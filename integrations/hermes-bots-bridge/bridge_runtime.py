"""Process-private, session-scoped tool capabilities for Hermes v0.21.0.

Only this canonical module owns bindings. Nothing is written into prompts,
global MCP settings, the Hermes environment or persistent session metadata.
"""

from __future__ import annotations

import base64
import hmac
import hashlib
import json
import math
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from contextvars import ContextVar
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

VERSION = 1
PLUGIN_VERSION = "1.3.0"
def _plugin_fingerprint():
    root = Path(__file__).parent
    digest = hashlib.sha256()
    for path in sorted(p for p in root.rglob('*') if p.is_file() and '__pycache__' not in p.parts
                       and 'tests' not in p.relative_to(root).parts and (p.suffix == '.py' or p.name in ('plugin.yaml', 'manifest.json'))):
        digest.update(path.relative_to(root).as_posix().encode() + b'\0' + path.read_bytes() + b'\0')
    return digest.hexdigest()

# Freeze at module load: files copied later must not masquerade as loaded code.
PLUGIN_FINGERPRINT = _plugin_fingerprint()
MAX_LEASE_MS = 30 * 60 * 1000
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
registered = False
_lock = threading.RLock()
_bindings: dict[str, "Binding"] = {}
# Remember revoked generations while the live gateway object exists so an old
# HTTP bind arriving after unbind cannot reinstate an obsolete capability.
_generations: dict[str, tuple[dict, set[str]]] = {}
_contexts: dict[Path, Any] = {}
_children: dict[str, tuple["Binding", Any]] = {}
_skill_review_scope: ContextVar[Any] = ContextVar("yaoyao_skill_review", default=None)
_SKILL_REVIEW_TOOLS = frozenset({"skills_list", "skill_view", "skill_manage"})


class BridgeError(Exception):
    def __init__(self, message: str, status: int = 403, code: str = "forbidden"):
        super().__init__(message)
        self.status = status
        self.code = code


@dataclass(repr=False)
class Binding:
    session_id: str
    stored_session_id: str
    profile: str
    profile_home: Path
    generation: str
    bridge_url: str
    token: str
    expires_at: float
    owner: tuple[str, str]
    session: dict
    agent: Any
    toolset: str = ""
    registrations: list = field(default_factory=list)
    native_names: set = field(default_factory=set)
    catalog_fingerprint: str = ""
    sampling: dict = field(default_factory=dict)
    computer_policy: dict | None = None
    workspace_memory: bool = False
    profile_memory_tools: set = field(default_factory=set)
    transfer_namespaces: set = field(default_factory=set)


def _cleanup_file_transfers(namespaces):
    import subprocess
    for namespace in namespaces:
        try:
            subprocess.run([sys.executable, str(Path(__file__).with_name('file_transfer.py')), namespace],
                           input=json.dumps({'op': 'transfer-cleanup'}), text=True, capture_output=True, timeout=5)
        except Exception:
            pass


def register_context(ctx):
    from hermes_constants import get_hermes_home
    _contexts[Path(get_hermes_home()).resolve()] = ctx
    if callable(getattr(ctx, "register_hook", None)):
        ctx.register_hook("subagent_start", inherit_child)
        ctx.register_hook("subagent_stop", release_child)
        ctx.register_hook("pre_tool_call", refresh_catalog)
        ctx.register_hook("pre_tool_call", computer_directive)


def _refresh_agent_tools(agent, binding):
    # Dashboard /bind runs outside the session's Profile context. Hermes keys
    # plugin registries and tool-definition caches by the active home; without
    # this scope a named Profile silently receives the default Profile catalog.
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    context = set_hermes_home_override(binding.profile_home)
    try:
        _refresh_profile_agent_tools(agent, binding)
    finally:
        reset_hermes_home_override(context)


def _refresh_profile_agent_tools(agent, binding):
    if binding.workspace_memory:
        _isolate_profile_memory(agent, binding)
    _isolate_profile_context(agent, binding)
    from model_tools import get_tool_definitions, get_toolset_for_tool
    if not hasattr(agent, "_yaoyao_base_toolsets"):
        agent._yaoyao_base_toolsets = getattr(agent, "enabled_toolsets", None)
    base = agent._yaoyao_base_toolsets
    definitions = get_tool_definitions(enabled_toolsets=base,
        disabled_toolsets=getattr(agent, "disabled_toolsets", None), quiet_mode=True,
        skip_tool_search_assembly=True) or []
    # Expand wildcard scopes before adding a private lease. Otherwise an
    # `all` Agent's Tool Search could enumerate another Bot's dynamic schemas.
    enabled = sorted({toolset for tool in definitions
                      if (toolset := get_toolset_for_tool(tool.get("function", {}).get("name", "")))
                      and not toolset.startswith("yaoyao_turn_")})
    if binding.toolset and binding.toolset not in enabled:
        enabled.append(binding.toolset)
    agent.enabled_toolsets = enabled
    agent.tools = get_tool_definitions(enabled_toolsets=enabled,
        disabled_toolsets=getattr(agent, "disabled_toolsets", None), quiet_mode=True) or []
    agent.valid_tool_names = {tool["function"]["name"] for tool in agent.tools}
    if hasattr(agent, "_memory_manager"):
        from agent.memory_manager import inject_memory_provider_tools
        inject_memory_provider_tools(agent)
    invalidate = getattr(agent, "_invalidate_system_prompt", None)
    if callable(invalidate):
        invalidate()


def _retire(binding):
    namespaces = tuple(binding.transfer_namespaces)
    binding.transfer_namespaces.clear()
    if namespaces:
        threading.Thread(target=_cleanup_file_transfers, args=(namespaces,), daemon=True).start()
    for child_id, (owner, _) in list(_children.items()):
        if owner is binding:
            _children.pop(child_id, None)
    for registration in reversed(binding.registrations):
        if registration is not None:
            registration.dispose()
    binding.registrations.clear()
    if binding.toolset:
        if hasattr(binding.agent, "_yaoyao_base_toolsets"):
            binding.agent.enabled_toolsets = binding.agent._yaoyao_base_toolsets
            del binding.agent._yaoyao_base_toolsets


