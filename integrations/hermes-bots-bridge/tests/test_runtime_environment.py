import importlib.util
import sys
import tempfile
import unittest
from contextvars import ContextVar
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('test_yaoyao_environment_bridge', Path(__file__).parents[1] / 'bridge_runtime.py')
bridge = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = bridge
spec.loader.exec_module(bridge)


class RuntimeEnvironmentTests(unittest.TestCase):
    def test_capabilities_reports_the_scoped_profile_catalog_without_operating_a_computer(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scope = ContextVar('runtime_environment_profile', default=root)
            configs = {
                root / 'default': {'agent': {'disabled_toolsets': []}},
                root / 'limited': {'agent': {'disabled_toolsets': ['terminal', 'computer_use']}},
            }
            observations = []

            def definitions(enabled_toolsets, disabled_toolsets, **kwargs):
                observations.append((scope.get(), kwargs))
                names = ['yaoyao_tools', 'yaoyao_call', 'terminal', 'read_file', 'computer_use', 'browser_navigate', 'memory', 'yaoyao_desktop_fake']
                return [{'function': {'name': name}} for name in names if name not in disabled_toolsets]

            modules = {
                'hermes_cli.profiles': SimpleNamespace(get_profile_dir=lambda profile: root / profile, profile_exists=lambda profile: profile in {'default', 'limited'}),
                'hermes_constants': SimpleNamespace(set_hermes_home_override=scope.set, reset_hermes_home_override=scope.reset),
                'hermes_cli.plugins': SimpleNamespace(discover_plugins=lambda: None),
                'hermes_cli.config': SimpleNamespace(load_config=lambda: configs[scope.get()]),
                'model_tools': SimpleNamespace(get_tool_definitions=definitions),
            }
            with patch.dict(sys.modules, modules), patch.object(bridge, '_web'), \
                    patch.object(bridge, '_server', return_value=SimpleNamespace(_load_enabled_toolsets=lambda: ['all'])):
                full = bridge.capabilities('default')
                limited = bridge.capabilities('limited')

            self.assertTrue(full['ready'])
            facts = full['runtime_environment']
            self.assertEqual(facts['profile'], 'default')
            self.assertEqual(facts['nativeTools'], {'terminal': ['terminal'], 'files': ['read_file'], 'desktop': ['computer_use'], 'browser': ['browser_navigate']})
            self.assertEqual(limited['runtime_environment']['nativeTools'], {'terminal': [], 'files': ['read_file'], 'desktop': [], 'browser': ['browser_navigate']})
            self.assertEqual(set(facts), {'version', 'profile', 'platform', 'osRelease', 'arch', 'nativeTools'})
            self.assertEqual(scope.get(), root)
            self.assertEqual([entry[0] for entry in observations], [root / 'default', root / 'limited'])
            self.assertTrue(all(entry[1]['skip_tool_search_assembly'] for entry in observations))

    def test_runtime_directory_does_not_report_bridge_tools_as_native_computer_capabilities(self):
        definitions = [{'function': {'name': name}} for name in ['yaoyao_tools', 'yaoyao_call', 'yaoyao_desktop_shell_123', 'tool_call', 'tool_describe', 'memory']]
        self.assertEqual(bridge._runtime_environment('default', definitions)['nativeTools'], {'terminal': [], 'files': [], 'desktop': [], 'browser': []})


if __name__ == '__main__':
    unittest.main()
