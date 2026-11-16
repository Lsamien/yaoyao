"""Per-run model visibility over Yaovi's already admitted tool catalog.

The registry and original dispatch remain the execution authority. Discovery
only publishes schemas at a model-request boundary; it never calls a target.
"""
from copy import deepcopy
from functools import wraps
import hashlib
import json
from pathlib import Path
import re
import threading
import time
import uuid

DISCOVER = 'workspace_tools_discover'
RESULT_READ = 'harness_result_read'
RESULT_PREFIX = 'mcp-result-'
_hooks_installed = False
_hooks_lock = threading.Lock()

DISCOVERY_SCHEMA = {'type': 'function', 'function': {
    'name': DISCOVER,
    'description': 'Find and load admitted tools for the next request. Use a short query or exact original names. This does not execute or authorize them.',
    'parameters': {'type': 'object', 'properties': {
        'query': {'type': 'string', 'minLength': 1, 'maxLength': 500},
        'names': {'type': 'array', 'minItems': 1, 'maxItems': 8, 'uniqueItems': True,
                  'items': {'type': 'string', 'minLength': 1, 'maxLength': 256}},
        'expectedCatalogRevision': {'type': 'string', 'pattern': '^[a-f0-9]{64}$'},
        'limit': {'type': 'integer', 'minimum': 1, 'maximum': 8}}, 'additionalProperties': False}}}
RESULT_SCHEMA = {'type': 'function', 'function': {
    'name': RESULT_READ, 'description': 'Read a saved tool result by its opaque resultId. Follow nextOffset to read all text; unavailable results must not cause the original action to be repeated.',
    'parameters': {'type': 'object', 'properties': {'id': {'type': 'string', 'minLength': 1, 'maxLength': 256},
        'offset': {'type': 'integer', 'minimum': 0}, 'length': {'type': 'integer', 'minimum': 1, 'maximum': 16000}},
        'required': ['id'], 'additionalProperties': False}}}


def _name(definition):
    return (definition.get('function') or {}).get('name', '')


def _digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def utf16_length(text):
    return len(text.encode('utf-16-le')) // 2


def _clip(text, length):
    return text.encode('utf-16-le')[:length * 2].decode('utf-16-le', errors='ignore')


def _error(code, message):
    return {'isError': True, 'code': code, 'error': message, 'targetExecuted': False}


