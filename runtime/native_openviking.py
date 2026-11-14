"""Yaovi identity policy around the unmodified, pinned Hermes OpenViking provider.

The upstream provider owns capture, recall, sessions, commit/recovery and tools.
This adapter pins a workstation connection and enforces Bot visibility at tool admission.
"""
import json
import re
from contextvars import ContextVar
from urllib.parse import unquote
from plugins.memory.openviking import (OpenVikingMemoryProvider, _VikingClient,
    _load_hermes_openviking_config, _profile_openviking_env, _resolve_connection_settings,
    _resolve_user_space, _probe_openviking_identity)


def connection(home):
    env = _profile_openviking_env(str(home)) or {}
    config = _load_hermes_openviking_config(str(home), env=env)
    settings = _resolve_connection_settings(config, env=env, hermes_home=str(home))
    settings['agent'] = ''  # The server-owned Bot identity always wins over .env / ovcli.
    value = {'settings': settings, 'providerConfig': config}
    client = connection_client(value)
    kind, health = _probe_openviking_identity(client)
    version = re.match(r'^v?(\d+)\.(\d+)\.(\d+)', str(health.get('version', ''))) if isinstance(health, dict) else None
    if kind != 'modern' or not version or tuple(map(int, version.groups())) < (0, 4, 17):
        raise RuntimeError('peer 模式需要支持 peer 命名空间的 OpenViking 0.4.17 或更新服务')
    status = client.get('/api/v1/system/status', timeout=5).get('result', {})
    user = str(status.get('user') or '').strip()
    if status.get('account'):
        settings['account'] = str(status['account'])
    if not user:
        raise RuntimeError('Hermes OpenViking 无法确认当前 user，请检查原生配置')
    settings['user'] = user
    return value


def connection_client(value, peer=''):
    s = value['settings']
    return _VikingClient(s['endpoint'], s['api_key'], account=s['account'], user=s['user'], agent=peer, extra_headers=s.get('extra_headers'))


def test_connection(value):
    try:
        client = connection_client(value)
        user = _resolve_user_space(client, timeout=5, raise_on_timeout=True)
        if not user:
            raise ValueError('服务未确认当前 user 身份，请检查凭据或升级 OpenViking')
        # An explicit peers path validates the namespace, without creating a peer.
        try:
            client.get('/api/v1/fs/ls', params={'uri': f'viking://user/{user}/peers'}, timeout=5)
        except Exception as error:
            if getattr(error, 'status_code', None) != 404:
                raise
        return {'ok': True, 'steps': [{'name': 'native', 'ok': True, 'detail': f'Hermes 原生插件已连接，当前 user：{user}'}]}
    except Exception:
        return {'ok': False, 'steps': [{'name': 'native', 'ok': False, 'detail': 'Hermes 原生 OpenViking 连接或 peer 命名空间不可用；请检查原生配置、凭据与服务版本'}]}


class _BotClient(_VikingClient):
    def post(self, path, payload=None, **kwargs):
        # Native viking_remember submits a user-only extraction session. Tag it too,
        # so an explicit remember cannot accidentally become common user memory.
        if self._agent and re.fullmatch(r'/api/v1/sessions/[^/]+/messages(?:/batch)?', path):
            payload = dict(payload or {})
            if isinstance(payload.get('messages'), list):
                payload['messages'] = [{**m, 'peer_id': self._agent} if m.get('role') in ('user', 'assistant') else m for m in payload['messages']]
            elif payload.get('role') in ('user', 'assistant'):
                payload['peer_id'] = self._agent
        return super().post(path, payload, **kwargs)


