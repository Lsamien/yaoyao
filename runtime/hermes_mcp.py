"""Hermes-native MCP management for Yaovi (config.yaml ``mcp_servers``), via the service bridge.

Reuses Hermes's own helpers (``hermes_cli.mcp_config`` save/remove/probe/validation, the dashboard
MCP OAuth flow). The dashboard routers themselves depend on the TUI gateway, which the embedded
runtime does not ship, so the thin route bodies are re-expressed here.

Env/header values live in the service's owner-only config.yaml. Public summaries stay redacted;
old env references remain readable and are converted only when that service is explicitly saved.
"""
from __future__ import annotations

import os
import re
import secrets
import threading
import time
from typing import Any

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
ENV_KEY_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,99}$")
REF_RE = re.compile(r"\$\{[^}]+\}")
# Yaovi-only key: run the stdio server inside the Bot's shared Linux desktop (compiled by Yaovi).
YAOVI_KEYS = ("yaovi_location",)


class McpError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _servers() -> dict[str, dict]:
    from hermes_cli.config import read_raw_config
    servers = (read_raw_config() or {}).get("mcp_servers") or {}
    return {k: v for k, v in servers.items() if isinstance(v, dict)} if isinstance(servers, dict) else {}


def _secret_var(server: str, key: str, header: bool = False) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", server).upper().strip("_")
    k = re.sub(r"[^A-Za-z0-9]+", "_", key).upper().strip("_")
    return f"MCP_{slug}_{'HDR_' if header else ''}{k}"[:120]


def _summary(name: str, cfg: dict) -> dict:
    from hermes_cli.web_server_mcp import _mcp_server_summary
    out = _mcp_server_summary(name, cfg)
    headers = cfg.get("headers") or {}
    out["header_keys"] = sorted(headers) if isinstance(headers, dict) else []
    out["env_keys"] = sorted((cfg.get("env") or {}).keys())
    out["yaovi_location"] = cfg.get("yaovi_location") or "server"
    tools = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
    out["include"] = tools.get("include")
    out["exclude"] = tools.get("exclude")
    return out


def op_list(args: dict) -> dict:
    return {"servers": [_summary(n, c) for n, c in sorted(_servers().items())]}


def op_raw(args: dict) -> dict:
    """Private Host compilation input. May contain actual values; never expose or log it."""
    return {"servers": _servers()}


def _secrets(server: str, incoming: Any, previous: dict, header: bool) -> dict:
    from hermes_cli.config import get_env_value, get_hermes_home
    from agent.secret_scope import load_env_file
    from pathlib import Path
    if not isinstance(incoming, dict):
        raise McpError(400, "env/headers 必须是对象")
    out = {}
    for key, value in incoming.items():
        if not isinstance(key, str) or not (ENV_KEY_RE.match(key) if not header else re.match(r"^[A-Za-z0-9-]{1,100}$", key)):
            raise McpError(400, f"无效的键名：{key}")
        if value is True:
            if key not in previous:
                raise McpError(400, f"{key} 没有已保存的值")
            value = previous[key]
            var = _secret_var(server, key, header)
            if value == "${" + var + "}":
                # Read the current home's file before inherited/process values. Bot homes may
                # retain an old reference to their system parent's automatic variable.
                inherited = os.environ.get("YAOVI_HERMES_ROOT", "")
                values = load_env_file(Path(inherited) / ".env") if inherited else {}
                values.update(load_env_file(get_hermes_home() / ".env"))
                value = values[var] if var in values else get_env_value(var)
                if value is None or (isinstance(value, str) and REF_RE.search(value)):
                    raise McpError(400, f"服务 {server} 的 {key} 已保存引用无法解析")
        if not isinstance(value, str) or len(value) > 16000:
            raise McpError(400, f"{key} 的值无效")
        out[key] = value
    return out


def _require_writable() -> None:
    from hermes_cli.config import is_managed
    if is_managed():
        raise McpError(403, "托管配置不允许修改 MCP 服务")


