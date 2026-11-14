"""Yaovi front-end bridge over Hermes's own provider/auth/model management.

One long-lived process per Hermes home (system root or one Bot's runtime home).
Requests and replies are NDJSON on stdin/stdout:
  -> {"id": "1", "op": "oauth.start", "args": {...}}
  <- {"id": "1", "ok": true, "result": {...}} | {"id": "1", "ok": false, "status": 400, "error": "..."}
Every op dispatches to the same functions Hermes's dashboard uses
(hermes_cli/web_routers/{oauth,config_env,models}.py, agent/credential_pool.py,
agent/auxiliary_client.py), so storage stays Hermes-native: config.yaml, .env, auth.json.
"""
import asyncio
import contextlib
import json
import math
import os
import sys
import threading
import time
import types
from argparse import Namespace
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "hermes"))
sys.path.insert(0, str(ROOT))

WIRE = sys.stdout
sys.stdout = sys.stderr  # Hermes helpers print; keep the wire clean.
_wire_lock = threading.Lock()

# Native sections compiled into Bot runs; client reads are always redacted.
CONFIG_KEYS = ("model", "providers", "custom_providers", "fallback_model", "auxiliary", "credential_pool_strategies", "image_gen", "video_gen", "web")


class ServiceError(Exception):
    def __init__(self, status=None, detail="", *, status_code=None, headers=None):
        super().__init__(detail)
        self.status_code = status_code if status_code is not None else status
        self.detail = detail


def _install_fastapi_shim():
    """The dashboard routers import FastAPI only for decorators/exceptions; Yaovi has no ASGI app."""
    if "fastapi" in sys.modules:
        return
    fa = types.ModuleType("fastapi")

    class APIRouter:
        def __init__(self, *a, **k):
            pass

        def __getattr__(self, _name):
            return lambda *a, **k: (lambda fn: fn)

    class Request:
        headers: dict = {}

    def _noop(*a, **k):
        return None

    fa.HTTPException = ServiceError
    fa.APIRouter = APIRouter
    fa.Request = Request
    for name in ("Depends", "Query", "Body", "Header", "WebSocket", "WebSocketDisconnect", "UploadFile", "File", "Form", "Path"):
        setattr(fa, name, _noop)
    sys.modules["fastapi"] = fa
    responses = types.ModuleType("fastapi.responses")
    for name in ("JSONResponse", "FileResponse", "HTMLResponse", "Response", "StreamingResponse", "PlainTextResponse", "RedirectResponse"):
        setattr(responses, name, type(name, (), {"__init__": lambda self, *a, **k: None}))
    sys.modules["fastapi.responses"] = responses
    concurrency = types.ModuleType("fastapi.concurrency")

    async def run_in_threadpool(fn, *a, **k):
        return await asyncio.to_thread(fn, *a, **k)

    concurrency.run_in_threadpool = run_in_threadpool
    sys.modules["fastapi.concurrency"] = concurrency
    # Only stub starlette when it is genuinely absent: the mcp SDK imports the real package.
    try:
        import starlette.concurrency  # noqa: F401
    except ImportError:
        starlette = types.ModuleType("starlette")
        sconc = types.ModuleType("starlette.concurrency")
        sconc.run_in_threadpool = run_in_threadpool
        sys.modules.setdefault("starlette", starlette)
        sys.modules.setdefault("starlette.concurrency", sconc)


