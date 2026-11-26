"""Per-Bot desktops inside one user's computer container.

Display :1 is the container's base desktop. Each Bot gets its own display (2..64)
with its own X server, window session, D-Bus, HOME and CUA driver socket, so Bots
of one account share the workspace but never share a screen or browser profile.

Run as uid 1000 (cua). Commands:
  start   N TOKEN HOMEKEY   start display N for one Bot (idempotent for the same token)
  stop    N                 stop display N and every process of its session
  inspect N                 print {"running": bool, "token": str|null}
  run     N TOKEN HOMEKEY   internal: the session supervisor started by `start`
"""
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

STATE = Path('/tmp/yaoyao-desktops')
DRIVER = '/usr/local/libexec/openmausbot/cua-driver'
CURSOR_SESSION = Path('/usr/local/libexec/yaoyao/cursor-desktop.py')
GEOMETRY = os.environ.get('YAOYAO_DESKTOP_GEOMETRY', '1280x900')


def fail(message, code=2):
    print(json.dumps({'error': message}), flush=True)
    sys.exit(code)


def display(value):
    if not re.fullmatch(r'[0-9]{1,2}', value) or not 2 <= int(value) <= 64:
        fail('invalid display')
    return int(value)


def token(value):
    if not re.fullmatch(r'[0-9a-f-]{36}', value):
        fail('invalid token')
    return value


def home_key(value):
    if not re.fullmatch(r'[0-9a-f-]{36}', value):
        fail('invalid home')
    return value


def socket_path(n):
    return f'/run/user/1000/yaoyao-cua-{n}.sock'


def files(n):
    return STATE / f'{n}.token', STATE / f'{n}.pid', STATE / f'{n}.log'


