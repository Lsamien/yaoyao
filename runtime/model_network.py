"""Request-local model networking for Yaovi's embedded Hermes bridge.

Policies travel on the private stdin RPC, never in config.yaml, logs or tool context.
No os.environ mutation: OAuth threads retain a snapshot; other calls can change routes.
HTTPX transports are selected per request (including cached SDK clients and redirects).
"""
import contextlib
import contextvars
import copy
import functools
import hashlib
import json
import os
from pathlib import Path
import socket
import threading
from urllib.parse import urlsplit

_context = contextvars.ContextVar("yaovi_model_network", default=None)
_installed = False
_auth_urls = {
    "openai-codex": "https://auth.openai.com/",
    "xai-oauth": "https://auth.x.ai/",
    "copilot": "https://github.com/", "copilot-acp": "https://github.com/",
    "qwen-oauth": "https://chat.qwen.ai/", "anthropic": "https://api.anthropic.com/",
    "claude-code": "https://api.anthropic.com/", "nous": "https://portal.nousresearch.com/",
    "minimax": "https://www.minimax.io/",
}


def _owns(provider):
    """Bot overrides apply only to Bot-owned credentials/endpoints, not parent auth."""
    if not os.environ.get("YAOVI_HERMES_ROOT"):
        return True
    home = Path(os.environ["HERMES_HOME"])
    try:
        auth = json.loads((home / "auth.json").read_text())
        if provider in (auth.get("providers") or {}) or provider in auth:
            return True
    except (OSError, ValueError):
        pass
    try:
        from agent.secret_scope import load_env_file
        from hermes_cli.providers import get_provider
        definition = get_provider(provider, allow_network=False)
        env = load_env_file(home / ".env") if (home / ".env").exists() else {}
        if any(env.get(key) for key in getattr(definition, "api_key_env_vars", ())):
            return True
        import yaml
        config = yaml.safe_load((home / "config.yaml").read_text()) or {}
        return provider in (config.get("providers") or {}) or any(p.get("id") == provider or p.get("name") == provider for p in config.get("custom_providers", []) if isinstance(p, dict))
    except (OSError, ValueError, ImportError, AttributeError):
        return False


def _policy(ctx, provider):
    snapshot = ctx["snapshot"]
    if "botConnections" in snapshot and (ctx.get("login") or _owns(provider)):
        return snapshot["botConnections"].get(provider, snapshot.get("default", "environment"))
    return snapshot.get("connections", {}).get(provider, snapshot.get("default", "environment"))


def _routes():
    result = []
    from hermes_cli.providers import HERMES_OVERLAYS, get_provider
    for provider in HERMES_OVERLAYS:
        definition = get_provider(provider, allow_network=False)
        if definition and definition.base_url:
            result.append((definition.base_url.rstrip("/"), provider))
    result.extend((url.rstrip("/"), provider) for provider, url in _auth_urls.items())
    from hermes_cli.config import load_config
    config = load_config()
    for provider, value in (config.get("providers") or {}).items():
        if isinstance(value, dict) and value.get("base_url"):
            result.append((value["base_url"].rstrip("/"), provider))
    for value in config.get("custom_providers") or []:
        if isinstance(value, dict) and value.get("base_url"):
            result.append((value["base_url"].rstrip("/"), value.get("id") or value.get("name") or "custom"))
    main = config.get("model") or {}
    if main.get("base_url"):
        result.append((main["base_url"].rstrip("/"), main.get("provider") or "custom"))
    return result


def _credential_routes():
    """Bind auxiliary SDK clients that resolve API keys without runtime_provider."""
    from hermes_cli.providers import HERMES_OVERLAYS, get_provider
    from agent.secret_scope import load_env_file
    env = {}
    homes = [os.environ.get("YAOVI_HERMES_ROOT"), os.environ.get("HERMES_HOME")]
    for home in homes:
        if home and (Path(home) / ".env").exists():
            env.update(load_env_file(Path(home) / ".env"))
    env.update(os.environ)
    candidates = {}
    for provider in HERMES_OVERLAYS:
        definition = get_provider(provider, allow_network=False)
        for name in getattr(definition, "api_key_env_vars", ()):
            if env.get(name):
                key = (str(definition.base_url or "").rstrip("/"), hashlib.sha256(env[name].encode()).hexdigest())
                candidates.setdefault(key, set()).add(provider)
    return {key: next(iter(providers)) for key, providers in candidates.items() if len(providers) == 1}