def _bootstrap():
    # In the embedded product, connecting an identity and choosing the default
    # model are separate user actions. Native Nous login otherwise moves a former
    # guest's welcome route to a new provider/model automatically after OAuth.
    from hermes_cli import anon_auth
    def keep_model_selection(_account_state):
        from hermes_cli.config import read_raw_config
        try:
            model = read_raw_config().get("model")
        except Exception:
            return {"model": "", "changed": False}
        selected = model.get("default", "") if isinstance(model, dict) else model or ""
        return {"model": str(selected), "changed": False}
    anon_auth.settle_after_upgrade = keep_model_selection
    # Both native Nous OAuth completion paths also save credentials through this
    # helper. Merge the new credential under Hermes's existing auth-store lock
    # without changing active_provider. Never restore an earlier snapshot: that
    # would race a user's explicit model selection in another request/process.
    # Explicit model selection uses _update_config_for_provider and remains intact.
    from hermes_cli import auth
    save_active_provider = auth._save_active_provider_state
    def save_identity_without_selecting_model(provider_id, state):
        if provider_id == "nous":
            return auth._persist_provider_state_to_store(
                provider_id, state, auth._auth_file_path(), set_active=False)
        return save_active_provider(provider_id, state)
    auth._save_active_provider_state = save_identity_without_selecting_model
    _install_fastapi_shim()
    # One process == one home: the dashboard's per-request profile scoping is unnecessary
    # (and depends on the TUI gateway, which the embedded runtime does not ship).
    import hermes_cli.web_server_profiles as profiles
    profiles._profile_scope = lambda profile=None: contextlib.nullcontext()
    profiles._config_profile_scope = lambda profile=None: contextlib.nullcontext()
    import hermes_cli.web_deps as deps
    original_late = deps.late

    def late(name, module="hermes_cli.web_server"):
        if name == "_require_token":
            return lambda request=None: None  # Yaovi authorizes before forwarding.
        if name in ("_profile_scope", "_config_profile_scope"):
            return lambda profile=None: contextlib.nullcontext()
        if name == "_dashboard_code_skew_guard":
            return lambda: None
        return original_late(name, module)

    deps.late = late
    if os.environ.get("YAOVI_HERMES_TEST_OFFLINE"):
        # Test isolation: only loopback is reachable (local fake servers); every remote fetch
        # (models.dev, model catalog, OAuth) fails fast and Hermes falls back to bundled data.
        import socket
        # macOS system proxies (often a loopback proxy) would otherwise tunnel past the guard.
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            os.environ.pop(key, None)
        os.environ["NO_PROXY"] = os.environ["no_proxy"] = "*"
        real_connect = socket.socket.connect

        def _loopback_only(sock, address):
            host = address[0] if isinstance(address, tuple) else address
            if isinstance(host, str) and host not in ("127.0.0.1", "::1", "localhost") and sock.family != socket.AF_UNIX:
                raise ConnectionRefusedError(f"network disabled in tests: {host}")
            return real_connect(sock, address)
        socket.socket.connect = _loopback_only
        real_getaddrinfo = socket.getaddrinfo

        def _no_remote_dns(host, *a, **k):
            if host not in (None, "127.0.0.1", "::1", "localhost"):
                raise socket.gaierror(f"network disabled in tests: {host}")
            return real_getaddrinfo(host, *a, **k)
        socket.getaddrinfo = _no_remote_dns
    # web_server itself needs real fastapi/uvicorn (it SystemExits without them). The routers
    # only reach into it for shared state via LateState, so provide that state in a stub.
    if "hermes_cli.web_server" not in sys.modules:
        import threading
        import types
        stub = types.ModuleType("hermes_cli.web_server")
        stub._CONFIG_MUTATION_LOCK = threading.RLock()
        sys.modules["hermes_cli.web_server"] = stub


def _run(value):
    if asyncio.iscoroutine(value):
        return asyncio.run(value)
    return value


def _model(cls_name, args):
    from hermes_cli import web_models
    return getattr(web_models, cls_name)(**args)


# ── ops ────────────────────────────────────────────────────────────────────────────────────────

def op_ping(args):
    from hermes_constants import get_hermes_home, get_default_hermes_root
    return {"home": str(get_hermes_home()), "root": str(get_default_hermes_root())}


def op_network_test(args):
    import model_network
    return model_network.test(args.get("provider"))


def op_providers_catalog(args):
    """Every Hermes provider: overlay metadata + label + aliases (full parity with `hermes model`)."""
    from hermes_cli import providers as p
    aliases = {}
    for alias, canonical in getattr(p, "ALIASES", {}).items():
        aliases.setdefault(canonical, []).append(alias)
    rows = []
    seen = set()
    try:
        from hermes_cli.provider_catalog import provider_catalog
        for d in provider_catalog():
            seen.add(d.slug)
            ov = p.HERMES_OVERLAYS.get(d.slug)
            rows.append({
                "id": d.slug, "label": d.label, "tab": getattr(d, "tab", ""),
                "authType": ov.auth_type if ov else "api_key", "transport": ov.transport if ov else "openai_chat",
                "aggregator": bool(ov and ov.is_aggregator), "signupUrl": getattr(d, "signup_url", "") or "",
                "envVars": list(getattr(d, "api_key_env_vars", ()) or ()), "aliases": sorted(aliases.get(d.slug, [])),
            })
    except Exception:
        pass
    for pid, ov in p.HERMES_OVERLAYS.items():
        if pid in seen:
            continue
        pdef = p.get_provider(pid, allow_network=False)
        rows.append({
            "id": pid, "label": p.get_label(pid), "tab": "",
            "authType": ov.auth_type, "transport": ov.transport, "aggregator": ov.is_aggregator,
            "signupUrl": "", "envVars": list(getattr(pdef, "api_key_env_vars", ()) or ()) + list(ov.extra_env_vars),
            "aliases": sorted(aliases.get(pid, [])),
        })
    return {"providers": rows}


