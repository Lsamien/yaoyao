/** Per-command guest supervisor. Its private socket acknowledges cancellation
 * only after the command's process group has been killed and its leader reaped.
 * No image installation is needed: our verified images already contain Python. */
export const COMMAND_ROOT='/run/yaoyao-private/commands'
export const GUEST_COMMAND=String.raw`
import contextlib,fcntl,json,os,select,shutil,signal,socket,subprocess,sys,time,uuid
from pathlib import Path
mode,root,key=sys.argv[1:4]
if str(uuid.UUID(key))!=key: raise ValueError('invalid operation ID')
root=Path(root)
root.mkdir(parents=True,exist_ok=True,mode=0o700)
root.chmod(0o700)
path=root/key
path.mkdir(exist_ok=True,mode=0o700)
lock=open(path/'lock','a')
@contextlib.contextmanager
def locked():
    fcntl.flock(lock,fcntl.LOCK_EX)
    try: yield
    finally: fcntl.flock(lock,fcntl.LOCK_UN)
endpoint=path/'control.sock'
cancelled=path/'cancelled'
done=path/'done'
started=path/'started'
def reply(value):
    print(json.dumps(value),flush=True)
if mode=='cancel':
    with locked():
        cancelled.touch()
        # A tombstone closes the cancel-before-start race. A completed command
        # and a command which has not launched are both safe to acknowledge.
        finished=done.exists() or (not endpoint.exists() and not started.exists())
    if finished:
        reply({'stopped':True})
    else:
        with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as client:
            client.settimeout(6)
            try:
                client.connect(str(endpoint))
                client.sendall(b'cancel\n')
                data=b''
                while b'\n' not in data and len(data)<4096:
                    chunk=client.recv(4096)
                    if not chunk: break
                    data+=chunk
                value=json.loads(data)
                if value.get('stopped') is not True: raise ValueError('command stop unconfirmed')
                reply(value)
            except Exception:
                with locked():
                    if not done.exists(): raise
                reply({'stopped':True})
elif mode=='run':
    user,timeout=sys.argv[4],float(sys.argv[5])
    argv=sys.argv[6:]
    server=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
    process=None
    confirmed=False
    claimed=False
    def stop():
        # Only this supervisor reaps the leader, preventing PID reuse while
        # delivering a signal to its process group.
        if process.returncode is None:
            if os.geteuid()==0 and uid!=0:
                # Managed containers deliberately have no CAP_KILL. Signal
                # as the command's user instead of widening container powers.
                script='import os,signal,sys\ntry: os.killpg(int(sys.argv[1]),signal.SIGKILL)\nexcept ProcessLookupError: pass'
                subprocess.run(['python3','-c',script,str(process.pid)],user=uid,group=uid,extra_groups=[],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,check=True,timeout=5)
            else:
                try: os.killpg(process.pid,signal.SIGKILL)
                except ProcessLookupError: pass
            process.wait(timeout=5)
    try:
        with locked():
            if started.exists() or done.exists():
                raise SystemExit(130)
            claimed=True
            if cancelled.exists():
                confirmed=True
                raise SystemExit(130)
            server.bind(str(endpoint))
            server.listen(4)
            started.touch()
            # Tests exercise the same supervisor under their current account;
            # production always enters as root and selects only cua or root.
            uid=0 if user=='root' else 1000
            options={'user':uid,'group':uid,'extra_groups':[]} if os.geteuid()==0 else {}
            process=subprocess.Popen(argv,start_new_session=True,**options)
        deadline=time.monotonic()+timeout
        while True:
            readable,_,_=select.select([server],[],[],.05)
            if readable:
                with server.accept()[0] as client:
                    client.settimeout(1)
                    if client.recv(32)!=b'cancel\n': raise ValueError('invalid command control')
                    stop()
                    confirmed=True
                    client.sendall(b'{"stopped":true}\n')
                raise SystemExit(130)
            if time.monotonic()>=deadline:
                stop()
                confirmed=True
                print('电脑命令超时',file=sys.stderr,flush=True)
                raise SystemExit(124)
            if process.poll() is not None:
                confirmed=True
                raise SystemExit(process.returncode if process.returncode>=0 else 128-process.returncode)
    finally:
        if process is not None and not confirmed:
            stop()
            confirmed=True
        server.close()
        if claimed:
            with locked():
                if confirmed: done.touch()
                endpoint.unlink(missing_ok=True)
        # Keep recent receipts for cancellation racing with normal completion.
        # Tombstones without a completed launch stay until that launch arrives.
        now=time.time()
        for entry in root.iterdir():
            try:
                if entry!=path and (entry/'done').is_file() and now-(entry/'done').stat().st_mtime>120:
                    shutil.rmtree(entry)
            except FileNotFoundError: pass
else:
    raise ValueError('invalid command operation')
`
