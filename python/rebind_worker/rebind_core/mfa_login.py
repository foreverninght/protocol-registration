from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit
from diagnostics import LoginFlowError

from registration_core.auth_flow import AuthFlow, AuthResult  # noqa: E402
from registration_core.config import Config  # noqa: E402
from registration_core.mfa_totp_protocol import totp_code_candidates  # noqa: E402


class MfaLoginError(RuntimeError):
    def __init__(self, code: str, message: str, *, phase=None, reason=None, status_code=None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.diagnostic = {"phase": phase, "reason": reason}
        self.status_code = status_code


def _login_call(phase, function, *args, **kwargs):
    try:
        return function(*args, **kwargs)
    except (LoginFlowError, MfaLoginError):
        raise
    except Exception as exc:
        raise LoginFlowError(phase, "LOGIN_STEP_FAILED") from exc


@dataclass
class LoginSession:
    email: str
    password: str
    totp_secret: str
    auth: AuthFlow
    result: AuthResult
    factor_id: str = ""
    account_id: str = ""
    trace: list[dict[str, Any]] = field(default_factory=list)

    @property
    def access_token(self) -> str:
        return str(self.result.access_token or "")

    @property
    def session_token(self) -> str:
        return str(self.result.session_token or "")

    @property
    def device_id(self) -> str:
        return str(self.result.device_id or "")

    @property
    def cookie_header(self) -> str:
        return str(self.result.cookie_header or "")


def _mask(value: str, head: int = 8, tail: int = 4) -> str:
    text = str(value or "")
    if len(text) <= head + tail:
        return "*" * len(text)
    return f"{text[:head]}...{text[-tail:]}"


def _cookie_value(session, name: str) -> str:
    try:
        jar = getattr(session, "cookies", None)
        if jar is None:
            return ""
        # curl_cffi / requests CookieJar
        if hasattr(jar, "get"):
            val = jar.get(name)
            if val:
                return str(val)
        for c in list(jar):
            if getattr(c, "name", "") == name:
                return str(getattr(c, "value", "") or "")
    except Exception:
        return ""
    return ""


def _parse_client_auth_session(raw: str) -> dict[str, Any]:
    text = unquote(str(raw or "").strip())
    if not text:
        return {}
    try:
        data = json.loads(text)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def extract_factor_id(*sources: Any) -> str:
    def structured(value: Any) -> str:
        if isinstance(value, dict):
            kind = str(value.get("type") or value.get("factor_type") or "").lower()
            if kind in {"totp", "otp_totp"}:
                fid = str(value.get("id") or value.get("factor_id") or "").strip()
                if re.fullmatch(r"[A-Za-z0-9_-]{1,128}", fid):
                    return fid
            for nested in value.values():
                if isinstance(nested, (dict, list)):
                    found = structured(nested)
                    if found:
                        return found
        elif isinstance(value, list):
            for nested in value:
                found = structured(nested)
                if found:
                    return found
        return ""

    def from_url(value: Any) -> str:
        if isinstance(value, str):
            parsed = urlsplit(value)
            if parsed.netloc and (parsed.scheme != "https" or parsed.netloc != "auth.openai.com"):
                return ""
            match = re.fullmatch(r"/mfa-challenge/([A-Za-z0-9_-]{1,128})/?", parsed.path)
            return match.group(1) if match else ""
        if isinstance(value, dict):
            for key in ("continue_url", "continueUrl", "url", "redirect_url"):
                found = from_url(value.get(key))
                if found:
                    return found
            for key, nested in value.items():
                if key not in {"factors", "mfa_factors", "mfa_challenge_factors"} and isinstance(nested, (dict, list)):
                    found = from_url(nested)
                    if found:
                        return found
        elif isinstance(value, list):
            for nested in value:
                found = from_url(nested)
                if found:
                    return found
        return ""

    for resolver in (structured, from_url):
        for source in sources:
            found = resolver(source)
            if found:
                return found
    return ""


def _decode_account_id_from_at(access_token: str) -> str:
    try:
        import base64

        parts = str(access_token or "").split(".")
        if len(parts) < 2:
            return ""
        payload = parts[1] + "=" * ((4 - len(parts[1]) % 4) % 4)
        data = json.loads(base64.urlsafe_b64decode(payload))
        auth = data.get("https://api.openai.com/auth") or {}
        return str(auth.get("chatgpt_account_id") or "").strip()
    except Exception:
        return ""


def _mfa_response(resp: Any, step: str) -> dict[str, Any]:
    try:
        data = resp.json()
    except (ValueError, TypeError):
        data = None
    error = data.get("error") if isinstance(data, dict) else None
    error_code = str(error.get("code") or "") if isinstance(error, dict) else str(error or "")
    if resp.status_code != 200 or error or (isinstance(data, dict) and data.get("success") is False):
        retryable = (
            step == "verify"
            and resp.status_code in {400, 401, 422}
            and error_code in {"invalid_code", "invalid_totp_code", "invalid_otp_code"}
        )
        raise MfaLoginError(
            "MFA_INVALID_CODE" if retryable else "MFA_FAILED",
            "MFA response rejected",
            phase="mfa_verify" if step == "verify" else "mfa_issue",
            reason="LOGIN_MFA_CODE_REJECTED" if retryable else "LOGIN_MFA_REJECTED",
            status_code=resp.status_code,
        )
    if not isinstance(data, dict):
        raise MfaLoginError("MFA_FAILED", "Expected a JSON object",
            phase="mfa_verify" if step == "verify" else "mfa_issue", reason="LOGIN_RESPONSE_INVALID")
    return data


def issue_mfa_challenge(auth: AuthFlow, factor_id: str) -> dict[str, Any]:
    headers = auth._common_headers("https://auth.openai.com/log-in/password")
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "*/*"
    resp = auth.session.post(
        "https://auth.openai.com/api/accounts/mfa/issue_challenge",
        headers=headers,
        json={
            "id": factor_id,
            "type": "totp",
            "force_fresh_challenge": False,
        },
        timeout=30,
    )
    if hasattr(auth, "_trace_http"):
        try:
            auth._trace_http("mfa_issue_challenge", resp)
        except Exception:
            pass
    return _mfa_response(resp, "issue_challenge")


def verify_mfa_totp(auth: AuthFlow, factor_id: str, code: str) -> dict[str, Any]:
    referer = f"https://auth.openai.com/mfa-challenge/{factor_id}"
    headers = auth._common_headers(referer)
    headers["Content-Type"] = "application/json"
    headers["Accept"] = "application/json"
    resp = auth.session.post(
        "https://auth.openai.com/api/accounts/mfa/verify",
        headers=headers,
        json={"id": factor_id, "type": "totp", "code": str(code).strip()},
        timeout=30,
    )
    if hasattr(auth, "_trace_http"):
        try:
            auth._trace_http("mfa_verify", resp)
        except Exception:
            pass
    return _mfa_response(resp, "verify")


def _is_callback(url: str) -> bool:
    parsed = urlsplit(url)
    return (
        parsed.scheme == "https"
        and parsed.netloc == "chatgpt.com"
        and parsed.path == "/api/auth/callback/openai"
        and bool(parse_qs(parsed.query).get("code"))
    )


def _finish_to_session(auth: AuthFlow, continue_url: str) -> AuthResult:
    continue_url = auth._normalize_continue_url(continue_url or "")
    if not continue_url:
        raise LoginFlowError("redirect", "LOGIN_CONTINUE_MISSING")
    if _is_callback(continue_url):
        callback_url = continue_url
    else:
        callback_url, _ = _login_call("redirect", auth.follow_redirect_chain, continue_url)
    if callback_url:
        if not _is_callback(callback_url):
            raise LoginFlowError("callback", "LOGIN_CALLBACK_INVALID")
        _login_call("callback", auth._consume_callback_for_session, callback_url)
    _login_call("session", auth.get_auth_session)
    if not auth.result.is_valid():
        raise LoginFlowError("session", "LOGIN_SESSION_MISSING")
    return auth.result


def _login_with_password_and_totp(
    email: str,
    password: str,
    totp_secret: str,
    *,
    auth: AuthFlow,
) -> LoginSession:
    """账密 + TOTP 纯协议登录，返回可用 session/AT。"""
    email = (email or "").strip()
    password = password or ""
    totp_secret = (totp_secret or "").strip().replace(" ", "").upper()
    if not email or not password or not totp_secret:
        raise LoginFlowError("input", "LOGIN_INPUT_MISSING")

    result = auth.result
    result.email = email
    result.password = password
    sess = LoginSession(
        email=email,
        password=password,
        totp_secret=totp_secret,
        auth=auth,
        result=result,
    )

    # 1) bootstrap
    csrf = _login_call("bootstrap", auth.get_csrf_token)
    auth_url = _login_call("bootstrap", auth.get_auth_url, csrf, email=email)
    device_id = _login_call("bootstrap", auth.auth_oauth_init, auth_url)
    sentinel = _login_call("bootstrap", auth.get_sentinel_token, device_id)
    sess.trace.append({"step": "bootstrap"})

    # 2) authorize continue login
    login_step = _login_call("authorize_continue", auth.authorize_continue,
        email=email,
        sentinel_token=sentinel,
        screen_hint="login",
        referer="https://auth.openai.com/log-in",
        trace_step="authorize_continue_login_rebind",
    )
    if not isinstance(login_step, dict):
        raise LoginFlowError("authorize_continue", "LOGIN_RESPONSE_INVALID")
    page_type = (auth._extract_page_type(login_step) or "").lower()
    continue_url = auth._normalize_continue_url(auth._extract_continue_url_from_step(login_step))
    sess.trace.append({"step": "authorize_continue"})

    if page_type != "login_password" and "/log-in/password" not in (continue_url or ""):
        raise LoginFlowError("authorize_continue", "LOGIN_PASSWORD_PAGE_MISSING")

    # 3) password verify（内部会带 sentinel）
    # 刷新一枚较新的 sentinel，贴近抓包
    _login_call("password_verify", auth.get_sentinel_token, device_id, flow="password_verify")
    pwd_resp = _login_call("password_verify", auth.login_password_verify, password)
    if not isinstance(pwd_resp, dict):
        raise LoginFlowError("password_verify", "LOGIN_RESPONSE_INVALID")
    page_type = (auth._extract_page_type(pwd_resp) or "").lower()
    continue_url = auth._normalize_continue_url(auth._extract_continue_url_from_step(pwd_resp))
    sess.trace.append(
        {
            "step": "password_verify",
        }
    )

    # 4) resolve factor id
    client_auth = _parse_client_auth_session(_cookie_value(auth.session, "oai-client-auth-session"))
    factor_id = extract_factor_id(continue_url, pwd_resp, client_auth)
    if not factor_id:
        # some responses put factors under page.payload
        factor_id = extract_factor_id((pwd_resp or {}).get("page") if isinstance(pwd_resp, dict) else None)
    if not factor_id:
        raise MfaLoginError("MFA_FAILED", "TOTP factor missing",
            phase="mfa_factor", reason="LOGIN_MFA_FACTOR_MISSING")
    sess.factor_id = factor_id

    # 5) issue + verify totp
    _login_call("mfa_issue", issue_mfa_challenge, auth, factor_id)
    verify_resp: dict[str, Any] = {}
    for code in _login_call("mfa_verify", totp_code_candidates, totp_secret, window=1):
        try:
            verify_resp = _login_call("mfa_verify", verify_mfa_totp, auth, factor_id, code)
            sess.trace.append({"step": "mfa_verify", "ok": True})
            break
        except MfaLoginError as exc:
            if exc.code != "MFA_INVALID_CODE":
                raise
    else:
        raise MfaLoginError("MFA_FAILED", "TOTP validation failed",
            phase="mfa_verify", reason="LOGIN_MFA_CODE_REJECTED")

    continue_url = auth._normalize_continue_url(auth._extract_continue_url_from_step(verify_resp))
    if "/mfa-challenge/" in continue_url:
        continue_url = ""
    if not continue_url:
        client_auth2 = _parse_client_auth_session(_cookie_value(auth.session, "oai-client-auth-session"))
        continue_url = auth._normalize_continue_url(auth._extract_continue_url_from_step(client_auth2))
        if "/mfa-challenge/" in continue_url:
            continue_url = ""
    if not continue_url:
        continue_url = auth._normalize_continue_url(_login_call("reauthorize", auth._reauthorize_for_session, auth_url) or "")
    if continue_url:
        _finish_to_session(auth, continue_url)
    else:
        _login_call("session", auth.get_auth_session)
        if not auth.result.is_valid():
            raise LoginFlowError("reauthorize", "LOGIN_CONTINUE_MISSING")
    if not auth.result.is_valid():
        raise LoginFlowError("session", "LOGIN_SESSION_MISSING")

    sess.account_id = _decode_account_id_from_at(auth.result.access_token)
    sess.trace.append(
        {
            "step": "session",
            "has_at": bool(auth.result.access_token),
            "has_session": bool(auth.result.session_token),
        }
    )
    return sess


def login_with_password_and_totp(
    email: str,
    password: str,
    totp_secret: str,
    *,
    proxy: str | None = None,
    upstream_proxy: str | None = None,
) -> LoginSession:
    auth = AuthFlow(Config(proxy=proxy or None, upstream_proxy=upstream_proxy or None,
                           registration_mode="protocol"))
    auth.strict_login_errors = True
    try:
        return _login_with_password_and_totp(email, password, totp_secret, auth=auth)
    except BaseException:
        try:
            auth.close()
        except Exception:
            pass
        raise
