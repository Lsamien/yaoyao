"""Exercise the real bundled AIAgent against a deterministic model endpoint."""
import json
import sys
import os
import ast
import hashlib
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]


class Model(BaseHTTPRequestHandler):
    calls = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append(body)
        used_tool = any(m.get('role') == 'tool' for m in body['messages'])
        message = {'role': 'assistant', 'content': '执行完成：收到工具结果。'} if used_tool else {
            'role': 'assistant', 'content': None,
            'tool_calls': [{'id': 'call-proof', 'type': 'function', 'function': {'name': 'proof_read', 'arguments': '{"path":"proof.txt"}'}}],
        }
        finish = 'stop' if used_tool else 'tool_calls'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if body.get('stream'):
            delta = dict(message)
            if 'tool_calls' in delta:
                delta['tool_calls'][0]['index'] = 0
            for part in [{'id':'test','object':'chat.completion.chunk','model':'test-model','choices':[{'index':0,'delta':delta,'finish_reason':None}]},
                         {'id':'test','object':'chat.completion.chunk','model':'test-model','choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}]:
                self.wfile.write(('data: '+json.dumps(part)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.wfile.write(json.dumps({'id':'test','object':'chat.completion','model':'test-model','choices':[{'index':0,'message':message,'finish_reason':finish}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode())


class LegacyMemoryModel(Model):
    """Calls the retired native ``memory`` tool, then the workspace tool, then answers."""
    calls = []

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.calls.append(body)
        tool_messages = [m for m in body['messages'] if m.get('role') == 'tool']
        if not tool_messages:
            call = {'id': 'call-legacy', 'type': 'function', 'function': {'name': 'memory', 'arguments': '{"action":"add","content":"x"}'}}
        elif len(tool_messages) == 1:
            call = {'id': 'call-workspace', 'type': 'function', 'function': {'name': 'workspace_memory_search', 'arguments': '{"scope":"agent"}'}}
        else:
            call = None
        message = {'role': 'assistant', 'content': None, 'tool_calls': [call]} if call else {'role': 'assistant', 'content': '记忆检查完成。'}
        finish = 'tool_calls' if call else 'stop'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
        self.end_headers()
        if body.get('stream'):
            delta = json.loads(json.dumps(message))
            if 'tool_calls' in delta:
                delta['tool_calls'][0]['index'] = 0
            for part in [{'id':'test','object':'chat.completion.chunk','model':'test-model','choices':[{'index':0,'delta':delta,'finish_reason':None}]},
                         {'id':'test','object':'chat.completion.chunk','model':'test-model','choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}]:
                self.wfile.write(('data: '+json.dumps(part)+'\n\n').encode())
            self.wfile.write(b'data: [DONE]\n\n')
        else:
            self.wfile.write(json.dumps({'id':'test','object':'chat.completion','model':'test-model','choices':[{'index':0,'message':message,'finish_reason':finish}],'usage':{'prompt_tokens':100,'completion_tokens':20,'total_tokens':120}}).encode())


class KernelTest(unittest.TestCase):
    def exchange(self, request, *, interrupt_at_tool=False, approve=True, on_frame=None, steer_phase=None):
        with tempfile.TemporaryFile(mode='w+') as errors:
            entry = [str(ROOT/'tests/runtime/steer_phase_worker.py'), steer_phase] if steer_phase else [str(ROOT/'runtime/worker.py')]
            child=subprocess.Popen([str(ROOT/'.venv/bin/python'),'-u',*entry],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,text=True)
            timeout=threading.Timer(40,child.kill);timeout.start();events=[]
            try:
                child.stdin.write(json.dumps(request)+'\n');child.stdin.flush()
                for line in child.stdout:
                    frame=json.loads(line);events.append(frame)
                    if on_frame:
                        on_frame(frame, lambda message: (child.stdin.write(json.dumps(message)+'\n'), child.stdin.flush()))
                    if frame['type']=='tool.request':
                        if interrupt_at_tool == 'cancel':
                            child.stdin.write(json.dumps({'type':'interrupt'})+'\n');child.stdin.flush();continue
                        if interrupt_at_tool:
                            child.kill();break
                        result={'allow':approve} if frame['name'] in ('yaovi_mcp_approve','yaovi_native_authorize') else {'text':'random-proof-762'}
                        child.stdin.write(json.dumps({'id':frame['id'],'result':result})+'\n');child.stdin.flush()
                child.wait(timeout=5)
            finally:
                timeout.cancel();child.kill();child.wait(timeout=5);child.stdin.close();child.stdout.close()
            if not interrupt_at_tool:
                errors.seek(0);self.assertEqual(child.returncode,0,errors.read()[-3000:]+str(events))
            return events

    def test_hermes_resolves_provider_from_config_and_system_env(self):
        """No baseURL/apiKey on the route: Hermes resolves custom_providers + the system-layer .env key."""
        seen = []
        class AuthModel(Model):
            def do_POST(self):
                seen.append(self.headers.get('Authorization'))
                super().do_POST()
        Model.calls=[]
        server=ThreadingHTTPServer(('127.0.0.1',0),AuthModel)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='yaovi-hermes-root-') as root, tempfile.TemporaryDirectory(prefix='yaovi-bot-') as directory:
            Path(root, '.env').write_text('PROOF_API_KEY=secret-proof-key\n')
            os.environ['YAOVI_HERMES_ROOT']=root
            self.addCleanup(os.environ.pop,'YAOVI_HERMES_ROOT',None)
            endpoint=f'http://127.0.0.1:{server.server_port}/v1'
            request={'workspaceId':'local','botId':'bot-one','sessionId':'session-hermes','runId':'run-hermes','dataRoot':directory,
                     'route':{'provider':'proof','model':'test-model','reasoningEffort':'none'},
                     'config':{'agent':{'max_iterations':4},'memory':{'enabled':False,'automatic':False},'delegation':{'enabled':False},'compression':{'enabled':False},
                               'model':{'provider':'proof','default':'test-model','context_length':128000},
                               'custom_providers':[{'name':'proof','base_url':endpoint,'key_env':'PROOF_API_KEY','api_mode':'chat_completions'}]},
                     'instructions':'Use proof_read once.','text':'Read proof.txt.',
                     'tools':[{'name':'proof_read','description':'Read a test artifact','parameters':{'type':'object','properties':{'path':{'type':'string'}}}}]}
            events=self.exchange(request)
            self.assertEqual(events[-1]['type'],'completed',events[-3:])
            self.assertIn('Bearer secret-proof-key',seen)

    def test_compiled_mcp_servers_expose_native_hermes_mcp_tools(self):
        """config.mcp_servers (compiled by Yaoyao) connects via Hermes; ${VAR} resolves from the system .env."""
        calls = []
        class McpModel(Model):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(body)
                done = any(m.get('role') == 'tool' for m in body['messages'])
                message = {'role': 'assistant', 'content': 'MCP 完成'} if done else {'role': 'assistant', 'content': None,
                    'tool_calls': [{'id': 'call-mcp', 'type': 'function', 'function': {'name': 'mcp__fake__secret_tag', 'arguments': '{}'}}]}
                finish='stop' if done else 'tool_calls'
                self.send_response(200);self.send_header('Content-Type', 'text/event-stream');self.end_headers()
                if 'tool_calls' in message:
                    message['tool_calls'][0]['index']=0
                for part in [{'id':'t','object':'chat.completion.chunk','model':'test-model','choices':[{'index':0,'delta':message,'finish_reason':None}]},
                             {'id':'t','object':'chat.completion.chunk','model':'test-model','choices':[{'index':0,'delta':{},'finish_reason':finish}],'usage':{'prompt_tokens':1,'completion_tokens':1,'total_tokens':2}}]:
                    self.wfile.write(('data: '+json.dumps(part)+'\n\n').encode())
                self.wfile.write(b'data: [DONE]\n\n')
        server=ThreadingHTTPServer(('127.0.0.1',0),McpModel)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='yaovi-hermes-root-') as root, tempfile.TemporaryDirectory(prefix='yaovi-bot-') as directory:
            Path(root, '.env').write_text('MCP_FAKE_SECRET=s3cret\n')
            os.environ['YAOVI_HERMES_ROOT']=root
            self.addCleanup(os.environ.pop,'YAOVI_HERMES_ROOT',None)
            request={'workspaceId':'local','botId':'bot-one','sessionId':'session-mcp','runId':'run-mcp','dataRoot':directory,
                     'route':{'provider':'openai','apiMode':'chat_completions','model':'test-model','baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'test','reasoningEffort':'none'},
                     'config':{'agent':{'max_iterations':4},'memory':{'memory_enabled':False,'user_profile_enabled':False,'automatic':False},'delegation':{'enabled':False},'model':{'context_length':128000},'compression':{'enabled':False},
                               'mcp_servers':{'fake':{'command':str(ROOT/'.venv/bin/python'),'args':[str(ROOT/'tests/fixtures/fake_mcp_server.py')],'env':{'FAKE_MCP_SECRET':'${MCP_FAKE_SECRET}'},'tools':{'include':['secret_tag']}},
                                              'off':{'command':'/nonexistent','enabled':False}}},
                     'instructions':'Use the MCP tool.','text':'Check the secret.','tools':[]}
            events=self.exchange(request)
            self.assertEqual(events[-1]['type'],'completed',events[-3:])
            names={t['function']['name'] for t in calls[0]['tools']}
            self.assertIn('mcp__fake__secret_tag',names)
            self.assertNotIn('mcp__fake__echo',names)
            tool_msgs=[m for m in calls[-1]['messages'] if m.get('role')=='tool']
            self.assertIn('yes',json.dumps(tool_msgs))
            self.assertEqual([e['arguments']['tool'] for e in events if e['type']=='tool.request'],['mcp__fake__secret_tag'])
            # Denied: the server is never called and the model sees the refusal.
            calls.clear()
            events=self.exchange({**request,'sessionId':'session-mcp-deny','runId':'run-mcp-deny'},approve=False)
            denied=json.dumps([m for m in calls[-1]['messages'] if m.get('role')=='tool'],ensure_ascii=False)
            self.assertIn('未批准',denied)
            self.assertNotIn('yes',denied)
            # Managed policy checks the native entry and the existing MCP guard
            # with the same model call identity, so one grant is not duplicated.
            calls.clear()
            events=self.exchange({**request,'botPolicy':{'enabled':True,'foreground':False},'sessionId':'session-mcp-managed','runId':'run-mcp-managed'})
            admissions=[e for e in events if e['type']=='tool.request']
            self.assertEqual([e['name'] for e in admissions],['yaovi_native_authorize','yaovi_mcp_approve'])
            self.assertEqual([e['modelCallId'] for e in admissions],['call-mcp','call-mcp'])
            self.assertIn('yes',json.dumps([m for m in calls[-1]['messages'] if m.get('role')=='tool']))

    def steer_request(self, directory, endpoint, session, **extra):
        return {'workspaceId':'local','botId':'bot-one','sessionId':session,'runId':'run-'+session,'dataRoot':directory,
                'route':{'model':'test-model','baseURL':endpoint,'apiKey':'test','reasoningEffort':'none'},
                'config':{'agent':{'max_iterations':4},'memory':{'enabled':False,'automatic':False},'delegation':{'enabled':False},'model':{'context_length':128000},'compression':{'enabled':False}},
                'instructions':'Use proof_read once.','text':'Read proof.txt.',
                'tools':[{'name':'proof_read','description':'Read a test artifact','parameters':{'type':'object','properties':{'path':{'type':'string'}}}}],**extra}

    def test_steer_during_tool_batch_is_inserted_as_user_row_without_interrupting(self):
        """Hermes AIAgent.steer(): accepted mid-run, lands as its own user row after the tool batch, turn completes normally."""
        Model.calls=[]
        server=ThreadingHTTPServer(('127.0.0.1',0),Model)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='yaovi-steer-') as directory:
            def steer_at_tool(frame, send):
                if frame['type']=='tool.request' and frame['name']=='proof_read':
                    send({'type':'steer','id':'steer-1','text':'顺便：回复用英文'})
            events=self.exchange(self.steer_request(directory,f'http://127.0.0.1:{server.server_port}/v1','session-steer'),on_frame=steer_at_tool)
            results=[e for e in events if e['type']=='steer.result']
            self.assertEqual([(r['id'],r['accepted']) for r in results],[('steer-1',True)],events)
            self.assertEqual(events[-1]['type'],'completed',events[-3:])
            self.assertFalse([e for e in events if e['type']=='steer.leftover'],'absorbed steer must not be re-delivered')
            last=Model.calls[-1]['messages']
            user_rows=[m for m in last if m.get('role')=='user']
            self.assertTrue(any('顺便：回复用英文' in json.dumps(m,ensure_ascii=False) for m in user_rows[1:]),last)
            self.assertEqual(last[-1]['role'],'user')

    def test_model_time_steer_continues_same_turn_and_preserves_completed_tools(self):
        """Real Hermes redirects before/during text, including repeated inserts and a completed tool."""
        for phase in ('before_text', 'during_text', 'after_tool', 'repeated', 'non_streaming'):
            with self.subTest(phase=phase):
                before_text = phase in ('before_text', 'non_streaming')
                started = threading.Event()
                acknowledged = [threading.Event(), threading.Event()]
                corrections = ['补一句：用中文', '再补一句：只说验证成功']
                expected = corrections if phase == 'repeated' else corrections[:1]
                class RedirectModel(Model):
                    calls = []
                    def do_POST(self):
                        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                        self.calls.append(body)
                        rows = body['messages']
                        correction_count = sum(any(text in str(row.get('content', '')) for row in rows if row['role'] == 'user') for text in expected)
                        tool = phase == 'after_tool' and not any(row['role'] == 'tool' for row in rows)
                        wait_for_insert = not tool and correction_count < len(expected)
                        if wait_for_insert:
                            started.set()
                            if before_text:
                                acknowledged[correction_count].wait(5)
                        message = {'role': 'assistant', 'content': '验证成功'}
                        if tool:
                            message = {'role': 'assistant', 'content': None, 'tool_calls': [
                                {'index': 0, 'id': 'proof-once', 'type': 'function', 'function': {'name': 'proof_read', 'arguments': '{}'}}]}
                        elif wait_for_insert:
                            message['content'] = f'正在生成旧回答{correction_count}'
                        try:
                            self.send_response(200)
                            self.send_header('Content-Type', 'text/event-stream' if body.get('stream') else 'application/json')
                            self.end_headers()
                            if not body.get('stream'):
                                self.wfile.write(json.dumps({'id':'t','object':'chat.completion','model':'test-model',
                                    'choices':[{'index':0,'message':message,'finish_reason':'stop'}]}).encode())
                                return
                            def delta(value, finish=None):
                                self.wfile.write(('data: '+json.dumps({'id':'t','object':'chat.completion.chunk','model':'test-model',
                                    'choices':[{'index':0,'delta':value,'finish_reason':finish}]})+'\n\n').encode())
                                self.wfile.flush()
                            delta(message)
                            if wait_for_insert and not before_text:
                                acknowledged[correction_count].wait(5)
                            delta({}, 'tool_calls' if tool else 'stop')
                            self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
                        except (BrokenPipeError, ConnectionResetError):
                            pass  # The superseded model request is intentionally closed.
                server = ThreadingHTTPServer(('127.0.0.1', 0), RedirectModel)
                threading.Thread(target=server.serve_forever, daemon=True).start()
                try:
                    with tempfile.TemporaryDirectory(prefix='yaovi-redirect-') as directory:
                        sent = set()
                        sender = None
                        def on_frame(frame, send):
                            nonlocal sender
                            if before_text and frame['type'] == 'ready':
                                def send_before_text():
                                    if started.wait(10):
                                        send({'type':'steer','id':'insert-0','text':expected[0]})
                                sender = threading.Thread(target=send_before_text, daemon=True);sender.start()
                            if not before_text and frame['type'] == 'message.delta':
                                for index, correction in enumerate(expected):
                                    if f'正在生成旧回答{index}' in (frame.get('text') or '') and index not in sent:
                                        sent.add(index)
                                        send({'type':'steer','id':f'insert-{index}','text':correction})
                            if frame['type'] == 'steer.result':
                                acknowledged[int(frame['id'].split('-')[-1])].set()
                        request = self.steer_request(directory, f'http://127.0.0.1:{server.server_port}/v1', 'session-'+phase,
                            instructions='Read proof once then answer.' if phase == 'after_tool' else 'Answer in plain text.', text='你好')
                        # A redirect reuses the current iteration, even at the one-iteration limit.
                        if phase != 'after_tool':
                            request['tools'] = []
                            request['config']['agent']['max_iterations'] = 1
                        if phase == 'non_streaming':
                            request['config']['model']['streaming'] = False
                        events = self.exchange(request, on_frame=on_frame)
                        if sender:
                            sender.join(1)
                        self.assertEqual([(e['id'], e['accepted']) for e in events if e['type']=='steer.result'],
                                         [(f'insert-{i}', True) for i in range(len(expected))], events)
                        self.assertFalse([e for e in events if e['type']=='steer.leftover'], events)
                        self.assertEqual([e['text'] for e in events if e['type']=='completed'], ['验证成功'])
                        self.assertEqual(len(RedirectModel.calls), len(expected) + 1 + int(phase == 'after_tool'))
                        self.assertEqual(bool(RedirectModel.calls[-1].get('stream')), phase != 'non_streaming')
                        last = RedirectModel.calls[-1]['messages']
                        for correction in expected:
                            self.assertEqual(sum(correction in str(row.get('content', '')) for row in last if row['role']=='user'), 1, last)
                        tool_calls = [e for e in events if e['type']=='tool.request' and e['name']=='proof_read']
                        self.assertEqual(len(tool_calls), 1 if phase == 'after_tool' else 0)
                        with sqlite3.connect(Path(directory, 'state.db')) as db:
                            saved = db.execute("select content from messages where role='user'").fetchall()
                        for correction in expected:
                            self.assertEqual(sum(correction in row[0] for row in saved), 1, saved)
                finally:
                    for gate in acknowledged:
                        gate.set()
                    server.shutdown();server.server_close()

    def test_steer_covers_initialization_preparation_and_reply_commit(self):
        """Pause the real worker at exact lifecycle boundaries, without relying on model latency."""
        for phase in ('initializing', 'ready', 'preparing', 'settling', 'committed'):
            with self.subTest(phase=phase):
                correction = '补充要求：只回复准备阶段验证成功'
                class PreparationModel(Model):
                    calls = []
                    def do_POST(self):
                        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                        self.calls.append(body)
                        inserted = any(correction in str(m.get('content', '')) for m in body['messages'] if m['role']=='user')
                        self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers()
                        self.wfile.write(json.dumps({'id':'t','object':'chat.completion','model':'test-model','choices':[
                            {'index':0,'message':{'role':'assistant','content':'准备阶段验证成功' if inserted else '原始回答'},'finish_reason':'stop'}]}).encode())
                server = ThreadingHTTPServer(('127.0.0.1',0),PreparationModel)
                threading.Thread(target=server.serve_forever,daemon=True).start()
                try:
                    with tempfile.TemporaryDirectory(prefix='yaovi-preparing-') as directory:
                        def on_frame(frame, send):
                            if frame['type']=='test.steer_phase':
                                send({'type':'steer','id':'phase-insert','text':correction})
                        request = self.steer_request(directory,f'http://127.0.0.1:{server.server_port}/v1','session-'+phase,
                                                     tools=[],text='原始问题',instructions='Answer in plain text.')
                        request['config']['model']['streaming'] = False
                        request['config']['agent']['max_iterations'] = 1
                        events = self.exchange(request,on_frame=on_frame,steer_phase=phase)
                        accepted = phase != 'committed'
                        self.assertEqual([e['accepted'] for e in events if e['type']=='steer.result'],[accepted],events)
                        self.assertFalse([e for e in events if e['type']=='steer.leftover'],events)
                        self.assertEqual([e['text'] for e in events if e['type']=='completed'],
                                         ['准备阶段验证成功' if accepted else '原始回答'])
                        self.assertEqual(len(PreparationModel.calls),2 if phase=='settling' else 1)
                        last = PreparationModel.calls[-1]['messages']
                        self.assertEqual(sum(correction in str(m.get('content','')) for m in last if m['role']=='user'),int(accepted),last)
                        with sqlite3.connect(Path(directory,'state.db')) as db:
                            saved = db.execute("select content from messages where role='user'").fetchall()
                        self.assertEqual(sum(correction in row[0] for row in saved),int(accepted),saved)
                finally:
                    server.shutdown();server.server_close()

    def test_restart_restores_history_without_replaying_completed_tool(self):
        Model.calls=[]
        server=ThreadingHTTPServer(('127.0.0.1',0),Model)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='yaovi-resume-') as directory:
            request={'workspaceId':'local','botId':'bot-one','sessionId':'session-resume','runId':'run-one','dataRoot':directory,
                     'route':{'model':'test-model','baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'test','reasoningEffort':'none'},
                     'config':{'agent':{'max_iterations':4},'memory':{'enabled':False,'automatic':False},'delegation':{'enabled':False},'model':{'context_length':128000},'compression':{'enabled':False}},
                     'instructions':'Use proof_read once.','text':'Read proof.txt.',
                     'tools':[{'name':'proof_read','description':'Read a test artifact','parameters':{'type':'object','properties':{'path':{'type':'string'}}}}]}
            first=self.exchange(request)
            # Resume an actual pre-rename persisted prompt. Only the two built-in
            # identity/help blocks may change; tools, history and quoted names stay.
            constants={}
            source=ast.parse((ROOT/'runtime/hermes/agent/prompt_builder.py').read_text())
            for node in source.body:
                if isinstance(node,ast.Assign) and isinstance(node.targets[0],ast.Name) and node.targets[0].id in ('DEFAULT_AGENT_IDENTITY','HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS'):
                    constants[node.targets[0].id]=ast.literal_eval(node.value)
            with sqlite3.connect(Path(directory)/'state.db') as db:
                prompt=db.execute('SELECT p.prompt FROM sessions s JOIN system_prompts p ON p.hash=s.system_prompt_hash WHERE s.id=?',(request['sessionId'],)).fetchone()[0]
                self.assertTrue(prompt.startswith('You are Yaoyao (夭夭 AI).'))
                legacy=constants['DEFAULT_AGENT_IDENTITY']+'\n\n'+constants['HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS']+'\n\n'+prompt.split('\n\n',2)[2]+'\n\nHistorical note: Hermes is a source dependency.'
                digest=hashlib.sha256(legacy.encode()).hexdigest()
                db.execute('INSERT INTO system_prompts(hash,prompt) VALUES(?,?)',(digest,legacy))
                db.execute('UPDATE sessions SET system_prompt_hash=? WHERE id=?',(digest,request['sessionId']))
            request.update(runId='run-two',text='Recall the previous result.')
            second=self.exchange(request)
            self.assertEqual(sum(e['type']=='tool.request' for e in first),1)
            self.assertEqual(sum(e['type']=='tool.request' for e in second),0)
            self.assertIn('random-proof-762',json.dumps(Model.calls[-1]))
            users=[m for m in Model.calls[-1]['messages'] if m['role']=='user']
            self.assertEqual(sum(m.get('content')=='Recall the previous result.' for m in users),1)
            system='\n'.join(m['content'] for m in Model.calls[-1]['messages'] if m['role'] in ('system','developer'))
            self.assertIn('You are Yaoyao (夭夭 AI).',system)
            self.assertNotIn('You are Hermes Agent',system)
            self.assertNotIn('You run on Hermes Agent',system)
            self.assertIn('Historical note: Hermes is a source dependency.',system)

    def test_restart_marks_unconfirmed_tool_unknown_without_replay(self):
        Model.calls=[]
        server=ThreadingHTTPServer(('127.0.0.1',0),Model)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='yaovi-unknown-') as directory:
            request={'workspaceId':'local','botId':'bot-one','sessionId':'session-unknown','runId':'run-one','dataRoot':directory,
                     'route':{'model':'test-model','baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'test','reasoningEffort':'none'},
                     'config':{'agent':{'max_iterations':4},'memory':{'enabled':False,'automatic':False},'delegation':{'enabled':False},'model':{'context_length':128000},'compression':{'enabled':False}},
                     'instructions':'Use proof_read once.','text':'Read proof.txt.',
                     'tools':[{'name':'proof_read','description':'Read a test artifact','parameters':{'type':'object','properties':{'path':{'type':'string'}}}}]}
            first=self.exchange(request,interrupt_at_tool=True)
            self.assertTrue(any(e['type']=='tool.request' for e in first))
            request.update(runId='run-two',text='Inspect the previous outcome before proceeding.')
            second=self.exchange(request)
            self.assertFalse(any(e['type']=='tool.request' for e in second))
            self.assertTrue(any('outcomeUnknown' in str(m.get('content')) for m in Model.calls[-1]['messages'] if m['role']=='tool'))

    def test_cancel_releases_pending_rpc_and_saves_interrupted_checkpoint(self):
        Model.calls=[]
        server=ThreadingHTTPServer(('127.0.0.1',0),Model)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='yaovi-cancel-') as directory:
            request={'workspaceId':'local','botId':'bot-one','sessionId':'session-cancel','runId':'run-one','dataRoot':directory,
                     'route':{'model':'test-model','baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'test','reasoningEffort':'none'},
                     'config':{'agent':{'max_iterations':4},'memory':{'enabled':False,'automatic':False},'delegation':{'enabled':False},'model':{'context_length':128000},'compression':{'enabled':False}},
                     'instructions':'Use proof_read once.','text':'Read proof.txt.',
                     'tools':[{'name':'proof_read','description':'Read a test artifact','parameters':{'type':'object','properties':{'path':{'type':'string'}}}}]}
            started=time.monotonic();events=self.exchange(request,interrupt_at_tool='cancel')
            self.assertLess(time.monotonic()-started,10)
            self.assertTrue(any(e['type']=='failed' for e in events))
            checkpoint=json.loads((Path(directory)/'contexts/session-cancel.json').read_text())
            self.assertEqual(checkpoint['status'],'interrupted')

    def test_real_loop_routes_tool_and_persists_context(self):
        Model.calls=[]
        server=ThreadingHTTPServer(('127.0.0.1',0),Model)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        with tempfile.TemporaryDirectory(prefix='yaovi-kernel-') as directory:
            request={'workspaceId':'local','botId':'bot-one','sessionId':'session-one','runId':'run-one','dataRoot':directory,
                     'route':{'provider':'openai','apiMode':'chat_completions','model':'test-model','baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'test','reasoningEffort':'none'},
                     'config':{'agent':{'max_iterations':4},'memory':{'memory_enabled':False,'user_profile_enabled':False,'automatic':False},'delegation':{'enabled':False},'model':{'context_length':128000},'compression':{'enabled':False}},
                     'instructions':'Use the proof tool once.','text':'Read proof.txt.',
                     'tools':[{'name':'proof_read','description':'Read a test artifact','parameters':{'type':'object','properties':{'path':{'type':'string'}},'required':['path']}}]}
            with tempfile.TemporaryFile(mode='w+') as errors:
                child=subprocess.Popen([str(ROOT/'.venv/bin/python'),'-u',str(ROOT/'runtime/worker.py')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=errors,text=True)
                timeout=threading.Timer(40,child.kill);timeout.start()
                events=[]
                try:
                    child.stdin.write(json.dumps(request)+'\n');child.stdin.flush()
                    for line in child.stdout:
                        frame=json.loads(line);events.append(frame)
                        if frame['type']=='tool.request':
                            self.assertEqual(frame['name'],'proof_read')
                            child.stdin.write(json.dumps({'id':frame['id'],'result':{'text':'random-proof-762'}})+'\n');child.stdin.flush()
                    child.wait(timeout=5)
                finally:
                    timeout.cancel();child.kill();child.stdin.close();child.stdout.close()
                errors.seek(0)
                self.assertEqual(child.returncode,0,errors.read()[-6000:]+'\n'+str(events))
            self.assertEqual([e['type'] for e in events].count('tool.request'),1)
            self.assertTrue(any(e['type']=='completed' and '执行完成' in e['text'] for e in events))
            self.assertTrue((Path(directory)/'contexts/session-one.json').exists())
            self.assertIn('random-proof-762',json.dumps(Model.calls[-1]))
            self.assertEqual({t['function']['name'] for t in Model.calls[0]['tools']},{'proof_read','clarify'})

    def test_legacy_memory_executor_is_retired_without_a_bridge(self):
        code=("import sys,json;sys.path.insert(0,'runtime/hermes');sys.path.insert(0,'runtime')\n"
              "from agent import runtime_context as rc;import agent.inline_tool_executors as e\n"
              "calls=[];rc._context={'tools':[]};rc._dispatch=lambda *a,**k:calls.append(a)\n"
              "class A:session_id='s';_memory_store=None;_memory_manager=None\n"
              "r=json.loads(e._memory(A(),{'action':'add','content':'x'},e.InlineToolContext(effective_task_id='t',tool_call_id='c')))\n"
              "print(json.dumps({'r':r,'calls':len(calls)}))")
        with tempfile.TemporaryDirectory() as home:
            out=subprocess.run([sys.executable,'-c',code],cwd=ROOT,capture_output=True,text=True,env={**os.environ,'HERMES_HOME':home,'YAOVI_KERNEL':'1'},check=True)
        result=json.loads(out.stdout.strip().splitlines()[-1])
        self.assertEqual(result['calls'],0)
        self.assertFalse(result['r']['success'])
        self.assertIn("tool 'memory' is retired",result['r']['error'])

    def test_only_workspace_memory_tools_and_legacy_memory_call_is_rejected(self):
        LegacyMemoryModel.calls=[]
        server=ThreadingHTTPServer(('127.0.0.1',0),LegacyMemoryModel)
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        workspace_tools=[{'name':n,'description':n,'parameters':{'type':'object','properties':{'scope':{'type':'string'}}}} for n in ('workspace_memory_search','workspace_memory_write','workspace_memory_forget')]
        with tempfile.TemporaryDirectory(prefix='yaovi-kernel-') as directory:
            request={'workspaceId':'local','botId':'bot-one','sessionId':'session-memory','runId':'run-memory','dataRoot':directory,
                     'route':{'provider':'openai','apiMode':'chat_completions','model':'test-model','baseURL':f'http://127.0.0.1:{server.server_port}/v1','apiKey':'test','reasoningEffort':'none'},
                     'config':{'agent':{'max_iterations':6},'memory':{'enabled':True,'automatic':True},'delegation':{'enabled':False},'model':{'context_length':128000},'compression':{'enabled':False}},
                     'instructions':'Check memory.','text':'Remember something.','tools':workspace_tools}
            events=self.exchange(request)
            offered={t['function']['name'] for t in LegacyMemoryModel.calls[0]['tools']}
            self.assertNotIn('memory',offered)
            self.assertTrue({'workspace_memory_search','workspace_memory_write','workspace_memory_forget'} <= offered)
            # The retired tool never reaches the control plane; only the workspace call does.
            self.assertEqual([e['name'] for e in events if e['type']=='tool.request'],['workspace_memory_search'])
            legacy=[m for m in LegacyMemoryModel.calls[1]['messages'] if m.get('role')=='tool' and m.get('tool_call_id')=='call-legacy']
            self.assertEqual(len(legacy),1)
            self.assertRegex(str(legacy[0]['content']).lower(),"tool 'memory' does not exist")
            self.assertIn('workspace_memory_write',str(legacy[0]['content']))
            self.assertTrue(any(e['type']=='completed' for e in events))
            system='\n'.join(str(m['content']) for m in LegacyMemoryModel.calls[0]['messages'] if m['role'] in ('system','developer'))
            self.assertIn('workspace_memory_search',system)
            self.assertFalse((Path(directory)/'memories').exists())
            self.assertFalse(any(Path(directory).rglob('MEMORY.md')) or any(Path(directory).rglob('USER.md')))
            self.assertNotIn('MEMORY.md (memory tool',system)


if __name__=='__main__':
    unittest.main()
