"""Pure injected tests: never load a real X library, inspect /proc or open X."""
import copy
import ctypes as C
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('native_close', Path(__file__).resolve().parents[2] / 'scripts/paired-chrome-native-close.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)
NONCE = 'a' * 32
EXPECTED = {'display': ':99', 'xvfbPid': 123, 'chromePid': 456,
            'windowTitle': f'Fixture {NONCE} - Some exact Chrome title', 'nonce': NONCE}


class FakeHost:
    env = {'CI': 'true', 'GITHUB_ACTIONS': 'true', 'DISPLAY': ':99'}
    def __init__(self):
        self.env = dict(self.env)
        self.ids = (1001, 1001)
        self.lock = 123
        self.system = 'linux'
        self.processes = {
            123: {'pid': 123, 'executable': native.XVFB, 'uids': [1001] * 4,
                  'argv': [native.XVFB, ':99', '-screen', '0', '1280x1024x24'], 'startTicks': '100', 'comm': 'Xvfb'},
            456: {'pid': 456, 'executable': native.CHROME, 'uids': [1001] * 4,
                  'argv': [native.CHROME], 'startTicks': '200', 'comm': 'chrome'}}
    def uid(self): return self.ids
    def platform(self): return self.system
    def lock_pid(self, _number): return self.lock
    def process(self, pid): return copy.deepcopy(self.processes[pid])


class FakeNative:
    def __init__(self):
        self.provenance = {'libraries': ['fake-only'], 'xtestVersion': [2, 2]}
        self.calls = []
        self.events = []
        self.pressed = set()
        self.fail_key = None
        self.throw_key = None
        self.fail_sync = False
        self.non_neutral = False
        self.focus_calls = 0
        self.move_focus = False
        self.focus_value = {'focusWindow': 50, 'rootWindow': 10, 'ancestors': [
            {'window': 50, 'title': None, 'pid': None},
            {'window': 30, 'title': EXPECTED['windowTitle'], 'pid': 456}]}
        self.codes = {'minimum': 8, 'maximum': 255, 'Control_L': 37, 'w': 25}
    def factory(self, display):
        self.calls.append(('open', display)); return self
    def focus(self):
        self.calls.append('focus'); self.focus_calls += 1
        value = copy.deepcopy(self.focus_value)
        if self.move_focus and self.focus_calls >= 2: value['focusWindow'] += 1
        return value
    def keycodes(self): self.calls.append('keycodes'); return dict(self.codes)
    def keyboard(self):
        self.calls.append('keyboard')
        return {'pressedKeycodes': sorted(self.pressed), 'xkb': {'mods': 0, 'locked_mods': int(self.non_neutral)}}
    def sync(self, tolerate_errors=False):
        self.calls.append(('sync', tolerate_errors))
        if self.fail_sync and self.events and not tolerate_errors: raise native.Rejected('injected async X error')
        return {'flushReturn': 1, 'syncReturn': 1, 'xErrors': []}
    def key(self, code, pressed):
        self.events.append((code, pressed)); self.calls.append(('key', code, pressed))
        if pressed: self.pressed.add(code)
        else: self.pressed.discard(code)
        if len(self.events) == self.throw_key: raise RuntimeError('injected uncertain FFI call')
        return 0 if len(self.events) == self.fail_key else 1
    def close(self): self.calls.append('close')


class FlowTests(unittest.TestCase):
    def probe(self, host=None, lib=None, expected=None):
        lib = lib or FakeNative()
        return native.execute({'mode': 'probe', 'expected': expected or EXPECTED}, host or FakeHost(), lib.factory), lib
    def send(self, baseline=None, host=None, lib=None):
        lib = lib or FakeNative()
        if baseline is None: baseline, _ = self.probe()
        request = {'mode': 'send', 'expected': baseline['expected'], 'baseline': baseline}
        return native.execute(request, host or FakeHost(), lib.factory), lib
    def assert_failed_without_input(self, evidence, lib):
        self.assertEqual(evidence['status'], 'failed', evidence)
        self.assertFalse(evidence['chordAttempted'])
        self.assertEqual(lib.events, [])
    def test_readonly_probe_discovers_exact_nonce_title_without_suffix_assumption(self):
        evidence, lib = self.probe(expected={**EXPECTED, 'windowTitle': None})
        self.assertEqual(evidence['status'], 'ok', evidence)
        self.assertEqual(evidence['expected']['windowTitle'], EXPECTED['windowTitle'])
        self.assertEqual(evidence['target'], {'window': 30, 'focusWindow': 50, 'rootWindow': 10, 'windowTitle': EXPECTED['windowTitle']})
        self.assertEqual(evidence['events'], [])
        self.assertEqual(lib.events, [])
        self.assertEqual(lib.calls[-1], 'close')
    def test_one_ordered_native_chord_and_release_proof(self):
        evidence, lib = self.send()
        self.assertEqual(evidence['status'], 'ok', evidence)
        self.assertEqual(lib.events, [(37, True), (25, True), (25, False), (37, False)])
        self.assertTrue(evidence['chordCompleted'])
        self.assertFalse(evidence['browserClosureVerified'])
        self.assertEqual(evidence['keyboardAfter']['pressedKeycodes'], [])
        self.assertEqual(evidence['cleanup'], [])
        self.assertEqual(lib.calls[-1], 'close')
    def test_wrong_modes_never_open(self):
        for mode in (None, '', 'close', 'send_again'):
            lib = FakeNative()
            result = native.execute({'mode': mode, 'expected': EXPECTED}, FakeHost(), lib.factory)
            self.assert_failed_without_input(result, lib)
            self.assertEqual(lib.calls, [])
    def test_host_preflight_rejects_before_loading(self):
        mutations = [lambda h: h.env.update(CI='false'), lambda h: h.env.update(GITHUB_ACTIONS='false'),
                     lambda h: h.env.update(DISPLAY=':100'), lambda h: setattr(h, 'ids', (0, 0)),
                     lambda h: setattr(h, 'ids', (1001, 0)), lambda h: setattr(h, 'lock', 777),
                     lambda h: setattr(h, 'system', 'darwin')]
        for field, value in [('executable', '/tmp/chrome'), ('uids', [0] * 4), ('comm', 'renderer'),
                             ('argv', [native.CHROME, '--type=renderer'])]:
            mutations.append(lambda h, f=field, v=value: h.processes[456].update({f: v}))
        mutations.extend([lambda h: h.processes[123].update(executable='/tmp/Xvfb'),
                          lambda h: h.processes[123].update(argv=[native.XVFB, ':100']),
                          lambda h: h.processes[123].update(argv=[native.XVFB, ':99', ':99'])])
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                host, lib = FakeHost(), FakeNative(); mutate(host)
                result, _ = self.probe(host, lib)
                self.assert_failed_without_input(result, lib)
                self.assertEqual(lib.calls, [])
    def test_invalid_expected_target_rejected_before_open(self):
        values = [('display', 'localhost:99'), ('display', ':99.1'), ('display', ':99;bad'),
                  ('chromePid', True), ('xvfbPid', 0), ('nonce', 'short'), ('nonce', 'G' * 32),
                  ('windowTitle', 'missing nonce'), ('windowTitle', NONCE * 2), ('windowTitle', NONCE + '\n')]
        for key, value in values:
            with self.subTest(key=key, value=value):
                result, lib = self.probe(expected={**EXPECTED, key: value})
                self.assert_failed_without_input(result, lib)
                self.assertEqual(lib.calls, [])
    def test_wrong_title_pid_or_ambiguous_ancestor_reject(self):
        for change in ('title', 'pid', 'ambiguous'):
            lib = FakeNative()
            if change == 'ambiguous': lib.focus_value['ancestors'].append(dict(lib.focus_value['ancestors'][-1]))
            else: lib.focus_value['ancestors'][-1][change] = 'wrong' if change == 'title' else 777
            result, _ = self.probe(lib=lib)
            self.assert_failed_without_input(result, lib)
            self.assertEqual(lib.calls[-1], 'close')
    def test_pressed_key_or_latched_modifier_is_not_cleared_or_overridden(self):
        for kind in ('pressed', 'locked'):
            lib = FakeNative()
            if kind == 'pressed': lib.pressed.add(50)
            else: lib.non_neutral = True
            result, _ = self.probe(lib=lib)
            self.assert_failed_without_input(result, lib)
            self.assertEqual(result['cleanup'], [])
    def test_changed_process_start_focus_mapping_and_title_reject_send(self):
        baseline, _ = self.probe()
        for change in ('process', 'focus', 'mapping', 'title', 'just_before'):
            host, lib = FakeHost(), FakeNative()
            if change == 'process': host.processes[456]['startTicks'] = '201'
            if change == 'focus': lib.focus_value['focusWindow'] = 60
            if change == 'mapping': lib.codes['w'] = 26
            if change == 'title': lib.focus_value['ancestors'][-1]['title'] += ' altered'
            if change == 'just_before': lib.move_focus = True
            result, _ = self.send(baseline, host, lib)
            self.assert_failed_without_input(result, lib)
    def test_send_requires_successful_readonly_probe_and_exact_target(self):
        baseline, _ = self.probe()
        for patch in ({'status': 'failed'}, {'mode': 'send'}, {'chordAttempted': True}, {'schemaVersion': 2}):
            result, lib = self.send({**baseline, **patch})
            self.assert_failed_without_input(result, lib)
            self.assertEqual(lib.calls, [])
    def test_each_failed_event_releases_own_attempted_keys_without_another_down(self):
        for failed in range(1, 5):
            with self.subTest(event=failed):
                lib = FakeNative(); lib.fail_key = failed
                result, _ = self.send(lib=lib)
                self.assertEqual(result['status'], 'failed')
                self.assertTrue(result['chordAttempted'])
                self.assertFalse(result['chordCompleted'])
                expected_cleanup = [(37, False)] if failed == 1 else [(25, False), (37, False)]
                self.assertEqual(lib.events[failed:], expected_cleanup)
                self.assertEqual(sum(pressed for _, pressed in lib.events), min(failed, 2))
                self.assertTrue(result['cleanupReleased'])
                self.assertEqual(lib.pressed, set())
    def test_uncertain_down_call_still_releases_that_key(self):
        lib = FakeNative(); lib.throw_key = 2
        result, _ = self.send(lib=lib)
        self.assertEqual(lib.events, [(37, True), (25, True), (25, False), (37, False)])
        self.assertEqual(result['error']['message'], 'injected uncertain FFI call')
        self.assertTrue(result['cleanupReleased'])
    def test_async_error_fails_despite_successful_call_returns(self):
        lib = FakeNative(); lib.fail_sync = True
        result, _ = self.send(lib=lib)
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['chordCompleted'])
        self.assertEqual(lib.events[4:], [(25, False), (37, False)])
    def test_cleanup_error_does_not_prevent_releasing_other_owned_key(self):
        lib = FakeNative(); lib.fail_key = 2; lib.throw_key = 3
        result, _ = self.send(lib=lib)
        self.assertEqual(lib.events[-1], (37, False))
        self.assertFalse(result['cleanupReleased'])
        self.assertEqual(result['status'], 'failed')
    def test_loader_failure_records_rejection_without_input(self):
        def unavailable(_display): raise OSError('libXtst unavailable')
        result = native.execute({'mode': 'probe', 'expected': EXPECTED}, FakeHost(), unavailable)
        self.assertEqual(result['status'], 'failed')
        self.assertFalse(result['chordAttempted'])
        self.assertIn('libXtst', result['error']['message'])