def _oauth():
    from hermes_cli.web_routers import oauth
    return oauth


def op_oauth_list(args):
    import hermes_external_auth as ext
    return ext.decorate(_run(_oauth().list_oauth_providers()))


def _ext_call(fn, *a):
    import hermes_external_auth as ext
    try:
        return fn(*a)
    except ext.AuthFlowError as e:
        raise ServiceError(e.status, str(e))


def op_oauth_start(args):
    oauth = _oauth()
    provider = args["provider"]
    entry = next((p for p in oauth._OAUTH_PROVIDER_CATALOG if p["id"] == provider), None)
    import hermes_external_auth as ext
    if provider in ext.WEB_FLOWS:
        return _ext_call(ext.start, provider)
    if entry is None:
        raise ServiceError(400, f"Unknown provider {provider}")
    if entry["flow"] == "external":
        raise ServiceError(400, f"{provider} uses an external CLI; run `{entry['cli_command']}` on the server")
    if entry["flow"] != "device_code":
        raise ServiceError(400, "Unsupported flow")
    oauth._gc_oauth_sessions()
    return _run(oauth._start_device_code_flow(provider, profile=None))


def op_oauth_poll(args):
    import hermes_external_auth as ext
    if ext.owns(args["sessionId"]):
        return _ext_call(ext.poll, args["provider"], args["sessionId"])
    return _run(_oauth().poll_oauth_session(args["provider"], args["sessionId"]))


def op_oauth_cancel(args):
    import hermes_external_auth as ext
    if ext.owns(args["sessionId"]):
        return ext.cancel(args["sessionId"])
    return _run(_oauth().cancel_oauth_session(args["sessionId"], None))


def op_oauth_submit(args):
    """Paste-token sign-in (Anthropic API key / `claude setup-token` token) into Hermes's .env."""
    import hermes_external_auth as ext
    return _ext_call(ext.submit_token, args["provider"], args.get("token", ""))


def op_oauth_disconnect(args):
    if args["provider"] == "copilot":
        import hermes_external_auth as ext
        return ext.disconnect("copilot")
    return _run(_oauth().disconnect_oauth_provider(args["provider"], None))


def _config_env():
    from hermes_cli.web_routers import config_env
    return config_env


def _managed_env(key):
    return key.startswith("YAOVI_") or key in {"HOME", "PATH", "HERMES_HOME", "HERMES_PYTHON_SRC_ROOT", "PYTHONPATH", "PYTHONHOME"}


def _env_writable(args):
    if _managed_env(args["key"]):
        raise ServiceError(400, "此变量由服务器运行环境管理，不能在 Hermes 环境变量中修改。")


def op_env_list(args):
    return {key: {**row, "readonly": _managed_env(key)} for key, row in _run(_config_env().get_env_vars()).items()}


def op_env_set(args):
    _env_writable(args)
    return _run(_config_env().set_env_var(_model("EnvVarUpdate", args)))


def op_env_delete(args):
    _env_writable(args)
    return _run(_config_env().remove_env_var(_model("EnvVarDelete", args)))


def _web_call(name):
    def run(args):
        import hermes_web
        try:
            return hermes_web.config() if name == "config" else getattr(hermes_web, name)(args)
        except ValueError as error:
            raise ServiceError(400, str(error))
    return run


op_web_config = _web_call("config")
op_web_provider = _web_call("provider")
op_web_env = _web_call("env")
op_web_search = _web_call("search")
op_web_extract = _web_call("extract")
op_web_test = _web_call("test")


