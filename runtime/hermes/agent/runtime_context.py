"""Application-owned configuration for embedded Yaovi workers.

One worker process serves one conversation. The snapshot is installed before
the kernel is imported and shared with its child threads, never read from an
external Hermes installation. Callers receive copies, so plugins cannot mutate
the admitted configuration of another call.
"""
from copy import deepcopy
from typing import Any

_context: dict[str, Any] | None = None
_dispatch = None

PRODUCT_HELP_GUIDANCE = (
    "You run in Yaoyao (夭夭 AI), a workstation with persistent Bots, group chats, "
    "devices, memory and skills. Use Yaoyao settings and the tools admitted for this "
    "task to configure or inspect the workstation. Bot settings own the runtime "
    "configuration; users do not manage a separate Agent Profile. Base product help "
    "on the current Yaoyao source, documentation and observed state."
)


def product_identity() -> str | None:
    if _context is None:
        return None
    from agent.prompt_builder import DEFAULT_AGENT_IDENTITY
    return DEFAULT_AGENT_IDENTITY.replace(
        "You are Hermes Agent, built by Nous Research.", "You are Yaoyao (夭夭 AI).", 1
    )


def product_help_guidance() -> str | None:
    return PRODUCT_HELP_GUIDANCE if _context is not None else None


def environment_hints_enabled() -> bool:
    # A Yaovi VM/client-only turn must not probe an ambient Hermes Docker/SSH
    # backend while building its prompt. Host tools install their own cwd scope.
    return _context is None or bool(_context.get('hostWorkspace'))


def migrate_product_prompt(prompt: str | None) -> str | None:
    """Rename only the known built-in prefix on the next turn, preserving context.

    Never replace names in user prose, Bot roles, memory, tools, or history.
    Upstream module names and license attribution remain source metadata.
    """
    identity = product_identity()
    if not prompt or identity is None:
        return prompt
    from agent.prompt_builder import (
        DEFAULT_AGENT_IDENTITY, HERMES_AGENT_HELP_GUIDANCE,
        HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS,
    )
    for help_text in (HERMES_AGENT_HELP_GUIDANCE, HERMES_AGENT_HELP_GUIDANCE_NO_SKILLS):
        prefix = DEFAULT_AGENT_IDENTITY + "\n\n" + help_text
        if prompt.startswith(prefix):
            return identity + "\n\n" + PRODUCT_HELP_GUIDANCE + prompt[len(prefix):]
    return prompt


def install(context: dict[str, Any], dispatch) -> None:
    global _context, _dispatch
    if _context is not None:
        raise RuntimeError("Runtime context is immutable after admission")
    _context = deepcopy(context)
    _dispatch = dispatch
    import native_skills
    if "skills" in _context:
        native_skills.install(_context, dispatch)
        _context.setdefault("config", {}).setdefault("skills", {}).update({"create_dir": str(native_skills.root()), "external_dirs": [], "inline_shell": False})


def dispatch(name, args, **metadata):
    return _dispatch(name, args, **metadata)


def current() -> dict[str, Any] | None:
    return deepcopy(_context)


def compact_skill_index_enabled() -> bool:
    config = (_context or {}).get('toolDiscovery') or {}
    return config.get('version') == 1 and config.get('mode') == 'on_demand'


# The admitted context is immutable, so the merged view is computed once per defaults object.
_merged: tuple[int, dict[str, Any], dict[str, Any]] | None = None


def _merged_configuration(defaults: dict[str, Any]) -> dict[str, Any]:
    global _merged
    if _merged is not None and _merged[0] == id(defaults) and _merged[1] is defaults:
        return _merged[2]
    def merge(base, overlay):
        result = deepcopy(base)
        for key, value in overlay.items():
            result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else deepcopy(value)
        return result
    merged = merge(defaults, _context.get("config", {}))
    _merged = (id(defaults), defaults, merged)
    return merged


def configuration(defaults: dict[str, Any]) -> dict[str, Any] | None:
    """A private copy callers may mutate."""
    if _context is None:
        return None
    return deepcopy(_merged_configuration(defaults))


def configuration_readonly(defaults: dict[str, Any]) -> dict[str, Any] | None:
    """The shared merged view; callers must not mutate it (``load_config_readonly`` contract)."""
    if _context is None:
        return None
    return _merged_configuration(defaults)


