"""Bot-owned WhatsApp pairing, without the Hermes Dashboard dependency graph."""
import atexit
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import threading
import time

class PairingManager:
    def __init__(self):
        self.lock=threading.RLock();self.flows={}
    def public(self,f):return {k:v for k,v in f.items() if k in ('pairing_id','status','qr_payload','error','expires_at','user')}
    def start(self,home,bridge,session,reset=False):
        home,bridge,session=map(lambda p:Path(p).resolve(),(home,bridge,session))
        with self.lock:
            self.flows={k:v for k,v in self.flows.items() if v['status'] in ('starting','waiting','finishing') or v['expires_at']>int((time.time()-600)*1000)}
            for f in self.flows.values():
                if f['home']==str(home) and f['status'] in ('starting','waiting','finishing'):return self.public(f)
            for previous in self.flows.values():
                if previous['home']==str(home):previous.update(status='cancelled',qr_payload=None)
            if (session/'creds.json').exists():
                if not reset:raise ValueError('已有WhatsApp会话；重新关联前请明确选择清除旧会话。')
                backup=home/'platforms/whatsapp/session-backups'/str(time.time_ns());backup.parent.mkdir(parents=True,exist_ok=True,mode=0o700);os.replace(session,backup)
            session.mkdir(parents=True,exist_ok=True,mode=0o700)
            identity=secrets.token_hex(16)
            f={'pairing_id':identity,'status':'starting','home':str(home),'expires_at':int((time.time()+600)*1000),'qr_payload':None}
            process=subprocess.Popen([shutil.which('node') or 'node',str(bridge/'bridge.js'),'--pair-only','--pair-json','--session',str(session)],cwd=bridge,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,encoding='utf8',start_new_session=os.name!='nt',env={**os.environ,'HERMES_HOME':str(home),'WHATSAPP_MODE':'bot','WHATSAPP_DM_POLICY':'pairing'})
            f['process']=process;self.flows[identity]=f
            timer=threading.Timer(600,lambda:self.cancel(identity,home,'expired'));timer.daemon=True;timer.start();f['timer']=timer
            thread=threading.Thread(target=self._watch,args=(f,process,session),daemon=True);f['thread']=thread;thread.start()
            return self.public(f)
    def _watch(self,f,process,session):
        connected=False
        try:
            for line in process.stdout:
                try:event=json.loads(line)
                except (ValueError,TypeError):continue
                with self.lock:
                    if f['status'] not in ('starting','waiting','finishing'):continue
                    kind=event.get('event')
                    if kind=='qr':f.update(status='waiting',qr_payload=str(event.get('qr',''))[:20000])
                    elif kind=='connected':connected=True;f.update(status='finishing',qr_payload=None,user=event.get('user'))
                    elif kind=='error':f.update(status='error',error='WhatsApp关联失败，请核对账号和网络。',qr_payload=None)
            code=process.wait(timeout=5)
            with self.lock:
                if f['status'] in ('starting','waiting','finishing'):
                    try:valid=isinstance(json.loads((session/'creds.json').read_text()),dict)
                    except Exception:valid=False
                    f.update(status='connected' if connected and code==0 and valid else 'error',qr_payload=None)
                    if f['status']=='error':f['error']='WhatsApp关联未完成，请重试。'
        finally:
            if process.poll() is None:self._stop(process)
            process.stdout.close()
            f['timer'].cancel()
    def _stop(self,process):
        try:
            process.terminate();process.wait(timeout=3)
        except subprocess.TimeoutExpired:process.kill();process.wait(timeout=3)
        except ProcessLookupError:pass
    def get(self,identity,home):
        with self.lock:
            f=self.flows.get(identity)
            if not f or f['home']!=str(Path(home).resolve()):raise ValueError('关联操作不存在或已结束。')
            return self.public(f)
    def cancel(self,identity,home,status='cancelled',invalidate=False):
        with self.lock:
            self.get(identity,home);f=self.flows[identity]
            if invalidate or f['status'] in ('starting','waiting','finishing') or f['status']=='connected' and not f.get('applied'):f.update(status=status,qr_payload=None)
            process=f['process'];f['timer'].cancel()
        if process.poll() is None:self._stop(process)
        if f.get('thread') is not threading.current_thread():f['thread'].join(timeout=4)
        return self.public(f)
    def apply(self,identity,home,callback):
        with self.lock:
            self.get(identity,home);f=self.flows[identity]
            if f['status']!='connected':raise ValueError('关联已取消或尚未完成，请重新读取状态。')
            if f.get('applied'):return {'ok':True,'alreadyApplied':True}
            result=callback();f['applied']=True
            return result
    def invalidate_home(self,home):
        for identity,f in list(self.flows.items()):
            if f['home']==str(Path(home).resolve()):self.cancel(identity,home,invalidate=True)
    def close(self):
        for identity,f in list(self.flows.items()):self.cancel(identity,f['home'])
manager=PairingManager()
atexit.register(manager.close)
