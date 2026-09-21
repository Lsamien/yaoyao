import importlib.util
import json
from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
import unittest

spec = importlib.util.spec_from_file_location('bot_model_settings_test', Path(__file__).parents[1] / 'model_settings.py')
models = importlib.util.module_from_spec(spec)
spec.loader.exec_module(models)


class BotModelSettingsTests(unittest.TestCase):
    def setUp(self):
        self.config = {"agent": {"reasoning_effort": "medium", "service_tier": "auto"}, "model": {"api_key": "fixture-secret"}}
        self.ctx = SimpleNamespace(current_provider='openai', current_model='model-a', current_base_url='https://api.openai.com/v1', user_providers={}, custom_providers=[])
        self.switch = Mock(side_effect=lambda **kw: SimpleNamespace(success=True, target_provider=kw['explicit_provider'], new_model=kw['raw_input'], base_url=self.ctx.current_base_url, api_key='fixture-secret', model_info=None))
        self.warning = Mock(return_value=None)
        self.meta = Mock(return_value=SimpleNamespace(supports_reasoning=True))
        self.fast = Mock(side_effect=lambda model, **kw: {'service_tier': 'priority'} if kw['base_url'].startswith('https://api.openai.com/') else None)
        self.reader = Mock(return_value=None)
        modules = {
            'hermes_constants': SimpleNamespace(VALID_REASONING_EFFORTS=['low','medium','high','ultra'], parse_reasoning_effort=lambda value: {} if value in ['none','low','medium','high','ultra'] else None),
            'hermes_cli.config': SimpleNamespace(load_config=lambda: self.config),
            'hermes_cli.inventory': SimpleNamespace(load_picker_context=lambda: self.ctx, _reasoning_catalog_reader=lambda _: self.reader,
                build_model_options_payload=lambda *a, **kw: {'providers': [{'slug':'openai','models':['model-a'], 'capabilities': {'model-a': {'reasoning': True}}}]}),
            'hermes_cli.models': SimpleNamespace(resolve_fast_mode_overrides=self.fast, github_model_reasoning_efforts=lambda _: ['low','high']),
            'hermes_cli.model_switch': SimpleNamespace(switch_model=self.switch),
            'hermes_cli.model_selection_guards': SimpleNamespace(combined_selection_warning=self.warning),
            'agent.models_dev': SimpleNamespace(get_model_capabilities=self.meta),
        }
        self.scoped = patch.object(models, 'profile_scope', side_effect=lambda _: nullcontext())
        self.modules = patch.dict('sys.modules', modules)
        self.scoped.start(); self.modules.start()
        self.addCleanup(self.scoped.stop); self.addCleanup(self.modules.stop)

    def test_catalogue_preserves_defaults_modes_and_does_not_disclose_credentials(self):
        value = models.options('default')
        self.assertEqual(value['defaults']['fastMode'], 'auto')
        self.assertEqual(value['models'][0]['fastModes'], ['normal','fast','auto','cold'])
        self.assertNotIn('fixture-secret', json.dumps(value))

    def test_inheritance_and_explicit_none_are_distinct_and_resolution_never_writes(self):
        value = models.resolve('default', {'provider': None, 'model': None, 'reasoningEffort': 'none', 'fastMode': 'cold'})
        self.assertEqual(value['effective'], {'provider':'openai','model':'model-a','reasoningEffort':'none','fastMode':'cold'})
        self.assertFalse(self.switch.call_args.kwargs['is_global'])
        self.assertEqual(self.switch.call_args.kwargs['current_api_key'], 'fixture-secret')
        self.assertNotIn('fixture-secret', json.dumps(value))
        self.config['agent'].update(reasoning_effort=False, service_tier='normal')
        self.assertEqual(models.resolve('default', None)['effective']['reasoningEffort'], 'none')

    def test_proxy_route_rejects_all_accelerated_modes(self):
        self.ctx.current_base_url = 'https://proxy.invalid/v1'
        for speed in ['fast','auto','cold']:
            with self.subTest(speed=speed), self.assertRaises(models.ModelSettingsError):
                models.resolve('default', {'fastMode': speed})
        self.assertEqual(models.resolve('default', {'fastMode':'normal'})['effective']['fastMode'], 'normal')

    def test_copilot_and_mandatory_reasoning_restrict_levels(self):
        with self.assertRaises(models.ModelSettingsError):
            models.resolve('default', {'provider':'copilot','model':'model-a','reasoningEffort':'ultra'})
        self.reader.return_value = {'supports_reasoning':True,'mandatory':True}
        with self.assertRaises(models.ModelSettingsError):
            models.resolve('default', {'reasoningEffort':'none'})

    def test_unknown_capabilities_remain_unknown(self):
        self.meta.return_value = None
        value = models.options('default')['models'][0]
        self.assertFalse(value['reasoningKnown'])
        self.assertIn('ultra', value['reasoningEfforts'])

    def test_invalid_pair_and_switch_failure_stop_resolution_without_secrets(self):
        for settings in [{'model':'model-b'}, {'provider':'openai','model':'bad --global'}, {'fastMode':'turbo'}, {'config':{}}]:
            with self.subTest(settings=settings), self.assertRaises(models.ModelSettingsError): models.resolve('default',settings)
        self.switch.side_effect = None
        self.switch.return_value = SimpleNamespace(success=False, error_message='fixture-secret')
        with self.assertRaises(models.ModelSettingsError) as exc: models.resolve('default',None)
        self.assertNotIn('fixture-secret', str(exc.exception))

    def test_confirmation_is_returned_without_applying_any_change(self):
        self.warning.return_value = SimpleNamespace(message='模型费用较高')
        self.assertEqual(models.resolve('default',{})['confirmationMessage'], '模型费用较高')


if __name__ == '__main__': unittest.main()
