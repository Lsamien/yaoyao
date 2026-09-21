"""Read-only Bot model catalogue and runtime resolution. Never writes Profile config."""
from contextlib import contextmanager
import re


class ModelSettingsError(Exception):
    pass


@contextmanager
def profile_scope(profile):
    from hermes_cli.profiles import get_profile_dir, profile_exists
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    if not isinstance(profile, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", profile) or not profile_exists(profile):
        raise ModelSettingsError("基础机器人不存在")
    token = set_hermes_home_override(get_profile_dir(profile))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def defaults(ctx, config):
    agent = config.get("agent") or {}
    effort = agent.get("reasoning_effort", "medium")
    tier = agent.get("service_tier") or "normal"
    return {"provider": ctx.current_provider, "model": ctx.current_model,
            "reasoningEffort": "none" if effort is False else str(effort or "medium"),
            "fastMode": {"priority": "fast"}.get(tier, tier)}


def route_url(ctx, provider):
    if provider == ctx.current_provider:
        return ctx.current_base_url
    entry = (ctx.user_providers or {}).get(provider)
    if isinstance(entry, dict):
        return str(entry.get("base_url") or "")
    for entry in ctx.custom_providers or []:
        if provider in (entry.get("name"), entry.get("id")):
            return str(entry.get("base_url") or "")
    return ""


def capability(provider, model, base_url="", hint=None):
    from hermes_constants import VALID_REASONING_EFFORTS
    from hermes_cli.models import resolve_fast_mode_overrides
    hint = hint or {}
    known = hint.get("reasoning") is False
    reasoning = hint.get("reasoning", True)
    try:
        from agent.models_dev import get_model_capabilities
        meta = get_model_capabilities(provider, model)
        if meta is not None:
            known = not meta.supports_reasoning or known
            reasoning = bool(meta.supports_reasoning) and reasoning
    except Exception:
        pass
    efforts = (["none"] if hint.get("can_disable_reasoning", True) else []) + list(VALID_REASONING_EFFORTS) if reasoning else []
    if provider == "copilot":
        from hermes_cli.models import github_model_reasoning_efforts
        declared = github_model_reasoning_efforts(model)
        if declared:
            efforts, known = list(declared), True
    fast = resolve_fast_mode_overrides(model, provider=provider, base_url=base_url) is not None
    return {"provider": provider, "model": model, "name": model,
            "reasoningEfforts": efforts, "reasoningKnown": known,
            "fastModes": ["normal", "fast", "auto", "cold"] if fast else ["normal"]}


def options(profile):
    from hermes_cli.config import load_config
    from hermes_cli.inventory import load_picker_context, build_model_options_payload
    with profile_scope(profile):
        ctx = load_picker_context()
        payload = build_model_options_payload(ctx, explicit_only=True)
        rows = []
        for provider in payload.get("providers", []):
            slug = provider["slug"]
            for model in provider.get("models", []):
                if isinstance(model, str):
                    rows.append(capability(slug, model, route_url(ctx, slug), (provider.get("capabilities") or {}).get(model)))
        return {"version": 1, "defaults": defaults(ctx, load_config()), "models": rows}


def resolve(profile, settings):
    from hermes_cli.config import load_config
    from hermes_cli.inventory import load_picker_context, _reasoning_catalog_reader
    from hermes_cli.model_switch import switch_model
    from hermes_cli.model_selection_guards import combined_selection_warning
    from hermes_constants import parse_reasoning_effort
    if settings is None:
        settings = {}
    if not isinstance(settings, dict) or set(settings) - {"provider", "model", "reasoningEffort", "fastMode"}:
        raise ModelSettingsError("模型配置格式无效")
    with profile_scope(profile):
        ctx, config = load_picker_context(), load_config()
        value = defaults(ctx, config)
        value.update({key: item for key, item in settings.items() if item is not None})
        if bool(settings.get("provider")) != bool(settings.get("model")):
            raise ModelSettingsError("模型与 Provider 必须一起选择")
        for key in ("model", "provider"):
            item = value[key]
            if not isinstance(item, str) or not item or len(item) > 512 or re.search(r"[\s\"'\\]", item) or item.startswith("-"):
                raise ModelSettingsError("基础机器人尚未配置有效的模型与 Provider")
        model_config = config.get("model") or {}
        current_key = model_config.get("api_key", "") if isinstance(model_config, dict) else ""
        result = switch_model(raw_input=value["model"], current_provider=ctx.current_provider,
                              current_model=ctx.current_model, current_base_url=ctx.current_base_url,
                              current_api_key=current_key, is_global=False, explicit_provider=value["provider"],
                              user_providers=ctx.user_providers, custom_providers=ctx.custom_providers)
        if not result.success:
            # Provider errors may include secrets/URLs; keep this boundary deliberately generic.
            raise ModelSettingsError("所选模型或 Provider 当前不可用，请检查基础机器人的模型服务")
        value.update(provider=result.target_provider, model=result.new_model)
        hint = {}
        reader = _reasoning_catalog_reader(result.target_provider)
        detail = reader(result.new_model) if reader else None
        if detail:
            hint = {"reasoning": detail.get("supports_reasoning", True), "can_disable_reasoning": not detail.get("mandatory")}
        caps = capability(value["provider"], value["model"], result.base_url or route_url(ctx, value["provider"]), hint)
        if not isinstance(value["reasoningEffort"], str) or parse_reasoning_effort(value["reasoningEffort"]) is None:
            raise ModelSettingsError("思考等级无效")
        if settings.get("reasoningEffort") is not None and value["reasoningEffort"] not in caps["reasoningEfforts"]:
            raise ModelSettingsError("该模型不支持所选思考等级，请重新选择或继承基础机器人")
        if value["fastMode"] not in caps["fastModes"]:
            raise ModelSettingsError("该模型或 Provider 不支持所选速度，请重新选择普通速度")
        warning = combined_selection_warning(value["model"], provider=value["provider"],
                                             base_url=result.base_url, api_key=result.api_key, model_info=result.model_info)
        return {"version": 1, "effective": value, "confirmationMessage": warning.message if warning else None}
