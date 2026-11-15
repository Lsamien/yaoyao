"""Private newline-delimited RPC worker for the embedded Yaovi kernel."""
import json
import os
from pathlib import Path
import queue
import signal
import re
import sys
import threading
import uuid

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "hermes"))
WIRE = sys.stdout
sys.stdout = sys.stderr
lock = threading.Lock()
pending = {}
agent = None
persistent_waits = False
# Guards steer acceptance against the end of the turn: after the final drain nothing can deliver it.
steer_lock = threading.Lock()
turn_closed = False
steer_ready = False
startup_steers = []
# Prefix of the per-turn application state Yaovi renders (src/server/workspacePrompt.ts).
TURN_CONTEXT_SENTINEL = "[[YAOVI_TURN_CONTEXT_V1]]"
# Control-plane RPCs whose replies are JSON values, never model-facing tool output.
CONTROL_TOOLS = ("yaovi_clarify", "yaovi_native_authorize", "yaovi_native_check",
                 "yaovi_skills_authorize", "yaovi_skills_load", "yaovi_skills_commit")


def emit(kind, **payload):
    with lock:
        WIRE.write(json.dumps({"type": kind, **payload}, ensure_ascii=False, default=str) + "\n")
        WIRE.flush()


def dispatch(name, args, **metadata):
    call_id = str(uuid.uuid4())
    from native_authorization import metadata as call_metadata
    metadata = call_metadata(**metadata)
    model_call_id = metadata.get("tool_call_id")
    reply = queue.Queue(maxsize=1)
    with lock:
        pending[call_id] = reply
    emit("tool.request", id=call_id, name=name, arguments=args,
         sessionId=metadata.get("session_id"), taskId=metadata.get("task_id"), modelCallId=model_call_id)
    try:
        value = reply.get() if persistent_waits else reply.get(timeout=600)
        if "error" in value:
            return json.dumps({"error": value["error"], "isError": True})
        result = value.get("result")
        if name not in CONTROL_TOOLS:
            # Yaoyao normalizes application tool results (text, or Hermes' native multimodal envelope).
            if isinstance(result, dict) and result.get("_multimodal") is True:
                return result
            if isinstance(result, str):
                return result
        from workspace_media import computer_result
        return computer_result(name, result)
    finally:
        with lock:
            pending.pop(call_id, None)


def interrupt():
    global turn_closed
    with steer_lock:
        turn_closed = True
    if agent is not None:
        agent.interrupt()
    # Release root and child RPC waits so cancellation does not wait for the
    # 600-second tool timeout. Product receipts retain uncertain side effects.
    with lock:
        targets = list(pending.values())
    for target in targets:
        try:
            target.put_nowait({"error": "Task cancelled. Inspect effects before retrying."})
        except queue.Full:
            pass


def read_replies():
    for line in sys.stdin:
        message = json.loads(line)
        if message.get("type") == "interrupt":
            interrupt()
            continue
        if message.get("type") == "steer":
            # Initialization is part of this turn too. Retain early input until
            # the agent exists; redirect owns admission through final reply commit.
            accepted = False
            phase = "closed"
            with steer_lock:
                text = str(message.get("text") or "").strip()
                if text and not turn_closed and not steer_ready:
                    startup_steers.append(text)
                    accepted, phase = True, "initializing"
                elif text and not turn_closed:
                    phase = ("tools" if getattr(agent, "_executing_tools", False) else
                             "model" if agent._model_request_active.is_set() else
                             "preparing" if agent._turn_redirect_open else "finishing")
                    try:
                        deliver = agent.steer if getattr(agent, "_executing_tools", False) else agent.redirect
                        accepted = bool(deliver(text))
                    except Exception:
                        phase = "delivery_error"
                        accepted = False
            emit("kernel.event", name="steer.admission", value={"accepted": accepted, "phase": phase})
            emit("steer.result", id=message.get("id"), accepted=accepted)
            continue
        with lock:
            target = pending.get(message.get("id"))
        if target is not None:
            try:
                target.put_nowait(message)
            except queue.Full:
                pass
    interrupt()


def strip_turn_context_sidecars(history):
    """Earlier turns replay their user content only, never the per-turn state sent with them."""
    for message in history:
        sidecar = message.get("api_content")
        if message.get("role") == "user" and isinstance(sidecar, str) and sidecar.startswith(TURN_CONTEXT_SENTINEL):
            message.pop("api_content", None)
    return history