def op_providers_validate(args):
    return _run(_config_env().validate_provider_credential(_model("EnvVarUpdate", args), None))


def op_endpoints_list(args):
    return _run(_config_env().list_custom_endpoints())


def op_endpoints_upsert(args):
    return _run(_config_env().upsert_custom_endpoint(_model("CustomEndpointUpdate", args)))


def op_endpoints_delete(args):
    return _run(_config_env().delete_custom_endpoint(args["id"]))


def op_endpoints_validate(args):
    return _run(_config_env().validate_custom_endpoint(_model("CustomEndpointUpdate", args)))


def _models():
    from hermes_cli.web_routers import models
    return models


def op_model_options(args):
    result = _run(_models().get_model_options(refresh=bool(args.get("refresh")),
                                            include_unconfigured=bool(args.get("includeUnconfigured")),
                                            explicit_only=bool(args.get("explicitOnly"))))
    # The Hermes picker deliberately exposes a broad dial. Yaovi Auto needs the
    # native transport's actual vocabulary so its recorded effort matches the wire.
    from agent.reasoning_effort import codex_supported_efforts, grok_supported_efforts
    from providers import get_provider_profile
    for provider in result.get("providers", []):
        slug = provider.get("slug")
        capabilities = provider.setdefault("capabilities", {})
        for model in provider.get("models", []):
            caps = capabilities.setdefault(model, {})
            if caps.get("reasoning") is False:
                continue
            if slug == "openai-codex":
                levels = codex_supported_efforts(model)
            elif slug in ("xai", "xai-oauth"):
                levels = grok_supported_efforts(model)
            else:
                # A boolean reasoning flag is not a declaration of selectable levels.
                # Preserve explicit catalog metadata; only supplement profile-declared sets.
                if "supported_reasoning_efforts" in caps or "supported_reasoning_levels" in caps:
                    continue
                profile = get_provider_profile(slug) if slug else None
                levels = profile.supported_reasoning_efforts(model) if profile else None
            if levels is not None:
                caps["supported_reasoning_efforts"] = list(levels)
                caps["reasoning"] = bool(levels)
                if levels and slug in ("openai-codex", "xai", "xai-oauth"):
                    caps["default_reasoning_effort"] = "medium"
    return result


def op_model_info(args):
    return _run(_models().get_model_info())


def op_model_recommended(args):
    return _run(_models().get_recommended_default_model(provider=args.get("provider", "")))


def op_model_auxiliary(args):
    return _run(_models().get_auxiliary_models())


def op_model_set(args):
    return _run(_models().set_model_assignment(_model("ModelAssignment", args)))


def _media_toolset(args):
    name = args.get("name")
    if name not in ("image_gen", "video_gen"):
        raise ServiceError(400, "Unknown media toolset")
    return name


def op_media_config(args):
    from hermes_cli.web_routers import tools
    return _run(tools.get_toolset_config(_media_toolset(args)))


def op_media_models(args):
    from hermes_cli.web_routers import tools
    return _run(tools.get_toolset_models(_media_toolset(args), provider=args.get("provider")))


def op_media_provider(args):
    from hermes_cli.web_routers import tools
    return _run(tools.select_toolset_provider(_media_toolset(args), _model("ToolsetProviderSelect", {"provider": args["provider"]})))


def op_media_model(args):
    from hermes_cli.web_routers import tools
    return _run(tools.select_toolset_model(_media_toolset(args), _model("ToolsetModelSelect", {"model": args["model"], "provider": args.get("provider")})))


def op_media_env(args):
    from hermes_cli.web_routers import tools
    return _run(tools.save_toolset_env(_media_toolset(args), _model("ToolsetEnvUpdate", {"env": args["env"]})))


