import re

LOGIN_PHASES = frozenset({"input", "bootstrap", "authorize_continue", "password_verify",
    "mfa_factor", "mfa_issue", "mfa_verify", "reauthorize", "redirect", "callback", "session"})
LOGIN_REASONS = frozenset({"LOGIN_INPUT_MISSING", "LOGIN_STEP_FAILED", "LOGIN_HTTP_ERROR",
    "LOGIN_CREDENTIALS_REJECTED", "LOGIN_RESPONSE_INVALID", "LOGIN_PASSWORD_PAGE_MISSING",
    "LOGIN_MFA_FACTOR_MISSING", "LOGIN_MFA_CODE_REJECTED", "LOGIN_MFA_REJECTED",
    "LOGIN_CONTINUE_MISSING", "LOGIN_CALLBACK_INVALID", "LOGIN_CALLBACK_REUSED",
    "LOGIN_SESSION_MISSING"})


class LoginFlowError(RuntimeError):
    def __init__(self, phase, reason, status_code=None):
        super().__init__(reason)
        self.code = "LOGIN_FAILED"
        self.diagnostic = {"phase": phase, "reason": reason}
        self.status_code = status_code


def diagnostic(exc, *, login_details=False):
    status = curl = None
    categories = set()
    seen = set()
    login = {}
    while isinstance(exc, BaseException) and id(exc) not in seen and len(seen) < 10:
        seen.add(id(exc))
        controlled = getattr(exc, "diagnostic", None)
        if isinstance(controlled, dict) and not login:
            phase, reason = controlled.get("phase"), controlled.get("reason")
            if isinstance(phase, str) and isinstance(reason, str) and phase in LOGIN_PHASES and reason in LOGIN_REASONS:
                login = {"phase": phase, "reason": reason}
        name = type(exc).__name__.lower()
        text = str(exc)[:8192]
        code = getattr(exc, "code", None)
        if type(code) is int and 1 <= code <= 99:
            curl = code
        if type(code) is int and 100 <= code <= 599:
            status = code
        value = getattr(exc, "status_code", None)
        if value is None:
            value = getattr(getattr(exc, "response", None), "status_code", None)
        if type(value) is int and 100 <= value <= 599:
            status = value
        match = re.search(r"\bcurl(?:\s*:\s*\(?\s*|\s*\(\s*)([1-9][0-9]?)(?!\d)", text, re.I)
        if match:
            curl = int(match.group(1))
        match = re.search(r"\bHTTP(?:/\d(?:\.\d)?)?(?:\s+status(?:\s+code)?\s*[:=]?|\s+error\s*[:=]?|\s*:)\s*([1-5][0-9]{2})(?!\d)|\bHTTP(?:/\d(?:\.\d)?)?\s+([1-5][0-9]{2})(?!\d)", text, re.I)
        if match:
            status = int(match.group(1) or match.group(2))
        if isinstance(exc, TimeoutError) or "timeout" in name:
            categories.add("timeout")
        if "ssl" in name or "tls" in name or "certificate" in name:
            categories.add("tls")
        if "proxy" in name:
            categories.add("proxy")
        if "protocol" in name or code == "PROTOCOL_ERROR":
            categories.add("protocol")
        exc = exc.__cause__ or exc.__context__
    if curl == 28:
        categories.add("timeout")
    if curl in (35, 51, 53, 54, 58, 59, 60, 64, 66, 77, 80, 82, 83, 90, 91):
        categories.add("tls")
    if curl in (5, 97):
        categories.add("proxy")
    if status is not None:
        categories.add("http")
    category = next((value for value in ("timeout", "tls", "proxy", "http", "protocol") if value in categories), "unknown")
    return {"category": category, "httpStatus": status, "curlCode": curl,
            **(login if login_details else {})}