class Function:
    def __init__(self, implementation): self.implementation = implementation
    def __call__(self, *args): return self.implementation(*args)


class FakeLibrary:
    """ctypes-level stubs, including pointers and C-long format-32 properties."""
    def __init__(self):
        self.calls, self.keep, self.errors = [], [], []
        self.xtest = True
        self.open_result = 1234
        self.property_format = None
        self.after = 0
        self.focus_window = 50
        self.w_code = 25
        self.modifier_slot = 2
        self.handler = None
        self.atoms = {'_NET_WM_NAME': 11, 'UTF8_STRING': 12, '_NET_WM_PID': 13, 'CARDINAL': 14}
        self.mapping = None
    def __getattr__(self, name):
        try: implementation = object.__getattribute__(self, 'impl_' + name)
        except AttributeError: implementation = None
        def invoke(*args):
            self.calls.append((name, args))
            return implementation(*args) if implementation else 1
        function = Function(invoke); setattr(self, name, function); return function
    def loader(self, name): self.calls.append(('load', (name,))); return self
    def impl_XSetErrorHandler(self, pointer):
        old = self.handler; self.handler = pointer
        return 321 if old is None else old
    def impl_XOpenDisplay(self, display): return self.open_result
    @staticmethod
    def put(pointer, type_, value): C.cast(pointer, C.POINTER(type_))[0] = value
    def impl_XTestQueryExtension(self, _d, event, error, major, minor):
        self.put(major, C.c_int, 2); self.put(minor, C.c_int, 2); return int(self.xtest)
    def impl_XGetInputFocus(self, _d, focus, revert):
        self.put(focus, C.c_ulong, self.focus_window); self.put(revert, C.c_int, 1); return 1
    def impl_XInternAtom(self, _d, name, only_if_exists):
        if only_if_exists != 1: raise AssertionError('Probe must never create an atom')
        return self.atoms[name.decode()]
    def impl_XGetWindowProperty(self, _d, window, atom, offset, length, delete, kind, actual, format_, count, after, data):
        if delete or offset: raise AssertionError('Properties are read-only')
        value = EXPECTED['windowTitle'].encode() if atom == 11 else 456
        if window == 50:
            self.put(actual, C.c_ulong, 0); return 0
        self.put(actual, C.c_ulong, kind)
        self.put(format_, C.c_int, self.property_format or (8 if atom == 11 else 32))
        self.put(count, C.c_ulong, len(value) if atom == 11 else 1)
        self.put(after, C.c_ulong, self.after)
        buffer = C.create_string_buffer(value) if atom == 11 else (C.c_ulong * 1)(value)
        self.keep.append(buffer)
        C.cast(data, C.POINTER(C.POINTER(C.c_ubyte)))[0] = C.cast(buffer, C.POINTER(C.c_ubyte))
        return 0
    def impl_XQueryTree(self, _d, window, root, parent, children, count):
        self.put(root, C.c_ulong, 10); self.put(parent, C.c_ulong, 30 if window == 50 else 10)
        self.put(count, C.c_uint, 0); return 1
    def impl_XDisplayKeycodes(self, _d, minimum, maximum):
        self.put(minimum, C.c_int, 8); self.put(maximum, C.c_int, 255); return 1
    def impl_XKeysymToKeycode(self, _d, keysym): return 37 if keysym == native.CONTROL_L else self.w_code
    def impl_XkbKeycodeToKeysym(self, _d, code, group, level):
        if group or level: raise AssertionError('Mapping must be neutral')
        return native.CONTROL_L if code == 37 else native.W
    def impl_XGetModifierMapping(self, _d):
        buffer = (C.c_ubyte * 8)(); buffer[self.modifier_slot] = 37
        self.keep.append(buffer); self.mapping = native.ModifierMap(1, buffer)
        return C.pointer(self.mapping)
    def impl_XkbGetState(self, _d, device, _state):
        if device != 0x0100: raise AssertionError('Expected core keyboard')
        return 0


