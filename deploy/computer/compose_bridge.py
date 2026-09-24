"""Private Compose desktop transport. No network port or Docker socket."""
import base64
import http.server
import json
import os
from pathlib import Path
import secrets
import selectors
import signal
import socketserver
import subprocess
import threading
import time
import uuid
from skill_bundle import install as install_skill

DESKTOP_ID = os.environ.get('YAOYAO_COMPOSE_DESKTOP_ID')
ROOT = Path('/run/yaoyao-private')
BRIDGE = ROOT / 'bridge'
SOCKET = BRIDGE / 'desktop.sock'
INSTANCE = secrets.token_hex(24)
PID1 = None
RESET = BRIDGE / 'reset.json'
LOCK = threading.RLock()
LEASE = None
RESTARTING = False
DRIVER = '/usr/local/libexec/openmausbot/cua-driver'
CUA_SOCKET = '/run/user/1000/openmausbot-cua.sock'
BASE_ENV = {'PATH': '/opt/venv/bin:/usr/local/bin:/usr/bin:/bin', 'DISPLAY': ':1'}
ENV = {**BASE_ENV, 'HOME': '/home/cua', 'USER': 'cua'}

def reset_desktop():
    global RESTARTING, LEASE
    with LOCK:
        if RESTARTING:
            return
        RESTARTING = True
        LEASE = None
        RESET.write_text(json.dumps({'pid1': PID1}))
    # Compose restarts the same service and retains its workspace volume.
    threading.Timer(0.1, lambda: os.kill(1, signal.SIGTERM)).start()

def current(body):
    if RESTARTING or not LEASE or body.get('token') != LEASE['token'] or body.get('instance') != INSTANCE or LEASE['expires'] <= time.monotonic():
        raise ValueError('桌面控制授权已失效')
    return LEASE

def start(argv, cwd, user='cua'):
    # The bridge itself runs as root; commands run in the explicitly selected
    # guest account without acquiring additional container capabilities.
    wrapper = 'import os,sys;os.chdir(sys.argv[1]);os.execvpe(sys.argv[2],sys.argv[2:],os.environ)'
    uid, environment = (0, {**BASE_ENV, 'HOME': '/root', 'USER': 'root'}) if user == 'root' else (1000, ENV)
    return subprocess.Popen(['python3','-c',wrapper,cwd,*argv], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment, user=uid, group=uid, extra_groups=[], start_new_session=True)

def stop_command(process):
    # Every command owns a session/process group. Keep its leader unreaped until
    # this signal, so its PID cannot be reused for an unrelated process group.
    with process.__dict__.setdefault('_yaoyao_lock', threading.RLock()):
        if process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)


def collect(process, data, timeout):
    # communicate() buffers without a limit; drain both pipes and feed stdin
    # together so output and input backpressure cannot deadlock one another.
    streams = selectors.DefaultSelector()
    output = {'stdout': bytearray(), 'stderr': bytearray()}
    pending = memoryview(data or b'')
    deadline = time.monotonic() + timeout
    size = 0
    try:
        for pipe, name in ((process.stdout, 'stdout'), (process.stderr, 'stderr')):
            os.set_blocking(pipe.fileno(), False)
            streams.register(pipe, selectors.EVENT_READ, name)
        if pending:
            os.set_blocking(process.stdin.fileno(), False)
            streams.register(process.stdin, selectors.EVENT_WRITE, 'stdin')
        else:
            process.stdin.close()
        while streams.get_map():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('桌面命令超时')
            for key, _ in streams.select(remaining):
                try:
                    if key.data == 'stdin':
                        try:
                            written = os.write(key.fd, pending[:65536])
                            pending = pending[written:]
                        except BrokenPipeError:
                            pending = pending[:0]
                        if not pending:
                            streams.unregister(key.fileobj)
                            key.fileobj.close()
                    else:
                        chunk = os.read(key.fd, 65536)
                        if not chunk:
                            streams.unregister(key.fileobj)
                            key.fileobj.close()
                        else:
                            size += len(chunk)
                            if size > 8 * 1024 * 1024:
                                raise ValueError('桌面命令输出超过限制')
                            output[key.data].extend(chunk)
                except BlockingIOError:
                    pass
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ValueError('桌面命令超时')
            with process.__dict__.setdefault('_yaoyao_lock', threading.RLock()):
                try:
                    process.wait(timeout=min(.05, remaining))
                    break
                except subprocess.TimeoutExpired:
                    pass
        return {**{name: value.decode('utf-8', 'replace') for name, value in output.items()}, 'exitCode': process.returncode}
    except Exception:
        try:
            stop_command(process)
        except Exception:
            # Only an unconfirmed cleanup requires fencing the whole desktop.
            reset_desktop()
            raise ValueError('尚未确认桌面命令已停止')
        raise
    finally:
        streams.close()
        for pipe in (process.stdin, process.stdout, process.stderr):
            pipe.close()