class ToolDiscovery:
    def __init__(self, agent, request, registry):
        self.agent, self.registry = agent, registry
        self.lock = threading.RLock()
        self.catalog, self.conflicts = {}, set()
        for definition in deepcopy(agent.tools):
            name = _name(definition)
            if name in self.catalog:
                self.conflicts.add(name)
            elif name:
                self.catalog[name] = definition
        self.admitted_names = set(self.catalog)
        requested_names = {t['name'] for t in request.get('tools', [])}
        # Native skill handlers may replace the bridge names during startup;
        # they retain their existing native visibility rather than being
        # mistaken for deferred workspace tools merely because names match.
        self.mcp_names = set(getattr(agent, '_yaovi_mcp_names', ()))
        workspace_names, self.unclassified = set(), set()
        for name in self.catalog:
            try:
                source = getattr(registry.get_entry(name), 'toolset', '')
            except Exception:
                # Registry introspection is an optimization, not a prerequisite
                # for answering. Unknown origins stay blocked until rechecked.
                self.unclassified.add(name)
                continue
            if source == 'yaovi' and name in requested_names:
                workspace_names.add(name)
            elif str(source).startswith('mcp-'):
                self.mcp_names.add(name)
        self.conflicts.update(requested_names & set(getattr(agent, '_yaovi_mcp_names', ())))
        self.native_names = set(self.catalog) - workspace_names - self.mcp_names - self.unclassified
        self.config = deepcopy(request.get('toolDiscovery'))
        self.scope = [request.get(k) for k in ('workspaceId', 'ownerId', 'botId', 'sessionId', 'runId')]
        self.scope.append(getattr(agent, 'platform', None))
        self.compact_enabled = request.get('compactResults') is True
        self.results = {}
        self.pending, self.stale = set(), set()
        self.unavailable = self.unclassified.copy()
        self.degraded = bool(self.unavailable)
        self._native_complete = False
        self.mode, self.fallback = 'eager', 'disabled'
        self.core = set()
        if isinstance(self.config, dict):
            names = self.config.get('coreNames', [])
            if self.config.get('version') != 1:
                self.fallback = 'unsupported'
            elif (self.config.get('mode') == 'on_demand' and isinstance(names, list)
                  and len(names) <= 64
                  and all(isinstance(n, str) and 0 < utf16_length(n) <= 256 for n in names)
                  and len(set(names)) == len(names)
                  and re.fullmatch('[a-f0-9]{64}', str(self.config.get('catalogRevision', '')))
                  and all(0 < utf16_length(n) <= 256 for n in self.catalog)
                  and DISCOVER not in self.catalog):
                self.mode, self.fallback = 'on_demand', None
                self.core = set(names) & workspace_names & set(self.catalog)
            elif self.config.get('mode') != 'eager':
                self.fallback = 'catalog_unavailable'
        self.core |= self.native_names
        if self.compact_enabled and RESULT_READ not in self.catalog:
            self.catalog[RESULT_READ] = deepcopy(RESULT_SCHEMA)
        if RESULT_READ in self.catalog:
            self.core.add(RESULT_READ)
        if self.degraded:
            self.mode, self.fallback = 'eager', 'registry_unavailable'
        self.loaded = (set(self.catalog) if self.mode == 'eager' else self.core.copy()) - self.unavailable
        self.revision = self._revision()
        self._publish()

    def _revision(self):
        return _digest({'scope': self.scope, 'hostRevision': (self.config or {}).get('catalogRevision') if isinstance(self.config, dict) else None,
                        'unavailable': sorted(self.unavailable),
                        'tools': [(n, 'mcp' if n in self.mcp_names else 'workspace', self.catalog[n]) for n in sorted(self.catalog)]})

    @property
    def active(self):
        return self.mode == 'on_demand' or self.compact_enabled or self.degraded

    def _catalog_failed(self, name):
        # Stay eager for this run, bounded to its original admission snapshot.
        # Failed MCP entries remain hidden AND execution-blocked; falling back
        # never means treating an unknown current handler as authorized.
        self.degraded = True
        self.mode, self.fallback = 'eager', 'registry_unavailable'
        self.unavailable.add(name)
        self.loaded = set(self.catalog) - self.unavailable - self.stale
        self.pending.clear()

    def _capture_native(self):
        # AIAgent adds memory/context-engine schemas after load_tools. Capture
        # those once after construction, never search the process-wide registry.
        if self._native_complete:
            return
        for definition in self.agent.tools:
            name = _name(definition)
            if name and name != DISCOVER and name not in self.catalog:
                self.catalog[name] = deepcopy(definition)
                self.admitted_names.add(name)
                self.native_names.add(name)
                self.core.add(name)
                self.loaded.add(name)
        self._native_complete = True
        self.revision = self._revision()

    def _refresh_mcp(self):
        previous_revision = self.revision
        previous_unavailable = self.unavailable.copy()
        changed = False
        for name in tuple(self.unclassified):
            try:
                entry = self.registry.get_entry(name)
                source = getattr(entry, 'toolset', '')
            except Exception:
                self._catalog_failed(name)
                continue
            self.unclassified.discard(name)
            self.unavailable.discard(name)
            changed = True
            if entry is None:
                self.catalog.pop(name, None)
                self.stale.add(name)
                self.loaded.discard(name)
            elif str(source).startswith('mcp-'):
                self.mcp_names.add(name)
        for name in self.mcp_names:
            if name in self.unclassified:
                continue
            previous = self.catalog.get(name)
            if previous is None:
                continue  # A removed tool cannot re-enter this run automatically.
            try:
                entry = self.registry.get_entry(name)
                schema = self.registry.get_schema(name) if entry is not None else None
                replacement = {'type': 'function', 'function': deepcopy(schema)} if schema else None
                if replacement:
                    if _name(replacement) != name:
                        raise ValueError('Registry schema name does not match the admitted tool')
                    if replacement != previous:
                        _digest(replacement)  # Reject unusable schemas inside the same fail-closed boundary.
                    # Reconnection may replace the handler while leaving schema
                    # bytes identical. Its original per-call approval still applies.
                    from agent.runtime_context import _require_approval
                    _require_approval(entry, name)
            except Exception:
                self._catalog_failed(name)
                continue
            self.unavailable.discard(name)
            if replacement != previous:
                changed = True
                self.stale.add(name)
                self.loaded.discard(name)
                self.pending.discard(name)
                if replacement:
                    self.catalog[name] = replacement
                else:
                    self.catalog.pop(name, None)
        if changed or previous_unavailable != self.unavailable:
            self.revision = self._revision()
        return self.revision != previous_revision

    def _publish(self):
        definitions = [deepcopy(definition) for name, definition in self.catalog.items()
                       if name in self.loaded and name not in self.unavailable and name not in self.stale]
        if self.mode == 'on_demand':
            definitions.append(deepcopy(DISCOVERY_SCHEMA))
        from tools.mcp_tool_agent import _agent_tools_lock
        with _agent_tools_lock:
            self.agent.tools = definitions
            self.agent.valid_tool_names = {_name(d) for d in definitions}

    def prepare(self):
        with self.lock:
            self._capture_native()
            if self.mode == 'on_demand' or self.degraded:
                self._refresh_mcp()
            if self.degraded:
                # Updated schemas become callable only after a model-request
                # boundary has published them. A prior refused call is never run.
                self.loaded = set(self.catalog) - self.unavailable
                self.stale.difference_update(self.loaded)
            else:
                self.loaded.update(self.pending & self.catalog.keys())
            self.pending.clear()
            self._publish()

    def metadata(self):
        with self.lock:
            self._capture_native()
            self._publish()
            return {'version': 1, 'mode': self.mode, 'catalogRevision': self.revision,
                    'visibleToolCount': len(self.agent.tools), **({'fallbackReason': self.fallback} if self.fallback else {})}

    def discover(self, args):
        if not isinstance(args, dict) or set(args) - {'query', 'names', 'limit', 'expectedCatalogRevision'}:
            return _error('invalid_request', 'Provide query or names, with optional expectedCatalogRevision.')
        query, names, limit = args.get('query'), args.get('names'), args.get('limit', 4)
        exact = 'names' in args
        if ('query' in args) == exact or (exact and ('limit' in args or not isinstance(names, list)
                or not 1 <= len(names) <= 8 or any(not isinstance(n, str) or not 1 <= utf16_length(n) <= 256 for n in names)
                or len(set(names)) != len(names))):
            return _error('invalid_request', 'Use one nonempty query or 1–8 distinct original names; names cannot include limit.')
        if not exact and (not isinstance(query, str) or not 1 <= utf16_length(query.strip()) <= 500
                          or type(limit) is not int or not 1 <= limit <= 8):
            return _error('invalid_request', 'query must be 1–500 characters and limit an integer from 1 to 8.')
        expected = args.get('expectedCatalogRevision')
        if expected is not None and (not isinstance(expected, str) or not re.fullmatch('[a-f0-9]{64}', expected)):
            return _error('invalid_request', 'Invalid catalog revision.')
        with self.lock:
            self._refresh_mcp()
            if expected is not None and expected != self.revision:
                return {**_error('tool_catalog_stale', 'Catalog changed; discover against the current revision.'), 'catalogRevision': self.revision}
            if self.mode != 'on_demand':
                if self.degraded:
                    return {**_error('tool_catalog_unavailable', 'Discovery is unavailable; this run uses its admitted eager catalog. Unverifiable tools remain blocked.'),
                            'mode': self.mode, 'fallbackReason': self.fallback, 'catalogRevision': self.revision}
                return _error('invalid_request', 'This run uses the eager catalog.')
            if not exact:
                tokens = re.findall(r'\w+', query.casefold())
                ranked = []
                for name, definition in self.catalog.items():
                    haystack = (name + ' ' + definition['function'].get('description', '')).casefold()
                    score = sum(1 for token in tokens if token in haystack)
                    if score:
                        ranked.append((-score, name))
                names = [name for _, name in sorted(ranked)[:limit]]
            if any(name in self.conflicts for name in names):
                return _error('tool_name_conflict', 'Original tool name is ambiguous; no target was executed.')
            found = [name for name in names if name in self.catalog]
            self.pending.update(found)
            self.stale.difference_update(found)
            return {'catalogRevision': self.revision,
                    'matches': [{'name': name, 'source': 'mcp' if name in self.mcp_names else 'workspace',
                                 'summary': _clip(' '.join(self.catalog[name]['function'].get('description', '').split()), 200), 'loaded': True} for name in found],
                    'loadedNames': found, 'notFound': [name for name in names if name not in self.catalog]}

    def guard(self, name):
        if self.mode != 'on_demand' and not self.degraded:
            return None
        with self.lock:
            self._refresh_mcp()
            if name in self.conflicts:
                return _error('tool_name_conflict', 'Original tool name is ambiguous; no target was executed.')
            if name in self.unavailable:
                return _error('tool_catalog_unavailable', 'The current tool registration cannot be verified. No target was executed; do not automatically replay prior operations.')
            if name in self.stale:
                return {**_error('tool_catalog_stale', 'Tool schema changed; use the next request catalog before a new call.' if self.degraded else 'Tool schema changed; discover it before a new call.'), 'catalogRevision': self.revision}
            if name != DISCOVER and name not in self.loaded:
                return _error('tool_not_loaded', 'Tool is not in the current request catalog. Wait for the next request catalog and issue a new call only if available; prior receipts remain authoritative.' if self.degraded else 'Tool is not loaded for this run. Use workspace_tools_discover, then issue a new call. Previous operation receipts remain authoritative.')
        return None

    def compact(self, result, name, args, ids):
        if not self.compact_enabled or name not in self.mcp_names or not isinstance(result, str) or utf16_length(result) <= 8000:
            return result
        # The native renderer can already have capped a flood or represented
        # binary media as MEDIA tags. Keep its existing limit/media handling;
        # never claim that our text reference restores an already-lost body.
        if any(marker in result for marker in ('[MCP RESULT TRUNCATED -', '[MCP content dropped:', 'MEDIA:')):
            return result
        from tools.tool_result_storage import _write_to_spillover, get_spillover_dir
        result_id = RESULT_PREFIX + uuid.uuid4().hex
        try:
            saved = _write_to_spillover(result, result_id + '.txt')
            if not saved:
                return result
            path = Path(saved)
            if path.is_symlink() or not path.resolve().is_relative_to(get_spillover_dir().resolve()):
                return result
            body = path.read_text(encoding='utf-8')
            if body != result:
                return result
            digest = hashlib.sha256(result.encode()).hexdigest()
            with self.lock:
                self.results[result_id] = {'path': path, 'root': get_spillover_dir().resolve(),
                    'tool': name, 'args': deepcopy(args), 'ids': dict(ids), 'hash': digest}
            flags = {}
            try:
                parsed = json.loads(result)
                if isinstance(parsed, dict):
                    flags = {key: parsed[key] for key in ('isError', 'outcomeUnknown', 'exitCode', 'exit_code', 'status', 'completed') if key in parsed}
                    if isinstance(parsed.get('error'), str):
                        flags['error'] = _clip(parsed['error'], 400)
            except ValueError:
                pass
            return json.dumps({'resultId': result_id, 'length': utf16_length(result), 'preview': _clip(result, 1500),
                'truncated': True, 'resultVersion': 1, 'available': True, 'sourceTool': name, 'contentHash': digest,
                'instruction': 'Read the complete result with harness_result_read(id=resultId) and nextOffset before relying on omitted evidence. Do not repeat the original operation.', **flags}, ensure_ascii=False)
        except (OSError, UnicodeError):
            return result

    def read(self, args):
        unavailable = _error('result_unavailable', 'Saved result is unavailable in this run. This does not mean the original operation was unexecuted; do not repeat it automatically.')
        if (not isinstance(args, dict) or set(args) - {'id', 'offset', 'length'}
                or not isinstance(args.get('id'), str) or not 1 <= utf16_length(args['id']) <= 256):
            return _error('invalid_request', 'id must be an opaque result ID of 1–256 characters; only offset and length are optional.')
        offset, length = args.get('offset', 0), args.get('length', 12000)
        if type(offset) is not int or offset < 0 or offset > 9007199254740991 or type(length) is not int or not 1 <= length <= 16000:
            return _error('invalid_request', 'offset must be a nonnegative safe integer; length must be 1–16000.')
        with self.lock:
            entry = self.results.get(args['id'])
        if entry is None:
            return unavailable
        from native_authorization import check_only
        from tools.tool_result_storage import SPILLOVER_MAX_AGE_HOURS
        with self.lock:
            self._refresh_mcp()
            if entry['tool'] in self.unavailable:
                return unavailable
            try:
                registered = self.registry.get_entry(entry['tool']) is not None
            except Exception:
                self._catalog_failed(entry['tool'])
                self.revision = self._revision()
                return unavailable
        try:
            if (entry['tool'] not in self.catalog or not registered
                    or not check_only(entry['tool'], entry['args'], **entry['ids'])
                    or entry['path'].is_symlink() or not entry['path'].resolve().is_relative_to(entry['root'])
                    or time.time() - entry['path'].stat().st_mtime >= SPILLOVER_MAX_AGE_HOURS * 3600):
                return unavailable
            text = entry['path'].read_text(encoding='utf-8')
            if hashlib.sha256(text.encode()).hexdigest() != entry['hash']:
                return unavailable
            encoded = text.encode('utf-16-le')
            total = len(encoded) // 2
            start, end = min(offset, total), min(offset + length, total)
            if start < total and 0xDC00 <= int.from_bytes(encoded[start * 2:start * 2 + 2], 'little') <= 0xDFFF:
                return _error('invalid_request', 'offset splits a Unicode character; use the previous page nextOffset.')
            if end < total and end > start and 0xD800 <= int.from_bytes(encoded[(end - 1) * 2:end * 2], 'little') <= 0xDBFF:
                end -= 1
            if end == start and start < total:
                return _error('invalid_request', 'length is too short for the next Unicode character; increase length.')
            return {'text': encoded[start * 2:end * 2].decode('utf-16-le'), 'offset': start, 'length': total,
                    'hasMore': end < total, 'nextOffset': end}
        except (OSError, UnicodeError):
            return unavailable


