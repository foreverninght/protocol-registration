import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from runtime import WorkerError, run
from rebind_core import mfa_login as login
from registration_core.auth_flow import AuthFlow, AuthResult
from registration_core.config import Config
from rebind_core.change_email import ChangeEmailClient, ChangeEmailError, _response_object
from registration_core.sentinel_quickjs import _ensure_sdk_file

CALLBACK = "https://chatgpt.com/api/auth/callback/openai?code=fixture&state=fixture"


def auth_fixture():
    auth = Mock()
    auth.result = AuthResult()
    auth.session.cookies = {}
    auth._normalize_continue_url.side_effect = lambda v: v or ""
    auth._extract_page_type.side_effect = lambda v: v.get("page", {}).get("type", "")
    auth._extract_continue_url_from_step.side_effect = lambda v: v.get("continue_url", "")
    auth.authorize_continue.return_value = {"page": {"type": "login_password"}}
    auth.login_password_verify.return_value = {"factors": [{"type": "totp", "id": "fixture"}]}
    def session():
        auth.result.access_token = "fixture-at"
        auth.result.session_token = "fixture-st"
    auth.get_auth_session.side_effect = session
    return auth


class WorkerTests(unittest.TestCase):
    def test_real_auth_constructor_and_change_email_import(self):
        with patch("curl_cffi.requests.Session.request", side_effect=AssertionError("network forbidden")):
            auth = AuthFlow(Config(proxy="http://127.0.0.1:9"))
            try:
                self.assertFalse(auth.session.trust_env)
                self.assertEqual(auth.session.proxies["https"], "http://127.0.0.1:9")
                self.assertTrue(callable(ChangeEmailClient))
            finally:
                auth.close()

    def test_change_email_rejects_explicit_errors(self):
        for payload in [{"success": False}, {"ok": False}, {"error": "fixture"}, []]:
            response = Mock(text="fixture")
            response.json.return_value = payload
            with self.assertRaises(ChangeEmailError):
                _response_object(response, "VERIFY_FAILED")

    def session(self, email, account="account"):
        return SimpleNamespace(account_id=account, factor_id="factor", session_token="session",
            access_token="access", auth=Mock(), result=SimpleNamespace(auth_session_json=json.dumps({"user": {"email": email}})))

    def execute(self, new=None):
        request = {"credentials": {"email": "old@example.test", "password": " password ", "totpSecret": "SECRET"},
                   "newEmail": "new@example.test", "proxy": "http://fixture.invalid:8080"}
        old = self.session("old@example.test")
        fresh = new or self.session("new@example.test")
        login_fn = Mock(side_effect=[old, fresh])
        client = Mock()
        client.eligibility.return_value = {"eligible": True}
        events = []
        result = run(request, events.append, lambda: {"type": "code", "code": "123456"},
                     login_fn, Mock(return_value=client))
        return result, events, login_fn, client, old, fresh

    def test_flow_new_login_and_strict_result(self):
        result, events, login_fn, client, old, fresh = self.execute()
        self.assertEqual(result["password"], " password ")
        self.assertTrue(result["mfaVerified"])
        self.assertEqual(result["accountId"], result["originalAccountId"])
        self.assertEqual([c.args[0] for c in login_fn.call_args_list], ["old@example.test", "new@example.test"])
        self.assertEqual(events[3]["type"], "need_code")
        self.assertGreater(events[3]["issuedAfter"], 1000000000000)
        client.verify.assert_called_once_with("new@example.test", "123456")
        old.auth.close.assert_called_once()
        fresh.auth.close.assert_called_once()

    def test_identity_mismatch_and_missing_session_email_fail_closed(self):
        for email, account, code in [("new@example.test", "different", "ACCOUNT_MISMATCH"),
                                      ("old@example.test", "account", "SESSION_EMAIL_MISMATCH"),
                                      ("", "account", "SESSION_EMAIL_MISMATCH")]:
            with self.subTest(code=code):
                fresh = self.session(email, account)
                with self.assertRaises(WorkerError) as raised:
                    self.execute(fresh)
                self.assertEqual(raised.exception.code, code)
                fresh.auth.close.assert_called_once()

    def test_original_frontend_no_warmup_no_token_exchange(self):
        auth = auth_fixture()
        with patch.object(login, "AuthFlow", return_value=auth), patch.object(login, "issue_mfa_challenge"), \
             patch.object(login, "verify_mfa_totp", return_value={"continue_url": CALLBACK}) as verify, \
             patch.object(login, "totp_code_candidates", return_value=["123456"]):
            login.login_with_password_and_totp("old@example.test", " password ", "SECRET")
        auth.initialize_login_pages.assert_not_called()
        auth.get_csrf_token.assert_called_once()
        auth.oauth_token_exchange.assert_not_called()
        auth._consume_callback_for_session.assert_called_once_with(CALLBACK)
        verify.assert_called_once()
        auth.login_password_verify.assert_called_once_with(" password ")

    def test_partial_login_closes_http_session(self):
        auth = auth_fixture()
        auth.get_csrf_token.side_effect = RuntimeError("fixture")
        with patch.object(login, "AuthFlow", return_value=auth):
            with self.assertRaises(RuntimeError):
                login.login_with_password_and_totp("old@example.test", "password", "SECRET")
        auth.close.assert_called_once()

    def test_mfa_explicit_failures(self):
        for status, payload, code in [(200, {"success": False}, "MFA_FAILED"),
            (200, [], "MFA_FAILED"), (429, {"error": {"code": "invalid_code"}}, "MFA_FAILED"),
            (400, {"error": {"code": "invalid_code"}}, "MFA_INVALID_CODE")]:
            response = Mock(status_code=status)
            response.json.return_value = payload
            with self.assertRaises(login.MfaLoginError) as raised:
                login._mfa_response(response, "verify")
            self.assertEqual(raised.exception.code, code)

    def test_cookie_chunks_order_and_gap(self):
        auth = AuthFlow.__new__(AuthFlow)
        name = "__Secure-next-auth.session-token"
        auth.session = SimpleNamespace(cookies={name + ".1": "b", name + ".0": "a"})
        self.assertEqual(auth._extract_session_cookie(), "ab")
        del auth.session.cookies[name + ".0"]
        self.assertEqual(auth._extract_session_cookie(), "")

    def test_sdk_readonly_bundled(self):
        session = Mock()
        path = _ensure_sdk_file(session, 1000)
        self.assertTrue(path.is_file())
        session.get.assert_not_called()
        with self.assertRaises(RuntimeError):
            _ensure_sdk_file(session, 1000, source_url="https://sentinel.openai.com/sentinel/other/sdk.js")
        session.get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
