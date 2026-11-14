"""Per-Bot messaging channels on Hermes platform adapters (Telegram, Feishu/Lark, DingTalk, WeCom).

Two roles:
* Service ops (``op_*``), dispatched by ``hermes_service.py`` inside one Bot's Hermes home:
  platform CRUD (secrets in that Bot's ``.env``, ``${VAR}`` references in ``config.yaml``
  under ``yaovi_channels``), connection test, pairing list/approve/revoke (Hermes PairingStore).
* Bridge (``python hermes_channels.py``), one process per Bot with enabled channels, supervised
  by Yaovi. It only sends and receives: inbound messages from authorized senders are written
  to stdout as NDJSON for Yaovi to run; Yaovi sends replies back with ``send`` on stdin.
  Authorization is owner-only pairing (no ALLOW_ALL); unknown DM senders receive a pairing
  code to approve in that Bot's settings; group messages require an @mention.
"""
from __future__ import annotations

import asyncio
import importlib.util
import shutil
import hashlib
import ssl
import copy
import json
import os
import re
import sys
import threading
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent
for _p in (str(ROOT / "hermes"), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

# Platform -> credential fields (env names Hermes adapters read natively) and options.
PLATFORMS: dict[str, dict[str, Any]] = {
    "telegram": {"label": "Telegram", "fields": [
        {"key": "TELEGRAM_BOT_TOKEN", "label": "Bot Token", "secret": True, "required": True}]},
    "feishu": {"label": "飞书 / Lark", "fields": [
        {"key": "FEISHU_APP_ID", "label": "App ID", "secret": False, "required": True},
        {"key": "FEISHU_APP_SECRET", "label": "App Secret", "secret": True, "required": True},
        {"key": "FEISHU_DOMAIN", "label": "域名（feishu / lark）", "secret": False, "required": False}]},
    "dingtalk": {"label": "钉钉", "fields": [
        {"key": "DINGTALK_CLIENT_ID", "label": "Client ID (AppKey)", "secret": False, "required": True},
        {"key": "DINGTALK_CLIENT_SECRET", "label": "Client Secret", "secret": True, "required": True}]},
    "wecom": {"label": "企业微信", "fields": [
        {"key": "WECOM_BOT_ID", "label": "机器人 Bot ID", "secret": False, "required": True},
        {"key": "WECOM_SECRET", "label": "Secret", "secret": True, "required": True}]},
}
PLATFORMS.update({
    'slack': {'label':'Slack','fields':[
        {'key':'SLACK_BOT_TOKEN','label':'Bot Token (xoxb-)','secret':True,'required':True},
        {'key':'SLACK_APP_TOKEN','label':'Socket Mode App Token (xapp-)','secret':True,'required':True}]},
    'discord': {'label':'Discord','fields':[{'key':'DISCORD_BOT_TOKEN','label':'Bot Token','secret':True,'required':True}]},
    'email': {'label':'Email','fields':[
        {'key':'EMAIL_ADDRESS','label':'邮箱地址','secret':False,'required':True},
        {'key':'EMAIL_PASSWORD','label':'应用密码','secret':True,'required':True},
        {'key':'EMAIL_IMAP_HOST','label':'IMAP TLS 主机（993）','secret':False,'required':True},
        {'key':'EMAIL_SMTP_HOST','label':'SMTP STARTTLS 主机（587）','secret':False,'required':True},
        {'key':'EMAIL_AUTHSERV_ID','label':'收信服务器 Authentication-Results authserv-id','secret':False,'required':True}]},
    'signal': {'label':'Signal','fields':[
        {'key':'SIGNAL_HTTP_URL','label':'signal-cli HTTP 地址','secret':False,'required':True},
        {'key':'SIGNAL_ACCOUNT','label':'已关联 Signal 账号','secret':False,'required':True}]},
    'whatsapp': {'label':'WhatsApp','fields':[]},
})


def preparation(name):
    missing=[]
    for module in {'slack':['slack_bolt','slack_sdk'],'discord':['discord'],'signal':['httpx'],'whatsapp':['aiohttp']}.get(name,[]):
        if importlib.util.find_spec(module) is None:missing.append('Python: '+module)
    if name=='whatsapp':
        from hermes_constants import get_hermes_dir
        if not shutil.which('node'):missing.append('Node.js')
        bridge=_whatsapp_bridge_directory()
        stamp=bridge/'node_modules/.hermes-pkg-hash'
        expected=hashlib.sha256((bridge/'package.json').read_bytes()).hexdigest()[:16] if (bridge/'package.json').exists() else ''
        manifest=bridge/'.yaovi-source-hash'
        source=ROOT/'hermes/scripts/whatsapp-bridge'
        current=_bridge_digest(bridge);wanted=_bridge_digest(source)
        if not stamp.exists() or stamp.read_text().strip()!=expected or not manifest.exists() or manifest.read_text().strip()!=wanted or current!=wanted:missing.append('WhatsApp bridge 固定版本依赖（通过主机打包或显式准备安装）')
        if not (get_hermes_dir('platforms/whatsapp/session','whatsapp/session')/'creds.json').exists():missing.append('WhatsApp 扫码关联')
    return {'ready':not missing,'missing':missing}

HOME_ENV = {p: f"{p.upper()}_HOME_CHANNEL" for p in PLATFORMS}
HOME_ENV["email"] = "EMAIL_HOME_ADDRESS"
# Hardened env forced in every bridge: Yaovi is the only authorizer; groups need an @mention.
FORCED_ENV = {
    "GATEWAY_ALLOW_ALL_USERS": "false", "GATEWAY_ALLOWED_USERS": "",
    **{f"{p.upper()}_ALLOW_ALL_USERS": "false" for p in PLATFORMS},
    **{f"{p.upper()}_ALLOWED_USERS": "" for p in PLATFORMS},  # adapter-level filter off; bridge decides
    "SLACK_REQUIRE_MENTION":"true", "DISCORD_REQUIRE_MENTION":"true", "SIGNAL_REQUIRE_MENTION":"true", "WHATSAPP_REQUIRE_MENTION":"true",
    "WHATSAPP_MODE":"bot", "WHATSAPP_GROUP_POLICY":"open", "WHATSAPP_DM_POLICY":"pairing", "EMAIL_TRUST_FROM_HEADER":"false",
    "TELEGRAM_REQUIRE_MENTION": "true", "DINGTALK_REQUIRE_MENTION": "true", "FEISHU_REQUIRE_MENTION": "true",
    "FEISHU_GROUP_POLICY": "open", "WECOM_DM_POLICY": "open", "WECOM_GROUP_POLICY": "open",
}
REF_RE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$")


class ChannelError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


def _platform(args: dict) -> str:
    name = str(args.get("platform") or "")
    if name not in PLATFORMS:
        raise ChannelError(400, f"不支持的渠道：{name or '（空）'}")
    return name


def _channels() -> dict[str, dict]:
    from hermes_cli.config import read_raw_config
    data = (read_raw_config() or {}).get("yaovi_channels") or {}
    return {k: v for k, v in data.items() if k in PLATFORMS and isinstance(v, dict)} if isinstance(data, dict) else {}


def _save_channels(channels: dict[str, dict]) -> None:
    from hermes_cli.config import read_raw_config, save_config
    cfg = read_raw_config() or {}
    if channels:
        cfg["yaovi_channels"] = channels
    else:
        cfg.pop("yaovi_channels", None)
    save_config(cfg)


def _env() -> dict[str, str]:
    from hermes_cli.config import load_env
    try:
        return load_env() or {}
    except Exception:
        return {}


def _store():
    from gateway.pairing import PairingStore
    return PairingStore()


def _approved_sorted(name: str) -> list[dict]:
    """Approved users for *name*, earliest grant first (missing approved_at last)."""
    return sorted(
        _store().list_approved(name),
        key=lambda a: (a.get("approved_at") is None, float(a["approved_at"]) if isinstance(a.get("approved_at"), (int, float)) else 0),
    )


def _trim_approved(name: str) -> list[dict]:
    """Keep at most one approved identity per platform (the earliest); revoke extras."""
    approved = _approved_sorted(name)
    if len(approved) <= 1:
        return approved
    keep, store = approved[0], _store()
    for extra in approved[1:]:
        store.revoke(name, str(extra.get("user_id")))
    return [keep]


def _summary(name: str, cfg: dict | None, env: dict[str, str]) -> dict:
    cfg = cfg or {}
    creds = cfg.get("credentials") if isinstance(cfg.get("credentials"), dict) else {}
    fields = []
    for f in PLATFORMS[name]["fields"]:
        ref = creds.get(f["key"]) if isinstance(creds.get(f["key"]), str) else ""
        m = REF_RE.match(ref or "")
        value = env.get(m.group(1)) if m else None
        fields.append({**f, "configured": bool(value), "value": None if f["secret"] or not value else value})
    store = _store()
    return {
        "platform": name, "label": PLATFORMS[name]["label"], "configured": bool(cfg),
        "enabled": bool(cfg.get("enabled")), "fields": fields,
        "ready": bool(cfg) and all(x["configured"] for x in fields if x["required"]) and preparation(name)["ready"],
        "preparation": preparation(name),
        "home_channel": cfg.get("home_channel") or "", "home_channel_name": cfg.get("home_channel_name") or "",
        "pending": [{"code": p.get("code"), "user_id": p.get("user_id"), "user_name": p.get("user_name") or "",
                     "age_minutes": p.get("age_minutes")} for p in store.list_pending(name)] if cfg else [],
        "approved": [{"user_id": a.get("user_id"), "user_name": a.get("user_name") or ""}
                     for a in (_trim_approved(name) if cfg else [])],
    }


def op_list(args: dict) -> dict:
    channels, env = _channels(), _env()
    return {"platforms": [_summary(n, channels.get(n), env) for n in PLATFORMS]}


def op_enabled(args: dict) -> dict:
    """Platforms the bridge should start (enabled and fully configured)."""
    return {"platforms": [s["platform"] for s in op_list({})["platforms"] if s["enabled"] and s["ready"]]}


def op_upsert(args: dict) -> dict:
    from hermes_cli.config import save_env_value, remove_env_value
    name = _platform(args)
    if name=='whatsapp' and args.get('enabled') is False:
        from hermes_pairing import manager
        from hermes_constants import get_hermes_home
        manager.invalidate_home(get_hermes_home())
    channels = _channels()
    previous = channels.get(name) or {}
    prev_creds = previous.get("credentials") if isinstance(previous.get("credentials"), dict) else {}
    incoming = args.get("credentials") or {}
    if not isinstance(incoming, dict):
        raise ChannelError(400, "credentials 必须是对象")
    creds: dict[str, str] = {}
    for f in PLATFORMS[name]["fields"]:
        key, value = f["key"], incoming.get(f["key"], True if f["key"] in prev_creds else None)
        if value is True and key in prev_creds:  # keep stored value
            creds[key] = prev_creds[key]
        elif isinstance(value, str) and value.strip():
            if len(value) > 4000 or "\n" in value:
                raise ChannelError(400, f"{f['label']} 的值无效")
            save_env_value(key, value.strip())
            creds[key] = "${" + key + "}"
        elif value in (None, "", False):
            if f["required"]:
                raise ChannelError(400, f"缺少 {f['label']}")
            if key in prev_creds:
                remove_env_value(key)
        else:
            raise ChannelError(400, f"{f['label']} 的值无效")
    entry: dict[str, Any] = {"enabled": bool(args.get("enabled", previous.get("enabled", True))), "credentials": creds}
    home = str(args.get("home_channel", previous.get("home_channel") or "") or "").strip()
    if len(home) > 256 or "\n" in home:
        raise ChannelError(400, "主频道 ID 无效")
    if home:
        entry["home_channel"] = home
        entry["home_channel_name"] = str(args.get("home_channel_name", previous.get("home_channel_name") or "") or "")[:128]
        save_env_value(HOME_ENV[name], home)
    elif previous.get("home_channel"):
        remove_env_value(HOME_ENV[name])
    channels[name] = entry
    _save_channels(channels)
    return _summary(name, entry, _env())


def op_set_enabled(args: dict) -> dict:
    name = _platform(args)
    channels = _channels()
    if name not in channels:
        raise ChannelError(404, "该渠道尚未配置")
    if name=='whatsapp' and not args.get('enabled'):
        from hermes_pairing import manager
        from hermes_constants import get_hermes_home
        manager.invalidate_home(get_hermes_home())
    channels[name]["enabled"] = bool(args.get("enabled"))
    _save_channels(channels)
    return _summary(name, channels[name], _env())


def op_remove(args: dict) -> dict:
    from hermes_cli.config import remove_env_value
    name = _platform(args)
    channels = _channels()
    if name=='whatsapp':
        from hermes_pairing import manager
        from hermes_constants import get_hermes_home
        manager.invalidate_home(get_hermes_home())
    entry = channels.pop(name, None)
    if entry is None:
        raise ChannelError(404, "该渠道尚未配置")
    for key in list((entry.get("credentials") or {}).keys()) + [HOME_ENV[name]]:
        remove_env_value(key)
    store = _store()
    for a in store.list_approved(name):
        store.revoke(name, str(a.get("user_id")))
    store.clear_pending(name)
    if name=='whatsapp':
        from hermes_constants import get_hermes_dir
        session=get_hermes_dir('platforms/whatsapp/session','whatsapp/session')
        if session.exists():
            backup=session.parent/'session-backups'/str(time.time_ns());backup.parent.mkdir(parents=True,exist_ok=True,mode=0o700);os.replace(session,backup)
    _save_channels(channels)
    return {"ok": True}


def op_pairing_approve(args: dict) -> dict:
    name = _platform(args)
    if name not in _channels():
        raise ChannelError(404, "该渠道尚未配置")
    code = str(args.get("code") or "").strip().upper()
    if not code:
        raise ChannelError(400, "请输入配对码")
    existing = _trim_approved(name)
    if existing:
        who = existing[0].get("user_name") or existing[0].get("user_id") or ""
        raise ChannelError(
            409,
            f"每个渠道只能授权一位用户（当前为 {who}）。请先取消其授权，再批准新的配对码。",
        )
    result = _store().approve_code(name, code)
    if not result:
        raise ChannelError(404, "配对码无效或已过期")
    _trim_approved(name)  # defend against concurrent grants
    return {"user_id": result.get("user_id"), "user_name": result.get("user_name") or ""}


def op_pairing_revoke(args: dict) -> dict:
    name = _platform(args)
    user = str(args.get("user_id") or "")
    if not _store().revoke(name, user):
        raise ChannelError(404, "未找到该授权用户")
    return {"ok": True}


def op_test(args: dict) -> dict:
    """Connect the configured adapter once and disconnect (verifies credentials)."""
    name = _platform(args)
    if name not in _channels():
        raise ChannelError(404, "该渠道尚未配置")
    _apply_env()
    try:
        adapter = _create_adapter(name)
    except ChannelError:
        raise
    except Exception as e:
        raise ChannelError(400, f"渠道初始化失败：{e}")

    if name=='email' and not os.environ.get('YAOVI_HERMES_TEST_CHANNEL_ADAPTER'):
        import imaplib,smtplib
        imap=None;smtp=None
        try:
            imap=imaplib.IMAP4_SSL(adapter._imap_host,adapter._imap_port,ssl_context=ssl.create_default_context(),timeout=15)
            imap.login(adapter._address,adapter._password);imap.noop()
            smtp=smtplib.SMTP(adapter._smtp_host,adapter._smtp_port,timeout=15);smtp.starttls(context=ssl.create_default_context());smtp.login(adapter._address,adapter._password);smtp.noop()
            return {'ok':True}
        except Exception: return {'ok':False,'error':'邮件服务器认证失败，请检查TLS地址和应用密码。'}
        finally:
            if imap:
                try:imap.logout()
                except Exception:pass
            if smtp:
                try:smtp.quit()
                except Exception:pass

    async def probe():
        try:
            ok = await asyncio.wait_for(adapter.connect(), timeout=float(args.get("timeout") or 20))
        finally:
            try:
                await asyncio.wait_for(adapter.disconnect(), timeout=10)
            except Exception:
                pass
        return ok
    try:
        ok = asyncio.run(probe())
    except asyncio.TimeoutError:
        return {"ok": False, "error": "连接超时"}
    except Exception as e:
        return {"ok": False, "error": str(e)[:500] or type(e).__name__}
    return {"ok": ok is not False, "error": None if ok is not False else "连接失败，请检查凭据"}


# ---------------------------------------------------------------- adapters

def _apply_env() -> None:
    """Load this Bot's .env only (no system-layer channel credentials) and force hardening."""
    from hermes_cli.config import get_hermes_home
    for p in PLATFORMS:
        for f in PLATFORMS[p]["fields"]:
            os.environ.pop(f["key"], None)
    env_file = Path(get_hermes_home()) / ".env"
    if env_file.exists():
        from dotenv import dotenv_values
        for k, v in dotenv_values(env_file).items():
            if v is not None:
                os.environ[k] = v
    os.environ.update(FORCED_ENV)


def _create_adapter(name: str):
    if os.environ.get("YAOVI_HERMES_TEST_OFFLINE") and os.environ.get("YAOVI_HERMES_TEST_CHANNEL_ADAPTER"):
        import importlib
        mod, _, attr = os.environ["YAOVI_HERMES_TEST_CHANNEL_ADAPTER"].partition(":")
        sys.path.insert(0, str(Path(mod).parent)) if "/" in mod else None
        factory = getattr(importlib.import_module(Path(mod).stem if "/" in mod else mod), attr)
        return factory(name)
    from hermes_cli.plugins import discover_plugins
    from gateway.config import Platform, PlatformConfig, load_gateway_config
    from gateway.platform_registry import platform_registry
    discover_plugins()
    cfg = load_gateway_config()
    pconfig = cfg.platforms.get(Platform(name)) or PlatformConfig(enabled=True)
    pconfig.enabled = True
    pconfig.extra = {**(pconfig.extra or {}), "require_mention": True}
    if name=='email':pconfig.extra.update({'unauthorized_dm_behavior':'pair','require_authenticated_sender':True})
    if name=='signal':
        pconfig.extra.update({'group_allowed_users':['*'],'require_mention':True})
        os.environ['SIGNAL_GROUP_ALLOWED_USERS']='*'
    if name=='whatsapp':
        pconfig.extra['bridge_script']=str(_whatsapp_bridge_directory()/'bridge.js')
        prep=preparation(name)
        if not prep['ready']:raise ChannelError(409,'、'.join(prep['missing']))
    if name=='signal':
        from plugins.platforms.signal.adapter import SignalAdapter,validate_signal_config
        adapter=SignalAdapter(pconfig) if validate_signal_config(pconfig) else None
    else:adapter = platform_registry.create_adapter(name, pconfig)
    if adapter is None:
        raise ChannelError(400, f"{PLATFORMS[name]['label']} 适配器无法创建（凭据缺失或依赖不可用）")
    if name=='signal':
        def mention(text,data):
            account=adapter._account_normalized;identities={v for v in [account,adapter._recipient_uuid_by_number.get(account)] if v}
            matched=any(str(m.get(k,'')) in identities for m in data.get('mentions',[]) for k in ('number','uuid')) or any(re.search(r'(?<![\w+])@'+re.escape(v)+r'(?![\w+])',text or '') for v in identities)
            if not matched:return False,text
            for v in identities:text=re.sub(r'(?<![\w+])@'+re.escape(v)+r'(?![\w+])','',text or '')
            return True,text.strip()
        adapter._apply_group_mention_rules=mention
    if name=='whatsapp':
        adapter._runtime_status_platform_key='yaovi:'+str(Path(os.environ['HERMES_HOME']).resolve())
        def checked_deps(_directory):
            prep=preparation(name)
            if not prep['ready']:raise ChannelError(409,'、'.join(prep['missing']))
            return True
        adapter._ensure_bridge_deps=checked_deps
    return adapter


# ---------------------------------------------------------------- bridge

PAIRING_TEXT = ("你好！我还不认识你。配对码：{code}\n"
                "请让 Bot 所有者在 Yaovi 中打开该 Bot 的设置 → 渠道，输入此配对码完成授权（1 小时内有效）。")


class Bridge:
    def __init__(self, wire):
        self.wire = wire
        self.lock = threading.Lock()
        self.adapters: dict[str, Any] = {}
        self.loop: asyncio.AbstractEventLoop | None = None
        self.stopping = asyncio.Event()
        self.send_locks = {}

    def emit(self, frame: dict) -> None:
        with self.lock:
            self.wire.write(json.dumps(frame, ensure_ascii=False) + "\n")
            self.wire.flush()

    def authorized(self, platform: str, user_id: str | None) -> bool:
        return bool(user_id) and _store().is_approved(platform, str(user_id))

    async def on_event(self, platform: str, event: Any) -> None:
        src = getattr(event, "source", None)
        if src is None or getattr(src, "is_bot", False):
            return
        user_id = str(getattr(src, "user_id", "") or getattr(event, "user_id", "") or "")
        chat_type = str(getattr(src, "chat_type", "dm") or "dm")
        if platform=='slack' and isinstance(getattr(event,'raw_message',None),dict) and event.raw_message.get('channel_type')=='mpim':chat_type='group'
        chat_id = str(getattr(src, "chat_id", "") or "")
        user_name = str(getattr(src, "user_name", "") or getattr(event, "user_name", "") or "")
        adapter=self.adapters.get(platform)
        if chat_type!='dm' and adapter:
            raw=getattr(event,'raw_message',None)
            if platform=='slack':
                from plugins.platforms.slack.adapter import _slack_mention_detection_text
                ids={u for u in [getattr(adapter,'_bot_user_id',None),*getattr(adapter,'_team_bot_user_ids',{}).values()] if u}
                if not isinstance(raw,dict) or not adapter._slack_message_mentions_self(_slack_mention_detection_text(raw),ids):return
            elif platform=='discord':
                if raw is None or not adapter._self_is_explicitly_mentioned(raw):return
            elif platform=='whatsapp':
                if not isinstance(raw,dict) or not ({adapter._normalize_whatsapp_id(v) for v in raw.get('mentionedIds',[])} & adapter._bot_ids_from_message(raw)):return
        if not self.authorized(platform, user_id):
            if chat_type == "dm" and user_id:
                code = _store().generate_code(platform, user_id, user_name)
                if code:
                    self.emit({"type": "pairing", "platform": platform, "userId": user_id, "userName": user_name})
                    if platform=='email':
                        await self.send({'platform':platform,'chatId':chat_id,'text':PAIRING_TEXT.format(code=code),'emailContext':copy.deepcopy(getattr(adapter,'_thread_context',{}).get(chat_id,{}))})
                    else:await self.adapters[platform].send(chat_id, PAIRING_TEXT.format(code=code))
            return  # groups: unknown senders are ignored
        thread = str(getattr(src, "thread_id", "") or "")
        key = ":".join([platform, chat_type, chat_id] + ([thread] if thread else []))
        media=[]
        from hermes_constants import get_hermes_home
        home=Path(get_hermes_home()).resolve()
        for i,value in enumerate(getattr(event,'media_urls',[]) or []):
            raw=str(value);raw=raw[7:] if raw.startswith('file://') else raw
            path=Path(raw)
            if not path.is_absolute() or not path.exists() or path.is_symlink():continue
            resolved=path.resolve()
            if not any(resolved.is_relative_to(home/p) for p in ['cache','image_cache','audio_cache','video_cache','document_cache']):continue
            if not resolved.is_file() or resolved.stat().st_size>25*1024*1024:continue
            types=getattr(event,'media_types',[]) or []
            media.append({'relativePath':resolved.relative_to(home).as_posix(),'name':resolved.name,'mimeType':types[i] if i<len(types) else 'application/octet-stream'})
        email_context=copy.deepcopy(getattr(self.adapters.get(platform),'_thread_context',{}).get(chat_id)) if platform=='email' else None
        self.emit({"type": "inbound", "platform": platform, "sessionKey": key, "chatId": chat_id, "chatType": chat_type,
                   "chatName": str(getattr(src, "chat_name", "") or ""), "threadId": thread or None,
                   "userId": user_id, "userName": user_name, "text": str(getattr(event, "text", "") or ""),
                   "messageId": str(getattr(event, "message_id", "") or "") or None, "media":media, "emailContext":email_context})

    def install(self, platform: str, adapter: Any) -> None:
        async def handle_message(event):  # replaces the runner path: no agent runs here
            try:
                await self.on_event(platform, event)
            except Exception as e:
                self.emit({"type": "status", "platform": platform, "state": "warning", "error": str(e)[:300]})

        async def noop_handler(event):
            return None
        adapter.set_message_handler(noop_handler)
        adapter.handle_message = handle_message
        adapter.set_authorization_check(lambda uid, ct=None, cid=None, **k: self.authorized(platform, uid))
        # Native early gates otherwise drop the first DM before Yaovi can issue a pairing code.
        # Only the final on_event boundary may dispatch to the Agent.
        if platform=='slack':
            adapter._early_reject_unauthorized=lambda uid,cid,is_dm: not (is_dm or self.authorized(platform,uid))
        if platform=='discord':
            adapter._is_allowed_user=lambda uid,author=None,*,guild=None,is_dm=False,channel_ids=None: bool(is_dm or self.authorized(platform,uid))

    async def send(self, args: dict) -> dict:
        platform = str(args.get("platform") or "")
        adapter = self.adapters.get(platform)
        if adapter is None:
            raise ChannelError(404, f"渠道 {platform} 未连接")
        text = str(args.get("text") or "")
        if not text.strip():
            return {"ok": True, "skipped": True}
        metadata = {"thread_id": args["threadId"]} if args.get("threadId") else None
        kw: dict[str, Any] = {"reply_to": args.get("replyTo") or None}
        if metadata:
            kw["metadata"] = metadata
        async with self.send_locks.setdefault(platform,asyncio.Lock()):
            if platform=='email' and isinstance(args.get('emailContext'),dict):
                adapter._thread_context[str(args.get('chatId') or '')]={k:str(v)[:1000] for k,v in args['emailContext'].items() if k in ('subject','message_id')}
            if platform=='email':
                # Build MIME before yielding: inbound mail may replace thread context meanwhile.
                msg,msg_id,_subject=adapter._new_reply(str(args.get('chatId') or ''),text,args.get('replyTo'))
                await asyncio.to_thread(adapter._smtp_send,msg)
                return {'ok':True,'messageId':msg_id}
            result = await adapter.send(str(args.get("chatId") or ""), text, **kw)
        ok = getattr(result, "success", True)
        if ok is False:
            raise ChannelError(502, str(getattr(result, "error", "") or "发送失败"))
        return {"ok": True, "messageId": getattr(result, "message_id", None)}

    async def command(self, msg: dict) -> None:
        rid, op = msg.get("id"), msg.get("op")
        try:
            if op == "send":
                result = await self.send(msg.get("args") or {})
            elif op == "status":
                result = {"platforms": list(self.adapters)}
            elif op == "stop":
                self.stopping.set()
                result = {"ok": True}
            else:
                raise ChannelError(400, f"unknown op {op}")
            self.emit({"id": rid, "ok": True, "result": result})
        except Exception as e:
            self.emit({"id": rid, "ok": False, "status": getattr(e, "status", 500), "error": str(e)[:500] or type(e).__name__})

    def read_stdin(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            asyncio.run_coroutine_threadsafe(self.command(msg), self.loop)
        self.loop.call_soon_threadsafe(self.stopping.set)

    async def connect(self, platform: str) -> None:
        delay=5
        while not self.stopping.is_set():
            adapter=None;fatal=asyncio.Event()
            try:
                adapter=_create_adapter(platform);self.install(platform,adapter)
                if hasattr(adapter,'set_fatal_error_handler'):
                    adapter.set_fatal_error_handler(lambda _adapter,event=fatal: self.loop.call_soon_threadsafe(event.set))
                ok=await asyncio.wait_for(adapter.connect(),timeout=60)
                if ok is False:raise ChannelError(502,'连接失败，请检查凭据')
                self.adapters[platform]=adapter
                self.emit({'type':'status','platform':platform,'state':'connected'});delay=5
                stopped=asyncio.create_task(self.stopping.wait());failed=asyncio.create_task(fatal.wait())
                try:await asyncio.wait([stopped,failed],return_when=asyncio.FIRST_COMPLETED)
                finally:
                    stopped.cancel();failed.cancel()
                if self.stopping.is_set():return
                raise ChannelError(502,str(getattr(adapter,'fatal_error_message',None) or '渠道连接中断'))
            except asyncio.CancelledError:raise
            except Exception as e:
                self.emit({'type':'status','platform':platform,'state':'error','error':str(e)[:300]})
                if adapter is not None and getattr(adapter,'fatal_error_retryable',True) is False:return
            finally:
                if self.adapters.get(platform) is adapter:self.adapters.pop(platform,None)
                if adapter is not None:
                    try:await asyncio.wait_for(adapter.disconnect(),timeout=10)
                    except Exception:pass
            try:await asyncio.wait_for(self.stopping.wait(),timeout=delay)
            except asyncio.TimeoutError:pass
            delay=min(delay*2,300)

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        _apply_env()
        platforms = op_enabled({})["platforms"]
        self.emit({"type": "ready", "platforms": platforms})
        threading.Thread(target=self.read_stdin, daemon=True).start()
        tasks = [asyncio.create_task(self.connect(p)) for p in platforms]
        await self.stopping.wait()
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks,return_exceptions=True)
        for adapter in list(self.adapters.values()):
            try:
                await asyncio.wait_for(adapter.disconnect(), timeout=10)
            except Exception:
                pass


def main() -> None:
    os.environ.setdefault("HERMES_SKIP_UPDATE_CHECK", "1")
    os.environ["HERMES_PYTHON_SRC_ROOT"] = str(ROOT / "hermes")
    wire = os.fdopen(os.dup(1), "w", buffering=1, encoding="utf-8")  # Hermes may rebind stdout
    sys.stdout = sys.stderr
    import hermes_service
    hermes_service._bootstrap()  # same offline test guard as the service bridge
    asyncio.run(Bridge(wire).run())




# Setup operations are imported by the service, never by the bridge's stdin runner.
def _whatsapp_bridge_directory():
    from hermes_constants import get_hermes_home
    return Path(get_hermes_home())/'channel-tools/whatsapp-bridge'


def _bridge_digest(directory):
    files=sorted([*directory.glob('*.js'),directory/'package.json',directory/'package-lock.json'])
    return hashlib.sha256(b''.join(p.name.encode()+b'\0'+p.read_bytes() for p in files if p.is_file())).hexdigest()


def op_prepare(args):
    name=_platform(args)
    if name!='whatsapp':return preparation(name)
    import subprocess
    from hermes_files import _file_lock
    npm=shutil.which('npm');node=shutil.which('node')
    if not npm or not node:raise ChannelError(409,'请先在Host准备Node.js和npm；不会自动安装运行时')
    source=ROOT/'hermes/scripts/whatsapp-bridge';target=_whatsapp_bridge_directory()
    with _file_lock(target.parent/'whatsapp-prepare.lock'):
        target.mkdir(parents=True,exist_ok=True)
        for filename in [p.name for p in source.glob('*.js')]+['package.json','package-lock.json']:
            shutil.copyfile(source/filename,target/filename)
        subprocess.run([npm,'ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],cwd=target,check=True,capture_output=True,timeout=240)
        (target/'node_modules/.hermes-pkg-hash').write_text(hashlib.sha256((target/'package.json').read_bytes()).hexdigest()[:16])
        (target/'.yaovi-source-hash').write_text(_bridge_digest(source))
    return preparation(name)


def op_whatsapp_start(args):
    from hermes_pairing import manager
    from hermes_constants import get_hermes_home,get_hermes_dir
    if _channels().get('whatsapp',{}).get('enabled'):raise ChannelError(409,'请先停用WhatsApp渠道再关联，避免会话冲突。')
    prep=preparation('whatsapp');missing=[v for v in prep['missing'] if v!='WhatsApp 扫码关联']
    if missing:raise ChannelError(409,'、'.join(missing))
    return manager.start(get_hermes_home(),_whatsapp_bridge_directory(),get_hermes_dir('platforms/whatsapp/session','whatsapp/session'),args.get('reset',False))


def op_whatsapp_apply(args):
    from hermes_pairing import manager
    from hermes_constants import get_hermes_home
    try:return manager.apply(args['id'],get_hermes_home(),lambda:op_upsert({'platform':'whatsapp','enabled':True,'credentials':{}}))
    except ValueError as e:raise ChannelError(409,str(e)) from None


def op_whatsapp_status(args):
    from hermes_pairing import manager
    from hermes_constants import get_hermes_home
    return manager.get(args['id'],get_hermes_home())


def op_whatsapp_cancel(args):
    from hermes_pairing import manager
    from hermes_constants import get_hermes_home
    return manager.cancel(args['id'],get_hermes_home())


if __name__ == "__main__":
    main()
