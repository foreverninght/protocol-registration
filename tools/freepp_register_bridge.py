# -*- coding: utf-8 -*-
"""Run mio-cc/freepp as a sidecar registration branch.

Stdout is reserved for newline-delimited JSON RPC with the Node parent.
freepp's own prints are redirected to stderr so protocol messages stay clean.
"""
from __future__ import annotations

import argparse
import ast
import base64
import contextlib
import hashlib
import hmac
import json
import os
import re
import sys
import struct
import threading
import time
import uuid
from dataclasses import asdict
from html import unescape
from http.cookies import SimpleCookie
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, quote, urlencode, urljoin, urlparse, urlunparse
from urllib import request as urllib_request
from urllib.error import HTTPError, URLError


PROTOCOL_OUT = sys.stdout
NEXTAUTH_STATE_COOKIE = "__Secure-next-auth.state"
_NEXTAUTH_STATE_SNAPSHOTS: dict[int, list[dict[str, Any]]] = {}
_LAST_CHATGPT_SESSION_CONTEXT: dict[str, Any] = {}
_LAST_CHATGPT_SESSION: Any = None
_LAST_OAUTH_SESSION_CONTEXT: dict[str, Any] = {}
_LAST_PHONE_BIND_PROBE: dict[str, Any] = {}
_PHONE_BIND_PROBE_CONFIG: dict[str, Any] = {}


class _RegistrationLogObserver:
    def __init__(self, target: Any):
        self.target = target
        self.tail = ""
        self.password_created = False

    def write(self, value: str) -> int:
        text = str(value)
        self.target.write(text)
        self.target.flush()
        self.tail = (self.tail + text)[-2048:]
        if "密码流程 user/register 成功" in self.tail or "user/register status=200" in self.tail:
            self.password_created = True
        return len(text)

    def flush(self) -> None:
        self.target.flush()


class ParentRpcError(RuntimeError):
    def __init__(self, message: str, code: str = ""):
        super().__init__(message)
        self.code = code


def _send(payload: dict[str, Any]) -> dict[str, Any]:
    request_id = uuid.uuid4().hex
    msg = {"id": request_id, **payload}
    print(json.dumps(msg, ensure_ascii=False), file=PROTOCOL_OUT, flush=True)
    while True:
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("parent process closed stdin")
        try:
            response = json.loads(line)
        except Exception:
            continue
        if response.get("id") != request_id:
            continue
        if response.get("ok") is False:
            raise ParentRpcError(str(response.get("error") or "parent RPC failed"), str(response.get("error_code") or ""))
        return response


def _event(step: str, **payload: Any) -> None:
    _send({"type": "event", "step": step, "payload": payload})


