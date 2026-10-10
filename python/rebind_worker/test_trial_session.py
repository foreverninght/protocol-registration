import json
import unittest
from unittest.mock import Mock, patch
from urllib.request import Request
from http.cookiejar import CookieJar

from runtime import WorkerError
from trial_runtime import run
from trial_session import COOKIE, restore
from test_trial_runtime import request_fixture, session_fixture, session_response, probe_fixture
from worker import error_message


class SavedSessionTests(unittest.TestCase):
    def setUp(self):
        self.request = dict(request_fixture(), session={"accessToken": "old-token", "sessionToken": "saved-token"},
                            mfaPreviouslyVerified=True)
        self.cached = session_fixture().auth
        self.cached.bootstrap_chatgpt_client_and_probe_trial.return_value = probe_fixture()
        self.fresh = session_fixture()
        self.fresh.auth.bootstrap_chatgpt_client_and_probe_trial.return_value = probe_fixture()
        self.login = Mock(return_value=self.fresh)
        self.events = []

    def execute(self):
        with patch("trial_runtime.restore", return_value=self.cached):
            return run(self.request, self.events.append, Mock(), self.login)

    def test_valid_session_zero_login_and_internal_tokens(self):
        result = self.execute()
        self.assertEqual(result["status"], "eligible")
        self.assertIs(result["mfaVerified"], True)
        self.assertEqual(result["session"]["accessToken"], session_response().json()["accessToken"])
        self.login.assert_not_called()
        self.cached.close.assert_called_once_with()
        self.assertEqual([event["stage"] for event in self.events], ["session_trial", "trial_qualification"])
        self.cached.session.get.assert_called_once()
        self.assertFalse(self.cached.session.get.call_args.kwargs["allow_redirects"])

    def test_401_or_empty_session_login_once(self):
        for response in (session_response(status=401), Mock(status_code=200, json=Mock(return_value={}))):
            self.setUp()
            self.cached.session.get.return_value = response
            self.assertEqual(self.execute()["status"], "eligible")
            self.login.assert_called_once()
            self.cached.close.assert_called_once()
            self.fresh.auth.close.assert_called_once()

    def test_fresh_401_does_not_login_twice(self):
        self.cached.session.get.return_value = session_response(status=401)
        self.fresh.result.auth_session_json = "{}"
        with self.assertRaises(WorkerError):
            self.execute()
        self.login.assert_called_once()
        self.fresh.auth.close.assert_called_once()

    def test_http_denials_zero_login(self):
        for status in (403, 429, 500, 302):
            self.setUp()
            self.cached.session.get.return_value = session_response(status=status)
            with self.assertRaises(WorkerError) as raised:
                self.execute()
            self.assertEqual(error_message(raised.exception, trial=True)["diagnostic"]["httpStatus"], status)
            self.assertEqual(raised.exception.diagnostic, {"phase": "session", "reason": "LOGIN_HTTP_ERROR"})
            self.login.assert_not_called()
            self.cached.close.assert_called_once()
            self.cached.bootstrap_chatgpt_client_and_probe_trial.assert_not_called()

    def test_network_zero_login_with_diagnostic(self):
        for exc, code in ((RuntimeError("curl: (28) PRIVATE"), "NETWORK_TIMEOUT"),
                          (RuntimeError("curl: (35) PRIVATE"), "NETWORK_TLS"),
                          (ConnectionError("PRIVATE"), "NETWORK_FAILED")):
            self.setUp()
            self.cached.session.get.side_effect = exc
            with self.assertRaises(WorkerError) as raised:
                self.execute()
            message = error_message(raised.exception, trial=True)
            self.assertEqual(message["code"], code)
            self.assertEqual(raised.exception.diagnostic, {"phase": "session", "reason": "LOGIN_STEP_FAILED"})
            self.assertNotIn("PRIVATE", json.dumps(message))
            self.login.assert_not_called()
            self.cached.close.assert_called_once()

    def test_identity_mismatch_zero_login(self):
        for response, code in ((session_response(account="other"), "ACCOUNT_MISMATCH"),
                               (session_response(email="other@example.test"), "SESSION_EMAIL_MISMATCH")):
            self.setUp()
            self.cached.session.get.return_value = response
            with self.assertRaises(WorkerError) as raised:
                self.execute()
            self.assertEqual(raised.exception.code, code)
            self.login.assert_not_called()
            self.cached.close.assert_called_once()

    def test_local_token_never_supplies_missing_server_token(self):
        self.cached.session.get.return_value.json.return_value = {"user": {"email": "new@example.test"}}
        with self.assertRaises(WorkerError) as raised:
            self.execute()
        self.assertEqual(raised.exception.code, "LOGIN_INCOMPLETE")
        self.login.assert_not_called()

    def test_mfa_record_requires_true_boolean(self):
        for value in (False, None, "true", 1):
            self.request["mfaPreviouslyVerified"] = value
            with self.assertRaises(WorkerError) as raised:
                self.execute()
            self.assertEqual(raised.exception.code, "MFA_FAILED")
        self.login.assert_not_called()

    def test_access_only_and_absent_session_login_once(self):
        for session in (None, {}, {"accessToken": "local-only"}):
            self.setUp()
            self.request["session"] = session
            self.execute()
            self.login.assert_called_once()
            self.cached.session.get.assert_not_called()

    def test_chunked_cookie_scope_and_restore_cleanup(self):
        from registration_core.auth_flow import AuthFlow
        token = "a" * 8000
        with patch("curl_cffi.requests.Session.request", side_effect=AssertionError("network forbidden")):
            auth = restore({"accessToken": "old-token", "sessionToken": token}, "http://fixture.invalid:8080")
            try:
                self.assertEqual(auth.result.access_token, "")
                self.assertEqual(AuthFlow._extract_session_cookie(auth), token)
                jar = CookieJar()
                for cookie in auth.session.cookies.jar:
                    jar.set_cookie(cookie)
                for url, expected in (("https://chatgpt.com/api/auth/session", True),
                                      ("https://auth.openai.com/", False),
                                      ("https://chatgpt.com.evil.test/", False),
                                      ("http://chatgpt.com/", False)):
                    request = Request(url)
                    jar.add_cookie_header(request)
                    self.assertEqual(COOKIE in (request.get_header("Cookie") or ""), expected)
            finally:
                auth.close()
        broken = Mock()
        broken.session.cookies.set.side_effect = RuntimeError("fixture")
        with patch("registration_core.auth_flow.AuthFlow", return_value=broken):
            with self.assertRaises(RuntimeError):
                restore({"accessToken": "", "sessionToken": "token"}, "proxy")
        broken.close.assert_called_once()

    def test_invalid_response_is_not_expiration(self):
        for value in (None, [], "", {"error": "unavailable"}):
            self.setUp()
            self.cached.session.get.return_value.json.return_value = value
            with self.assertRaises(WorkerError):
                self.execute()
            self.login.assert_not_called()
            self.cached.close.assert_called_once()

    def test_fresh_server_identity_overrules_local_account_claim(self):
        self.request["session"] = None
        self.fresh.result.auth_session_json = json.dumps(session_response(account="other").json())
        with self.assertRaises(WorkerError) as raised:
            self.execute()
        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.login.assert_called_once()
        self.fresh.auth.bootstrap_chatgpt_client_and_probe_trial.assert_not_called()
        self.fresh.auth.session.get.assert_not_called()
        self.fresh.auth.close.assert_called_once()

    def test_expired_close_error_does_not_prevent_single_login(self):
        self.cached.session.get.return_value = session_response(status=401)
        self.cached.close.side_effect = RuntimeError("close failed")
        self.assertEqual(self.execute()["status"], "eligible")
        self.cached.close.assert_called_once()
        self.login.assert_called_once()

    def test_cached_probe_failure_never_triggers_login(self):
        for exc in (RuntimeError("HTTP 403"), RuntimeError("HTTP 429"), RuntimeError("curl: (28)")):
            self.setUp()
            self.cached.bootstrap_chatgpt_client_and_probe_trial.side_effect = exc
            with self.assertRaises(WorkerError):
                self.execute()
            self.login.assert_not_called()
            self.cached.close.assert_called_once()

    def test_cached_probe_401_logs_in_once(self):
        error = RuntimeError("authentication required")
        error.status_code = 401
        self.cached.bootstrap_chatgpt_client_and_probe_trial.side_effect = error
        result = self.execute()
        self.assertEqual(result["status"], "eligible")
        self.login.assert_called_once()
        self.cached.close.assert_called_once()
        self.fresh.auth.close.assert_called_once()
        self.assertEqual([event["stage"] for event in self.events],
                         ["session_trial", "trial_qualification", "login_trial", "trial_qualification"])

    def test_fresh_probe_401_never_repeats_login(self):
        self.cached.bootstrap_chatgpt_client_and_probe_trial.side_effect = RuntimeError("HTTP 401")
        self.fresh.auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = RuntimeError("HTTP 401")
        with self.assertRaises(WorkerError) as raised:
            self.execute()
        self.assertEqual(error_message(raised.exception, trial=True)["diagnostic"]["httpStatus"], 401)
        self.login.assert_called_once()
        self.cached.close.assert_called_once()
        self.fresh.auth.close.assert_called_once()

    def test_probe_returns_tokens_after_internal_refresh(self):
        for reuse in (True, False):
            self.setUp()
            if not reuse:
                self.request["session"] = None
            auth = self.cached if reuse else self.fresh.auth
            def refreshed_probe(**kwargs):
                auth.result.access_token = "fixture-final-access-token"
                auth.result.session_token = "fixture-final-session-token"
                return probe_fixture()
            auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = refreshed_probe
            result = self.execute()
            self.assertEqual(result["session"], {"accessToken": "fixture-final-access-token",
                                                 "sessionToken": "fixture-final-session-token"})
            auth.close.assert_called_once()

    def test_cached_probe_401_close_error_still_allows_login(self):
        self.cached.bootstrap_chatgpt_client_and_probe_trial.side_effect = RuntimeError("HTTP 401")
        self.cached.close.side_effect = RuntimeError("close failed")
        self.assertEqual(self.execute()["status"], "eligible")
        self.login.assert_called_once()
        self.cached.close.assert_called_once()

    def test_invalid_session_input(self):
        for value in ([], "token", {"sessionToken": None}, {"sessionToken": "abc\r\nCookie: evil"}):
            self.request["session"] = value
            with self.assertRaises(WorkerError) as raised:
                self.execute()
            self.assertEqual(raised.exception.code, "INVALID_INPUT")
            self.login.assert_not_called()


if __name__ == "__main__":
    unittest.main()
