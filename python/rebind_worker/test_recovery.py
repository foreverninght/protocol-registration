import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from runtime import WorkerError, run
from recovery_runtime import run as recover
from worker import error_message


def request():
    return {"type": "recover", "credentials": {"email": "old@example.test", "password": " password ",
            "totpSecret": "SECRET"}, "newEmail": "new@example.test", "expectedAccountId": "id", "proxy": "http://fixture:9"}


def session(email="new@example.test"):
    return SimpleNamespace(account_id="id", factor_id="factor", session_token="session", access_token="access",
                           auth=Mock(), result=SimpleNamespace(auth_session_json=json.dumps({"user": {"email": email}})))


class RecoveryTests(unittest.TestCase):
    def test_read_only_recovery(self):
        fresh, events, receive = session(), [], Mock(side_effect=AssertionError("no receive"))
        login = Mock(return_value=fresh)
        with patch("rebind_core.change_email.ChangeEmailClient", side_effect=AssertionError("no change")):
            result = recover(request(), events.append, receive, login)
        self.assertEqual(result, {"email": "new@example.test", "accountId": "id", "originalAccountId": "id",
                                 "password": " password ", "totpSecret": "SECRET", "sessionToken": "session",
                                 "accessToken": "access", "mfaVerified": True})
        login.assert_called_once_with("new@example.test", " password ", "SECRET", proxy="http://fixture:9")
        self.assertEqual(events, [{"type": "stage", "stage": "login_recovery"}])
        receive.assert_not_called()
        fresh.auth.close.assert_called_once()

    def test_invalid_identity_email_and_missing_mfa_tokens_close(self):
        for field, value, code in [("account_id", "other", "ACCOUNT_MISMATCH"),
                                   ("factor_id", "", "LOGIN_INCOMPLETE"), ("session_token", " ", "LOGIN_INCOMPLETE"),
                                   ("access_token", None, "LOGIN_INCOMPLETE"),
                                   ("result", SimpleNamespace(auth_session_json='{"email":"old@example.test"}'), "SESSION_EMAIL_MISMATCH")]:
            with self.subTest(field=field):
                fresh = session()
                setattr(fresh, field, value)
                with self.assertRaises(WorkerError) as raised:
                    recover(request(), Mock(), Mock(side_effect=AssertionError), Mock(return_value=fresh))
                self.assertEqual(raised.exception.code, code)
                fresh.auth.close.assert_called_once()

    def test_checkpoint_precedes_client_creation_and_requires_exact_ack(self):
        for reply in [None, {}, {"type": "code", "code": "123456"}, {"type": "identity_ack", "extra": 1}]:
            old, client, events = session("old@example.test"), Mock(), []
            req = {**request(), "type": "run", "requireIdentityCheckpoint": True}
            with self.assertRaises(WorkerError):
                run(req, events.append, Mock(return_value=reply), Mock(return_value=old), client)
            client.assert_not_called()
            self.assertEqual(events[-1], {"type": "identity", "accountId": "id"})
            old.auth.close.assert_called_once()

    def test_checkpoint_and_every_stage_ack_before_mutation(self):
        old, fresh, events = session("old@example.test"), session(), []
        client = Mock()
        client.eligibility.return_value = {"eligible": True}
        def receive():
            event = events[-1]
            if event["type"] == "identity":
                client.eligibility.assert_not_called()
                return {"type": "identity_ack"}
            if event["type"] == "need_code":
                return {"type": "code", "code": "123456"}
            if event["stage"] == "begin":
                client.begin.assert_not_called()
            if event["stage"] == "verify":
                client.verify.assert_not_called()
            return {"type": "stage_ack", "stage": event["stage"]}
        result = run({**request(), "type": "run", "requireIdentityCheckpoint": True, "requireStageAck": True},
                     events.append, receive, Mock(side_effect=[old, fresh]), Mock(return_value=client))
        self.assertTrue(result["mfaVerified"])
        client.verify.assert_called_once()

    def test_missing_verify_stage_ack_never_verifies(self):
        events, client = [], Mock()
        client.eligibility.return_value = {"eligible": True}
        def receive():
            event = events[-1]
            if event["type"] == "need_code":
                return {"type": "code", "code": "123456"}
            return {"type": "stage_ack", "stage": "wrong" if event["stage"] == "verify" else event["stage"]}
        with self.assertRaises(WorkerError):
            run({**request(), "requireStageAck": True}, events.append, receive, Mock(return_value=session()), Mock(return_value=client))
        client.verify.assert_not_called()

    def test_real_http_messages_only_expose_status(self):
        for message, status in [("verify HTTP 403", 403), ("begin HTTP 409", 409),
                                ("Auth URL ????: HTTP 401 - secret headers body credentials", 401)]:
            with self.subTest(status=status):
                self.assertEqual(error_message(RuntimeError(message)), {
                    "type": "error", "code": "NETWORK_FAILED",
                    "diagnostic": {"category": "http", "httpStatus": status, "curlCode": None}})

    def test_wrapped_curl_35_is_tls_without_raw_messages(self):
        cause = RuntimeError("curl: (35) secret https://fixture?password=secret headers body")
        wrapped = RuntimeError("wrapped secret credentials")
        wrapped.__cause__ = cause
        self.assertEqual(error_message(wrapped), {
            "type": "error", "code": "NETWORK_TLS",
            "diagnostic": {"category": "tls", "httpStatus": None, "curlCode": 35}})

    def test_diagnostics_are_numbers_and_controlled_categories_only(self):
        for exc, code, category, status, curl in [
            (TimeoutError("secret url password"), "NETWORK_TIMEOUT", "timeout", None, None),
            (RuntimeError("curl: (60) secret https://fixture?token=secret"), "NETWORK_TLS", "tls", None, 60),
            (RuntimeError("curl: (5) secret headers"), "NETWORK_PROXY", "proxy", None, 5),
            (RuntimeError("HTTP/1.1 503 secret body"), "NETWORK_FAILED", "http", 503, None),
            (ConnectionError("secret"), "NETWORK_FAILED", "unknown", None, None),
            (RuntimeError("secret curl: 999 HTTP: 999"), "WORKER_FAILED", "unknown", None, None),
        ]:
            self.assertEqual(error_message(exc), {"type": "error", "code": code,
                "diagnostic": {"category": category, "httpStatus": status, "curlCode": curl}})
        exc = WorkerError("VERIFY_FAILED")
        cause = RuntimeError("secret")
        cause.code = 28
        exc.__cause__ = cause
        self.assertEqual(error_message(exc), {"type": "error", "code": "VERIFY_FAILED",
            "diagnostic": {"category": "timeout", "httpStatus": None, "curlCode": 28}})


if __name__ == "__main__":
    unittest.main()