def inherit_child(parent_session_id=None, child_session_id=None, **kwargs):
    """Only the core lifecycle can introduce a child; model args cannot."""
    try:
        binding = _resolve(parent_session_id)
        inherited = _children.get(parent_session_id) or next((entry for entry in _children.values() if getattr(entry[1], "session_id", None) == parent_session_id), None)
        parent = inherited[1] if inherited else binding.agent
        child = next((item for item in getattr(parent, "_active_children", [])
                      if getattr(item, "session_id", None) == child_session_id), None)
        if child is None or not child_session_id:
            return
        with _lock:
            _children[child_session_id] = (binding, child)
            _refresh_agent_tools(child, binding)
    except BridgeError:
        return


def release_child(child_session_id=None, **kwargs):
    with _lock:
        for key, (_, child) in list(_children.items()):
            if key == child_session_id or getattr(child, "session_id", None) == child_session_id:
                _children.pop(key, None)


def refresh_catalog(session_id=None, function_name=None, tool_name=None, **kwargs):
    if _skill_review_scope.get() is not None:
        return
    if (function_name or tool_name) not in {"tool_search", "tool_describe", "yaoyao_tools"}:
        return
    try:
        binding = _resolve(session_id)
        if binding.toolset:
            with _lock:
                _mount_native_tools(binding)
    except BridgeError:
        return


def _mount_native_tools(binding, *, timeout=10):
    """Register session-scoped schemas in Hermes' own searchable catalog."""
    ctx = _contexts.get(binding.profile_home)
    if ctx is None:
        raise BridgeError("请安装新版工具桥并重新打开 Hermes 会话", 409, "tools_unavailable")
    catalog = _request(binding, "/tools/list", timeout=timeout)
    fingerprint = hashlib.sha256(json.dumps(catalog.get("tools", []), sort_keys=True).encode()).hexdigest()
    if fingerprint == binding.catalog_fingerprint:
        return
    for registration in reversed(binding.registrations):
        registration.dispose()
    binding.registrations.clear()
    binding.native_names.clear()
    binding.toolset = "yaoyao_turn_" + hashlib.sha256(binding.generation.encode()).hexdigest()[:16]
    for tool in catalog.get("tools", []):
        tool_id = _string(tool, "id")
        label = _string(tool, "name")
        name = "yaoyao_" + re.sub(r"[^a-zA-Z0-9_]", "_", label)[:30] + "_" + hashlib.sha256(tool_id.encode()).hexdigest()[:12]
        description = f"夭夭 Bot {label}。" + str(tool.get("description") or "")
        def handler(args, _tool_id=tool_id, **kwargs):
            try:
                if _resolve(kwargs.get("session_id", "")) is not binding:
                    raise BridgeError("此工具属于其他轮次，授权已失效")
                return call_tool({"toolId": _tool_id, "arguments": args}, **kwargs)
            except BridgeError as exc:
                return json.dumps({"error": str(exc), "code": exc.code}, ensure_ascii=False)
        handle = ctx.register_tool(name=name, toolset=binding.toolset, description=description,
            schema={"name": name, "description": description, "parameters": tool.get("inputSchema") or {"type": "object", "properties": {}}}, handler=handler)
        if handle is None:
            raise BridgeError("Hermes 无法注册本轮工具", 503, "unsupported_runtime")
        binding.registrations.append(handle)
        binding.native_names.add(name)
    _refresh_agent_tools(binding.agent, binding)
    for owner, child in list(_children.values()):
        if owner is binding:
            _refresh_agent_tools(child, binding)
    binding.catalog_fingerprint = fingerprint


async def sampling_request(owner, body):
    """Reuse Hermes' bounded native MCP sampling, scoped to this turn/profile."""
    binding = _resolve(_string(body, "session_id"))
    if binding.owner != owner or binding.generation != _string(body, "generation"):
        raise BridgeError("采样请求不属于当前轮次")
    name = _string(body, "server", 128)
    params = body.get("params")
    if not isinstance(params, dict):
        raise BridgeError("采样请求格式无效", 400)
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from tools.mcp_tool import SamplingHandler, _ensure_mcp_sdk
    _ensure_mcp_sdk()
    from mcp.types import CreateMessageRequestParams
    parsed = CreateMessageRequestParams.model_validate(params)
    context = set_hermes_home_override(binding.profile_home)
    try:
        handler = binding.sampling.setdefault(name, SamplingHandler(name, {"max_rpm": 10, "timeout": 30, "max_tokens_cap": 4096}))
        result = await handler(None, parsed)
        if _resolve(binding.session_id) is not binding:
            raise BridgeError("采样结果所属轮次已经结束")
        return result.model_dump(by_alias=True, exclude_none=True)
    finally:
        reset_hermes_home_override(context)


def _web():
    # This module must execute inside the real Dashboard. Never create a new
    # Dashboard with a new auth token when a plugin is imported in another host.
    web = sys.modules.get("hermes_cli.web_server")
    if web is None or not callable(getattr(web, "_has_valid_session_token", None)):
        raise BridgeError("当前进程不是受支持的 Hermes Dashboard", 503, "unsupported_runtime")
    return web


def _server():
    try:
        from tui_gateway import server
    except ImportError:
        raise BridgeError("Hermes 会话接口不可用", 503, "unsupported_runtime") from None

    if not isinstance(getattr(server, "_sessions", None), dict) or not hasattr(server, "_sessions_lock"):
        raise BridgeError("Hermes 会话接口不兼容，请修复工具桥或更新 Hermes", 503, "unsupported_runtime")
    if not callable(getattr(server, "_turn_isolation_enabled", None)):
        raise BridgeError("无法确认 Hermes 的运行模式", 503, "unsupported_runtime")
    try:
        isolated = server._turn_isolation_enabled()
    except Exception:
        raise BridgeError("无法确认 Hermes 的运行模式", 503, "unsupported_runtime") from None
    if isolated:
        raise BridgeError("工具桥仅支持 Hermes 非隔离运行模式", 503, "unsupported_mode")
    return server


def request_identity(request) -> tuple[str, str]:
    """Use only the core HTTP gate's verified principal, never request JSON."""
    web = _web()
    if bool(getattr(web.app.state, "auth_required", False)):
        session = getattr(request.state, "session", None)
        user = getattr(session, "user_id", None)
        provider = getattr(session, "provider", None)
        if not isinstance(user, str) or not user or not isinstance(provider, str) or not provider:
            raise BridgeError("请先登录 Hermes Dashboard", 401, "unauthorized")
        if provider == "server-internal" or getattr(session, "expires_at", 0) <= time.time():
            raise BridgeError("Hermes 登录已过期", 401, "unauthorized")
        return provider, user
    if not web._has_valid_session_token(request):
        raise BridgeError("Hermes 本机令牌无效", 401, "unauthorized")
    return "local-session-token", "dashboard"


