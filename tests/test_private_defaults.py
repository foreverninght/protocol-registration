import importlib.util
import os
from pathlib import Path
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]

def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'tools' / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PrivateDefaultsTests(unittest.TestCase):
    def test_phone_service_requires_explicit_configuration(self):
        tool = load_tool('openai_phone_bind_protocol')
        self.assertEqual(tool.SUB2_ORIGIN, '')
        for value in ['', ' ', 'file:///fixture', 'https://fixture:fixture@service.example.test']:
            with self.assertRaises(ValueError):
                tool.clean_base_url(value)
        self.assertEqual(tool.clean_base_url(' https://service.example.test/ '), 'https://service.example.test')

    def test_missing_probe_service_never_contacts_an_implicit_endpoint(self):
        bridge = load_tool('freepp_register_bridge')
        self.assertEqual(bridge._probe_base_url(''), '')
        class NoNetwork:
            def post(self, *args, **kwargs):
                raise AssertionError('No endpoint configured: network must not be used')
        with patch.dict(os.environ, {}, clear=True), patch.object(bridge, '_PHONE_BIND_PROBE_CONFIG', {'sub2AdminApiKey': 'fixture-key'}):
            result = bridge._run_phone_bind_probe_once(types.SimpleNamespace(), NoNetwork())
        self.assertTrue(result['skipped'])
        self.assertEqual(result['reason'], 'sub2_base_url_missing_or_invalid')


if __name__ == '__main__':
    unittest.main()
