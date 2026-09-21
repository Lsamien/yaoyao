"""Authenticated Dashboard API, mounted at /api/plugins/yaoyao-bot-bridge."""

import asyncio
import importlib.util
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse


_spec = importlib.util.spec_from_file_location(
    "_yaoyao_bot_bridge_bootstrap", Path(__file__).parents[1] / "bootstrap.py"
)
if _spec is None or _spec.loader is None:
    raise ImportError("夭夭工具桥加载失败")
_bootstrap = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bootstrap)
bridge = _bootstrap.runtime()
router = APIRouter()
_model_spec = importlib.util.spec_from_file_location("_yaoyao_bot_model_settings", Path(__file__).parents[1] / "model_settings.py")
_models = importlib.util.module_from_spec(_model_spec)
_model_spec.loader.exec_module(_models)


@router.get("/model-options")
async def model_options(request: Request, profile: str = "default"):
    try:
        bridge.request_identity(request)
        return await asyncio.to_thread(_models.options, profile)
    except bridge.BridgeError as exc:
        return _error(exc)
    except _models.ModelSettingsError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc), "code": "invalid_model_settings"})
    except Exception:
        return JSONResponse(status_code=503, content={"detail": "模型工具桥与 Hermes 不兼容或模型服务暂不可用，请检查并重试", "code": "model_settings_unavailable"})


@router.post("/model-settings/resolve")
async def resolve_model_settings(request: Request):
    try:
        bridge.request_identity(request)
        body = await _body(request)
        return await asyncio.to_thread(_models.resolve, body.get("profile"), body.get("settings"))
    except bridge.BridgeError as exc:
        return _error(exc)
    except _models.ModelSettingsError as exc:
        return JSONResponse(status_code=400, content={"detail": str(exc), "code": "invalid_model_settings"})
    except Exception:
        return JSONResponse(status_code=503, content={"detail": "无法解析 Bot 模型配置，请检查工具桥与模型服务", "code": "model_settings_unavailable"})


def _error(exc):
    return JSONResponse(
        status_code=exc.status,
        content={"detail": str(exc), "code": exc.code},
    )


async def _body(request, limit=16384):
    raw = await request.body()
    if len(raw) > limit:
        raise bridge.BridgeError("绑定请求过大", 413, "invalid_request")
    try:
        body = await request.json()
    except Exception:
        raise bridge.BridgeError("绑定请求必须是 JSON 对象", 400, "invalid_request") from None
    if not isinstance(body, dict):
        raise bridge.BridgeError("绑定请求必须是 JSON 对象", 400, "invalid_request")
    return body


@router.post("/computer-file")
async def computer_file(request: Request):
    try:
        identity = bridge.request_identity(request)
        body = await _body(request, 36 * 1024 * 1024)
        return await asyncio.to_thread(bridge.computer_file, identity, body)
    except bridge.BridgeError as exc:
        return _error(exc)
    except Exception:
        return JSONResponse(status_code=502, content={"code": "computer_file_failed", "detail": "Hermes 文件传输失败"})


@router.post("/memory-extract")
async def memory_extract(request: Request):
    try:
        bridge.request_identity(request)
        body = await _body(request, 512 * 1024)
        return await bridge.extract_memory(body.get("profile"), body.get("prompt"))
    except bridge.BridgeError as exc:
        return _error(exc)
    except Exception:
        return JSONResponse(status_code=502, content={"code": "memory_extraction_failed", "detail": "Hermes 记忆提炼失败"})


@router.get("/capabilities")
def capabilities(request: Request, profile: str = "default"):
    try:
        bridge.request_identity(request)
        return bridge.capabilities(profile)
    except bridge.BridgeError as exc:
        return _error(exc)


@router.post("/bind")
async def bind(request: Request):
    try:
        identity = bridge.request_identity(request)
        body = await _body(request)
        return await asyncio.to_thread(bridge.bind, identity, body)
    except bridge.BridgeError as exc:
        return _error(exc)


@router.post("/unbind")
async def unbind(request: Request):
    try:
        identity = bridge.request_identity(request)
        return bridge.unbind(identity, await _body(request))
    except bridge.BridgeError as exc:
        return _error(exc)


@router.post("/sampling")
async def sampling(request: Request):
    try:
        identity = bridge.request_identity(request)
        return await bridge.sampling_request(identity, await _body(request))
    except bridge.BridgeError as exc:
        return _error(exc)
    except Exception:
        return JSONResponse(status_code=502, content={"code": "sampling_failed", "detail": "Hermes MCP 采样失败"})