def _transport_identity(transport) -> tuple[str, str]:
    from tui_gateway.ws import WSTransport

    if not isinstance(transport, WSTransport):
        raise BridgeError("仅支持已认证的 Dashboard WebSocket 会话")
    identity = getattr(transport, "auth_identity", None)
    web = _web()
    if bool(getattr(web.app.state, "auth_required", False)):
        if not isinstance(identity, dict):
            raise BridgeError("WebSocket 会话缺少可信身份")
        user, provider = identity.get("user_id"), identity.get("provider")
        if not isinstance(user, str) or not user or not isinstance(provider, str) or not provider or provider == "server-internal":
            raise BridgeError("WebSocket 会话身份不受支持")
        return provider, user
    # Identity None alone is not authority: stdio and unauthenticated fakes also
    # have no identity. Require the canonical token on the admitted WS object.
    ws = getattr(transport, "_ws", None)
    token = getattr(ws, "query_params", {}).get("token", "")
    expected = getattr(web, "_SESSION_TOKEN", "")
    if identity is not None or not isinstance(token, str) or not expected or not hmac.compare_digest(token, expected):
        raise BridgeError("WebSocket 会话与本机登录不匹配")
    return "local-session-token", "dashboard"


def capabilities(profile: str = "default") -> dict:
    in_process = False
    try:
        _web()
        if not isinstance(profile, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", profile):
            raise BridgeError("Profile 名称无效", 400, "invalid_profile")
        from hermes_cli.profiles import get_profile_dir, profile_exists
        from hermes_constants import set_hermes_home_override, reset_hermes_home_override

        if not profile_exists(profile):
            raise BridgeError("Hermes Profile 不存在", 404, "profile_missing")
        home = get_profile_dir(profile)
        # Dashboard APIs mount independently of the lazy tool-plugin loader.
        from hermes_cli.plugins import discover_plugins
        from hermes_cli.config import load_config
        from model_tools import get_tool_definitions

        context = set_hermes_home_override(home)
        try:
            server = _server()
            in_process = True
            discover_plugins()
            config = load_config()
            agent_config = config.get("agent") or {}
            definitions = get_tool_definitions(
                enabled_toolsets=server._load_enabled_toolsets(),
                disabled_toolsets=agent_config.get("disabled_toolsets") if isinstance(agent_config, dict) else None,
                quiet_mode=True, skip_tool_search_assembly=True,
            ) or []
            names = {t.get("function", {}).get("name") for t in definitions if isinstance(t, dict)}
            if not {"yaoyao_tools", "yaoyao_call"} <= names:
                raise BridgeError(f"Profile {profile} 尚未安装或启用夭夭工具桥，请检查该 Profile 的插件与工具集设置", 503, "profile_tools_unavailable")
            return {"version": VERSION, "ready": True, "in_process": True, "profile": profile, "native_tools": True,
                    "computer_runtime_version": 2, "plugin_version": PLUGIN_VERSION, "plugin_fingerprint": PLUGIN_FINGERPRINT,
                    "memory_isolation": True, "memory_isolation_transport": "bridge-bind-v1", "memory_extraction": True,
                    "isolated_context_files": True, "skill_learning": True, "model_settings_version": 1, "file_transfer_version": 1}
        finally:
            reset_hermes_home_override(context)
    except Exception as exc:
        reason = str(exc) if isinstance(exc, BridgeError) else "无法确认 Hermes 插件接口兼容性"
        return {"version": VERSION, "ready": False, "in_process": in_process, "profile": profile, "reason": reason,
                "plugin_version": PLUGIN_VERSION, "plugin_fingerprint": PLUGIN_FINGERPRINT}


def _string(body: dict, key: str, maximum: int = 512) -> str:
    value = body.get(key)
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 for c in value):
        raise BridgeError(f"参数 {key} 无效", 400, "invalid_request")
    return value


