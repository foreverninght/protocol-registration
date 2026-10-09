import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class PythonDependencyClosureTests(unittest.TestCase):
    def run_isolated(self, flavor, body):
        backend = ROOT / "vendor" / flavor / "backend"
        preamble = f"""
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, {str(backend)!r})
sys.path.insert(0, {str(ROOT / 'tools')!r})
sys.path.insert(0, {str(ROOT / 'python' / 'rebind_worker')!r})
def offline(event, args):
    if event.startswith('socket.') or event in ('subprocess.Popen', 'os.system'):
        raise RuntimeError('Network/process execution disabled: ' + event)
sys.addaudithook(offline)
from unittest.mock import Mock, patch
from contextlib import ExitStack
with ExitStack() as guards:
    for target in ('curl_cffi.requests.Session.request', 'requests.sessions.Session.request', 'urllib.request.urlopen'):
        guards.enter_context(patch(target, side_effect=AssertionError('Network disabled')))
"""
        script = textwrap.dedent(preamble) + textwrap.indent(textwrap.dedent(body), "    ")
        env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1", FREEPP_BACKEND_DIR=str(backend))
        for key in ('PYTHONPATH', 'PYTHONHOME', 'MIN_CONFIG_PATH', 'MIN_BACKEND_DIR'):
            env.pop(key, None)
        with tempfile.TemporaryDirectory() as cwd:
            result = subprocess.run(
                [sys.executable, "-B", "-c", script], cwd=cwd, env=env,
                capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_freepp_backend_imports_in_offline_process(self):
        for flavor in ('freepp',):
            with self.subTest(flavor=flavor):
                self.run_isolated(flavor, """
                    import importlib
                    from pathlib import Path
                    import core, reg
                    backend = Path(reg.__file__).resolve().parent.parent
                    for package in ('core', 'reg'):
                        for source in sorted((backend / package).glob('*.py')):
                            if source.stem != '__init__':
                                module = importlib.import_module(package + '.' + source.stem)
                                assert Path(module.__file__).resolve().is_relative_to(backend)
                    from reg import engine, chatgpt_core, channel_imap, provider_stats
                    assert callable(engine.stream_registration)
                    assert callable(channel_imap.build_channel)
                    assert callable(chatgpt_core.run)
                    assert callable(chatgpt_core.login_with_password)
                    assert callable(provider_stats.record)
                    import freepp_register_bridge as bridge
                    import setup_openai_totp_2fa as totp
                    import renew_chatgpt_session_cookie
                    import openai_phone_bind_protocol
                    assert callable(totp.setup_totp_2fa)
                    bridge._patch_nextauth_state_cookie_guard(chatgpt_core)
                """)

    def test_main_backend_token_exchange_reuses_session_without_direct_fallback(self):
        self.run_isolated('freepp', """
            import json
            from reg import chatgpt_core as core
            from reg.registration_context import RegistrationContext
            context = RegistrationContext.create('http://localhost:7890', 'test-device', core.choose_fp(seed='test'))
            session = core._new_registration_session(context)
            try:
                response = Mock(status_code=200)
                response.json.return_value = {'access_token': 'test-token'}
                with patch.object(session, 'post', return_value=response) as post:
                    result = core.submit_callback_url(session=session, callback_url='http://localhost/cb?code=test&state=state', expected_state='state', code_verifier='test')
                    assert json.loads(result)['access_token'] == 'test-token'
                    post.assert_called_once()
                    assert post.call_args.args[0] == core.TOKEN_URL
                    assert post.call_args.kwargs['allow_redirects'] is False
                    context.assert_session(session)
                for failure in (RuntimeError('proxy failed'), Mock(status_code=503), Mock(status_code=302)):
                    with patch.object(session, 'post') as post:
                        if isinstance(failure, Exception):
                            post.side_effect = failure
                        else:
                            post.return_value = failure
                        try:
                            core._post_form(core.TOKEN_URL, {}, session=session)
                        except RuntimeError:
                            pass
                        else:
                            raise AssertionError('Exchange failure must propagate')
                        post.assert_called_once()
            finally:
                session.close()
        """)

    def test_bridge_default_backend_is_packaged_and_requires_explicit_proxy(self):
        self.run_isolated('freepp', """
            import contextlib, io, json
            import freepp_register_bridge as bridge
            output = io.StringIO()
            with patch.object(bridge, 'PROTOCOL_OUT', output), contextlib.redirect_stdout(io.StringIO()):
                status = bridge.main([])
            assert status == 2
            result = json.loads(output.getvalue().strip().splitlines()[-1])
            assert 'FREEPP_PROXY_REQUIRED' in result['error']
        """)

    def test_qualification_worker_imports_and_bundled_assets_are_self_contained(self):
        self.run_isolated('freepp', """
            import importlib
            from pathlib import Path
            import worker
            import runtime, recovery_runtime, trial_runtime, trial_session
            from registration_core import sentinel_quickjs, sentinel_sdk
            worker_root = Path(worker.__file__).resolve().parent
            for package in ('registration_core', 'rebind_core'):
                for source in sorted((worker_root / package).glob('*.py')):
                    if source.stem != '__init__':
                        importlib.import_module(package + '.' + source.stem)
            with patch.dict('os.environ', {'OPENAI_SENTINEL_SDK_FILE': '', 'OPENAI_SENTINEL_VERSION': '', 'OPENAI_SENTINEL_SDK_URL': '', 'OPENAI_SENTINEL_SDK_SHA256': ''}):
                sdk = sentinel_quickjs._ensure_sdk_file(Mock(), 1000)
                assert sdk.is_relative_to(worker_root)
                assert sentinel_sdk.validate_sdk(sdk.read_bytes()) == sentinel_sdk.BUNDLED_SHA256
            assets = worker_root / 'registration_core' / 'sentinel_assets'
            assert (assets / 'public_bridge.js').is_file()
            assert (assets / 'sentinel_bootstrap.js').is_file()
        """)

    def test_all_python_sources_compile_without_execution(self):
        roots = [ROOT / 'tools', ROOT / 'vendor', ROOT / 'python']
        for root in roots:
            for source in root.rglob('*.py'):
                with self.subTest(source=str(source.relative_to(ROOT))):
                    compile(source.read_text(encoding='utf-8-sig'), str(source), 'exec')


if __name__ == '__main__':
    unittest.main()
