import base64
import json
from pathlib import Path
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from runtime import WorkerError
from trial_runtime import CAMPAIGN, run
from worker import error_message
from registration_core.auth_flow import AuthFlow, AuthResult


def request_fixture():
    return {"type": "trial", "credentials": {"email": "new@example.test", "password": " password ",
            "totpSecret": "SECRET"}, "proxy": "http://fixture.invalid:8080", "expectedAccountId": "account"}


def session_fixture():
    auth = Mock(result=AuthResult())
    auth.result.session_token = "session-secret"
    auth._extract_session_cookie.return_value = "session-secret"
    auth.session.get.return_value = session_response()
    return SimpleNamespace(account_id="account", factor_id="factor", session_token="session-secret",
                           access_token="access-secret", auth=auth,
                           result=SimpleNamespace(auth_session_json=json.dumps(session_response().json())))


def session_response(account="account", email="new@example.test", status=200):
    payload = base64.urlsafe_b64encode(json.dumps({
        "https://api.openai.com/auth": {"chatgpt_account_id": account}}).encode()).decode().rstrip("=")
    response = Mock(status_code=status)
    response.json.return_value = {"user": {"email": email}, "accessToken": "header." + payload + ".signature"}
    return response


def probe_fixture(status="eligible"):
    return {"status": status, "campaign_id": CAMPAIGN, "amount_minor": 0,
            "amount_currency": "JPY", "billing_country": "JP",
            "source": "protocol_bootstrap/check_coupon", "detail": "check_coupon:state=" + status,
            "headers": "secret", "cookie": "secret", "trace": "secret"}