def load_tools(agent) -> bool:
    if _context is None:
        return False
    from tools.registry import registry
    catalog = _context.get("tools", [])
    if "skills" in _context:
        catalog = [t for t in catalog if t["name"] not in ("skills_list", "skill_view", "skill_manage")]
    child = getattr(agent, "platform", None) == "subagent"
    if child:
        # Temporary workers cannot mutate long-lived identities, shared learning,
        # teams or schedules. They retain the parent's admitted device tools.
        catalog = [t for t in catalog if (
            (not t["name"].startswith("workspace_") or t["name"].startswith(("workspace_get_", "workspace_list_", "workspace_history_search", "workspace_memory_search", "workspace_memory_file_read")))
            and t["name"] not in ("skill_propose", "skill_feedback", "task_checkpoint_update")
            and not t["name"].startswith("routine_")
        )]
    for entry in catalog:
        def handler(args, task_id=None, _name=entry["name"], **kwargs):
            return _dispatch(_name, args, task_id=task_id, **kwargs)
        # Media still executes through Hermes's native dispatchers behind the workspace bridge;
        # this explicit registration keeps receipts and generated attachments in the owning turn.
        registry.register(name=entry["name"], toolset="yaovi", schema={"name": entry["name"], "description": entry["description"], "parameters": entry["parameters"]}, handler=handler,
                          override=entry["name"] in ("image_generate", "video_generate", "web_search", "web_extract", "tool_search", "tool_describe", "tool_call", "manage_connections"))
    agent.tools = [{"type": "function", "function": entry} for entry in catalog]
    if not child and not _context.get("review"):
        from tools import clarify_tool
        agent.tools.append({"type":"function","function":registry.get_schema("clarify")})
    # User mode uses workspace memory tools; peer mode injects its native provider
    # schemas after initialization. The builtin Hermes ``memory`` tool stays absent.
    if _context.get("config", {}).get("delegation", {}).get("enabled", True) and (not child or "delegation" in (getattr(agent, "enabled_toolsets", None) or [])):
        from tools import delegate_tool  # register the native Hermes subagent tool
        schema = registry.get_schema("delegate_task")
        if schema:
            agent.tools.append({"type": "function", "function": schema})
    import native_skills
    if "skills" in _context:
        native_skills.register(agent, writable=not child)
    mcp_toolsets = [] if _context.get("review") else load_mcp_tools(agent)
    agent._skip_mcp_refresh = True
    agent.valid_tool_names = {t["function"]["name"] for t in agent.tools}
    agent.enabled_toolsets = ["yaovi", "skills", "delegation", *(["memory"] if _context.get("nativeMemory") else []), *mcp_toolsets]
    agent.disabled_toolsets = []
    agent._tool_snapshot_generation = registry._generation
    agent._kanban_worker_guidance = ""
    if _context.get("toolDiscovery") is not None or _context.get("compactResults") is True:
        from tool_discovery import configure
        configure(agent, _context, registry=registry)
    return True


def load_mcp_tools(agent) -> list[str]:
    """Connect the admitted Hermes ``mcp_servers`` (compiled per Bot by Yaovi) and expose their
    ``mcp_<server>_<tool>`` tools. A failing server is skipped; the turn still runs."""
    servers = (_context or {}).get("config", {}).get("mcp_servers") or {}
    names = [n for n, cfg in servers.items() if isinstance(cfg, dict) and cfg.get("enabled", True) is not False]
    if not names:
        return []
    try:
        from tools.mcp_tool_discovery import discover_mcp_tools
        from tools.registry import registry
        tool_names = set(discover_mcp_tools(names))
    except Exception:
        import logging
        logging.getLogger(__name__).warning("MCP discovery failed", exc_info=True)
        return []
    agent._yaovi_mcp_names = set(tool_names)
    have = {t["function"]["name"] for t in agent.tools}
    for name in tool_names:
        _require_approval(registry.get_entry(name), name)
    agent.tools.extend(d for d in registry.get_definitions(tool_names, quiet=True) if d["function"]["name"] not in have)
    return [f"mcp-{n}" for n in names]


_MCP_READ_ONLY_UTILITIES = ("_list_resources", "_read_resource", "_list_prompts", "_get_prompt")


def _require_approval(entry, name: str) -> None:
    """Every MCP tool call (except the built-in resource/prompt readers) waits for Yaovi's per-call approval,
    exactly as the former Yaovi MCP client did; a denial returns an error to the model without calling the server."""
    if entry is None or getattr(entry.handler, "_yaovi_guarded", False) or name.endswith(_MCP_READ_ONLY_UTILITIES):
        return
    import json
    original = entry.handler

    def guarded(args, **kwargs):
        verdict = _dispatch("yaovi_mcp_approve", {"tool": name, "args": args}, task_id=kwargs.get("task_id"))
        try:
            allowed = bool(json.loads(verdict).get("allow")) if isinstance(verdict, str) else bool((verdict or {}).get("allow"))
        except Exception:
            allowed = False
        if not allowed:
            return json.dumps({"error": f"用户未批准调用 MCP 工具 {name}，未执行。"}, ensure_ascii=False)
        return original(args, **kwargs)

    guarded._yaovi_guarded = True
    entry.handler = guarded