def compose_turn(text, turn_context):
    """``(model-facing message, persisted message)``; state reaches this turn's calls only."""
    if not turn_context:
        return text, None
    if not str(turn_context).startswith(TURN_CONTEXT_SENTINEL):
        raise ValueError("Turn context is missing its sentinel")
    if isinstance(text, list):
        return [{"type": "text", "text": turn_context}, *text], text
    return turn_context + "\n\n" + str(text), text


def clarify(questions):
    answers = {}
    for question in questions:
        answer = json.loads(dispatch("yaovi_clarify", {"question": question["question"], "choices": question.get("choices")}))
        if not isinstance(answer, str):
            return {"answers": answers, "outcome": "cancelled"}
        answers[question["qid"]] = answer
    return {"answers": answers, "outcome": "submitted"}


def load_hermes_env(home):
    """System-layer Hermes .env first, then the Bot's own .env (Bot keys win); process env stays authoritative."""
    from agent.secret_scope import load_env_file
    root = os.environ.get("YAOVI_HERMES_ROOT", "").strip()
    merged = {}
    for path in ([Path(root) / ".env"] if root else []) + [home / ".env"]:
        if path.exists():
            merged.update(load_env_file(path))
    for key, value in merged.items():
        os.environ.setdefault(key, value)


def resolve_route(route, config):
    """Hermes owns provider resolution: config.yaml model/providers, .env keys, auth.json OAuth and pools."""
    from hermes_cli.runtime_provider import resolve_runtime_provider
    if route.get("baseURL"):  # explicit endpoint (tests / Hermes `--base-url` rung)
        runtime = resolve_runtime_provider(requested=route.get("provider") or "custom", explicit_base_url=route["baseURL"],
                                           explicit_api_key=route.get("apiKey"), target_model=route.get("model") or None)
        runtime["api_mode"] = route.get("apiMode") or runtime.get("api_mode")
        return runtime
    runtime = resolve_runtime_provider(requested=route.get("provider") or None, target_model=route.get("model") or None)
    if not runtime.get("base_url") and runtime.get("provider") not in ("bedrock", "copilot-acp", "moa"):
        raise RuntimeError(f"Hermes could not resolve provider {route.get('provider')!r}; configure it in model services")
    return runtime


def model_speed_options(route, runtime):
    """Translate the Bot's selected speed using Hermes' route-aware native fast gate."""
    from agent.fast_mode import parse_exact_service_tier
    from hermes_cli.models import resolve_fast_mode_overrides
    mode = route.get("fastMode") or "normal"
    if mode not in ("normal", "fast"):
        raise ValueError(f"Unsupported Bot fast mode: {mode}")
    tier = parse_exact_service_tier(mode)
    overrides = {}
    if tier:
        overrides = resolve_fast_mode_overrides(route["model"], provider=runtime.get("provider"), base_url=runtime.get("base_url"))
        if overrides is None:
            raise ValueError("The resolved provider route does not support fast mode")
    return {"service_tier": tier or None, "request_overrides": overrides}


def register_vault_env():
    """Owner-authorized vault env credentials arrive in the process env only.
    Register each value for model-facing redaction before any tool runs, and allow
    the names through Hermes sandbox env scrubbing (owner decision: all subprocesses)."""
    names = [n for n in os.environ.pop("YAOVI_VAULT_ENV_NAMES", "").split(",") if re.fullmatch(r"[A-Z][A-Z0-9_]*", n or "")]
    if not names:
        return
    from agent.redact import register_vault_redaction_value
    from tools.env_passthrough import register_env_passthrough
    for name in names:
        register_vault_redaction_value(os.environ.get(name))
    register_env_passthrough(names)


