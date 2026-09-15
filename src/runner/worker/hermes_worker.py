"""Hermes model loop with a closed, parent-owned tool dispatcher.

Credentials and this process remain on the Runner. Tools operate through the
parent's leased computer; no model-selected native Hermes handler is invoked.
Only private stdin/stdout carry protocol frames. Ordinary logging uses stderr.
"""
from __future__ import annotations
import contextlib
import copy
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import uuid

WIRE = sys.stdout
WRITE_LOCK = threading.Lock()
BOOT = json.loads(sys.stdin.readline())
NONCE = BOOT["nonce"]
PROXY_ENV_KEYS = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                  "http_proxy", "https_proxy", "all_proxy", "no_proxy")

# Only context-management settings cross the Profile boundary. Plugins, tools,
# arbitrary environment variables and unrelated credentials remain excluded.
COMPRESSION_KEYS = {
    "enabled", "threshold", "threshold_tokens", "target_ratio",
    "protect_first_n", "protect_last_n", "min_tail_user_messages", "tail_mode",
    "max_attempts", "abort_on_summary_failure", "in_place", "checkpoint_required",
    "codex_gpt55_autoraise", "codex_gpt55_autoraise_notice",
    "codex_responses_native", "codex_responses_compact_threshold",
    "proactive_prune_tokens", "proactive_prune_min_result_chars",
    "proactive_prune_min_reclaim_tokens", "micro_compact",
    "micro_compact_every_n_turns", "micro_compact_defrag_threshold_tokens",
    "idle_compact_after_seconds", "context_timeout_seconds", "context_total_ceiling_seconds",
}

def context_configuration(config):
    raw = config.get("compression", {})
    if not isinstance(raw, dict):
        raw = {}
    compression = {key: value for key, value in raw.items()
                   if key in COMPRESSION_KEYS
                   and isinstance(value, (str, bool, int, float))
                   and (not isinstance(value, float) or math.isfinite(value))}
    thresholds = raw.get("model_thresholds")
    if isinstance(thresholds, dict):
        compression["model_thresholds"] = {
            key: value for key, value in thresholds.items()
            if isinstance(key, str) and isinstance(value, (int, float))
            and not isinstance(value, bool) and math.isfinite(value) and 0 < value <= 1
        }
    model = config.get("model", {})
    limits = {key: model[key] for key in ("context_length", "max_tokens")
              if isinstance(model, dict) and isinstance(model.get(key), int)
              and not isinstance(model[key], bool) and model[key] > 0}
    return {"compression": compression, "model": limits}

def emit(kind, **values):
    with WRITE_LOCK:
        WIRE.write(json.dumps({"nonce": NONCE, "type": kind, **values}, ensure_ascii=False) + "\n")
        WIRE.flush()

class ConfigurationError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def load_profile():
    source = Path(BOOT["hermesSource"]).resolve()
    root = Path(BOOT["hermesHome"]).resolve()
    profile = BOOT["profile"]
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", profile):
        raise ConfigurationError("computer_profile_invalid")
    home = root if profile == "default" else root / "profiles" / profile
    if not (home / "config.yaml").is_file():
        raise ConfigurationError("computer_profile_missing")
    os.environ["HERMES_HOME"] = str(home)
    sys.path.insert(0, str(source))
    from dotenv import dotenv_values
    profile_env = dotenv_values(home / ".env")
    for key, value in profile_env.items():
        if value is not None:
            os.environ[key] = value
    # Capture only this Profile's values, before Hermes imports can load any
    # fallback environment. Preserve case and explicit empty values for its SDK.
    proxy_env = {key: profile_env[key] for key in PROXY_ENV_KEYS
                 if isinstance(profile_env.get(key), str)}
    from hermes_constants import set_hermes_home_override
    set_hermes_home_override(str(home))
    from hermes_cli.config import load_config_readonly
    try:
        return load_config_readonly(), proxy_env
    except Exception:
        raise ConfigurationError("computer_profile_config_invalid") from None


def resolve_workspace(config):
    terminal = config.get("terminal", {})
    if not isinstance(terminal, dict):
        raise ConfigurationError("computer_cwd_invalid")
    raw = terminal.get("cwd")
    if raw is None or raw == "":
        raw = "."
    if not isinstance(raw, str) or not raw.strip() or len(raw) > 4096 or re.search(r"[\x00-\x1f\x7f]", raw):
        raise ConfigurationError("computer_cwd_invalid")
    configured = raw.strip()
    # Placeholders refer to the assigned Linux workspace, never the Web/App
    # release directory inherited by this host-side configuration reader.
    base = BOOT.get("defaultCwd", "/home/cua/workspace")
    path = "." if configured in (".", "auto", "cwd") else os.path.expanduser(configured)
    cwd = os.path.normpath(path if os.path.isabs(path) else os.path.join(base, path))
    if not os.path.isabs(path) and os.path.commonpath([base, cwd]) != base:
        raise ConfigurationError("computer_cwd_invalid")
    return {"cwd": cwd, "configuredCwd": configured}