def _mask_code(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if len(text) <= 2:
        return "*" * len(text)
    return f"{'*' * (len(text) - 2)}{text[-2:]}"


def _load_config(raw: str) -> dict[str, Any]:
    if not raw:
        return {}
    decoded = base64.b64decode(raw.encode("ascii")).decode("utf-8")
    data = json.loads(decoded)
    if not isinstance(data, dict):
        raise ValueError("config must be a JSON object")
    return data


def _load_stdin_config() -> dict[str, Any]:
    line = sys.stdin.readline()
    if not line:
        raise ValueError("missing sidecar initialization message")
    try:
        message = json.loads(line)
    except (ValueError, TypeError):
        raise ValueError("invalid sidecar initialization message") from None
    if not isinstance(message, dict) or message.get("type") != "init" or not isinstance(message.get("config"), dict):
        raise ValueError("invalid sidecar initialization message")
    return message["config"]


def _proxy_url(proxy: Any) -> str:
    if not isinstance(proxy, dict):
        return ""
    host = str(proxy.get("host") or "").strip()
    port = str(proxy.get("port") or "").strip()
    if host and port:
        username = str(proxy.get("username") or "").strip()
        password = str(proxy.get("password") or "").strip()
        auth = ""
        if username or password:
            auth = f"{quote(username, safe='')}:{quote(password, safe='')}@"
        return f"http://{auth}{host}:{port}"
    raw = str(proxy.get("raw") or "").strip()
    if not raw:
        return ""
    return raw if "://" in raw else f"http://{raw}"


def _cookie_attr(cookie: Any, name: str, default: Any = None) -> Any:
    if isinstance(cookie, dict):
        return cookie.get(name, default)
    try:
        value = getattr(cookie, name)
    except Exception:
        return default
    return default if value is None else value


def _iter_cookies(session: Any) -> list[Any]:
    try:
        return list(session.cookies)
    except Exception:
        return []


def _cookie_domain_matches(cookie_domain: str, wanted_host: str) -> bool:
    domain = str(cookie_domain or "").strip().lstrip(".").lower()
    host = str(wanted_host or "").strip().lower()
    return bool(domain and (host == domain or host.endswith(f".{domain}")))


def _cookie_domain_candidates(host: str) -> list[str]:
    normalized = str(host or "").strip().lstrip(".").lower()
    if not normalized:
        return []
    candidates: list[str] = []
    parts = normalized.split(".")
    for index in range(0, max(1, len(parts) - 1)):
        domain = ".".join(parts[index:])
        if not domain or "." not in domain:
            continue
        candidates.extend([domain, f".{domain}"])
    deduped: list[str] = []
    seen: set[str] = set()
    for domain in candidates:
        if domain not in seen:
            seen.add(domain)
            deduped.append(domain)
    return deduped


def _cookie_dict_for_domain(session: Any, domain: str) -> dict[str, str]:
    try:
        jar = session.cookies
        data = jar.get_dict(domain=domain)  # type: ignore[attr-defined]
        if isinstance(data, dict):
            return {str(k): str(v) for k, v in data.items() if k and v}
    except Exception:
        pass
    return {}


def _cookie_header_for_host(session: Any, host: str) -> str:
    pairs: list[str] = []
    seen: set[str] = set()
    for cookie in _iter_cookies(session):
        name = str(_cookie_attr(cookie, "name", "") or "").strip()
        value = str(_cookie_attr(cookie, "value", "") or "")
        if not name or name in seen:
            continue
        domain = str(_cookie_attr(cookie, "domain", host) or host)
        if not _cookie_domain_matches(domain, host):
            continue
        seen.add(name)
        pairs.append(f"{name}={value}")
    for domain in _cookie_domain_candidates(host):
        for name, value in _cookie_dict_for_domain(session, domain).items():
            if name in seen:
                continue
            seen.add(name)
            pairs.append(f"{name}={value}")
    return "; ".join(pairs)


def _cookie_rest(cookie: Any) -> dict[str, Any]:
    try:
        rest = getattr(cookie, "_rest", {}) or {}
        return rest if isinstance(rest, dict) else {}
    except Exception:
        return {}


def _cookie_same_site(cookie: Any) -> str | None:
    rest = _cookie_rest(cookie)
    for key in ("SameSite", "samesite", "sameSite"):
        value = str(rest.get(key) or "").strip()
        if value:
            normalized = value.lower()
            if normalized in {"strict", "lax", "none"}:
                return normalized.capitalize()
    return None


def _cookie_http_only(cookie: Any) -> bool:
    rest = _cookie_rest(cookie)
    return any(str(key).lower() == "httponly" for key in rest)


def _cookie_to_storage(cookie: Any) -> dict[str, Any]:
    item: dict[str, Any] = {
        "name": str(_cookie_attr(cookie, "name", "") or ""),
        "value": str(_cookie_attr(cookie, "value", "") or ""),
        "domain": str(_cookie_attr(cookie, "domain", "") or ""),
        "path": str(_cookie_attr(cookie, "path", "/") or "/"),
        "secure": bool(_cookie_attr(cookie, "secure", False)),
        "httpOnly": _cookie_http_only(cookie),
    }
    expires = _cookie_attr(cookie, "expires", None)
    if expires is not None:
        try:
            item["expires"] = int(expires)
        except Exception:
            pass
    same_site = _cookie_same_site(cookie)
    if same_site:
        item["sameSite"] = same_site
    return item


def _cookies_for_hosts(session: Any, hosts: list[str]) -> list[dict[str, Any]]:
    cookies: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()

    def add_cookie(item: dict[str, Any]) -> None:
        name = str(item.get("name") or "").strip()
        value = str(item.get("value") or "")
        domain = str(item.get("domain") or "").strip()
        path = str(item.get("path") or "/")
        if not name or not value or not domain:
            return
        if not any(_cookie_domain_matches(domain, host) for host in hosts):
            return
        key = (domain, path, name)
        if key in seen:
            return
        seen.add(key)
        normalized = dict(item)
        normalized["name"] = name
        normalized["value"] = value
        normalized["domain"] = domain
        normalized["path"] = path
        cookies.append(normalized)

    for cookie in _iter_cookies(session):
        add_cookie(_cookie_to_storage(cookie))

    for host in hosts:
        for domain in _cookie_domain_candidates(host):
            for name, value in _cookie_dict_for_domain(session, domain).items():
                add_cookie({
                    "name": name,
                    "value": value,
                    "domain": domain,
                    "path": "/",
                    "secure": True,
                })
    return cookies


def _chatgpt_session_context(chatgpt_core: Any, session: Any) -> dict[str, Any]:
    cookie = _cookie_header_for_host(session, "chatgpt.com")
    did = ""
    try:
        did = str(session.cookies.get("oai-did", domain="chatgpt.com") or "")
    except Exception:
        did = ""
    if not did:
        for item in _iter_cookies(session):
            if str(_cookie_attr(item, "name", "") or "") == "oai-did":
                did = str(_cookie_attr(item, "value", "") or "")
                break
    try:
        user_agent = str(chatgpt_core._session_ua(session) or "")  # pylint: disable=protected-access
    except Exception:
        user_agent = ""
    return {
        "cookie": cookie,
        "user_agent": user_agent,
        "oai_device_id": did,
    }


def _oauth_session_context(chatgpt_core: Any, session: Any) -> dict[str, Any]:
    hosts = ["auth.openai.com", "openai.com"]
    cookies = [
        cookie for cookie in _cookies_for_hosts(session, hosts)
        if not _cookie_domain_matches(str(cookie.get("domain", "")), "chatgpt.com")
    ]
    cookie_headers = {
        host: _cookie_header_for_host(session, host)
        for host in hosts
    }
    cookie_headers = {host: value for host, value in cookie_headers.items() if value}
    try:
        user_agent = str(chatgpt_core._session_ua(session) or "")  # pylint: disable=protected-access
    except Exception:
        user_agent = ""
    return {
        "cookies": cookies,
        "cookie": cookie_headers.get("auth.openai.com", ""),
        "cookie_headers": cookie_headers,
        "user_agent": user_agent,
        "hosts": hosts,
    }


def _remember_oauth_session_context(context: dict[str, Any]) -> None:
    if not isinstance(context, dict):
        return
    incoming_cookies = [
        cookie for cookie in (context.get("cookies") or [])
        if isinstance(cookie, dict) and cookie.get("name") and cookie.get("value")
    ]
    incoming_headers = context.get("cookie_headers")
    if not isinstance(incoming_headers, dict):
        incoming_headers = {}
    has_material = bool(incoming_cookies or context.get("cookie") or incoming_headers)
    if not has_material:
        return

    existing_cookies = [
        cookie for cookie in (_LAST_OAUTH_SESSION_CONTEXT.get("cookies") or [])
        if isinstance(cookie, dict) and cookie.get("name") and cookie.get("value")
    ]
    merged_cookies: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for cookie in [*incoming_cookies, *existing_cookies]:
        key = (
            str(cookie.get("domain") or ""),
            str(cookie.get("path") or "/"),
            str(cookie.get("name") or ""),
        )
        if key in seen:
            continue
        seen.add(key)
        merged_cookies.append(dict(cookie))

    existing_headers = _LAST_OAUTH_SESSION_CONTEXT.get("cookie_headers")
    if not isinstance(existing_headers, dict):
        existing_headers = {}
    merged_headers = {
        str(host): str(value)
        for host, value in existing_headers.items()
        if value
    }
    for host, value in incoming_headers.items():
        if host and value:
            merged_headers[str(host)] = str(value)

    merged = dict(_LAST_OAUTH_SESSION_CONTEXT)
    merged.update({
        key: value for key, value in context.items()
        if key not in {"cookies", "cookie", "cookie_headers"} and value
    })
    merged["cookies"] = merged_cookies
    if not merged.get("cookie") and context.get("cookie"):
        merged["cookie"] = str(context["cookie"])
    if merged_headers:
        merged["cookie_headers"] = merged_headers
    _LAST_OAUTH_SESSION_CONTEXT.clear()
    _LAST_OAUTH_SESSION_CONTEXT.update(merged)


def _oauth_session_has_auth_cookie(context: dict[str, Any]) -> bool:
    if not isinstance(context, dict):
        return False
    for cookie in context.get("cookies") or []:
        if not isinstance(cookie, dict):
            continue
        if (
            str(cookie.get("name") or "").strip() == "oai-client-auth-session"
            and bool(str(cookie.get("value") or "").strip())
        ):
            return True
    sources = [context.get("cookie") or ""]
    headers = context.get("cookie_headers")
    if isinstance(headers, dict):
        sources.extend(headers.values())
    pattern = re.compile(
        r"(?:^|[;,{ \t])['\"]?oai-client-auth-session['\"]?\s*[:=]\s*['\"]?[^'\"};,\s]+",
        re.IGNORECASE,
    )
    return any(pattern.search(str(source or "")) for source in sources)


class _PasswordAuthorizationStateError(RuntimeError):
    """The password authorization chain must be recreated from the beginning."""


def _response_json(response: Any) -> dict[str, Any]:
    try:
        value = response.json()
    except Exception:
        return {}
    return value if isinstance(value, dict) else {}


def _nested_value(value: Any, wanted: tuple[str, ...]) -> str:
    if isinstance(value, dict):
        for key in wanted:
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        for candidate in value.values():
            found = _nested_value(candidate, wanted)
            if found:
                return found
    elif isinstance(value, list):
        for candidate in value:
            found = _nested_value(candidate, wanted)
            if found:
                return found
    return ""


def _response_next_url(response: Any, current_url: str = "") -> str:
    location = str(
        response.headers.get("Location")
        or response.headers.get("location")
        or ""
    ).strip()
    if location:
        return urljoin(current_url or str(getattr(response, "url", "") or ""), location)
    candidate = _nested_value(_response_json(response), ("continue_url", "url", "redirect_uri"))
    return urljoin(current_url, candidate) if candidate else ""


def _callback_has_code_state(url: str) -> bool:
    parsed = urlparse(str(url or ""))
    query = parse_qs(parsed.query, keep_blank_values=True)
    return bool(query.get("code", [""])[0] and query.get("state", [""])[0])


def _response_text_snippet(response: Any, limit: int = 200000) -> str:
    try:
        text = str(getattr(response, "text", "") or "")
    except Exception:
        return ""
    return text[:limit]


def _password_authorize_step(response: Any, final_url: str, data: dict[str, Any]) -> str:
    page_type = _nested_value(data, ("type",))
    if page_type:
        return page_type
    path = urlparse(str(final_url or "")).path.lower()
    if "email-verification" in path:
        return "email_otp_verification"
    if "reset-password" in path or "new-password" in path:
        return "reset_password"
    if "log-in" in path or "login" in path:
        return "login"
    text = _response_text_snippet(response).lower()
    if "email_otp_verification" in text or "email-verification" in text:
        return "email_otp_verification"
    if "reset_password" in text or "reset-password/new-password" in text:
        return "reset_password"
    if "invalid_auth_step" in text:
        return "invalid_auth_step"
    return ""


def _is_password_auth_step_error(code: str, reason: str = "") -> bool:
    code_lower = str(code or "").strip().lower()
    reason_lower = str(reason or "").strip().lower()
    return (
        code_lower in {"invalid_state", "invalid_auth_step"}
        or "invalid authorization step" in reason_lower
        or "session not found or expired" in reason_lower
    )


def _password_flow_headers(
    chatgpt_core: Any,
    session: Any,
    *,
    referer: str,
    device_id: str,
    json_request: bool = False,
) -> dict[str, str]:
    try:
        ua = str(chatgpt_core._session_ua(session) or "")  # pylint: disable=protected-access
    except Exception:
        ua = ""
    headers = {
        "accept": "application/json" if json_request else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": chatgpt_core._session_accept_language(session),
        "referer": referer,
        "user-agent": ua,
        "oai-device-id": device_id,
        **chatgpt_core._make_trace_headers(),  # pylint: disable=protected-access
    }
    if json_request:
        headers.update({
            "content-type": "application/json",
            "origin": "https://auth.openai.com",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        })
    else:
        headers.update({
            "upgrade-insecure-requests": "1",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site" if "chatgpt.com" in referer else "same-origin",
        })
    return headers


def _resolve_password_callback(
    chatgpt_core: Any,
    session: Any,
    initial_url: str,
    *,
    device_id: str,
) -> str:
    current = str(initial_url or "").strip()
    for _hop in range(8):
        if _callback_has_code_state(current):
            return current
        if not current:
            break
        try:
            response = session.get(
                current,
                timeout=30,
                allow_redirects=False,
                headers=_password_flow_headers(
                    chatgpt_core,
                    session,
                    referer="https://auth.openai.com/reset-password/new-password",
                    device_id=device_id,
                ),
                impersonate=chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
            )
        except Exception as exc:
            print(f"[signlist] password callback resolve failed: {type(exc).__name__}")
            break
        next_url = _response_next_url(response, current)
        print(
            f"[signlist] password callback hop={_hop} status={response.status_code} "
            f"next={'set' if next_url else 'empty'}"
        )
        if not next_url or next_url == current:
            break
        current = next_url
    return current if _callback_has_code_state(current) else ""



def _clear_auth_openai_authorization_cookies(session: Any) -> int:
    """Drop stale auth.openai.com authorization cookies before starting a new password chain.

    Keep chatgpt.com / next-auth cookies intact; only old auth.openai login/session
    cookies from the registration chain are removed. Reusing those stale cookies can
    make /email-otp/validate return invalid_auth_step even after authorize returns
    the email-verification page.
    """
    removed = 0
    try:
        cookies = list(session.cookies)
    except Exception:
        cookies = []
    for cookie in cookies:
        name = str(getattr(cookie, "name", "") or "")
        domain = str(getattr(cookie, "domain", "") or "")
        path = str(getattr(cookie, "path", "/") or "/")
        if not name:
            continue
        normalized_domain = domain.lstrip(".").lower()
        if normalized_domain != "auth.openai.com":
            continue
        cleared = False
        for args in (
            {"domain": domain, "path": path, "name": name},
            {"domain": domain, "name": name},
            {"name": name},
        ):
            try:
                session.cookies.clear(**args)
                cleared = True
                break
            except Exception:
                pass
        if not cleared:
            try:
                del session.cookies[name]
                cleared = True
            except Exception:
                pass
        if cleared:
            removed += 1
    return removed

def _totp_code_candidates(secret: str, *, now: float | None = None, window: int = 1) -> list[str]:
    normalized = re.sub(r"[^A-Z2-7]", "", str(secret or "").upper())
    if not normalized:
        return []
    padded = normalized + "=" * ((8 - len(normalized) % 8) % 8)
    key = base64.b32decode(padded, casefold=True)
    timestamp = time.time() if now is None else float(now)
    codes: list[str] = []
    for offset in range(-abs(window), abs(window) + 1):
        counter = max(0, int(timestamp // 30) + offset)
        digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
        index = digest[-1] & 0x0F
        value = (struct.unpack(">I", digest[index:index + 4])[0] & 0x7FFFFFFF) % 1000000
        codes.append(f"{value:06d}")
    return codes


def _mfa_factor_id(*sources: Any) -> str:
    def find(value: Any) -> str:
        if isinstance(value, str):
            matched = re.search(r"/mfa-challenge/([A-Za-z0-9_-]{1,128})", value)
            return matched.group(1) if matched else ""
        if isinstance(value, dict):
            kind = str(value.get("type") or value.get("factor_type") or "").strip().lower()
            factor_id = str(value.get("id") or value.get("factor_id") or "").strip()
            if kind in {"totp", "otp_totp"} and re.fullmatch(r"[A-Za-z0-9_-]{1,128}", factor_id):
                return factor_id
            for nested in value.values():
                found = find(nested)
                if found:
                    return found
        if isinstance(value, list):
            for nested in value:
                found = find(nested)
                if found:
                    return found
        return ""
    for source in sources:
        found = find(source)
        if found:
            return found
    return ""


def _complete_totp_login_challenge(
    chatgpt_core: Any,
    session: Any,
    *,
    validate_data: dict[str, Any],
    continue_url: str,
    totp_secret: str,
    totp_factor_id: str,
    device_id: str,
) -> Any:
    factor_id = _mfa_factor_id(validate_data, continue_url) or str(totp_factor_id or "").strip()
    codes = _totp_code_candidates(totp_secret)
    if not factor_id or not codes:
        raise RuntimeError("CREDENTIAL_REPAIR_MFA_ASSET_MISSING: existing TOTP challenge requires stored secret and factor id")
    referer = f"https://auth.openai.com/mfa-challenge/{factor_id}"
    headers = _password_flow_headers(
        chatgpt_core, session, referer=referer, device_id=device_id, json_request=True
    )
    issue = session.post(
        "https://auth.openai.com/api/accounts/mfa/issue_challenge",
        timeout=30,
        allow_redirects=False,
        headers=headers,
        data=json.dumps({"id": factor_id, "type": "totp", "force_fresh_challenge": False}),
        impersonate=chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
    )
    _event("freepp_password_probe_mfa_challenge_issued", status=issue.status_code)
    if issue.status_code != 200:
        raise RuntimeError(f"CREDENTIAL_REPAIR_MFA_FAILED: issue challenge HTTP {issue.status_code}")
    last_status = 0
    for code in codes:
        verified = session.post(
            "https://auth.openai.com/api/accounts/mfa/verify",
            timeout=30,
            allow_redirects=False,
            headers=headers,
            data=json.dumps({"id": factor_id, "type": "totp", "code": code}),
            impersonate=chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
        )
        last_status = verified.status_code
        payload = _response_json(verified)
        error = payload.get("error") if isinstance(payload, dict) else None
        if verified.status_code == 200 and not error and not (isinstance(payload, dict) and payload.get("success") is False):
            _event("freepp_password_probe_mfa_verified", status=verified.status_code)
            return verified
    raise RuntimeError(f"CREDENTIAL_REPAIR_MFA_FAILED: TOTP verify HTTP {last_status}")


def _setup_post_login_password_once(
    chatgpt_core: Any,
    session: Any,
    *,
    email: str,
    password: str,
    code_fetcher: Any,
    totp_secret: str = "",
    totp_factor_id: str = "",
    cancel_check: Any = None,
    flow_attempt: int = 1,
) -> dict[str, Any]:
    if len(password) < 12 or not re.search(r"[a-z]", password) or not re.search(r"[A-Z]", password) or not re.search(r"\d", password):
        raise ValueError("generated password does not satisfy the observed password policy")
    if cancel_check and cancel_check():
        raise RuntimeError("password setup cancelled")

    _event("freepp_password_probe_started", email=email, flowAttempt=flow_attempt, passwordLength=len(password))

    device_id = str(_LAST_CHATGPT_SESSION_CONTEXT.get("oai_device_id") or "").strip()
    if not device_id:
        try:
            device_id = str(session.cookies.get("oai-did", domain="chatgpt.com") or "").strip()
        except Exception:
            device_id = ""
    device_id = device_id or str(uuid.uuid4())

    cleared_auth_cookies = _clear_auth_openai_authorization_cookies(session)
    if cleared_auth_cookies:
        print(f"[signlist] add-password cleared stale auth.openai cookies: {cleared_auth_cookies}")
    _event(
        "freepp_password_probe_auth_cookies_cleared",
        email=email,
        flowAttempt=flow_attempt,
        clearedAuthOpenAiCookies=cleared_auth_cookies,
        hasDeviceId=bool(device_id),
    )

    oauth = chatgpt_core.start_nextauth_openai_oauth(
        session,
        callback_url="https://chatgpt.com/",
        login_hint=email,
        device_id=device_id,
    )
    parsed = urlparse(oauth.auth_url)
    query = parse_qs(parsed.query, keep_blank_values=True)
    params = {key: (values[0] if values else "") for key, values in query.items()}
    params.update({
        "connection": "password",
        "login_hint": email,
        "reauth": "password",
        "post_login_add_password": "true",
        "max_age": "0",
        "screen_hint": "login_or_signup",
    })
    authorize_url = urlunparse(parsed._replace(query=urlencode(params)))
    otp_issued_at = time.time()
    _event(
        "freepp_password_probe_authorize_started",
        email=email,
        flowAttempt=flow_attempt,
        authorizePath=urlparse(authorize_url).path or "/",
        otpIssuedAtMs=int(otp_issued_at * 1000),
    )
    response = session.get(
        authorize_url,
        timeout=30,
        allow_redirects=True,
        headers=_password_flow_headers(
            chatgpt_core,
            session,
            referer="https://chatgpt.com/",
            device_id=device_id,
        ),
        impersonate=chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
    )
    authorize_data = _response_json(response)
    final_url = str(getattr(response, "url", "") or authorize_url)
    page_type = _password_authorize_step(response, final_url, authorize_data)
    final_path = urlparse(final_url).path or "/"
    print(
        f"[signlist] add-password authorize status={response.status_code} "
        f"page={page_type or 'unknown'} final_path={final_path[:120]}"
    )
    authorize_code = _nested_value(authorize_data, ("code",))
    authorize_reason = (
        _nested_value(authorize_data, ("message",))
        or _nested_value(authorize_data, ("error", "message"))
        or _nested_value(authorize_data, ("detail",))
        or authorize_code
        or ""
    )
    _event(
        "freepp_password_probe_authorize_completed",
        email=email,
        flowAttempt=flow_attempt,
        status=response.status_code,
        page=page_type or "unknown",
        finalPath=final_path[:160],
        code=str(authorize_code or "")[:120],
        reason=str(authorize_reason or "")[:240],
        reachedEmailOtp=page_type == "email_otp_verification" or "email-verification" in final_path.lower(),
    )
    if response.status_code == 409 or _is_password_auth_step_error(authorize_code, authorize_reason):
        raise _PasswordAuthorizationStateError("add-password authorize state is not ready")
    if response.status_code >= 400:
        raise RuntimeError(f"add-password authorize failed: HTTP {response.status_code}")
    final_path_lower = final_path.lower()
    terminal_authorize_step = (
        page_type in {"login", "invalid_auth_step"}
        or "/log-in" in final_path_lower
        or "/login" in final_path_lower
        or "/error" in final_path_lower
    )
    if terminal_authorize_step:
        password_login_step = page_type == "login" or "/log-in/password" in final_path_lower
        if password_login_step:
            _event(
                "freepp_password_probe_already_set",
                email=email,
                flowAttempt=flow_attempt,
                source="authorize_password_login",
            )
            return {
                "created": False,
                "already_set": True,
                "access_token": "",
                "session_token": "",
                "session_refresh_error": "password exists; explicit login required",
            }
        raise _PasswordAuthorizationStateError(
            f"add-password authorize reached terminal step page={page_type or 'unknown'} path={final_path[:120]}"
        )
    if page_type not in {"email_otp_verification"} and "email-verification" not in final_path_lower:
        # Historical successful add-password runs returned JSON-less HTML here
        # (page=unknown) but still issued a valid login-code email. Do not block
        # that path; rely on OTP validate/password/add responses for truth.
        print(
            f"[signlist] add-password authorize step ambiguous; continuing "
            f"page={page_type or 'unknown'} path={final_path[:120]}"
        )

    mailbox_source = str(os.environ.get("SIGNLIST_MAILBOX_SOURCE") or "").strip().lower()
    seen_ids: set[str] = set()
    resend_attempted = mailbox_source == "icmail_public"
    code = None
    if not resend_attempted:
        try:
            code = code_fetcher(
                timeout_sec=20,
                seen_ids=seen_ids,
                not_before=otp_issued_at,
                purpose="password_setup",
            )
        except RuntimeError as exc:
            if "MAILBOX_CODE_TIMEOUT" not in str(exc):
                raise
            _event(
                "freepp_password_probe_initial_wait_timeout",
                email=email,
                flowAttempt=flow_attempt,
                mailboxSource=mailbox_source,
            )
            code = None
    if not code:
        resend_ok = chatgpt_core._resend_email_otp(  # pylint: disable=protected-access
            session,
            device_id,
            str(session.headers.get("user-agent") or ""),
            chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
        )
        _event(
            "freepp_password_probe_otp_send",
            email=email,
            flowAttempt=flow_attempt,
            ok=resend_ok,
            mailboxSource=mailbox_source,
        )
        print(f"[signlist] add-password 显式 email-otp/send source={mailbox_source or 'unknown'} ok={resend_ok}")
        if not resend_ok:
            raise RuntimeError("add-password email-otp/send failed")
        otp_issued_at = time.time()
        code = code_fetcher(
            timeout_sec=None,
            seen_ids=seen_ids,
            not_before=otp_issued_at,
            purpose="password_setup_resend",
        )
    if not code:
        _event("freepp_password_probe_code_missing", email=email, flowAttempt=flow_attempt)
        raise RuntimeError("add-password email OTP was not received")
    _event("freepp_password_probe_code_selected", email=email, flowAttempt=flow_attempt, codeMasked=_mask_code(code))
    validate_response = session.post(
        "https://auth.openai.com/api/accounts/email-otp/validate",
        timeout=30,
        allow_redirects=False,
        headers=_password_flow_headers(
            chatgpt_core,
            session,
            referer="https://auth.openai.com/email-verification",
            device_id=device_id,
            json_request=True,
        ),
        data=json.dumps({"code": str(code)}),
        impersonate=chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
    )
    validate_data = _response_json(validate_response)
    validate_code = _nested_value(validate_data, ("code",))
    validate_type = _nested_value(validate_data, ("type",)) or ""
    validate_reason = (
        _nested_value(validate_data, ("message",))
        or _nested_value(validate_data, ("error", "message"))
        or _nested_value(validate_data, ("detail",))
        or validate_code
        or ""
    )
    print(
        f"[signlist] add-password OTP validate status={validate_response.status_code} "
        f"code={validate_code or 'unknown'} type={validate_type or 'unknown'} "
        f"reason={str(validate_reason)[:180]}"
    )
    _event(
        "freepp_password_probe_validate_completed",
        email=email,
        flowAttempt=flow_attempt,
        status=validate_response.status_code,
        code=str(validate_code or "")[:120],
        type=str(validate_type or "")[:120],
        reason=str(validate_reason or "")[:240],
        invalidAuthStep=bool(validate_response.status_code == 409 or _is_password_auth_step_error(validate_code, validate_reason)),
    )
    if validate_response.status_code == 409 or _is_password_auth_step_error(validate_code, validate_reason):
        raise _PasswordAuthorizationStateError("add-password OTP validate authorization step invalid")
    if validate_response.status_code not in (200, 201, 202, 204, 302, 303):
        raise RuntimeError(f"add-password OTP validate failed: HTTP {validate_response.status_code}")

    reset_url = _response_next_url(validate_response, final_url)
    if str(validate_type).strip().lower() == "mfa_challenge":
        validate_response = _complete_totp_login_challenge(
            chatgpt_core,
            session,
            validate_data=validate_data,
            continue_url=reset_url,
            totp_secret=totp_secret,
            totp_factor_id=totp_factor_id,
            device_id=device_id,
        )
        reset_url = _response_next_url(validate_response, reset_url)
    if reset_url and not _callback_has_code_state(reset_url):
        reset_response = session.get(
            reset_url,
            timeout=30,
            allow_redirects=True,
            headers=_password_flow_headers(
                chatgpt_core,
                session,
                referer="https://auth.openai.com/email-verification",
                device_id=device_id,
            ),
            impersonate=chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
        )
        reset_referer = str(getattr(reset_response, "url", "") or reset_url)
    else:
        reset_referer = reset_url or "https://auth.openai.com/reset-password/new-password"

    add_response = session.post(
        "https://auth.openai.com/api/accounts/password/add",
        timeout=30,
        allow_redirects=False,
        headers=_password_flow_headers(
            chatgpt_core,
            session,
            referer=reset_referer,
            device_id=device_id,
            json_request=True,
        ),
        data=json.dumps({"password": password}),
        impersonate=chatgpt_core._session_impersonate(session),  # pylint: disable=protected-access
    )
    add_data = _response_json(add_response)
    add_code = _nested_value(add_data, ("code",))
    print(f"[signlist] /api/accounts/password/add status={add_response.status_code}")
    _event(
        "freepp_password_probe_add_completed",
        email=email,
        flowAttempt=flow_attempt,
        status=add_response.status_code,
        code=str(add_code or "")[:120],
        callbackAvailable=bool(_response_next_url(add_response, reset_referer)),
    )
    password_already_set = add_code == "password_already_set"
    if add_response.status_code == 409 or add_code == "invalid_state":
        raise _PasswordAuthorizationStateError("password/add invalid_state")
    if (add_response.status_code < 200 or add_response.status_code >= 400) and not password_already_set:
        raise RuntimeError(f"password/add failed: HTTP {add_response.status_code} code={add_code or 'unknown'}")
    if password_already_set:
        _event("freepp_password_probe_already_set", email=email, flowAttempt=flow_attempt)

    callback_candidate = _response_next_url(add_response, reset_referer)
    callback_url = _resolve_password_callback(
        chatgpt_core,
        session,
        callback_candidate,
        device_id=device_id,
    )
    access_token = ""
    session_token = ""
    session_refresh_error = ""
    if callback_url:
        access_token, session_token = chatgpt_core.finish_nextauth_access_token(session, callback_url)
        if not access_token:
            session_refresh_error = "password created but refreshed ChatGPT session has no access token"
    else:
        session_refresh_error = "password created but callback URL was unavailable"
    return {
        "created": not password_already_set,
        "already_set": password_already_set,
        "access_token": access_token,
        "session_token": session_token,
        "session_refresh_error": session_refresh_error,
    }


def _setup_post_login_password(
    chatgpt_core: Any,
    session: Any,
    *,
    email: str,
    password: str,
    code_fetcher: Any,
    totp_secret: str = "",
    totp_factor_id: str = "",
    cancel_check: Any = None,
) -> dict[str, Any]:
    for attempt in range(1, 3):
        try:
            return _setup_post_login_password_once(
                chatgpt_core,
                session,
                email=email,
                password=password,
                code_fetcher=code_fetcher,
                totp_secret=totp_secret,
                totp_factor_id=totp_factor_id,
                cancel_check=cancel_check,
                flow_attempt=attempt,
            )
        except _PasswordAuthorizationStateError as exc:
            reason = str(exc)
            retryable_authorize_state = any(marker in reason.lower() for marker in ('authorize state is not ready', 'invalid_state', 'authorization step invalid', 'sign-in session is no longer valid'))
            will_retry = bool(retryable_authorize_state and attempt < 2)
            _event(
                "freepp_password_probe_retrying_authorization",
                email=email,
                flowAttempt=attempt,
                willRetry=will_retry,
                retryableAuthorizeState=retryable_authorize_state,
                reason=reason[:240],
            )
            if not will_retry:
                raise
            print(f"[signlist] add-password authorize state invalid; recreating chain once: {reason[:160]}")
    raise RuntimeError("add-password authorization failed")



def _clean_change_email_config(raw: Any) -> dict[str, Any]:
    source = raw if isinstance(raw, dict) else {}
    base_url = str(source.get("domainMailboxBaseUrl") or source.get("base_url") or "").strip().rstrip("/")
    api_token = str(source.get("domainMailboxApiToken") or source.get("api_token") or "").strip()
    domain = str(source.get("domain") or "").strip().lstrip("@").lower()
    local_part_prefix = re.sub(r"[^a-z0-9._-]+", "", str(source.get("localPartPrefix") or "").strip().lower())[:32]
    timeout_seconds = max(30, min(600, int(float(source.get("timeoutSeconds") or 120))))
    poll_interval_ms = max(500, min(30000, int(float(source.get("pollIntervalMs") or 3000))))
    return {
        "enabled": bool(source.get("enabled")),
        "domainMailboxBaseUrl": base_url,
        "domainMailboxApiToken": api_token,
        "domain": domain,
        "localPartPrefix": local_part_prefix,
        "timeoutSeconds": timeout_seconds,
        "pollIntervalMs": poll_interval_ms,
        "failRegistrationOnError": bool(source.get("failRegistrationOnError")),
    }


def _domain_mailbox_api_json(method: str, base_url: str, path: str, token: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
    url = f"{base_url.rstrip('/')}{path}"
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib_request.Request(url, data=body, method=method.upper())
    req.add_header("accept", "application/json")
    if token:
        req.add_header("authorization", f"Bearer {token}")
    if body is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib_request.urlopen(req, timeout=30) as res:  # noqa: S310 - local configured HTTP API.
            raw = res.read().decode("utf-8", "replace")
            return json.loads(raw or "{}") if raw else {}
    except HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"domain mailbox API HTTP {exc.code}: {raw}") from exc
    except URLError as exc:
        raise RuntimeError(f"domain mailbox API failed: {exc.reason}") from exc


def _create_change_email_mailbox(config: dict[str, Any]) -> dict[str, str]:
    base_url = str(config.get("domainMailboxBaseUrl") or "").rstrip("/")
    api_token = str(config.get("domainMailboxApiToken") or "").strip()
    domain = str(config.get("domain") or "").strip().lstrip("@").lower()
    if not base_url:
        raise RuntimeError("change-email domain mailbox base URL is empty")
    if not api_token:
        raise RuntimeError("change-email domain mailbox API token is empty")
    if not domain:
        raise RuntimeError("change-email domain is empty")
    prefix = str(config.get("localPartPrefix") or "").strip().lower()
    local_part = f"{prefix}{uuid.uuid4().hex[:12]}" if prefix else ""
    payload = {"domain": domain}
    if local_part:
        payload["local_part"] = local_part
    created = _domain_mailbox_api_json("POST", base_url, "/v1/mailboxes", api_token, payload)
    address = str(created.get("address") or "").strip().lower()
    token = str(created.get("token") or "").strip()
    inbox_url = str(created.get("inbox_url") or "").strip()
    if not address or not token:
        raise RuntimeError("domain mailbox API did not return address/token")
    return {"address": address, "token": token, "inbox_url": inbox_url, "base_url": base_url}


def _extract_change_email_code(text: str) -> str:
    compact = str(text or "")
    for pattern in (
        r"(?:code|验证码|verification)[^0-9]{0,40}([0-9]{6})",
        r"\b([0-9]{6})\b",
    ):
        match = re.search(pattern, compact, re.IGNORECASE)
        if match:
            return match.group(1)
    return ""


def _poll_change_email_code(mailbox: dict[str, str], timeout_seconds: int, poll_interval_ms: int,
                            *, seen_ids=None, exclude_codes=None) -> str:
    deadline = time.time() + timeout_seconds
    seen = seen_ids if isinstance(seen_ids, set) else set(seen_ids or [])
    excluded = set(exclude_codes or [])
    base_url = mailbox["base_url"]
    token = mailbox["token"]
    address = mailbox["address"]
    path = f"/v1/messages?address={quote(address, safe='')}&limit=20"
    while time.time() < deadline:
        data = _domain_mailbox_api_json("GET", base_url, path, token, None)
        for item in data.get("results") or data.get("items") or []:
            if not isinstance(item, dict):
                continue
            item_id = str(item.get("id") or item.get("message_id") or "")
            if item_id and item_id in seen:
                continue
            if item_id:
                seen.add(item_id)
            text = "\n".join(str(item.get(key) or "") for key in ("subject", "raw", "text", "html"))
            code = _extract_change_email_code(text)
            if code and code not in excluded:
                return code
        time.sleep(max(0.5, poll_interval_ms / 1000.0))
    return ""


def _chatgpt_backend_headers(chatgpt_core: Any, session: Any, access_token: str, *, referer: str = "https://chatgpt.com/") -> dict[str, str]:
    try:
        ua = str(chatgpt_core._session_ua(session) or "")  # pylint: disable=protected-access
    except Exception:
        ua = ""
    if not ua:
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    headers = {
        "accept": "application/json",
        "accept-language": chatgpt_core._session_accept_language(session),
        "oai-language": chatgpt_core._session_oai_language(session),
        "cache-control": "no-cache",
        "content-type": "application/json",
        "origin": "https://chatgpt.com",
        "pragma": "no-cache",
        "referer": referer,
        "user-agent": ua,
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        **chatgpt_core._make_trace_headers(),  # pylint: disable=protected-access
    }
    if access_token:
        headers["authorization"] = f"Bearer {access_token}"
    device_id = str(_LAST_CHATGPT_SESSION_CONTEXT.get("oai_device_id") or "").strip()
    if device_id:
        headers["oai-device-id"] = device_id
    return headers


def _accounts_check_url(chatgpt_core: Any, session: Any) -> str:
    offset = int(chatgpt_core._session_timezone_offset_min(session))
    return (
        "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27"
        f"?timezone_offset_min={offset}"
    )


def _json_error_detail(response: Any) -> str:
    try:
        data = response.json()
    except Exception:
        data = None
    if isinstance(data, dict):
        for key in ("message", "detail", "error", "code"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()[:300]
    try:
        return str(response.text or "").replace("\n", " ")[:300]
    except Exception:
        return ""


def _check_trial_eligibility(chatgpt_core: Any, session: Any, access_token: str) -> dict[str, Any]:
    if session is None:
        raise RuntimeError("live ChatGPT session is unavailable")
    if not access_token:
        raise RuntimeError("access token is unavailable")
    try:
        impersonate = chatgpt_core._session_impersonate(session)  # pylint: disable=protected-access
    except Exception:
        impersonate = None
    response = session.get(
        _accounts_check_url(chatgpt_core, session),
        headers=_chatgpt_backend_headers(chatgpt_core, session, access_token),
        timeout=30,
        impersonate=impersonate,
    )
    if response.status_code != 200:
        raise RuntimeError(
            f"accounts/check failed: HTTP {response.status_code} {_json_error_detail(response)}"
        )
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError("accounts/check returned non-JSON response") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("accounts/check returned non-object JSON")

    accounts = payload.get("accounts")
    if not isinstance(accounts, dict) or not any(isinstance(item, dict) for item in accounts.values()):
        raise RuntimeError("accounts/check returned no authenticated account")

    # Keep only campaign identifiers in task evidence. The full response may
    # contain account/session data and is intentionally not persisted.
    account_campaign_ids: list[str] = []
    accounts = payload.get("accounts")
    if isinstance(accounts, dict):
        for account in accounts.values():
            if not isinstance(account, dict):
                continue
            campaigns = account.get("eligible_promo_campaigns")
            if not isinstance(campaigns, dict):
                continue
            for campaign in campaigns.values():
                if not isinstance(campaign, dict):
                    continue
                for key in ("id", "promo_campaign_id", "campaign_id"):
                    value = str(campaign.get(key) or "").strip()
                    if value and value not in account_campaign_ids:
                        account_campaign_ids.append(value)

    # The browser flow also reads this endpoint after the session is created.
    # It reports first-party health/finance UI eligibility, not the Plus promo
    # itself; accounts/check remains the authoritative promo source.
    first_party = session.get(
        "https://chatgpt.com/backend-api/aip/first-party/eligibility",
        headers=_chatgpt_backend_headers(chatgpt_core, session, access_token),
        timeout=30,
        impersonate=impersonate,
    )
    first_party_payload: dict[str, Any] = {}
    try:
        parsed_first_party = first_party.json()
        if isinstance(parsed_first_party, dict):
            first_party_payload = parsed_first_party
    except Exception:
        first_party_payload = {}

    def _first_party_trial_positive(value: Any) -> bool:
        if isinstance(value, dict):
            for key, item in value.items():
                normalized = str(key).lower().replace("-", "_")
                if normalized in {
                    "eligible", "is_eligible", "trial_eligible", "eligible_for_trial",
                    "has_trial", "trial_available", "eligible_for_plus_trial",
                } and item is True:
                    return True
                if normalized in {"promo", "promo_id", "promotion", "offer", "trial"} and item:
                    return True
                if _first_party_trial_positive(item):
                    return True
        elif isinstance(value, list):
            return any(_first_party_trial_positive(item) for item in value)
        return False

    return {
        "enabled": True,
        "status": "checked",
        "http_status": int(response.status_code),
        "accounts_check": payload,
        "account_campaign_ids": account_campaign_ids,
        "first_party_http_status": int(first_party.status_code),
        "first_party_eligibility": first_party_payload,
        "first_party_trial_eligible": _first_party_trial_positive(first_party_payload),
        "checked_at": int(time.time() * 1000),
    }


def _validate_live_access_token(chatgpt_core: Any, session: Any, access_token: str) -> dict[str, Any]:
    """Verify the final token after all post-registration mutations."""
    if session is None:
        raise RuntimeError("final AT validation requires live ChatGPT session")
    if not access_token:
        raise RuntimeError("final AT validation requires access token")
    try:
        impersonate = chatgpt_core._session_impersonate(session)  # pylint: disable=protected-access
    except Exception:
        impersonate = None
    response = session.get(
        _accounts_check_url(chatgpt_core, session),
        headers=_chatgpt_backend_headers(chatgpt_core, session, access_token),
        timeout=30,
        impersonate=impersonate,
    )
    if response.status_code == 401:
        raise RuntimeError("final AT validation failed: HTTP 401 unauthorized")
    if response.status_code == 403:
        raise RuntimeError("final AT validation blocked: HTTP 403 challenge/forbidden")
    if response.status_code != 200:
        raise RuntimeError(f"final AT validation failed: HTTP {response.status_code} {_json_error_detail(response)}")
    try:
        payload = response.json()
    except Exception as exc:
        raise RuntimeError("final AT validation returned non-JSON response") from exc
    accounts = payload.get("accounts") if isinstance(payload, dict) else None
    valid_accounts = [item for item in (accounts or {}).values() if isinstance(item, dict)] if isinstance(accounts, dict) else []
    if not valid_accounts:
        raise RuntimeError("final AT validation returned no authenticated account")
    return {
        "status": "valid",
        "http_status": int(response.status_code),
        "accounts_count": len(valid_accounts),
        "checked_at": int(time.time() * 1000),
    }


def _post_json_candidates(chatgpt_core: Any, session: Any, url: str, candidates: list[dict[str, Any]], *, access_token: str, referer: str) -> dict[str, Any]:
    errors: list[str] = []
    try:
        impersonate = chatgpt_core._session_impersonate(session)  # pylint: disable=protected-access
    except Exception:
        impersonate = None
    for payload in candidates:
        response = session.post(
            url,
            timeout=30,
            allow_redirects=False,
            headers=_chatgpt_backend_headers(chatgpt_core, session, access_token, referer=referer),
            data=json.dumps(payload),
            impersonate=impersonate,
        )
        detail = _json_error_detail(response)
        keys = ",".join(sorted(payload.keys()))
        if 200 <= response.status_code < 300:
            try:
                data = response.json()
            except Exception:
                data = {}
            return {"status": int(response.status_code), "payload_keys": keys, "data": data if isinstance(data, dict) else {}}
        errors.append(f"{keys}: HTTP {response.status_code} {detail}".strip())
        if response.status_code in (401, 403, 409, 429):
            break
    raise RuntimeError("; ".join(errors[-4:]) or "request failed")


def _change_registered_email(
    chatgpt_core: Any,
    session: Any,
    *,
    current_email: str,
    access_token: str,
    config: dict[str, Any],
    result_state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    cfg = _clean_change_email_config(config)
    if not cfg.get("enabled"):
        return {"enabled": False, "changed": False, "status": "disabled"}
    if not session:
        raise RuntimeError("change-email requires active ChatGPT session")
    if not access_token:
        raise RuntimeError("change-email requires access token")

    mailbox = _create_change_email_mailbox(cfg)
    target_email = mailbox["address"]
    if result_state is not None:
        result_state.update({"enabled": True, "changed": False, "status": "pending", "original_email": current_email, "target_email": target_email})
    _event("change_email_mailbox_created", originalEmail=current_email, targetEmail=target_email)

    try:
        impersonate = chatgpt_core._session_impersonate(session)  # pylint: disable=protected-access
    except Exception:
        impersonate = None
    eligibility = session.get(
        "https://chatgpt.com/backend-api/accounts/change_email/eligibility",
        timeout=30,
        allow_redirects=False,
        headers=_chatgpt_backend_headers(chatgpt_core, session, access_token),
        impersonate=impersonate,
    )
    if eligibility.status_code >= 400:
        raise RuntimeError(f"change-email eligibility failed: HTTP {eligibility.status_code} {_json_error_detail(eligibility)}")
    _event("change_email_eligibility_checked", status=int(eligibility.status_code), targetEmail=target_email)

    begin = _post_json_candidates(
        chatgpt_core,
        session,
        "https://chatgpt.com/backend-api/accounts/change_email/begin",
        [
            {"email": target_email},
            {"new_email": target_email},
            {"new_email_address": target_email},
            {"email_address": target_email},
        ],
        access_token=access_token,
        referer="https://chatgpt.com/",
    )
    _event("change_email_begin_completed", status=begin.get("status"), payloadKeys=begin.get("payload_keys"), targetEmail=target_email)

    code = _poll_change_email_code(mailbox, int(cfg["timeoutSeconds"]), int(cfg["pollIntervalMs"]))
    if not code:
        raise RuntimeError("change-email verification code was not received")
    _event("change_email_code_available", targetEmail=target_email)

    verify = _post_json_candidates(
        chatgpt_core,
        session,
        "https://chatgpt.com/backend-api/accounts/change_email/verify",
        [
            {"code": code},
            {"email": target_email, "code": code},
            {"new_email": target_email, "code": code},
            {"email_address": target_email, "code": code},
        ],
        access_token=access_token,
        referer="https://chatgpt.com/",
    )
    changed_result = {
        "enabled": True,
        "changed": True,
        "status": "changed",
        "original_email": current_email,
        "changed_email": target_email,
        "mailbox": {
            "address": target_email,
            "inbox_url": mailbox.get("inbox_url") or "",
            "provider": "domain_mailbox_vps",
        },
        "begin_payload_keys": begin.get("payload_keys"),
        "verify_payload_keys": verify.get("payload_keys"),
    }
    _LAST_CHATGPT_SESSION_CONTEXT["changedEmailMailbox"] = {
        "email": target_email, "base_url": mailbox["base_url"], "token": mailbox["token"],
    }
    if result_state is not None:
        result_state.update(changed_result)
    _event("change_email_verified", status=verify.get("status"), payloadKeys=verify.get("payload_keys"), targetEmail=target_email)
    return changed_result

def _probe_config_text(source: dict[str, Any], *names: str) -> str:
    for name in names:
        value = source.get(name)
        if value not in (None, ""):
            return str(value).strip()
    return ""


def _probe_base_url(value: str) -> str:
    return (value or "").strip().rstrip("/")


def _probe_sub2_headers(base_url: str, admin_api_key: str, user_agent: str) -> dict[str, str]:
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "origin": base_url,
        "pragma": "no-cache",
        "referer": f"{base_url}/admin/accounts",
        "user-agent": user_agent,
        "x-admin-ui-request": "1",
        "x-api-key": admin_api_key,
    }


def _probe_query(url: str, name: str) -> str:
    try:
        values = parse_qs(urlparse(url).query, keep_blank_values=True).get(name) or []
        return str(values[0] if values else "").strip()
    except Exception:
        return ""


def _probe_path(url: str) -> str:
    try:
        parsed = urlparse(str(url or ""))
        return parsed.path or ""
    except Exception:
        return ""


def _probe_response_text(response: Any, limit: int = 300) -> str:
    try:
        text = str(response.text or "")
    except Exception:
        text = ""
    return " ".join(text.split())[:limit]


def _probe_extract_account_select_session_id(text: str) -> str:
    if not text:
        return ""
    patterns = (
        r'name=["\']session_id["\'][^>]*\bvalue=["\']([^"\']+)["\']',
        r'\bvalue=["\']([^"\']+)["\'][^>]*name=["\']session_id["\']',
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            value = unescape(match.group(1)).strip()
            if re.match(r"^us_[A-Za-z0-9_-]+$", value):
                return value
    match = re.search(r"\bus_[A-Za-z0-9_-]{8,}\b", text)
    return match.group(0) if match else ""


def _probe_auth_headers(chatgpt_core: Any, session: Any, referer: str, *, json_request: bool = False) -> dict[str, str]:
    try:
        user_agent = str(chatgpt_core._session_ua(session) or "")  # pylint: disable=protected-access
    except Exception:
        user_agent = ""
    if not user_agent:
        user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    try:
        trace_headers = chatgpt_core._make_trace_headers()  # pylint: disable=protected-access
    except Exception:
        trace_headers = {}
    headers = {
        "accept": "application/json" if json_request else "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": chatgpt_core._session_accept_language(session),
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "referer": referer,
        "user-agent": user_agent,
        **trace_headers,
    }
    if json_request:
        headers.update({
            "content-type": "application/json",
            "origin": "https://auth.openai.com",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
        })
    else:
        headers.update({
            "upgrade-insecure-requests": "1",
            "sec-fetch-dest": "document",
            "sec-fetch-mode": "navigate",
            "sec-fetch-site": "cross-site",
        })
    return headers



def _probe_cookie_header_to_storage(header: str, domain: str) -> list[dict[str, Any]]:
    cookies: list[dict[str, Any]] = []
    text = str(header or "").strip()
    if not text:
        return cookies

    parsed_pairs: list[tuple[str, str]] = []
    if text.startswith("{") and text.endswith("}"):
        try:
            parsed = ast.literal_eval(text)
        except Exception:
            parsed = None
        if isinstance(parsed, dict):
            for raw_name, raw_value in parsed.items():
                name = str(raw_name or "").strip()
                value = "" if raw_value is None else str(raw_value)
                if name and value:
                    parsed_pairs.append((name, value))

    if not parsed_pairs:
        for part in text.split(";"):
            separator = part.find("=")
            if separator <= 0:
                continue
            name = part[:separator].strip()
            value = part[separator + 1:].strip()
            if name and value:
                parsed_pairs.append((name, value))

    for name, value in parsed_pairs:
        cookies.append({
            "name": name,
            "value": value,
            "domain": domain,
            "path": "/",
            "secure": True,
        })
    return cookies


def _probe_cookie_material(chatgpt_core: Any, session: Any) -> dict[str, Any]:
    context = _oauth_session_context(chatgpt_core, session)
    cookie_headers = context.get("cookie_headers") if isinstance(context.get("cookie_headers"), dict) else {}
    normalized_headers = {
        str(host): str(value)
        for host, value in cookie_headers.items()
        if host and value
    }
    if context.get("cookie") and not normalized_headers.get("auth.openai.com"):
        normalized_headers["auth.openai.com"] = str(context.get("cookie") or "")
    cookies = [
        dict(cookie)
        for cookie in (context.get("cookies") or [])
        if isinstance(cookie, dict) and cookie.get("name") and cookie.get("value")
    ]
    for host, header in normalized_headers.items():
        cookies.extend(_probe_cookie_header_to_storage(header, host))
    chatgpt_context = dict(_LAST_CHATGPT_SESSION_CONTEXT)
    chatgpt_cookie = str(chatgpt_context.get('cookie') or '').strip()
    if chatgpt_cookie:
        cookies.extend(_probe_cookie_header_to_storage(chatgpt_cookie, 'chatgpt.com'))
    deduped: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for cookie in cookies:
        key = (str(cookie.get("domain") or ""), str(cookie.get("path") or "/"), str(cookie.get("name") or ""))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(cookie)
    cookie_names = sorted({str(cookie.get("name") or "") for cookie in deduped if cookie.get("name")})
    cookie_domains = sorted({str(cookie.get("domain") or "") for cookie in deduped if cookie.get("domain")})
    return {
        "cookies": deduped,
        "cookie_headers": normalized_headers,
        "cookie_count": len(deduped),
        "cookie_names": cookie_names,
        "cookie_domains": cookie_domains,
        "cookie_header_pair_counts": {
            str(host): str(value).count("=")
            for host, value in normalized_headers.items()
            if value
        },
        "cookie_header_available": bool(any(normalized_headers.values())),
        "cookie_material_available": bool(deduped or any(normalized_headers.values())),
    }


def _probe_apply_cookie_material(session: Any, material: dict[str, Any]) -> int:
    applied = 0
    for cookie in material.get("cookies") or []:
        if not isinstance(cookie, dict):
            continue
        name = str(cookie.get("name") or "").strip()
        value = str(cookie.get("value") or "")
        if not name or not value:
            continue
        domain = str(cookie.get("domain") or "").strip()
        path = str(cookie.get("path") or "/").strip() or "/"
        try:
            if domain:
                session.cookies.set(name, value, domain=domain, path=path)
            else:
                session.cookies.set(name, value, path=path)
            applied += 1
        except Exception:
            continue
    return applied


def _probe_new_session(session_class: Any, proxy_url: str, impersonate: str) -> Any:
    proxies = {"http": proxy_url, "https": proxy_url} if proxy_url else None
    try:
        return session_class(proxies=proxies, impersonate=impersonate or None)
    except TypeError:
        return session_class(proxies=proxies)


def _probe_reuse_saved_phone_bind_state(
    chatgpt_core: Any,
    original_session: Any,
    state: dict[str, Any],
    proxy_url: str,
    impersonate: str,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "reuseProbeRan": True,
        "reuseCookieApplied": False,
        "reuseAddPhonePageAvailable": False,
        "reuseInvalidPhoneAuthStepOk": False,
        "reusableForLater": False,
    }
    try:
        replay = _probe_new_session(original_session.__class__, proxy_url, impersonate)
        applied = _probe_apply_cookie_material(replay, state)
        result["reuseCookieApplied"] = applied > 0
        result["reuseCookieAppliedCount"] = applied
        add_phone_url = str(state.get("add_phone_url") or state.get("continue_url") or "").strip()
        if not add_phone_url:
            result["reuseError"] = "missing_add_phone_url"
            return result
        request_kwargs: dict[str, Any] = {"timeout": 30}
        if impersonate:
            request_kwargs["impersonate"] = impersonate
        page_response = replay.get(
            add_phone_url,
            headers=_probe_auth_headers(chatgpt_core, original_session, "https://auth.openai.com/choose-an-account"),
            allow_redirects=True,
            **request_kwargs,
        )
        final_url = str(getattr(page_response, "url", "") or "")
        result["reuseAddPhonePageStatus"] = int(page_response.status_code)
        result["reuseAddPhoneFinalPath"] = _probe_path(final_url)
        result["reuseAddPhonePageAvailable"] = page_response.status_code < 400 and "add-phone" in final_url

        send_response = replay.post(
            "https://auth.openai.com/api/accounts/add-phone/send",
            headers=_probe_auth_headers(chatgpt_core, original_session, "https://auth.openai.com/add-phone", json_request=True),
            json={"phone_number": "+1", "channel": "sms"},
            **request_kwargs,
        )
        body = _probe_response_text(send_response, 500)
        body_lower = body.lower()
        result["reuseInvalidPhoneStatus"] = int(send_response.status_code)
        result["reuseInvalidPhoneAuthStepOk"] = (
            send_response.status_code not in (401, 403)
            and "invalid_auth_step" not in body_lower
            and "missing authorization step" not in body_lower
            and "缺少 openai session_id" not in body_lower
        )
        result["reusableForLater"] = bool(
            result["reuseCookieApplied"]
            and result["reuseAddPhonePageAvailable"]
            and result["reuseInvalidPhoneAuthStepOk"]
        )
        return result
    except Exception as exc:  # noqa: BLE001 - diagnostics only.
        result["reuseError"] = f"{type(exc).__name__}: {exc}"
        return result

def _run_phone_bind_probe_once(chatgpt_core: Any, session: Any) -> dict[str, Any]:
    probe: dict[str, Any] = {
        "ok": False,
        "skipped": False,
        "sub2SessionIdAvailable": False,
        "authUrlAvailable": False,
        "oauthStateAvailable": False,
        "chooseAccountPageAvailable": False,
        "accountSelectSessionAvailable": False,
        "sessionSelectContinueUrlAvailable": False,
        "addPhoneUrlAvailable": False,
        "authCookieCount": 0,
        "saveableForLater": False,
    }
    settings = dict(_PHONE_BIND_PROBE_CONFIG)
    admin_api_key = _probe_config_text(settings, "sub2AdminApiKey", "sub2_admin_api_key") or str(os.environ.get("SUB2API_ADMIN_API_KEY") or "").strip()
    probe["hasAdminApiKey"] = bool(admin_api_key)
    if not admin_api_key:
        probe.update({"skipped": True, "reason": "sub2_admin_api_key_missing"})
        return probe
    base_url = _probe_base_url(_probe_config_text(settings, "sub2BaseUrl", "sub2_base_url") or os.environ.get("SUB2API_BASE_URL") or "")
    parsed_base_url = urlparse(base_url)
    if parsed_base_url.scheme not in ("http", "https") or not parsed_base_url.hostname or parsed_base_url.username or parsed_base_url.password:
        probe.update({"skipped": True, "reason": "sub2_base_url_missing_or_invalid"})
        return probe
    proxy_id = _probe_config_text(settings, "sub2ProxyId", "sub2_proxy_id") or str(os.environ.get("SUB2API_PROXY_ID") or "").strip()
    redirect_uri = _probe_config_text(settings, "sub2RedirectUri", "sub2_redirect_uri") or str(os.environ.get("SUB2API_REDIRECT_URI") or "").strip()
    try:
        user_agent = str(chatgpt_core._session_ua(session) or "")  # pylint: disable=protected-access
    except Exception:
        user_agent = ""
    if not user_agent:
        user_agent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
    try:
        impersonate = str(chatgpt_core._session_impersonate(session) or "")  # pylint: disable=protected-access
    except Exception:
        impersonate = ""
    request_kwargs = {"timeout": 30}
    if impersonate:
        request_kwargs["impersonate"] = impersonate

    try:
        payload: dict[str, Any] = {}
        if proxy_id:
            try:
                payload["proxy_id"] = int(proxy_id)
            except ValueError:
                payload["proxy_id"] = proxy_id
        if redirect_uri:
            payload["redirect_uri"] = redirect_uri
        generate_response = session.post(
            f"{base_url}/api/v1/admin/openai/generate-auth-url",
            headers=_probe_sub2_headers(base_url, admin_api_key, user_agent),
            json=payload,
            **request_kwargs,
        )
        probe["sub2GenerateStatus"] = int(generate_response.status_code)
        if generate_response.status_code < 200 or generate_response.status_code >= 300:
            probe["error"] = f"generate-auth-url HTTP {generate_response.status_code}: {_probe_response_text(generate_response)}"
            return probe
        try:
            data = (generate_response.json() or {}).get("data") or {}
        except Exception:
            probe["error"] = f"generate-auth-url non-json: {_probe_response_text(generate_response)}"
            return probe
        sub2_session_id = str(data.get("session_id") or "").strip()
        auth_url = str(data.get("auth_url") or "").strip()
        oauth_state = _probe_query(auth_url, "state")
        probe["sub2SessionIdAvailable"] = bool(sub2_session_id)
        probe["authUrlAvailable"] = bool(auth_url)
        probe["oauthStateAvailable"] = bool(oauth_state)
        if not auth_url:
            probe["error"] = "generate-auth-url response missing auth_url"
            return probe

        auth_response = session.get(
            auth_url,
            headers=_probe_auth_headers(chatgpt_core, session, f"{base_url}/admin/accounts"),
            allow_redirects=True,
            **request_kwargs,
        )
        final_url = str(getattr(auth_response, "url", "") or "")
        body = str(auth_response.text or "")
        probe["authUrlStatus"] = int(auth_response.status_code)
        probe["authUrlFinalPath"] = _probe_path(final_url)
        probe["authUrlRedirects"] = [
            {
                "status": int(getattr(item, "status_code", 0) or 0),
                "path": _probe_path(str(getattr(item, "url", "") or "")),
                "locationPath": _probe_path(str(item.headers.get("location") or item.headers.get("Location") or "")),
            }
            for item in list(getattr(auth_response, "history", []) or [])[:6]
        ]
        probe["chooseAccountPageAvailable"] = "choose-an-account" in final_url or "choose-an-account" in body
        account_select_session_id = _probe_extract_account_select_session_id(body)
        probe["accountSelectSessionAvailable"] = bool(account_select_session_id)
        cookie_material = _probe_cookie_material(chatgpt_core, session)
        probe["authCookieCount"] = int(cookie_material.get("cookie_count") or 0)
        probe["authCookieNames"] = list(cookie_material.get("cookie_names") or [])[:80]
        probe["authCookieDomains"] = list(cookie_material.get("cookie_domains") or [])[:30]
        probe["authCookieHeaderPairCounts"] = dict(cookie_material.get("cookie_header_pair_counts") or {})
        probe["authCookieHeaderAvailable"] = bool(cookie_material.get("cookie_header_available"))
        probe["authCookieMaterialAvailable"] = bool(cookie_material.get("cookie_material_available"))
        if auth_response.status_code < 200 or auth_response.status_code >= 400:
            probe["error"] = f"auth-url HTTP {auth_response.status_code}: {_probe_response_text(auth_response)}"
            return probe
        if not account_select_session_id:
            probe["error"] = "auth-url did not expose account-select session_id"
            return probe

        select_response = session.post(
            "https://auth.openai.com/api/accounts/session/select",
            headers=_probe_auth_headers(chatgpt_core, session, "https://auth.openai.com/choose-an-account", json_request=True),
            json={"session_id": account_select_session_id},
            **request_kwargs,
        )
        probe["sessionSelectStatus"] = int(select_response.status_code)
        select_data: dict[str, Any] = {}
        try:
            parsed = select_response.json() or {}
            if isinstance(parsed, dict):
                select_data = parsed
        except Exception:
            select_data = {}
        continue_url = str(select_data.get("continue_url") or "").strip()
        probe["sessionSelectContinueUrlAvailable"] = bool(continue_url)
        probe["addPhoneUrlAvailable"] = "add-phone" in continue_url
        if select_response.status_code < 200 or select_response.status_code >= 300:
            probe["error"] = f"session/select HTTP {select_response.status_code}: {_probe_response_text(select_response)}"
            return probe
        cookie_material = _probe_cookie_material(chatgpt_core, session)
        probe["authCookieCount"] = int(cookie_material.get("cookie_count") or 0)
        probe["authCookieNames"] = list(cookie_material.get("cookie_names") or [])[:80]
        probe["authCookieDomains"] = list(cookie_material.get("cookie_domains") or [])[:30]
        probe["authCookieHeaderPairCounts"] = dict(cookie_material.get("cookie_header_pair_counts") or {})
        probe["authCookieHeaderAvailable"] = bool(cookie_material.get("cookie_header_available"))
        probe["authCookieMaterialAvailable"] = bool(cookie_material.get("cookie_material_available"))
        phone_bind_auth = {
            **cookie_material,
            "sub2_session_id": sub2_session_id,
            "oauth_state": oauth_state,
            "account_select_session_id": account_select_session_id,
            "continue_url": continue_url,
            "add_phone_url": continue_url,
            "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "source": "freepp_sub2_auth_url",
        }
        probe["phoneBindAuth"] = phone_bind_auth
        probe["saveableForLater"] = bool(
            sub2_session_id
            and oauth_state
            and account_select_session_id
            and continue_url
            and probe["authCookieMaterialAvailable"]
        )
        reuse_probe = _probe_reuse_saved_phone_bind_state(
            chatgpt_core,
            session,
            phone_bind_auth,
            str(settings.get("_registration_proxy_url") or "").strip(),
            impersonate,
        )
        probe.update(reuse_probe)
        probe["ok"] = bool(probe["saveableForLater"] and probe["addPhoneUrlAvailable"] and probe.get("reusableForLater"))
        return probe
    except Exception as exc:  # noqa: BLE001 - diagnostics only.
        probe["error"] = f"{type(exc).__name__}: {exc}"
        return probe


def _phone_bind_probe_retryable(probe: dict[str, Any]) -> bool:
    if probe.get("ok"):
        return False
    error = str(probe.get("error") or "").lower()
    if not error:
        return False
    transient_markers = (
        "ssl",
        "connection",
        "timed out",
        "timeout",
        "unexpected eof",
        "reset by peer",
        "temporarily unavailable",
        "could not resolve",
        "failure when receiving",
        "http 429",
    )
    return any(marker in error for marker in transient_markers) or bool(
        re.search(r"\bhttp 5\d\d\b", error)
    )


def _run_phone_bind_probe(chatgpt_core: Any, session: Any) -> dict[str, Any]:
    settings = dict(_PHONE_BIND_PROBE_CONFIG)
    proxy_url = str(settings.get("_registration_proxy_url") or "").strip()
    try:
        impersonate = str(chatgpt_core._session_impersonate(session) or "")  # pylint: disable=protected-access
    except Exception:
        impersonate = ""

    current_session = session
    max_attempts = 3
    last_probe: dict[str, Any] = {}
    for attempt in range(1, max_attempts + 1):
        if attempt > 1:
            material = _probe_cookie_material(chatgpt_core, current_session)
            current_session = _probe_new_session(session.__class__, proxy_url, impersonate)
            applied = _probe_apply_cookie_material(current_session, material)
            _event(
                "phone_bind_probe_reconnecting",
                attempt=attempt,
                maxAttempts=max_attempts,
                cookieCount=applied,
            )
        last_probe = _run_phone_bind_probe_once(chatgpt_core, current_session)
        last_probe["attempts"] = attempt
        last_probe["reconnectAttempts"] = attempt - 1
        if last_probe.get("ok") or not _phone_bind_probe_retryable(last_probe):
            return last_probe
        if attempt < max_attempts:
            time.sleep(float(attempt))
    return last_probe


def _snapshot_nextauth_state_cookies(session: Any) -> list[dict[str, Any]]:
    snapshots: list[dict[str, Any]] = []
    for cookie in _iter_cookies(session):
        if _cookie_attr(cookie, "name", "") != NEXTAUTH_STATE_COOKIE:
            continue
        value = str(_cookie_attr(cookie, "value", "") or "")
        if not value:
            continue
        snapshots.append({
            "name": NEXTAUTH_STATE_COOKIE,
            "value": value,
            "domain": str(_cookie_attr(cookie, "domain", "chatgpt.com") or "chatgpt.com"),
            "path": str(_cookie_attr(cookie, "path", "/") or "/"),
            "secure": bool(_cookie_attr(cookie, "secure", True)),
            "expires": _cookie_attr(cookie, "expires", None),
        })
    if snapshots:
        _NEXTAUTH_STATE_SNAPSHOTS[id(session)] = snapshots
    return snapshots


def _has_nextauth_state_cookie(session: Any) -> bool:
    return any(_cookie_attr(cookie, "name", "") == NEXTAUTH_STATE_COOKIE for cookie in _iter_cookies(session))


def _restore_nextauth_state_cookies(session: Any) -> int:
    if _has_nextauth_state_cookie(session):
        return 0
    snapshots = _NEXTAUTH_STATE_SNAPSHOTS.get(id(session)) or []
    restored = 0
    for item in snapshots:
        value = str(item.get("value") or "")
        if not value:
            continue
        kwargs = {
            "domain": str(item.get("domain") or "chatgpt.com"),
            "path": str(item.get("path") or "/"),
        }
        try:
            session.cookies.set(NEXTAUTH_STATE_COOKIE, value, **kwargs)
        except TypeError:
            session.cookies.set(NEXTAUTH_STATE_COOKIE, value)
        restored += 1
    return restored


def _patch_nextauth_state_cookie_guard(chatgpt_core: Any) -> None:
    if getattr(chatgpt_core, "_signlist_nextauth_state_guard", False):
        return
    original_start = chatgpt_core.start_nextauth_openai_oauth
    original_finish = chatgpt_core.finish_nextauth_access_token

    def guarded_start_nextauth_openai_oauth(session: Any, *args: Any, **kwargs: Any) -> Any:
        result = original_start(session, *args, **kwargs)
        snapshots = _snapshot_nextauth_state_cookies(session)
        if snapshots:
            domains = ",".join(f"{c.get('domain')}{c.get('path')}" for c in snapshots)
            print(f"[signlist] next-auth state cookie snapshot saved: {len(snapshots)} ({domains})")
        return result

    def guarded_finish_nextauth_access_token(session: Any, continue_url: str) -> tuple[str, str]:
        global _LAST_CHATGPT_SESSION  # pylint: disable=global-statement
        _LAST_CHATGPT_SESSION = session
        restored = _restore_nextauth_state_cookies(session)
        if restored:
            print(f"[signlist] restored missing next-auth state cookie before callback: {restored}")
        before_callback = _oauth_session_context(chatgpt_core, session)
        if before_callback.get("cookies") or before_callback.get("cookie") or before_callback.get("cookie_headers"):
            _remember_oauth_session_context(before_callback)
            print(
                "[signlist] captured oauth session context before chatgpt callback: "
                f"cookies={len(before_callback.get('cookies') or [])} "
                f"auth_cookie={'set' if before_callback.get('cookie') else 'empty'}"
            )
        result = original_finish(session, continue_url)
        context = _chatgpt_session_context(chatgpt_core, session)
        if context.get("cookie") or context.get("user_agent") or context.get("oai_device_id"):
            changed_mailbox = _LAST_CHATGPT_SESSION_CONTEXT.get("changedEmailMailbox")
            _LAST_CHATGPT_SESSION_CONTEXT.clear()
            _LAST_CHATGPT_SESSION_CONTEXT.update(context)
            if changed_mailbox:
                _LAST_CHATGPT_SESSION_CONTEXT["changedEmailMailbox"] = changed_mailbox
            print(
                "[signlist] captured chatgpt session context for 2FA: "
                f"cookie={'set' if context.get('cookie') else 'empty'} "
                f"ua={'set' if context.get('user_agent') else 'empty'} "
                f"did={'set' if context.get('oai_device_id') else 'empty'}"
            )
        oauth_context = _oauth_session_context(chatgpt_core, session)
        if oauth_context.get("cookies") or oauth_context.get("cookie") or oauth_context.get("cookie_headers"):
            _remember_oauth_session_context(oauth_context)
            print(
                "[signlist] captured oauth session context: "
                f"cookies={len(oauth_context.get('cookies') or [])} "
                f"auth_cookie={'set' if oauth_context.get('cookie') else 'empty'}"
            )
        return result

    chatgpt_core.start_nextauth_openai_oauth = guarded_start_nextauth_openai_oauth
    chatgpt_core.finish_nextauth_access_token = guarded_finish_nextauth_access_token
    chatgpt_core._signlist_nextauth_state_guard = True


def _selftest() -> int:
    proxy = _proxy_url({
        "protocol": "http",
        "host": "proxy.example.test",
        "port": 8080,
        "username": "fixture-user",
        "password": "fixture:p@ss",
    })
    expected = "http://fixture-user:fixture%3Ap%40ss@proxy.example.test:8080"
    if proxy != expected:
        print(f"proxy selftest failed: {proxy!r} != {expected!r}", file=sys.stderr)
        return 1
    class FakeCookie:
        def __init__(self, name: str, value: str, domain: str = "chatgpt.com", path: str = "/", secure: bool = True):
            self.name = name
            self.value = value
            self.domain = domain
            self.path = path
            self.secure = secure

    class FakeCookies:
        def __init__(self):
            self.items = [FakeCookie(NEXTAUTH_STATE_COOKIE, "state-jwe", ".chatgpt.com", "/")]

        def __iter__(self):
            return iter(self.items)

        def set(self, name: str, value: str, domain: str = "chatgpt.com", path: str = "/"):
            self.items = [cookie for cookie in self.items if cookie.name != name]
            self.items.append(FakeCookie(name, value, domain, path))

    class FakeSession:
        def __init__(self):
            self.cookies = FakeCookies()

    class FakeCore:
        @staticmethod
        def start_nextauth_openai_oauth(session: Any, *args: Any, **kwargs: Any) -> str:
            return "started"

        @staticmethod
        def finish_nextauth_access_token(session: Any, continue_url: str) -> tuple[str, str]:
            if not _has_nextauth_state_cookie(session):
                raise AssertionError("state cookie was not restored")
            session.cookies.set(
                "oai-client-auth-session",
                "oauth-session-jwe",
                domain="auth.openai.com",
                path="/",
            )
            return "access-token", "session-token"

    fake_session = FakeSession()
    _patch_nextauth_state_cookie_guard(FakeCore)
    FakeCore.start_nextauth_openai_oauth(fake_session)
    fake_session.cookies.items = []
    at, st = FakeCore.finish_nextauth_access_token(fake_session, "https://chatgpt.com/api/auth/callback/openai?code=x&state=y")
    if (at, st) != ("access-token", "session-token"):
        print("next-auth state cookie guard selftest failed", file=sys.stderr)
        return 1
    return 0



def _normalize_token_json(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            return {"raw": value}
    return {}


def _set_session_cookie(
    session: Any,
    name: Any,
    value: Any,
    *,
    domain: Any = "chatgpt.com",
    path: Any = "/",
) -> bool:
    cookie_name = str(name or "").strip()
    cookie_value = str(value or "")
    if not cookie_name or not cookie_value:
        return False
    cookie_domain = str(domain or "chatgpt.com").strip() or "chatgpt.com"
    cookie_path = str(path or "/").strip() or "/"
    try:
        session.cookies.set(cookie_name, cookie_value, domain=cookie_domain, path=cookie_path)
    except TypeError:
        session.cookies.set(cookie_name, cookie_value)
    return True


def _apply_repair_cookies(session: Any, repair: dict[str, Any], session_context: dict[str, Any]) -> int:
    applied = 0
    for source in (repair.get("cookies"), session_context.get("cookies")):
        if isinstance(source, dict):
            for name, value in source.items():
                applied += int(_set_session_cookie(session, name, value))
        elif isinstance(source, list):
            for item in source:
                if not isinstance(item, dict):
                    continue
                applied += int(_set_session_cookie(
                    session,
                    item.get("name"),
                    item.get("value"),
                    domain=item.get("domain") or "chatgpt.com",
                    path=item.get("path") or "/",
                ))

    raw_cookie = str(session_context.get("cookie") or repair.get("cookie") or "").strip()
    if raw_cookie:
        parsed = SimpleCookie()
        try:
            parsed.load(raw_cookie)
        except Exception:
            parsed = SimpleCookie()
        for name, morsel in parsed.items():
            applied += int(_set_session_cookie(session, name, morsel.value))
    return applied


def _credential_repair_state(
    chatgpt_core: Any,
    config: dict[str, Any],
    proxy: str,
) -> dict[str, Any]:
    global _LAST_CHATGPT_SESSION  # pylint: disable=global-statement

    repair = config.get("credential_repair")
    if not isinstance(repair, dict):
        raise TypeError("credential_repair must be an object")

    email = str(repair.get("email") or config.get("email") or "").strip()
    password = str(repair.get("password") if repair.get("password") is not None else config.get("password") or "")
    if not email:
        raise ValueError("credential_repair.email is required")

    session_context = repair.get("session_context")
    if not isinstance(session_context, dict):
        session_context = {}
    fingerprint = chatgpt_core.choose_fp(email)
    impersonate = str(
        session_context.get("impersonate")
        or repair.get("impersonate")
        or fingerprint.get("impersonate")
        or ""
    ).strip()
    proxies = {"http": proxy, "https": proxy}
    session = chatgpt_core.BaseSession(proxies=proxies, impersonate=impersonate)
    session.trust_env = False
    session.headers.clear()
    session.headers.update(fingerprint.get("chrome_fp") or {})
    chatgpt_core._bind_session_fp(session, fingerprint)  # pylint: disable=protected-access

    user_agent = str(session_context.get("user_agent") or repair.get("user_agent") or "").strip()
    if user_agent:
        session.headers["user-agent"] = user_agent
        session._anti_fuzz_ua = user_agent  # type: ignore[attr-defined]  # pylint: disable=protected-access
    device_id = str(session_context.get("oai_device_id") or repair.get("oai_device_id") or "").strip()
    if device_id:
        chatgpt_core._bind_oai_did(session, device_id)  # pylint: disable=protected-access
    cookie_count = _apply_repair_cookies(session, repair, session_context)

    _LAST_CHATGPT_SESSION = session
    _LAST_CHATGPT_SESSION_CONTEXT.clear()
    _LAST_CHATGPT_SESSION_CONTEXT.update(session_context)
    current_context = _chatgpt_session_context(chatgpt_core, session)
    _LAST_CHATGPT_SESSION_CONTEXT.update({key: value for key, value in current_context.items() if value})
    oauth_context = _oauth_session_context(chatgpt_core, session)
    if oauth_context.get("cookies") or oauth_context.get("cookie") or oauth_context.get("cookie_headers"):
        _remember_oauth_session_context(oauth_context)

    token_data = _normalize_token_json(repair.get("token_json"))
    access_token = str(
        repair.get("access_token")
        or token_data.get("access_token")
        or token_data.get("accessToken")
        or ""
    ).strip()
    session_token = str(
        repair.get("session_token")
        or token_data.get("session_token")
        or token_data.get("sessionToken")
        or ""
    ).strip()
    if access_token:
        token_data["accessToken"] = access_token
        token_data["access_token"] = access_token
    if session_token:
        token_data["sessionToken"] = session_token
        token_data["session_token"] = session_token
    return {
        "email": email,
        "password": password,
        "access_token": access_token,
        "session_token": session_token,
        "token_data": token_data,
        "cookie_count": cookie_count,
        "password_status": str(repair.get("password_status") or "no_password").strip().lower(),
        "totp": repair.get("totp") if isinstance(repair.get("totp"), dict) else None,
    }


def _post_registration_delay(seconds: float, cancelled: threading.Event) -> None:
    deadline = time.monotonic() + seconds
    while True:
        if cancelled.is_set():
            raise RuntimeError("post-registration delay cancelled")
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        if cancelled.wait(min(10.0, remaining)):
            raise RuntimeError("post-registration delay cancelled")
        _event("freepp_post_registration_delay_heartbeat", remainingSeconds=max(0, deadline - time.monotonic()))


def _verify_saved_totp(chatgpt_core: Any, session: Any, access_token: str, proxy: str,
                       saved: dict[str, Any], verified_factor_id: str = "") -> dict[str, Any]:
    from setup_openai_totp_2fa import OpenAITotp2faClient, _active_totp_factor_id

    result = {**saved, "success": False, "verified": False, "verification_error": None}
    try:
        context = _chatgpt_session_context(chatgpt_core, session)
        client = OpenAITotp2faClient(
            access_token, session=session, proxy=proxy,
            cookie=str(context.get("cookie") or ""),
            user_agent=str(context.get("user_agent") or ""),
            oai_device_id=str(context.get("oai_device_id") or ""),
        )
        info = client.mfa_info()
        factor_id = _active_totp_factor_id(info)
        activated_here = False
        if not factor_id:
            enrollment_id = str(saved.get("enrollment_session_id") or "")
            if not enrollment_id:
                raise RuntimeError("saved TOTP has no active factor or resumable enrollment session")
            client.activate(str(saved["secret"]), enrollment_id)
            result["activated"] = True
            activated_here = True
            info = client.mfa_info()
            factor_id = _active_totp_factor_id(info)
            if not factor_id:
                raise RuntimeError("activation succeeded but active TOTP factor is not visible")
        result["activated"] = True
        if not activated_here and verified_factor_id != factor_id:
            _complete_totp_login_challenge(
                chatgpt_core, session, validate_data={},
                continue_url=f"https://auth.openai.com/mfa-challenge/{factor_id}",
                totp_secret=str(saved["secret"]), totp_factor_id=factor_id,
                device_id=str(context.get("oai_device_id") or ""),
            )
        result.update({"success": True, "verified": True, "active_factor_id": factor_id, "after_activate": info})
    except Exception as exc:
        result["verification_error"] = {"code": "TOTP_VERIFICATION_PENDING", "message": f"{type(exc).__name__}: {exc}"}
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    config_args = parser.add_mutually_exclusive_group()
    config_args.add_argument("--config-b64", default="")
    config_args.add_argument("--config-stdin", action="store_true")
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args(argv)
    if args.selftest:
        return _selftest()
    config = _load_stdin_config() if args.config_stdin else _load_config(args.config_b64)
    credential_repair = config.get("credential_repair")
    repair_mode = isinstance(credential_repair, dict)
    phone_bind_probe_config = config.get("phone_bind_probe") if isinstance(config.get("phone_bind_probe"), dict) else {}
    _PHONE_BIND_PROBE_CONFIG.clear()
    _PHONE_BIND_PROBE_CONFIG.update(phone_bind_probe_config)
    phone_bind_probe_requested = bool(phone_bind_probe_config.get("enabled", False))
    phone_bind_probe_enabled = phone_bind_probe_requested and bool(
        _probe_config_text(phone_bind_probe_config, "sub2AdminApiKey", "sub2_admin_api_key")
        or str(os.environ.get("SUB2API_ADMIN_API_KEY") or "").strip()
    )

    default_backend = Path(__file__).resolve().parents[1] / "vendor" / "freepp" / "backend"
    backend_dir = Path(str(config.get("freepp_backend_dir") or default_backend)).resolve()
    if not (backend_dir / "reg" / "chatgpt_core.py").is_file():
        print(json.dumps({
            "type": "result",
            "ok": False,
            "error": f"FREEPP_BACKEND_DIR does not exist: {backend_dir}",
        }, ensure_ascii=False), file=PROTOCOL_OUT, flush=True)
        return 2

    sys.path.insert(0, str(backend_dir))
    if repair_mode:
        os.environ["OPENAI_SENTINEL_MODE"] = "pure"
    else:
        os.environ.setdefault("OPENAI_SENTINEL_MODE", str(config.get("sentinel_mode") or "pure"))

    from reg import chatgpt_core  # pylint: disable=import-error,import-outside-toplevel
    _patch_nextauth_state_cookie_guard(chatgpt_core)

    email = str(config.get("email") or "").strip()
    password = str(config.get("password") or "")
    mailbox_source = str(config.get("mailbox_source") or "").strip().lower()
    proxy = _proxy_url(config.get("proxy"))
    if not proxy:
        print(json.dumps({
            "type": "result",
            "ok": False,
            "error": "FREEPP_PROXY_REQUIRED: registration requires an explicit task proxy",
        }, ensure_ascii=False), file=PROTOCOL_OUT, flush=True)
        return 2
    _PHONE_BIND_PROBE_CONFIG["_registration_proxy_url"] = proxy
    repair_password_status = str((credential_repair or {}).get("password_status") or "").strip().lower()
    repair_totp_status = str((credential_repair or {}).get("totp_status") or "").strip().lower()
    setup_password = bool(
        config.get("setup_password", False)
        or (credential_repair or {}).get("setup_password", False)
        or (credential_repair or {}).get("password_missing", False)
        or repair_password_status == "no_password"
    )
    setup_totp = bool(
        config.get("setup_totp", False)
        or (credential_repair or {}).get("setup_totp", False)
        or (credential_repair or {}).get("totp_missing", False)
        or repair_totp_status in {"no_totp", "missing"}
    )
    validate_oauth_session = bool(config.get("validate_oauth_session", False))
    auto_check_eligibility = bool(config.get("auto_check_eligibility", False))
    post_registration_delay_seconds = max(0, min(600, int(float(config.get("post_registration_delay_seconds") or 0))))
    change_email_config = _clean_change_email_config(config.get("change_email"))
    cancelled = threading.Event()

    used_codes: set[str] = set()
    repair_mailbox = None
    repair_mailbox_seen: set[str] = set()
    saved_context = (credential_repair or {}).get("session_context") or {}
    saved_mailbox = saved_context.get("changedEmailMailbox") if isinstance(saved_context, dict) else None
    if isinstance(saved_mailbox, dict) and str(saved_mailbox.get("email") or "").strip().lower() == email.lower():
        if saved_mailbox.get("base_url") and saved_mailbox.get("token"):
            repair_mailbox = {"address": email, "base_url": str(saved_mailbox["base_url"]), "token": str(saved_mailbox["token"])}

    def fetch_code(timeout_sec=None, seen_ids=None, not_before=None, purpose="registration_otp", exclude_codes=None):
        if cancelled.is_set():
            return None
        timeout = int(timeout_sec or config.get("mailbox_timeout_sec") or 120)
        normalized_purpose = str(purpose or "registration_otp").strip().lower()
        effective_not_before = not_before
        # signlist 邮箱通道必须显式给注册验证码加 baseline。否则 freepp 没识别到
        # icloud/IMAP 分支时会调用 code_fetcher()，Node 侧收到 after=0，容易捡到历史旧码。
        if effective_not_before is None and normalized_purpose == "registration_otp":
            effective_not_before = time.time()
        after_ms = None
        if effective_not_before:
            try:
                after_ms = int(float(effective_not_before) * 1000)
            except Exception:
                after_ms = None
        excluded = set(str(code or "").strip() for code in (exclude_codes or []))
        excluded.update(used_codes)
        _event(
            "mailbox_code_request",
            email=email,
            purpose=normalized_purpose,
            timeoutSec=timeout,
            afterMs=after_ms,
            seenIdCount=len(list(seen_ids or [])),
            excludedCodeCount=len([code for code in excluded if code]),
        )
        if repair_mailbox:
            requested_seen = set(seen_ids or [])
            requested_seen.update(repair_mailbox_seen)
            try:
                code = _poll_change_email_code(repair_mailbox, timeout, 1000, seen_ids=requested_seen, exclude_codes=excluded)
            except Exception:
                raise ParentRpcError("MAILBOX_PROVIDER_ERROR: changed email mailbox polling failed", "MAILBOX_PROVIDER_ERROR") from None
            repair_mailbox_seen.update(requested_seen)
            if not code:
                raise ParentRpcError("MAILBOX_CODE_TIMEOUT: changed email mailbox returned no new code", "MAILBOX_CODE_TIMEOUT")
            used_codes.add(code)
            _event("mailbox_code_result", email=email, purpose=normalized_purpose, found=True, codeMasked=_mask_code(code))
            return code
        response = _send({
            "type": "fetch_code",
            "email": email,
            "timeout_sec": timeout,
            "after_ms": after_ms,
            "seen_ids": list(seen_ids or []),
            "seen_codes": sorted(code for code in excluded if code),
            "purpose": normalized_purpose,
        })
        mail = response.get("mail") or {}
        mail_id = str(mail.get("id") or "").strip()
        if mail_id and hasattr(seen_ids, "add"):
            seen_ids.add(mail_id)
        code = str(response.get("code") or "").strip()
        _event(
            "mailbox_code_result",
            email=email,
            purpose=normalized_purpose,
            found=bool(code),
            codeMasked=_mask_code(code),
            mailId=mail_id or None,
            mailReceivedAt=mail.get("receivedAt") or None,
            mailSubject=str(mail.get("subject") or "")[:160],
            afterMs=after_ms,
        )
        if code:
            used_codes.add(code)
        return code or None

    def channel_setup(_proxies: Any, cancel_check=None):
        return email, password, fetch_code

    result_payload: dict[str, Any]
    repair_state: dict[str, Any] = {}
    verified_totp_factor_id = ""

    def complete_existing_totp(session, data, continue_url, device_id):
        nonlocal verified_totp_factor_id
        factor_id = _mfa_factor_id(data, continue_url)
        if not factor_id:
            return continue_url
        saved = repair_state.get("totp") or {}
        response = _complete_totp_login_challenge(
            chatgpt_core, session, validate_data=data, continue_url=continue_url,
            totp_secret=str(saved.get("secret") or ""),
            totp_factor_id=str(saved.get("active_factor_id") or ""), device_id=device_id,
        )
        verified_totp_factor_id = factor_id
        return _response_next_url(response, continue_url)

    try:
        os.environ["SIGNLIST_MAILBOX_SOURCE"] = mailbox_source
        registration_log = _RegistrationLogObserver(sys.stderr)
        if repair_mode:
            if repair_mailbox:
                try:
                    baseline = _domain_mailbox_api_json("GET", repair_mailbox["base_url"],
                        f"/v1/messages?address={quote(email, safe='')}&limit=20", repair_mailbox["token"], None)
                    for item in baseline.get("results") or baseline.get("items") or []:
                        if not isinstance(item, dict):
                            continue
                        item_id = str(item.get("id") or item.get("message_id") or "")
                        if item_id:
                            repair_mailbox_seen.add(item_id)
                        old_code = _extract_change_email_code("\n".join(str(item.get(key) or "") for key in ("subject", "raw", "text", "html")))
                        if old_code:
                            used_codes.add(old_code)
                except Exception:
                    raise ParentRpcError("MAILBOX_PROVIDER_ERROR: changed email mailbox baseline failed", "MAILBOX_PROVIDER_ERROR") from None
            repair_state = _credential_repair_state(chatgpt_core, config, proxy)
            result_email = repair_state["email"]
            result_password = repair_state["password"]
            token_data = repair_state["token_data"]
            registration_log.password_created = repair_state["password_status"] == "has_password"
            _event(
                "freepp_credential_repair_login_started",
                email=result_email,
                sentinelMode=os.environ.get("OPENAI_SENTINEL_MODE"),
                restoredCookieCount=repair_state["cookie_count"],
                hasFallbackAccessToken=bool(repair_state["access_token"]),
            )
            with contextlib.redirect_stdout(registration_log):
                login_result = chatgpt_core.login_with_password(
                    proxy,
                    result_email,
                    result_password,
                    cancel_check=cancelled.is_set,
                    code_fetcher=fetch_code,
                    mfa_handler=complete_existing_totp,
                )
            if login_result:
                login_email, login_access_token, login_session_token = login_result
                result_email = str(login_email or result_email).strip()
            elif "/mfa-challenge/" in registration_log.tail and not (repair_state.get("totp") or {}).get("secret"):
                raise RuntimeError(
                    "CREDENTIAL_REPAIR_UNKNOWN_MFA: server requires an existing MFA factor but no local TOTP secret is stored"
                )
            elif setup_password or (setup_totp and (repair_state.get("totp") or {}).get("secret") and repair_state["access_token"]):
                login_access_token = ""
                login_session_token = ""
                _event(
                    "freepp_credential_repair_login_deferred_until_password_setup",
                    email=result_email,
                    reason="password login unavailable; use add-password email OTP flow",
                )
            else:
                raise RuntimeError("CREDENTIAL_REPAIR_LOGIN_FAILED: login returned no result")
            access_token = str(login_access_token or repair_state["access_token"] or "").strip()
            session_token = str(login_session_token or repair_state["session_token"] or "").strip()
            if access_token:
                token_data["accessToken"] = access_token
                token_data["access_token"] = access_token
            if session_token:
                token_data["sessionToken"] = session_token
                token_data["session_token"] = session_token
            _event(
                "freepp_credential_repair_login_completed",
                email=result_email,
                hasAccessToken=bool(access_token),
                hasSessionToken=bool(session_token),
                sessionCaptured=_LAST_CHATGPT_SESSION is not None,
            )
        else:
            chatgpt_core.register_email_channel("signlist", channel_setup)
            _event("freepp_sidecar_started", email=email, sentinelMode=os.environ.get("OPENAI_SENTINEL_MODE"))
            with contextlib.redirect_stdout(registration_log):
                run_result = chatgpt_core.run(proxy or None, email="signlist", cancel_check=cancelled.is_set)
            if not run_result:
                raise RuntimeError("freepp returned no result")
            token_json, result_email, result_password, access_token, session_token = run_result
            token_data = _normalize_token_json(token_json)
            access_token = str(access_token or token_data.get("access_token") or token_data.get("accessToken") or "").strip()
            session_token = str(session_token or token_data.get("session_token") or token_data.get("sessionToken") or "").strip()
        has_post_registration_steps = bool(
            validate_oauth_session
            or (setup_password and not registration_log.password_created)
            or setup_totp
            or change_email_config.get("enabled")
            or phone_bind_probe_enabled
            or auto_check_eligibility
        )
        if post_registration_delay_seconds:
            _event(
                "freepp_post_registration_delay_started",
                seconds=post_registration_delay_seconds,
                validateOauthSession=bool(validate_oauth_session),
                setupPassword=bool(setup_password and not registration_log.password_created),
                setupTotp=bool(setup_totp),
                changeEmail=bool(change_email_config.get("enabled")),
                phoneBindProbe=bool(phone_bind_probe_enabled),
                autoCheckEligibility=bool(auto_check_eligibility),
                hasPostRegistrationSteps=bool(has_post_registration_steps),
            )
            _post_registration_delay(post_registration_delay_seconds, cancelled)
            _event("freepp_post_registration_delay_completed", seconds=post_registration_delay_seconds)

        # Eligibility must observe the freshly registered account before any
        # post-registration mutation (password, TOTP, email change, etc.).
        # Those operations can refresh the session or change account state.
        eligibility_result = {"enabled": bool(auto_check_eligibility), "status": "disabled"}
        eligibility_error = None
        if auto_check_eligibility:
            _event("freepp_eligibility_check_started", email=str(result_email or email).strip())
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    eligibility_result = _check_trial_eligibility(
                        chatgpt_core,
                        _LAST_CHATGPT_SESSION,
                        access_token,
                    )
                _event(
                    "freepp_eligibility_check_completed",
                    status=int(eligibility_result.get("http_status") or 0),
                    accountsCheckKeys=sorted((eligibility_result.get("accounts_check") or {}).keys()),
                    accountCampaignIds=eligibility_result.get("account_campaign_ids") or [],
                    firstPartyKeys=sorted((eligibility_result.get("first_party_eligibility") or {}).keys()),
                    firstPartyTrialEligible=bool(eligibility_result.get("first_party_trial_eligible")),
                )
            except Exception as exc:  # noqa: BLE001 - report the post-step failure.
                eligibility_error = {
                    "code": type(exc).__name__,
                    "message": str(exc),
                }
                eligibility_result = {"enabled": True, "status": "failed"}
                _event("freepp_eligibility_check_failed", **eligibility_error)

        if phone_bind_probe_enabled:
            if _LAST_CHATGPT_SESSION is None:
                _event("freepp_phone_bind_probe_skipped", reason="chatgpt_session_unavailable")
            elif not _LAST_PHONE_BIND_PROBE:
                _event("freepp_phone_bind_probe_started", email=str(result_email or email).strip())
                probe = _run_phone_bind_probe(chatgpt_core, _LAST_CHATGPT_SESSION)
                if probe:
                    _LAST_PHONE_BIND_PROBE.clear()
                    _LAST_PHONE_BIND_PROBE.update(probe)
                    _event(
                        "freepp_phone_bind_probe_completed",
                        ok=bool(probe.get("ok")),
                        saveableForLater=bool(probe.get("saveableForLater")),
                        reusableForLater=bool(probe.get("reusableForLater")),
                        accountSelectSessionAvailable=bool(probe.get("accountSelectSessionAvailable")),
                        addPhoneUrlAvailable=bool(probe.get("addPhoneUrlAvailable")),
                    )
                else:
                    _event("freepp_phone_bind_probe_skipped", reason="empty_probe_result")

        password_result = None
        password_error = None
        password_session_refresh_error = None
        if setup_password and not registration_log.password_created:
            _event("freepp_password_setup_started", email=result_email)
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    password_result = _setup_post_login_password(
                        chatgpt_core,
                        _LAST_CHATGPT_SESSION,
                        email=str(result_email or email).strip(),
                        password=str(result_password or password),
                        code_fetcher=fetch_code,
                        totp_secret=str((repair_state.get("totp") or {}).get("secret") or ""),
                        totp_factor_id=str((repair_state.get("totp") or {}).get("active_factor_id") or ""),
                        cancel_check=cancelled.is_set,
                    )
                if password_result.get("access_token"):
                    access_token = str(password_result["access_token"])
                    token_data["accessToken"] = access_token
                    token_data["access_token"] = access_token
                if password_result.get("session_token"):
                    session_token = str(password_result["session_token"])
                    token_data["sessionToken"] = session_token
                    token_data["session_token"] = session_token
                password_session_refresh_error = str(password_result.get("session_refresh_error") or "") or None
                if password_result.get("already_set"):
                    _event("freepp_credential_repair_relogin_started", email=result_email, reason="password_already_set")
                    try:
                        with contextlib.redirect_stdout(registration_log):
                            relogin_result = chatgpt_core.login_with_password(
                                proxy,
                                result_email,
                                str(result_password if result_password is not None else password),
                                cancel_check=cancelled.is_set,
                                code_fetcher=fetch_code,
                                require_password=True,
                                mfa_handler=complete_existing_totp,
                            )
                        if not relogin_result or not relogin_result[1]:
                            raise RuntimeError("password_already_set login did not verify the stored password")
                        password_result["created"] = True
                        relogin_email, relogin_access_token, relogin_session_token = relogin_result
                        result_email = str(relogin_email or result_email).strip()
                        access_token = str(relogin_access_token or "").strip()
                        session_token = str(relogin_session_token or "").strip()
                        if access_token:
                            token_data["accessToken"] = access_token
                            token_data["access_token"] = access_token
                        if session_token:
                            token_data["sessionToken"] = session_token
                            token_data["session_token"] = session_token
                        password_result["access_token"] = access_token
                        password_result["session_token"] = session_token
                        password_session_refresh_error = None
                        _event(
                            "freepp_credential_repair_relogin_completed",
                            email=result_email,
                            hasAccessToken=bool(access_token),
                            hasSessionToken=bool(session_token),
                        )
                    except Exception as exc:
                        password_result["created"] = False
                        password_error = {"code": "PASSWORD_UNVERIFIED", "message": str(exc)}
                        password_session_refresh_error = f"{type(exc).__name__}: {exc}"
                        _event(
                            "freepp_credential_repair_relogin_failed",
                            email=result_email,
                            code=type(exc).__name__,
                            message=str(exc)[:240],
                        )
                _event(
                    "freepp_password_setup_completed",
                    sessionRefreshed=bool(password_result.get("access_token")),
                    sessionRefreshPending=bool(password_session_refresh_error),
                )
            except Exception as exc:  # noqa: BLE001 - preserve the registered account.
                password_error = {
                    "code": type(exc).__name__,
                    "message": str(exc),
                }
                _event("freepp_password_setup_failed", **password_error)

        totp_result = repair_state.get("totp") if repair_mode else None
        totp_error = None
        if setup_totp and access_token and password_error is None:
            _event("freepp_twofa_setup_started", email=result_email)
            try:
                from setup_openai_totp_2fa import setup_totp_2fa  # pylint: disable=import-error,import-outside-toplevel
                with contextlib.redirect_stdout(sys.stderr):
                    if totp_result and totp_result.get("secret"):
                        totp_result = _verify_saved_totp(
                            chatgpt_core, _LAST_CHATGPT_SESSION, access_token, proxy,
                            totp_result, verified_totp_factor_id,
                        )
                    else:
                        totp = setup_totp_2fa(
                            access_token,
                            cookie=str(_LAST_CHATGPT_SESSION_CONTEXT.get("cookie") or ""),
                            user_agent=str(_LAST_CHATGPT_SESSION_CONTEXT.get("user_agent") or ""),
                            oai_device_id=str(_LAST_CHATGPT_SESSION_CONTEXT.get("oai_device_id") or ""),
                            proxy=proxy,
                            timeout=30,
                            session=_LAST_CHATGPT_SESSION,
                        )
                        totp_result = asdict(totp)
                totp_error = totp_result.get("verification_error")
                if totp_error:
                    _event("freepp_twofa_verification_pending", activated=totp_result.get("activated", False), **totp_error)
                else:
                    _event("freepp_twofa_setup_completed", activeFactorId=totp_result.get("active_factor_id"))
            except Exception as exc:  # noqa: BLE001 - preserve the created account and token.
                totp_error = {
                    "code": type(exc).__name__,
                    "message": str(exc),
                }
                _event("freepp_twofa_setup_failed", **totp_error)
        elif setup_totp:
            _event(
                "freepp_twofa_setup_skipped",
                reason="password_setup_failed" if password_error is not None else "access_token_unavailable",
            )

        completion_error = None
        email_change_result = {"enabled": bool(change_email_config.get("enabled")), "changed": False, "status": "disabled"}
        email_change_error = None
        if change_email_config.get("enabled"):
            _event("change_email_started", email=str(result_email or email).strip(), domain=change_email_config.get("domain"))
            try:
                with contextlib.redirect_stdout(sys.stderr):
                    email_change_result = _change_registered_email(
                        chatgpt_core,
                        _LAST_CHATGPT_SESSION,
                        current_email=str(result_email or email).strip(),
                        access_token=access_token,
                        config=change_email_config,
                        result_state=email_change_result,
                    )
            except Exception as exc:  # noqa: BLE001 - preserve the registered account unless configured otherwise.
                email_change_error = {
                    "code": type(exc).__name__,
                    "message": str(exc),
                }
                if not email_change_result.get("changed"):
                    email_change_result["status"] = "failed"
                _event("change_email_failed", **email_change_error)
                if change_email_config.get("failRegistrationOnError"):
                    completion_error = {
                        "code": "FREEPP_CHANGE_EMAIL_FAILED",
                        "message": f"{type(exc).__name__}: {exc}",
                        "retryable_proxy": False,
                    }

        _event("freepp_final_at_validation_started", email=str(result_email or email).strip())
        try:
            final_at_validation = _validate_live_access_token(
                chatgpt_core,
                _LAST_CHATGPT_SESSION,
                access_token,
            )
        except Exception as exc:
            completion_error = completion_error or {
                "code": "FREEPP_FINAL_AT_VALIDATION_FAILED",
                "message": f"{type(exc).__name__}: {exc}",
                "retryable_proxy": False,
            }
            final_at_validation = {
                "status": "invalid",
                "error": {"code": type(exc).__name__, "message": str(exc)[:500]},
                "checked_at": int(time.time() * 1000),
            }
        _event("freepp_final_at_validation_completed", **final_at_validation)

        refreshed_context = _chatgpt_session_context(chatgpt_core, _LAST_CHATGPT_SESSION)
        _LAST_CHATGPT_SESSION_CONTEXT.update({key: value for key, value in refreshed_context.items() if value})

        result_payload = {
            "type": "result",
            "ok": True,
            "email": str(result_email or email).strip(),
            "login_email": str((email_change_result or {}).get("changed_email") or result_email or email).strip(),
            "email_change": email_change_result,
            "email_change_error": email_change_error,
            "password": str(result_password if result_password is not None else password),
            "password_status": "has_password" if (registration_log.password_created or (password_result or {}).get("created")) else "no_password",
            "password_error": password_error,
            "password_session_refresh_error": password_session_refresh_error,
            "token_json": token_data,
            "access_token": access_token,
            "session_token": session_token,
            "session_context": dict(_LAST_CHATGPT_SESSION_CONTEXT),
            "oauth_session": dict(_LAST_OAUTH_SESSION_CONTEXT),
            "phone_bind_probe": dict(_LAST_PHONE_BIND_PROBE),
            "totp": totp_result,
            "totp_error": totp_error,
            "eligibility_check": eligibility_result,
            "eligibility_error": eligibility_error,
            "final_at_validation": final_at_validation,
            "completion_error": completion_error,
            "completed_at": int(time.time() * 1000),
        }
    except Exception as exc:  # noqa: BLE001 - bridge returns structured failure to parent.
        result_payload = {
            "type": "result",
            "ok": False,
            "error": f"{type(exc).__name__}: {exc}",
        }

    print(json.dumps(result_payload, ensure_ascii=False), file=PROTOCOL_OUT, flush=True)
    return 0 if result_payload.get("ok") else 1


if __name__ == "__main__":
    raise SystemExit(main())
