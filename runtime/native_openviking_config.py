"""Redacted native configuration, draft probes and reversible .env updates.

Connection values remain Hermes-native. No server is installed or started here.
"""
import hashlib
import base64
import json
import os
import re
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit
from plugins.memory.openviking import (
    _VikingClient, _load_hermes_openviking_config, _profile_openviking_env,
    _resolve_connection_settings, _probe_openviking_identity, _write_env_vars,
    _ovcli_values_for,
)


class ConfigurationError(RuntimeError):
    def __init__(self, detail, status=400):
        super().__init__(detail)
        self.status = status


def _revision(home):
    files = [Path(home) / '.env', Path(home) / 'config.yaml']
    env = _profile_openviking_env(str(home)) or {}
    config = _load_hermes_openviking_config(str(home), env=env)
    try: linked = _ovcli_values_for(config, env=env)
    except Exception: linked = {}
    parts = [p.read_bytes() if p.exists() else b'<missing>' for p in files]
    parts.append(json.dumps(linked, sort_keys=True).encode())
    return hashlib.sha256(b'\0'.join(parts)).hexdigest()


def _resolved(home):
    env = _profile_openviking_env(str(home)) or {}
    config = _load_hermes_openviking_config(str(home), env=env)
    try:
        settings = _resolve_connection_settings(config, env=env, hermes_home=str(home))
    except Exception:
        # A malformed saved endpoint must still be editable while offline.
        try: linked = _ovcli_values_for(config, env=env)
        except Exception: linked = {}
        settings = {k: env.get('OPENVIKING_' + k.upper(), linked.get(k) or config.get(k) or '') for k in ('endpoint', 'api_key', 'account', 'user')}
        settings['api_key'] = env.get('OPENVIKING_API_KEY', linked.get('api_key') or '')
        settings['endpoint'] = settings['endpoint'] or 'http://127.0.0.1:1933'
    settings = {**settings, 'agent': ''}
    source = 'managed' if config.get('deployment') == 'quick_local' else 'profile' if any(k in env for k in ('OPENVIKING_ENDPOINT', 'OPENVIKING_API_KEY', 'OPENVIKING_ACCOUNT', 'OPENVIKING_USER')) else 'linked' if config.get('use_ovcli_config') else 'profile' if any(config.get(k) for k in ('endpoint', 'account', 'user')) else 'default'
    # Use the upstream constant too, so a renamed deployment cannot become editable.
    from plugins.memory.openviking import quick_local
    if config.get('deployment') == quick_local.DEPLOYMENT:
        source = 'managed'
    return settings, config, source


def read_configuration(home):
    settings, _, source = _resolved(home)
    return {'endpoint': settings['endpoint'], 'account': settings.get('account') or 'default',
            'user': settings.get('user') or 'default', 'keyConfigured': bool(settings.get('api_key')),
            'source': source, 'readOnly': source == 'managed', 'revision': _revision(home), 'configHome': str(home)}


def candidate(home, values=None):
    settings, config, source = _resolved(home)
    if values is not None:
        if not isinstance(values, dict) or any(k not in ('endpoint', 'account', 'user', 'apiKey', 'clearApiKey', 'revision') for k in values):
            raise ConfigurationError('原生连接配置字段无效')
        if source == 'managed':
            raise ConfigurationError('Quick Local 连接由 Hermes 管理，请在 Hermes 中修改', 409)
        if values.get('revision') is not None and values['revision'] != _revision(home):
            raise ConfigurationError('Hermes 配置已更新，请重新读取后保存', 409)
        for key in ('endpoint', 'account', 'user'):
            if key in values:
                if not isinstance(values[key], str):
                    raise ConfigurationError('原生连接字段必须是文本')
                settings[key] = values[key].strip()
        if 'clearApiKey' in values and not isinstance(values['clearApiKey'], bool):
            raise ConfigurationError('清除密钥选项无效')
        if 'apiKey' in values and not isinstance(values['apiKey'], str):
            raise ConfigurationError('API Key 必须是文本')
        key = values.get('apiKey', '').strip()
        if key and values.get('clearApiKey'):
            raise ConfigurationError('不能同时填写和清除 API Key')
        if key or values.get('clearApiKey'):
            settings['api_key'] = key
    endpoint = settings.get('endpoint', '').strip()
    try:
        parsed = urlsplit(endpoint)
        valid = parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password and not parsed.query and not parsed.fragment
        if not valid or any(c.isspace() for c in endpoint):
            raise ValueError()
        parsed.port
    except ValueError:
        raise ConfigurationError('请填写有效的 HTTP / HTTPS 服务地址，不要包含凭据、查询参数或片段') from None
    settings['endpoint'] = endpoint.rstrip('/')
    for key in ('account', 'user'):
        settings[key] = settings.get(key) or 'default'
        if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}', settings[key]):
            raise ConfigurationError('Account 和 User 仅支持 1–128 位字母、数字及 _ . @ -')
    secret = settings.get('api_key') or ''
    if len(secret) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in secret):
        raise ConfigurationError('API Key 格式无效，请使用单行密钥')
    return {'settings': settings, 'providerConfig': config}