def op_media_generate(args):
    """Use the native media dispatcher; Yaovi only publishes its resulting file as an attachment."""
    import base64
    import mimetypes
    from hermes_constants import get_hermes_home
    name = _media_toolset(args)
    # The service owns this temporary run overlay; never persist a Bot selection to config.yaml.
    from agent import runtime_context
    with _aux_lock:
        previous = runtime_context._context
        selection = args.get("selection")
        if name == "image_gen" and isinstance(selection, dict):
            from hermes_cli.config import load_config
            import copy
            config = copy.deepcopy(load_config())
            provider, model = selection.get("provider"), selection.get("model")
            if not isinstance(provider, str) or not isinstance(model, str) or not provider or not model:
                raise ServiceError(400, "Invalid image model selection")
            section = config.setdefault("image_gen", {})
            section.update({"provider": provider, "model": model, "allow_provider_fallback": False})
            section.setdefault(provider, {})["model"] = model
            runtime_context._context = {"config": config}
        try:
            if name == "image_gen":
                from tools.image_generation_tool import _handle_image_generate
                from agent.image_gen_provider import save_url_image
                arguments = args.get("arguments") or {}
                if arguments.get("image_url") or arguments.get("reference_image_urls"):
                    from tools.image_generation_tool import _active_image_capabilities
                    capabilities = _active_image_capabilities()
                    if "image" not in capabilities.get("modalities", []) or capabilities.get("source_image_role") == "style":
                        raise ServiceError(400, "Selected image model does not support source image editing; no generation was requested")
                result = _handle_image_generate(arguments)
                asset_key, save_url = "image", save_url_image
            else:
                from tools.video_generation_tool import _handle_video_generate
                from agent.video_gen_provider import save_url_video
                result = _handle_video_generate(args.get("arguments") or {})
                asset_key, save_url = "video", save_url_video
        finally:
            runtime_context._context = previous
    result = json.loads(result) if isinstance(result, str) else result
    if not isinstance(result, dict) or not result.get("success"):
        raise ServiceError(502, str((result.get("error") if isinstance(result, dict) else None) or "Hermes media generation failed"))
    asset = result.get(asset_key)
    if not isinstance(asset, str) or not asset:
        raise ServiceError(502, "Hermes returned no media file")
    path = save_url(asset) if asset.startswith(("https://", "http://")) else Path(asset)
    path = path.resolve()
    cache = (get_hermes_home() / "cache").resolve()
    if not path.is_relative_to(cache) or not path.is_file():
        raise ServiceError(502, "Hermes returned an invalid media cache path")
    limit = 32 * 1024 * 1024 if name == "image_gen" else 64 * 1024 * 1024
    with path.open("rb") as source:
        data = source.read(limit + 1)
    if not data or len(data) > limit:
        raise ServiceError(502, "Generated media is empty or exceeds the attachment limit")
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    if not mime.startswith("image/" if name == "image_gen" else "video/"):
        raise ServiceError(502, "Hermes returned an invalid media type")
    return {"name": path.name, "mimeType": mime, "data": base64.b64encode(data).decode("ascii"),
            "provider": result.get("provider"), "model": result.get("model")}


def op_openviking_connection(args):
    from native_openviking import connection
    from hermes_constants import get_hermes_home
    return connection(get_hermes_home())


def _openviking_config_call(name, args):
    import native_openviking_config as native
    from hermes_constants import get_hermes_home
    try:
        if name == 'read': return native.read_configuration(get_hermes_home())
        if name == 'test': return native.test_configuration(get_hermes_home(), args.get('config'))
        if name == 'prepare': return native.prepare(get_hermes_home(), args.get('config'))
        return native.transaction(args.get('token'), args.get('action'), get_hermes_home())
    except native.ConfigurationError as error:
        raise ServiceError(error.status, str(error)) from None


def op_openviking_test(args):
    return _openviking_config_call('test', args)


def op_openviking_config(args):
    return _openviking_config_call('read', args)


def op_openviking_config_prepare(args):
    return _openviking_config_call('prepare', args)


def op_openviking_config_transaction(args):
    return _openviking_config_call('transaction', args)


def op_openviking_remove_peer(args):
    from native_openviking import connection_client
    from plugins.memory.openviking import _resolve_user_space
    import re
    peer = str(args.get("peerId", ""))
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", peer):
        raise ServiceError(400, "peer 名称无效")
    client = connection_client(op_openviking_connection({}), peer)
    user = _resolve_user_space(client, timeout=5, raise_on_timeout=True)
    if not user or user != args.get("user"):
        raise ServiceError(409, "原 OpenViking user 未确认，保留待清理记录")
    try:
        client.delete("/api/v1/fs", params={"uri": f"viking://user/{user}/peers/{peer}", "recursive": True}, timeout=30)
    except Exception as exc:
        if getattr(exc, "status_code", None) != 404:
            raise ServiceError(502, "peer 清理失败，将保留待重试记录") from None
    return {"ok": True}