@contextlib.contextmanager
def scope(snapshot, provider=None, *, login=False, model_operation=True):
    if snapshot is None:
        yield
        return
    ctx = {"snapshot": copy.deepcopy(snapshot), "provider": provider, "login": login,
           "model_operation": model_operation, "routes": _routes(), "credentials": _credential_routes()}
    token = _context.set(ctx)
    try:
        yield
    finally:
        _context.reset(token)


def route(url, context=None):
    ctx = context if context is not None else _context.get()
    if not ctx:
        return "environment"
    if ctx.get("provider"):
        return _policy(ctx, ctx["provider"])
    target = urlsplit(str(url))
    matches = []
    for base, provider in ctx["routes"]:
        parsed = urlsplit(base)
        if (target.scheme, target.netloc) == (parsed.scheme, parsed.netloc) and (target.path == parsed.path or target.path.startswith(parsed.path.rstrip("/") + "/")):
            matches.append((len(parsed.path), _policy(ctx, provider)))
    if matches:
        length = max(m[0] for m in matches)
        policies = {p for size, p in matches if size == length}
        if len(policies) != 1:
            # Two connection identities share one endpoint; guessing could leak traffic.
            raise RuntimeError("同一模型地址配置了不同网络方式，请为这些连接设置相同网络。")
        return policies.pop()
    return ctx["snapshot"].get("default", "environment") if ctx["model_operation"] else "environment"


def _credential_context(url, headers, ctx=None):
    """Direct HTTP media clients also need the identity of the bearer they resolved."""
    ctx = ctx if ctx is not None else _context.get()
    if not ctx:
        return ctx
    authorization = headers.get("authorization") or headers.get("Authorization") or ""
    if not authorization.lower().startswith("bearer "):
        return ctx
    fingerprint = hashlib.sha256(authorization[7:].encode()).hexdigest()
    target, matches = urlsplit(str(url)), []
    for (base, key), provider in ctx["credentials"].items():
        parsed = urlsplit(base)
        if key == fingerprint and (target.scheme, target.netloc) == (parsed.scheme, parsed.netloc) and (target.path == parsed.path or target.path.startswith(parsed.path.rstrip("/") + "/")):
            matches.append((len(parsed.path), provider))
    if matches:
        length = max(size for size, _ in matches)
        providers = {p for size, p in matches if size == length}
        if len(providers) == 1:
            return {**ctx, "provider": providers.pop()}
    return ctx