def _error_detail(error, stage):
    status = getattr(error, 'status_code', None) or getattr(getattr(error, 'response', None), 'status_code', None)
    if isinstance(error, ConfigurationError):
        return str(error)
    if status in (401, 403):
        return f'凭据无效或无访问权限（HTTP {status}），请检查 API Key 和身份设置'
    if status:
        return f'{stage}返回 HTTP {status}，请检查服务地址、访问代理与服务版本'
    if 'timeout' in type(error).__name__.lower():
        return f'{stage}超时，请检查网络与服务地址'
    if isinstance(error, (ConnectionError, OSError)) or 'connect' in type(error).__name__.lower():
        return f'无法连接服务，请检查地址、端口和网络（{stage}）'
    return f'{stage}失败，请检查原生配置；服务端原始错误已隐藏以保护凭据'


def probe(value):
    steps = []
    stage, name = '服务健康检查', 'health'
    try:
        s = value['settings']
        client = _VikingClient(s['endpoint'], s.get('api_key', ''), account=s['account'], user=s['user'], agent='', extra_headers=s.get('extra_headers'))
        kind, health = _probe_openviking_identity(client)
        if kind != 'modern':
            raise ConfigurationError('服务未返回健康的 OpenViking 标识，请检查服务地址与版本', 422)
        steps.append({'name': name, 'ok': True, 'detail': '已连接 OpenViking 服务'})
        stage, name = '服务版本检查', 'version'
        version = re.match(r'^v?(\d+)\.(\d+)\.(\d+)', str(health.get('version', '')))
        if not version or tuple(map(int, version.groups())) < (0, 4, 17):
            found = '.'.join(version.groups()) if version else '未知'
            raise ConfigurationError(f'peer 模式需要 OpenViking 0.4.17 或更新服务，当前版本：{found}', 422)
        steps.append({'name': name, 'ok': True, 'detail': '当前版本：' + '.'.join(version.groups())})
        stage, name = '凭据与身份检查', 'identity'
        status = client.get('/api/v1/system/status', timeout=5).get('result', {})
        user = str(status.get('user') or '').strip()
        if not user:
            raise ConfigurationError('服务未确认当前 user，请检查 API Key 或本地 / root key 身份设置', 422)
        steps.append({'name': name, 'ok': True, 'detail': f'当前 user：{user}'})
        stage, name = 'peer 命名空间检查', 'peer'
        try:
            client.get('/api/v1/fs/ls', params={'uri': f'viking://user/{user}/peers'}, timeout=5)
        except Exception as error:
            if getattr(error, 'status_code', None) != 404:
                raise
        steps.append({'name': name, 'ok': True, 'detail': 'peer 路径可用；空空间尚未创建时无需回填'})
        return {'ok': True, 'steps': steps, 'identity': {'user': user, 'account': str(status.get('account') or s['account'])}}
    except Exception as error:
        steps.append({'name': name, 'ok': False, 'detail': _error_detail(error, stage)})
        return {'ok': False, 'steps': steps}


def test_configuration(home, values=None):
    try:
        return probe(candidate(home, values))
    except Exception as error:
        return {'ok': False, 'steps': [{'name': 'native', 'ok': False, 'detail': _error_detail(error, '原生配置读取')}]}