def op_upsert(args: dict) -> dict:
    from hermes_cli.mcp_config import _save_mcp_server
    _require_writable()
    name = str(args.get("name") or "")
    if not NAME_RE.match(name):
        raise McpError(400, "服务名称只能包含字母、数字、- 和 _")
    previous = _servers().get(name) or {}
    if args.get("create") and previous:
        raise McpError(409, f"服务 {name} 已存在")
    transport = args.get("transport") or ("http" if args.get("url") else "stdio")
    cfg: dict[str, Any] = {}
    if transport == "http":
        url = str(args.get("url") or "")
        if not re.match(r"^https?://", url):
            raise McpError(400, "HTTP MCP 需要 http(s) 地址")
        cfg["url"] = url
        headers = _secrets(name, args.get("headers", {}), previous.get("headers") or {}, True)
        if headers:
            cfg["headers"] = headers
        if args.get("auth") == "oauth":
            cfg["auth"] = "oauth"
    else:
        command = str(args.get("command") or "").strip()
        if not command:
            raise McpError(400, "stdio MCP 需要命令")
        cfg["command"] = command
        cfg["args"] = [str(a) for a in (args.get("args") or [])][:64]
        env = _secrets(name, args.get("env", {}), previous.get("env") or {}, False)
        if env:
            cfg["env"] = env
        if args.get("yaovi_location") == "virtual":
            cfg["yaovi_location"] = "virtual"
    tools: dict[str, Any] = {}
    for key in ("include", "exclude"):
        value = args.get(key)
        if value is not None:
            if not isinstance(value, list) or not all(isinstance(v, str) and 0 < len(v) <= 128 for v in value):
                raise McpError(400, f"{key} 必须是工具名列表")
            tools[key] = value[:500]
    if tools:
        cfg["tools"] = tools
    cfg["enabled"] = bool(args.get("enabled", previous.get("enabled", True)))
    for keep in ("sampling", "oauth", "timeout", "connect_timeout"):
        if keep in previous:
            cfg[keep] = previous[keep]
    literal_paths = {("mcp_servers", name, field, key)
                     for field in ("headers", "env") for key, value in cfg.get(field, {}).items()
                     if not REF_RE.search(value)}
    if not _save_mcp_server(name, cfg, literal_paths=literal_paths):
        raise McpError(400, f"服务 {name} 的命令或参数被 Hermes 判定为可疑，未保存")
    return _summary(name, cfg)


def op_remove(args: dict) -> dict:
    from hermes_cli.mcp_config import _remove_mcp_server
    _require_writable()
    name = str(args.get("name") or "")
    if not _remove_mcp_server(name):
        raise McpError(404, f"服务 {name} 不存在")
    return {"ok": True}


def op_enabled(args: dict) -> dict:
    from hermes_cli.config import load_config, save_config
    _require_writable()
    name = str(args.get("name") or "")
    cfg = load_config()
    servers = cfg.get("mcp_servers") or {}
    if name not in servers:
        # A Bot home may switch an inherited system server on/off with a stub override entry.
        if not (args.get("override") and NAME_RE.match(name)):
            raise McpError(404, f"服务 {name} 不存在")
        servers = cfg.setdefault("mcp_servers", servers if isinstance(servers, dict) else {})
        servers[name] = {}
    servers[name]["enabled"] = bool(args.get("enabled"))
    save_config(cfg)
    return {"ok": True, "name": name, "enabled": bool(args.get("enabled"))}