class BindingTests(unittest.TestCase):
    def test_fake_libraries_exercise_abi_title_pid_keycodes_and_keyboard(self):
        lib = FakeLibrary()
        connection = native.NativeX11(':99', loader=lib.loader)
        focus = connection.focus()
        self.assertEqual(focus['ancestors'][-1]['pid'], 456)
        self.assertEqual(focus['ancestors'][-1]['title'], EXPECTED['windowTitle'])
        self.assertEqual(connection.keycodes()['w'], 25)
        native.assert_neutral(connection.keyboard())
        connection.key(25, True)
        self.assertEqual(lib.XTestFakeKeyEvent.argtypes, [C.c_void_p, C.c_uint, C.c_int, C.c_ulong])
        self.assertEqual(lib.XKeysymToKeycode.restype, C.c_ubyte)
        connection.close()
        self.assertEqual([name for name, _ in lib.calls].count('XCloseDisplay'), 1)
        self.assertEqual([args for name, args in lib.calls if name == 'XTestFakeKeyEvent'], [(1234, 25, 1, 0)])
    def test_missing_xtest_or_display_closes_and_restores_handler(self):
        for which in ('xtest', 'display'):
            lib = FakeLibrary()
            if which == 'xtest': lib.xtest = False
            else: lib.open_result = None
            with self.assertRaises(native.Rejected): native.NativeX11(':99', loader=lib.loader)
            names = [name for name, _ in lib.calls]
            self.assertEqual(names.count('XSetErrorHandler'), 2)
            self.assertEqual(names.count('XCloseDisplay'), int(which == 'xtest'))
            self.assertNotIn('XTestFakeKeyEvent', names)
    def test_malformed_or_truncated_property_frees_allocated_buffer(self):
        for which in ('format', 'truncated'):
            lib = FakeLibrary(); conn = native.NativeX11(':99', loader=lib.loader)
            if which == 'format': lib.property_format = 16
            else: lib.after = 1
            with self.assertRaises(native.Rejected): conn.property(30, '_NET_WM_NAME', 'UTF8_STRING')
            self.assertEqual([name for name, _ in lib.calls].count('XFree'), 1)
            conn.close()
    def test_non_window_focus_rejected(self):
        for window in (0, 1):
            lib = FakeLibrary(); lib.focus_window = window
            conn = native.NativeX11(':99', loader=lib.loader)
            with self.assertRaises(native.Rejected): conn.focus()
            conn.close()
    def test_invalid_code_or_modifier_map_is_rejected(self):
        for which in ('zero', 'same', 'wrong-modifier'):
            lib = FakeLibrary()
            if which == 'zero': lib.w_code = 0
            if which == 'same': lib.w_code = 37
            if which == 'wrong-modifier': lib.modifier_slot = 3
            conn = native.NativeX11(':99', loader=lib.loader)
            with self.assertRaises(native.Rejected): conn.keycodes()
            if which == 'wrong-modifier': self.assertIn('XFreeModifiermap', [name for name, _ in lib.calls])
            conn.close()
    def test_async_errors_are_preserved_and_sync_does_not_claim_int_status(self):
        lib = FakeLibrary(); conn = native.NativeX11(':99', loader=lib.loader)
        error = native.XErrorEvent(); error.error_code = 3; error.request_code = 132
        conn.on_error(None, C.pointer(error))
        with self.assertRaises(native.Rejected): conn.sync()
        self.assertEqual(conn.sync(tolerate_errors=True)['xErrors'][0]['error_code'], 3)
        conn.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