def _bridge_url(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
        if (
            parsed.scheme != "http" or parsed.hostname != "127.0.0.1"
            or not port or not 1 <= port <= 65535
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment
            or value != f"http://127.0.0.1:{port}"
        ):
            raise ValueError()
    except ValueError:
        raise BridgeError("工具桥地址必须是本机 127.0.0.1 的 HTTP 端口", 400, "invalid_request") from None
    return value


def _profile_home(session: dict, profile: str) -> Path:
    from hermes_cli.profiles import get_profile_dir, profile_matches_home
    from hermes_constants import get_process_hermes_home

    actual = Path(session.get("profile_home") or get_process_hermes_home()).resolve()
    if not profile_matches_home(profile, actual):
        raise BridgeError("Profile 与 Hermes 会话不匹配")
    return Path(get_profile_dir(profile)).resolve()


def _check_session_mode(session: dict) -> None:
    # A session created before the process-wide setting changed can still own
    # a compute host. Its worker cannot share this process-private table.
    if session.get("_compute_host_active"):
        raise BridgeError("此 Hermes 会话仍使用隔离计算进程，请在非隔离模式下新建会话", 503, "unsupported_mode")


def _expiry(body: dict) -> float:
    value = body.get("expires_at")
    now = time.time() * 1000
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not now < value <= now + MAX_LEASE_MS + 5000:
        raise BridgeError("工具桥授权有效期无效", 400, "invalid_request")
    return value


def _agent_has_tools(agent, home: Path) -> bool:
    required = {"yaoyao_tools", "yaoyao_call"}
    names = {
        t.get("function", {}).get("name")
        for t in (getattr(agent, "tools", None) or []) if isinstance(t, dict)
    }
    if required <= names:
        return True
    if not {"tool_call", "tool_describe"} <= names or not hasattr(agent, "enabled_toolsets") or not hasattr(agent, "disabled_toolsets"):
        return False
    # Current Hermes defers plugin schemas behind Tool Search. Check the same
    # scoped pre-assembly catalog its dispatcher uses, not process-global names
    # or text in the model-visible tool_search description.
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from model_tools import get_tool_definitions

    context = set_hermes_home_override(home)
    try:
        definitions = get_tool_definitions(
            enabled_toolsets=agent.enabled_toolsets,
            disabled_toolsets=agent.disabled_toolsets,
            quiet_mode=True, skip_tool_search_assembly=True,
        ) or []
        return required <= {t.get("function", {}).get("name") for t in definitions if isinstance(t, dict)}
    finally:
        reset_hermes_home_override(context)


def _purge(server) -> None:
    now = time.time() * 1000
    for sid, binding in list(_bindings.items()):
        if binding.expires_at <= now or server._sessions.get(sid) is not binding.session:
            _bindings.pop(sid, None)
            _retire(binding)
    for sid, (session, _) in list(_generations.items()):
        if server._sessions.get(sid) is not session:
            _generations.pop(sid, None)
    for sid, (binding, _) in list(_children.items()):
        if _bindings.get(binding.session_id) is not binding:
            _children.pop(sid, None)


@contextmanager
def _bind_locks(server, deadline):
    # Lock contention is part of the binding deadline, not an unbounded wait
    # outside it. In particular a stalled earlier bind must not trap retries.
    acquired = []
    try:
        for lock in (server._sessions_lock, _lock):
            if not lock.acquire(timeout=max(0, deadline - time.monotonic())):
                raise BridgeError("Hermes 工具桥正在处理其他绑定，请稍后重试", 409, "binding_busy")
            acquired.append(lock)
        yield
    finally:
        for lock in reversed(acquired):
            lock.release()


def bind(owner: tuple[str, str], body: dict, *, wait_seconds: float = 20) -> dict:
    workspace_memory = body.get("workspace_memory", False)
    if type(workspace_memory) is not bool:
        raise BridgeError("记忆隔离设置格式无效", 400, "invalid_memory_policy")
    policy = body.get("computer_policy")
    if policy is not None and (not isinstance(policy, dict) or set(policy) != {"mode", "hostAccess"}
                               or policy.get("mode") not in {"isolated", "profile"}
                               or type(policy.get("hostAccess")) is not bool):
        raise BridgeError("电脑会话权限格式无效", 400, "invalid_computer_policy")
    server = _server()
    sid = _string(body, "session_id")
    stored = _string(body, "stored_session_id")
    profile = _string(body, "profile", 128)
    generation = _string(body, "generation", 128)
    url = _bridge_url(_string(body, "bridge_url", 128))
    token = _string(body, "token", 512)
    if len(token) < 32:
        raise BridgeError("工具桥令牌长度不足", 400, "invalid_request")
    expiry = _expiry(body)
    deadline = time.monotonic() + wait_seconds
    build_requested = False
    while True:
        with _bind_locks(server, deadline):
            session = server._sessions.get(sid)
            if not isinstance(session, dict):
                raise BridgeError("Hermes 会话不存在", 404, "session_missing")
            _check_session_mode(session)
            if _transport_identity(session.get("transport")) != owner:
                raise BridgeError("当前登录不能绑定此会话")
            home = _profile_home(session, profile)
            if session.get("_finalized"):
                raise BridgeError("Hermes 会话已经结束", 409, "session_closed")
            agent = session.get("agent")
            if session.get("agent_error"):
                # Provider errors can contain credentials. Keep this response
                # bounded and let Hermes retain its detailed initialization log.
                raise BridgeError("Hermes Profile 初始化失败，工具桥尚未绑定", 409, "agent_initialization_failed")
            current = _bindings.get(sid)
            busy = bool(session.get("running")) and not (current and current.generation == generation)
            if agent is not None and not busy:
                break
            start_build = getattr(server, "_start_agent_build", None)
            needs_build = agent is None and not busy and not build_requested and callable(start_build)
        if needs_build:
            # Native, idempotent startup also covers resumed lazy sessions.
            # Never submit a prompt merely to trigger initialization: it would
            # run the first turn before memory/tools have been bound.
            build_requested = True
            start_build(sid, session)
        if time.monotonic() >= deadline:
            if busy:
                raise BridgeError("Hermes 会话正在运行，不能更换轮次授权", 409, "session_busy")
            raise BridgeError("Hermes 会话仍在初始化，请重试", 409, "initializing")
        time.sleep(0.1)

    with _bind_locks(server, deadline):
        _purge(server)
        expiry = _expiry(body)
        if server._sessions.get(sid) is not session or session.get("agent") is not agent:
            raise BridgeError("Hermes 会话已改变，请重试", 409, "session_changed")
        _check_session_mode(session)
        if _transport_identity(session.get("transport")) != owner or _profile_home(session, profile) != home:
            raise BridgeError("Hermes 会话身份或 Profile 已改变")
        current_keys = {str(session.get("session_key") or ""), str(getattr(agent, "session_id", "") or "")}
        if stored not in current_keys:
            raise BridgeError("持久会话 ID 与当前会话不匹配", 409, "session_changed")
        if not _agent_has_tools(agent, home):
            raise BridgeError("此会话尚未加载工具桥，请启用 yaoyao_bot_bridge 工具集并新建会话", 409, "tools_unavailable")
        current = _bindings.get(sid)
        if current and current.generation == generation:
            if current.session is not session or current.agent is not agent or current.owner != owner or current.profile != profile or current.bridge_url != url or current.computer_policy != policy or current.workspace_memory != workspace_memory or not hmac.compare_digest(current.token, token):
                raise BridgeError("不能更改现有轮次的工具授权", 409, "generation_conflict")
            current.expires_at = max(current.expires_at, expiry)
            current.stored_session_id = stored
            return {"ok": True, "generation": generation, "expires_at": current.expires_at,
                    "native_tools": bool(current.toolset), "computer_runtime_version": 2, "workspace_memory": current.workspace_memory}
        previous = _generations.get(sid)
        seen = previous[1] if previous and previous[0] is session else set()
        if generation in seen:
            raise BridgeError("该轮次授权已撤销", 409, "generation_revoked")
        if session.get("running"):
            raise BridgeError("Hermes 会话正在运行，不能更换轮次授权", 409, "session_busy")
        if session.get("_yaoyao_workspace_memory") and not workspace_memory:
            raise BridgeError("此 Bot 会话必须继续使用独立记忆，请新建会话后更改模式", 409, "memory_policy_conflict")
        if len(seen) >= 4096:
            raise BridgeError("请恢复会话以更新工具桥授权记录", 409, "session_renewal_required")
        seen.add(generation)
        _generations[sid] = (session, seen)
        if current:
            _retire(current)
        binding = Binding(sid, stored, profile, home, generation, url, token, expiry, owner, session, agent)
        binding.computer_policy = dict(policy) if policy else None
        binding.workspace_memory = workspace_memory
        if workspace_memory:
            _isolate_profile_memory(agent, binding)
            session["_yaoyao_workspace_memory"] = True
        _isolate_profile_context(agent, binding)
        if policy:
            # Private runtime state survives unbind so a stale tool call cannot
            # fall back to the unrestricted native Profile after revocation.
            session["_yaoyao_computer_policy"] = dict(policy)
        _bindings[sid] = binding
        if body.get("native_tools") is True:
            try:
                _mount_native_tools(binding, timeout=max(0.1, min(10, deadline - time.monotonic())))
            except Exception:
                _bindings.pop(sid, None)
                _retire(binding)
                raise
        return {"ok": True, "generation": generation, "expires_at": expiry, "native_tools": bool(binding.toolset),
                "computer_runtime_version": 2, "workspace_memory": binding.workspace_memory}


def unbind(owner: tuple[str, str], body: dict) -> dict:
    server = _server()
    sid, generation = _string(body, "session_id"), _string(body, "generation", 128)
    with server._sessions_lock, _lock:
        _purge(server)
        binding = _bindings.get(sid)
        if binding is None:
            return {"ok": True, "removed": False}
        if binding.owner != owner:
            raise BridgeError("当前登录不能撤销此会话的授权")
        if binding.generation != generation:
            return {"ok": True, "removed": False}
        _bindings.pop(sid, None)
        _retire(binding)
        return {"ok": True, "removed": True}


def _resolve(session_id: str) -> Binding:
    # session_id is supplied by Hermes' tool dispatcher kwargs, never args.
    if not isinstance(session_id, str) or not session_id:
        raise BridgeError("工具调用缺少可信 Hermes 会话身份")
    server = _server()
    with server._sessions_lock, _lock:
        _purge(server)
        inherited = _children.get(session_id)
        if inherited is None:
            inherited = next((value for value in _children.values() if getattr(value[1], "session_id", None) == session_id), None)
        if inherited:
            binding, child = inherited
            if _bindings.get(binding.session_id) is not binding or getattr(child, "session_id", None) != session_id:
                raise BridgeError("子代理工具授权已失效")
            session_id = binding.session_id
        matches = [
            (sid, session) for sid, session in server._sessions.items()
            if session_id in {
                sid, str(session.get("session_key") or ""),
                str(getattr(session.get("agent"), "session_id", "") or ""),
            }
        ]
        if len(matches) != 1:
            raise BridgeError("无法确定工具调用所属的唯一会话")
        sid, session = matches[0]
        _check_session_mode(session)
        binding = _bindings.get(sid)
        if binding is None:
            raise BridgeError("本轮没有可用的夭夭工具授权，或授权已经结束")
        if binding.session is not session or session.get("agent") is not binding.agent:
            raise BridgeError("Hermes 会话已更换，旧工具授权失效")
        if _transport_identity(session.get("transport")) != binding.owner or _profile_home(session, binding.profile) != binding.profile_home:
            raise BridgeError("工具调用的身份或 Profile 已改变")
        if not session.get("running") or session.get("_finalized"):
            raise BridgeError("本轮已经停止，工具授权不可使用")
        return binding


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise BridgeError("工具桥拒绝重定向", 502, "bridge_redirect")


def _request(binding: Binding, path: str, body: dict | None = None, *, timeout=600) -> dict:
    remaining = (binding.expires_at - time.time() * 1000) / 1000
    if remaining <= 0:
        raise BridgeError("本轮工具授权已过期")
    request = urllib.request.Request(
        binding.bridge_url + path,
        data=json.dumps({} if body is None else body, ensure_ascii=False).encode(),
        headers={"Authorization": "Bearer " + binding.token, "Content-Type": "application/json"},
        method="POST",
    )
    # Loopback never uses machine proxy settings; redirects must not leak token.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=min(remaining, timeout)) as response:
            raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise BridgeError("工具结果过大，请改用文件附件", 502, "result_too_large")
        result = json.loads(raw)
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except urllib.error.HTTPError as exc:
        # Do not reflect upstream response/request objects: they can carry keys.
        raise BridgeError(f"工具桥拒绝请求（HTTP {exc.code}）", 502, "bridge_rejected") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        if path == "/tools/list":
            raise BridgeError("Hermes 未能读取夭夭的本轮工具目录，尚未提交聊天消息", 502, "bridge_catalog_unreachable") from None
        raise BridgeError("工具桥连接中断；操作可能已执行，请先检查结果，不要自动重试", 502, "bridge_unreachable") from None
    except (ValueError, UnicodeError):
        raise BridgeError("工具桥返回了无效结果", 502, "invalid_result") from None


def _attachment(binding: Binding, data: bytes, mime: str) -> str:
    # Immutable UUID filenames, private directory and private files. Persist
    # outside conversations so file references survive Dashboard restarts.
    parent = binding.profile_home / "attachments"
    directory = parent / "yaoyao-bot-bridge"
    if parent.is_symlink() or directory.is_symlink():
        raise BridgeError("工具附件目录不能是符号链接", 502, "invalid_attachment_directory")
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    extension = mimetypes.guess_extension(mime) or ".bin"
    if not re.fullmatch(r"\.[a-zA-Z0-9]{1,10}", extension):
        extension = ".bin"
    path = directory / (str(uuid.uuid4()) + extension)
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    parent_fd = os.open(parent, directory_flags)
    try:
        try:
            os.mkdir("yaoyao-bot-bridge", mode=0o700, dir_fd=parent_fd)
        except FileExistsError:
            pass
        directory_fd = os.open("yaoyao-bot-bridge", directory_flags, dir_fd=parent_fd)
        try:
            os.fchmod(directory_fd, 0o700)
            fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory_fd)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
        finally:
            os.close(directory_fd)
    finally:
        os.close(parent_fd)
    return str(path)


