"""Opt-in, payload-free observations of actual HTTP model attempts.

Passes request/response bytes unchanged. No retries, usage estimates, or network
calls are introduced. Unsupported transports remain explicitly incomplete.
"""
from contextvars import ContextVar
from contextlib import contextmanager
from functools import wraps
import json
import time
import uuid

_scope = ContextVar('yaovi_dialogue_usage_scope', default=None)
_installed = False
_default = None
_emit = None


@contextmanager
def scope(**values):
    token = _scope.set({**(_default or {}), **(_scope.get() or {}), **values})
    try:
        yield
    finally:
        _scope.reset(token)


class Attempt:
    def __init__(self, request):
        self.context = dict(_scope.get() or _default or {})
        self.call_id = str(uuid.uuid4())
        self.done = False
        self.buffer = b''
        self.usage = {}
        self.model = 'unknown'
        self.status_code = None
        self.provider = self.context.get('provider', 'unknown')
        self.sse = False
        self.incomplete = False
        self.terminal_received = False
        # Only read an already buffered model request; do not touch streams.
        try:
            payload = json.loads(request.content)
            self.model = str(payload.get('model', 'unknown'))
        except Exception:
            pass
        self.event('started')

    def event(self, status):
        u = self.usage
        i = u.get('prompt_tokens', u.get('input_tokens'))
        o = u.get('completion_tokens', u.get('output_tokens'))
        valid = lambda n: isinstance(n, int) and not isinstance(n, bool) and n >= 0
        obs = dict(version=1, eventId=str(uuid.uuid4()), callId=self.call_id,
                   runId=self.context.get('rootRunId', 'unknown'), role=self.context.get('role', 'unknown'),
                   attempt=1, provider=self.provider, model=self.model, status=status,
                   timestampMs=int(time.time() * 1000), source='provider' if valid(i) and valid(o) else 'unknown',
                   inputTokens=i if valid(i) else None, outputTokens=o if valid(o) else None,
                   inputIncludesCache=True, outputIncludesReasoning=True)
        if self.context.get('parentCallId'):
            obs['parentCallId'] = self.context['parentCallId']
        read = (u.get('prompt_tokens_details') or u.get('input_tokens_details') or {}).get('cached_tokens')
        reasoning = (u.get('completion_tokens_details') or u.get('output_tokens_details') or {}).get('reasoning_tokens')
        obs.update(cacheReadTokens=read if valid(read) else None, reasoningTokens=reasoning if valid(reasoning) else None)
        # Anthropic input excludes separately billed cache buckets.
        if 'cache_read_input_tokens' in u or 'cache_creation_input_tokens' in u:
            obs.update(inputIncludesCache=False, cacheReadTokens=u.get('cache_read_input_tokens'), cacheWriteTokens=u.get('cache_creation_input_tokens'))
        if self.incomplete:
            obs.update(inputTokens=None, outputTokens=None, source='unknown')
        try:
            _emit('usage.observation', observation=obs)
        except Exception:
            pass  # Observability cannot change execution behavior.

    def parse(self, data):
        if data == b'[DONE]':
            self.terminal_received = True
            return
        try:
            value = json.loads(data)
            if value.get('type') in ('message_stop', 'response.completed'):
                self.terminal_received = True
            for item in [value, value.get('response', {}), value.get('message', {})]:
                if isinstance(item, dict) and isinstance(item.get('usage'), dict):
                    self.usage.update(item['usage'])
                if self.model == 'unknown' and isinstance(item, dict) and item.get('model'):
                    self.model = str(item['model'])
        except Exception:
            pass

    def feed(self, data):
        self.buffer += data
        if self.sse:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                if line.startswith(b'data:'):
                    self.parse(line[5:].strip())
        if len(self.buffer) > 2 * 1024 * 1024:
            self.buffer = b''
            self.incomplete = True

    def finish(self, status='completed'):
        if self.done:
            return
        self.done = True
        if self.buffer:
            self.parse(self.buffer[5:].strip() if self.buffer.startswith(b'data:') else self.buffer)
        self.event('failed' if self.status_code and self.status_code >= 400 else 'completed' if self.terminal_received else status)


