#!/usr/bin/env python3
"""CI-only, one-shot XTEST Ctrl+W. Importing this module never opens a display.

The probe is read-only. A send revalidates its exact probe, queues one native
Control_L/w chord, and verifies released keys. This proves an X-server input
request, NOT that Chrome handled it; callers must independently observe closure.
Only Python stdlib and the runner's existing libX11/libXtst are used.
"""
import argparse
import ctypes as C
import datetime
import json
import os
from pathlib import Path
import re
import signal
import sys

CHROME = '/opt/google/chrome/chrome'
XVFB = '/usr/bin/Xvfb'
CONTROL_L, W, CONTROL_MASK = 0xFFE3, 0x77, 4
SCHEMA = 1


class Rejected(RuntimeError):
    pass


def require(value, message):
    if not value:
        raise Rejected(message)


def display_number(display):
    require(isinstance(display, str) and re.fullmatch(r':[0-9]+(?:\.0)?', display),
            'Require an explicit local Xvfb DISPLAY with screen 0')
    return int(display[1:].split('.')[0])


def validate_expected(expected, allow_title_discovery=False):
    require(isinstance(expected, dict), 'Expected target identity is required')
    require(set(expected) == {'display', 'xvfbPid', 'chromePid', 'windowTitle', 'nonce'},
            'Require only display, xvfbPid, chromePid, windowTitle and nonce')
    display_number(expected['display'])
    for key in ('xvfbPid', 'chromePid'):
        require(type(expected[key]) is int and expected[key] > 1, f'Invalid {key}')
    require(expected['xvfbPid'] != expected['chromePid'], 'Chrome and Xvfb must be different processes')
    nonce, title = expected['nonce'], expected['windowTitle']
    require(isinstance(nonce, str) and re.fullmatch(r'[a-f0-9]{32}', nonce), 'Require a fresh 32-hex title nonce')
    if not (allow_title_discovery and title is None):
        require(isinstance(title, str) and len(title) <= 512 and title.count(nonce) == 1
                and not any(ord(char) < 32 for char in title), 'Require an exact window title containing the nonce once')


class Host:
    """Read-only Linux process/display provenance. Injectable for pure tests."""
    env = os.environ

    def uid(self):
        return os.getuid(), os.geteuid()

    def platform(self):
        return sys.platform

    def lock_pid(self, number):
        path = Path(f'/tmp/.X{number}-lock')
        require(not path.is_symlink(), 'Xvfb lock must not be a symlink')
        value = path.read_text(encoding='ascii').strip()
        require(re.fullmatch(r'[0-9]+', value), 'Xvfb lock must contain one PID')
        return int(value)

    def process(self, pid):
        base = Path(f'/proc/{pid}')
        executable = os.readlink(base / 'exe')
        status = (base / 'status').read_text()
        uid_line = re.search(r'^Uid:\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+([0-9]+)$', status, re.M)
        require(uid_line, f'Cannot read process {pid} UID evidence')
        args = (base / 'cmdline').read_bytes().rstrip(b'\0').split(b'\0')
        args = [value.decode('utf-8', errors='strict') for value in args]
        # Field 22, after a comm field that can itself contain spaces/parentheses.
        stat = (base / 'stat').read_text()
        fields = stat[stat.rfind(')') + 2:].split()
        require(len(fields) > 19 and fields[19].isdigit(), f'Cannot read process {pid} start identity')
        return {'pid': pid, 'executable': executable, 'uids': [int(value) for value in uid_line.groups()],
                'startTicks': fields[19], 'argv': args, 'comm': stat[stat.find('(') + 1:stat.rfind(')')]}


def inspect_host(expected, host, allow_title_discovery=False):
    validate_expected(expected, allow_title_discovery)
    require(host.platform() == 'linux', 'Native close evidence requires Linux Xvfb')
    uid, euid = host.uid()
    require(uid > 0 and euid == uid, 'Native close evidence requires the ordinary non-root runner')
    require(host.env.get('CI') == 'true' and host.env.get('GITHUB_ACTIONS') == 'true',
            'Native input is restricted to the dedicated GitHub Actions fixture')
    require(host.env.get('DISPLAY') == expected['display'], 'DISPLAY differs from the explicitly expected Xvfb display')
    require(host.lock_pid(display_number(expected['display'])) == expected['xvfbPid'], 'X display lock PID mismatch')
    processes = {}
    for name, executable in (('xvfb', XVFB), ('chrome', CHROME)):
        proc = host.process(expected[name + 'Pid'])
        require(proc['executable'] == executable, f'Expected the installed {name} executable exactly')
        require(proc['comm'] == ('Xvfb' if name == 'xvfb' else 'chrome'), f'Unexpected {name} process comm')
        require(proc['uids'] == [uid] * 4, f'{name} must belong to the ordinary runner')
        require(proc['argv'], f'{name} process has no command line')
        if name == 'xvfb':
            require(proc['argv'][1:].count(f":{display_number(expected['display'])}") == 1,
                    'Xvfb command line does not name the expected display exactly once')
        else:
            require(not any(arg.startswith('--type=') for arg in proc['argv'][1:]),
                    'Expected the browser process, not a Chrome child process')
        # Do not retain unrelated arguments or X authority file paths.
        processes[name] = {key: proc[key] for key in ('pid', 'executable', 'uids', 'startTicks', 'comm')}
    return {'runnerUid': uid, 'effectiveUid': euid, 'display': expected['display'],
            'githubActions': True, 'ci': True, **processes}