def _decode(value: Any) -> bytes:
    if not isinstance(value, str):
        raise BridgeError("工具附件缺少有效内容", 502, "invalid_result")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise BridgeError("工具附件编码无效", 502, "invalid_result") from None


def normalize_result(result: dict, binding: Binding) -> str | dict:
    """Preserve MCP blocks; adapt pictures to Hermes' native vision envelope."""
    parts: list[dict] = []
    texts: list[str] = []
    has_image = False

    def text(value: str):
        texts.append(value)
        parts.append({"type": "text", "text": value})

    if result.get("isError"):
        text("工具执行失败：")
    blocks = result.get("content", [])
    if not isinstance(blocks, list):
        raise BridgeError("工具结果 content 无效", 502, "invalid_result")
    for block in blocks:
        if not isinstance(block, dict):
            text(json.dumps(block, ensure_ascii=False))
            continue
        kind = block.get("type")
        if kind == "text":
            text(str(block.get("text", "")))
        elif kind in {"image", "audio"}:
            mime = str(block.get("mimeType") or "application/octet-stream")
            data = _decode(block.get("data"))
            if kind == "image" and mime in {"image/png", "image/jpeg", "image/gif", "image/webp"}:
                has_image = True
                parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}})
                texts.append(f"[图像 {mime}，{len(data)} 字节]")
            else:
                path = _attachment(binding, data, mime)
                text(f"附件（{mime}）：{path}")
        elif kind == "resource" and isinstance(block.get("resource"), dict):
            resource = block["resource"]
            mime = str(resource.get("mimeType") or "application/octet-stream")
            if "blob" in resource:
                path = _attachment(binding, _decode(resource["blob"]), mime)
                text(f"附件（{mime}，来源 {resource.get('uri', '')}）：{path}")
            elif "text" in resource:
                text(f"资源 {resource.get('uri', '')}\n{resource['text']}")
            else:
                text(json.dumps(block, ensure_ascii=False))
        elif kind == "resource_link":
            text(json.dumps(block, ensure_ascii=False))
        else:
            # Unknown future MCP content stays available as a JSON attachment,
            # rather than silently dropping bytes or sending invalid AI parts.
            path = _attachment(binding, json.dumps(block, ensure_ascii=False).encode(), "application/json")
            text(f"扩展工具结果：{path}")
    if "structuredContent" in result:
        text(json.dumps(result["structuredContent"], ensure_ascii=False))
    if not blocks and "structuredContent" not in result:
        text(json.dumps(result, ensure_ascii=False))
    summary = "\n".join(texts)
    return {"_multimodal": True, "content": parts, "text_summary": summary} if has_image else summary