def _atomic_write(path, content):
    descriptor, staged = tempfile.mkstemp(prefix='.openviking-', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(content); stream.flush(); os.fsync(stream.fileno())
        os.chmod(staged, 0o600)
        os.replace(staged, path)
    finally:
        if os.path.exists(staged): os.unlink(staged)


_transactions = {}


def _journal(state, token):
    folder = state['home'] / '.openviking-config-transactions'
    folder.mkdir(mode=0o700, exist_ok=True)
    os.chmod(folder, 0o700)
    return folder / (token + '.json')


def _save_transaction(state, token):
    data = {k: state[k] for k in ('revision', 'committed')}
    data['before'] = None if state['before'] is None else base64.b64encode(state['before']).decode()
    data['after'] = base64.b64encode(state['after']).decode()
    _atomic_write(_journal(state, token), json.dumps(data).encode())


def prepare(home, values):
    home = Path(home)
    if not isinstance(values, dict): raise ConfigurationError('原生连接配置必须是对象')
    initial_revision = _revision(home)
    value = candidate(home, values)
    result = probe(value)
    if not result['ok']:
        raise ConfigurationError(result['steps'][-1]['detail'], 422)
    path = home / '.env'
    before = path.read_bytes() if path.exists() else None
    revision = _revision(home)
    if initial_revision != revision or values.get('revision') is not None and values['revision'] != revision:
        raise ConfigurationError('Hermes 配置已更新，请重新读取后保存', 409)
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temp = tempfile.mkstemp(prefix='.openviking-draft-', dir=home)
    os.close(fd)
    try:
        if before is not None: Path(temp).write_bytes(before)
        s = value['settings']
        writes = {'OPENVIKING_ENDPOINT': s['endpoint'], 'OPENVIKING_ACCOUNT': s['account'], 'OPENVIKING_USER': s['user']}
        if values.get('apiKey', '').strip() or values.get('clearApiKey'):
            writes['OPENVIKING_API_KEY'] = s.get('api_key') or ''
        _write_env_vars(Path(temp), writes)
        after = Path(temp).read_bytes()
    finally:
        os.unlink(temp)
    token = uuid.uuid4().hex
    _transactions[token] = {'home': home, 'before': before, 'after': after, 'revision': revision, 'committed': False}
    _save_transaction(_transactions[token], token)
    return {'token': token, 'test': result}


def transaction(token, action, home=None):
    if action not in ('commit', 'rollback', 'finish', 'retain'):
        raise ConfigurationError('配置保存事务操作无效')
    if not isinstance(token, str) or not re.fullmatch(r'[0-9a-f]{32}', token):
        raise ConfigurationError('配置保存事务标识无效', 409)
    state = _transactions.get(token)
    if state is None and home is not None:
        journal = Path(home) / '.openviking-config-transactions' / (token + '.json')
        if journal.exists():
            data = json.loads(journal.read_bytes())
            state = {**data, 'home':Path(home), 'before':None if data['before'] is None else base64.b64decode(data['before']), 'after':base64.b64decode(data['after'])}
            _transactions[token] = state
    if state is None: raise ConfigurationError('配置保存事务已失效，请重试', 409)
    path = state['home'] / '.env'
    if action == 'commit':
        if _revision(state['home']) != state['revision']:
            raise ConfigurationError('Hermes 配置已更新，请重新读取后保存', 409)
        _atomic_write(path, state['after']); state['committed'] = True
        _save_transaction(state, token)
        return read_configuration(state['home'])
    if action == 'rollback' and (state['committed'] or path.exists() and path.read_bytes() == state['after']):
        if not path.exists() or path.read_bytes() != state['after']:
            raise ConfigurationError('Hermes 配置已被其他操作修改，未覆盖其内容', 409)
        if state['before'] is None: path.unlink()
        else: _atomic_write(path, state['before'])
        state['committed'] = False
        _save_transaction(state, token)
    if action == 'finish':
        _journal(state, token).unlink(missing_ok=True)
        _transactions.pop(token, None)
    return {'ok': True}
