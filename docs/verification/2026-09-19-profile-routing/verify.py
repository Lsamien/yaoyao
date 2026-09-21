"""Verify Profile routing against real Hermes with a local fake model endpoint.

Run with the Hermes virtualenv Python; no production config or source is changed.
Use --baseline to reproduce the unpatched metadata/environment override defects.
"""
import argparse
import asyncio
import importlib.util
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import requests
import websockets

REPO = Path(__file__).resolve().parents[3]
PLUGIN = REPO / 'integrations/hermes-bots-bridge'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=Path.home() / '.hermes/hermes-agent')
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--no-env-seed', action='store_true', help='Isolate the default-Profile metadata leak')
    args = parser.parse_args()
    source = args.source.resolve()
    root = Path(tempfile.mkdtemp(prefix='yaoyao-profile-routing-'))
    overlay = root / 'source'; overlay.mkdir()
    # Copy Python packages: native bootstrap modules resolve their own path and
    # prepend that root. Symlinking them would silently load the installed code.
    for item in source.iterdir():
        if item.is_dir() and (item / '__init__.py').is_file():
            shutil.copytree(item, overlay / item.name, ignore=shutil.ignore_patterns('__pycache__'))
        elif item.is_file() and item.suffix == '.py':
            shutil.copy2(item, overlay / item.name)
        else:
            (overlay / item.name).symlink_to(item, target_is_directory=item.is_dir())
    home = root / 'home'
    seen_models = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200); self.end_headers()
            self.wfile.write(json.dumps({'tools': [{'id': 'fixture_ping', 'name': 'fixture_ping',
                'description': 'Return fixture proof', 'inputSchema': {'type': 'object', 'properties': {}}}]}
                if self.path == '/tools/list' else {'data': [{'id': 'fixture-default'}]}).encode())

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
            if self.path == '/tools/list':
                return self.do_GET()
            seen_models.append(body.get('model'))
            message = {'role': 'assistant', 'content': 'fixture reply'}
            self.send_response(200)
            if body.get('stream'):
                self.send_header('Content-Type', 'text/event-stream'); self.end_headers()
                chunk = {'id': 'fixture', 'object': 'chat.completion.chunk',
                         'choices': [{'index': 0, 'delta': message, 'finish_reason': 'stop'}]}
                self.wfile.write(('data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n').encode())
            else:
                self.send_header('Content-Type', 'application/json'); self.end_headers()
                self.wfile.write(json.dumps({'id': 'fixture', 'choices': [{'index': 0,
                    'message': message, 'finish_reason': 'stop'}],
                    'usage': {'prompt_tokens': 100, 'completion_tokens': 5, 'total_tokens': 105}}).encode())

    http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=http.serve_forever, daemon=True).start()
    model_url = f'http://127.0.0.1:{http.server_port}'
    spec = importlib.util.spec_from_file_location('installer', REPO / 'scripts/install-hermes-bridge.py')
    installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)
    for profile, model in [('default', 'fixture-default'), ('yaoer', 'grok-4.6')]:
        selected = home if profile == 'default' else home / 'profiles' / profile
        (selected / 'workspace').mkdir(parents=True)
        config = {'model': {'default': model, 'provider': 'custom', 'base_url': model_url + '/v1',
                  'api_key': 'fixture', 'context_length': 65536},
                  'terminal': {'cwd': str(selected / 'workspace')},
                  'plugins': {'enabled': ['yaoyao-bot-bridge']}, 'toolsets': ['yaoyao_bot_bridge'],
                  'tools': {'tool_search': {'enabled': 'off'}}, 'dashboard': {'turn_isolation': False},
                  'compression': {'enabled': False},
                  'memory': {'memory_enabled': False, 'user_profile_enabled': False}}
        (selected / 'config.yaml').write_text(json.dumps(config))
        (selected / '.env').write_text('')
        installer.install(home, profile, PLUGIN, repair_source=None if args.baseline else overlay)

    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]
    env = {'PATH': os.environ['PATH'], 'HOME': str(root / 'os-home'), 'LANG': 'en_US.UTF-8',
           'HERMES_HOME': str(home), 'PYTHONPATH': str(overlay), 'HERMES_MODEL': 'gpt-5.6-terra',
           'HERMES_DASHBOARD_SESSION_TOKEN': 'fixture-profile-token-123456789',
           'NO_PROXY': '127.0.0.1,localhost', 'PYTHONDONTWRITEBYTECODE': '1'}
    if args.no_env_seed:
        env.pop('HERMES_MODEL')
    log = (root / 'hermes.log').open('w')
    child = subprocess.Popen([str(source / 'venv/bin/python'), '-m', 'hermes_cli.main', 'serve',
                              '--host', '127.0.0.1', '--port', str(port), '--skip-build', '--isolated'],
                             env=env, cwd=root, stdout=log, stderr=log)
    base = f'http://127.0.0.1:{port}'
    client = requests.Session(); client.trust_env = False
    client.headers['X-Hermes-Session-Token'] = env['HERMES_DASHBOARD_SESSION_TOKEN']

    def request(path, body=None):
        response = client.get(base + path, timeout=30) if body is None else client.post(base + path, json=body, timeout=30)
        response.raise_for_status()
        return response.json()

    async def rpc(ws, method, params):
        key = str(uuid.uuid4())
        await ws.send(json.dumps({'jsonrpc': '2.0', 'id': key, 'method': method, 'params': params}))
        while True:
            frame = json.loads(await asyncio.wait_for(ws.recv(), 30))
            if frame.get('id') == key:
                assert 'error' not in frame, frame
                return frame['result']

    async def verify():
        results = []
        for profile, expected in [('default', 'fixture-default'), ('yaoer', 'grok-4.6')]:
            await asyncio.to_thread(request, '/api/config?profile=' + profile)
            caps = await asyncio.to_thread(request, '/api/plugins/yaoyao-bot-bridge/capabilities?profile=' + profile)
            assert caps['ready'], caps
            async with websockets.connect(f'ws://127.0.0.1:{port}/api/ws?token=' + env['HERMES_DASHBOARD_SESSION_TOKEN'],
                                          origin=base, proxy=None) as ws:
                while 'gateway.ready' not in await asyncio.wait_for(ws.recv(), 30):
                    pass
                created = await rpc(ws, 'session.create', {'profile': profile, 'source': 'yaoyao_workspace', 'close_on_disconnect': False})
                stored = created.get('stored_session_id') or created['session_key']
                resumed = await rpc(ws, 'session.resume', {'profile': profile, 'session_id': stored,
                                                           'omit_messages': True, 'close_on_disconnect': False})
                sid = resumed['session_id']; generation = str(uuid.uuid4())
                start = time.monotonic()
                bound = await asyncio.to_thread(request, '/api/plugins/yaoyao-bot-bridge/bind', {
                    'session_id': sid, 'stored_session_id': stored, 'profile': profile, 'generation': generation,
                    'bridge_url': model_url, 'token': 'a' * 40, 'expires_at': time.time() * 1000 + 60000,
                    'native_tools': True, 'workspace_memory': True})
                assert bound['ok'], bound
                elapsed = round(time.monotonic() - start, 3)
                offset = len(seen_models)
                await ws.send(json.dumps({'jsonrpc': '2.0', 'id': 'prompt', 'method': 'prompt.submit',
                                          'params': {'session_id': sid, 'text': 'Hello'}}))
                while True:
                    frame = json.loads(await asyncio.wait_for(ws.recv(), 30))
                    event = frame.get('params', {}).get('type')
                    assert event != 'error' and 'error' not in frame, frame
                    if event == 'message.complete':
                        break
                models = seen_models[offset:]
                expected_model = 'gpt-5.6-terra' if args.baseline and not args.no_env_seed else expected
                expected_info = ('fixture-default' if args.no_env_seed else 'gpt-5.6-terra') if args.baseline else expected
                assert models and all(model == expected_model for model in models), models
                assert created['info']['model'] == expected_info, created
                assert resumed['info']['model'] == expected_info, resumed
                results.append({'profile': profile, 'configured': expected, 'create': created['info']['model'],
                                'resume': resumed['info']['model'], 'requests': models, 'bindSeconds': elapsed})
                await asyncio.to_thread(request, '/api/plugins/yaoyao-bot-bridge/unbind', {'session_id': sid, 'generation': generation})
        print(json.dumps({'baseline': args.baseline, 'environmentSeed': not args.no_env_seed, 'results': results}, ensure_ascii=False, indent=2), flush=True)

    try:
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise RuntimeError('Hermes exited; inspect ' + str(root / 'hermes.log'))
            try:
                if client.get(base + '/api/status', timeout=1).status_code == 200:
                    break
            except requests.RequestException:
                pass
            time.sleep(.2)
        else:
            raise TimeoutError('Hermes startup exceeded 30 seconds')
        asyncio.run(verify())
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill(); child.wait()
        http.shutdown(); http.server_close(); log.close(); client.close()
        print('Fixture logs: ' + str(root), flush=True)


if __name__ == '__main__':
    main()