def install():
    global _installed
    if _installed:
        return
    _installed = True
    import httpx
    # Resolve credentials under the provider's policy, including token refresh. Bind
    # the resulting SDK client by credentials as two suppliers may share a hostname.
    from hermes_cli import runtime_provider
    resolve = runtime_provider.resolve_runtime_provider
    @functools.wraps(resolve)
    def resolve_provider(*args, **kwargs):
        ctx = _context.get()
        provider = kwargs.get("requested") or (args[0] if args else None)
        token = _context.set({**ctx, "provider": provider}) if ctx and provider else None
        try:
            result = resolve(*args, **kwargs)
            if ctx and result.get("api_key"):
                key = (str(result.get("base_url") or "").rstrip("/"), hashlib.sha256(str(result["api_key"]).encode()).hexdigest())
                ctx["credentials"][key] = provider or result.get("provider")
            return result
        finally:
            if token is not None:
                _context.reset(token)
    runtime_provider.resolve_runtime_provider = resolve_provider
    # Native xAI media resolves OAuth/API-key credentials without runtime_provider.
    # Register the returned identity, rather than treating the shared origin as ambiguous.
    from tools import xai_http
    resolve_xai = xai_http.resolve_xai_http_credentials
    @functools.wraps(resolve_xai)
    def resolve_xai_credentials(*args, **kwargs):
        result = resolve_xai(*args, **kwargs)
        ctx = _context.get()
        if ctx and result.get("api_key") and result.get("base_url"):
            key = (result["base_url"].rstrip("/"), hashlib.sha256(result["api_key"].encode()).hexdigest())
            ctx["credentials"][key] = result["provider"]
        return result
    xai_http.resolve_xai_http_credentials = resolve_xai_credentials
    for cls, transport in ((httpx.Client, httpx.HTTPTransport), (httpx.AsyncClient, httpx.AsyncHTTPTransport)):
        original_init = cls.__init__
        original_select = cls._transport_for_url

        def make_init(original):
            @functools.wraps(original)
            def init(self, *args, **kwargs):
                self._yaovi_context = _context.get()
                self._yaovi_transports = {}
                self._yaovi_transport_lock = threading.Lock()
                self._yaovi_tls = {key: kwargs[key] for key in ("verify", "cert") if key in kwargs}
                original(self, *args, **kwargs)
                tls = getattr(getattr(self._transport, "_pool", None), "_ssl_context", None)
                if tls is not None:
                    self._yaovi_tls = {"verify": tls}
            return init

        def make_select(original, transport_type):
            def select(self, url):
                ctx = _context.get() or getattr(self, "_yaovi_context", None)
                if ctx and getattr(self, "_yaovi_provider", None):
                    ctx = {**ctx, "provider": self._yaovi_provider}
                proxy = route(url, ctx)
                if proxy == "environment":
                    return original(self, url)
                with self._yaovi_transport_lock:
                    if proxy not in self._yaovi_transports:
                        self._yaovi_transports[proxy] = transport_type(proxy=proxy, trust_env=False, **self._yaovi_tls)
                    return self._yaovi_transports[proxy]
            return select
        cls.__init__ = make_init(original_init)
        cls._transport_for_url = make_select(original_select, transport)
    original_close = httpx.Client.close
    def close(self):
        for transport in self._yaovi_transports.values():
            transport.close()
        original_close(self)
    httpx.Client.close = close
    original_aclose = httpx.AsyncClient.aclose
    async def aclose(self):
        for transport in self._yaovi_transports.values():
            await transport.aclose()
        await original_aclose(self)
    httpx.AsyncClient.aclose = aclose
    # __exit__ calls transport.__exit__ directly rather than Client.close().
    old_exit = httpx.Client.__exit__
    def exit_client(self, *args):
        for transport in self._yaovi_transports.values():
            transport.close()
        return old_exit(self, *args)
    httpx.Client.__exit__ = exit_client
    old_aexit = httpx.AsyncClient.__aexit__
    async def exit_async(self, *args):
        for transport in self._yaovi_transports.values():
            await transport.aclose()
        return await old_aexit(self, *args)
    httpx.AsyncClient.__aexit__ = exit_async

    # requests is used by some model catalogs. Keep its response/cookie/redirect semantics;
    # use HTTPX for the adapter transport so SOCKS needs no extra PySocks dependency.
    import requests
    from urllib3.response import HTTPResponse
    from io import BytesIO
    original_send = requests.adapters.HTTPAdapter.send
    def send(self, request, stream=False, timeout=None, verify=True, cert=None, proxies=None):
        ctx = _credential_context(request.url, request.headers)
        proxy = route(request.url, ctx)
        if proxy == "environment":
            return original_send(self, request, stream, timeout, verify, cert, proxies)
        seconds = timeout if isinstance(timeout, (int, float)) else max(timeout or (30, 30))
        with httpx.Client(verify=verify, cert=cert, trust_env=False, timeout=seconds) as client:
            if ctx and ctx.get("provider"):
                client._yaovi_provider = ctx["provider"]
            response = client.request(request.method, request.url, headers=dict(request.headers), content=request.body, follow_redirects=False)
            raw = HTTPResponse(body=BytesIO(response.content), headers={k: v for k, v in response.headers.items() if k.lower() not in ("content-encoding", "content-length")}, status=response.status_code, preload_content=False)
            return self.build_response(request, raw)
    requests.adapters.HTTPAdapter.send = send

    import urllib.request
    import urllib.response
    import urllib.error
    from email.message import Message
    original_open = urllib.request.OpenerDirector.open
    def open_url(self, fullurl, data=None, timeout=socket._GLOBAL_DEFAULT_TIMEOUT):
        request = fullurl if isinstance(fullurl, urllib.request.Request) else urllib.request.Request(fullurl, data=data)
        if request.type not in ("http", "https") or route(request.full_url) == "environment":
            return original_open(self, fullurl, data, timeout)
        verify = next((getattr(h, "_context", None) for h in self.handlers if isinstance(h, urllib.request.HTTPSHandler) and getattr(h, "_context", None) is not None), True)
        with httpx.Client(verify=verify, timeout=timeout if isinstance(timeout, (int, float)) else 30, follow_redirects=True) as client:
            response = client.request(request.get_method(), request.full_url, headers=dict(request.header_items()), content=data if data is not None else request.data)
        headers = Message()
        for name, value in response.headers.items():
            if name.lower() not in ("content-encoding", "content-length"):
                headers[name] = value
        headers["Content-Length"] = str(len(response.content))
        if response.status_code >= 400:
            raise urllib.error.HTTPError(str(response.url), response.status_code, response.reason_phrase, headers, BytesIO(response.content))
        return urllib.response.addinfourl(BytesIO(response.content), headers, str(response.url), response.status_code)
    urllib.request.OpenerDirector.open = open_url

    original_start = threading.Thread.start
    def start(self, *args, **kwargs):
        if _context.get():
            context = contextvars.copy_context()
            run = self.run
            self.run = lambda: context.run(run)
        return original_start(self, *args, **kwargs)
    threading.Thread.start = start
    import subprocess
    original_popen = subprocess.Popen
    class ModelProcess(original_popen):
        def __init__(self, args, *a, **kwargs):
            command = kwargs.get("executable") or (args[0] if isinstance(args, (list, tuple)) and args else "")
            provider = {"copilot": "copilot-acp", "claude": "claude-code"}.get(Path(str(command)).stem)
            if provider and _context.get():
                env = dict(kwargs.get("env") or os.environ)
                route_env = process_env(provider)
                for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
                    env.pop(key, None)
                    if key in route_env:
                        env[key] = route_env[key]
                kwargs["env"] = env
            super().__init__(args, *a, **kwargs)
    subprocess.Popen = ModelProcess
    for module_name, names in (("openai", ("OpenAI", "AsyncOpenAI")), ("anthropic", ("Anthropic", "AsyncAnthropic"))):
        try:
            module = __import__(module_name)
        except ImportError:
            continue
        for name in names:
            cls = getattr(module, name)
            original = cls.__init__
            def bind(original):
                @functools.wraps(original)
                def init(self, *args, **kwargs):
                    original(self, *args, **kwargs)
                    ctx = _context.get()
                    key = kwargs.get("api_key") or kwargs.get("auth_token")
                    if ctx and key:
                        provider = ctx["credentials"].get((str(self.base_url).rstrip("/"), hashlib.sha256(str(key).encode()).hexdigest()))
                        if provider:
                            self._client._yaovi_provider = provider
                return init
            cls.__init__ = bind(original)


