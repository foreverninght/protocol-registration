import json
import re

from runtime import WorkerError
from trial_session import SessionExpired, confirm_identity, confirm_response, restore, saved_tokens


CAMPAIGN = "plus-1-month-free"
LOGIN_CODES = {"INVALID_INPUT", "LOGIN_FAILED", "LOGIN_INCOMPLETE", "MFA_FAILED", "MFA_INVALID_CODE"}


def run(request, emit, receive, login_fn=None):
    credentials = request.get("credentials")
    if not isinstance(credentials, dict):
        raise WorkerError("INVALID_INPUT")
    fields = [credentials.get(key) for key in ("email", "password", "totpSecret")]
    proxy, expected = request.get("proxy"), request.get("expectedAccountId")
    if any(not isinstance(value, str) or not value.strip() for value in fields + [proxy, expected]):
        raise WorkerError("INVALID_INPUT")
    email, password, secret = fields
    tokens = saved_tokens(request)
    fresh = None
    auth = None
    try:
        if tokens:
            emit({"type": "stage", "stage": "session_trial"})
            auth = restore(tokens, proxy)
            try:
                actual_email, account = confirm_identity(auth, expected, email)
            except SessionExpired:
                try:
                    auth.close()
                except Exception:
                    pass
                auth = None
            else:
                return probe_trial(auth, actual_email, account, emit)
        emit({"type": "stage", "stage": "login_trial"})
        try:
            if login_fn is None:
                from rebind_core.mfa_login import login_with_password_and_totp
                login_fn = login_with_password_and_totp
            fresh = login_fn(email, password, secret, proxy=proxy)
        except Exception as exc:
            code = getattr(exc, "code", None)
            raise WorkerError(code if isinstance(code, str) and code in LOGIN_CODES else "LOGIN_FAILED") from exc
        auth = fresh.auth
        if any(not isinstance(value, str) or not value.strip() for value in
               [getattr(fresh, key, None) for key in ("account_id", "factor_id", "session_token", "access_token")]):
            raise WorkerError("LOGIN_INCOMPLETE")
        if fresh.account_id != expected:
            raise WorkerError("ACCOUNT_MISMATCH")
        try:
            data = json.loads(fresh.result.auth_session_json)
            user = data.get("user") or {}
            actual_email = user.get("email") or data.get("email")
        except (ValueError, AttributeError, TypeError):
            raise WorkerError("SESSION_EMAIL_MISMATCH") from None
        if not isinstance(actual_email, str) or actual_email.strip().lower() != email.strip().lower():
            raise WorkerError("SESSION_EMAIL_MISMATCH")
        actual_email, account = confirm_response(auth, data, expected, email)
        return probe_trial(auth, actual_email, account, emit)
    finally:
        if auth is not None:
            try:
                auth.close()
            except Exception:
                pass


def probe_trial(auth, actual_email, account, emit):
    result = {"email": actual_email, "accountId": account, "mfaVerified": True,
              "status": "error", "campaignId": CAMPAIGN, "amountMinor": None,
              "currency": None, "billingCountry": None, "errorCode": "TRIAL_PROBE_FAILED"}
    result["session"] = {"accessToken": auth.result.access_token,
                         "sessionToken": auth.result.session_token}
    emit({"type": "stage", "stage": "trial_qualification"})
    try:
        probe = auth.bootstrap_chatgpt_client_and_probe_trial(strict_coupon_errors=True)
        if not isinstance(probe, dict):
            return result
        status = probe.get("status")
        amount = probe.get("amount_minor")
        currency = probe.get("amount_currency")
        country = probe.get("billing_country")
        if (status not in ("eligible", "ineligible", "error") or probe.get("campaign_id") != CAMPAIGN
                or (amount is not None and type(amount) is not int)
                or (currency is not None and (not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency)))
                or (country is not None and (not isinstance(country, str) or not re.fullmatch(r"[A-Z]{2}", country)))):
            return result
        if status != "error" and probe.get("source") != "protocol_bootstrap/check_coupon":
            return result
        if status == "eligible" and probe.get("detail") != "check_coupon:state=eligible":
            return result
        result.update(status=status, amountMinor=amount, currency=currency, billingCountry=country,
                      errorCode="TRIAL_PROBE_FAILED" if status == "error" else None)
    except Exception as exc:
        raise WorkerError("TRIAL_PROBE_FAILED") from exc
    return result
