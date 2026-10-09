import contextlib
import json
import logging
import os
import sys

sys.dont_write_bytecode = True
for key in list(os.environ):
    if key.startswith(("AUTH_", "OAUTH_", "OPENAI_", "PROTOCOL_", "REGISTRATION_", "LOGIN_", "BROWSER_")) and key != "OPENAI_SENTINEL_NODE_PATH":
        del os.environ[key]
logging.disable(logging.CRITICAL)

from runtime import WorkerError, run
from trial_runtime import run as run_trial
from recovery_runtime import run as run_recovery
from diagnostics import diagnostic

MAX_LINE = 65536
ERROR_CODES = {"INVALID_INPUT", "INVALID_CODE", "PROTOCOL_ERROR", "NOT_ELIGIBLE",
               "LOGIN_FAILED", "LOGIN_INCOMPLETE", "MFA_FAILED", "MFA_INVALID_CODE",
               "BEGIN_FAILED", "VERIFY_FAILED", "REAUTH_FAILED", "RELOGIN_FAILED",
               "ACCOUNT_MISMATCH", "SESSION_EMAIL_MISMATCH", "TRIAL_PROBE_FAILED",
               "NETWORK_TIMEOUT", "NETWORK_TLS", "NETWORK_PROXY", "NETWORK_FAILED"}


def error_message(exc, trial=False):
    code = getattr(exc, "code", None)
    detail = diagnostic(exc, login_details=trial)
    network = False
    credential_failure = False
    explicit_code = None
    current, seen = exc, set()
    while isinstance(current, BaseException) and id(current) not in seen and len(seen) < 10:
        seen.add(id(current))
        current_code = getattr(current, "code", None)
        if (explicit_code is None and isinstance(current_code, str) and current_code in ERROR_CODES
                and current_code not in {"LOGIN_FAILED", "MFA_FAILED", "TRIAL_PROBE_FAILED",
                                         "NETWORK_TIMEOUT", "NETWORK_TLS", "NETWORK_PROXY", "NETWORK_FAILED"}):
            explicit_code = current_code
        text = str(current)[:8192].lower()
        credential_failure = credential_failure or any(marker in text for marker in (
            "invalid_username_or_password", "invalid_credentials", "incorrect password",
            "invalid password", "\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef"))
        network = network or isinstance(current, ConnectionError) or any(
            name in type(current).__name__.lower() for name in ("connection", "requestexception", "curlerror"))
        current = current.__cause__ or current.__context__
    if trial and "reason" in detail:
        credential_failure = detail["reason"] == "LOGIN_CREDENTIALS_REJECTED"
    if not trial:
        code = code if isinstance(code, str) and code in ERROR_CODES else {
            "timeout": "NETWORK_TIMEOUT", "tls": "NETWORK_TLS", "proxy": "NETWORK_PROXY",
            "http": "NETWORK_FAILED"}.get(detail["category"], "NETWORK_FAILED" if network or detail["curlCode"] else "WORKER_FAILED")
        return {"type": "error", "code": code, "diagnostic": detail}
    if detail["httpStatus"] is not None:
        detail["category"] = "http"
    code = code if isinstance(code, str) and code in ERROR_CODES else "WORKER_FAILED"
    if explicit_code is not None:
        code = explicit_code
    elif credential_failure:
        code = "LOGIN_FAILED"
    elif detail["httpStatus"] is not None:
        if code.startswith("NETWORK_"):
            code = "WORKER_FAILED"
    else:
        code = {"timeout": "NETWORK_TIMEOUT", "tls": "NETWORK_TLS", "proxy": "NETWORK_PROXY"}.get(
            detail["category"], "NETWORK_FAILED" if network or detail["curlCode"] else code)
    return {"type": "error", "code": code, "diagnostic": detail}


class Sink:
    def write(self, value):
        return len(value)

    def flush(self):
        pass


def receive():
    line = sys.stdin.buffer.readline(MAX_LINE + 1)
    if len(line) > MAX_LINE or not line.endswith(b"\n"):
        raise WorkerError("PROTOCOL_ERROR")
    value = json.loads(line)
    if not isinstance(value, dict):
        raise WorkerError("PROTOCOL_ERROR")
    return value


def main():
    output = sys.stdout
    request_type = None
    def emit(value):
        output.write(json.dumps(value, ensure_ascii=True, separators=(",", ":")) + "\n")
        output.flush()
    try:
        with contextlib.redirect_stdout(Sink()), contextlib.redirect_stderr(Sink()):
            request = receive()
            request_type = request.get("type")
            if request_type not in ("run", "trial", "recover"):
                raise WorkerError("PROTOCOL_ERROR")
            handler = {"run": run, "trial": run_trial, "recover": run_recovery}[request_type]
            result = handler(request, emit, receive)
        emit({"type": "result", "result": result})
        return 0
    except Exception as exc:
        emit(error_message(exc, trial=request_type == "trial"))
        return 1


if __name__ == "__main__":
    sys.exit(main())
