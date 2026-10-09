import json

from runtime import WorkerError


def run(request, emit, receive, login_fn=None):
    credentials = request.get("credentials")
    if not isinstance(credentials, dict):
        raise WorkerError("INVALID_INPUT")
    fields = [credentials.get(key) for key in ("email", "password", "totpSecret")]
    new_email, expected, proxy = [request.get(key) for key in ("newEmail", "expectedAccountId", "proxy")]
    if any(not isinstance(value, str) or not value.strip() for value in fields + [new_email, expected, proxy]):
        raise WorkerError("INVALID_INPUT")
    if len(expected) > 200:
        raise WorkerError("INVALID_INPUT")
    _, password, secret = fields
    fresh = None
    try:
        emit({"type": "stage", "stage": "login_recovery"})
        if login_fn is None:
            from rebind_core.mfa_login import login_with_password_and_totp
            login_fn = login_with_password_and_totp
        fresh = login_fn(new_email, password, secret, proxy=proxy)
        if any(not isinstance(value, str) or not value.strip() for value in
               [getattr(fresh, key, None) for key in ("account_id", "factor_id", "session_token", "access_token")]):
            raise WorkerError("LOGIN_INCOMPLETE")
        if fresh.account_id != expected:
            raise WorkerError("ACCOUNT_MISMATCH")
        try:
            data = json.loads(fresh.result.auth_session_json)
            actual_email = (data.get("user") or {}).get("email") or data.get("email")
        except (ValueError, AttributeError, TypeError):
            raise WorkerError("SESSION_EMAIL_MISMATCH") from None
        if not isinstance(actual_email, str) or actual_email.strip().lower() != new_email.strip().lower():
            raise WorkerError("SESSION_EMAIL_MISMATCH")
        return {"email": actual_email, "accountId": fresh.account_id, "originalAccountId": expected,
                "password": password, "totpSecret": secret, "sessionToken": fresh.session_token,
                "accessToken": fresh.access_token, "mfaVerified": True}
    finally:
        if fresh is not None:
            try:
                fresh.auth.close()
            except Exception:
                pass