def process_env(provider):
    """External login subprocesses receive a private, pinned environment."""
    env = dict(os.environ)
    ctx = _context.get()
    proxy = _policy(ctx, provider) if ctx else "environment"
    if proxy != "environment":
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
            env.pop(key, None)
        if proxy:
            env.update(HTTP_PROXY=proxy, HTTPS_PROXY=proxy, ALL_PROXY=proxy, NO_PROXY="")
        else:
            env.update(NO_PROXY="*", no_proxy="*")
    return env


def test(provider=None):
    import httpx
    ctx = _context.get()
    proxy = route(_auth_urls.get(provider, "https://example.com/"))
    result = {"proxy": "skipped", "target": "skipped", "message": ""}
    if proxy and proxy != "environment":
        url = urlsplit(proxy)
        try:
            with socket.create_connection((url.hostname, url.port), timeout=5):
                pass
            result["proxy"] = "passed"
        except OSError:
            return {**result, "proxy": "failed", "message": "服务器无法连接代理，请检查地址、端口和代理是否运行。"}
    if not provider:
        return {**result, "message": "代理端口可达。请选择模型连接，继续测试目标服务。" if result["proxy"] == "passed" else "未指定代理，无需测试代理端口。"}
    url = _auth_urls.get(provider) or next((base for base, pid in ctx["routes"] if pid == provider), None)
    if not url:
        return {**result, "message": "该连接没有可测试的服务地址。"}
    try:
        with httpx.Client(timeout=10, follow_redirects=False) as client:
            with client.stream("GET", url) as response:
                status = response.status_code
        # An authorization-required response still proves the TLS target was reached.
        if status == 407:
            return {**result, "proxy": "failed", "message": "代理拒绝认证，请检查代理账号和密码。"}
        return {**result, "target": "passed", "message": "目标服务可达；这不代表账号已登录。"}
    except httpx.ProxyError:
        return {**result, "proxy": "failed", "target": "skipped", "message": "代理连接或认证失败，请检查代理协议、账号和密码。"}
    except Exception:
        return {**result, "target": "failed", "message": "目标服务不可达，请检查代理认证、出口网络或稍后重试。"}