class XErrorEvent(C.Structure):
    _fields_ = [('type', C.c_int), ('display', C.c_void_p), ('resourceid', C.c_ulong),
                ('serial', C.c_ulong), ('error_code', C.c_ubyte),
                ('request_code', C.c_ubyte), ('minor_code', C.c_ubyte)]


class XkbState(C.Structure):
    _fields_ = [('group', C.c_ubyte), ('locked_group', C.c_ubyte),
                ('base_group', C.c_ushort), ('latched_group', C.c_ushort),
                ('mods', C.c_ubyte), ('base_mods', C.c_ubyte),
                ('latched_mods', C.c_ubyte), ('locked_mods', C.c_ubyte),
                ('compat_state', C.c_ubyte), ('grab_mods', C.c_ubyte),
                ('compat_grab_mods', C.c_ubyte), ('lookup_mods', C.c_ubyte),
                ('compat_lookup_mods', C.c_ubyte), ('ptr_buttons', C.c_ushort)]


class ModifierMap(C.Structure):
    _fields_ = [('max_keypermod', C.c_int), ('modifiermap', C.POINTER(C.c_ubyte))]


class NativeX11:
    """Small ctypes binding, with injected libraries for ABI/cleanup unit tests."""
    def __init__(self, display, loader=C.CDLL):
        self.x = loader('libX11.so.6')
        self.xt = loader('libXtst.so.6')
        self.errors = []
        self.display = None
        self.old_handler = None
        p = C.POINTER
        self.bind(self.x, 'XOpenDisplay', [C.c_char_p], C.c_void_p)
        self.bind(self.x, 'XCloseDisplay', [C.c_void_p], C.c_int)
        self.bind(self.x, 'XSetErrorHandler', [C.c_void_p], C.c_void_p)
        self.bind(self.x, 'XSync', [C.c_void_p, C.c_int], C.c_int)
        self.bind(self.x, 'XFlush', [C.c_void_p], C.c_int)
        self.bind(self.x, 'XGetInputFocus', [C.c_void_p, p(C.c_ulong), p(C.c_int)], C.c_int)
        self.bind(self.x, 'XQueryTree', [C.c_void_p, C.c_ulong, p(C.c_ulong), p(C.c_ulong), p(p(C.c_ulong)), p(C.c_uint)], C.c_int)
        self.bind(self.x, 'XInternAtom', [C.c_void_p, C.c_char_p, C.c_int], C.c_ulong)
        self.bind(self.x, 'XGetWindowProperty', [C.c_void_p, C.c_ulong, C.c_ulong, C.c_long, C.c_long,
                  C.c_int, C.c_ulong, p(C.c_ulong), p(C.c_int), p(C.c_ulong), p(C.c_ulong), p(p(C.c_ubyte))], C.c_int)
        self.bind(self.x, 'XFree', [C.c_void_p], C.c_int)
        self.bind(self.x, 'XQueryKeymap', [C.c_void_p, p(C.c_char)], C.c_int)
        self.bind(self.x, 'XDisplayKeycodes', [C.c_void_p, p(C.c_int), p(C.c_int)], C.c_int)
        self.bind(self.x, 'XKeysymToKeycode', [C.c_void_p, C.c_ulong], C.c_ubyte)
        self.bind(self.x, 'XkbKeycodeToKeysym', [C.c_void_p, C.c_ubyte, C.c_int, C.c_int], C.c_ulong)
        self.bind(self.x, 'XkbGetState', [C.c_void_p, C.c_uint, p(XkbState)], C.c_int)
        self.bind(self.x, 'XGetModifierMapping', [C.c_void_p], p(ModifierMap))
        self.bind(self.x, 'XFreeModifiermap', [p(ModifierMap)], C.c_int)
        self.bind(self.xt, 'XTestQueryExtension', [C.c_void_p, p(C.c_int), p(C.c_int), p(C.c_int), p(C.c_int)], C.c_int)
        self.bind(self.xt, 'XTestFakeKeyEvent', [C.c_void_p, C.c_uint, C.c_int, C.c_ulong], C.c_int)
        callback_type = C.CFUNCTYPE(C.c_int, C.c_void_p, p(XErrorEvent))
        self.handler = callback_type(self.on_error)
        self.old_handler = self.x.XSetErrorHandler(C.cast(self.handler, C.c_void_p))
        try:
            self.display = self.x.XOpenDisplay(display.encode('ascii'))
            require(self.display, 'XOpenDisplay failed for the explicitly expected Xvfb display')
            values = [C.c_int() for _ in range(4)]
            require(self.xt.XTestQueryExtension(self.display, *[C.byref(value) for value in values]) != 0,
                    'The existing Xvfb server does not support XTEST')
            self.sync()
            require(values[2].value >= 2, 'Require XTEST protocol version 2 or newer')
            self.provenance = {'libraries': ['libX11.so.6', 'libXtst.so.6'],
                               'xtestVersion': [values[2].value, values[3].value]}
        except BaseException:
            self.close()
            raise

    @staticmethod
    def bind(library, name, args, result):
        function = getattr(library, name)
        function.argtypes, function.restype = args, result

    def on_error(self, _display, pointer):
        error = pointer.contents
        self.errors.append({name: int(getattr(error, name)) for name in
                            ('resourceid', 'serial', 'error_code', 'request_code', 'minor_code')})
        return 0

    def sync(self, tolerate_errors=False):
        # XFlush/XSync's int return values do NOT carry a documented success
        # status. Record them; a synchronous round trip and X errors are the proof.
        flush = self.x.XFlush(self.display)
        sync = self.x.XSync(self.display, 0)
        if not tolerate_errors:
            require(not self.errors, f'X11 protocol error: {self.errors}')
        return {'flushReturn': flush, 'syncReturn': sync, 'xErrors': list(self.errors)}

    def property(self, window, name, kind):
        atom = self.x.XInternAtom(self.display, name.encode(), 1)
        required_type = self.x.XInternAtom(self.display, kind.encode(), 1)
        if not atom or not required_type:
            return None
        actual, count, after = C.c_ulong(), C.c_ulong(), C.c_ulong()
        format_ = C.c_int()
        data = C.POINTER(C.c_ubyte)()
        try:
            result = self.x.XGetWindowProperty(self.display, window, atom, 0, 1024, 0, required_type,
                       C.byref(actual), C.byref(format_), C.byref(count), C.byref(after), C.byref(data))
            require(result == 0 and not self.errors, f'Cannot read X window property {name}')
            if actual.value == 0:
                return None
            require(actual.value == required_type and after.value == 0, f'Malformed or truncated {name}')
            require(bool(data), f'Missing data for {name}')
            if kind == 'UTF8_STRING':
                require(format_.value == 8 and count.value <= 4096, f'Invalid {name} encoding')
                return C.string_at(data, count.value).decode('utf-8', errors='strict')
            require(format_.value == 32 and count.value == 1, f'Invalid {name} cardinal')
            # Xlib expands format-32 data into C longs, including on 64-bit hosts.
            return int(C.cast(data, C.POINTER(C.c_ulong))[0])
        finally:
            if data:
                self.x.XFree(data)

    def focus(self):
        focus, revert = C.c_ulong(), C.c_int()
        self.x.XGetInputFocus(self.display, C.byref(focus), C.byref(revert))
        require(not self.errors, 'Cannot read X input focus')
        require(focus.value > 1, 'X focus is None or PointerRoot, not a real window')
        result = {'focusWindow': focus.value, 'revertTo': revert.value, 'ancestors': []}
        window, seen = focus.value, set()
        for _ in range(32):
            require(window not in seen, 'Cycle in focused X window ancestry')
            seen.add(window)
            result['ancestors'].append({'window': window,
                'title': self.property(window, '_NET_WM_NAME', 'UTF8_STRING'),
                'pid': self.property(window, '_NET_WM_PID', 'CARDINAL')})
            root, parent, children, count = C.c_ulong(), C.c_ulong(), C.POINTER(C.c_ulong)(), C.c_uint()
            try:
                require(self.x.XQueryTree(self.display, window, C.byref(root), C.byref(parent),
                        C.byref(children), C.byref(count)) != 0 and not self.errors,
                        'Cannot read focused X window ancestry')
            finally:
                if children:
                    self.x.XFree(children)
            if parent.value == root.value and root.value > 1:
                result['rootWindow'] = root.value
                return result
            require(parent.value > 1, 'Focused X window has no rooted ancestor')
            window = parent.value
        raise Rejected('Focused X window ancestry exceeds the bounded probe')

    def keyboard(self):
        bitmap, state = (C.c_char * 32)(), XkbState()
        require(self.x.XQueryKeymap(self.display, bitmap) != 0 and not self.errors, 'Cannot query physical key state')
        require(self.x.XkbGetState(self.display, 0x0100, C.byref(state)) == 0 and not self.errors,
                'Cannot query core XKB state')
        pressed = [key for key in range(256) if bytes(bitmap)[key // 8] & (1 << (key % 8))]
        return {'pressedKeycodes': pressed, 'xkb': {name: int(getattr(state, name)) for name, _ in state._fields_}}

    def keycodes(self):
        minimum, maximum = C.c_int(), C.c_int()
        self.x.XDisplayKeycodes(self.display, C.byref(minimum), C.byref(maximum))
        require(8 <= minimum.value <= maximum.value <= 255 and not self.errors, 'Invalid X keycode range')
        keys = {'Control_L': int(self.x.XKeysymToKeycode(self.display, CONTROL_L)),
                'w': int(self.x.XKeysymToKeycode(self.display, W))}
        require(len(set(keys.values())) == 2, 'Control_L and w must have distinct keycodes')
        for name, symbol in (('Control_L', CONTROL_L), ('w', W)):
            code = keys[name]
            require(minimum.value <= code <= maximum.value, f'Invalid {name} keycode')
            require(self.x.XkbKeycodeToKeysym(self.display, code, 0, 0) == symbol and not self.errors,
                    f'{name} is not mapped in neutral keyboard group/level')
        mapping = self.x.XGetModifierMapping(self.display)
        require(bool(mapping) and not self.errors, 'Cannot inspect the X modifier mapping')
        try:
            width = mapping.contents.max_keypermod
            require(0 < width <= 32 and bool(mapping.contents.modifiermap), 'Invalid X modifier map')
            slots = {name: [index // width for index in range(8 * width)
                           if mapping.contents.modifiermap[index] == code] for name, code in keys.items()}
            require(slots['Control_L'] == [2] and not slots['w'], 'Require ordinary Control_L and non-modifier w')
        finally:
            self.x.XFreeModifiermap(mapping)
        return {'minimum': minimum.value, 'maximum': maximum.value, **keys}

    def key(self, code, pressed):
        return int(self.xt.XTestFakeKeyEvent(self.display, code, int(pressed), 0))

    def close(self):
        try:
            if self.display:
                self.x.XCloseDisplay(self.display)
        finally:
            self.display = None
            if self.old_handler is not None:
                self.x.XSetErrorHandler(self.old_handler)
                self.old_handler = None


def assert_neutral(keyboard):
    require(keyboard['pressedKeycodes'] == [] and all(value == 0 for value in keyboard['xkb'].values()),
            'Initial/final keyboard, modifiers, locks, group and pointer buttons must be neutral')


def target_identity(focus, expected):
    matches = [item for item in focus['ancestors'] if isinstance(item['title'], str)
               and item['title'].count(expected['nonce']) == 1 and item['pid'] == expected['chromePid']
               and (expected['windowTitle'] is None or item['title'] == expected['windowTitle'])]
    require(len(matches) == 1, 'Focus ancestry must identify exactly one exact nonce title and Chrome PID')
    title = matches[0]['title']
    require(len(title) <= 512 and not any(ord(char) < 32 for char in title), 'Unsafe or overlong focused title')
    return {'focusWindow': focus['focusWindow'], 'window': matches[0]['window'],
            'rootWindow': focus['rootWindow'], 'windowTitle': title}


def execute(request, host=None, native_factory=NativeX11):
    """Return JSON evidence for success OR rejection; never replay input."""
    host = host or Host()
    evidence = {'schemaVersion': SCHEMA, 'status': 'failed', 'mode': request.get('mode'),
                'route': 'X11 XTEST native Control_L+w', 'physicalKeyboard': False,
                'browserClosureVerified': False, 'chordAttempted': False, 'chordCompleted': False,
                'events': [], 'cleanup': [], 'observedAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    native, owned = None, []
    try:
        require(request.get('mode') in ('probe', 'send'), 'Require explicit probe or send mode')
        expected = request.get('expected')
        evidence['host'] = inspect_host(expected, host, allow_title_discovery=request['mode'] == 'probe')
        evidence['expected'] = dict(expected)
        if request['mode'] == 'send':
            baseline = request.get('baseline')
            require(isinstance(baseline, dict) and baseline.get('status') == 'ok'
                    and baseline.get('schemaVersion') == SCHEMA and baseline.get('mode') == 'probe'
                    and baseline.get('chordAttempted') is False,
                    'Send requires a successful read-only probe')
            require(baseline.get('expected') == expected and baseline.get('host') == evidence['host'],
                    'Expected process/display identity changed since the read-only probe')
        native = native_factory(expected['display'])
        evidence['native'] = native.provenance
        evidence['focus'] = native.focus()
        evidence['target'] = target_identity(evidence['focus'], expected)
        expected = {**expected, 'windowTitle': evidence['target']['windowTitle']}
        evidence['expected'] = expected
        evidence['keycodes'] = native.keycodes()
        evidence['keyboardBefore'] = native.keyboard()
        assert_neutral(evidence['keyboardBefore'])
        evidence['preflightSync'] = native.sync()
        if request['mode'] == 'send':
            require(evidence['target'] == baseline.get('target') and evidence['keycodes'] == baseline.get('keycodes'),
                    'Focus/window ancestry or key mapping changed since the read-only probe')
            # Read-only revalidation immediately before the first queued event.
            require(inspect_host(expected, host) == evidence['host'], 'Process identity changed immediately before input')
            evidence['focusBeforeSend'] = native.focus()
            require(target_identity(evidence['focusBeforeSend'], expected) == evidence['target'],
                    'X focus changed immediately before input')
            evidence['keyboardBeforeSend'] = native.keyboard()
            assert_neutral(evidence['keyboardBeforeSend'])
            codes = evidence['keycodes']
            for name, pressed in [('Control_L', True), ('w', True), ('w', False), ('Control_L', False)]:
                # Mark uncertainty BEFORE the FFI call. Even a thrown call may
                # have queued a key down; cleanup releases only our own keys.
                evidence['chordAttempted'] = True
                if pressed:
                    owned.append(codes[name])
                event = {'key': name, 'keycode': codes[name], 'pressed': pressed, 'delayMs': 0}
                evidence['events'].append(event)
                event['result'] = native.key(codes[name], pressed)
                require(event['result'] != 0, f'XTEST rejected {name} {"down" if pressed else "up"}; do not retry')
            evidence['sendSync'] = native.sync()
            evidence['keyboardAfter'] = native.keyboard()
            assert_neutral(evidence['keyboardAfter'])
            owned.clear()
            evidence['chordCompleted'] = True
        evidence['status'] = 'ok'
    except BaseException as error:
        evidence['error'] = {'type': type(error).__name__, 'message': str(error)}
    finally:
        if native is not None:
            if owned:
                # Releases are best-effort, never another key down/chord. A
                # server disconnect/SIGKILL cannot guarantee release; fail closed.
                for code in reversed(owned):
                    item = {'keycode': code, 'pressed': False}
                    evidence['cleanup'].append(item)
                    try:
                        item['result'] = native.key(code, False)
                    except BaseException as error:
                        item['error'] = str(error)
                try:
                    evidence['cleanupSync'] = native.sync(tolerate_errors=True)
                    evidence['keyboardAfterCleanup'] = native.keyboard()
                    assert_neutral(evidence['keyboardAfterCleanup'])
                    evidence['cleanupReleased'] = all(item.get('result', 0) != 0 for item in evidence['cleanup'])
                except BaseException as error:
                    evidence['cleanupReleased'] = False
                    evidence['cleanupError'] = str(error)
            try:
                native.close()
            except BaseException as error:
                evidence['status'] = 'failed'
                evidence['closeError'] = str(error)
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request-json', required=True)
    args = parser.parse_args(argv)
    # SIGTERM from the wrapper timeout must enter release cleanup, not silently
    # strand a modifier. A severed X connection or forced kill is still uncertain.
    def interrupted(signum, _frame):
        raise InterruptedError(f'Native input helper interrupted by signal {signum}; do not retry')
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        require(len(args.request_json) <= 65536, 'Request exceeds bounded JSON input')
        request = json.loads(args.request_json)
        require(isinstance(request, dict), 'Request must be an object')
        result = execute(request)
    except BaseException as error:
        result = {'schemaVersion': SCHEMA, 'status': 'failed', 'chordAttempted': False,
                  'error': {'type': type(error).__name__, 'message': str(error)}}
    print(json.dumps(result, separators=(',', ':')), flush=True)
    return 0 if result['status'] == 'ok' else 1


if __name__ == '__main__':
    sys.exit(main())
