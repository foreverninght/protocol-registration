import json
import unittest
from unittest.mock import Mock, patch

from diagnostics import LoginFlowError
from rebind_core import mfa_login as login
from registration_core.auth_flow import AuthFlow, AuthResult
from test_worker import auth_fixture, CALLBACK
from worker import error_message


def flow(strict=True):
    auth = AuthFlow.__new__(AuthFlow)
    auth.strict_login_errors = strict
    auth.result = AuthResult()
    auth.session = Mock()
    auth.session.cookies = {}
    auth._common_headers = Mock(return_value={})
    auth._html_headers = Mock(return_value={})
    auth._trace_http = Mock()
    auth._last_sentinel_token = ""
    auth._build_chatgpt_cookie_header = Mock(return_value="")
    return auth


def response(status=200, data=None, location=""):
    result = Mock(status_code=status, text="PRIVATE-BODY", headers={"Location": location})
    result.json.return_value = data
    return result


class LoginDiagnosticsTests(unittest.TestCase):
    def test_strict_bootstrap_http_and_tls_do_not_retry(self):
        for status in (403, 429):
            auth = flow()
            auth.session.get.return_value = response(status, {})
            with self.assertRaises(LoginFlowError) as raised:
                auth.get_csrf_token()
            self.assertEqual(raised.exception.status_code, status)
            auth.session.get.assert_called_once()
        auth = flow()
        original = RuntimeError("PRIVATE")
        original.code = 35
        auth.session.get.side_effect = original
        auth._rotate_impersonate_session = Mock()
        with self.assertRaises(RuntimeError) as raised:
            auth.get_csrf_token()
        self.assertIs(raised.exception, original)
        auth._rotate_impersonate_session.assert_not_called()
        with self.assertRaises(RuntimeError) as raised:
            auth.auth_oauth_init("https://fixture.invalid/")
        self.assertIs(raised.exception, original)

    def test_password_http_and_controlled_credentials(self):
        for status, body, reason in (
            (401, {}, "LOGIN_HTTP_ERROR"),
            (401, {"error": {"code": "invalid_username_or_password"}}, "LOGIN_CREDENTIALS_REJECTED"),
            (403, {"error": {"code": "invalid_credentials"}}, "LOGIN_HTTP_ERROR"),
            (429, {"error": "PRIVATE-BODY"}, "LOGIN_HTTP_ERROR"),
        ):
            with self.subTest(status=status, reason=reason):
                auth = flow()
                auth.session.post.return_value = response(status, body)
                with self.assertRaises(LoginFlowError) as raised:
                    auth.login_password_verify("PRIVATE-PASSWORD")
                result = error_message(raised.exception, trial=True)
                self.assertEqual(result["code"], "LOGIN_FAILED")
                self.assertEqual(result["diagnostic"], dict(category="http", httpStatus=status,
                    curlCode=None, phase="password_verify", reason=reason))
                self.assertNotIn("PRIVATE", json.dumps(result))

    def test_registration_default_and_trial_only_fields(self):
        auth = flow(False)
        auth.session.post.return_value = response(403, {})
        with self.assertRaises(RuntimeError) as raised:
            auth.login_password_verify("fixture")
        self.assertNotIsInstance(raised.exception, LoginFlowError)
        auth.session.get.side_effect = TimeoutError("PRIVATE")
        self.assertFalse(auth._consume_callback_for_session(CALLBACK))
        self.assertIsNone(auth._reauthorize_for_session("https://fixture.invalid/authorize"))
        result = error_message(LoginFlowError("session", "LOGIN_SESSION_MISSING"))
        self.assertNotIn("phase", result["diagnostic"])
        self.assertNotIn("reason", result["diagnostic"])

    def test_session_empty_200_is_not_network(self):
        for data in ({}, None, [], {"accessToken": "fixture"}):
            auth = flow()
            auth.session.get.return_value = response(200, data)
            with self.assertRaises(LoginFlowError) as raised:
                auth.get_auth_session()
            result = error_message(raised.exception, trial=True)
            self.assertEqual(result["code"], "LOGIN_FAILED")
            self.assertEqual(result["diagnostic"]["reason"], "LOGIN_SESSION_MISSING")
            self.assertEqual(result["diagnostic"]["httpStatus"], 200)

    def test_callback_network_never_reconsumes_code(self):
        auth = flow()
        original = TimeoutError("PRIVATE URL cookies")
        auth.session.get.side_effect = original
        with self.assertRaises(LoginFlowError) as raised:
            login._login_call("callback", auth._consume_callback_for_session, CALLBACK)
        self.assertIs(raised.exception.__cause__, original)
        result = error_message(raised.exception, trial=True)
        self.assertEqual(result["code"], "NETWORK_TIMEOUT")
        self.assertEqual(result["diagnostic"]["phase"], "callback")
        with self.assertRaises(LoginFlowError) as reused:
            auth._consume_callback_for_session(CALLBACK.replace("state=fixture", "state=other"))
        self.assertEqual(reused.exception.diagnostic["reason"], "LOGIN_CALLBACK_REUSED")
        self.assertEqual(auth.session.get.call_count, 1)

    def test_callback_landing_and_reauthorize_hop_propagate_network(self):
        for phase, method, url, redirect in (
            ("callback", "_consume_callback_for_session", CALLBACK, "https://chatgpt.com/"),
            ("reauthorize", "_reauthorize_for_session", "https://fixture.invalid/authorize", "https://fixture.invalid/hop"),
        ):
            with self.subTest(phase=phase):
                auth = flow()
                original = ConnectionError("PRIVATE")
                auth.session.get.side_effect = [response(302, {}, redirect), original]
                with self.assertRaises(LoginFlowError) as raised:
                    login._login_call(phase, getattr(auth, method), url)
                self.assertIs(raised.exception.__cause__, original)
                result = error_message(raised.exception, trial=True)
                self.assertEqual(result["code"], "NETWORK_FAILED")
                self.assertEqual(result["diagnostic"]["phase"], phase)
                self.assertEqual(auth.session.get.call_count, 2)

    def test_callback_redirect_stops_before_consumption(self):
        auth = flow()
        self.assertEqual(auth.follow_redirect_chain(CALLBACK), (CALLBACK, CALLBACK))
        auth.session.get.assert_not_called()

    def test_reauthorize_callback_without_state_is_not_consumed(self):
        auth = flow()
        callback = CALLBACK.split("&state=")[0]
        auth.session.get.return_value = response(302, {}, callback)
        self.assertEqual(auth._reauthorize_for_session("https://fixture.invalid/authorize"), callback)
        auth.session.get.assert_called_once()

    def test_reauthorize_first_relative_location(self):
        for strict in (True, False):
            with self.subTest(strict=strict):
                auth = flow(strict)
                auth.session.get.side_effect = [
                    response(302, {}, "/continue"), response(302, {}, CALLBACK)]
                self.assertEqual(auth._reauthorize_for_session(
                    "https://fixture.invalid/oauth/authorize?prompt=login"), CALLBACK)
                self.assertEqual([call.args[0] for call in auth.session.get.call_args_list], [
                    "https://fixture.invalid/oauth/authorize",
                    "https://fixture.invalid/continue"])

    def test_reauthorize_relative_hop_uses_current_path(self):
        for strict in (True, False):
            with self.subTest(strict=strict):
                auth = flow(strict)
                auth.session.get.side_effect = [
                    response(302, {}, "https://fixture.invalid/consent/step/start"),
                    response(302, {}, "../finish"), response(302, {}, CALLBACK)]
                self.assertEqual(auth._reauthorize_for_session(
                    "https://fixture.invalid/oauth/authorize"), CALLBACK)
                self.assertEqual([call.args[0] for call in auth.session.get.call_args_list], [
                    "https://fixture.invalid/oauth/authorize",
                    "https://fixture.invalid/consent/step/start",
                    "https://fixture.invalid/consent/finish"])

    def test_callback_cookie_skips_homepage_but_session_is_verified(self):
        auth = flow()
        def callback(*args, **kwargs):
            auth.session.cookies["__Secure-next-auth.session-token"] = "fixture"
            return response(302, {}, "https://chatgpt.com/")
        auth.session.get.side_effect = callback
        self.assertTrue(auth._consume_callback_for_session(CALLBACK))
        auth.session.get.assert_called_once()
        auth.session.get.side_effect = TimeoutError("homepage would fail")
        with self.assertRaises(TimeoutError):
            auth.get_auth_session()
        self.assertEqual(auth.session.get.call_args.args[0], "https://chatgpt.com/api/auth/session")

    def test_bootstrap_tls_cause_and_missing_factor(self):
        auth = auth_fixture()
        original = RuntimeError("PRIVATE")
        original.code = 35
        auth.auth_oauth_init.side_effect = original
        with patch.object(login, "AuthFlow", return_value=auth):
            with self.assertRaises(LoginFlowError) as raised:
                login.login_with_password_and_totp("fixture@example.test", "fixture", "SECRET")
        result = error_message(raised.exception, trial=True)
        self.assertEqual(result["code"], "NETWORK_TLS")
        self.assertEqual(result["diagnostic"]["phase"], "bootstrap")
        self.assertEqual(result["diagnostic"]["curlCode"], 35)
        auth.close.assert_called_once()
        auth = auth_fixture()
        auth.login_password_verify.return_value = {}
        with self.assertRaises(login.MfaLoginError) as raised:
            login._login_with_password_and_totp("fixture@example.test", "fixture", "SECRET", auth=auth)
        result = error_message(raised.exception, trial=True)
        self.assertEqual(result["code"], "MFA_FAILED")
        self.assertEqual(result["diagnostic"]["reason"], "LOGIN_MFA_FACTOR_MISSING")

    def test_continue_missing_and_whitelist(self):
        with self.assertRaises(LoginFlowError) as raised:
            login._finish_to_session(auth_fixture(), "")
        self.assertEqual(error_message(raised.exception, trial=True)["diagnostic"]["reason"], "LOGIN_CONTINUE_MISSING")
        exc = RuntimeError("PRIVATE")
        exc.diagnostic = {"phase": "PRIVATE", "reason": "PRIVATE"}
        self.assertNotIn("PRIVATE", json.dumps(error_message(exc, trial=True)))


if __name__ == "__main__":
    unittest.main()