def run(argv, cwd='/home/cua/workspace', data=None, timeout=30, user='cua'):
    return collect(start(argv, cwd, user), data, timeout)


def operation_id(body):
    value = body.get('operationId')
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('桌面命令标识无效')
    return value


def operations(lease):
    entries = lease.setdefault('operations', {})
    now = time.monotonic()
    for key, value in list(entries.items()):
        if value.get('finished', now) + 120 < now:
            del entries[key]
    return entries

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        global LEASE
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length > 36 * 1024 * 1024:
                raise ValueError('请求过大')
            body = json.loads(self.rfile.read(length) or b'{}')
            if body.get('desktopId') != DESKTOP_ID:
                raise ValueError('桌面身份不匹配')
            op = self.path
            if op == '/health':
                ready = False
                if not RESTARTING:
                    try:
                        result = run([DRIVER, 'call', 'health_report', '{}', '--socket', CUA_SOCKET], timeout=5)
                        ready = result['exitCode'] == 0
                    except Exception:
                        pass
                result = {'id': DESKTOP_ID, 'protocol': 1, 'instance': INSTANCE, 'ready': ready, 'features': ['skills-v1', 'command-cancel-v1']}
            elif op == '/acquire':
                with LOCK:
                    if RESTARTING:
                        raise ValueError('桌面正在重置')
                    if LEASE:
                        if body.get('requestId') != LEASE['requestId'] or body.get('owner') != LEASE['owner']:
                            raise ValueError('共享桌面正在使用')
                        current({'token': LEASE['token'], 'instance': INSTANCE})
                    else:
                        if not isinstance(body.get('requestId'), str) or not isinstance(body.get('owner'), str):
                            raise ValueError('缺少桌面授权身份')
                        LEASE = {'requestId': body['requestId'], 'owner': body['owner'], 'token': secrets.token_hex(32), 'expires': time.monotonic() + 90, 'active': 0}
                    result = {'token': LEASE['token'], 'instance': INSTANCE}
            elif op == '/renew':
                with LOCK:
                    current(body)['expires'] = time.monotonic() + 90
                    result = {'ok': True}
            elif op == '/release':
                with LOCK:
                    current(body)
                    if LEASE['active'] and not body.get('cancel'):
                        raise ValueError('共享桌面仍有未结束操作')
                    LEASE = None
                    result = {'ok': True}
                    if body.get('cancel'):
                        reset_desktop()
            elif op == '/frame':
                path = '/tmp/yaoyao-compose-' + secrets.token_hex(12) + '.png'
                try:
                    frame = run([DRIVER, 'call', 'get_desktop_state', '{}', '--socket', CUA_SOCKET, '--screenshot-out-file', path], timeout=10)
                    if frame['exitCode'] != 0:
                        raise ValueError('桌面画面尚未就绪')
                    data = Path(path).read_bytes()
                    if data[1:4] != b'PNG':
                        raise ValueError('桌面画面无效')
                    result = {'data': base64.b64encode(data).decode(), 'width': int.from_bytes(data[16:20], 'big'), 'height': int.from_bytes(data[20:24], 'big'), 'capturedAt': int(time.time()*1000)}
                finally:
                    Path(path).unlink(missing_ok=True)
            elif op == '/skills-install':
                with LOCK:
                    current(body)
                    result = install_skill(body.get('bundle', {}))
                    current(body)
            elif op == '/cancel':
                key = operation_id(body)
                with LOCK:
                    entries = operations(current(body))
                    command = entries.get(key)
                    if command is None:
                        if len(entries) >= 4096:
                            raise ValueError('桌面操作过多，请稍后重试')
                        # Cancellation may arrive before execute on another
                        # connection. The tombstone prevents that late launch.
                        command = entries[key] = {'finished': time.monotonic()}
                    command['cancelled'] = True
                    process = command.get('process')
                if process is not None:
                    try:
                        stop_command(process)
                    except Exception:
                        raise ValueError('尚未确认桌面命令已停止')
                result = {'ok': True, 'stopped': True, 'operationId': key}
            elif op == '/execute':
                argv = body.get('argv')
                if not isinstance(argv, list) or not argv or len(argv) > 64 or any(not isinstance(x, str) or '\0' in x for x in argv) or sum(map(len, argv)) > 65536:
                    raise ValueError('桌面命令无效')
                cwd = body.get('cwd', '/home/cua/workspace')
                if not isinstance(cwd, str) or (cwd != '/home/cua/workspace' and not cwd.startswith('/home/cua/workspace/')) or '..' in Path(cwd).parts:
                    raise ValueError('Compose 桌面工作目录必须位于 /home/cua/workspace')
                user = body.get('user', 'cua')
                if user not in ('cua', 'root'):
                    raise ValueError('桌面命令用户无效')
                data = base64.b64decode(body['input'], validate=True) if body.get('input') else None
                timeout = min(60, max(1, body.get('timeout', 30000)/1000))
                # Older runners can still execute without operationId; only
                # callers supplying an ID can use targeted cancellation.
                key = operation_id(body) if 'operationId' in body else str(uuid.uuid4())
                with LOCK:
                    lease = current(body)
                    entries = operations(lease)
                    if key in entries:
                        raise ValueError('桌面命令已取消或已执行')
                    if len(entries) >= 4096:
                        raise ValueError('桌面操作过多，请稍后重试')
                    # Spawn while holding the lease lock, then release the lock
                    # before waiting so revocation can stop the container.
                    process = start(argv, cwd, user)
                    command = entries[key] = {'process': process, 'cancelled': False}
                    lease['active'] += 1
                try:
                    result = collect(process, data, timeout)
                    with LOCK:
                        current(body)
                        if command['cancelled']:
                            raise ValueError('桌面命令已取消')
                finally:
                    with LOCK:
                        command.pop('process', None)
                        command['finished'] = time.monotonic()
                        if LEASE is lease:
                            lease['active'] -= 1
            else:
                raise ValueError('桌面数量和创建删除由 Compose 管理')
            payload = json.dumps(result).encode()
            self.send_response(200)
        except Exception as exc:
            code = 'computer_busy' if str(exc) in ('共享桌面正在使用','共享桌面仍有未结束操作') else 'compose_desktop_error'
            payload = json.dumps({'error': str(exc), 'code': code}, ensure_ascii=False).encode()
            self.send_response(409)
        self.send_header('Content-Type','application/json')
        self.send_header('X-Yaoyao-Desktop-Id',DESKTOP_ID)
        self.send_header('Content-Length',str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except BrokenPipeError:
            pass

class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

def expire():
    while True:
        time.sleep(5)
        with LOCK:
            expired = LEASE and LEASE['expires'] <= time.monotonic()
        if expired:
            reset_desktop()

def main():
    global PID1
    if not DESKTOP_ID:
        return
    ROOT.mkdir(exist_ok=True)
    ROOT.chmod(0o700)
    BRIDGE.mkdir(exist_ok=True)
    BRIDGE.chmod(0o755)
    PID1 = Path('/proc/1/stat').read_text().split()[21]
    if RESET.exists() and json.loads(RESET.read_text()).get('pid1') == PID1:
        raise SystemExit(1)  # A new bridge process alone cannot fence old programs.
    RESET.unlink(missing_ok=True)
    SOCKET.unlink(missing_ok=True)
    server = Server(str(SOCKET), Handler)
    SOCKET.chmod(0o600)
    os.chown(SOCKET,1000,1000)
    threading.Thread(target=expire,daemon=True).start()
    server.serve_forever()


if __name__ == '__main__':
    main()