def compact_session(agent, db, history, saved, history_file):
    """Compress a settled session in place and report the new size; anything else is left untouched."""
    def done(status, **usage):
        emit("completed", text=status, usage=usage)
    # Only a turn that ended cleanly has a transcript without dangling tool calls.
    if not isinstance(saved, dict) or saved.get("status") != "complete" or not history:
        return done("skipped")
    from agent.conversation_compression import finalize_context_engine_compression_notification
    from agent.conversation_compression_manual import CompressRequest, compress_now
    # This process has no tools and no live prompt environment: keep the session's stored prompt
    # (and its saved tool list) instead of rebuilding them at the commit boundary.
    row = db.get_session(agent.session_id) or {}
    stored_prompt = row.get("system_prompt")
    agent._cached_system_prompt = stored_prompt if isinstance(stored_prompt, str) else ""
    agent._retain_seeded_system_prompt = True
    committed = False
    try:
        outcome = compress_now(agent, history, CompressRequest(), system_message="",
                               skip_without_window=True, task_id=agent.session_id or "default")
        committed = outcome.status == "compressed"
        if committed and agent.session_id != saved.get("kernelSessionId"):
            # The kernel moved the conversation to a new session id: the next turn must follow it.
            temporary = history_file.with_suffix(".tmp")
            temporary.write_text(json.dumps({**saved, "kernelSessionId": agent.session_id}))
            temporary.chmod(0o600)
            temporary.replace(history_file)
    finally:
        finalize_context_engine_compression_notification(agent, committed=committed)
    if not committed:
        return done(outcome.status)
    compressor = getattr(agent, "context_compressor", None)
    done("compressed", context_used=int(outcome.after_tokens), before_tokens=int(outcome.before_tokens),
         context_max=int(getattr(compressor, "context_length", 0) or 0) or None, context_source="local_estimate")