def op_test(args: dict) -> dict:
    from hermes_cli.mcp_config import _oauth_tokens_present, _probe_single_server, redact_mcp_probe_text
    from tools.mcp_tool_config import _interpolate_env_vars
    name = str(args.get("name") or "")
    cfg = args.get("config") if isinstance(args.get("config"), dict) else _servers().get(name)
    if not cfg:
        raise McpError(404, f"服务 {name} 不存在")
    try:
        from hermes_cli.env_loader import load_hermes_dotenv
        load_hermes_dotenv()
    except Exception:
        pass
    cfg = {k: v for k, v in _interpolate_env_vars(dict(cfg)).items() if k not in YAOVI_KEYS}
    details: dict[str, Any] = {}
    from tools.mcp_tool import _ensure_mcp_sdk
    if not _ensure_mcp_sdk():
        return {"ok": False, "error": "Hermes 运行环境缺少 mcp SDK", "tools": []}
    try:
        tools = _probe_single_server(name, cfg, connect_timeout=float(args.get("timeout") or 20), details=details)
    except Exception as exc:
        return {"ok": False, "error": redact_mcp_probe_text(exc), "tools": []}
    if cfg.get("auth") == "oauth" and not _oauth_tokens_present(name):
        return {"ok": False, "error": "需要先完成 OAuth 授权", "tools": []}
    return {"ok": True, "tools": [{"name": t, "description": d} for t, d in tools],
            "prompts": details.get("prompts", 0), "resources": details.get("resources", 0)}


# ── MCP OAuth (Hermes dashboard flow; the callback is served by Yaovi and forwarded here) ──

def op_auth_start(args: dict) -> dict:
    from hermes_constants import get_hermes_home
    from hermes_cli.web_server_mcp import _mcp_oauth_flows, _run_dashboard_mcp_oauth
    from tools.mcp_dashboard_oauth import DashboardOAuthFlow, exception_message
    name = str(args.get("name") or "")
    cfg = _servers().get(name)
    if not cfg:
        raise McpError(404, f"服务 {name} 不存在")
    if not cfg.get("url"):
        raise McpError(400, "stdio 服务通过环境变量认证，不使用 OAuth")
    redirect = str(args.get("redirectUri") or "")
    if not re.match(r"^https?://", redirect):
        raise McpError(400, "缺少回调地址")
    cfg = dict(cfg, auth="oauth")
    if any(f.server_name == name and not f.worker_done for f in _mcp_oauth_flows.values()):
        raise McpError(409, f"{name} 的 OAuth 授权正在进行")
    home = str(get_hermes_home().expanduser().resolve(strict=False))
    flow = DashboardOAuthFlow(flow_id=secrets.token_urlsafe(24), server_name=name, profile=None, hermes_home=home,
                              redirect_uri=redirect, reconnect_live=False)
    _mcp_oauth_flows[flow.flow_id] = flow
    threading.Thread(target=_run_dashboard_mcp_oauth, args=(flow, cfg), daemon=True).start()
    import asyncio
    try:
        asyncio.run(flow.wait_for_authorization_url(timeout=30))
    except Exception as exc:
        flow.mark_error(exception_message(exc))
    return flow.snapshot()


def op_auth_status(args: dict) -> dict:
    from hermes_cli.web_server_mcp import _mcp_oauth_flows
    flow = _mcp_oauth_flows.get(str(args.get("flowId") or ""))
    if flow is None:
        raise McpError(404, "OAuth 流程不存在或已过期")
    snap = flow.snapshot()
    snap["tools"] = flow.tools
    return snap


def op_auth_cancel(args: dict) -> dict:
    from hermes_cli.web_server_mcp import _mcp_oauth_flows
    flow = _mcp_oauth_flows.get(str(args.get("flowId") or ""))
    if flow is not None:
        flow.mark_error("Cancelled by user", cancelled=True)
    return {"ok": True}


def op_auth_callback(args: dict) -> dict:
    from hermes_cli.web_server_mcp import _mcp_oauth_flows
    name, state = str(args.get("name") or ""), args.get("state")
    flow = next((f for f in _mcp_oauth_flows.values() if f.server_name == name and f.status == "authorization_required"
                 and f.expected_state is not None and isinstance(state, str) and secrets.compare_digest(f.expected_state, state)), None)
    if flow is None:
        raise McpError(404, "OAuth 流程已过期")
    try:
        flow.deliver_callback(code=args.get("code"), state=state, error=args.get("error"), iss=args.get("iss"))
    except ValueError as exc:
        raise McpError(409 if "already received" in str(exc) else 400, "回调无效或已使用")
    if args.get("error"):
        raise McpError(400, "授权失败")
    return {"ok": True}