def op_config_get(args):
    """Raw (non-default-merged) provider sections of this home's config.yaml, secrets redacted."""
    from hermes_cli.config import read_raw_config
    raw = read_raw_config() or {}
    return {"config": _redact({k: raw[k] for k in CONFIG_KEYS if k in raw})}


def op_config_compiled(args):
    """Unredacted provider sections, for compiling into a run config. Never forwarded to a client."""
    from hermes_cli.config import read_raw_config
    raw = read_raw_config() or {}
    return {"config": {k: raw[k] for k in CONFIG_KEYS if k in raw}}


def op_config_patch(args):
    """Replace whole provider sections (null deletes) after Hermes's own structural validation."""
    from hermes_cli.config import read_raw_config, save_config, validate_config_structure
    patch = args.get("config") or {}
    bad = [k for k in patch if k not in CONFIG_KEYS]
    if bad:
        raise ServiceError(400, f"Unsupported config keys: {', '.join(bad)}")
    raw = read_raw_config() or {}
    for key, value in patch.items():
        if value is None:
            raw.pop(key, None)
        else:
            raw[key] = value
    issues = [i for i in validate_config_structure(raw) if getattr(i, "severity", "") == "error"]
    if issues:
        raise ServiceError(400, "; ".join(getattr(i, "message", str(i)) for i in issues))
    save_config(raw)
    return op_config_get({})


