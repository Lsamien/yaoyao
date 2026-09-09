"""Disposable UI fixture; use distinct ports for concurrent native clients."""
import argparse, base64, json, time, threading, hashlib, struct
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,required=True);parser.add_argument('--image',required=True);args=parser.parse_args()
image_bytes=Path(args.image).read_bytes()
image=base64.b64encode(image_bytes).decode()
width,height=struct.unpack('>II',image_bytes[16:24])
state={'mode':'agent','generation':1,'controlId':None,'actions':[],'notes':''}
agents=[dict(id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',name='环境助手甲',avatar='',instructions='',nodeId='local',profile='default',archived=False,revision=1,execution='computer'),dict(id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name='环境助手乙',avatar='',instructions='',nodeId='local',profile='default',archived=False,revision=1,execution='computer')]
agents[1].update(computerEnvironmentId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',computerEnvironmentName='协作电脑')
env={'legacy':False,'shared':[],'jobs':[],'image':'sha256:'+'a'*64,'previous':None,'uploaded':0}
lock=threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self,value):
        data=json.dumps(value,ensure_ascii=False).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_GET(self):
        with lock:
            if self.path=='/fixture/state': return self.respond({**state,**env})
            if self.path=='/api/app/computers':
                if env['legacy']: self.send_error(404);return
                return self.respond({'canManageImages':True,'computers':[{'agent':a,'available':True,'reason':'可以打开电脑面板'} for a in agents]})
            if self.path=='/api/app/computers/shared': return self.respond({'computers':env['shared']})
            if self.path=='/api/app/admin/runners': return self.respond({'runners':[{'id':'11111111-1111-4111-8111-111111111111','name':'测试执行节点','enabled':True,'online':True}]})
            if '/images/jobs/' in self.path and '/chunk' in self.path: return self.respond({'data':base64.b64encode(b'fixture-image').decode(),'offset':0,'size':13,'manifest':{'protocol':1}})
            if self.path.endswith('/images'): return self.respond({'configured':True,'busy':False,'activeImageId':env['image'],'previousImageId':env['previous'],'images':[{'imageId':'sha256:'+'a'*64,'architecture':'arm64','driver':'0.20.0'},{'imageId':'sha256:'+'b'*64,'architecture':'arm64','driver':'0.20.0'}],'jobs':env['jobs'],'uploads':[]})
            if self.path.endswith('/frame'): return self.respond({'id':'22222222-2222-4222-8222-222222222222','generation':state['generation'],'data':image,'width':width,'height':height,'capturedAt':int(time.time()*1000)})
            if self.path.endswith('/computer'): return self.respond({**state,'canResume':True})
            return self.respond({'ok':True,'csrfToken':'fixture','features':['computerControl']})
    def do_POST(self):
        data=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or b'{}')
        with lock:
            if self.path=='/fixture/reset':
                state.update(mode='agent',generation=1,controlId=None,actions=[],notes='');env.update(legacy=False,shared=[],jobs=[],image='sha256:'+'a'*64,previous=None,uploaded=0)
            elif self.path=='/fixture/legacy': env['legacy']=True
            elif self.path=='/api/app/computers/shared': env['shared'].append({'id':'cccccccc-cccc-4ccc-8ccc-cccccccccccc','name':data['name'],'memberIds':data['memberIds']})
            elif self.path.endswith('/images/jobs'):
                if data['operation'] in ['activate','rollback']: env['image'],env['previous']=(data.get('imageId') or env['previous']),env['image']
                job={'id':data['requestId'],'operation':data['operation'],'state':'complete','message':'镜像操作完成','createdAt':1,'updatedAt':1}
                if data['operation']=='export':job['archiveSize']=13
                env['jobs'].insert(0,job)
            elif self.path.endswith('/images/uploads'): return self.respond({'id':data['id'],'offset':0})
            elif '/images/uploads/' in self.path:
                env['uploaded']+=len(base64.b64decode(data['data']));return self.respond({'offset':env['uploaded']})
            elif self.path.endswith('/take'):
                state.update(mode='human',generation=state['generation']+1,controlId='11111111-1111-4111-8111-111111111111')
                return self.respond({**state,'token':'fixture-private-control-token-1234567890','canResume':True})
            elif self.path.endswith('/input'): state['actions'].append(data.get('action'))
            elif self.path.endswith('/giveback'): state.update(mode='agent',generation=state['generation']+1,controlId=None,notes=data.get('notes',''))
            return self.respond({'ok':True})
    def do_DELETE(self):
        with lock:
            if '/computers/shared/' in self.path: env['shared']=[]
            return self.respond({'ok':True})
print(f'native computer fixture on 127.0.0.1:{args.port}',flush=True)
ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