def metadata(agent):
    state = getattr(agent, '_yaovi_tool_discovery', None)
    return state.metadata() if state else {'version': 1, 'mode': 'eager', 'catalogRevision': _digest(getattr(agent, 'tools', [])),
                                          'visibleToolCount': len(getattr(agent, 'tools', [])), 'fallbackReason': 'disabled'}


def configure(agent, request, *, registry=None, install_hooks=True):
    if registry is None:
        from tools.registry import registry
    state = ToolDiscovery(agent, request, registry)
    agent._yaovi_tool_discovery = state
    repair = getattr(agent, '_repair_tool_call', None)
    if (state.mode == 'on_demand' or state.degraded) and callable(repair):
        # A guessed exact deferred name must not fuzzy-match a different core
        # tool before the executor has a chance to reject it.
        agent._repair_tool_call = lambda name: None if name in state.admitted_names or name in state.conflicts else repair(name)
    if install_hooks:
        _install_hooks()
    return state


def _install_hooks():
    global _hooks_installed
    with _hooks_lock:
        if _hooks_installed:
            return
        from agent import chat_completion_helpers, conversation_loop, tool_executor
        original_assemble = conversation_loop.assemble_api_request
        original_build = chat_completion_helpers.build_api_kwargs
        original_restore = conversation_loop._restore_pinned_tools
        original_invalid = conversation_loop._invalid_tool_name_error_content
        original_execute = tool_executor._dispatch_authorized_once

        @wraps(original_assemble)
        def assemble(agent, **kwargs):
            state = getattr(agent, '_yaovi_tool_discovery', None)
            if state and state.active:
                # Publish BEFORE prompt-cache decoration takes a request-local
                # copy, and before token-pressure measurement sees the tools.
                state.prepare()
            return original_assemble(agent, **kwargs)

        @wraps(original_build)
        def build(agent, messages, tools_for_api=None):
            state = getattr(agent, '_yaovi_tool_discovery', None)
            if state and state.active:
                state.prepare()
                if tools_for_api is not None:
                    tools_for_api = [d for d in tools_for_api if _name(d) in agent.valid_tool_names]
                    if state.degraded:
                        # The registry may change between assembly's decorated
                        # snapshot and this final send boundary. Keep request-
                        # local cache annotations, but never send an old schema
                        # after the eager guard has accepted its replacement.
                        current = {_name(d): d for d in agent.tools}
                        tools_for_api = [{**d, 'function': deepcopy(current[_name(d)]['function'])}
                                         for d in tools_for_api]
            return original_build(agent, messages, tools_for_api)

        @wraps(original_restore)
        def restore(agent, row):
            state = getattr(agent, '_yaovi_tool_discovery', None)
            if state and state.active:
                return [_name(d) for d in agent.tools]
            return original_restore(agent, row)

        @wraps(original_invalid)
        def invalid(name, valid_names):
            if DISCOVER in valid_names and name:
                return json.dumps(_error('tool_not_loaded', 'Tool is not loaded in this run. Use workspace_tools_discover and issue a new call after discovery. Prior receipts remain authoritative.'), ensure_ascii=False)
            return original_invalid(name, valid_names)

        @wraps(original_execute)
        def execute(agent, managed, ref, **kwargs):
            state = getattr(agent, '_yaovi_tool_discovery', None)
            if state is None or not state.active:
                return original_execute(agent, managed, ref, **kwargs)
            invoke = kwargs['execute']
            def admitted(args):
                refusal = state.guard(ref.name)
                if refusal is not None:
                    return json.dumps(refusal, ensure_ascii=False)
                if ref.name == DISCOVER and (state.mode == 'on_demand' or state.degraded):
                    return json.dumps(state.discover(args), ensure_ascii=False)
                if ref.name == RESULT_READ and str(args.get('id', '')).startswith(RESULT_PREFIX):
                    return json.dumps(state.read(args), ensure_ascii=False)
                result = invoke(args)
                return state.compact(result, ref.name, args, {'tool_call_id': ref.call_id, 'task_id': ref.task_id,
                                                            'session_id': getattr(agent, 'session_id', None)})
            return original_execute(agent, managed, ref, **{**kwargs, 'execute': admitted})

        chat_completion_helpers.build_api_kwargs = build
        conversation_loop.assemble_api_request = assemble
        conversation_loop._restore_pinned_tools = restore
        conversation_loop._invalid_tool_name_error_content = invalid
        tool_executor._dispatch_authorized_once = execute
        _hooks_installed = True