def resolve_model():
    config, proxy_env = load_profile()
    workspace = resolve_workspace(config)
    model = config.get("model", {})
    if not isinstance(model, dict) or not model.get("default"):
        raise ConfigurationError("computer_model_missing")
    try:
        from hermes_cli.runtime_provider import resolve_runtime_provider
        runtime = resolve_runtime_provider(requested=model.get("provider"), explicit_api_key=model.get("api_key"), explicit_base_url=model.get("base_url"), target_model=model["default"])
    except Exception:
        raise ConfigurationError("computer_model_unavailable") from None
    if runtime.get("api_mode") not in ("chat_completions", "anthropic_messages", "codex_responses"):
        raise ConfigurationError("computer_model_unsupported")
    emit("resolved", model={key: runtime[key] for key in ("provider", "api_mode", "base_url", "api_key") if key in runtime} | {"model": model["default"]}, **workspace,
         contextConfig=context_configuration(config),
         **({"proxyEnv": proxy_env} if proxy_env else {}))


def run_model():
    home = Path(BOOT["home"]).resolve()
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chdir(home)
    os.environ["HOME"] = str(home)
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_CWD"] = str(home)
    sys.path.insert(0, str(Path(BOOT["hermesSource"]).resolve()))
    context_config = context_configuration(BOOT.get("contextConfig", {}))
    # JSON is a YAML subset. An absent compression setting uses Hermes' own
    # defaults, while an explicit Profile false remains false.
    (home / "config.yaml").write_text(json.dumps({
        "plugins": {"enabled": []}, **context_config,
        "model": {**context_config["model"], "default": BOOT["model"]["model"],
                  **{key: BOOT["model"][key] for key in ("provider", "base_url") if key in BOOT["model"]}},
    }), encoding="utf-8")
    (home / ".env").touch(mode=0o600)
    # Prevent the installed project's dotenv fallback from importing host secrets.
    import hermes_cli.env_loader as env_loader
    env_loader.load_hermes_dotenv = lambda *args, **kwargs: []
    import run_agent
    import model_tools
    supplied_tools = [{"type": "function", "function": {"name": item["name"], "description": item["description"], "parameters": item["inputSchema"]}} for item in BOOT["tools"]]
    # Hermes refreshes tools at compaction boundaries, including through
    # model_tools directly. Keep the parent-owned catalog on every rebuild;
    # neither drop the VM tools nor discover native handlers from the host.
    def closed_tool_definitions(*args, **kwargs):
        return copy.deepcopy(supplied_tools)
    run_agent.get_tool_definitions = closed_tool_definitions
    model_tools.get_tool_definitions = closed_tool_definitions
    pending = {}
    stopped = threading.Event()
    allowed = {item["name"] for item in BOOT["tools"]}

    class ClosedAgent(run_agent.AIAgent):
        def _compress_context(self, *args, **kwargs):
            result = super()._compress_context(*args, **kwargs)
            if not stopped.is_set() and isinstance(result, tuple) and result and isinstance(result[0], list):
                emit("checkpoint", messages=result[0])
            return result

        def _persist_session(self, messages, conversation_history=None):
            result = super()._persist_session(messages, conversation_history)
            if not stopped.is_set():
                emit("checkpoint", messages=messages)
            return result

        def _execute_tool_calls(self, assistant_message, messages, effective_task_id, api_call_count=0):
            # Intercept before Hermes' sequential, parallel and inline branches.
            # In particular message_agent/delegate_task must never reach native code.
            from agent.tool_dispatch_helpers import make_tool_result_message
            emit("checkpoint", messages=messages)
            for tool in assistant_message.tool_calls:
                name = tool.function.name
                try:
                    arguments = json.loads(tool.function.arguments)
                    if not isinstance(arguments, dict):
                        raise ValueError("arguments must be an object")
                    result = self._invoke_tool(name, arguments, effective_task_id, tool.id)
                except Exception:
                    result = json.dumps({"error": "Worker tool failed or was cancelled"})
                if isinstance(result, dict) and result.get("_multimodal"):
                    result = [{"type": "text", "text": result.get("text_summary", "")}, *result.get("content", [])]
                messages.append(make_tool_result_message(name, result, tool.id))
                emit("checkpoint", messages=messages)

        def _invoke_tool(self, function_name, function_args, effective_task_id, tool_call_id=None, **kwargs):
            if stopped.is_set() or function_name not in allowed:
                return json.dumps({"error": "This tool is not authorized for this worker"})
            call_id = str(uuid.uuid4())
            event = threading.Event()
            slot = {"event": event}
            pending[call_id] = slot
            emit("tool", id=call_id, callId=tool_call_id, name=function_name, arguments=function_args)
            try:
                if not event.wait(90) or stopped.is_set():
                    stopped.set()
                    emit("failed", message="Worker 工具调用已超时或停止")
                    self.interrupt()
                    raise RuntimeError("worker tool cancelled or timed out")
                result = slot.get("result", {"error": "No tool response"})
                return result if isinstance(result, str) or (isinstance(result, dict) and result.get("_multimodal")) else json.dumps(result, ensure_ascii=False)
            finally:
                pending.pop(call_id, None)

    from tools.registry import registry
    def no_native_dispatch(*args, **kwargs):
        raise RuntimeError("closed worker requires parent dispatch")
    for item in BOOT["tools"]:
        registry.register(name=item["name"], toolset="yaoyao_computer", schema={"name": item["name"], "description": item["description"], "parameters": item["inputSchema"]}, handler=no_native_dispatch)

    model = BOOT["model"]
    if model.get("api_mode") not in ("chat_completions", "anthropic_messages", "codex_responses"):
        raise ValueError("unsupported worker provider")
    agent = ClosedAgent(**model, enabled_toolsets=[], disabled_toolsets=None, quiet_mode=True,
        save_trajectories=False, skip_context_files=True, skip_memory=True,
        skip_background_review=True, checkpoints_enabled=False, session_id=BOOT["sessionId"],
        max_iterations=32, run_budget_seconds=900,
        stream_delta_callback=lambda text, **kwargs: emit("delta", text=str(text)) if text is not None else None,
        reasoning_callback=lambda text, **kwargs: emit("reasoning", text=str(text)) if text is not None else None)
    agent.tools = closed_tool_definitions()
    agent.valid_tool_names = set(allowed)

    def receive():
        try:
            for line in sys.stdin:
                frame = json.loads(line)
                if frame.get("nonce") != NONCE:
                    continue
                if frame.get("type") == "result" and frame.get("id") in pending:
                    slot = pending[frame["id"]]
                    slot["result"] = frame.get("result")
                    slot["event"].set()
                elif frame.get("type") == "interrupt":
                    break
        finally:
            stopped.set()
            agent.interrupt()
            for slot in list(pending.values()):
                slot["event"].set()
    threading.Thread(target=receive, daemon=True).start()
    emit("ready", tools=sorted(allowed))
    environment = "Computer tools operate on your assigned isolated Linux computer, with working directory " + BOOT["cwd"] + ". Its network access follows the configured computer policy. "
    if BOOT.get("host"):
        environment += "The user also enabled host tools. host_* tools operate on the Runner host (" + BOOT["host"]["platform"] + "), with working directory " + BOOT["host"]["cwd"] + ". Use the appropriate OS syntax for each tool. computer_* tools operate in Linux; computer_copy_file explicitly copies between host and VM. These environments have separate files, processes and installed software. "
    else:
        environment += "Host files and commands are not available through computer tools. Never attempt to execute a host command through them. "
    result = agent.run_conversation(BOOT["prompt"], conversation_history=BOOT.get("history", []), task_id=BOOT["taskId"],
        system_message="You are a controlled Hermes worker. " + environment + "Other supplied application and team tools follow their descriptions. Use only supplied tools and follow the user's task and permission scope.\n" + str(BOOT.get("skillInstructions", "")))
    # These are engine result flags, never inferred from model-generated text.
    failure_code = ("context_compaction_disabled" if result.get("compaction_disabled") is True
                    else "context_compaction_failed" if result.get("compression_exhausted") is True
                    else None)
    interrupted = stopped.is_set() or result.get("interrupted") is True
    completed = result.get("completed", True) is not False and not result.get("failed") and failure_code is None and not interrupted
    emit("complete", text=str(result.get("final_response") or ""), messages=result.get("messages"),
         interrupted=interrupted, completed=completed,
         **({"failureCode": failure_code} if failure_code and not interrupted and not pending else {}))