def list_tools(args: dict, **kwargs) -> str:
    try:
        if args:
            raise BridgeError("查询工具不接受身份或其他参数", 400, "invalid_request")
        binding = _resolve(kwargs.get("session_id", ""))
        result = _request(binding, "/tools/list")
        if _resolve(kwargs.get("session_id", "")) is not binding:
            raise BridgeError("本轮工具授权已经更换")
        return json.dumps(result, ensure_ascii=False)
    except BridgeError as exc:
        return json.dumps({"error": str(exc), "code": exc.code}, ensure_ascii=False)


def call_tool(args: dict, **kwargs) -> str | dict:
    try:
        if not isinstance(args, dict) or set(args) != {"toolId", "arguments"} or not isinstance(args.get("arguments"), dict):
            raise BridgeError("调用必须只包含 toolId 和 arguments", 400, "invalid_request")
        tool_id = _string(args, "toolId")
        binding = _resolve(kwargs.get("session_id", ""))
        # The model cannot pick identity, credentials or a replay identifier.
        # One UUID per invocation. No automatic retry of side-effecting tools.
        invocation = kwargs.get("tool_call_id")
        call_id = hashlib.sha256((str(kwargs.get("session_id")) + ":" + invocation).encode()).hexdigest() if isinstance(invocation, str) and invocation else str(uuid.uuid4())
        result = _request(binding, "/tools/call", {"toolId": tool_id, "arguments": args["arguments"], "callId": call_id})
        # A cancelled or replaced grant may finish in the background. Do not
        # release its result to a different turn after an HTTP round trip.
        if _resolve(kwargs.get("session_id", "")) is not binding:
            raise BridgeError("本轮工具授权已经更换")
        return normalize_result(result, binding)
    except BridgeError as exc:
        return json.dumps({"error": str(exc), "code": exc.code}, ensure_ascii=False)


# Native Hermes remains the only owner of Profile configuration, skills and
# authenticated integrations. The Runner never opens those files itself.
def _isolate_profile_context(agent, binding):
    """Disable automatic host instruction files only for isolated Bot sessions.

    Apply on every bind/rebuild, including inherited children, before the model
    runs. Skills have their own loader; history and Profile config stay intact.
    """
    if (binding.computer_policy or {}).get("mode") != "isolated":
        return
    invalidate = getattr(agent, "_invalidate_system_prompt", None)
    if not all(hasattr(agent, name) for name in ("skip_context_files", "load_soul_identity")) or not callable(invalidate):
        raise BridgeError("当前 Hermes 不支持工具桥的会话上下文隔离", 409, "context_isolation_unavailable")
    agent.skip_context_files = True
    # This override loads SOUL even when skip_context_files is true.
    agent.load_soul_identity = False
    invalidate()


def _isolate_profile_memory(agent, binding):
    """Apply the existing agent controls before any prompt, without editing Profile config.

    session.create is Hermes' strict public contract; memory isolation belongs
    to this authenticated session binding instead of invented RPC parameters.
    """
    required = ("_memory_store", "_memory_manager", "_memory_enabled", "_user_profile_enabled", "skip_background_review")
    if not all(hasattr(agent, name) for name in required) or not callable(getattr(agent, "_invalidate_system_prompt", None)):
        raise BridgeError("当前 Hermes 不支持工具桥的会话记忆隔离", 409, "memory_isolation_unavailable")
    manager = agent._memory_manager
    binding.profile_memory_tools.add("memory")
    if manager:
        binding.profile_memory_tools.update(manager.get_all_tool_names())
    agent._memory_store = None
    agent._memory_manager = None
    agent._memory_enabled = False
    agent._user_profile_enabled = False
    agent.skip_background_review = True
    agent.disabled_toolsets = list(dict.fromkeys([*(agent.disabled_toolsets or []), "memory"]))
    if manager:
        manager.shutdown_all()
    agent._invalidate_system_prompt()
    if agent is binding.agent:
        _enable_skill_review(agent, binding)