def x_alive(n):
    env = {**os.environ, 'DISPLAY': f':{n}'}
    return subprocess.run(['xset', 'q'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode == 0


def driver_alive(n):
    if not Path(socket_path(n)).exists():
        return False
    return subprocess.run([DRIVER, 'call', 'health_report', '{}', '--socket', socket_path(n)],
                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5).returncode == 0


def read_token(n):
    path = files(n)[0]
    if path.is_file() and not path.is_symlink():
        return path.read_text().strip() or None
    return None


def supervisor_pid(n):
    path = files(n)[1]
    try:
        pid = int(path.read_text().strip())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def inspect(n):
    running = supervisor_pid(n) is not None and x_alive(n) and driver_alive(n)
    return {'running': running, 'token': read_token(n)}


def stop(n):
    pid = supervisor_pid(n)
    if pid:
        try:
            os.killpg(pid, signal.SIGTERM)
        except OSError:
            pass
        for _ in range(50):
            if supervisor_pid(n) is None:
                break
            time.sleep(0.1)
        else:
            try:
                os.killpg(pid, signal.SIGKILL)
            except OSError:
                pass
    token_file, pid_file, _ = files(n)
    for path in [token_file, pid_file, Path(socket_path(n)), Path(f'/tmp/.X{n}-lock'), Path(f'/tmp/.X11-unix/X{n}')]:
        try:
            path.unlink()
        except OSError:
            pass


def start(n, value, key):
    STATE.mkdir(mode=0o700, exist_ok=True)
    current = inspect(n)
    if current['running']:
        if current['token'] == value:
            return {'running': True, 'token': value}
        fail('display owned by another desktop', 3)
    stop(n)
    files(n)[0].write_text(value)
    log = open(files(n)[2], 'ab')
    child = subprocess.Popen([sys.executable, __file__, 'run', str(n), value, key], stdin=subprocess.DEVNULL,
                             stdout=log, stderr=log, start_new_session=True)
    files(n)[1].write_text(str(child.pid))
    for _ in range(600):
        if child.poll() is not None:
            fail('desktop exited during startup', 4)
        if x_alive(n) and driver_alive(n):
            return {'running': True, 'token': value}
        time.sleep(0.1)
    stop(n)
    fail('desktop did not become ready', 4)


def run(n, value, key):
    children = []
    stopping = False

    def on_signal(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    home = Path('/home/cua/desktops') / key
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    profiles = home / 'browser-profiles'
    profiles.mkdir(exist_ok=True, mode=0o700)
    for lock in ['SingletonLock', 'SingletonSocket', 'SingletonCookie', '.parentlock', 'parent.lock', 'lock']:
        for found in profiles.rglob(lock):
            try:
                found.unlink()
            except OSError:
                pass
    workspace = home / 'workspace'
    if not workspace.exists():
        workspace.symlink_to('/home/cua/workspace')
    env = {k: v for k, v in os.environ.items() if k not in ('DBUS_SESSION_BUS_ADDRESS', 'SESSION_MANAGER')}
    env.update({'HOME': str(home), 'USER': 'cua', 'DISPLAY': f':{n}', 'XDG_RUNTIME_DIR': '/run/user/1000',
                'XDG_CURRENT_DESKTOP': 'XFCE', 'XDG_SESSION_DESKTOP': 'xfce', 'XDG_SESSION_TYPE': 'x11',
                'YAOYAO_BROWSER_PROFILE': str(profiles), 'YAOYAO_DESKTOP': str(n),
                'CUA_DRIVER_INSTALL_CHANNEL': 'python_package', 'CUA_DRIVER_RS_TELEMETRY_ENABLED': '0'})

    def spawn(argv):
        child = subprocess.Popen(argv, env=env, cwd=str(home), stdin=subprocess.DEVNULL)
        children.append(child)
        return child

    try:
        for path in [Path(f'/tmp/.X{n}-lock'), Path(f'/tmp/.X11-unix/X{n}'), Path(socket_path(n))]:
            try:
                path.unlink()
            except OSError:
                pass
        width, height = GEOMETRY.split('x')
        if shutil.which('Xtigervnc'):
            server = spawn(['Xtigervnc', f':{n}', '-geometry', GEOMETRY, '-depth', '24', '-rfbport', '-1',
                            '-SecurityTypes', 'None', '-nolisten', 'tcp', '-AlwaysShared'])
        else:
            server = spawn(['Xvfb', f':{n}', '-screen', '0', f'{width}x{height}x24', '-nolisten', 'tcp', '-noreset'])
        for _ in range(150):
            if stopping or server.poll() is not None:
                raise RuntimeError('X server exited')
            if x_alive(n):
                break
            time.sleep(0.2)
        else:
            raise RuntimeError('X server did not become ready')
        for setting in (['s', 'off'], ['-dpms'], ['s', 'noblank']):
            subprocess.run(['xset', *setting], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if CURSOR_SESSION.exists():
            session = spawn(['dbus-run-session', '--', 'sh', '-c',
                             'xsetroot -solid "#202734"; (plank &); (/usr/local/bin/yaoyao-browser about:blank &); exec xfwm4 --compositor=off'])
        else:
            session = spawn(['dbus-run-session', '--', 'startxfce4'])
        driver = spawn([DRIVER, 'serve', '--socket', socket_path(n), '--permission-mode', 'standard'])
        critical = [server, session, driver]
        while not stopping:
            if any(child.poll() is not None for child in critical):
                raise RuntimeError('desktop process exited')
            time.sleep(0.5)
    except Exception as error:
        print(error, file=sys.stderr, flush=True)
    finally:
        for child in reversed(children):
            if child.poll() is None:
                child.terminate()
        deadline = time.time() + 3
        for child in children:
            try:
                child.wait(timeout=max(0.1, deadline - time.time()))
            except subprocess.TimeoutExpired:
                child.kill()
        # Session helpers (panel, browser) may outlive their parents; end the whole group.
        try:
            os.killpg(0, signal.SIGTERM)
        except OSError:
            pass


def main(argv):
    if len(argv) < 2:
        fail('usage')
    command = argv[0]
    if command == 'inspect' and len(argv) == 2:
        print(json.dumps(inspect(display(argv[1]))), flush=True)
    elif command == 'stop' and len(argv) == 2:
        stop(display(argv[1]))
        print(json.dumps({'running': False}), flush=True)
    elif command == 'start' and len(argv) == 4:
        print(json.dumps(start(display(argv[1]), token(argv[2]), home_key(argv[3]))), flush=True)
    elif command == 'run' and len(argv) == 4:
        run(display(argv[1]), token(argv[2]), home_key(argv[3]))
    else:
        fail('usage')


if __name__ == '__main__':
    if os.getuid() != 1000:
        fail('must run as cua', 5)
    main(sys.argv[1:])
