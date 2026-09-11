"""Supervise the Cursor desktop using the existing uid, workspace and CUA socket contract."""
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

children = []
critical = []
stopping = False


def stop(*_):
    global stopping
    stopping = True


def spawn(argv, user=True, required=True):
    child = subprocess.Popen(argv, user=1000 if user else None,
                             group=1000 if user else None,
                             extra_groups=[] if user else None)
    children.append(child)
    if required:
        critical.append(child)
    return child


signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    # Run workspace setup as its owner; no extra DAC or CHOWN capability is needed.
    setup = """
from pathlib import Path
import os
root = Path('/home/cua/workspace/.browser-profiles/google-chrome')
root.mkdir(parents=True, exist_ok=True)
for name in ['SingletonLock', 'SingletonSocket', 'SingletonCookie']:
    (root / name).unlink(missing_ok=True)
config = Path('/home/cua/.config')
config.mkdir(exist_ok=True)
link = config / 'google-chrome'
if not link.is_symlink() and not link.exists():
    link.symlink_to(root)
launchers = config / 'plank/dock1/launchers'
launchers.mkdir(parents=True, exist_ok=True)
for name in ['google-chrome', 'xfce4-terminal', 'thunar']:
    (launchers / (name + '.dockitem')).write_text('[PlankDockItemPreferences]\\nLauncher=file:///usr/share/applications/' + name + '.desktop\\n')
"""
    subprocess.run(['python3', '-c', setup], user=1000, group=1000, extra_groups=[], check=True)
    for path in ['/tmp/.X1-lock', '/tmp/.X11-unix/X1', '/run/user/1000/openmausbot-cua.sock', '/run/user/1000/yaoyao-dbus']:
        subprocess.run(['rm', '-f', path], user=1000, group=1000, extra_groups=[], check=True)
    os.environ['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=/run/user/1000/yaoyao-dbus'
    spawn(['dbus-daemon', '--session', '--nofork', '--address=' + os.environ['DBUS_SESSION_BUS_ADDRESS']])
    spawn(['Xvfb', ':1', '-screen', '0', '1280x800x24', '-ac', '-nolisten', 'tcp', '-noreset'])
    for _ in range(100):
        if stopping or any(p.poll() is not None for p in children):
            raise RuntimeError('桌面启动已中断')
        if subprocess.run(['xset', 'q'], user=1000, group=1000, extra_groups=[], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
            break
        time.sleep(0.2)
    else:
        raise RuntimeError('X display :1 did not become ready')
    spawn(['xfwm4', '--compositor=off'])
    subprocess.run(['xsetroot', '-solid', '#202734'], user=1000, group=1000, extra_groups=[])
    spawn(['plank'], required=False)
    spawn(['/usr/local/libexec/openmausbot/cua-driver', 'serve', '--socket', '/run/user/1000/openmausbot-cua.sock', '--permission-mode', 'standard'])
    # A visible browser gives this minimal desktop a usable initial surface.
    spawn(['/usr/local/bin/yaoyao-browser', 'about:blank'], required=False)
    if os.environ.get('YAOYAO_COMPOSE_DESKTOP_ID'):
        spawn(['python3', '/usr/local/libexec/yaoyao/compose_bridge.py'], user=False)
    while not stopping:
        if any(p.poll() is not None for p in critical):
            raise RuntimeError('桌面进程已退出，等待重新启动')
        time.sleep(0.5)
except Exception as error:
    print(error, file=sys.stderr, flush=True)
    sys.exit(1)
finally:
    # Stop the guest session without giving root CAP_KILL in managed containers.
    subprocess.run(['python3', '-c', 'import os,signal; os.kill(-1,signal.SIGTERM)'], user=1000, group=1000, extra_groups=[])
    for child in children:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
