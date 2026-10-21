#!/usr/bin/env python3
"""Pure screenshot proof tests. Never connect to an X display."""
import importlib.util
from pathlib import Path
import struct
import zlib

path = Path(__file__).resolve().parents[2] / 'scripts/paired-chrome-native-split-capture.py'
spec = importlib.util.spec_from_file_location('capture', path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
left, right = [248, 215, 218], [211, 244, 224]
width, height = 400, 200
rgb = b''.join(bytes(left) * 200 + bytes(right) * 200 for _ in range(height))
pixels = module.inspect_pixels(width, height, rgb, [left, right])
assert [item['count'] for item in pixels] == [40000, 40000]
png = module.encode_png(width, height, rgb)
assert png[:8] == b'\x89PNG\r\n\x1a\n'
offset, data = 8, b''
while offset < len(png):
    length = struct.unpack('>I', png[offset:offset+4])[0]
    kind, payload = png[offset+4:offset+8], png[offset+8:offset+8+length]
    assert zlib.crc32(kind + payload) & 0xffffffff == struct.unpack('>I', png[offset+8+length:offset+12+length])[0]
    if kind == b'IDAT':
        data += payload
    offset += length + 12
assert zlib.decompress(data) == b''.join(b'\0' + rgb[y*width*3:(y+1)*width*3] for y in range(height))
for colors, image in [([left, left], rgb), ([left, right], bytes(left)*width*height),
                      ([left, right], b''.join(bytes(left if (x+y)%2 else right) for y in range(height) for x in range(width)))]:
    try:
        module.inspect_pixels(width, height, image, colors)
        raise AssertionError('Invalid capture passed')
    except module.close.Rejected:
        pass
try:
    module.encode_png(width, height, b'wrong')
    raise AssertionError('Invalid dimensions passed')
except module.close.Rejected:
    pass
print('Native split capture pure tests passed')