def _redact(value):
    if isinstance(value, dict):
        return {k: ("***" if k in ("api_key", "apiKey", "token") and v else _redact(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact(v) for v in value]
    return value


def _entry_view(index, entry):
    token = entry.access_token or ""
    return {
        "index": index, "id": entry.id, "label": entry.label, "authType": entry.auth_type, "source": entry.source,
        "priority": entry.priority, "baseUrl": entry.base_url, "lastStatus": entry.last_status,
        "lastError": entry.last_error_message, "tokenPreview": ("…" + token[-4:]) if len(token) > 8 else "",
    }


def op_pool_list(args):
    from agent.credential_pool import load_pool
    from hermes_cli.config import read_raw_config
    pool = load_pool(args["provider"])
    strategies = (read_raw_config() or {}).get("credential_pool_strategies") or {}
    return {"provider": args["provider"], "strategy": strategies.get(args["provider"], "fill_first"),
            "entries": [_entry_view(i + 1, e) for i, e in enumerate(pool.entries())]}


def op_pool_add(args):
    from agent.credential_pool import load_pool
    from hermes_cli.auth_commands import _add_api_key_credential
    if not (args.get("apiKey") or "").strip():
        raise ServiceError(400, "apiKey required")
    pool = load_pool(args["provider"])
    entry = _add_api_key_credential(Namespace(api_key=args["apiKey"], label=args.get("label") or ""), args["provider"], pool)
    return {"entry": _entry_view(len(pool.entries()), entry)}


def op_pool_remove(args):
    from agent.credential_pool import load_pool
    pool = load_pool(args["provider"])
    removed = pool.remove_index(int(args["index"]))
    if removed is None:
        raise ServiceError(404, "credential not found")
    return {"ok": True}


def op_pool_priority(args):
    from agent.credential_pool import load_pool
    pool = load_pool(args["provider"])
    moved = pool.move_entry(args["id"], int(args["priority"]))
    if moved is None:
        raise ServiceError(404, "credential not found")
    return {"ok": True}


def op_auth_import_codex(args):
    """One-time import of a Yaovi-held Codex OAuth grant into Hermes's auth.json (no network)."""
    from hermes_cli.auth_codex import _save_codex_tokens
    tokens = {"access_token": args["accessToken"], "refresh_token": args["refreshToken"]}
    if args.get("accountId"):
        tokens["account_id"] = args["accountId"]
    _save_codex_tokens(tokens, set_active=False)
    return {"ok": True}


_aux_lock = threading.RLock()


def _aux_timeout(args):
    """A Host classification deadline includes time spent waiting for this shared process's lock."""
    deadline = args.get("deadlineAt")
    if deadline is None:
        return args.get("timeout")
    if isinstance(deadline, bool) or not isinstance(deadline, (int, float)) or not math.isfinite(deadline):
        raise ServiceError(400, "Invalid auxiliary deadline")
    remaining = (deadline - time.time() * 1000) / 1000
    if remaining <= 0:
        raise ServiceError(504, "Auxiliary classification deadline expired")
    timeout = args.get("timeout")
    return min(timeout, remaining) if isinstance(timeout, (int, float)) and timeout > 0 else remaining


def op_aux_complete(args):
    """One auxiliary call through Hermes's own task routing (auxiliary.<task> → main model → fallback).

    ``config`` is the compiled run config (system layer + Bot overlay); it is installed as the
    embedded configuration for the duration of the call, exactly as a Bot run sees it."""
    from agent import runtime_context
    from agent.auxiliary_client import call_llm
    content = args["prompt"]
    images = args.get("images") or []
    if images:
        content = [{"type": "text", "text": args["prompt"]}] + [
            {"type": "image_url", "image_url": {"url": f"data:{i['mimeType']};base64,{i['data']}"}} for i in images]
    kwargs = {"task": args.get("task") or None, "messages": [{"role": "user", "content": content}],
              "max_tokens": args.get("maxTokens") or 1200, "timeout": args.get("timeout")}
    if args.get("provider"):
        kwargs["provider"] = args["provider"]
    if args.get("model"):
        kwargs["model"] = args["model"]
    with _aux_lock:
        kwargs["timeout"] = _aux_timeout(args)
        previous = runtime_context._context
        usage_observations = []
        restore_usage = lambda: None
        if args.get('usageObservation'):
            import dialogue_usage
            restore_usage = dialogue_usage.install({**args['usageObservation'], 'role': 'auxiliary', 'provider': args.get('provider', 'unknown')},
                lambda kind, **event: usage_observations.append(event['observation']))
        if isinstance(args.get("config"), dict):
            runtime_context._context = {"config": args["config"]}
        try:
            if not args.get("provider"):
                # Same main-route handoff a running agent gives its auxiliary calls ("auto" → main).
                with contextlib.suppress(Exception):
                    from hermes_cli.config import load_config
                    from hermes_cli.runtime_provider import resolve_runtime_provider
                    main = (load_config().get("model") or {})
                    if main.get("provider"):
                        rt = resolve_runtime_provider(requested=main["provider"], target_model=main.get("default") or None)
                        kwargs["main_runtime"] = {**rt, "model": main.get("default") or rt.get("model")}
            # Provider preparation also consumes the same deadline; never restart its budget here.
            kwargs["timeout"] = _aux_timeout(args)
            response = call_llm(**kwargs)
        finally:
            runtime_context._context = previous
            restore_usage()
    try:
        text = response.choices[0].message.content or ""
    except Exception:
        text = str(getattr(response, "output_text", "") or "")
    return {"text": text, **({'usageObservations': usage_observations} if args.get('usageObservation') else {})}


def op_provider_runtime(args):
    """Resolved credentials for one Hermes provider (default: the main model's provider).

    Used only by Yaovi's media tools (image/STT/TTS), which call the OpenAI-shaped media
    endpoints directly; chat and auxiliary traffic never leaves Hermes."""
    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider
    main = load_config().get("model") or {}
    provider = args.get("provider") or main.get("provider") or None
    model = args.get("model") or (main.get("default") if provider == main.get("provider") else None)
    rt = resolve_runtime_provider(requested=provider, target_model=model or None)
    return {"provider": rt.get("provider") or provider or "", "base_url": rt.get("base_url") or "",
            "api_key": rt.get("api_key") or "", "api_mode": rt.get("api_mode") or "",
            "model": model or rt.get("model") or ""}


def _mcp_call(fn):
    def run(args):
        import hermes_mcp
        try:
            return getattr(hermes_mcp, fn)(args)
        except hermes_mcp.McpError as e:
            raise ServiceError(e.status, str(e))
    return run


op_mcp_list = _mcp_call("op_list")
op_mcp_raw = _mcp_call("op_raw")
op_mcp_upsert = _mcp_call("op_upsert")
op_mcp_remove = _mcp_call("op_remove")
op_mcp_enabled = _mcp_call("op_enabled")
op_mcp_test = _mcp_call("op_test")
op_mcp_authStart = _mcp_call("op_auth_start")
op_mcp_authStatus = _mcp_call("op_auth_status")
op_mcp_authCancel = _mcp_call("op_auth_cancel")
op_mcp_authCallback = _mcp_call("op_auth_callback")



def _channels_call(fn):
    def run(args):
        import hermes_channels
        try:
            return getattr(hermes_channels, fn)(args)
        except hermes_channels.ChannelError as e:
            raise ServiceError(e.status, str(e))
    return run


op_channels_prepare = _channels_call("op_prepare")
op_channels_whatsappStart = _channels_call("op_whatsapp_start")
op_channels_whatsappApply = _channels_call("op_whatsapp_apply")
op_channels_whatsappStatus = _channels_call("op_whatsapp_status")
op_channels_whatsappCancel = _channels_call("op_whatsapp_cancel")
op_channels_list = _channels_call("op_list")
op_channels_enabled = _channels_call("op_enabled")
op_channels_upsert = _channels_call("op_upsert")
op_channels_setEnabled = _channels_call("op_set_enabled")
op_channels_remove = _channels_call("op_remove")
op_channels_test = _channels_call("op_test")
op_channels_pairingApprove = _channels_call("op_pairing_approve")
op_channels_pairingRevoke = _channels_call("op_pairing_revoke")


def op_ecosystem_skills(args):
    from hermes_ecosystem import skills_catalog
    return skills_catalog()
def op_ecosystem_bundle(args):
    from hermes_ecosystem import skill_bundle
    return skill_bundle(args['sourcePath'], args.get('fingerprint'))

OPS = {name[3:].replace("_", ".", 1): fn for name, fn in globals().items() if name.startswith("op_")}


def emit(value):
    with _wire_lock:
        WIRE.write(json.dumps(value, ensure_ascii=False, default=str) + "\n")
        WIRE.flush()


def handle(message):
    rid = message.get("id")
    fn = OPS.get(message.get("op", ""))
    if fn is None:
        emit({"id": rid, "ok": False, "status": 404, "error": f"unknown op {message.get('op')}"})
        return
    try:
        # Embedded-config readers and writers share the lock so a request cannot
        # observe another Bot's temporary media/auxiliary overlay. These two ops
        # only read persisted config.yaml via Hermes's atomic-write/cache path;
        # they never consult the overlay and must not queue behind slow I/O.
        import model_network
        args = message.get("args") or {}
        op = message.get("op", "")
        with (contextlib.nullcontext() if op in ('config.get', 'config.compiled') else _aux_lock), model_network.scope(message.get("network"), args.get("provider") if op.startswith("oauth.") or op == "network.test" else None,
                                            login=op in ("oauth.start", "oauth.submit", "oauth.poll"), model_operation=not op.startswith(("mcp.", "channels.", "web.", "ecosystem."))):
            result = fn(args)
        emit({"id": rid, "ok": True, "result": result})
    except ServiceError as e:
        emit({"id": rid, "ok": False, "status": e.status_code, "error": public_error(e.detail, message.get("network"))})
    except BaseException as e:  # noqa: BLE001 — every failure (even SystemExit) must reach the caller
        status = getattr(e, "status_code", 500)
        emit({"id": rid, "ok": False, "status": status if isinstance(status, int) else 500,
              "error": public_error(str(getattr(e, "detail", "") or e) or type(e).__name__, message.get("network"))})


def public_error(error, snapshot):
    from urllib.parse import urlsplit, unquote
    text = str(error)
    if snapshot:
        values = [snapshot.get("default"), *snapshot.get("connections", {}).values(), *snapshot.get("botConnections", {}).values()]
        for value in values:
            if not isinstance(value, str) or value == "environment":
                continue
            parsed = urlsplit(value)
            text = text.replace(value, "[代理地址]")
            if parsed.password:
                text = text.replace(parsed.password, "[已隐藏]").replace(unquote(parsed.password), "[已隐藏]")
    return text



def main():
    os.environ.setdefault("HERMES_SKIP_UPDATE_CHECK", "1")
    os.environ["HERMES_PYTHON_SRC_ROOT"] = str(ROOT / "hermes")
    _bootstrap()
    import model_network
    model_network.install()
    import atexit,signal
    def cleanup():
        from hermes_pairing import manager
        manager.close()
    atexit.register(cleanup)
    signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))
    emit({"type": "ready"})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        threading.Thread(target=handle, args=(message,), daemon=True).start()


if __name__ == "__main__":
    main()