def main():
    global agent, persistent_waits, turn_closed, steer_ready
    request = json.loads(sys.stdin.readline())
    persistent_waits = request.get("botPolicy", {}).get("version") == 2
    # Native initialization and skill admission may issue RPCs before AIAgent
    # exists. Start the sole reply reader before any such authorization call.
    threading.Thread(target=read_replies, daemon=True).start()
    home = Path(request["dataRoot"]).resolve()
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HERMES_PYTHON_SRC_ROOT"] = str(ROOT / "hermes")
    os.environ["HERMES_SKIP_UPDATE_CHECK"] = "1"
    os.environ["YAOVI_KERNEL"] = "1"
    from agent.runtime_context import install, migrate_product_prompt
    # Session titles belong to the Yaovi workspace (server-side, via Hermes auxiliary.title_generation).
    aux = request.setdefault("config", {}).setdefault("auxiliary", {})
    aux.setdefault("title_generation", {})["enabled"] = False
    network_snapshot = request.pop("network", None)
    install(request, dispatch)
    import model_network
    model_network.install()
    network_scope = model_network.scope(network_snapshot, model_operation=False)
    network_scope.__enter__()  # One turn owns this process; child threads inherit its snapshot.
    from run_agent import AIAgent
    if request.get('usageObservation'):
        import dialogue_usage
        dialogue_usage.install({**request['usageObservation'], 'provider': request.get('route', {}).get('provider', 'unknown')}, emit, AIAgent)
    import native_authorization
    native_authorization.install(request, dispatch, agent_class=AIAgent)
    load_hermes_env(home)
    register_vault_env()
    import host_runtime
    host_cwd = host_runtime.install(request)
    from hermes_state import SessionDB
    db = SessionDB(db_path=home / "state.db")
    session = request["sessionId"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", session):
        raise ValueError("Invalid session identifier")
    route = request["route"]
    config = request["config"]
    history_file = home / "contexts" / (session + ".json")
    checkpoint = json.loads(history_file.read_text()) if history_file.exists() else {}
    if isinstance(checkpoint, list):
        history = checkpoint
    else:
        session = checkpoint.get("kernelSessionId", session)
        # Preserve dangling calls before repairing alternation: repair can drop them.
        history = db.get_messages_as_conversation(session, include_ancestors=True, repair_alternation=False)
        if checkpoint.get("status") == "running":
            # Missing tool receipts remain unknown; never invoke the old action again.
            pending_calls = {c["id"] for m in history for c in m.get("tool_calls", [])}
            pending_calls -= {m.get("tool_call_id") for m in history if m.get("role") == "tool"}
            for call in pending_calls:
                history.append({"role":"tool", "tool_call_id":call, "content":json.dumps({"error":"Interrupted before the result was confirmed. Inspect effects before retrying.","outcomeUnknown":True})})
    # A turn that crashed before its cleanup must not leak its state into this one,
    # including rows reloaded from the store after in-turn compaction.
    db.clear_user_api_content_with_prefix(session, TURN_CONTEXT_SENTINEL)
    strip_turn_context_sidecars(history)
    # Existing sessions retain their admitted tools and context. Only the known
    # application identity prefix changes, at a turn boundary before model use.
    row = db.get_session(session)
    if row:
        stored_prompt = row.get("system_prompt")
        product_prompt = migrate_product_prompt(stored_prompt)
        if product_prompt != stored_prompt:
            db.update_system_prompt(session, product_prompt)
    runtime = resolve_route(route, config)
    agent = AIAgent(
        **model_speed_options(route, runtime),
        model=route["model"], provider=runtime.get("provider"),
        base_url=runtime.get("base_url"), api_key=runtime.get("api_key"),
        api_mode=runtime.get("api_mode"), credential_pool=runtime.get("credential_pool"),
        fallback_model=config.get("fallback_model") or None,
        session_id=session, session_db=db, platform=str(request.get("platform") or "yaovi"),
        **({'cwd': host_cwd} if host_cwd else {}),
        max_iterations=config["agent"]["max_iterations"],
        reasoning_config=(None if route.get("reasoningEffort") in (None, "default")
                          else {"enabled": False} if route["reasoningEffort"] == "none"
                          else {"effort": route["reasoningEffort"]}),
        quiet_mode=True, skip_context_files=True, skip_memory=False,
        skip_background_review=not config.get("memory", {}).get("automatic", True),
        ephemeral_system_prompt=request.get("instructions", ""),
        stream_delta_callback=lambda text: emit("message.delta", text=text),
        reasoning_callback=lambda text, **kw: emit("reasoning.delta", text=text),
        event_callback=lambda name, value: emit("kernel.event", name=name, value=value),
        tool_progress_callback=lambda kind, name=None, preview=None, args=None, **kw: emit("kernel.event", name=kind, value={"tool":name,"preview":preview,"args":args,**kw}),
        clarify_callback=clarify,
    )
    # Tag tool progress with the model's call id so the host can pair started/completed events.
    agent._yaovi_embedded = True
    if request.get('reportOnlyReview') is True:
        # The Host admitted only the structured decision and session attachment
        # reader. Native skill,
        # clarification, delegation and discovery tools are not in this turn's
        # catalog; native_authorization remains a second fail-closed boundary.
        allowed = {'workspace_review_background_task', 'harness_result_read'}
        names = [entry.get('name') for entry in request.get('tools', [])]
        if request.get('botPolicy', {}).get('enabled') is not True or len(names) != len(allowed) or set(names) != allowed:
            raise RuntimeError('Report-only review contains an unsupported tool')
        agent.tools = [tool for tool in agent.tools if tool.get('function', {}).get('name') in allowed]
        agent.valid_tool_names = {tool['function']['name'] for tool in agent.tools}
        agent.enabled_toolsets = ['yaovi']
        agent.disabled_toolsets = []
    agent._iters_since_skill = checkpoint.get("skillIterations", 0) if isinstance(checkpoint, dict) else 0
    if request.get("compact") is not None:
        # specs/102: the Host compresses a settled session between turns. No conversation turn runs,
        # and the turn checkpoint keeps its status and run id.
        compact_session(agent, db, history, checkpoint, history_file)
        agent.close()
        db.close()
        return
    history_file.parent.mkdir(parents=True, exist_ok=True)
    def checkpoint(status):
        temporary = history_file.with_suffix(".tmp")
        temporary.write_text(json.dumps({"version":1,"status":status,"kernelSessionId":agent.session_id,"runId":request["runId"],"skillIterations":agent._iters_since_skill}))
        temporary.chmod(0o600)
        temporary.replace(history_file)
    checkpoint("running")
    with steer_lock:
        if turn_closed:
            raise RuntimeError("Task cancelled during initialization")
        # Opt this worker into whole-turn admission. Native redirect otherwise
        # retains its model-request-only contract for other Hermes surfaces.
        with agent._pending_redirect_lock:
            agent._turn_redirect_open = True
        for text in startup_steers:
            if not agent.redirect(text):
                # External runtimes can own their own turn admission. Preserve
                # accepted input for their existing leftover recovery contract.
                agent.steer(text)
        startup_steers.clear()
        steer_ready = True
    from tool_discovery import metadata as discovery_metadata
    emit("ready", sessionId=session, toolDiscovery=discovery_metadata(agent))
    if request.get("review"):
        from agent.background_review import _run_review_fork, _ReviewForkState, spawn_background_review_thread
        state = _ReviewForkState()
        _, prompt = spawn_background_review_thread(agent, request["review"]["messages"], review_skills=True, focus=request["review"].get("focus"))
        result = _run_review_fork(agent, request["review"]["messages"], prompt, {}, None, state)
        if not result:
            raise RuntimeError("Native skill review did not finish")
    else:
        message, persisted = compose_turn(request["text"], request.get("turnContext"))
        try:
            result = agent.run_conversation(message, conversation_history=history,
                                            **({"persist_user_message": persisted} if persisted is not None else {}))
        finally:
            if persisted is not None:
                for lineage in dict.fromkeys((session, agent.session_id)):
                    db.clear_user_api_content_with_prefix(lineage, TURN_CONTEXT_SENTINEL)
    with steer_lock:
        turn_closed = True
        with agent._pending_redirect_lock:
            agent._turn_redirect_open = False
            unapplied_redirect = agent._pending_redirect
            agent._pending_redirect = None
        # Keep Hermes' recovery handoff for an unconsumed tool steer or redirect
        # restart limit. Normal model-time insertion is consumed in this turn.
        leftover_steer = (result.get("pending_steer") or "").strip()
        drain = getattr(agent, "_drain_pending_steer", None)
        late = (drain() or "").strip() if callable(drain) else ""
    leftover_steer = "\n".join(part for part in (leftover_steer, late, unapplied_redirect) if part)
    if leftover_steer and result.get("completed") is not False:
        emit("steer.leftover", text=leftover_steer)
    checkpoint("complete" if result.get("completed") else "interrupted")
    if result.get("completed") is False:
        raise RuntimeError(result.get("error") or "Agent did not complete the turn")
    # Hermes is the source of truth: session_* counters for billing, last_prompt_tokens /
    # context_usage_fields for occupancy (never use session sums as context %).
    compressor = getattr(agent, "context_compressor", None)
    context_fields = {}
    try:
        from agent.context_breakdown import context_usage_fields
        context_fields = context_usage_fields(compressor) if compressor else {}
    except Exception:
        context_fields = {}
    if not context_fields.get("context_used"):
        last_prompt = int(result.get("last_prompt_tokens") or 0)
        context_max = int(getattr(compressor, "context_length", 0) or 0) if compressor else 0
        if last_prompt > 0:
            context_fields = {
                "context_used": min(last_prompt, context_max) if context_max else last_prompt,
                "context_max": context_max or None,
                "context_source": "provider_usage" if last_prompt else "local_estimate",
            }
    breakdown = None
    try:
        from agent.context_breakdown import compute_session_context_breakdown
        breakdown = compute_session_context_breakdown(agent, history if isinstance(history, list) else [])
    except Exception:
        breakdown = None
    last_turn = getattr(agent, "_last_turn_usage", None)
    emit("completed", text=result.get("final_response", ""), usage={
        # Per-process turn totals (Yaovi spawns one worker per turn).
        "input_tokens": int(getattr(agent, "session_prompt_tokens", 0) or result.get("prompt_tokens") or 0),
        "output_tokens": int(getattr(agent, "session_completion_tokens", 0) or result.get("completion_tokens") or 0),
        "total_tokens": int(getattr(agent, "session_total_tokens", 0) or result.get("total_tokens") or 0),
        "prompt_tokens": int(getattr(agent, "session_prompt_tokens", 0) or 0),
        "completion_tokens": int(getattr(agent, "session_completion_tokens", 0) or 0),
        "cache_read_tokens": int(getattr(agent, "session_cache_read_tokens", 0) or 0),
        "cache_write_tokens": int(getattr(agent, "session_cache_write_tokens", 0) or 0),
        "reasoning_tokens": int(getattr(agent, "session_reasoning_tokens", 0) or 0),
        "last_prompt_tokens": int(result.get("last_prompt_tokens") or 0),
        "last_turn": last_turn if isinstance(last_turn, dict) else None,
        "model": result.get("model") or getattr(agent, "model", None),
        "provider": result.get("provider") or getattr(agent, "provider", None),
        "usage_mode": "turn",
        **{k: v for k, v in context_fields.items() if v is not None},
        **({"breakdown": breakdown} if breakdown else {}),
    })
    agent.close()
    db.close()


def preload():
    """Import Hermes-independent libraries before the turn request arrives.

    A standby worker is spawned ahead of the next turn and blocks on its first stdin line; doing
    this work first removes it from the turn's latency. Hermes modules are not imported here: they
    capture HERMES_HOME at import time and must load after the runtime context is installed.
    """
    import importlib
    for name in ("openai", "httpx", "pydantic", "psutil", "rich.console", "jinja2", "requests",
                 "tenacity", "ruamel.yaml", "dotenv", "anyio", "jsonschema"):
        try:
            importlib.import_module(name)
        except Exception:
            pass


if __name__ == "__main__":
    try:
        preload()
        main()
    except BaseException as error:
        emit("failed", message=str(error), code=type(error).__name__)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
    finally:
        import native_skills
        native_skills.cleanup()
