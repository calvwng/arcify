#!/usr/bin/env python3
"""Read-only CI X11 capture of one verified native Chrome window. No input/launch."""
import argparse
import ctypes as C
import importlib.util
import json
from pathlib import Path
import struct
import zlib

spec = importlib.util.spec_from_file_location('native_close', Path(__file__).with_name('paired-chrome-native-close.py'))
close = importlib.util.module_from_spec(spec)
spec.loader.exec_module(close)
require = close.require


class XImage(C.Structure):
    _fields_ = [('width', C.c_int), ('height', C.c_int), ('xoffset', C.c_int), ('format', C.c_int),
                ('data', C.c_void_p), ('byte_order', C.c_int), ('bitmap_unit', C.c_int),
                ('bitmap_bit_order', C.c_int), ('bitmap_pad', C.c_int), ('depth', C.c_int),
                ('bytes_per_line', C.c_int), ('bits_per_pixel', C.c_int),
                ('red_mask', C.c_ulong), ('green_mask', C.c_ulong), ('blue_mask', C.c_ulong)]


def encode_png(width, height, rgb):
    require(len(rgb) == width * height * 3, 'RGB size must match screenshot dimensions')
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    raw = b''.join(b'\0' + rgb[y*width*3:(y+1)*width*3] for y in range(height))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')


def inspect_pixels(width, height, rgb, colors):
    require(len(colors) == 2 and len(set(tuple(c) for c in colors)) == 2, 'Two distinct fixture colors required')
    results = []
    for color in colors:
        require(len(color) == 3 and all(type(c) is int and 0 <= c <= 255 for c in color), 'Invalid RGB color')
        count, total_x, minimum_x, maximum_x = 0, 0, width, -1
        target = bytes(color)
        for y in range(height):
            for x in range(width):
                offset = (y * width + x) * 3
                if rgb[offset:offset+3] == target:
                    count += 1
                    total_x += x
                    minimum_x, maximum_x = min(minimum_x, x), max(maximum_x, x)
        require(count >= 10000, 'Both native fixture pane backgrounds must be painted in the same window capture')
        results.append({'rgb': color, 'count': count, 'centerX': total_x / count, 'minX': minimum_x, 'maxX': maximum_x})
    require(abs(results[0]['centerX'] - results[1]['centerX']) >= width * 0.25,
            'Distinct native pane backgrounds must be visibly side by side')
    require(results[0]['maxX'] < results[1]['minX'] or results[1]['maxX'] < results[0]['minX'],
            'The native panes must occupy separate horizontal ranges')
    return results


def capture(request):
    expected = request['expected']
    host = close.inspect_host(expected, close.Host(), allow_title_discovery=True)
    native = close.NativeX11(expected['display'])
    image = None
    try:
        target = close.target_identity(native.focus(), expected)
        native.bind(native.x, 'XGetGeometry', [C.c_void_p, C.c_ulong, C.POINTER(C.c_ulong), C.POINTER(C.c_int), C.POINTER(C.c_int), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint), C.POINTER(C.c_uint)], C.c_int)
        native.bind(native.x, 'XGetImage', [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_ulong, C.c_int], C.POINTER(XImage))
        native.bind(native.x, 'XDestroyImage', [C.POINTER(XImage)], C.c_int)
        root, x, y, width, height, border, depth = C.c_ulong(), C.c_int(), C.c_int(), C.c_uint(), C.c_uint(), C.c_uint(), C.c_uint()
        require(native.x.XGetGeometry(native.display, target['window'], C.byref(root), C.byref(x), C.byref(y), C.byref(width), C.byref(height), C.byref(border), C.byref(depth)) != 0, 'Cannot inspect exact Chrome window geometry')
        require(320 <= width.value <= 4096 and 200 <= height.value <= 2160, 'Unexpected or excessive native screenshot geometry')
        native.sync()
        image = native.x.XGetImage(native.display, target['window'], 0, 0, width.value, height.value, C.c_ulong(-1), 2)
        native.sync()
        require(bool(image), 'XGetImage failed for exact native Chrome window')
        value = image.contents
        require(value.width == width.value and value.height == height.value and value.bits_per_pixel == 32 and value.byte_order == 0 and
                (value.red_mask, value.green_mask, value.blue_mask) == (0xff0000, 0xff00, 0xff) and value.xoffset == 0 and
                width.value * 4 <= value.bytes_per_line <= width.value * 4 + 64, 'Unsupported Xvfb pixel format; do not claim visual proof')
        raw = C.string_at(value.data, value.bytes_per_line * height.value)
        rgb = bytearray()
        for row in range(height.value):
            line = raw[row*value.bytes_per_line:row*value.bytes_per_line + width.value*4]
            for offset in range(0, len(line), 4):
                rgb.extend((line[offset+2], line[offset+1], line[offset]))
        # Preserve screenshot even if the pixel proof subsequently rejects it.
        output = Path(request['output'])
        require(output.is_absolute() and output.suffix == '.png', 'Require exact absolute PNG output')
        with output.open('xb') as handle:
            handle.write(encode_png(width.value, height.value, rgb))
        require(close.inspect_host(expected, close.Host(), allow_title_discovery=True) == host, 'Native process identity changed during capture')
        require(close.target_identity(native.focus(), expected) == target, 'Native target focus changed during capture')
        return {'status': 'ok', 'route': 'Read-only X11 XGetImage of exact Chrome native window', 'nativeWindow': True,
                'host': host, 'target': target, 'width': width.value, 'height': height.value,
                'pixels': inspect_pixels(width.value, height.value, rgb, request['colors']), 'output': str(output)}
    finally:
        if image:
            native.x.XDestroyImage(image)
        native.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request-json', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(capture(json.loads(args.request_json))))
    except Exception as error:
        print(json.dumps({'status': 'failed', 'error': str(error)}))
        raise SystemExit(1)
