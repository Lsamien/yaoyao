"""Yaovi-owned admission for native Hermes tools; upstream remains unmodified.

The request carries only the enforcement switch. Every actual native call asks
the control plane for a fresh decision; no permission result is cached here.
"""
from contextvars import ContextVar
from functools import wraps
import json

_call_context = ContextVar('yaovi_native_tool_call', default={})
_authorization = None


def enabled():
    return _authorization is not None


def metadata(**values):
    result = {**_call_context.get(), **{k: v for k, v in values.items() if v is not None}}
    if not result.get('tool_call_id'):
        from tools.approval_context import _approval_tool_call_id
        result['tool_call_id'] = _approval_tool_call_id.get() or None
    return result


def authorize(tool, args, **values):
    """Return an error result on refusal/unavailable authority, otherwise None."""
    if _authorization is None:
        return None
    return _authorization.check(tool, args, **values)


def check_only(tool, args, **values):
    """Revalidate passive reads without requesting or waiting for new approval."""
    if _authorization is None:
        return True
    return _authorization.check_only(tool, args, **values)


class NativeAuthorization:
    def __init__(self, request, dispatch):
        self.request = request
        self.dispatch = dispatch

    def check(self, tool, args, **values):
        try:
            ids = metadata(**values)
            ids.setdefault('session_id', self.request.get('sessionId'))
            from host_runtime import authorization_inputs
            for checked_args in authorization_inputs(tool, args, ids):
                verdict = self.dispatch('yaovi_native_authorize', {'tool': tool, 'args': checked_args}, **ids)
                verdict = json.loads(verdict) if isinstance(verdict, str) else verdict
                if not isinstance(verdict, dict) or verdict.get('allow') is not True:
                    message = verdict.get('error') if isinstance(verdict, dict) else None
                    return json.dumps({'error': message or '此 Bot 未获授权，工具未执行。', 'isError': True}, ensure_ascii=False)
            return None
        except Exception:
            return json.dumps({'error': '无法确认 Bot 权限，工具未执行。', 'isError': True}, ensure_ascii=False)

    def check_only(self, tool, args, **values):
        try:
            ids = metadata(**values)
            ids.setdefault('session_id', self.request.get('sessionId'))
            from host_runtime import authorization_inputs
            for checked_args in authorization_inputs(tool, args, ids):
                verdict = self.dispatch('yaovi_native_check', {'tool': tool, 'args': checked_args}, **ids)
                verdict = json.loads(verdict) if isinstance(verdict, str) else verdict
                if not isinstance(verdict, dict) or verdict.get('allow') is not True:
                    return False
            return True
        except Exception:
            return False


def install(request, dispatch, *, registry=None, agent_class=None, executor=None):
    """Install once before agent construction; return a restoration hook for tests."""
    global _authorization
    if request.get('botPolicy', {}).get('enabled') is not True:
        return lambda: None
    if registry is None:
        from tools.registry import registry
    if agent_class is None:
        from run_agent import AIAgent as agent_class
    if executor is None:
        from agent import tool_executor as executor
    previous = _authorization
    authority = NativeAuthorization(request, dispatch)
    _authorization = authority
    admitted = {entry['name'] for entry in request.get('tools', [])}
    original_registry = registry.dispatch
    original_delegate = agent_class._dispatch_delegate_task
    original_execute = executor._dispatch_authorized_once

    @wraps(original_registry)
    def guarded_registry(name, args, *, scope=None, **kwargs):
        entry = registry.get_entry(name, scope=scope)
        # Only actual workspace bridge handlers are already checked by TS.
        # Native skills can replace catalog entries with the same name.
        bridged = name in admitted and entry is not None and entry.toolset == 'yaovi'
        refusal = None if bridged else authority.check(name, args, **kwargs)
        return refusal if refusal is not None else original_registry(name, args, scope=scope, **kwargs)

    @wraps(original_delegate)
    def guarded_delegate(self, args):
        refusal = authority.check('delegate_task', args, session_id=getattr(self, 'session_id', None))
        return refusal if refusal is not None else original_delegate(self, args)

    @wraps(original_execute)
    def contextual_execute(agent, state, ref, **kwargs):
        # Inline delegate/memory calls bypass model_tools' observability binding.
        token = _call_context.set({'tool_call_id': ref.call_id, 'task_id': ref.task_id,
                                   'session_id': getattr(agent, 'session_id', None)})
        try:
            return original_execute(agent, state, ref, **kwargs)
        finally:
            _call_context.reset(token)

    registry.dispatch = guarded_registry
    agent_class._dispatch_delegate_task = guarded_delegate
    executor._dispatch_authorized_once = contextual_execute

    def restore():
        global _authorization
        registry.dispatch = original_registry
        agent_class._dispatch_delegate_task = original_delegate
        executor._dispatch_authorized_once = original_execute
        _authorization = previous
    return restore
