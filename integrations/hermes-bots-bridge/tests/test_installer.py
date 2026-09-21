import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import yaml
from test_profile_runtime_repair import SERVER, METHODS

spec = importlib.util.spec_from_file_location('bridge_installer', Path(__file__).parents[3] / 'scripts/install-hermes-bridge.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'source'; self.source.mkdir()
        (self.source / 'plugin.yaml').write_text('name: yaoyao-bot-bridge\nversion: 1.2.0\n')
        self.home = self.root / 'hermes'; self.home.mkdir()
        self.config = self.home / 'config.yaml'
        self.config.write_text('model:\n  default: keep-model\nplugins:\n  enabled: [existing]\n')
        self.target = self.home / 'plugins' / 'yaoyao-bot-bridge'
        self.target.mkdir(parents=True)
        (self.target / 'old').write_text('previous-plugin')

    def tearDown(self):
        self.temp.cleanup()

    def test_upgrade_backs_up_plugin_and_preserves_unrelated_config(self):
        original = self.config.read_bytes()
        result = installer.install(self.home, 'default', self.source)
        self.assertEqual((Path(result['backup']) / 'config.yaml').read_bytes(), original)
        self.assertEqual((Path(result['backup']) / 'yaoyao-bot-bridge' / 'old').read_text(), 'previous-plugin')
        config = yaml.safe_load(self.config.read_text())
        self.assertEqual(config['model']['default'], 'keep-model')
        self.assertEqual(config['plugins']['enabled'], ['existing', 'yaoyao-bot-bridge'])

    def test_preserves_an_explicitly_disabled_plugin(self):
        self.config.write_text('plugins:\n  disabled: [yaoyao-bot-bridge]\n')
        result = installer.install(self.home, 'default', self.source)
        self.assertTrue(result['disabled'])
        self.assertNotIn('yaoyao-bot-bridge', yaml.safe_load(self.config.read_text())['plugins'].get('enabled', []))

    def test_failed_copy_or_config_write_preserves_original_installation(self):
        for function in ['shutil.copytree', 'yaml.safe_dump']:
            with self.subTest(function=function):
                original = self.config.read_bytes()
                with patch.object(installer.shutil if function.startswith('shutil') else installer.yaml,
                                  function.split('.')[1], side_effect=RuntimeError('fixture-failure')):
                    with self.assertRaises(RuntimeError): installer.install(self.home, 'default', self.source)
                self.assertEqual(self.config.read_bytes(), original)
                self.assertEqual((self.target / 'old').read_text(), 'previous-plugin')

    def test_check_is_read_only_and_enable_changes_only_the_selected_profile_plugin(self):
        named = self.home / 'profiles' / 'writer'; named.mkdir(parents=True)
        config = named / 'config.yaml'
        config.write_text('plugins:\n  disabled: [yaoyao-bot-bridge, other]\nagent:\n  disabled_toolsets: [yaoyao_bot_bridge, terminal]\nplatform_toolsets:\n  cli: [web]\n')
        before = self.config.read_bytes()
        self.assertFalse(installer.check(self.home, 'writer', self.source)['enabled'])
        self.assertFalse((named / 'backups').exists())
        installer.install(self.home, 'writer', self.source, enable=True)
        checked = installer.check(self.home, 'writer', self.source)
        self.assertTrue(checked['filesCurrent']); self.assertTrue(checked['enabled']); self.assertFalse(checked['disabled'])
        saved = yaml.safe_load(config.read_text())
        self.assertEqual(saved['plugins']['disabled'], ['other'])
        self.assertEqual(saved['agent']['disabled_toolsets'], ['terminal'])
        self.assertEqual(saved['platform_toolsets']['cli'], ['web', 'yaoyao_bot_bridge'])
        self.assertEqual(self.config.read_bytes(), before)
        (named / 'plugins' / 'yaoyao-bot-bridge' / 'plugin.yaml').write_text('invalid: [')
        broken = installer.check(self.home, 'writer', self.source)
        self.assertTrue(broken['valid']); self.assertFalse(broken['filesCurrent'])

    def test_check_detects_same_version_code_changes(self):
        installer.install(self.home, 'default', self.source)
        self.assertTrue(installer.check(self.home, 'default', self.source)['filesCurrent'])
        (self.target / 'bridge_runtime.py').write_text('old implementation')
        self.assertFalse(installer.check(self.home, 'default', self.source)['filesCurrent'])

    def test_core_repair_is_backed_up_and_rolled_back_with_a_failed_plugin_install(self):
        installer.shutil.copyfile(Path(__file__).parents[1] / 'profile_runtime_repair.py', self.source / 'profile_runtime_repair.py')
        runtime = self.root / 'runtime'
        (runtime / 'tui_gateway').mkdir(parents=True)
        server = runtime / 'tui_gateway' / 'server.py'
        methods = runtime / 'tui_gateway' / 'methods_session.py'
        server.write_text(SERVER); methods.write_text(METHODS)
        config = self.config.read_bytes()
        with patch.object(installer.yaml, 'safe_dump', side_effect=RuntimeError('fixture-failure')):
            with self.assertRaises(RuntimeError):
                installer.install(self.home, 'default', self.source, repair_source=runtime)
        self.assertEqual(server.read_text(), SERVER)
        self.assertEqual(methods.read_text(), METHODS)
        self.assertEqual(self.config.read_bytes(), config)
        self.assertEqual((self.target / 'old').read_text(), 'previous-plugin')
        result = installer.install(self.home, 'default', self.source, repair_source=runtime)
        self.assertTrue(result['profileRuntimeRepaired'])
        self.assertIn('@_profile_scoped', methods.read_text())
        self.assertEqual((Path(result['backup']) / 'hermes-runtime' / 'server.py').read_text(), SERVER)
        self.assertEqual(yaml.safe_load(self.config.read_text())['model']['default'], 'keep-model')


if __name__ == '__main__':
    unittest.main()
