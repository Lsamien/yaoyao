"""Yaovi's Host tools and trusted per-turn working directory.

The workspace owns this policy. Hermes supplies the real native handlers; its
upstream source and the VM/client bridges remain unchanged. This directory is a
default working directory, not an operating-system sandbox.
"""
from copy import deepcopy
from functools import wraps
import os
from pathlib import Path

HOST_TOOLS = ('terminal', 'process_manage', 'read_file', 'write_file', 'patch', 'search_files', 'execute_code')
_cwd = None


def authorization_inputs(tool, args, ids):
    """Resolve native file targets before policy sees them, including every patch target."""
    if _cwd is None or tool not in ('read_file', 'write_file', 'patch', 'search_files') or not isinstance(args, dict):
        return [args]
    from tools.terminal_tool import get_session_cwd
    cwd = get_session_cwd(ids.get('task_id') or ids.get('session_id')) or _cwd
    paths = [args.get('path', '.' if tool == 'search_files' else None)]
    if tool == 'patch' and args.get('mode') == 'patch' and isinstance(args.get('patch'), str):
        from tools.file_tools import _collect_v4a_header_paths
        parsed = _collect_v4a_header_paths(args['patch'])
        if not isinstance(parsed, str):
            paths = parsed[0]
    resolved = []
    for raw in paths:
        if not isinstance(raw, str) or not raw:
            continue  # The native handler rejects its malformed input without effects.
        path = Path(os.path.expanduser(raw))
        target = path if path.is_absolute() else Path(cwd) / path
        resolved.append({**args, 'path': str(target.resolve()), 'host_original_paths': [raw]})
    return resolved or [args]


def install(request):
    global _cwd
    workspace = request.get('hostWorkspace')
    if workspace is None:
        return None
    if (not isinstance(workspace, dict) or set(workspace) != {'cwd'}
            or not isinstance(workspace['cwd'], str) or not os.path.isabs(workspace['cwd'])):
        raise ValueError('Invalid Host workspace')
    path = Path(workspace['cwd'])
    if not path.is_dir() or path.is_symlink():
        raise ValueError('Host workspace is unavailable')
    cwd = str(path.resolve(strict=True))
    _cwd = cwd

    # A worker is one turn and one Host. All Hermes worker/child threads copy
    # contextvars; the explicit scope never falls back to .env/config backends.
    from tools.terminal_scope import set_terminal_scope
    from agent.runtime_cwd import set_session_cwd
    set_terminal_scope({'TERMINAL_ENV': 'local', 'TERMINAL_CWD': cwd})
    set_session_cwd(cwd)

    from agent import runtime_context
    original = runtime_context.load_tools

    @wraps(original)
    def load_tools(agent):
        loaded = original(agent)
        if not loaded or request.get('reportOnlyReview') or request.get('review'):
            return loaded
        # Import the native modules rather than replacing them with workspace
        # RPC handlers. native_authorization still checks each real dispatch.
        from tools import terminal_tool, process_registry, file_tools, code_execution_tool  # noqa: F401
        from tools.registry import registry
        names = {tool['function']['name'] for tool in agent.tools}
        for name in HOST_TOOLS:
            if name in names:
                raise RuntimeError(f'Host tool conflicts with workspace tool: {name}')
            schema = deepcopy(registry.get_schema(name))
            if not schema:
                raise RuntimeError(f'Host native tool unavailable: {name}')
            schema['description'] = ('Runs in the Bot Host environment. The default task directory is '
                                     f'{cwd}. VM operations use computer_*; client desktop operations use desktop_*. '
                                     + schema.get('description', ''))
            agent.tools.append({'type': 'function', 'function': schema})
        agent.valid_tool_names = {tool['function']['name'] for tool in agent.tools}
        agent.enabled_toolsets = list(dict.fromkeys([*agent.enabled_toolsets, 'terminal', 'file', 'code_execution']))
        agent._tool_snapshot_generation = registry._generation
        # The discovery layer captures post-builder native schemas before the
        # first request (the same path used by native memory/context tools).
        return loaded

    runtime_context.load_tools = load_tools
    return cwd