def install(context, emit, agent_class=None):
    """Install only with an explicit isolated observation request; return restore."""
    global _installed, _default, _emit
    if not context:
        return lambda: None
    if _installed:
        raise RuntimeError('Usage observer already installed')
    import httpx
    _installed, _default, _emit = True, dict(context), emit
    sync_send, async_send = httpx.Client.send, httpx.AsyncClient.send
    def observed(request):
        return request.method == 'POST' and any(request.url.path.rstrip('/').endswith(x) for x in ('/chat/completions', '/responses', '/messages'))
    class SyncStream(httpx.SyncByteStream):
        def __init__(self, stream, attempt): self.stream, self.attempt = stream, attempt
        def __iter__(self):
            try:
                for data in self.stream:
                    self.attempt.feed(data)
                    yield data
                self.attempt.finish()
            except BaseException:
                self.attempt.finish('failed')
                raise
        def close(self):
            try: self.stream.close()
            finally: self.attempt.finish('cancelled')
    class AsyncStream(httpx.AsyncByteStream):
        def __init__(self, stream, attempt): self.stream, self.attempt = stream, attempt
        async def __aiter__(self):
            try:
                async for data in self.stream:
                    self.attempt.feed(data)
                    yield data
                self.attempt.finish()
            except BaseException:
                self.attempt.finish('failed')
                raise
        async def aclose(self):
            try: await self.stream.aclose()
            finally: self.attempt.finish('cancelled')
    def attach(response, attempt, asynchronous=False):
        attempt.status_code = response.status_code
        attempt.sse = 'text/event-stream' in response.headers.get('content-type', '')
        if response.is_stream_consumed:
            attempt.feed(response.content)
            attempt.finish()
        else:
            response.stream = (AsyncStream if asynchronous else SyncStream)(response.stream, attempt)
        return response
    @wraps(sync_send)
    def send(self, request, **kwargs):
        if not observed(request): return sync_send(self, request, **kwargs)
        attempt = Attempt(request)
        try: return attach(sync_send(self, request, **kwargs), attempt)
        except BaseException:
            attempt.finish('failed')
            raise
    @wraps(async_send)
    async def asend(self, request, **kwargs):
        if not observed(request): return await async_send(self, request, **kwargs)
        attempt = Attempt(request)
        try: return attach(await async_send(self, request, **kwargs), attempt, True)
        except BaseException:
            attempt.finish('failed')
            raise
    httpx.Client.send, httpx.AsyncClient.send = send, asend
    original_run = getattr(agent_class, 'run_conversation', None)
    if original_run:
        @wraps(original_run)
        def run(self, *args, **kwargs):
            role = 'child' if getattr(self, 'platform', '') == 'subagent' else context.get('role', 'foreground')
            with scope(role=role):
                return original_run(self, *args, **kwargs)
        agent_class.run_conversation = run
    from agent import auxiliary_client
    original_aux, original_async_aux = auxiliary_client.call_llm, auxiliary_client.async_call_llm
    @wraps(original_aux)
    def aux(*args, **kwargs):
        with scope(role='auxiliary'): return original_aux(*args, **kwargs)
    @wraps(original_async_aux)
    async def async_aux(*args, **kwargs):
        with scope(role='auxiliary'): return await original_async_aux(*args, **kwargs)
    auxiliary_client.call_llm, auxiliary_client.async_call_llm = aux, async_aux
    def restore():
        global _installed, _default, _emit
        httpx.Client.send, httpx.AsyncClient.send = sync_send, async_send
        auxiliary_client.call_llm, auxiliary_client.async_call_llm = original_aux, original_async_aux
        if original_run: agent_class.run_conversation = original_run
        _installed, _default, _emit = False, None, None
    return restore
