"""Web sign-in for the providers whose Hermes dashboard entry is ``flow: external``.

Each flow drives Hermes's own credential code and storage:
  - qwen-oauth   device code + PKCE against Qwen's OAuth server (the flow the Qwen CLI runs), tokens
                 saved with Hermes's ``_save_qwen_cli_tokens`` (~/.qwen/oauth_creds.json, 0600)
  - copilot      GitHub device code with Hermes's Copilot client id; token saved as
                 ``COPILOT_GITHUB_TOKEN`` in .env, exactly like ``hermes model`` → Copilot → option 1
  - copilot-acp  runs ``copilot login`` on the server and surfaces its URL/code
  - anthropic / claude-code
                 paste a token: an API key or a ``claude setup-token`` token minted by Anthropic's own
                 client. No in-app PKCE: Hermes keeps that flow terminal-only on purpose (minting
                 Claude subscription tokens from a scriptable HTTP endpoint is against Anthropic's
                 OAuth usage policies), and Yaovi respects that boundary.

Endpoints can be redirected with YAOVI_HERMES_TEST_* variables, which only tests set.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import secrets
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from typing import Any

WEB_FLOWS = {
    "qwen-oauth": "device_code",
    "copilot": "device_code",
    "copilot-acp": "process",
    "anthropic": "paste_token",
    "claude-code": "paste_token",
}
EXTRA_PROVIDERS = [  # API-key providers whose Hermes setup also offers an OAuth device login
    {"id": "copilot", "name": "GitHub Copilot", "flow": "external", "cli_command": "hermes model",
     "docs_url": "https://docs.github.com/en/copilot", "disconnect_hint": None, "disconnect_command": None,
     "disconnectable": True},
]

_sessions: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


class AuthFlowError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _qwen_base() -> str:
    return os.environ.get("YAOVI_HERMES_TEST_QWEN_OAUTH_BASE", "https://chat.qwen.ai").rstrip("/")


def _github_base() -> str:
    return os.environ.get("YAOVI_HERMES_TEST_GITHUB_BASE", "https://github.com").rstrip("/")


def _post_form(url: str, fields: dict[str, str], timeout: float = 15) -> dict[str, Any]:
    req = urllib.request.Request(url, data=urllib.parse.urlencode(fields).encode(), headers={
        "Accept": "application/json", "User-Agent": "HermesAgent/1.0",
        "Content-Type": "application/x-www-form-urlencoded"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:  # OAuth errors (authorization_pending…) arrive as 4xx JSON
        try:
            return json.loads(e.read().decode() or "{}")
        except Exception:
            return {"error": f"http_{e.code}"}
    except (urllib.error.URLError, OSError, ValueError) as e:
        raise AuthFlowError(502, f"无法连接登录服务：{getattr(e, 'reason', e)}")


def _new_session(provider: str, flow: str, **extra: Any) -> dict[str, Any]:
    sid = uuid.uuid4().hex
    sess = {"id": sid, "provider": provider, "flow": flow, "status": "pending", "error_message": None,
            "created": time.time(), "cancel": threading.Event(), **extra}
    with _lock:
        _sessions[sid] = sess
    return sess


def _finish(sess: dict[str, Any], status: str, error: str | None = None) -> None:
    sess["status"], sess["error_message"] = status, error


def owns(session_id: str) -> bool:
    with _lock:
        return session_id in _sessions


def decorate(listing: dict[str, Any]) -> dict[str, Any]:
    """Tag each external provider with the web flow Yaovi can run for it."""
    providers = listing.get("providers", [])
    known = {p["id"] for p in providers}
    for extra in EXTRA_PROVIDERS:
        if extra["id"] not in known:
            providers.append({**extra, "status": copilot_status()})
    for p in providers:
        if p["id"] in WEB_FLOWS:
            p["web_flow"] = WEB_FLOWS[p["id"]]
    listing["providers"] = providers
    return listing


def copilot_status() -> dict[str, Any]:
    from hermes_cli.config import get_env_value
    token = get_env_value("COPILOT_GITHUB_TOKEN") or ""
    return {"logged_in": bool(token), "source_label": "COPILOT_GITHUB_TOKEN" if token else None,
            "token_preview": token[-4:] if token else None}


# ── device code flows ─────────────────────────────────────────────────────────────────────────

def _start_qwen() -> dict[str, Any]:
    from hermes_cli.auth_constants import QWEN_OAUTH_CLIENT_ID
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode()
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    data = _post_form(f"{_qwen_base()}/api/v1/oauth2/device/code", {
        "client_id": QWEN_OAUTH_CLIENT_ID, "scope": "openid profile email model.completion",
        "code_challenge": challenge, "code_challenge_method": "S256"})
    if not data.get("device_code") or not data.get("user_code"):
        raise AuthFlowError(502, f"Qwen 未返回设备码：{data.get('error_description') or data.get('error') or '未知错误'}")
    sess = _new_session("qwen-oauth", "device_code", expires_at=time.time() + int(data.get("expires_in") or 600))
    interval = max(int(data.get("interval") or 5), 1)

    def poll() -> None:
        fields = {"grant_type": "urn:ietf:params:oauth:grant-type:device_code", "client_id": QWEN_OAUTH_CLIENT_ID,
                  "device_code": data["device_code"], "code_verifier": verifier}
        nonlocal interval
        while time.time() < sess["expires_at"] and not sess["cancel"].wait(interval):
            result = _post_form(f"{_qwen_base()}/api/v1/oauth2/token", fields)
            if result.get("access_token"):
                from hermes_cli.auth_qwen import _save_qwen_cli_tokens
                _save_qwen_cli_tokens({
                    "access_token": result["access_token"], "refresh_token": result.get("refresh_token", ""),
                    "token_type": result.get("token_type", "Bearer"), "resource_url": result.get("resource_url", ""),
                    "expiry_date": int((time.time() + int(result.get("expires_in") or 3600)) * 1000)})
                return _finish(sess, "approved")
            err = result.get("error", "")
            if err == "slow_down":
                interval += 5
            elif err != "authorization_pending":
                return _finish(sess, "denied" if err == "access_denied" else "error", result.get("error_description") or err or "登录失败")
        if sess["status"] == "pending":
            _finish(sess, "cancelled" if sess["cancel"].is_set() else "expired")
    threading.Thread(target=poll, daemon=True).start()
    return {"session_id": sess["id"], "flow": "device_code", "user_code": data["user_code"],
            "verification_url": data.get("verification_uri_complete") or data.get("verification_uri") or "",
            "expires_in": int(data.get("expires_in") or 600), "poll_interval": interval}


def _start_copilot() -> dict[str, Any]:
    # Provider discovery registers the bundled, pinned upstream plugin namespace.
    from providers import get_provider_profile
    if get_provider_profile("copilot") is None:
        raise AuthFlowError(503, "GitHub Copilot 模型插件不可用。")
    from plugins.model_providers.github_copilot.copilot.credentials import COPILOT_OAUTH_CLIENT_ID
    data = _post_form(f"{_github_base()}/login/device/code", {"client_id": COPILOT_OAUTH_CLIENT_ID, "scope": "read:user"})
    if not data.get("device_code") or not data.get("user_code"):
        raise AuthFlowError(502, "GitHub 未返回设备码")
    sess = _new_session("copilot", "device_code", expires_at=time.time() + int(data.get("expires_in") or 900))
    interval = max(int(data.get("interval") or 5), 1)

    def poll() -> None:
        nonlocal interval
        fields = {"client_id": COPILOT_OAUTH_CLIENT_ID, "device_code": data["device_code"],
                  "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}
        while time.time() < sess["expires_at"] and not sess["cancel"].wait(interval):
            result = _post_form(f"{_github_base()}/login/oauth/access_token", fields, 10)
            if result.get("access_token"):
                from hermes_cli.config import save_env_value
                save_env_value("COPILOT_GITHUB_TOKEN", result["access_token"])
                return _finish(sess, "approved")
            err = result.get("error", "")
            if err == "slow_down":
                interval = int(result.get("interval") or interval + 5)
            elif err != "authorization_pending":
                return _finish(sess, "denied" if err == "access_denied" else "error", result.get("error_description") or err or "登录失败")
        if sess["status"] == "pending":
            _finish(sess, "cancelled" if sess["cancel"].is_set() else "expired")
    threading.Thread(target=poll, daemon=True).start()
    return {"session_id": sess["id"], "flow": "device_code", "user_code": data["user_code"],
            "verification_url": data.get("verification_uri") or "https://github.com/login/device",
            "expires_in": int(data.get("expires_in") or 900), "poll_interval": interval}


# ── external process (copilot login) ─────────────────────────────────────────────────────────

_URL_RE = re.compile(r"https?://[^\s'\"<>]+")
_CODE_RE = re.compile(r"\b([A-Z0-9]{4}-[A-Z0-9]{4})\b")


def _start_copilot_acp() -> dict[str, Any]:
    command = os.environ.get("YAOVI_HERMES_TEST_COPILOT_CMD")
    if not command:
        from hermes_cli.auth_external_process import resolve_external_process_command
        command = resolve_external_process_command("copilot")
    if not command:
        raise AuthFlowError(409, "服务器上没有安装 GitHub Copilot CLI（copilot），请先安装后再登录。")
    from model_network import process_env
    proc = subprocess.Popen([command, "login"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1, env={**process_env("copilot-acp"), "NO_COLOR": "1"})
    sess = _new_session("copilot-acp", "process", proc=proc, url="", code="", expires_at=time.time() + 900)
    seen = threading.Event()

    def pump() -> None:
        for line in proc.stdout:  # type: ignore[union-attr]
            if not sess["url"] and (m := _URL_RE.search(line)):
                sess["url"] = m.group(0).rstrip(".,)")
            if not sess["code"] and (m := _CODE_RE.search(line)):
                sess["code"] = m.group(1)
            if sess["url"] and sess["code"]:
                seen.set()
        code = proc.wait()
        seen.set()
        if sess["status"] == "pending":
            _finish(sess, "approved" if code == 0 else ("cancelled" if sess["cancel"].is_set() else "error"),
                    None if code == 0 else f"copilot login 退出码 {code}")
    threading.Thread(target=pump, daemon=True).start()
    seen.wait(20)
    if sess["status"] == "error":
        raise AuthFlowError(502, sess["error_message"] or "copilot login 失败")
    return {"session_id": sess["id"], "flow": "process", "user_code": sess["code"],
            "verification_url": sess["url"] or "https://github.com/login/device", "expires_in": 900, "poll_interval": 3}


# ── paste token (Anthropic) ──────────────────────────────────────────────────────────────────

def submit_token(provider: str, token: str) -> dict[str, Any]:
    token = (token or "").strip()
    if WEB_FLOWS.get(provider) != "paste_token":
        raise AuthFlowError(400, "该供应商不支持粘贴凭据")
    if not token or len(token) > 4096 or re.search(r"\s", token):
        raise AuthFlowError(400, "凭据格式无效")
    from hermes_cli.config import save_env_value
    if token.startswith("sk-ant-oat"):
        var = "CLAUDE_CODE_OAUTH_TOKEN"   # `claude setup-token` output
    elif token.startswith("sk-ant-") and provider == "anthropic":
        var = "ANTHROPIC_API_KEY"
    else:
        raise AuthFlowError(400, "请粘贴以 sk-ant- 开头的 Anthropic API Key，或 `claude setup-token` 生成的令牌")
    save_env_value(var, token)
    return {"ok": True, "env_var": var}


# ── dispatch ──────────────────────────────────────────────────────────────────────────────────

def start(provider: str) -> dict[str, Any]:
    flow = WEB_FLOWS.get(provider)
    if flow == "paste_token":
        raise AuthFlowError(400, "请粘贴凭据（API Key 或 setup-token）")
    starter = {"qwen-oauth": _start_qwen, "copilot": _start_copilot, "copilot-acp": _start_copilot_acp}.get(provider)
    if not starter:
        raise AuthFlowError(400, f"{provider} 没有可用的网页登录")
    return starter()


def poll(provider: str, session_id: str) -> dict[str, Any]:
    with _lock:
        sess = _sessions.get(session_id)
    if not sess or sess["provider"] != provider:
        raise AuthFlowError(404, "登录会话不存在或已过期")
    if sess["status"] == "pending" and time.time() > sess["expires_at"]:
        cancel(session_id)
        _finish(sess, "expired")
    out = {"session_id": session_id, "status": sess["status"], "error_message": sess["error_message"]}
    if sess["flow"] == "process":
        out.update(user_code=sess["code"], verification_url=sess["url"])
    return out


def cancel(session_id: str) -> dict[str, Any]:
    with _lock:
        sess = _sessions.get(session_id)
    if sess:
        sess["cancel"].set()
        proc = sess.get("proc")
        if proc and proc.poll() is None:
            proc.terminate()
        if sess["status"] == "pending":
            _finish(sess, "cancelled")
    return {"ok": True}


def disconnect(provider: str) -> dict[str, Any]:
    from hermes_cli.config import remove_env_value
    if provider == "copilot":
        remove_env_value("COPILOT_GITHUB_TOKEN")
        return {"ok": True}
    raise AuthFlowError(400, "unsupported")
