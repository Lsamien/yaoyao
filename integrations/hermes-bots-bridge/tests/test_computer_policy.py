import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
import uuid
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('test_yaoyao_bridge', Path(__file__).parents[1] / 'bridge_runtime.py')
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)


class ReviewAgent(SimpleNamespace):
    def _spawn_background_review_now(self, messages_snapshot, **kwargs):
        self.review_calls.append((messages_snapshot, kwargs, bridge._skill_review_scope.get()))


class ComputerPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.home = Path(self.temp.name)
        self.profile_scope = ContextVar('fixture_home', default=self.home)
        self.agent = ReviewAgent(session_id='stored', enabled_toolsets=['all'], review_calls=[],
                                 skip_context_files=False, load_soul_identity=False,
                                 _background_review_agent=None, _background_review_run=None)
        self.session = {'agent': self.agent, 'session_key': 'stored', 'running': True, 'cwd': str(self.home),
                        '_yaoyao_computer_policy': {'mode': 'isolated', 'hostAccess': False}}
        self.server = SimpleNamespace(_sessions={'runtime': self.session}, _sessions_lock=threading.RLock())
        self.binding = bridge.Binding('runtime', 'stored', 'default', self.home, 'generation',
                                     'http://127.0.0.1:12345', 'a' * 40, time.time() * 1000 + 60000,
                                     ('user', 'password'), self.session, self.agent,
                                     computer_policy=dict(self.session['_yaoyao_computer_policy']))
        bridge._bindings.clear(); bridge._generations.clear(); bridge._children.clear()
        bridge._bindings['runtime'] = self.binding
        self.patches = [patch.dict(sys.modules, {
                            'agent.redact': SimpleNamespace(redact_sensitive_text=lambda text, **kw: text),
                            'hermes_constants': SimpleNamespace(get_hermes_home=self.profile_scope.get,
                                set_hermes_home_override=self.profile_scope.set, reset_hermes_home_override=self.profile_scope.reset),
                        }),
                        patch.object(bridge, '_server', return_value=self.server),
                        patch.object(bridge, '_check_session_mode'),
                        patch.object(bridge, '_transport_identity', return_value=self.binding.owner),
                        patch.object(bridge, '_profile_home', return_value=self.home)]
        for p in self.patches: p.start()

    def tearDown(self):
        for p in reversed(self.patches): p.stop()
        self.temp.cleanup()

    def test_lazy_binding_starts_native_initialization_without_submitting_a_prompt(self):
        self.session.update(agent=None, running=False, agent_error=None)
        started = []
        def start(sid, session):
            started.append(sid)
            session['agent'] = self.agent
        self.server._start_agent_build = start
        body = {'session_id': 'runtime', 'stored_session_id': 'stored', 'profile': 'default',
                'generation': 'lazy-new', 'bridge_url': self.binding.bridge_url, 'token': self.binding.token,
                'expires_at': time.time() * 1000 + 60000}
        with patch.object(bridge, '_agent_has_tools', return_value=True), patch.object(bridge, '_isolate_profile_context'):
            self.assertTrue(bridge.bind(self.binding.owner, body)['ok'])
        self.assertEqual(started, ['runtime'])

    def test_failed_initialization_is_reported_immediately_without_exposing_credentials(self):
        self.session.update(agent=None, running=False, agent_error='api-key=fixture-secret')
        body = {'session_id': 'runtime', 'stored_session_id': 'stored', 'profile': 'default',
                'generation': 'failed-new', 'bridge_url': self.binding.bridge_url, 'token': self.binding.token,
                'expires_at': time.time() * 1000 + 60000}
        with self.assertRaises(bridge.BridgeError) as raised:
            bridge.bind(self.binding.owner, body)
        self.assertEqual(raised.exception.code, 'agent_initialization_failed')
        self.assertNotIn('fixture-secret', str(raised.exception))

    def test_binding_deadline_includes_lock_contention(self):
        held, release = threading.Event(), threading.Event()
        def hold():
            with bridge._lock:
                held.set(); release.wait(2)
        worker = threading.Thread(target=hold)
        worker.start(); self.assertTrue(held.wait(1))
        try:
            with self.assertRaises(bridge.BridgeError) as raised:
                with bridge._bind_locks(self.server, time.monotonic() + 0.02):
                    self.fail('contended lock unexpectedly acquired')
            self.assertEqual(raised.exception.code, 'binding_busy')
        finally:
            release.set(); worker.join(1)
        available = []
        def check_released():
            acquired = self.server._sessions_lock.acquire(blocking=False)
            available.append(acquired)
            if acquired:
                self.server._sessions_lock.release()
        checker = threading.Thread(target=check_released)
        checker.start(); checker.join(1)
        self.assertEqual(available, [True])

    def test_catalog_callback_wait_is_bounded_and_distinct_from_tool_execution(self):
        seen = []
        def opening(request, timeout):
            seen.append(timeout)
            raise TimeoutError('fixture-secret')
        opener = SimpleNamespace(open=opening)
        with patch.object(bridge.urllib.request, 'build_opener', return_value=opener):
            with self.assertRaises(bridge.BridgeError) as raised:
                bridge._request(self.binding, '/tools/list', timeout=0.5)
        self.assertEqual(seen, [0.5])
        self.assertEqual(raised.exception.code, 'bridge_catalog_unreachable')
        self.assertNotIn('fixture-secret', str(raised.exception))

    def test_native_catalog_uses_binding_profile_and_restores_request_context(self):
        current = ContextVar('fixture_profile', default=self.home)
        constants = SimpleNamespace(set_hermes_home_override=current.set, reset_hermes_home_override=current.reset)
        named = self.home / 'profiles' / 'yaoer'
        self.binding.profile_home = named
        self.binding.computer_policy = None
        self.binding.toolset = 'yaoyao_turn_current'
        other_turn = 'yaoyao_turn_other'
        scopes = []

        def definitions(enabled_toolsets, **kwargs):
            scopes.append(current.get())
            names = ['named_skill', self.binding.toolset, other_turn] if current.get() == named else ['default_skill']
            return [{'function': {'name': name}} for name in names
                    if enabled_toolsets == ['all'] or name in enabled_toolsets]

        model_tools = SimpleNamespace(get_tool_definitions=definitions, get_toolset_for_tool=lambda name: name)
        with patch.dict(sys.modules, {'hermes_constants': constants, 'model_tools': model_tools}):
            bridge._refresh_agent_tools(self.agent, self.binding)
        self.assertEqual(scopes, [named, named])
        self.assertEqual(self.agent.valid_tool_names, {'named_skill', self.binding.toolset})
        self.assertNotIn(other_turn, self.agent.enabled_toolsets)
        self.assertEqual(current.get(), self.home)

    def test_catalog_failure_restores_profile_context(self):
        current = ContextVar('fixture_profile_failure', default=self.home)
        constants = SimpleNamespace(set_hermes_home_override=current.set, reset_hermes_home_override=current.reset)
        self.binding.profile_home = self.home / 'profiles' / 'yaoer'
        self.binding.computer_policy = None

        def fail(**kwargs):
            self.assertEqual(current.get(), self.binding.profile_home)
            raise RuntimeError('fixture catalog failed')

        model_tools = SimpleNamespace(get_tool_definitions=fail, get_toolset_for_tool=lambda name: name)
        with patch.dict(sys.modules, {'hermes_constants': constants, 'model_tools': model_tools}):
            with self.assertRaisesRegex(RuntimeError, 'fixture catalog failed'):
                bridge._refresh_agent_tools(self.agent, self.binding)
        self.assertEqual(current.get(), self.home)

    def test_isolated_skills_and_vm_tools_use_native_catalog_but_host_operations_require_approval(self):
        for name in ['skills_list', 'skill_view', 'vision_analyze', 'yaoyao_computer_shell_aabbcc']:
            self.assertIsNone(bridge.computer_directive(session_id='stored', tool_name=name, args={}))
        for name in ['terminal', 'process_manage', 'read_file', 'write_file', 'execute_code', 'delegate_task', 'session_search', 'browser_navigate', 'yaoyao_computer_copy_file_aabbcc']:
            result = bridge.computer_directive(session_id='stored', tool_name=name, args={'path': '/authorized.txt'})
            self.assertEqual(result['action'], 'approve')
            self.assertIn('/authorized.txt', result['message'])
        self.binding.computer_policy['hostAccess'] = True
        self.assertIsNone(bridge.computer_directive(session_id='stored', tool_name='terminal', args={}))
        self.binding.computer_policy.update(mode='profile', hostAccess=False)
        self.assertIsNone(bridge.computer_directive(session_id='stored', tool_name='terminal', args={}))

    def test_stopped_expired_unbound_and_replaced_sessions_cannot_call_native_tools(self):
        for change in ['stop', 'expire', 'unbind', 'replace']:
            with self.subTest(change=change):
                self.session.update(running=True, agent=self.agent)
                self.binding.expires_at = time.time() * 1000 + 60000
                bridge._bindings['runtime'] = self.binding
                if change == 'stop': self.session['running'] = False
                if change == 'expire': self.binding.expires_at = 0
                if change == 'unbind': bridge._bindings.clear()
                if change == 'replace': self.session['agent'] = SimpleNamespace(session_id='stored')
                self.assertEqual(bridge.computer_directive(session_id='runtime', tool_name='skill_view', args={})['action'], 'block')

    def test_ordinary_profile_sessions_are_unaffected(self):
        self.session.pop('_yaoyao_computer_policy')
        self.assertIsNone(bridge.computer_directive(session_id='stored', tool_name='terminal', args={}))

    def test_policy_cannot_be_changed_during_renewal(self):
        self.session['running'] = False
        body = {'session_id': 'runtime', 'stored_session_id': 'stored', 'profile': 'default',
                'generation': 'generation', 'bridge_url': self.binding.bridge_url, 'token': self.binding.token,
                'expires_at': time.time() * 1000 + 60000, 'computer_policy': {'mode': 'profile', 'hostAccess': True}}
        with patch.object(bridge, '_agent_has_tools', return_value=True):
            with self.assertRaises(bridge.BridgeError) as error:
                bridge.bind(self.binding.owner, body)
            self.assertEqual(error.exception.code, 'generation_conflict')

    def test_transfer_is_owned_by_hermes_and_checks_generation_owner_and_protected_paths(self):
        constants = SimpleNamespace(set_hermes_home_override=lambda p: None, reset_hermes_home_override=lambda p: None)
        file_tools = SimpleNamespace(_check_sensitive_path=lambda p, t: 'denied' if p.endswith('protected') else None,
                                     _check_protected_instruction_write=lambda p, t: None,
                                     _check_approval_required_write=lambda p, t: None)
        safety = SimpleNamespace(get_read_block_error=lambda p: 'denied' if p.endswith('protected') else None)
        modules = {'hermes_constants': constants, 'tools.file_tools': file_tools, 'agent.file_safety': safety}
        (self.home / 'authorized').write_bytes(b'authorized-input')
        body = {'session_id': 'runtime', 'generation': 'generation', 'action': 'read', 'path': 'authorized'}
        with patch.dict(sys.modules, modules):
            self.assertEqual(bridge.computer_file(self.binding.owner, body)['data'], 'YXV0aG9yaXplZC1pbnB1dA==')
            for owner, changed in [(('other', 'password'), body), (self.binding.owner, {**body, 'generation': 'stale'}),
                                    (self.binding.owner, {**body, 'path': 'protected'})]:
                with self.assertRaises(bridge.BridgeError): bridge.computer_file(owner, changed)
            transfer_id = str(uuid.uuid4())
            transfer = {**body, 'action': 'transfer', 'direction': 'read', 'transfer': {'op': 'transfer-read-open', 'transferId': transfer_id, 'path': 'authorized', 'maxBytes': 1024 * 1024}}
            metadata = bridge.computer_file(self.binding.owner, transfer)
            self.assertTrue(metadata['ok']); self.assertEqual(metadata['size'], 16)
            chunk = {**transfer, 'transfer': {'op': 'transfer-read', 'transferId': transfer_id, 'offset': 0}}
            self.assertEqual(bridge.computer_file(self.binding.owner, chunk)['data'], 'YXV0aG9yaXplZC1pbnB1dA==')
            for changed in [{**chunk, 'generation': 'stale'}, {**chunk, 'path': 'protected'}]:
                with self.assertRaises(bridge.BridgeError): bridge.computer_file(self.binding.owner, changed)
            bridge.computer_file(self.binding.owner, {**transfer, 'transfer': {'op': 'transfer-abort', 'transferId': transfer_id}})
            bridge.computer_file(self.binding.owner, {**body, 'action': 'write', 'path': 'result', 'data': 'cmVzdWx0'})
            self.assertEqual((self.home / 'result').read_bytes(), b'result')
            staged_id = str(uuid.uuid4())
            bridge.computer_file(self.binding.owner, {**body, 'action': 'transfer', 'direction': 'write', 'path': 'pending',
                'transfer': {'op': 'transfer-write-open', 'transferId': staged_id, 'maxBytes': 1024 * 1024, 'size': 0,
                             'sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'overwrite': False}})
            staged = self.home / ('.yaoyao-transfer-' + staged_id)
            self.assertTrue(staged.exists())
            bridge.unbind(self.binding.owner, {'session_id': 'runtime', 'generation': 'generation'})
            deadline = time.time() + 3
            while staged.exists() and time.time() < deadline: time.sleep(0.02)
            self.assertFalse(staged.exists())
            self.assertFalse((self.home / 'pending').exists())

            self.session['running'] = False
            with self.assertRaises(bridge.BridgeError): bridge.computer_file(self.binding.owner, body)

    def test_workspace_memory_uses_agent_controls_without_mutating_another_agent(self):
        stopped = []
        other = SimpleNamespace(_memory_enabled=True)
        self.agent._memory_store = object()
        self.agent._memory_manager = SimpleNamespace(get_all_tool_names=lambda: {'provider_remember'}, shutdown_all=lambda: stopped.append(True))
        self.agent._memory_enabled = self.agent._user_profile_enabled = True
        self.agent.skip_background_review = False
        self.agent.disabled_toolsets = ['terminal']
        invalidated = []
        self.agent._invalidate_system_prompt = lambda: invalidated.append(True)
        self.binding.workspace_memory = True
        self.session['_yaoyao_workspace_memory'] = True
        bridge._isolate_profile_memory(self.agent, self.binding)
        self.assertIsNone(self.agent._memory_store)
        self.assertIsNone(self.agent._memory_manager)
        self.assertFalse(self.agent._memory_enabled)
        self.assertFalse(self.agent._user_profile_enabled)
        self.assertFalse(self.agent.skip_background_review)
        self.assertEqual(self.agent.disabled_toolsets, ['terminal', 'memory'])
        self.assertEqual(stopped, [True]); self.assertEqual(invalidated, [True])
        self.assertTrue(other._memory_enabled)
        for tool in ('memory', 'provider_remember'):
            self.assertEqual(bridge.computer_directive(session_id='stored', tool_name=tool, args={})['action'], 'block')
        self.assertIsNone(bridge.computer_directive(session_id='stored', tool_name='skill_view', args={}))

    def test_skill_review_is_installed_once_and_never_runs_memory_review(self):
        bridge._enable_skill_review(self.agent, self.binding)
        wrapped = self.agent._spawn_background_review_now
        bridge._enable_skill_review(self.agent, self.binding)
        self.assertIs(wrapped, self.agent._spawn_background_review_now)
        self.agent._spawn_background_review_now([], review_memory=True)
        self.assertEqual(self.agent.review_calls, [])
        self.agent._spawn_background_review_now([{'role': 'user', 'content': 'verified work'}], review_memory=True, review_skills=True)
        self.assertEqual(len(self.agent.review_calls), 1)
        _, kwargs, scope = self.agent.review_calls[0]
        self.assertFalse(kwargs['review_memory'])
        self.assertTrue(kwargs['review_skills'])
        self.assertIs(scope.parent, self.agent)
        self.assertIsNone(bridge._skill_review_scope.get())

    def test_review_fork_keeps_isolation_and_only_skill_permission_after_turn_unbind(self):
        self.agent.skip_context_files = True
        self.agent.load_soul_identity = False
        self.agent.disabled_toolsets = ['memory']
        scope = bridge._SkillReviewScope(self.agent, self.binding, time.monotonic() + 60)
        parent = bridge._SkillReviewParent(scope)
        parent._background_review_run = SimpleNamespace(cancel_requested=threading.Event())
        fork = self.context_agent()
        fork._memory_store = fork._memory_manager = object()
        fork._memory_enabled = fork._user_profile_enabled = True
        tools = [{'function': {'name': name}} for name in ['skills_list', 'skill_view', 'skill_manage', 'memory']]
        with patch.dict(sys.modules, {'model_tools': SimpleNamespace(get_tool_definitions=lambda **kw: tools)}):
            parent._background_review_agent = fork
        self.assertTrue(fork.skip_context_files)
        self.assertFalse(fork.load_soul_identity)
        self.assertTrue(fork.skip_background_review)
        self.assertIsNone(fork._memory_manager)
        self.assertIsNone(fork._memory_store)
        self.assertFalse(fork._memory_enabled)
        self.assertFalse(fork._user_profile_enabled)
        self.assertIsNone(fork._cached_system_prompt)
        self.assertEqual(fork.valid_tool_names, {'skills_list', 'skill_view', 'skill_manage'})
        bridge._bindings.clear()
        self.session['running'] = False
        constants = SimpleNamespace(get_hermes_home=lambda: self.home)
        with patch.dict(sys.modules, {'hermes_constants': constants}):
            token = bridge._skill_review_scope.set(scope)
            try:
                self.assertIsNone(bridge.computer_directive(session_id='stored', tool_name='skill_manage'))
                for tool in ['memory', 'provider_remember', 'read_file', 'terminal', 'yaoyao_computer_shell', 'workspace_send_to_agent']:
                    self.assertEqual(bridge.computer_directive(session_id='stored', tool_name=tool)['action'], 'block')
                self.assertEqual(bridge.computer_directive(session_id='other-session', tool_name='skill_manage')['action'], 'block')
                constants.get_hermes_home = lambda: self.home / 'other-profile'
                self.assertEqual(bridge.computer_directive(session_id='stored', tool_name='skill_manage')['action'], 'block')
                constants.get_hermes_home = lambda: self.home
                scope.run.cancel_requested.set()
                self.assertEqual(bridge.computer_directive(session_id='stored', tool_name='skill_manage')['action'], 'block')
                scope.run.cancel_requested.clear()
                parent._background_review_agent = None
                self.assertEqual(bridge.computer_directive(session_id='stored', tool_name='skill_manage')['action'], 'block')
            finally:
                bridge._skill_review_scope.reset(token)
        self.assertEqual(bridge.computer_directive(session_id='stored', tool_name='skill_manage')['action'], 'block')

    def context_agent(self, session_id='stored'):
        agent = SimpleNamespace(session_id=session_id, enabled_toolsets=['skills'], disabled_toolsets=[],
                                skip_context_files=False, load_soul_identity=True,
                                _cached_system_prompt='previous-profile-context')
        agent._invalidate_system_prompt = lambda: setattr(agent, '_cached_system_prompt', None)
        return agent

    def test_isolated_bind_and_resumed_agent_clear_context_cache_without_changing_history(self):
        self.session.update(running=False, history=[{'role': 'user', 'content': 'keep-history'}])
        original = self.context_agent('ordinary-session')
        body = {'session_id': 'runtime', 'stored_session_id': 'stored', 'profile': 'default',
                'bridge_url': self.binding.bridge_url, 'token': self.binding.token,
                'expires_at': time.time() * 1000 + 60000, 'computer_policy': self.binding.computer_policy}
        with patch.object(bridge, '_agent_has_tools', return_value=True):
            for generation in ['first-turn', 'resumed-turn']:
                agent = self.context_agent()
                self.session['agent'] = agent
                bridge.bind(self.binding.owner, {**body, 'generation': generation})
                self.assertTrue(agent.skip_context_files)
                self.assertFalse(agent.load_soul_identity)
                self.assertIsNone(agent._cached_system_prompt)
                self.assertEqual(agent.enabled_toolsets, ['skills'])
                self.assertEqual(self.session['history'], [{'role': 'user', 'content': 'keep-history'}])
                bridge.unbind(self.binding.owner, {'session_id': 'runtime', 'generation': generation})
                self.assertTrue(agent.skip_context_files)
        self.assertFalse(original.skip_context_files)
        self.assertTrue(original.load_soul_identity)

    def test_isolated_child_inherits_context_policy_and_keeps_skill_tools(self):
        child = self.context_agent('child-session')
        self.agent._active_children = [child]
        tools = [{'function': {'name': name}} for name in ['skills_list', 'skill_view', 'skill_manage']]
        model_tools = SimpleNamespace(get_tool_definitions=lambda **kw: tools, get_toolset_for_tool=lambda name: 'skills')
        with patch.dict(sys.modules, {'model_tools': model_tools}):
            bridge.inherit_child(parent_session_id='stored', child_session_id='child-session')
        self.assertTrue(child.skip_context_files)
        self.assertFalse(child.load_soul_identity)
        self.assertIsNone(child._cached_system_prompt)
        self.assertEqual(child.valid_tool_names, {'skills_list', 'skill_view', 'skill_manage'})

    def test_context_isolation_preserves_profile_mode_and_requires_supported_agent(self):
        for policy in [None, {'mode': 'profile', 'hostAccess': True}]:
            agent = self.context_agent()
            self.binding.computer_policy = policy
            bridge._isolate_profile_context(agent, self.binding)
            self.assertFalse(agent.skip_context_files)
            self.assertTrue(agent.load_soul_identity)
            self.assertEqual(agent._cached_system_prompt, 'previous-profile-context')
        self.binding.computer_policy = {'mode': 'isolated', 'hostAccess': False}
        with self.assertRaises(bridge.BridgeError) as error:
            bridge._isolate_profile_context(SimpleNamespace(), self.binding)
        self.assertEqual(error.exception.code, 'context_isolation_unavailable')


if __name__ == '__main__':
    unittest.main()