@dataclass
class _SkillReviewScope:
    parent: Any
    binding: Binding
    deadline: float
    agent: Any = None
    run: Any = None


class _SkillReviewParent:
    """Keep Hermes' review lifecycle on the real parent; constrain its detached fork.

    Hermes registers the fork before its first model request. Intercept that
    per-instance assignment, without patching Hermes classes or global config.
    """
    def __init__(self, scope):
        object.__setattr__(self, "_scope", scope)

    def __getattr__(self, name):
        return getattr(self._scope.parent, name)

    def __setattr__(self, name, value):
        scope = self._scope
        if name == "_background_review_run" and value is not None:
            scope.run = value
        if name == "_background_review_agent" and value is not None:
            # Routed review models rebuild their prompt; same-model reviews may
            # rebuild after compaction. Both must retain the parent's isolation.
            value.skip_context_files = scope.parent.skip_context_files
            value.load_soul_identity = scope.parent.load_soul_identity
            value.skip_background_review = True
            value._memory_store = value._memory_manager = None
            value._memory_enabled = value._user_profile_enabled = False
            from model_tools import get_tool_definitions
            value.tools = [tool for tool in get_tool_definitions(enabled_toolsets=["skills"],
                disabled_toolsets=scope.parent.disabled_toolsets, quiet_mode=True,
                skip_tool_search_assembly=True) or [] if tool.get("function", {}).get("name") in _SKILL_REVIEW_TOOLS]
            value.valid_tool_names = {tool["function"]["name"] for tool in value.tools}
            value._invalidate_system_prompt()
            scope.agent = value
        setattr(scope.parent, name, value)


def _enable_skill_review(agent, binding):
    """Use Hermes' native trigger/queue/review, while allowing skills only."""
    native = getattr(agent, "_spawn_background_review_now", None)
    required = ("skip_context_files", "load_soul_identity", "_background_review_agent", "_background_review_run")
    if (not all(hasattr(agent, name) for name in required) or not callable(native)
        or (not callable(getattr(native, "__func__", None)) and not hasattr(agent, "_yaoyao_skill_review_native"))):
        raise BridgeError("当前 Hermes 不支持工具桥的技能复盘", 409, "skill_review_unavailable")
    agent._yaoyao_skill_review_binding = binding
    if not hasattr(agent, "_yaoyao_skill_review_native"):
        agent._yaoyao_skill_review_native = native.__func__

        def skills_only(messages_snapshot, review_memory=False, review_skills=False, focus=None,
                        task_cfg=None, _requeue_attempts=0, explicit=False):
            if not review_skills:
                return
            scope = _SkillReviewScope(agent, agent._yaoyao_skill_review_binding,
                                      time.monotonic() + MAX_LEASE_MS / 1000)
            token = _skill_review_scope.set(scope)
            try:
                # Hermes copies ContextVars into its review/tool threads. The
                # main turn never inherits this narrow post-turn permission.
                return agent._yaoyao_skill_review_native(_SkillReviewParent(scope), messages_snapshot,
                    review_memory=False, review_skills=True, focus=focus, task_cfg=task_cfg,
                    _requeue_attempts=_requeue_attempts, explicit=explicit)
            finally:
                _skill_review_scope.reset(token)

        agent._spawn_background_review_now = skills_only
    agent.skip_background_review = False


def _skill_review_directive(scope, session_id, tool_name):
    from hermes_constants import get_hermes_home
    if (time.monotonic() >= scope.deadline or scope.agent is None or scope.run is None
        or getattr(scope.parent, "_background_review_agent", None) is not scope.agent
        or getattr(scope.parent, "_background_review_run", None) is not scope.run
        or scope.run.cancel_requested.is_set()
        or session_id != scope.agent.session_id
        or Path(get_hermes_home()).resolve() != scope.binding.profile_home.resolve()):
        return {"action": "block", "message": "本次技能复盘已结束或 Profile 不匹配。"}
    if tool_name not in _SKILL_REVIEW_TOOLS:
        return {"action": "block", "message": "技能复盘仅允许 skills_list、skill_view 和 skill_manage；不要调用记忆、文件、电脑或协作工具。"}
    return None


