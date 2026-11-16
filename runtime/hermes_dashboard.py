"""In-process dispatch to Hermes' own dashboard REST handlers (Yaoyao embedded mode).

Yaoyao used to call a separately running Hermes dashboard over HTTP. The embedded runtime has
no ASGI server: hermes_service.py shims FastAPI so the router modules import as plain functions
and records each decorated route. ``call`` matches a method + path against those routes and
invokes the native handler with path, query and body arguments, so responses keep the exact
shapes the dashboard returned. One service process serves one Hermes home, so the ``profile``
query parameter is resolved by the caller choosing the process, never by the handler.
"""
import asyncio
import inspect
import re
import types
import typing
from typing import Any

ROUTER_MODULES = (
    "hermes_cli.web_routers.sessions",
    "hermes_cli.web_routers.profiles",
    "hermes_cli.web_routers.config_env",
    "hermes_cli.web_routers.models",
    "hermes_cli.web_routers.files",
)
_loaded = False
_compiled: list[tuple[str, re.Pattern, list[str], Any]] = []


def _load(routes):
    global _loaded
    if _loaded:
        return
    import importlib
    import os
    from pathlib import Path
    home = Path(os.environ["HERMES_HOME"])
    if not (home / "state.db").exists():
        # The dashboard expects its gateway to have created the store; the embedded home creates it here.
        from hermes_state import SessionDB
        SessionDB(db_path=home / "state.db").close()
    for name in ROUTER_MODULES:
        importlib.import_module(name)
    for method, template, fn in routes:
        names = re.findall(r"{([A-Za-z_][A-Za-z0-9_]*)(?::path)?}", template)
        pattern = re.escape(template)
        for param in names:
            pattern = pattern.replace(re.escape("{" + param + ":path}"), "(?P<%s>.+)" % param)
            pattern = pattern.replace(re.escape("{" + param + "}"), "(?P<%s>[^/]+)" % param)
        # Static routes (``/api/sessions/search``) win over templates (``/api/sessions/{id}``).
        _compiled.append((method, re.compile("^" + pattern + "$"), names, fn))
    _compiled.sort(key=lambda item: len(item[2]))
    _loaded = True


class _Request:
    def __init__(self, query, body):
        self.headers = {}
        self.cookies = {}
        self.query_params = query
        self.client = types.SimpleNamespace(host="127.0.0.1", port=0)
        self.url = types.SimpleNamespace(path="", query="")
        self.state = types.SimpleNamespace()
        self._body = body

    async def json(self):
        return self._body


def _base_types(annotation):
    if annotation is inspect.Parameter.empty:
        return ()
    origin = typing.get_origin(annotation)
    if origin in (typing.Union, types.UnionType):
        return tuple(a for a in typing.get_args(annotation) if a is not type(None))
    return (annotation,)


def _convert(value, annotation):
    for kind in _base_types(annotation):
        if kind is bool:
            return str(value).lower() in ("1", "true", "yes", "on")
        if kind is int:
            return int(value)
        if kind is float:
            return float(value)
        if kind is str:
            return str(value)
    return value


def _model_type(annotation):
    for kind in _base_types(annotation):
        if inspect.isclass(kind) and hasattr(kind, "model_validate"):
            return kind
    return None


def _arguments(fn, path_args, query, body):
    kwargs = {}
    for name, param in inspect.signature(fn).parameters.items():
        annotation = param.annotation
        if name in path_args:
            kwargs[name] = _convert(path_args[name], annotation)
        elif name == "request" or getattr(annotation, "__name__", "") == "Request":
            kwargs[name] = _Request(query, body)
        elif _model_type(annotation) is not None:
            kwargs[name] = _model_type(annotation).model_validate(body or {})
        elif name in query:
            kwargs[name] = _convert(query[name], annotation)
        elif name in ("body", "payload", "data") and body is not None:
            kwargs[name] = body
        elif param.default is not inspect.Parameter.empty:
            kwargs[name] = param.default
    return kwargs


def _response(result):
    if hasattr(result, "status_code") and hasattr(result, "body") and not hasattr(result, "kwargs"):
        # Real starlette responses (JSONResponse, Response, PlainTextResponse).
        raw = bytes(result.body or b"")
        media = getattr(result, "media_type", None) or ""
        if "json" in media:
            import json
            return {"status": int(result.status_code), "json": json.loads(raw or b"null")}
        return {"status": int(result.status_code), "text": raw.decode("utf-8", "replace"), "media_type": media}
    if hasattr(result, "path") and type(result).__name__ == "FileResponse" and not hasattr(result, "kwargs"):
        return {"status": int(getattr(result, "status_code", 200)), "file": str(result.path),
                "filename": getattr(result, "filename", None), "media_type": getattr(result, "media_type", None), "headers": {}}
    args = getattr(result, "args", None)
    options = getattr(result, "kwargs", None)
    if args is None or options is None:
        return {"status": 200, "json": result}
    kind = type(result).__name__
    if kind == "FileResponse":
        path = options.get("path", args[0] if args else None)
        return {"status": 200, "file": str(path), "filename": options.get("filename"),
                "media_type": options.get("media_type"), "headers": options.get("headers") or {}}
    status = int(options.get("status_code") or 200)
    if kind == "JSONResponse":
        return {"status": status, "json": options.get("content", args[0] if args else None)}
    content = options.get("content", args[0] if args else b"")
    if isinstance(content, bytes):
        content = content.decode("utf-8", "replace")
    return {"status": status, "text": content, "media_type": options.get("media_type")}


def call(routes, error_type, args):
    _load(routes)
    method = str(args.get("method") or "GET").upper()
    path = str(args.get("path") or "")
    query = {k: v for k, v in (args.get("query") or {}).items() if k != "profile"}
    body = args.get("body")
    allowed = False
    for route_method, pattern, _names, fn in _compiled:
        match = pattern.match(path)
        if not match:
            continue
        allowed = True
        if route_method != method:
            continue
        try:
            result = fn(**_arguments(fn, match.groupdict(), query, body))
            if inspect.isawaitable(result):
                result = asyncio.run(result) if inspect.iscoroutine(result) else asyncio.run(_await(result))
            return _response(result)
        except error_type as exc:
            detail = getattr(exc, "detail", "") or str(exc)
            return {"status": int(getattr(exc, "status_code", 500) or 500), "json": {"detail": detail}}
    return {"status": 405 if allowed else 404, "json": {"detail": "Not Found" if not allowed else "Method Not Allowed"}}


async def _await(value):
    return await value
