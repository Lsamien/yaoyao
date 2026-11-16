"""System-owned web tools over Hermes's native providers and safety pipeline.

Called under hermes_service's configuration lock. Bot homes never execute these
operations; Yaovi stores the returned full text as a session-scoped tool result.
"""
import json
import asyncio
import os
import stat
from pathlib import Path


def _run(value):
    return asyncio.run(value) if asyncio.iscoroutine(value) else value


def _system():
    if os.environ.get("YAOVI_HERMES_ROOT"):
        raise ValueError("搜索与网页配置仅支持系统层")


def _extract_backend():
    from tools import web_tools
    from tools.tool_backend_helpers import read_web_capability_selection
    backend = web_tools._get_extract_backend()
    if read_web_capability_selection("extract") is None:
        # Native shared autodetection can choose search-only ddgs/Brave. For
        # an unpinned extract capability use Hermes's capability-aware registry.
        web_tools._ensure_web_plugins_loaded()
        from agent.web_search_registry import get_provider, get_active_extract_provider
        candidate = get_provider(backend)
        if candidate is not None and not candidate.supports_extract():
            candidate = get_active_extract_provider()
            if candidate is not None:
                backend = candidate.name
    return backend


def config():
    _system()
    from hermes_cli.web_routers.tools import get_toolset_config
    from hermes_cli.config import read_raw_config
    result = _run(get_toolset_config("web"))
    web = (read_raw_config() or {}).get("web") or {}
    from tools.tool_backend_helpers import read_selection
    result["selection"] = {cap: web.get(f"{cap}_backend") or read_selection("web")
                           for cap in ("search", "extract")}
    result["active_extract_backend"] = _extract_backend()
    return result


def provider(args):
    _system()
    from hermes_cli.config import read_raw_config, save_config
    from hermes_cli.web_routers.tools import select_toolset_provider
    from hermes_cli.web_models import ToolsetProviderSelect
    capability = args["capability"]
    if capability not in ("search", "extract"):
        raise ValueError("未知网页工具能力")
    if args.get("provider") is None:
        # Restore this capability to native autodetection. A legacy shared pin
        # must not keep it pinned; preserve the other capability explicitly.
        raw = read_raw_config() or {}
        web = raw.setdefault("web", {})
        from tools.tool_backend_helpers import read_selection
        shared = read_selection("web")
        web.pop("backend", None)
        web.pop("use_gateway", None)
        other = "extract" if capability == "search" else "search"
        if shared and not web.get(f"{other}_backend"):
            web[f"{other}_backend"] = shared
        web.pop(f"{capability}_backend", None)
        save_config(raw)
    else:
        _run(select_toolset_provider("web", ToolsetProviderSelect(
            provider=args["provider"], capability=capability)))
    return config()


def env(args):
    _system()
    from hermes_cli.web_routers.tools import save_toolset_env
    from hermes_cli.web_models import ToolsetEnvUpdate
    _run(save_toolset_env("web", ToolsetEnvUpdate(env=args["env"])))
    return config()


def _public_result(result):
    # Vendor error envelopes are successful RPC replies; redact them too.
    from hermes_cli.config import load_env, OPTIONAL_ENV_VARS
    secrets = [v for k, v in (load_env() or {}).items()
               if len(v) >= 8 and OPTIONAL_ENV_VARS.get(k, {}).get("password", True)]
    def clean(value):
        if isinstance(value, str):
            for secret in secrets:
                value = value.replace(secret, "[已隐藏授权]")
            return value
        if isinstance(value, list):
            return [clean(v) for v in value]
        if isinstance(value, dict):
            return {k: clean(v) for k, v in value.items()}
        return value
    result = clean(result)
    failed = result.get("success") is False or bool(result.get("error")) or (
        "results" in result and not any(r.get("content") and not r.get("error") for r in result["results"]))
    if failed:
        result["isError"] = True
        result["configuration_hint"] = "请在我的设置 → 模型服务 → 搜索与网页中检查供应商、凭据和连接。"
    return result


def search(args):
    _system()
    from tools.web_tools import web_search_tool, _get_search_backend
    result = json.loads(web_search_tool(args["query"], limit=args.get("limit", 5)))
    return _public_result({**result, "provider": _get_search_backend()})


def extract(args):
    _system()
    from hermes_constants import get_hermes_dir
    from tools import web_tools_truncate as truncation
    from tools import web_tools
    created = {}
    backend = _extract_backend()
    original_backend = web_tools._get_extract_backend
    original = truncation._store_full_text
    def record(url, content):
        path = original(url, content)
        if path:
            created[url] = Path(path)
        return path
    # Record only paths generated by this native call, never parse a path from
    # provider text or accept one from the model. Restore even on failure.
    truncation._store_full_text = record
    web_tools._get_extract_backend = lambda: backend
    try:
        result = json.loads(_run(web_tools.web_extract_tool(args["urls"], char_limit=args.get("char_limit"))))
    finally:
        truncation._store_full_text = original
        web_tools._get_extract_backend = original_backend
    cache = get_hermes_dir("cache/web", "web_cache").resolve()
    for row in result.get("results", []):
        path = created.get(row.get("url"))
        if path is None:
            continue
        try:
            if path.parent.resolve() != cache:
                raise ValueError("网页缓存目录无效")
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, "r", encoding="utf-8") as stream:
                info = os.fstat(stream.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > 8 * 1024 * 1024:
                    raise ValueError("网页缓存超过读取上限")
                row["content"] = stream.read(2 * 1024 * 1024)
        except (OSError, ValueError):
            # Do not expose the native read_file footer if storage/read failed.
            row["content"] = row.get("content", "").split("──────── [TRUNCATED]", 1)[0]
            row["note"] = "全文缓存无法读取，可提高 char_limit 重新提取。"
    return _public_result({**result, "provider": backend})


def test(args):
    result = search({"query": args.get("query") or "Hermes web search", "limit": 1}) if args["capability"] == "search" else extract({"urls": [args.get("url") or "https://example.com"], "char_limit": 2000})
    return {"ok": not result.get("isError", False), "provider": result.get("provider"), "result": result}
