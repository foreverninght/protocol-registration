import base64
import contextlib
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "vendor/freepp/backend"))
from reg import chatgpt_core as real_core
import setup_openai_totp_2fa as twofa


def load_bridge():
    spec = importlib.util.spec_from_file_location("bridge_contract_fixture", ROOT / "tools/freepp_register_bridge.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def core_fixture(bridge, mode="normal"):
    core = types.ModuleType("reg.chatgpt_core")
    core.start_nextauth_openai_oauth = lambda *a, **k: None
    core.finish_nextauth_access_token = lambda *a, **k: ("", "")
    channel = {}
    core.register_email_channel = lambda name, setup: channel.update(setup=setup)

    def run(*args, **kwargs):
        email, password, fetch = channel["setup"](None)
        if mode in ("otp", "two_phase", "wait", "provider_error", "final_timeout", "delay"):
            if mode in ("two_phase", "final_timeout", "provider_error"):
                with patch.object(real_core, "_resend_email_otp", side_effect=lambda *a: bridge._event("fixture_resend") or True):
                    code = real_core._wait_otp_imap_two_phase(
                        fetch, None, "did", "ua", "fp", phase1_sec=1, phase2_sec=1,
                        otp_issued_at=time.time() - 1,
                    )
            else:
                code = fetch(timeout_sec=10 if mode == "wait" else 1)
            bridge._event("fixture_code_received", code=code, email=email)
        return None, email, password, "AT-" + email, "ST-" + email

    core.run = run
    core.login_with_password = lambda *a, **k: None
    reg = types.ModuleType("reg")
    reg.chatgpt_core = core
    return core, {"reg": reg, "reg.chatgpt_core": core}


def run_main(bridge, core_modules, config, events=None, final_validation_error=None):
    output = io.StringIO()
    config = {"email": "offline@example.test", "password": " FixturePassword1! ",
              "proxy": {"host": "fixture.invalid", "port": 1}, **config}
    with patch.dict(sys.modules, core_modules), patch.object(bridge, "PROTOCOL_OUT", output), \
            patch.object(bridge, "_event", side_effect=lambda step, **payload: events.append((step, payload)) if events is not None else None), \
            patch.object(bridge, "_validate_live_access_token", return_value={"status": "valid"}, side_effect=final_validation_error), \
            patch.object(bridge, "_chatgpt_session_context", return_value={}):
        encoded = base64.b64encode(json.dumps(config).encode()).decode()
        code = bridge.main(["--config-b64", encoded])
    return code, json.loads(output.getvalue())


class BridgeContracts(unittest.TestCase):
    def setUp(self):
        self.network = patch.object(socket.socket, "connect", side_effect=AssertionError("external network forbidden"))
        self.network.start()
        self.addCleanup(self.network.stop)
        self.bridge = load_bridge()
        self.core, self.modules = core_fixture(self.bridge)

    def test_stdin_initialization_consumes_exactly_one_line(self):
        config = {"password": " FixturePassword1! ", "credential_repair": {"totp": {"secret": "fixture-secret"}}}
        stream = io.StringIO(json.dumps({"type": "init", "config": config}) + "\n" + '{"id":"rpc","ok":true}\n')
        with patch.object(self.bridge.sys, "stdin", stream):
            self.assertEqual(self.bridge._load_stdin_config(), config)
            self.assertEqual(json.loads(stream.readline())["id"], "rpc")
        for invalid in ("", "not-json", '{"type":"event","config":{}}', '{"type":"init","config":[]}'):
            with patch.object(self.bridge.sys, "stdin", io.StringIO(invalid)), self.assertRaises(ValueError):
                self.bridge._load_stdin_config()

    def test_registration_password_setup_has_independent_repair_state(self):
        with patch.object(self.bridge, "_setup_post_login_password", return_value={"created": True}) as setup:
            rc, result = run_main(self.bridge, self.modules, {"setup_password": True})
        self.assertEqual(rc, 0)
        self.assertEqual(result["password_status"], "has_password")
        self.assertIsNone(result["password_error"])
        self.assertEqual(setup.call_args.kwargs["totp_secret"], "")
        self.assertEqual(setup.call_args.kwargs["password"], " FixturePassword1! ")
        self.assertEqual(result["password"], " FixturePassword1! ")

    def test_late_completion_failures_keep_successful_credentials(self):
        totp = twofa.Totp2faResult(True, "JBSWY3DPEHPK3PXP", "enrollment", "factor", {}, {}, {},
                                   activated=True, verified=True)
        for kind in ("final_at", "strict_change"):
            with patch.object(self.bridge, "_setup_post_login_password", return_value={"created": True}), \
                    patch.object(twofa, "setup_totp_2fa", return_value=totp), \
                    patch.object(self.bridge, "_change_registered_email", side_effect=RuntimeError("fixture email failure")):
                config = {"setup_password": True, "setup_totp": True,
                          "change_email": {"enabled": kind == "strict_change", "failRegistrationOnError": True}}
                _, result = run_main(self.bridge, self.modules, config,
                    final_validation_error=TimeoutError("fixture AT failure") if kind == "final_at" else None)
            self.assertTrue(result["ok"])
            self.assertEqual(result["password_status"], "has_password")
            self.assertEqual(result["password"], " FixturePassword1! ")
            self.assertEqual(result["totp"]["secret"], "JBSWY3DPEHPK3PXP")
            self.assertEqual(result["access_token"], "AT-offline@example.test")
            self.assertEqual(result["session_token"], "ST-offline@example.test")
            self.assertFalse(result["completion_error"]["retryable_proxy"])
            expected = "FREEPP_FINAL_AT_VALIDATION_FAILED" if kind == "final_at" else "FREEPP_CHANGE_EMAIL_FAILED"
            self.assertEqual(result["completion_error"]["code"], expected)
            if kind == "final_at":
                self.assertEqual(result["final_at_validation"]["status"], "invalid")

    def test_confirmed_changed_email_survives_later_failure(self):
        def changed_then_failed(*args, result_state, **kwargs):
            result_state.update({"changed": True, "changed_email": "changed@example.test", "status": "changed"})
            raise RuntimeError("post-change event failed")
        with patch.object(self.bridge, "_change_registered_email", side_effect=changed_then_failed):
            _, result = run_main(self.bridge, self.modules, {"change_email": {"enabled": True, "failRegistrationOnError": True}},
                                 final_validation_error=TimeoutError("AT failed after email changed"))
        self.assertEqual(result["login_email"], "changed@example.test")
        self.assertTrue(result["email_change"]["changed"])
        self.assertEqual(result["completion_error"]["code"], "FREEPP_CHANGE_EMAIL_FAILED")
        self.assertEqual(result["final_at_validation"]["status"], "invalid")

    def test_changed_mailbox_credentials_are_private_and_survive_session_refresh(self):
        mailbox = {"address": "changed@example.test", "base_url": "https://mailbox.invalid", "token": "private-fixture-token", "inbox_url": "https://mailbox.invalid/inbox"}
        session = types.SimpleNamespace(get=lambda *a, **k: types.SimpleNamespace(status_code=200))
        with patch.object(self.bridge, "_create_change_email_mailbox", return_value=mailbox), \
                patch.object(self.bridge, "_event"), patch.object(self.bridge, "_chatgpt_backend_headers", return_value={}), \
                patch.object(self.bridge, "_post_json_candidates", return_value={"status": 200}), \
                patch.object(self.bridge, "_poll_change_email_code", return_value="123456"):
            public_result = self.bridge._change_registered_email(self.core, session, current_email="old@example.test",
                access_token="AT", config={"enabled": True})
        private = self.bridge._LAST_CHATGPT_SESSION_CONTEXT["changedEmailMailbox"]
        self.assertEqual(private, {"email": mailbox["address"], "base_url": mailbox["base_url"], "token": mailbox["token"]})
        self.assertNotIn(mailbox["token"], json.dumps(public_result))
        self.assertNotIn("token", public_result["mailbox"])
        with patch.object(self.bridge, "_restore_nextauth_state_cookies", return_value=0), \
                patch.object(self.bridge, "_oauth_session_context", return_value={}), \
                patch.object(self.bridge, "_chatgpt_session_context", return_value={"user_agent": "fixture"}), \
                contextlib.redirect_stdout(io.StringIO()):
            self.bridge._patch_nextauth_state_cookie_guard(self.core)
            self.core.finish_nextauth_access_token(session, "https://fixture.invalid/callback")
        self.assertEqual(self.bridge._LAST_CHATGPT_SESSION_CONTEXT["changedEmailMailbox"], private)

    def test_existing_password_requires_verified_login(self):
        state = {"email": "offline@example.test", "password": "WRONGPassword1!", "password_status": "no_password",
                 "cookie_count": 1, "access_token": "OLD-AT", "session_token": "OLD-ST", "token_data": {}, "totp": None}
        with patch.object(self.bridge, "_credential_repair_state", return_value=state), \
                patch.object(self.bridge, "_setup_post_login_password", return_value={"created": False, "already_set": True}):
            _, result = run_main(self.bridge, self.modules, {"credential_repair": {"setup_password": True}})
        self.assertEqual(result["password_status"], "no_password")
        self.assertEqual(result["password_error"]["code"], "PASSWORD_UNVERIFIED")
        self.assertEqual(result["access_token"], "OLD-AT")

    def test_existing_password_verified_login_can_complete(self):
        state = {"email": "offline@example.test", "password": "Password1!Valid", "password_status": "no_password",
                 "cookie_count": 1, "access_token": "OLD-AT", "session_token": "OLD-ST", "token_data": {}, "totp": None}
        self.core.login_with_password = unittest.mock.Mock(side_effect=[None, (state["email"], "NEW-AT", "NEW-ST")])
        with patch.object(self.bridge, "_credential_repair_state", return_value=state), \
                patch.object(self.bridge, "_setup_post_login_password", return_value={"created": False, "already_set": True}):
            _, result = run_main(self.bridge, self.modules, {"credential_repair": {"setup_password": True}})
        self.assertEqual(result["password_status"], "has_password")
        self.assertIsNone(result["password_error"])
        self.assertEqual(result["access_token"], "NEW-AT")

    def test_totp_partial_activation_keeps_secret_and_error(self):
        client = twofa.OpenAITotp2faClient("fixture-token")
        with patch.object(client, "enroll", return_value=("FIXTURE_SECRET", "session", {})), \
                patch.object(client, "activate", return_value={"success": True}), \
                patch.object(client, "mfa_info", side_effect=[{}, {}, TimeoutError("final read timeout")]):
            partial = client.setup_totp()
        self.assertTrue(partial.activated)
        self.assertFalse(partial.verified)
        self.assertFalse(partial.success)
        self.assertEqual(partial.secret, "FIXTURE_SECRET")
        with patch.object(twofa, "setup_totp_2fa", return_value=partial):
            _, result = run_main(self.bridge, self.modules, {"setup_totp": True})
        self.assertEqual(result["totp"]["secret"], "FIXTURE_SECRET")
        self.assertEqual(result["totp_error"]["code"], "TOTP_VERIFICATION_PENDING")
        self.assertFalse(result["totp"]["verified"])

    def test_activation_response_timeout_preserves_ambiguous_secret(self):
        client = twofa.OpenAITotp2faClient("fixture-token")
        server = {"active": False}
        def activate(*args):
            server["active"] = True
            raise TimeoutError("activation response lost")
        with patch.object(client, "enroll", return_value=("JBSWY3DPEHPK3PXP", "enrollment", {})), \
                patch.object(client, "activate", side_effect=activate), \
                patch.object(client, "mfa_info", side_effect=[{}, {}]):
            result = client.setup_totp()
        self.assertTrue(server["active"])
        self.assertIsNone(result.activated)
        self.assertFalse(result.verified)
        self.assertEqual(result.secret, "JBSWY3DPEHPK3PXP")
        self.assertEqual(result.enrollment_session_id, "enrollment")
        self.assertEqual(result.verification_error["code"], "TOTP_VERIFICATION_PENDING")

    def test_post_enrollment_failure_preserves_resumable_material(self):
        client = twofa.OpenAITotp2faClient("fixture-token")
        with patch.object(client, "enroll", return_value=("JBSWY3DPEHPK3PXP", "enrollment", {})), \
                patch.object(client, "activate") as activate, \
                patch.object(client, "mfa_info", side_effect=[{}, TimeoutError("after enroll")]):
            result = client.setup_totp()
        activate.assert_not_called()
        self.assertEqual(result.secret, "JBSWY3DPEHPK3PXP")
        self.assertFalse(result.verified)

    def totp_session(self, *, bad_code=False, pending=False):
        def response(data, status=200):
            return types.SimpleNamespace(status_code=status, text=json.dumps(data), json=lambda: data)
        active = response({"factors": {"totp": [{"id": "factor"}]}})
        calls = []
        def post(url, **kwargs):
            calls.append(url)
            self.assertNotEqual(url, twofa.MFA_ENROLL_URL)
            if url.endswith("/mfa/verify") and bad_code:
                return response({"error": {"code": "invalid_code"}}, 400)
            return response({"success": True})
        session = types.SimpleNamespace(headers={}, cookies={}, post=post,
            get=unittest.mock.Mock(side_effect=[response({}), active] if pending else [active]))
        return session, calls

    def test_saved_secret_reverified_without_enrollment(self):
        for bad_code in (False, True):
            session, calls = self.totp_session(bad_code=bad_code)
            with patch.object(self.bridge, "_event"), patch.object(self.bridge, "_chatgpt_session_context", return_value={"oai_device_id": "fixture"}):
                result = self.bridge._verify_saved_totp(real_core, session, "AT", "http://fixture.invalid:1",
                    {"secret": "JBSWY3DPEHPK3PXP", "activated": None})
            self.assertEqual(result["verified"], not bad_code)
            self.assertTrue(result["activated"])
            self.assertEqual(result["secret"], "JBSWY3DPEHPK3PXP")
            self.assertTrue(any(url.endswith("/mfa/issue_challenge") for url in calls))
            self.assertTrue(any(url.endswith("/mfa/verify") for url in calls))
            self.assertNotIn(twofa.MFA_ENROLL_URL, calls)
            self.assertEqual(result["verification_error"] is None, not bad_code)

    def test_saved_enrollment_resumed_without_new_secret(self):
        session, calls = self.totp_session(pending=True)
        with patch.object(self.bridge, "_event"), patch.object(self.bridge, "_chatgpt_session_context", return_value={}):
            result = self.bridge._verify_saved_totp(real_core, session, "AT", "http://fixture.invalid:1",
                {"secret": "JBSWY3DPEHPK3PXP", "enrollment_session_id": "enrollment", "activated": None})
        self.assertTrue(result["verified"])
        self.assertEqual(result["secret"], "JBSWY3DPEHPK3PXP")
        self.assertEqual(calls, [twofa.MFA_ACTIVATE_URL])

    def test_repair_main_verifies_existing_secret_instead_of_enrolling(self):
        session, calls = self.totp_session()
        self.bridge._LAST_CHATGPT_SESSION = session
        for name in ("_session_ua", "_session_accept_language", "_make_trace_headers", "_session_impersonate"):
            setattr(self.core, name, getattr(real_core, name))
        state = {"email": "offline@example.test", "password": "Password1!Valid", "password_status": "has_password",
                 "cookie_count": 1, "access_token": "OLD-AT", "session_token": "OLD-ST", "token_data": {},
                 "totp": {"secret": "JBSWY3DPEHPK3PXP", "activated": None, "verified": False}}
        with patch.object(self.bridge, "_credential_repair_state", return_value=state), patch.object(twofa, "setup_totp_2fa") as enroll:
            _, result = run_main(self.bridge, self.modules, {"credential_repair": {"setup_totp": True}})
        enroll.assert_not_called()
        self.assertTrue(result["totp"]["verified"])
        self.assertIsNone(result["totp_error"])
        self.assertEqual(result["totp"]["secret"], "JBSWY3DPEHPK3PXP")

    def test_totp_complete_and_missing_factor_are_distinct(self):
        for final_info, verified in [({"factors": {"totp": [{"id": "factor"}]}}, True), ({}, False)]:
            client = twofa.OpenAITotp2faClient("fixture-token")
            with patch.object(client, "enroll", return_value=("FIXTURE_SECRET", "session", {})), \
                    patch.object(client, "activate", return_value={"success": True}), \
                    patch.object(client, "mfa_info", side_effect=[{}, {}, final_info]):
                result = client.setup_totp()
            self.assertEqual(result.verified, verified)
            self.assertTrue(result.activated)
            self.assertEqual(result.secret, "FIXTURE_SECRET")

    def test_core_password_preserves_whitespace(self):
        password = "  FixturePassword1!  "
        class StopFixture(Exception):
            pass
        original = real_core.choose_fp
        def capture(*args, **kwargs):
            self.assertEqual(inspect.currentframe().f_back.f_locals["password"], password)
            raise StopFixture()
        try:
            real_core.choose_fp = capture
            with self.assertRaises(StopFixture):
                real_core.login_with_password(None, "offline@example.test", password)
        finally:
            real_core.choose_fp = original

    def test_real_login_requires_password_endpoint_for_password_verification(self):
        from requests.cookies import RequestsCookieJar
        for final_url, expected in [
            ("https://auth.openai.com/email-verification", False),
            ("https://chatgpt.com/api/auth/callback/openai?code=fixture&state=fixture", False),
            ("https://auth.openai.com/log-in/password", True),
        ]:
            response = types.SimpleNamespace(status_code=200, url=final_url, close=lambda: None)
            verify = types.SimpleNamespace(status_code=200, json=lambda: {"continue_url": "https://chatgpt.com/callback"})
            session = types.SimpleNamespace(headers={}, cookies=RequestsCookieJar(), request=lambda *a, **k: None,
                                            get=unittest.mock.Mock(return_value=response), post=unittest.mock.Mock(return_value=verify))
            fp = {"ua": "fixture", "impersonate": "chrome", "chrome_fp": {}}
            with patch.object(real_core.requests, "Session", return_value=session), \
                    patch.object(real_core, "choose_fp", return_value=fp), \
                    patch.object(real_core, "_fp_summary", return_value="fixture"), \
                    patch.object(real_core, "_human_delay"), \
                    patch.object(real_core, "start_nextauth_openai_oauth", return_value=types.SimpleNamespace(auth_url="https://fixture.invalid/authorize")), \
                    patch.object(real_core, "finish_nextauth_access_token", return_value=("AT", "ST")), \
                    patch.object(real_core.sentinel_sdk, "sentinel_for", return_value={"ok": False}), \
                    contextlib.redirect_stdout(io.StringIO()):
                result = real_core.login_with_password(None, "offline@example.test", "  ExactPassword1!  ", require_password=True)
            self.assertEqual(bool(result), expected)
            if expected:
                self.assertEqual(json.loads(session.post.call_args.kwargs["data"])["password"], "  ExactPassword1!  ")
            else:
                session.post.assert_not_called()

    def test_delay_heartbeats_and_cancel_are_interruptible(self):
        clock = [0.0]
        events = []
        class FakeCancel:
            def is_set(self):
                return False
            def wait(self, seconds):
                clock[0] += seconds
                return False
        with patch.object(self.bridge.time, "monotonic", side_effect=lambda: clock[0]), \
                patch.object(self.bridge, "_event", side_effect=lambda step, **kw: events.append((clock[0], step))):
            self.bridge._post_registration_delay(600, FakeCancel())
        self.assertEqual(len(events), 60)
        self.assertEqual(events[-1][0], 600)
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.bridge._post_registration_delay(600, cancelled)


def ipc_main():
    original_stdin = sys.stdin
    initialization = original_stdin.readline()
    mode = json.loads(initialization)["config"]["mailbox_source"]
    class ReplayInitialization:
        def __init__(self):
            self.first_line = initialization
        def readline(self):
            if self.first_line is not None:
                line, self.first_line = self.first_line, None
                return line
            return original_stdin.readline()
    sys.stdin = ReplayInitialization()
    bridge = load_bridge()
    core, modules = core_fixture(bridge, mode)
    bridge._validate_live_access_token = lambda *a: {"status": "valid"}
    bridge._chatgpt_session_context = lambda *a: {}
    if mode in ("repair_password_mfa", "repair_changed_otp", "repair_changed_otp_private"):
        from requests.cookies import RequestsCookieJar
        def response(data=None, url=""):
            data = data or {}
            return types.SimpleNamespace(status_code=200, text=json.dumps(data), json=lambda: data,
                                         url=url, close=lambda: None, headers={})
        def get(url, **kwargs):
            if url == twofa.MFA_INFO_URL:
                return response({"factors": {"totp": [{"id": "fixture-factor"}]}})
            final_url = "https://auth.openai.com/email-verification" if mode.startswith("repair_changed_otp") else "https://auth.openai.com/log-in/password"
            return response(url=final_url)
        def post(url, **kwargs):
            if url.endswith("/email-otp/validate"):
                assert json.loads(kwargs["data"])["code"] == "654321"
                return response({"continue_url": "https://auth.openai.com/mfa-challenge/fixture-factor"})
            if url.endswith("/password/verify"):
                return response({"continue_url": "https://auth.openai.com/mfa-challenge/fixture-factor"})
            if url.endswith("/mfa/issue_challenge"):
                return response({"success": True})
            if url.endswith("/mfa/verify"):
                return response({"success": True, "continue_url": "https://chatgpt.com/callback?code=fixture&state=fixture"})
            raise AssertionError("unexpected fixture POST " + url)
        session = types.SimpleNamespace(headers={}, cookies=RequestsCookieJar(), get=get, post=post, request=lambda *a, **k: None)
        def repair_state(core_arg, config, proxy):
            saved = config["credential_repair"]
            bridge._LAST_CHATGPT_SESSION = session
            bridge._LAST_CHATGPT_SESSION_CONTEXT.update(saved.get("session_context") or {})
            return {"email": saved["email"], "password": saved["password"], "password_status": saved["password_status"],
                    "cookie_count": 0, "access_token": "OLD-AT", "session_token": "OLD-ST", "token_data": {}, "totp": saved.get("totp")}
        bridge._credential_repair_state = repair_state
        for name in ("_session_ua", "_session_accept_language", "_make_trace_headers", "_session_impersonate"):
            setattr(core, name, getattr(real_core, name))
        def login(proxy, email, password, **kwargs):
            bridge._event("fixture_repair_login", email=email)
            fp = {"ua": "fixture", "impersonate": "chrome", "chrome_fp": {}}
            with patch.object(real_core.requests, "Session", return_value=session), \
                    patch.object(real_core, "choose_fp", return_value=fp), \
                    patch.object(real_core, "_fp_summary", return_value="fixture"), \
                    patch.object(real_core, "_human_delay"), \
                    patch.object(real_core, "start_nextauth_openai_oauth", return_value=types.SimpleNamespace(auth_url="https://fixture.invalid/authorize")), \
                    patch.object(real_core, "finish_nextauth_access_token", return_value=("REPAIRED-AT", "REPAIRED-ST")), \
                    patch.object(real_core.sentinel_sdk, "sentinel_for", return_value={"ok": False}):
                return real_core.login_with_password(proxy, email, password, **kwargs)
        core.login_with_password = login
        if mode == "repair_changed_otp_private":
            mailbox_reads = [0]
            def mailbox_api(method, base_url, api_path, token, payload):
                assert method == "GET" and base_url == "https://mailbox.invalid"
                assert token == "private-fixture-token"
                assert api_path == "/v1/messages?address=changed%40example.test&limit=20"
                mailbox_reads[0] += 1
                bridge._event("fixture_private_mailbox_read", count=mailbox_reads[0])
                old = {"id": "old", "text": "verification code 123456"}
                return {"results": [old] if mailbox_reads[0] == 1 else [old, {"id": "new", "text": "verification code 654321"}]}
            bridge._domain_mailbox_api_json = mailbox_api
    if mode == "delay":
        original_delay = bridge._post_registration_delay
        def accelerated_delay(seconds, cancelled):
            clock = [0.0]
            class AdvancingCancel:
                def is_set(self):
                    return cancelled.is_set()
                def wait(self, interval):
                    clock[0] += interval
                    return cancelled.is_set()
            with patch.object(bridge.time, "monotonic", side_effect=lambda: clock[0]):
                original_delay(seconds, AdvancingCancel())
        bridge._post_registration_delay = accelerated_delay
    if mode in ("late_at", "strict_change"):
        bridge._setup_post_login_password = lambda *a, **k: {"created": True}
        twofa.setup_totp_2fa = lambda *a, **k: twofa.Totp2faResult(
            True, "JBSWY3DPEHPK3PXP", "enrollment", "factor", {}, {}, {}, activated=True, verified=True)
        def late_failure(*args, **kwargs):
            raise TimeoutError("fixture late completion failure")
        if mode == "late_at":
            bridge._validate_live_access_token = late_failure
        else:
            bridge._change_registered_email = late_failure
    if mode == "totp_partial":
        twofa.setup_totp_2fa = lambda *a, **k: twofa.Totp2faResult(
            success=False, secret="JBSWY3DPEHPK3PXP", enrollment_session_id="fixture-enrollment",
            active_factor_id="", before={}, after_enroll={}, after_activate={},
            activated=None, verified=False,
            verification_error={"code": "TOTP_VERIFICATION_PENDING", "message": "activation response lost"},
        )
    with patch.dict(sys.modules, modules), patch.object(socket.socket, "connect", side_effect=AssertionError("external network forbidden")):
        return bridge.main(sys.argv[2:])


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--ipc":
        raise SystemExit(ipc_main())
    unittest.main()
