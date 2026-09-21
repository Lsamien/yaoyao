import importlib.util
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('profile_repair', Path(__file__).parents[1] / 'profile_runtime_repair.py')
repair = importlib.util.module_from_spec(spec)
spec.loader.exec_module(repair)

SERVER = '''
def _resolve_model() -> str:
    if env := _env_model_seed():
        return env
    m = _load_cfg().get("model", "")
    if isinstance(m, dict):
        return str(m.get("default", "") or "").strip()
    if isinstance(m, str) and m:
        return m.strip()
    # No env seed / config preference: native fallback.
    return "fallback"

def _resolve_startup_runtime():
    model = _resolve_model()
    return model, "launch-provider"
'''
METHODS = '''
@method("session.create")
def create(rid, params):
    return _resolve_model()

@method("session.resume")
def resume(rid, params):
    return _resolve_model()
'''


class ProfileRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        gateway = self.root / 'tui_gateway'
        gateway.mkdir()
        (gateway / 'server.py').write_text(SERVER)
        (gateway / 'methods_session.py').write_text(METHODS)

    def tearDown(self):
        self.temp.cleanup()

    def test_configured_profile_model_and_provider_win_over_launch_environment(self):
        prepared = repair.prepare(self.root)
        namespace = {'_env_model_seed': lambda: 'gpt-5.6-terra',
                     '_load_cfg': lambda: {'model': {'default': 'grok-4.6'}},
                     '_config_model_target': lambda: ('grok-4.6', 'custom:yaoer')}
        exec(prepared[0][2], namespace)
        self.assertEqual(namespace['_resolve_model'](), 'grok-4.6')
        self.assertEqual(namespace['_resolve_startup_runtime'](), ('grok-4.6', 'custom:yaoer'))
        namespace['_load_cfg'] = lambda: {}
        self.assertEqual(namespace['_resolve_model'](), 'gpt-5.6-terra')
        namespace['_load_cfg'] = lambda: {'model': {'default': ''}}
        self.assertEqual(namespace['_resolve_model'](), 'gpt-5.6-terra')
        # Preparation is read-only; activation belongs to the transactional installer.
        self.assertEqual(prepared[0][0].read_text(), SERVER)

    def test_create_and_resume_metadata_run_in_requested_profile_and_restore_context(self):
        profile = ['default']
        methods = {}
        def method(name):
            def register(handler):
                methods[name] = handler
                return handler
            return register
        def scoped(handler):
            def wrapped(rid, params):
                old = profile[0]
                profile[0] = params['profile']
                try:
                    return handler(rid, params)
                finally:
                    profile[0] = old
            return wrapped
        namespace = {'method': method, '_profile_scoped': scoped,
                     '_resolve_model': lambda: {'default': 'gpt-5.6-terra', 'yaoer': 'grok-4.6'}[profile[0]]}
        exec(repair.prepare(self.root)[1][2], namespace)
        for handler in methods.values():
            self.assertEqual(handler('id', {'profile': 'yaoer'}), 'grok-4.6')
            self.assertEqual(profile[0], 'default')

    def test_idempotent_repair_and_unknown_source_is_rejected_without_writes(self):
        for path, _, updated in repair.prepare(self.root):
            path.write_bytes(updated)
        self.assertTrue(all(before == after for _, before, after in repair.prepare(self.root)))
        server = self.root / 'tui_gateway' / 'server.py'
        server.write_text('def incompatible(): pass\n')
        with self.assertRaises(ValueError):
            repair.prepare(self.root)
        self.assertEqual(server.read_text(), 'def incompatible(): pass\n')
