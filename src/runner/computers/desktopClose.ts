/** Ask application windows to close while their display/session bus still live.
 * Never answer save prompts; the existing bounded container stop remains the
 * fallback for unresponsive applications. No titles or credentials are read. */
export const CLOSE_DESKTOP=String.raw`
import ctypes as c
import re, subprocess, time
def windows():
    result = subprocess.run(['xprop', '-root', '_NET_CLIENT_LIST'], capture_output=True, text=True, timeout=1)
    return set(int(value, 16) for value in re.findall(r'0x[0-9a-fA-F]+', result.stdout))
try:
    x = c.CDLL('libX11.so.6')
    x.XOpenDisplay.argtypes = [c.c_char_p]; x.XOpenDisplay.restype = c.c_void_p
    x.XDefaultRootWindow.argtypes = [c.c_void_p]; x.XDefaultRootWindow.restype = c.c_ulong
    x.XInternAtom.argtypes = [c.c_void_p, c.c_char_p, c.c_int]; x.XInternAtom.restype = c.c_ulong
    x.XSendEvent.argtypes = [c.c_void_p, c.c_ulong, c.c_int, c.c_long, c.c_void_p]
    x.XFlush.argtypes = [c.c_void_p]; x.XCloseDisplay.argtypes = [c.c_void_p]
    display = x.XOpenDisplay(None)
    if not display: raise RuntimeError('no display')
    class Client(c.Structure):
        _fields_ = [('type',c.c_int),('serial',c.c_ulong),('sent',c.c_int),('display',c.c_void_p),('window',c.c_ulong),('message',c.c_ulong),('format',c.c_int),('data',c.c_long*5)]
    class Event(c.Union):
        _fields_ = [('client',Client),('padding',c.c_long*24)]
    pending = set()
    for window in windows():
        kind = subprocess.run(['xprop','-id',hex(window),'_NET_WM_WINDOW_TYPE'],capture_output=True,text=True,timeout=1).stdout
        if '_NET_WM_WINDOW_TYPE_NORMAL' not in kind: continue
        event = Event(); event.client.type = 33; event.client.sent = 1
        event.client.display = display; event.client.window = window
        event.client.message = x.XInternAtom(display,b'_NET_CLOSE_WINDOW',0)
        event.client.format = 32; event.client.data[1] = 2
        x.XSendEvent(display,x.XDefaultRootWindow(display),0,(1<<19)|(1<<20),c.byref(event))
        pending.add(window)
    x.XFlush(display)
    deadline = time.monotonic()+4
    while pending and time.monotonic()<deadline:
        time.sleep(0.1); pending.intersection_update(windows())
    if not pending: time.sleep(0.25)
    x.XCloseDisplay(display)
except Exception:
    pass
`
