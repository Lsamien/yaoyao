"""Private Compose desktop transport. No network port or Docker socket."""
import base64
import http.server
import json
import os
from pathlib import Path
import secrets
import signal
import socketserver
import subprocess
import threading
import time

DESKTOP_ID = os.environ.get('YAOYAO_COMPOSE_DESKTOP_ID')
if not DESKTOP_ID:
    raise SystemExit(0)
ROOT = Path('/run/yaoyao-private')
ROOT.mkdir(exist_ok=True)
ROOT.chmod(0o700)
BRIDGE = ROOT / 'bridge'
BRIDGE.mkdir(exist_ok=True)
BRIDGE.chmod(0o755)
SOCKET = BRIDGE / 'desktop.sock'
INSTANCE = secrets.token_hex(24)
PID1 = Path('/proc/1/stat').read_text().split()[21]
RESET = BRIDGE / 'reset.json'
if RESET.exists() and json.loads(RESET.read_text()).get('pid1') == PID1:
    raise SystemExit(1)  # A new bridge process alone cannot fence old programs.
RESET.unlink(missing_ok=True)
SOCKET.unlink(missing_ok=True)
LOCK = threading.RLock()
LEASE = None
RESTARTING = False
DRIVER = '/usr/local/libexec/openmausbot/cua-driver'
CUA_SOCKET = '/run/user/1000/openmausbot-cua.sock'
ENV = {'PATH': '/opt/venv/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/cua', 'USER': 'cua', 'DISPLAY': ':1'}

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

def start(argv, cwd):
    # Change directory after dropping privileges: the persistent workspace is
    # owned by cua and the bridge does not need DAC_OVERRIDE.
    wrapper = 'import os,sys;os.chdir(sys.argv[1]);os.execvpe(sys.argv[2],sys.argv[2:],os.environ)'
    return subprocess.Popen(['python3','-c',wrapper,cwd,*argv], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, user=1000, group=1000, extra_groups=[], start_new_session=True)

def run(argv, cwd='/home/cua/workspace', data=None, timeout=30):
    process = start(argv, cwd)
    try:
        stdout, stderr = process.communicate(data, timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise ValueError('桌面画面服务尚未就绪')
    if len(stdout) + len(stderr) > 8 * 1024 * 1024:
        raise ValueError('桌面命令输出超过限制')
    return {'stdout': stdout.decode('utf-8', 'replace'), 'stderr': stderr.decode('utf-8', 'replace'), 'exitCode': process.returncode}

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
                result = {'id': DESKTOP_ID, 'protocol': 1, 'instance': INSTANCE, 'ready': ready}
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
            elif op == '/execute':
                argv = body.get('argv')
                if not isinstance(argv, list) or not argv or len(argv) > 64 or any(not isinstance(x, str) or '\0' in x for x in argv) or sum(map(len, argv)) > 65536:
                    raise ValueError('桌面命令无效')
                cwd = body.get('cwd', '/home/cua/workspace')
                if not isinstance(cwd, str) or (cwd != '/home/cua/workspace' and not cwd.startswith('/home/cua/workspace/')) or '..' in Path(cwd).parts:
                    raise ValueError('Compose 桌面工作目录必须位于 /home/cua/workspace')
                with LOCK:
                    lease = current(body)
                    # Spawn while holding the lease lock, then release the lock
                    # before waiting so revocation can stop the container.
                    process = start(argv, cwd)
                    lease['active'] += 1
                try:
                    data = base64.b64decode(body['input']) if body.get('input') else None
                    stdout, stderr = process.communicate(data, timeout=min(60, max(1, body.get('timeout', 30000)/1000)))
                    if len(stdout) + len(stderr) > 8*1024*1024:
                        raise ValueError('桌面命令输出超过限制')
                    with LOCK:
                        current(body)
                    result = {'stdout': stdout.decode('utf-8','replace'), 'stderr': stderr.decode('utf-8','replace'), 'exitCode': process.returncode}
                except Exception:
                    reset_desktop()
                    raise
                finally:
                    with LOCK:
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

server = Server(str(SOCKET), Handler)
SOCKET.chmod(0o600)
os.chown(SOCKET,1000,1000)
threading.Thread(target=expire,daemon=True).start()
server.serve_forever()