class YaoviOpenVikingProvider(OpenVikingMemoryProvider):
    def __init__(self, identity, *, automatic=True, recall=True):
        super().__init__()
        self.identity = identity
        self.automatic = automatic
        self.read_only = False
        self.recall_enabled = recall
        self.policy = identity.get('policy')
        self._explicit_access = ContextVar('yaovi_memory_explicit_access', default=None)

    def _profile_config_and_env(self):
        # Frozen per run. No fallback to an unrelated Bot profile or global actor.
        return {k: v for k, v in self.identity['providerConfig'].items() if k != 'deployment'}, {}

    def _resolve_bound_connection_settings(self, config=None, env=None):
        return {**self.identity['settings'], 'agent': self.identity['peerId']}

    def initialize(self, session_id, **kwargs):
        self.read_only = kwargs.get('agent_context') != 'primary'
        if not self.automatic or self.read_only or self.policy is not None and not self.policy.get('write'):
            kwargs['agent_context'] = 'subagent'
        # Keep pending commits in a directory dedicated to this identity. A promotion must
        # not replay a former peer's pending session through the actor-less primary client.
        from pathlib import Path
        kwargs['hermes_home'] = str(Path(kwargs['hermes_home']) / 'openviking-identities' / ('peer-' + self.identity['peerId'] if self.identity['peerId'] else 'primary'))
        super().initialize(session_id, **kwargs)
        self._user_id = self.identity['peerId']
        if self._client is None:
            raise RuntimeError('Hermes OpenViking 原生连接不可用；本轮记忆未接入')

    def _handle_runtime_openviking_unreachable(self, **kwargs):
        # Yaovi connects to an existing server; provider initialization must not start
        # or install a separate per-Bot Quick Local service.
        self._client = None

    def _build_client(self, endpoint=None):
        endpoint, key, account, user, peer = self._settings_tuple(endpoint)
        return _BotClient(endpoint, key, account=account, user=user, agent=peer, extra_headers=self._extra_headers)

    def _new_client(self):
        return self._build_client()

    def _sender_peer(self, author_id):
        return self.identity['peerId']

    def _recall_config(self):
        cfg = super()._recall_config()
        all_peers = self.identity['primary'] and (self.policy is None or self.policy.get('allPeers'))
        return {**cfg, 'scope': 'shared' if all_peers else 'peer', 'resources': False, 'compress': 'off'}

    def prefetch(self, query, *, session_id=''):
        if not self.recall_enabled:
            return ''
        if self.policy is not None and not self._automatic_read_allowed(self._policy_roots()):
            return ''
        result = super().prefetch(query, session_id=session_id)
        # Do not inject a result whose authority was revoked while remote recall
        # was in flight. This read-only check never opens an approval request.
        if self.policy is not None and not self._automatic_read_allowed(self._policy_roots()):
            return ''
        return result

    def _automatic_read_allowed(self, roots):
        if not roots:
            return False
        from native_authorization import check_only
        scopes = list(dict.fromkeys(self._permission_scope(root) for root in roots))
        return check_only('viking_search', {'scope': roots, 'permissionScope': scopes[0] if len(scopes) == 1 else scopes})

    def _policy_roots(self, *, resources=False):
        root = f'viking://user/{self._user_space(require_confirmed=True)}'
        policy = self.policy or {}
        roots = []
        suffixes = ('/memories', '/resources') if resources else ('/memories',)
        if policy.get('shared') or self.identity['primary'] and policy.get('self'):
            roots.extend(root + suffix for suffix in suffixes)
        if not self.identity['primary'] and policy.get('self'):
            roots.extend(root + '/peers/' + self.identity['peerId'] + suffix for suffix in suffixes)
        if self.identity['primary'] and policy.get('allPeers'):
            roots.append(root + '/peers')
        return roots

    def _post_prefetch_search(self, client, query, session_id, **kwargs):
        if self.policy is not None:
            roots = self._policy_roots()
            if not self._automatic_read_allowed(roots):
                return {'result': {'memories': [], 'resources': []}}
            kwargs['target_uri'] = roots
        return super()._post_prefetch_search(client, query, session_id, **kwargs)

    def _session_start_memory_context(self, session_id):
        # Upstream reads the shared user profile directly, before query filtering.
        # Suppress that read unless this Bot can read that root.
        if self.policy is not None:
            root = f'viking://user/{self._user_space(require_confirmed=True)}/memories'
            if not self._allowed(root) or not self._automatic_read_allowed([root]):
                return ''
        return super()._session_start_memory_context(session_id)

    def _normalized_uri(self, uri):
        if not isinstance(uri, str):
            return None
        uri = unquote(unquote(uri)).rstrip('/')
        if any(p in ('.', '..') for p in uri.split('/')) or any(c in uri for c in ('\\', '?', '#', '%')):
            return None
        user = self._user_space(require_confirmed=True)
        uri = uri.replace('viking://~', f'viking://user/{user}', 1) if uri.startswith('viking://~/') or uri == 'viking://~' else uri
        root = f'viking://user/{user}'
        if not (uri == root or uri.startswith(root + '/')):
            return None
        return uri

    def _allowed(self, uri, *, write=False):
        uri = self._normalized_uri(uri)
        if uri is None:
            return False
        root = f'viking://user/{self._user_space(require_confirmed=True)}'
        rest = uri[len(root):]
        if rest.startswith('/peers/') or rest == '/peers':
            if self.identity['primary']:
                identity_allowed = not write
            else:
                peer = '/peers/' + self.identity['peerId']
                identity_allowed = rest == peer or rest.startswith(peer + '/')
        else:
            identity_allowed = rest == '' and self.identity['primary'] and not write or (not write or self.identity['primary']) and any(rest == p or rest.startswith(p + '/') for p in ('/memories', '/resources'))
        if not identity_allowed:
            return False
        explicit = self._explicit_access.get()
        if explicit is not None:
            return any(uri == target or recursive and uri.startswith(target + '/') for target, recursive in explicit)
        if self.policy is None:
            return True
        if write and not self.policy.get('write'):
            return False
        return any(uri == target or uri.startswith(target + '/') for target in self._policy_roots(resources=True))

    def _permission_scope(self, uri):
        root = f'viking://user/{self._user_space(require_confirmed=True)}'
        private = root if self.identity['primary'] else root + '/peers/' + self.identity['peerId']
        if any(uri == private + p or uri.startswith(private + p + '/') for p in ('/memories', '/resources')):
            return 'self'
        if any(uri == root + p or uri.startswith(root + p + '/') for p in ('/memories', '/resources')):
            return 'shared'
        return 'memory-uri:' + uri

    def handle_tool_call(self, tool_name, args, **kwargs):
        args = dict(args)
        args.pop('permissionScope', None)  # Computed below; model input cannot declare its own scope.
        if self.read_only and tool_name not in ('viking_search', 'viking_read', 'viking_browse'):
            return json.dumps({'error': '子任务和审阅上下文只允许读取记忆'})
        access_token = None
        try:
            if tool_name == 'viking_add_resource':
                # Native ingestion can read local files/URLs and write account resources.
                # Admit only user-scoped targets; local file admission remains Yaovi-owned.
                return json.dumps({'error': '请通过服务器的授权文件入口导入资料'})
            key = {'viking_search': 'scope', 'viking_browse': 'path', 'viking_forget': 'uri'}.get(tool_name)
            if tool_name == 'viking_search' and not args.get('scope'):
                root = f'viking://user/{self._user_space(require_confirmed=True)}'
                args['scope'] = self._policy_roots(resources=True) if self.policy is not None else root if self.identity['primary'] else [root + '/memories', root + '/peers/' + self.identity['peerId'] + '/memories']
                if not args['scope']:
                    return json.dumps({'error': '未授权默认记忆范围，请指定需要访问的记忆 URI'})
            if tool_name == 'viking_browse' and args.get('path', 'viking://') == 'viking://':
                if self.policy is not None:
                    roots = self._policy_roots(resources=True)
                    if not roots:
                        return json.dumps({'error': '未授权默认记忆范围，请指定需要访问的记忆 URI'})
                    args['path'] = roots[0]
                else:
                    args['path'] = 'viking://~' if self.identity['primary'] else 'viking://~/peers/' + self.identity['peerId']
            values = args.get('uris') or args.get('uri') if tool_name == 'viking_read' else args.get(key) if key else None
            targets = []
            if values is not None:
                for value in values if isinstance(values, list) else [values]:
                    normalized = self._normalized_uri(value)
                    if normalized is None:
                        return json.dumps({'error': '此 Bot 无权访问该记忆空间'})
                    if tool_name == 'viking_read' and args.get('level', 'overview') in ('abstract', 'overview'):
                        normalized = self._normalize_summary_uri(normalized)
                    targets.append(normalized)
                if tool_name == 'viking_read':
                    args.pop('uris', None)
                    args['uri'] = targets if isinstance(values, list) else targets[0]
                elif key:
                    args[key] = targets if isinstance(values, list) else targets[0]
                values = targets
            from native_authorization import authorize, enabled
            if enabled():
                scopes = list(dict.fromkeys(self._permission_scope(target) for target in targets)) or ['self']
                refusal = authorize(tool_name, {**args, 'permissionScope': scopes[0] if len(scopes) == 1 else scopes}, **kwargs)
                if refusal is not None:
                    return refusal
                access_token = self._explicit_access.set([(target, tool_name in ('viking_search', 'viking_browse')) for target in targets])
            if values is not None and not all(self._allowed(v, write=tool_name == 'viking_forget') for v in (values if isinstance(values, list) else [values])):
                return json.dumps({'error': '此 Bot 无权访问该记忆空间'})
            return super().handle_tool_call(tool_name, args, **kwargs)
        except Exception:
            return json.dumps({'error': 'OpenViking 记忆操作失败，请检查连接与访问范围'})
        finally:
            if access_token is not None:
                self._explicit_access.reset(access_token)

    def _build_prefetch_entries(self, client, items, **kwargs):
        items = [item for item in items if self._allowed(item.get('uri', ''))]
        if self.policy is not None and not self._automatic_read_allowed([self._normalized_uri(item['uri']) for item in items]):
            return []
        return super()._build_prefetch_entries(client, items, **kwargs)

    def _tool_search(self, args):
        value = json.loads(super()._tool_search(args))
        if 'results' in value:
            value['results'] = [item for item in value['results'] if self._allowed(item.get('uri', ''))]
            for item in value['results']:
                if 'related' in item:
                    item['related'] = [uri for uri in item['related'] if self._allowed(uri)]
            value['total'] = len(value['results'])
        return json.dumps(value, ensure_ascii=False)

    def _tool_browse(self, args):
        value = json.loads(super()._tool_browse(args))
        if isinstance(value, dict) and 'entries' in value:
            value['entries'] = [item for item in value['entries'] if self._allowed(item.get('uri', ''))]
        return json.dumps(value, ensure_ascii=False)

    def get_tool_schemas(self):
        return [s for s in super().get_tool_schemas() if s['name'] != 'viking_add_resource']
