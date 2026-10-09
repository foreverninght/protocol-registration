import base64
import json

from runtime import WorkerError


ORIGIN = "https://chatgpt.com"
COOKIE = "__Secure-next-auth.session-token"


class SessionExpired(Exception):
    pass


def session_error(code, reason="LOGIN_RESPONSE_INVALID", status=None):
    error = WorkerError(code)
    error.diagnostic = {"phase": "session", "reason": reason}
    if status is not None:
        error.status_code = status
    return error


def saved_tokens(request):
    session = request.get("session")
    if session is None:
        return None
    if not isinstance(session, dict):
        raise WorkerError("INVALID_INPUT")
    tokens = {}
    for key in ("accessToken", "sessionToken"):
        value = session.get(key, "")
        if not isinstance(value, str) or any(ord(char) < 33 or ord(char) > 126 for char in value):
            raise WorkerError("INVALID_INPUT")
        tokens[key] = value
    if not tokens["sessionToken"]:
        return None
    if request.get("mfaPreviouslyVerified") is not True:
        raise WorkerError("MFA_FAILED")
    return tokens


def restore(tokens, proxy):
    from registration_core.auth_flow import AuthFlow
    from registration_core.config import Config

    auth = AuthFlow(Config(proxy=proxy, registration_mode="protocol"))
    try:
        auth.result.access_token = ""
        auth.result.session_token = tokens["sessionToken"]
        token = tokens["sessionToken"]
        chunks = [token[index:index + 3800] for index in range(0, len(token), 3800)]
        for index, chunk in enumerate(chunks):
            name = COOKIE if len(chunks) == 1 else f"{COOKIE}.{index}"
            auth.session.cookies.set(name, chunk, domain="chatgpt.com", path="/", secure=True)
        return auth
    except Exception:
        try:
            auth.close()
        except Exception:
            pass
        raise


def confirm_identity(auth, expected, email):
    try:
        response = auth.session.get(
            ORIGIN + "/api/auth/session", headers=auth._chatgpt_client_headers(include_auth=False),
            timeout=30, allow_redirects=False,
        )
    except Exception as exc:
        raise session_error("NETWORK_FAILED", "LOGIN_STEP_FAILED") from exc
    status = response.status_code
    if status == 401:
        raise SessionExpired()
    if status != 200:
        raise session_error("TRIAL_PROBE_FAILED", "LOGIN_HTTP_ERROR", status)
    try:
        data = response.json()
    except Exception as exc:
        raise session_error("LOGIN_INCOMPLETE") from exc
    if data == {}:
        raise SessionExpired()
    identity = confirm_response(auth, data, expected, email)
    session_token = auth._extract_session_cookie()
    if session_token:
        auth.result.session_token = session_token
    return identity


def confirm_response(auth, data, expected, email):
    if not isinstance(data, dict):
        raise session_error("LOGIN_INCOMPLETE")
    user = data.get("user")
    actual_email = user.get("email") if isinstance(user, dict) else data.get("email")
    if not isinstance(actual_email, str) or actual_email.strip().lower() != email.strip().lower():
        raise session_error("SESSION_EMAIL_MISMATCH")
    token = data.get("accessToken") or data.get("access_token")
    if not isinstance(token, str) or not token:
        raise session_error("LOGIN_INCOMPLETE")
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        account = claims["https://api.openai.com/auth"]["chatgpt_account_id"]
    except (ValueError, KeyError, IndexError, TypeError):
        raise session_error("LOGIN_INCOMPLETE") from None
    if not isinstance(account, str) or account != expected:
        raise session_error("ACCOUNT_MISMATCH")
    auth.result.access_token = token
    auth.result.auth_session_json = json.dumps(data)
    return actual_email, account
