import ctypes, ctypes.util
x=ctypes.CDLL(ctypes.util.find_library('X11')); t=ctypes.CDLL(ctypes.util.find_library('Xtst'))
x.XOpenDisplay.argtypes=[ctypes.c_char_p];x.XOpenDisplay.restype=ctypes.c_void_p
x.XStringToKeysym.argtypes=[ctypes.c_char_p];x.XStringToKeysym.restype=ctypes.c_ulong
x.XKeysymToKeycode.argtypes=[ctypes.c_void_p,ctypes.c_ulong];x.XKeysymToKeycode.restype=ctypes.c_ubyte
x.XSync.argtypes=[ctypes.c_void_p,ctypes.c_int];x.XCloseDisplay.argtypes=[ctypes.c_void_p]
t.XTestFakeKeyEvent.argtypes=[ctypes.c_void_p,ctypes.c_uint,ctypes.c_int,ctypes.c_ulong]
d=x.XOpenDisplay(None)
if not d: raise RuntimeError('No existing X display')
a=x.XKeysymToKeycode(d,x.XStringToKeysym(b'Alt_L'));s=x.XKeysymToKeycode(d,x.XStringToKeysym(b's'))
if not a or not s: raise RuntimeError('Required shortcut keys unavailable')
try:
 for key,down in [(a,1),(s,1),(s,0),(a,0)]:
  if not t.XTestFakeKeyEvent(d,key,down,0): raise RuntimeError('XTEST input rejected')
 x.XSync(d,0)
finally:x.XCloseDisplay(d)
print('One native XTEST Alt+S sent')