try:
    with contextlib.redirect_stdout(sys.stderr):
        if BOOT.get("mode") == "skills":
            config, _ = load_profile()
            from profile_skills import ProfileSkills, SkillError
            def authorize_skill_commit():
                emit("tool", id="commit", name="skill_commit", arguments={})
                frame = json.loads(sys.stdin.readline())
                if frame.get("nonce") != NONCE or frame.get("type") != "result" or frame.get("id") != "commit" or frame.get("result") != {"authorized": True}:
                    raise SkillError("skill_cancelled", "技能发布授权已失效")
            try:
                profile_home = Path(BOOT["hermesHome"]).resolve()
                if BOOT["profile"] != "default":
                    profile_home = profile_home / "profiles" / BOOT["profile"]
                result = ProfileSkills(profile_home, config, BOOT["provenance"], authorize_skill_commit).call(BOOT["action"], BOOT.get("arguments", {}))
                emit("skills", result=result)
            except SkillError as error:
                emit("skills", result={"error": str(error), "code": error.code})
            except Exception:
                emit("skills", result={"error": "无法读取或发布技能，请检查 Profile 技能目录", "code": "skill_storage_error"})
        elif BOOT.get("mode") == "resolve-workspace":
            emit("resolved", **resolve_workspace(load_profile()[0]))
        elif BOOT.get("mode") == "resolve":
            resolve_model()
        else:
            run_model()
except BaseException as error:
    if BOOT.get("diagnostic"):
        import traceback
        traceback.print_exc(file=sys.stderr)
    # Never serialize SDK exception strings, request headers, or credentials.
    emit("failed", code=error.code if isinstance(error, ConfigurationError) else "computer_worker_failed")
    sys.exit(1)