class TrialTests(unittest.TestCase):
    def execute(self, fresh, request=None):
        login = Mock(return_value=fresh)
        receive = Mock(side_effect=AssertionError("unexpected code IPC"))
        events = []
        with patch("rebind_core.change_email.ChangeEmailClient", side_effect=AssertionError("unexpected rebind")) as client:
            result = run(request or request_fixture(), events.append, receive, login)
        client.assert_not_called()
        receive.assert_not_called()
        login.assert_called_once_with("new@example.test", " password ", "SECRET", proxy="http://fixture.invalid:8080")
        fresh.auth.bootstrap_chatgpt_client_and_probe_trial.assert_called_once_with(strict_coupon_errors=True)
        fresh.auth.close.assert_called_once_with()
        self.assertEqual(events, [{"type": "stage", "stage": "login_trial"},
                                  {"type": "stage", "stage": "trial_qualification"}])
        return result

    def test_exact_contract_for_all_statuses(self):
        for status in ("eligible", "ineligible", "error"):
            with self.subTest(status=status):
                fresh = session_fixture()
                fresh.auth.bootstrap_chatgpt_client_and_probe_trial.return_value = probe_fixture(status)
                self.assertEqual(self.execute(fresh), {"email": "new@example.test", "accountId": "account",
                    "mfaVerified": True, "status": status, "campaignId": CAMPAIGN, "amountMinor": 0,
                    "currency": "JPY", "billingCountry": "JP",
                    "session": {"accessToken": session_response().json()["accessToken"], "sessionToken": "session-secret"},
                    "errorCode": "TRIAL_PROBE_FAILED" if status == "error" else None})

    def test_exception_is_error_and_closes_session(self):
        fresh = session_fixture()
        fresh.auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = OSError("tokens password SECRET")
        with self.assertRaises(WorkerError) as raised:
            self.execute(fresh)
        self.assertEqual(error_message(raised.exception, trial=True), {"type": "error", "code": "TRIAL_PROBE_FAILED",
            "diagnostic": {"category": "unknown", "httpStatus": None, "curlCode": None}})
        fresh.auth.close.assert_called_once_with()

    def test_login_and_probe_exceptions_use_real_worker_sanitizer(self):
        for phase in ("login", "probe"):
            for message, expected, category, http, curl in [
                ("curl: (35)", "NETWORK_TLS", "tls", None, 35),
                ("curl: (28)", "NETWORK_TIMEOUT", "timeout", None, 28),
                ("curl: (7)", "NETWORK_FAILED", "unknown", None, 7),
                ("HTTP 429", None, "http", 429, None),
                ("HTTP 403", None, "http", 403, None),
                ("HTTP 401", None, "http", 401, None),
                ("unknown", None, "unknown", None, None),
            ]:
                with self.subTest(phase=phase, message=message):
                    fresh = session_fixture()
                    exc = RuntimeError(message + " https://fixture.invalid/?token=PRIVATE password PRIVATE")
                    login = Mock(return_value=fresh)
                    if phase == "login":
                        login.side_effect = exc
                    else:
                        fresh.auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = exc
                    with self.assertRaises(WorkerError) as raised:
                        run(request_fixture(), Mock(), Mock(), login)
                    self.assertIs(raised.exception.__cause__, exc)
                    result = error_message(raised.exception, trial=True)
                    self.assertEqual(result, {"type": "error", "code": expected or (
                        "LOGIN_FAILED" if phase == "login" else "TRIAL_PROBE_FAILED"),
                        "diagnostic": {"category": category, "httpStatus": http, "curlCode": curl}})
                    self.assertNotIn("PRIVATE", json.dumps(result))
                    self.assertNotIn("https://", json.dumps(result))
                    if phase == "probe":
                        fresh.auth.close.assert_called_once_with()

    def test_explicit_denials_keep_codes_even_with_network_context(self):
        for code in ("MFA_INVALID_CODE", "LOGIN_INCOMPLETE", "ACCOUNT_MISMATCH",
                     "SESSION_EMAIL_MISMATCH", "LOGIN_FAILED"):
            with self.subTest(code=code):
                exc = WorkerError(code)
                if code == "LOGIN_FAILED":
                    exc.args = ("invalid_username_or_password PRIVATE",)
                exc.__context__ = RuntimeError("curl: (28) PRIVATE")
                self.assertEqual(error_message(exc, trial=True)["code"], code)

    def test_from_none_retains_context_for_network_diagnostic(self):
        cause = RuntimeError("curl: (35) https://fixture.invalid/?token=PRIVATE")
        try:
            try:
                raise cause
            except RuntimeError:
                raise WorkerError("LOGIN_FAILED") from None
        except WorkerError as wrapped:
            self.assertIs(wrapped.__context__, cause)
            self.assertIsNone(wrapped.__cause__)
            self.assertTrue(wrapped.__suppress_context__)
            self.assertEqual(error_message(wrapped, trial=True), {"type": "error", "code": "NETWORK_TLS",
                "diagnostic": {"category": "tls", "httpStatus": None, "curlCode": 35}})

    def test_http_dominates_network_context(self):
        for status in (401, 403, 429):
            exc = WorkerError("LOGIN_FAILED")
            exc.status_code = status
            exc.__context__ = RuntimeError("curl: (28) PRIVATE")
            self.assertEqual(error_message(exc, trial=True), {"type": "error", "code": "LOGIN_FAILED",
                "diagnostic": {"category": "http", "httpStatus": status, "curlCode": 28}})

    def coupon_auth(self, coupon):
        auth = Mock(result=AuthResult())
        auth.result.access_token = "PRIVATE"
        accounts = Mock(status_code=200)
        accounts.json.return_value = {"eligible_promo_campaigns": [CAMPAIGN]}
        auth.session.get.side_effect = [Mock(status_code=200), accounts, Mock(status_code=200), coupon]
        return auth

    def test_actual_coupon_failures_reach_worker_without_stale_eligibility(self):
        for coupon, code, category, status, curl in [
            (Mock(status_code=429), "TRIAL_PROBE_FAILED", "http", 429, None),
            (Mock(status_code=403), "TRIAL_PROBE_FAILED", "http", 403, None),
            (Mock(status_code=401), "TRIAL_PROBE_FAILED", "http", 401, None),
            (RuntimeError("curl: (28) PRIVATE"), "NETWORK_TIMEOUT", "timeout", None, 28),
            (RuntimeError("curl: (35) PRIVATE"), "NETWORK_TLS", "tls", None, 35),
            (RuntimeError("PRIVATE"), "TRIAL_PROBE_FAILED", "unknown", None, None),
        ]:
            with self.subTest(code=code, status=status):
                fresh = session_fixture()
                auth = self.coupon_auth(coupon)
                fresh.auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = lambda **kwargs: (
                    AuthFlow.bootstrap_chatgpt_client_and_probe_trial(auth, **kwargs))
                with patch("curl_cffi.requests.Session.request", side_effect=AssertionError("network forbidden")):
                    with self.assertRaises(WorkerError) as raised:
                        run(request_fixture(), Mock(), Mock(), Mock(return_value=fresh))
                self.assertEqual(error_message(raised.exception, trial=True), {"type": "error", "code": code,
                    "diagnostic": {"category": category, "httpStatus": status, "curlCode": curl}})
                self.assertEqual(auth.session.get.call_count, 4)
                self.assertIn("/promo_campaign/check_coupon?", auth.session.get.call_args.args[0])
                fresh.auth.close.assert_called_once_with()

    def test_default_coupon_behavior_and_strict_success_contract(self):
        for coupon in (Mock(status_code=429), RuntimeError("curl: (28) PRIVATE")):
            auth = self.coupon_auth(coupon)
            result = AuthFlow.bootstrap_chatgpt_client_and_probe_trial(auth)
            self.assertEqual(result["source"], "protocol_bootstrap/accounts_check")
            self.assertIs(result, auth.result.trial_probe)
        coupon = Mock(status_code=200)
        coupon.json.return_value = {"state": "eligible"}
        fresh = session_fixture()
        auth = self.coupon_auth(coupon)
        fresh.auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = lambda **kwargs: (
            AuthFlow.bootstrap_chatgpt_client_and_probe_trial(auth, **kwargs))
        self.assertEqual(self.execute(fresh)["status"], "eligible")

    def test_diagnostic_chain_cycle_is_bounded(self):
        exc = WorkerError("LOGIN_FAILED")
        exc.__context__ = RuntimeError("curl: (35) PRIVATE")
        exc.__context__.__context__ = exc
        self.assertEqual(error_message(exc, trial=True)["code"], "NETWORK_TLS")

    def test_mfa_network_wrapping_and_legacy_worker_contract(self):
        for code in ("LOGIN_FAILED", "MFA_FAILED", "TRIAL_PROBE_FAILED"):
            exc = WorkerError(code)
            self.assertEqual(error_message(exc, trial=True)["code"], code)
            exc.__cause__ = RuntimeError("curl: (35) PRIVATE")
            self.assertEqual(error_message(exc, trial=True)["code"], "NETWORK_TLS")
            self.assertEqual(error_message(exc)["code"], code)
        self.assertEqual(error_message(RuntimeError("HTTP 429"))["code"], "NETWORK_FAILED")
        self.assertEqual(error_message(RuntimeError("HTTP 429"), trial=True)["code"], "WORKER_FAILED")

    def test_real_worker_error_ipc_is_sanitized(self):
        script = """
import runpy
import sys
from unittest.mock import patch
from test_trial_runtime import session_fixture
from runtime import WorkerError
fresh = session_fixture()
phase, message = sys.argv[1:]
exc = RuntimeError(message + " https://fixture.invalid/?password=PRIVATE")
if phase == "wrapped":
    wrapped = WorkerError("LOGIN_FAILED")
    wrapped.__cause__ = exc
    exc = wrapped
def login(*args, **kwargs):
    if phase != "probe":
        raise exc
    return fresh
fresh.auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = exc
with patch("rebind_core.mfa_login.login_with_password_and_totp", side_effect=login), patch(
        "curl_cffi.requests.Session.request", side_effect=AssertionError("network forbidden")):
    try:
        runpy.run_path("worker.py", run_name="__main__")
    finally:
        if phase == "probe":
            fresh.auth.close.assert_called_once_with()
"""
        for phase, message, code, category, status, curl in [
            ("login", "curl: (35)", "NETWORK_TLS", "tls", None, 35),
            ("wrapped", "curl: (35)", "NETWORK_TLS", "tls", None, 35),
            ("probe", "curl: (28)", "NETWORK_TIMEOUT", "timeout", None, 28),
            ("probe", "HTTP 429", "TRIAL_PROBE_FAILED", "http", 429, None),
            ("probe", "unknown", "TRIAL_PROBE_FAILED", "unknown", None, None),
            ("login", "HTTP 403", "LOGIN_FAILED", "http", 403, None),
            ("login", "invalid_username_or_password", "LOGIN_FAILED", "unknown", None, None),
        ]:
            with self.subTest(phase=phase, message=message):
                completed = subprocess.run([sys.executable, "-B", "-c", script, phase, message],
                    input=json.dumps(request_fixture()) + "\n", text=True, capture_output=True,
                    cwd=Path(__file__).parent, timeout=30)
                self.assertEqual(completed.returncode, 1, completed.stderr)
                self.assertEqual(completed.stderr, "")
                messages = [json.loads(line) for line in completed.stdout.splitlines()]
                self.assertEqual([item["type"] for item in messages],
                    ["stage", "stage", "error"] if phase == "probe" else ["stage", "error"])
                self.assertEqual(messages[-1], {"type": "error", "code": code,
                    "diagnostic": {"category": category, "httpStatus": status, "curlCode": curl}})
                for private in ("PRIVATE", "https://", "password", "SECRET", "traceback"):
                    self.assertNotIn(private, completed.stdout)

    def test_unexpected_probe_is_error(self):
        bad = [None, [], "eligible", {}, probe_fixture("unknown")]
        for field, value in [("campaign_id", "other"), ("amount_minor", True), ("amount_minor", 0.0),
                             ("amount_currency", "jpy"), ("amount_currency", "JPYY"),
                             ("billing_country", "Japan"), ("source", None)]:
            bad.append(dict(probe_fixture(), **{field: value}))
        for probe in bad:
            with self.subTest(probe=probe):
                fresh = session_fixture()
                fresh.auth.bootstrap_chatgpt_client_and_probe_trial.return_value = probe
                result = self.execute(fresh)
                self.assertEqual(result["status"], "error")
                self.assertEqual(result["errorCode"], "TRIAL_PROBE_FAILED")

    def test_stale_accounts_eligible_never_masks_coupon_failure(self):
        for detail in ("check_coupon HTTP 401", "check_coupon HTTP 403", "check_coupon non-json",
                       "check_coupon:state=unknown", "check_coupon error: OSError: fixture"):
            for source in ("protocol_bootstrap/accounts_check", "protocol_bootstrap/check_coupon"):
                with self.subTest(detail=detail, source=source):
                    fresh = session_fixture()
                    fresh.auth.bootstrap_chatgpt_client_and_probe_trial.return_value = dict(
                        probe_fixture(), source=source, detail=detail)
                    self.assertEqual(self.execute(fresh)["status"], "error")

    def test_nullable_metadata_and_top_level_email(self):
        fresh = session_fixture()
        fresh.result.auth_session_json = json.dumps({"email": "NEW@example.test",
            "accessToken": session_response().json()["accessToken"]})
        fresh.auth.session.get.return_value = session_response(email="NEW@example.test")
        fresh.auth.bootstrap_chatgpt_client_and_probe_trial.return_value = dict(
            probe_fixture(), amount_minor=None, amount_currency=None, billing_country=None)
        result = self.execute(fresh)
        self.assertEqual(result["email"], "NEW@example.test")
        self.assertEqual(result["status"], "eligible")
        for key in ("amountMinor", "currency", "billingCountry"):
            self.assertIsNone(result[key])

    def test_identity_failures_prevent_probe_and_close(self):
        cases = [("account_id", "other", "ACCOUNT_MISMATCH")]
        cases += [(key, value, "LOGIN_INCOMPLETE") for key in
                  ("account_id", "factor_id", "session_token", "access_token") for value in (None, "", " ")]
        for key, value, code in cases:
            with self.subTest(key=key, value=value):
                fresh = session_fixture()
                setattr(fresh, key, value)
                self.assert_identity_failure(fresh, code)
        for raw in ('{"user":{"email":"old@example.test"}}', '{}', '[]', 'null', 'bad',
                    '{"user":[]}', '{"user":{"email":42}}'):
            fresh = session_fixture()
            fresh.result.auth_session_json = raw
            self.assert_identity_failure(fresh, "SESSION_EMAIL_MISMATCH")

    def assert_identity_failure(self, fresh, code):
        with self.assertRaises(WorkerError) as raised:
            run(request_fixture(), Mock(), Mock(), Mock(return_value=fresh))
        self.assertEqual(raised.exception.code, code)
        fresh.auth.bootstrap_chatgpt_client_and_probe_trial.assert_not_called()
        fresh.auth.close.assert_called_once_with()

    def test_input_validation(self):
        for field in ("credentials", "proxy", "expectedAccountId"):
            request = request_fixture()
            del request[field]
            login = Mock()
            with self.assertRaises(WorkerError) as raised:
                run(request, Mock(), Mock(), login)
            self.assertEqual(raised.exception.code, "INVALID_INPUT")
            login.assert_not_called()
        for field in ("email", "password", "totpSecret"):
            request = request_fixture()
            request["credentials"][field] = " "
            with self.assertRaises(WorkerError) as raised:
                run(request, Mock(), Mock(), Mock())
            self.assertEqual(raised.exception.code, "INVALID_INPUT")

    def test_login_errors_use_standard_codes(self):
        for code in ("MFA_FAILED", "MFA_INVALID_CODE", "LOGIN_FAILED", "LOGIN_INCOMPLETE", "secret"):
            exc = RuntimeError("password SECRET")
            exc.code = code
            with self.assertRaises(WorkerError) as raised:
                run(request_fixture(), Mock(), Mock(), Mock(side_effect=exc))
            self.assertEqual(raised.exception.code, "LOGIN_FAILED" if code == "secret" else code)
            self.assertNotIn("SECRET", str(raised.exception))

    def test_close_failure_does_not_replace_result(self):
        fresh = session_fixture()
        fresh.auth.close.side_effect = RuntimeError("close secret")
        fresh.auth.bootstrap_chatgpt_client_and_probe_trial.return_value = probe_fixture()
        self.assertEqual(self.execute(fresh)["status"], "eligible")

    def test_real_worker_stdin_and_output_protection(self):
        script = '''
import runpy
import sys
from unittest.mock import patch
from test_trial_runtime import session_fixture, probe_fixture
fresh = session_fixture()
def probe(*, strict_coupon_errors):
    assert strict_coupon_errors is True
    print("probe secret")
    print("stderr secret", file=sys.stderr)
    return probe_fixture()
fresh.auth.bootstrap_chatgpt_client_and_probe_trial.side_effect = probe
def login(*args, **kwargs):
    assert args == ("new@example.test", " password ", "SECRET")
    assert kwargs == {"proxy": "http://fixture.invalid:8080"}
    print("login secret")
    return fresh
with patch("rebind_core.mfa_login.login_with_password_and_totp", side_effect=login), patch(
        "rebind_core.change_email.ChangeEmailClient", side_effect=AssertionError("unexpected rebind")), patch(
        "curl_cffi.requests.Session.request", side_effect=AssertionError("network forbidden")):
    try:
        runpy.run_path("worker.py", run_name="__main__")
    finally:
        fresh.auth.close.assert_called_once_with()
'''
        completed = subprocess.run([sys.executable, "-B", "-c", script],
            input=json.dumps(request_fixture()) + "\n", text=True, capture_output=True,
            cwd=Path(__file__).parent, timeout=30)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(completed.stderr, "")
        messages = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual([item["type"] for item in messages], ["stage", "stage", "result"])
        self.assertEqual([item["stage"] for item in messages[:2]], ["login_trial", "trial_qualification"])
        self.assertEqual(messages[-1]["result"]["status"], "eligible")
        self.assertEqual(messages[-1]["result"].pop("session"), {
            "accessToken": session_response().json()["accessToken"], "sessionToken": "session-secret"})
        for secret in ("SECRET", "password", "session-secret", "access-secret", "detail", "trace", "headers", "cookie"):
            self.assertNotIn(secret, json.dumps(messages))


if __name__ == "__main__":
    unittest.main()
