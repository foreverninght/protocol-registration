import json
import time


class WorkerError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def run(request, emit, receive, login_fn=None, client_cls=None):
    if login_fn is None:
        from rebind_core.mfa_login import login_with_password_and_totp
        login_fn = login_with_password_and_totp
    if client_cls is None:
        from rebind_core.change_email import ChangeEmailClient
        client_cls = ChangeEmailClient
    credentials = request.get("credentials")
    if not isinstance(credentials, dict):
        raise WorkerError("INVALID_INPUT")
    fields = [credentials.get(k) for k in ("email", "password", "totpSecret")]
    new_email, proxy = request.get("newEmail"), request.get("proxy")
    if any(not isinstance(v, str) or not v.strip() for v in fields + [new_email, proxy]):
        raise WorkerError("INVALID_INPUT")
    email, password, secret = fields
    if new_email.strip().lower() == email.strip().lower():
        raise WorkerError("INVALID_INPUT")
    sessions = []
    def login(address):
        value = login_fn(address, password, secret, proxy=proxy)
        sessions.append(value)
        if not value.account_id or not value.factor_id or not value.session_token or not value.access_token:
            raise WorkerError("LOGIN_INCOMPLETE")
        return value
    def stage(value):
        emit({"type": "stage", "stage": value})
        if request.get("requireStageAck") is True:
            if receive() != {"type": "stage_ack", "stage": value}:
                raise WorkerError("PROTOCOL_ERROR")
    try:
        stage("login_old")
        original = login(email)
        if request.get("requireIdentityCheckpoint") is True:
            if not isinstance(original.account_id, str) or not original.account_id.strip() or len(original.account_id) > 200:
                raise WorkerError("LOGIN_INCOMPLETE")
            emit({"type": "identity", "accountId": original.account_id})
            if receive() != {"type": "identity_ack"}:
                raise WorkerError("PROTOCOL_ERROR")
        stage("eligibility")
        client = client_cls(login=original)
        eligibility = client.eligibility()
        if not isinstance(eligibility, dict) or eligibility.get("eligible") is not True:
            raise WorkerError("NOT_ELIGIBLE")
        stage("begin")
        issued_after = int(time.time() * 1000)
        client.begin(new_email)
        emit({"type": "need_code", "issuedAfter": issued_after})
        reply = receive()
        if not isinstance(reply, dict) or reply.get("type") != "code":
            raise WorkerError("PROTOCOL_ERROR")
        code = reply.get("code")
        if not isinstance(code, str) or not code.isascii() or not code.isdigit() or not 4 <= len(code) <= 10:
            raise WorkerError("INVALID_CODE")
        stage("verify")
        client.verify(new_email, code)
        stage("login_new")
        fresh = login(new_email)
        if fresh.auth is original.auth:
            raise WorkerError("RELOGIN_FAILED")
        if fresh.account_id != original.account_id:
            raise WorkerError("ACCOUNT_MISMATCH")
        try:
            data = json.loads(fresh.result.auth_session_json)
            user = data.get("user") or {}
            actual_email = user.get("email") or data.get("email")
        except (ValueError, AttributeError, TypeError):
            raise WorkerError("SESSION_EMAIL_MISMATCH") from None
        if not isinstance(actual_email, str) or actual_email.strip().lower() != new_email.strip().lower():
            raise WorkerError("SESSION_EMAIL_MISMATCH")
        stage("completed")
        return {"email": actual_email, "accountId": fresh.account_id,
                "originalAccountId": original.account_id, "password": password,
                "totpSecret": secret, "sessionToken": fresh.session_token,
                "accessToken": fresh.access_token, "mfaVerified": True}
    finally:
        for session in sessions:
            try:
                session.auth.close()
            except Exception:
                pass