def computer_directive(session_id=None, tool_name=None, args=None, **kwargs):
    scope = _skill_review_scope.get()
    if scope is not None:
        return _skill_review_directive(scope, session_id, tool_name)
    try:
        server = _server()
    except BridgeError:
        return None
    with server._sessions_lock, _lock:
        inherited = _children.get(session_id)
        sessions = [inherited[0].session] if inherited else [s for sid, s in server._sessions.items()
            if session_id in {sid, s.get("session_key"), getattr(s.get("agent"), "session_id", None)}]
        managed = next((s for s in sessions if s.get("_yaoyao_computer_policy") or s.get("_yaoyao_workspace_memory")), None)
    if managed is None:
        return None
    try:
        binding = _resolve(session_id)
    except BridgeError:
        return {"action": "block", "message": "电脑会话授权已经结束，请在当前 Bot 中发起新一轮。"}
    policy = binding.computer_policy
    if binding.workspace_memory and tool_name in binding.profile_memory_tools:
        return {"action": "block", "message": "此 Bot 使用独立记忆，请使用本轮授权的 workspace 记忆工具。"}
    if not policy:
        return None if binding.workspace_memory else {"action": "block", "message": "当前轮次缺少电脑权限声明。"}
    if policy["mode"] == "profile" or policy["hostAccess"]:
        return None
    # Skill discovery, vision, and authenticated services retain the Profile's
    # existing tool permissions. Host commands/files/UI require Hermes approval.
    host_tools = {"terminal", "process", "process_manage", "read_file", "write_file", "patch", "search_files",
                  "execute_code", "code_execution", "delegate_task", "computer_use", "desktop_project", "session_search"}
    host = tool_name in host_tools or str(tool_name).startswith(("browser_", "host_", "yaoyao_computer_copy_file_"))
    if not host:
        return None
    fingerprint = hashlib.sha256(json.dumps([tool_name, args], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    try:
        from agent.redact import redact_sensitive_text
        details = redact_sensitive_text(json.dumps(args or {}, ensure_ascii=False), force=True)[:4000]
    except Exception:
        return {"action": "block", "message": "无法安全显示本机操作内容，请使用虚拟机工具或重新发起请求。"}
    return {"action": "approve", "message": f"隔离 Bot 请求使用 Hermes 本机工具 {tool_name}。\n具体操作：{details}",
            "rule_key": "yaoyao-host:" + fingerprint}


def computer_file(owner, body):
    binding = _resolve(_string(body, "session_id"))
    if binding.owner != owner or binding.generation != _string(body, "generation") or not binding.computer_policy:
        raise BridgeError("文件请求不属于当前电脑会话")
    action, raw = body.get("action"), _string(body, "path", 4096)
    transfer = body.get("transfer") if action == "transfer" else None
    if action == "transfer":
        action = body.get("direction")
        operations = {"read": {"transfer-read-open", "transfer-read", "transfer-status", "transfer-abort"},
                      "write": {"transfer-write-open", "transfer-append", "transfer-finish", "transfer-status", "transfer-abort"}}
        if not isinstance(transfer, dict) or transfer.get("op") not in operations.get(action, set()):
            raise BridgeError("文件分块请求格式无效", 400)
    if action not in {"read", "write"} or "\0" in raw:
        raise BridgeError("文件请求格式无效", 400)
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    context = set_hermes_home_override(binding.profile_home)
    try:
        cwd = Path(binding.session.get("cwd") or binding.profile_home)
        path = Path(raw).expanduser()
        path = (cwd / path).resolve() if not path.is_absolute() else path.resolve()
        # Respect Hermes' internal protected paths as well as regular-file and
        # size bounds; model-selected paths never become configuration inputs.
        from tools.file_tools import _check_sensitive_path, _check_protected_instruction_write, _check_approval_required_write
        from agent.file_safety import get_read_block_error
        error = get_read_block_error(str(path)) if action == "read" else _check_sensitive_path(str(path), str(binding.agent.session_id))
        if action == "write" and not error:
            error = (_check_protected_instruction_write([str(path)], str(binding.agent.session_id))
                     or _check_approval_required_write([str(path)], str(binding.agent.session_id)))
        if error:
            raise BridgeError("该文件不在 Hermes 允许的文件访问范围内")
        if transfer is not None:
            import subprocess
            namespace = hashlib.sha256(json.dumps([binding.owner, binding.session_id, binding.generation, action, str(path)]).encode()).hexdigest()
            payload = dict(transfer)
            if payload.get("op") in {"transfer-read-open", "transfer-write-open"}:
                payload["path"] = str(path)
            with _lock:
                if _resolve(binding.session_id) is not binding:
                    raise BridgeError("文件所属轮次已经结束")
                binding.transfer_namespaces.add(namespace)
            try:
                completed = subprocess.run([sys.executable, str(Path(__file__).with_name("file_transfer.py")), namespace],
                                           input=json.dumps(payload), text=True, capture_output=True, cwd=str(cwd), timeout=30)
            finally:
                if _bindings.get(binding.session_id) is not binding:
                    _cleanup_file_transfers((namespace,))
            if completed.returncode:
                raise BridgeError("文件分块传输失败：" + completed.stderr.strip().split("\n")[-1][:300], 400)
            if _resolve(binding.session_id) is not binding:
                raise BridgeError("文件所属轮次已经结束")
            result = json.loads(completed.stdout)
            if "path" in result: result["path"] = raw
            return {"ok": True, **result}
        limit = 25 * 1024 * 1024
        if action == "read":
            import stat
            fd = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(fd, "rb") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
                    raise BridgeError("只支持不超过 25 MiB 的普通文件", 400)
                data = stream.read(limit + 1)
            if len(data) > limit:
                raise BridgeError("文件超过 25 MiB", 413)
            result = {"ok": True, "data": base64.b64encode(data).decode()}
        else:
            encoded = body.get("data")
            if not isinstance(encoded, str) or len(encoded) > (limit + 2) // 3 * 4:
                raise BridgeError("文件超过 25 MiB", 413)
            try:
                data = base64.b64decode(encoded, validate=True)
            except ValueError:
                raise BridgeError("文件编码无效", 400) from None
            if len(data) > limit:
                raise BridgeError("文件超过 25 MiB", 413)
            _resolve(binding.session_id)
            path.parent.mkdir(parents=True, exist_ok=True)
            # Atomic replacement never follows an existing destination symlink.
            import tempfile
            fd, temporary = tempfile.mkstemp(prefix=".yaoyao-transfer-", dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                _resolve(binding.session_id)
                os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            result = {"ok": True}
        if _resolve(binding.session_id) is not binding:
            raise BridgeError("文件所属轮次已经结束")
        return result
    finally:
        reset_hermes_home_override(context)


async def extract_memory(profile, prompt):
    import asyncio
    if not isinstance(profile, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", profile):
        raise BridgeError("Profile 名称无效", 400)
    if not isinstance(prompt, str) or not 0 < len(prompt) <= 65000:
        raise BridgeError("记忆提炼输入无效", 400)
    from hermes_cli.profiles import get_profile_dir, profile_exists
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    if not profile_exists(profile):
        raise BridgeError("Hermes Profile 不存在", 404)
    context = set_hermes_home_override(get_profile_dir(profile))
    try:
        from agent.auxiliary_client import async_call_llm, extract_content_or_reasoning
        from hermes_cli.config import load_config_readonly
        from hermes_cli.runtime_provider import resolve_runtime_provider
        model = load_config_readonly().get("model") or {}
        if not isinstance(model, dict) or not model.get("default"):
            raise BridgeError("Hermes Profile 尚未配置模型", 409)
        runtime = resolve_runtime_provider(requested=model.get("provider"), target_model=model["default"],
                                           explicit_base_url=model.get("base_url"), explicit_api_key=model.get("api_key"))
        # An HTTP request has no agent turn context: never borrow the last
        # multiplexed Profile's runtime from the auxiliary client's mirrors.
        response = await asyncio.wait_for(async_call_llm(task="compression", messages=[
            {"role": "system", "content": "仅从给定材料提炼记忆。不调用工具，不补充未经确认的事实。"},
            {"role": "user", "content": prompt}], tools=[], max_tokens=4096, timeout=90,
            main_runtime={**runtime, "model": model["default"]}), timeout=90)
        return {"text": extract_content_or_reasoning(response)}
    finally:
        reset_hermes_home_override(context)
