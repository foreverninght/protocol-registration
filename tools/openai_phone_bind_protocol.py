#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Pure HTTP protocol client for the OpenAI auth phone-binding flow.

The Sub2API OAuth session is generated live with an admin API key. HAR files are
not used as the source for Sub2API session_id/code/state.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import uuid
import time
from html import unescape
from urllib.parse import parse_qs, urljoin, urlparse
from pathlib import Path
from typing import Any

try:
    from curl_cffi.requests import Session
except Exception as exc:  # pragma: no cover
    raise SystemExit(
        "curl_cffi is required. Install it with: python -m pip install curl_cffi"
    ) from exc


AUTH_ORIGIN = "https://auth.openai.com"
SUB2_ORIGIN = ""
DEFAULT_PROFILE = "chrome136"
DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36"
)


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def load_json_file(path: str | None) -> Any:
    if not path:
        return None
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def first_header(headers: list[dict[str, Any]], name: str) -> str:
    for header in headers or []:
        if str(header.get("name", "")).lower() == name.lower():
            return str(header.get("value", ""))
    return ""


def coerce_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            text = coerce_text(item)
            if text:
                parts.append(text)
        return "".join(parts)
    if isinstance(value, dict):
        if "text" in value:
            return coerce_text(value.get("text"))
        try:
            return json.dumps(value, ensure_ascii=False)
        except Exception:
            return str(value)
    return str(value)


def response_error_text(response: Any) -> str:
    text = str(getattr(response, "text", "") or "")
    payload = None
    try:
        payload = response.json()
    except Exception:
        payload = None
    if isinstance(payload, dict):
        candidates: list[Any] = [
            payload.get("detail"),
            payload.get("message"),
            payload.get("error"),
        ]
        error_value = payload.get("error")
        if isinstance(error_value, dict):
            candidates.extend([error_value.get("message"), error_value.get("detail"), error_value.get("code")])
        for item in candidates:
            if isinstance(item, (dict, list)):
                try:
                    item = json.dumps(item, ensure_ascii=False)
                except Exception:
                    item = str(item)
            item_text = str(item or "").strip()
            if item_text:
                return " ".join(item_text.split())[:1200]
        try:
            text = json.dumps(payload, ensure_ascii=False)
        except Exception:
            pass
    return " ".join(text.split())[:1200]


def parse_query_fields(url: str) -> dict[str, str]:
    try:
        parsed = urlparse(url)
        query = parse_qs(parsed.query)
        fragment = parse_qs(parsed.fragment)
        for key, values in fragment.items():
            if key not in query or not query[key]:
                query[key] = values
    except Exception:
        return {}
    return {key: str(values[0]) for key, values in query.items() if values}


def extract_callback_fields(value: Any) -> dict[str, str]:
    """Extract an OAuth callback pair from response JSON, headers, or text."""
    if value is None:
        return {}
    if isinstance(value, dict):
        direct_code = str(value.get("code") or "").strip()
        direct_state = str(value.get("state") or "").strip()
        if direct_code and direct_state:
            return {"code": direct_code, "state": direct_state}
        for item in value.values():
            fields = extract_callback_fields(item)
            if fields.get("code") and fields.get("state"):
                return fields
        return {}
    if isinstance(value, (list, tuple)):
        for item in value:
            fields = extract_callback_fields(item)
            if fields.get("code") and fields.get("state"):
                return fields
        return {}

    text = unescape(str(value or "").strip()).replace("\\u0026", "&")
    if not text:
        return {}
    if text[:1] in ("{", "["):
        try:
            fields = extract_callback_fields(json.loads(text))
            if fields.get("code") and fields.get("state"):
                return fields
        except Exception:
            pass
    candidates = [text]
    candidates.extend(re.findall(r"https?://[^\s\"'<>]+", text))
    for candidate in candidates:
        fields = parse_query_fields(candidate.rstrip("),.;"))
        if fields.get("code") and fields.get("state"):
            return {"code": fields["code"], "state": fields["state"]}
    return {}


def extract_continue_url(value: Any) -> str:
    if isinstance(value, dict):
        for key in ("continue_url", "continueUrl", "redirect_url", "redirectUrl", "url"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate.strip():
                return candidate.strip()
        for item in value.values():
            candidate = extract_continue_url(item)
            if candidate:
                return candidate
    elif isinstance(value, (list, tuple)):
        for item in value:
            candidate = extract_continue_url(item)
            if candidate:
                return candidate
    return ""


def clean_base_url(value: str) -> str:
    value = (value or "").strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise ValueError("SUB2API_BASE_URL must be an explicitly configured HTTP(S) URL without embedded credentials")
    return value


def env_text(name: str) -> str:
    return str(os.environ.get(name) or "").strip()


def extract_oai_client_auth_session(text: str) -> dict[str, str]:
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except Exception:
        return {}
    if not isinstance(parsed, dict):
        return {}
    session = parsed.get("oai-client-auth-session")
    if not isinstance(session, dict):
        return {}
    out: dict[str, str] = {}
    for key in ("session_id", "auth_session_logging_id", "openai_client_id", "email", "phone_number"):
        value = session.get(key)
        if value not in (None, ""):
            out[key] = str(value)
    return out


def extract_session_id_from_html(text: str) -> str:
    if not text:
        return ""
    patterns = (
        r'name=["\']session_id["\'][^>]*\bvalue=["\']([^"\']+)["\']',
        r'\bvalue=["\']([^"\']+)["\'][^>]*name=["\']session_id["\']',
        r'(?:\\?["\'])id(?:\\?["\'])\s*[,=:]\s*(?:\\?["\'])(us_[A-Za-z0-9_-]+)(?:\\?["\'])',
    )
    for pattern in patterns:
        match = re.search(pattern, text, re.IGNORECASE)
        if match:
            return unescape(match.group(1)).strip()
    return ""


def load_har_template(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    har = load_json_file(path)
    entries = (((har or {}).get("log") or {}).get("entries") or [])
    template: dict[str, Any] = {
        "workspace_id": "",
        "code": "",
        "state": "",
        "headers": {},
    }
    wanted = {
        "/api/accounts/session/select",
        "/api/accounts/authorize/continue",
        "/api/accounts/add-phone/send",
        "/api/accounts/phone-otp/validate",
        "/api/accounts/workspace/select",
    }
    for entry in entries:
        request = entry.get("request") or {}
        response = entry.get("response") or {}
        url = str(request.get("url") or "")
        if any(pathname in url for pathname in wanted):
            headers = request.get("headers") or []
            for name in (
                "accept-language",
                "sec-ch-ua",
                "sec-ch-ua-mobile",
                "sec-ch-ua-platform",
                "user-agent",
            ):
                value = first_header(headers, name)
                if value:
                    template["headers"][name] = value

        response_text = coerce_text((response.get("content") or {}).get("text"))
        if response_text and "/api/accounts/workspace/select" in url:
            try:
                payload = json.loads(response_text)
                if not isinstance(payload, dict):
                    payload = {}
                continue_url = str(payload.get("continue_url") or "")
                query_fields = parse_query_fields(continue_url)
                if query_fields.get("state"):
                    template["state"] = query_fields["state"]
                if query_fields.get("login_verifier"):
                    template["login_verifier"] = query_fields["login_verifier"]
                if query_fields.get("code"):
                    template["code"] = query_fields["code"]
            except Exception:
                pass

        parsed_url = urlparse(url)
        if parsed_url.scheme in {"http", "https"} and parsed_url.hostname == "localhost":
            query_fields = parse_query_fields(url)
            if query_fields.get("code"):
                template["code"] = query_fields["code"]
            if query_fields.get("state"):
                template["state"] = query_fields["state"]
    return template


def load_cookie_header(args: argparse.Namespace) -> str:
    if args.cookie:
        return args.cookie.strip()
    if args.cookie_file:
        return Path(args.cookie_file).read_text(encoding="utf-8").strip()
    return ""


def apply_cookie_json(session: Session, args: argparse.Namespace) -> int:
    data = None
    if args.cookies_json:
        data = json.loads(args.cookies_json)
    elif args.cookies_file:
        data = load_json_file(args.cookies_file)
    if not isinstance(data, list):
        return 0
    count = 0
    for cookie in data:
        if not isinstance(cookie, dict):
            continue
        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        domain = str(cookie.get("domain") or "")
        path = str(cookie.get("path") or "/")
        if not name or not value:
            continue
        try:
            session.cookies.set(name, value, domain=domain or None, path=path)
            count += 1
        except Exception:
            pass
    return count


def apply_cookie_list(session: Session, data: Any) -> int:
    if not isinstance(data, list):
        return 0
    count = 0
    for cookie in data:
        if not isinstance(cookie, dict):
            continue
        name = str(cookie.get("name") or "")
        value = str(cookie.get("value") or "")
        domain = str(cookie.get("domain") or "")
        path = str(cookie.get("path") or "/")
        if not name or not value:
            continue
        try:
            session.cookies.set(name, value, domain=domain or None, path=path)
            count += 1
        except Exception:
            pass
    return count


def apply_cookie_header(session: Session, cookie_header: str) -> int:
    """Load a raw Cookie header into the live session cookie jar."""
    count = 0
    for part in str(cookie_header or "").split(";"):
        name, separator, value = part.strip().partition("=")
        if not separator or not name:
            continue
        try:
            session.cookies.set(
                name.strip(),
                value.strip(),
                domain="auth.openai.com",
                path="/",
            )
            count += 1
        except Exception:
            pass
    return count


def export_cookies(session: Session) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    try:
        jar = session.cookies.jar
    except Exception:
        jar = []
    for cookie in jar:
        name = str(getattr(cookie, 'name', '') or '')
        value = str(getattr(cookie, 'value', '') or '')
        if not name or not value:
            continue
        output.append({
            'name': name,
            'value': value,
            'domain': str(getattr(cookie, 'domain', '') or ''),
            'path': str(getattr(cookie, 'path', '/') or '/'),
            'secure': bool(getattr(cookie, 'secure', False)),
            'httpOnly': bool(getattr(cookie, 'rest', {}).get('HttpOnly', False)),
            'expires': getattr(cookie, 'expires', None),
            'sameSite': getattr(cookie, 'rest', {}).get('SameSite'),
        })
    return output


def clear_transient_auth_flow_cookies(session: Session) -> int:
    """Drop an expired OAuth action while preserving the unified login."""
    removed = 0
    try:
        jar = session.cookies.jar
        for cookie in list(jar):
            name = str(getattr(cookie, "name", "") or "")
            if not (
                name in {
                    "oai-client-auth-session",
                    "oai-client-auth-info",
                    "hydra_redirect",
                    "iss_context",
                    "rg_context",
                }
                or name.startswith("oai-login-csrf_")
            ):
                continue
            try:
                jar.clear(cookie.domain, cookie.path, cookie.name)
                removed += 1
            except Exception:
                pass
    except Exception:
        pass
    return removed


def load_state(path: str | None) -> dict[str, Any]:
    if not path:
        return {}
    state_path = Path(path)
    if not state_path.exists():
        return {}
    data = load_json_file(str(state_path))
    return data if isinstance(data, dict) else {}


def save_state(path: str | None, state: dict[str, Any]) -> None:
    if not path:
        return
    state_path = Path(path)
    state_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = state_path.with_suffix(state_path.suffix + '.tmp')
    tmp_path.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding='utf-8')
    tmp_path.replace(state_path)


def auth_headers(template: dict[str, Any], referer: str, cookie_header: str = "") -> dict[str, str]:
    headers = {
        "accept": "application/json",
        "accept-language": "zh-CN,zh;q=0.9",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "origin": AUTH_ORIGIN,
        "pragma": "no-cache",
        "referer": referer,
        "sec-ch-ua": '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": DEFAULT_UA,
        "x-access-flow-invocation-id": str(uuid.uuid4()),
    }
    headers.update({k: str(v) for k, v in (template.get("headers") or {}).items() if v})
    # The browser generates a new invocation id for every auth action. A value
    # copied from HAR (or reused across session/select and add-phone/send) makes
    # the server reject the next request as an invalid or expired auth step.
    headers["x-access-flow-invocation-id"] = str(uuid.uuid4())
    navigation_id = str(template.get("document_navigation_id") or "").strip()
    if navigation_id:
        headers["x-openai-document-navigation-id"] = navigation_id
    # curl_cffi's Session owns the current cookie jar. Never pin requests to
    # the startup/HAR Cookie header: OAuth bootstrap and session/select rotate
    # auth cookies, and replaying the old header breaks the next auth step.
    for name in list(headers):
        if name.lower() == "cookie":
            del headers[name]
    return headers


def post_json(
    session: Session,
    path: str,
    payload: dict[str, Any],
    referer: str,
    template: dict[str, Any],
    cookie_header: str,
    timeout: int,
    *,
    retry_transport_once: bool = False,
    request_timeout: int | None = None,
    extra_headers: dict[str, str] | None = None,
) -> dict[str, Any]:
    url = f"{AUTH_ORIGIN}{path}"
    attempts = 2 if retry_transport_once else 1
    effective_timeout = max(1, int(request_timeout or timeout))
    response = None
    for attempt in range(1, attempts + 1):
        try:
            request_headers = auth_headers(template, referer, cookie_header)
            request_headers.update(extra_headers or {})
            response = session.post(
                url,
                headers=request_headers,
                json=payload,
                timeout=effective_timeout,
                impersonate=DEFAULT_PROFILE,
            )
            break
        except Exception as exc:
            message = str(exc).lower()
            transient = any(marker in message for marker in (
                "timed out",
                "timeout",
                "connection reset",
                "socket hang up",
                "empty reply",
            ))
            if attempt >= attempts or not transient:
                raise
            print(
                f"[协议] POST {path} 网络无响应，"
                f"{effective_timeout} 秒后自动重试一次。"
            )
            time.sleep(0.6)
    if response is None:
        raise RuntimeError(f"{path} failed without a response")
    body = response_error_text(response)
    print(f"[协议] POST {path} -> HTTP {response.status_code}")
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(f"{path} failed: HTTP {response.status_code} {body}")
    try:
        data = response.json()
    except Exception:
        data = {}
    auth_session = data.get("oai-client-auth-session")
    if isinstance(auth_session, str) and auth_session:
        try:
            session.cookies.set("oai-client-auth-session", auth_session, domain="auth.openai.com", path="/")
        except Exception:
            pass
    elif isinstance(auth_session, dict):
        session_id = str(auth_session.get("session_id") or "")
        if session_id:
            data["_extracted_session_id"] = session_id
    page = data.get("page") if isinstance(data.get("page"), dict) else {}
    page_type = str(data.get("type") or page.get("type") or "").strip()
    continue_url = extract_continue_url(data)
    auth_cookie_domains = session_cookie_domains(session, "oai-client-auth-session")
    print(
        f"[协议] {path} 响应 page={page_type or '-'} "
        f"continue_url={'set' if continue_url else 'none'} "
        f"auth_cookie_domains={','.join(auth_cookie_domains) or '-'}"
    )
    return data


def session_cookie_value(session: Session, name: str) -> str:
    try:
        for cookie in session.cookies.jar:
            if str(getattr(cookie, "name", "") or "") == name:
                return str(getattr(cookie, "value", "") or "")
    except Exception:
        pass
    try:
        return str(session.cookies.get(name) or "")
    except Exception:
        return ""


def session_cookie_domains(session: Session, name: str) -> list[str]:
    domains: list[str] = []
    try:
        for cookie in session.cookies.jar:
            if str(getattr(cookie, "name", "") or "") != name:
                continue
            domain = str(getattr(cookie, "domain", "") or "<host-only>")
            if domain not in domains:
                domains.append(domain)
    except Exception:
        pass
    return domains

def sentinel_token_for_action(session: Session, action: str, label: str) -> str:
    did = session_cookie_value(session, "oai-did").strip()
    if not did:
        raise RuntimeError(f"{label} 缺少 oai-did Cookie")

    backend_dir = env_text("FREEPP_BACKEND_DIR") or str(Path(__file__).resolve().parents[1] / "vendor" / "freepp" / "backend")
    if not backend_dir or not Path(backend_dir).is_dir():
        raise RuntimeError(f"{label} 缺少可用的 FreePP backend 路径")
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)
    try:
        from reg import sentinel_sdk
    except Exception as exc:
        raise RuntimeError(f"{label} 无法加载 Sentinel: {exc}") from exc

    sentinel = sentinel_sdk.sentinel_for(
        action,
        proxy=env_text("PHONE_BIND_PROXY") or None,
        did=did,
    )
    token = str((sentinel or {}).get("sentinel_token") or "").strip()
    if not (sentinel or {}).get("ok") or not token:
        reason = str((sentinel or {}).get("error") or "Sentinel token 为空")
        raise RuntimeError(f"{label} Sentinel 生成失败: {reason}")
    return token



def authorize_continue(
    session: Session,
    template: dict[str, Any],
    cookie_header: str,
    timeout: int,
) -> dict[str, str]:
    """Perform the confirmation represented by the ordinary final 确定 button."""
    did = session_cookie_value(session, "oai-did").strip()
    if not did:
        raise RuntimeError("authorize/continue 缺少 oai-did Cookie")

    backend_dir = env_text("FREEPP_BACKEND_DIR") or str(Path(__file__).resolve().parents[1] / "vendor" / "freepp" / "backend")
    if not backend_dir or not Path(backend_dir).is_dir():
        raise RuntimeError("authorize/continue 缺少可用的 FreePP backend 路径")
    if backend_dir not in sys.path:
        sys.path.insert(0, backend_dir)
    try:
        from reg import sentinel_sdk
    except Exception as exc:
        raise RuntimeError(f"authorize/continue 无法加载 Sentinel: {exc}") from exc

    sentinel = sentinel_sdk.sentinel_for(
        "authorize_continue",
        proxy=env_text("PHONE_BIND_PROXY") or None,
        did=did,
    )
    token = str((sentinel or {}).get("sentinel_token") or "").strip()
    if not (sentinel or {}).get("ok") or not token:
        reason = str((sentinel or {}).get("error") or "Sentinel token 为空")
        raise RuntimeError(f"authorize/continue Sentinel 生成失败: {reason}")

    headers = auth_headers(
        template,
        "https://auth.openai.com/phone-verification",
        cookie_header,
    )
    headers["openai-sentinel-token"] = token
    response = session.post(
        f"{AUTH_ORIGIN}/api/accounts/authorize/continue",
        headers=headers,
        json={},
        timeout=timeout,
        allow_redirects=False,
        impersonate=DEFAULT_PROFILE,
    )
    body = response_error_text(response)
    print(f"[协议] POST /api/accounts/authorize/continue -> HTTP {response.status_code}")
    if response.status_code < 200 or response.status_code >= 400:
        raise RuntimeError(
            f"/api/accounts/authorize/continue failed: HTTP {response.status_code} {body}"
        )

    location = str(response.headers.get("Location") or response.headers.get("location") or "").strip()
    try:
        payload: Any = response.json()
    except Exception:
        payload = str(response.text or "")
    fields = extract_callback_fields([location, str(getattr(response, "url", "") or ""), payload])
    next_url = location or extract_continue_url(payload)
    response_type = ""
    response_keys = ""
    if isinstance(payload, dict):
        response_type = str(payload.get("type") or "")
        if not response_type and isinstance(payload.get("page"), dict):
            response_type = str(payload["page"].get("type") or "")
        response_keys = ",".join(sorted(str(key) for key in payload.keys()))[:200]
    print(
        "[协议] authorize/continue 响应 "
        f"type={response_type or '-'} continue_url={'set' if next_url else 'none'} "
        f"callback={'set' if fields.get('code') and fields.get('state') else 'none'}"
    )
    return {
        "code": fields.get("code", ""),
        "state": fields.get("state", ""),
        "continue_url": next_url,
        "diagnostic": (
            f"action=authorize/continue,status={response.status_code},"
            f"type={response_type or '-'},keys={response_keys or '-'},"
            f"continue_url={'set' if next_url else 'none'}"
        ),
    }


def is_chatgpt_consent_page(page: dict[str, Any]) -> bool:
    page_type = str(page.get("type") or "").strip().lower()
    if re.fullmatch(r"sign_in_with_chatgpt(?:_[a-z0-9]+)*_consent", page_type):
        return True
    payload = page.get("payload") if isinstance(page.get("payload"), dict) else {}
    return payload.get("oauth_resource_consent") is not None


def codex_workspace_from_validation(validation_data: dict[str, Any]) -> dict[str, str]:
    page = validation_data.get("page") if isinstance(validation_data.get("page"), dict) else {}
    payload = page.get("payload") if isinstance(page.get("payload"), dict) else {}
    auth_sessions = [
        validation_data.get("oai-client-auth-session"),
        page.get("oai-client-auth-session"),
        payload.get("oai-client-auth-session"),
    ]
    workspaces: list[dict[str, Any]] = []
    for auth_session in auth_sessions:
        if not isinstance(auth_session, dict):
            continue
        candidates = auth_session.get("workspaces")
        if isinstance(candidates, list):
            workspaces.extend(item for item in candidates if isinstance(item, dict))
    usable = [item for item in workspaces if str(item.get("id") or "").strip()]
    selected = next(
        (item for item in usable if str(item.get("kind") or "").strip().lower() == "personal"),
        usable[0] if usable else None,
    )
    if not selected:
        return {}
    return {
        "id": str(selected.get("id") or "").strip(),
        "kind": str(selected.get("kind") or "").strip(),
    }


def select_codex_workspace(
    session: Session,
    validation_data: dict[str, Any],
    template: dict[str, Any],
    cookie_header: str,
    timeout: int,
) -> dict[str, str]:
    workspace = codex_workspace_from_validation(validation_data)
    workspace_id = workspace.get("id", "")
    if not workspace_id:
        raise RuntimeError("Codex consent 页面没有可选择的 workspace_id")
    selected = post_json(
        session,
        "/api/accounts/workspace/select",
        {"workspace_id": workspace_id},
        "https://auth.openai.com/sign-in-with-chatgpt/codex/consent",
        template,
        cookie_header,
        timeout,
    )
    fields = extract_callback_fields(selected)
    continue_url = extract_continue_url(selected)
    return {
        "code": fields.get("code", ""),
        "state": fields.get("state", ""),
        "continue_url": continue_url,
        "workspace_id": workspace_id,
        "diagnostic": (
            "action=workspace/select,"
            f"workspace_kind={workspace.get('kind') or '-'},"
            f"continue_url={'set' if continue_url else 'none'}"
        ),
    }


def grant_consent(
    session: Session,
    validation_data: dict[str, Any],
    template: dict[str, Any],
    cookie_header: str,
    timeout: int,
) -> dict[str, str]:
    """Submit the final consent page shown after a successful phone OTP."""
    page = validation_data.get("page") if isinstance(validation_data.get("page"), dict) else validation_data
    page_type = str(page.get("type") or "").strip()
    if not is_chatgpt_consent_page(page):
        fields = extract_callback_fields(page)
        return {
            "code": fields.get("code", ""),
            "state": fields.get("state", ""),
            "continue_url": extract_continue_url(page),
        }

    payload = page.get("payload") if isinstance(page.get("payload"), dict) else {}
    resource_consent = payload.get("oauth_resource_consent")
    auth_session_id = str(payload.get("session_id") or "").strip()

    headers = auth_headers(
        template,
        "https://auth.openai.com/sign-in-with-chatgpt/consent",
        cookie_header,
    )
    request_json: dict[str, str] | None = None
    if resource_consent is not None:
        if not auth_session_id:
            raise RuntimeError("资源授权 consent 缺少 auth_session_id")
        did = session_cookie_value(session, "oai-did").strip()
        if not did:
            raise RuntimeError("资源授权 consent 缺少 oai-did Cookie")
        backend_dir = env_text("FREEPP_BACKEND_DIR") or str(Path(__file__).resolve().parents[1] / "vendor" / "freepp" / "backend")
        if not backend_dir or not Path(backend_dir).is_dir():
            raise RuntimeError("资源授权 consent 缺少可用的 FreePP backend 路径")
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)
        try:
            from reg import sentinel_sdk
        except Exception as exc:
            raise RuntimeError(f"资源授权 consent 无法加载 Sentinel: {exc}") from exc
        sentinel = sentinel_sdk.sentinel_for(
            "authorize_continue",
            proxy=env_text("PHONE_BIND_PROXY") or None,
            did=did,
        )
        token = str((sentinel or {}).get("sentinel_token") or "").strip()
        if not (sentinel or {}).get("ok") or not token:
            reason = str((sentinel or {}).get("error") or "Sentinel token 为空")
            raise RuntimeError(f"资源授权 consent Sentinel 生成失败: {reason}")
        headers["openai-sentinel-token"] = token
        request_json = {"auth_session_id": auth_session_id}

    request_kwargs: dict[str, Any] = {
        "headers": headers,
        "timeout": timeout,
        "allow_redirects": False,
        "impersonate": DEFAULT_PROFILE,
    }
    if request_json is not None:
        request_kwargs["json"] = request_json
    response = session.post(
        f"{AUTH_ORIGIN}/api/accounts/consent/grant",
        **request_kwargs,
    )
    body = response_error_text(response)
    print(f"[协议] POST /api/accounts/consent/grant -> HTTP {response.status_code}")
    if response.status_code < 200 or response.status_code >= 400:
        raise RuntimeError(
            f"/api/accounts/consent/grant failed: HTTP {response.status_code} {body}"
        )

    location = str(response.headers.get("Location") or response.headers.get("location") or "").strip()
    try:
        payload: Any = response.json()
    except Exception:
        payload = str(response.text or "")
    fields = extract_callback_fields([location, str(getattr(response, "url", "") or ""), payload])
    next_url = location or extract_continue_url(payload)
    response_type = ""
    response_keys = ""
    if isinstance(payload, dict):
        response_type = str(payload.get("type") or "")
        if not response_type and isinstance(payload.get("page"), dict):
            response_type = str(payload["page"].get("type") or "")
        response_keys = ",".join(sorted(str(key) for key in payload.keys()))[:200]
    print(
        "[协议] consent/grant 响应 "
        f"type={response_type or '-'} continue_url={'set' if next_url else 'none'} "
        f"callback={'set' if fields.get('code') and fields.get('state') else 'none'}"
    )
    return {
        "code": fields.get("code", ""),
        "state": fields.get("state", ""),
        "continue_url": next_url,
        "diagnostic": (
            f"type={response_type or '-'},keys={response_keys or '-'},"
            f"continue_url={'set' if next_url else 'none'}"
        ),
    }


def confirm_phone_verification(
    session: Session,
    validation_data: dict[str, Any],
    template: dict[str, Any],
    cookie_header: str,
    timeout: int,
) -> dict[str, str]:
    """Click the protocol equivalent of the confirmation page after phone OTP."""
    page = validation_data.get("page") if isinstance(validation_data.get("page"), dict) else validation_data
    direct = extract_callback_fields(page)
    if direct.get("code") and direct.get("state"):
        return {
            "code": direct["code"],
            "state": direct["state"],
            "continue_url": extract_continue_url(page),
            "diagnostic": "action=none,callback=validation_response",
        }

    page_type = str(page.get("type") or "").strip()
    if page_type.lower() == "sign_in_with_chatgpt_codex_consent":
        confirmed = select_codex_workspace(session, validation_data, template, cookie_header, timeout)
        action = "workspace/select"
    elif is_chatgpt_consent_page(page):
        confirmed = grant_consent(session, validation_data, template, cookie_header, timeout)
        action = "consent/grant"
    else:
        confirmed = authorize_continue(session, template, cookie_header, timeout)
        action = "authorize/continue"
    diagnostic = str(confirmed.get("diagnostic") or "").strip()
    confirmed["diagnostic"] = (
        f"page_type={page_type or '-'},action={action}"
        f"{',' + diagnostic if diagnostic else ''}"
    )
    return confirmed


def follow_to_callback(session: Session, start_url: str, template: dict[str, Any], cookie_header: str, timeout: int) -> dict[str, str]:
    current_url = str(start_url or "").strip()
    extracted: dict[str, str] = {}
    initial = extract_callback_fields(current_url)
    if initial.get("code") and initial.get("state"):
        return initial
    if not current_url:
        return extracted
    for _ in range(10):
        response = session.get(
            current_url,
            headers=auth_headers(template, "https://auth.openai.com/add-phone", cookie_header),
            timeout=timeout,
            allow_redirects=False,
            impersonate=DEFAULT_PROFILE,
        )
        location = str(response.headers.get("Location") or response.headers.get("location") or "")
        if location:
            current_url = urljoin(current_url, location)
            extracted.update(extract_callback_fields(current_url))
            if extracted.get("code") and extracted.get("state"):
                return extracted
            continue
        body_text = str(response.text or "")
        if body_text:
            try:
                body_payload: Any = response.json()
            except Exception:
                body_payload = body_text
            extracted.update(extract_callback_fields([
                str(getattr(response, "url", "") or current_url),
                body_payload,
            ]))
            if extracted.get("code") and extracted.get("state"):
                return extracted
            next_url = extract_continue_url(body_payload)
            if next_url:
                resolved_url = urljoin(current_url, next_url)
                if resolved_url != current_url:
                    current_url = resolved_url
                    extracted.update(extract_callback_fields(current_url))
                    if extracted.get("code") and extracted.get("state"):
                        return extracted
                    continue
        break
    return extracted


def begin_openai_auth_flow(
    session: Session,
    auth_url: str,
    sub2_base_url: str,
    template: dict[str, Any],
    cookie_header: str,
    timeout: int,
) -> dict[str, str]:
    if not auth_url:
        return {}
    fields: dict[str, str] = {}
    current_url = auth_url
    referer = f"{sub2_base_url}/admin/accounts"
    visited: set[str] = set()
    for step in range(4):
        if not current_url or current_url in visited:
            break
        visited.add(current_url)
        response = session.get(
            current_url,
            headers=auth_headers(template, referer, cookie_header),
            timeout=timeout,
            allow_redirects=True,
            impersonate=DEFAULT_PROFILE,
        )
        label = "auth-url" if step == 0 else f"auth continue {step}"
        print(f"[协议] OpenAI {label} -> HTTP {response.status_code}")
        if response.status_code < 200 or response.status_code >= 400:
            raise RuntimeError(
                f"OpenAI {label} failed: HTTP {response.status_code} "
                f"{response_error_text(response)}"
            )

        body = str(response.text or "")
        selected_session_id = extract_session_id_from_html(body)
        if selected_session_id:
            fields["session_id"] = selected_session_id

        auth_session = extract_oai_client_auth_session(body)
        for key in ("session_id", "auth_session_logging_id", "openai_client_id", "email", "phone_number"):
            if auth_session.get(key):
                fields[f"auth_{key}" if key == "session_id" else key] = auth_session[key]
        if fields.get("session_id"):
            break

        try:
            payload: Any = response.json()
        except Exception:
            payload = {}
        payload_page = payload.get("page") if isinstance(payload, dict) and isinstance(payload.get("page"), dict) else {}
        payload_type = str((payload.get("type") if isinstance(payload, dict) else "") or payload_page.get("type") or "").strip()
        response_url = str(getattr(response, "url", "") or current_url)
        response_path = urlparse(response_url).path
        if response_path in {"/log-in", "/email-verification"}:
            fields["login_required"] = "1"
            fields["login_path"] = response_path
        print(
            f"[协议] OpenAI {label} page={payload_type or '-'} "
            f"path={response_path or '/'} continue_url={'set' if extract_continue_url(payload) else 'none'} "
            f"auth_cookie_domains={','.join(session_cookie_domains(session, 'oai-client-auth-session')) or '-'}"
        )
        next_url = extract_continue_url(payload)
        if not next_url:
            break
        referer = str(getattr(response, "url", "") or current_url)
        current_url = urljoin(referer, next_url)
    return fields


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="OpenAI phone binding pure HTTP protocol client")
    parser.add_argument("--har", default="", help="Optional auth.openai.com HAR for browser-like header hints only")
    parser.add_argument("--session-id", default="", help="Existing auth.openai.com account session_id, if automatic extraction is unavailable")
    parser.add_argument("--sub2-base-url", default="", help="Sub2API base URL. Required here or through SUB2API_BASE_URL")
    parser.add_argument("--sub2-admin-api-key", default="", help="Sub2API admin API key. Defaults to SUB2API_ADMIN_API_KEY")
    parser.add_argument("--sub2-proxy-id", default="", help="Optional Sub2API proxy_id. Defaults to SUB2API_PROXY_ID")
    parser.add_argument("--sub2-redirect-uri", default="", help="Optional OpenAI OAuth redirect_uri override")
    parser.add_argument("--phone", default="", help="Phone number with country code")
    parser.add_argument("--otp", default="", help="SMS OTP code")
    parser.add_argument("--oauth-code", default="", help="OAuth callback code, overrides extracted value")
    parser.add_argument("--oauth-state", default="", help="OAuth callback state, overrides extracted value")
    parser.add_argument("--stage", choices=("full", "send", "validate", "exchange"), default="full")
    parser.add_argument("--state-file", default="", help="State file used to persist cookies and extracted fields between send and validate")
    parser.add_argument("--cookie", default="", help="Raw Cookie header, if your flow requires cookies")
    parser.add_argument("--cookie-file", default="", help="Text file containing raw Cookie header")
    parser.add_argument("--cookies-file", default="", help="Playwright/Chrome cookies JSON array")
    parser.add_argument("--cookies-json", default="", help="Inline cookies JSON array")
    parser.add_argument("--skip-select", action="store_true", help="Skip /session/select and assume supplied cookies/session already point to add-phone")
    parser.add_argument("--reuse-saved-auth", action="store_true", help="Reuse saved Sub2/OpenAI authorization state instead of generating a new auth_url")
    parser.add_argument("--exchange-after-bind", action="store_true", help="After phone validation, call sub2 exchange-code")
    parser.add_argument("--authorization-only", action="store_true", help="Refresh OAuth authorization without submitting a phone number")
    parser.add_argument("--dump-fields", action="store_true", help="Generate Sub2API OAuth URL, print live fields, and exit")
    parser.add_argument("--proxy", default="", help="HTTP(S) proxy URL for OpenAI/Sub2 requests. Defaults to PHONE_BIND_PROXY")
    parser.add_argument("--timeout", type=int, default=45)
    return parser.parse_args()


def sub2_headers(base_url: str, admin_api_key: str) -> dict[str, str]:
    return {
        "accept": "application/json, text/plain, */*",
        "accept-language": "zh",
        "cache-control": "no-cache",
        "content-type": "application/json",
        "origin": base_url,
        "pragma": "no-cache",
        "referer": f"{base_url}/admin/accounts",
        "sec-ch-ua": '"Not=A?Brand";v="99", "Microsoft Edge";v="151", "Chromium";v="151"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
        "user-agent": DEFAULT_UA,
        "x-admin-ui-request": "1",
        "x-api-key": admin_api_key,
    }


def generate_sub2_auth_url(
    session: Session,
    base_url: str,
    admin_api_key: str,
    proxy_id: str,
    redirect_uri: str,
    timeout: int,
) -> dict[str, str]:
    if not admin_api_key:
        raise SystemExit("缺少 Sub2API 管理员 API Key。请传 --sub2-admin-api-key 或设置 SUB2API_ADMIN_API_KEY。")
    payload: dict[str, Any] = {}
    if proxy_id:
        try:
            payload["proxy_id"] = int(proxy_id)
        except ValueError:
            payload["proxy_id"] = proxy_id
    if redirect_uri:
        payload["redirect_uri"] = redirect_uri
    response = session.post(
        f"{base_url}/api/v1/admin/openai/generate-auth-url",
        headers=sub2_headers(base_url, admin_api_key),
        json=payload,
        timeout=timeout,
        impersonate=DEFAULT_PROFILE,
    )
    print(f"[协议] sub2 generate-auth-url -> HTTP {response.status_code}")
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(f"generate-auth-url failed: HTTP {response.status_code} {response_error_text(response)}")
    try:
        payload_json = response.json()
    except Exception as exc:
        raise RuntimeError(f"generate-auth-url returned non-JSON: {response.text[:1200]}") from exc
    data = payload_json.get("data") if isinstance(payload_json, dict) else None
    if not isinstance(data, dict):
        raise RuntimeError(f"generate-auth-url returned unexpected payload: {json.dumps(payload_json, ensure_ascii=False)[:1200]}")
    session_id = str(data.get("session_id") or "").strip()
    auth_url = str(data.get("auth_url") or "").strip()
    state = parse_query_fields(auth_url).get("state", "")
    if not session_id or not auth_url or not state:
        raise RuntimeError("generate-auth-url response missing session_id/auth_url/state")
    return {"session_id": session_id, "auth_url": auth_url, "state": state}


def exchange_sub2_code(
    session: Session,
    base_url: str,
    admin_api_key: str,
    session_id: str,
    code: str,
    state: str,
    proxy_id: str,
    timeout: int,
) -> dict[str, Any]:
    payload: dict[str, Any] = {"session_id": session_id, "code": code, "state": state}
    if proxy_id:
        try:
            payload["proxy_id"] = int(proxy_id)
        except ValueError:
            payload["proxy_id"] = proxy_id
    response = None
    transient_statuses = {408, 425, 429, 500, 502, 503, 504}
    max_attempts = 4
    for attempt in range(1, max_attempts + 1):
        try:
            response = session.post(
                f"{base_url}/api/v1/admin/openai/exchange-code",
                headers=sub2_headers(base_url, admin_api_key),
                json=payload,
                timeout=timeout,
                impersonate=DEFAULT_PROFILE,
            )
        except Exception as exc:
            if attempt >= max_attempts:
                raise
            delay = min(2 ** (attempt - 1), 4)
            eprint(f"[协议] sub2 exchange-code 传输失败，{delay} 秒后重试 ({attempt}/{max_attempts}): {exc}")
            time.sleep(delay)
            continue
        print(f"[协议] sub2 exchange-code -> HTTP {response.status_code}")
        if response.status_code not in transient_statuses or attempt >= max_attempts:
            break
        delay = min(2 ** (attempt - 1), 4)
        eprint(f"[协议] sub2 exchange-code 临时返回 HTTP {response.status_code}，{delay} 秒后重试 ({attempt}/{max_attempts})")
        time.sleep(delay)
    if response is None:
        raise RuntimeError("exchange-code failed without a response")
    if response.status_code < 200 or response.status_code >= 300:
        raise RuntimeError(f"exchange-code failed: HTTP {response.status_code} {response_error_text(response)}")
    try:
        return response.json()
    except Exception:
        return {"raw": response.text}


def extract_refresh_token(payload: Any) -> str:
    if isinstance(payload, str):
        try:
            return extract_refresh_token(json.loads(payload))
        except Exception:
            return ""
    if isinstance(payload, dict):
        for key in ("rt", "refresh_token", "refreshToken"):
            value = str(payload.get(key) or "").strip()
            if value:
                return value
        for key in ("data", "result", "tokens", "token", "payload"):
            token = extract_refresh_token(payload.get(key))
            if token:
                return token
    if isinstance(payload, list):
        for item in payload:
            token = extract_refresh_token(item)
            if token:
                return token
    return ""


def exchange_after_callback(
    session: Session,
    base_url: str,
    admin_api_key: str,
    session_id: str,
    code: str,
    state: str,
    proxy_id: str,
    timeout: int,
    enabled: bool,
) -> tuple[str, str]:
    if not enabled:
        return "", ""
    if not session_id or not code or not state:
        return "", "callback 缺少 session_id/code/state"
    try:
        payload = exchange_sub2_code(
            session,
            base_url,
            admin_api_key,
            session_id,
            code,
            state,
            proxy_id,
            timeout,
        )
        refresh_token = extract_refresh_token(payload)
        if not refresh_token:
            return "", "exchange-code 返回值中没有 rt/refresh_token"
        return refresh_token, ""
    except Exception as exc:
        message = str(exc)
        eprint(f"[协议] exchange-code 未获取 RT: {message}")
        return "", message


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    args = parse_args()
    template = load_har_template(args.har if os.path.exists(args.har) else None)
    state = load_state(args.state_file)
    document_navigation_id = str(
        state.get("document_navigation_id") or uuid.uuid4()
    ).strip()
    template["document_navigation_id"] = document_navigation_id
    state["document_navigation_id"] = document_navigation_id
    session_id = str(args.session_id or state.get("session_id") or template.get("session_id") or "").strip()
    auth_session_id = str(state.get("auth_session_id") or template.get("auth_session_id") or "").strip()
    workspace_id = str(state.get("workspace_id") or template.get("workspace_id") or "").strip()
    sub2_session_id = str(state.get("sub2_session_id") or "").strip()
    oauth_code = (args.oauth_code or state.get("oauth_code") or template.get("code") or "").strip()
    oauth_state = (args.oauth_state or state.get("oauth_state") or template.get("state") or "").strip()
    refresh_token = str(state.get("refresh_token") or "").strip()
    exchange_error = str(state.get("exchange_error") or "").strip()
    sub2_base_url = clean_base_url(args.sub2_base_url or env_text("SUB2API_BASE_URL"))
    sub2_admin_api_key = args.sub2_admin_api_key or env_text("SUB2API_ADMIN_API_KEY")
    sub2_proxy_id = args.sub2_proxy_id or env_text("SUB2API_PROXY_ID")
    sub2_redirect_uri = args.sub2_redirect_uri or env_text("SUB2API_REDIRECT_URI")

    request_proxy = (args.proxy or env_text("PHONE_BIND_PROXY")).strip()
    session = Session(proxy=request_proxy or None)
    cookie_header = load_cookie_header(args)
    raw_cookie_count = apply_cookie_header(session, cookie_header)
    if raw_cookie_count:
        print(f"[协议] 已将原始 Cookie 载入实时会话（{raw_cookie_count} 条）")
    state_cookie_count = apply_cookie_list(session, state.get("cookies"))
    if state_cookie_count:
        print(f"[协议] 已从状态文件恢复 {state_cookie_count} 条 Cookie")
    cookie_count = apply_cookie_json(session, args)
    if cookie_count:
        print(f"[协议] 已注入 {cookie_count} 条 Cookie")

    if args.stage == "exchange":
        if not (sub2_session_id or session_id) or not oauth_code or not oauth_state:
            raise SystemExit("状态文件缺少 session_id/code/state，不能单独重试 RT 交换。")
        refresh_token, exchange_error = exchange_after_callback(
            session,
            sub2_base_url,
            sub2_admin_api_key,
            sub2_session_id or session_id,
            oauth_code,
            oauth_state,
            sub2_proxy_id,
            args.timeout,
            True,
        )
        save_state(args.state_file, {
            **state,
            "refresh_token": refresh_token,
            "exchange_error": exchange_error,
            "workflow_stage": "completed" if refresh_token else "rt_pending",
            "updated_at": int(time.time() * 1000),
        })
        if not refresh_token:
            raise RuntimeError(f"RT 获取失败: {exchange_error or 'refresh_token 为空'}")
        print(json.dumps({"status": "completed", "refresh_token": refresh_token}, ensure_ascii=False))
        print("[协议] 已仅重试 Sub2 exchange-code 并获取 RT。")
        return 0

    if args.stage == "validate":
        if not session_id:
            raise SystemExit("缺少 session_id。请先执行 send 阶段并保存 state-file。")
        if not sub2_session_id:
            sub2_session_id = str(state.get("sub2_session_id") or "").strip()

        code = (args.otp or input("请输入短信验证码: ")).strip()
        if not code:
            raise SystemExit("验证码不能为空。")
        data = post_json(
            session,
            "/api/accounts/phone-otp/validate",
            {"code": code},
            "https://auth.openai.com/phone-verification",
            template,
            cookie_header,
            args.timeout,
        )
        print("[协议] 验证码已提交。")
        continue_url = str(data.get("continue_url") or "")
        if continue_url:
            print(f"[协议] 下一步: {continue_url}")

        expected_oauth_state = oauth_state
        confirmed = confirm_phone_verification(session, data, template, cookie_header, args.timeout)
        callback = {
            "code": confirmed.get("code", ""),
            "state": confirmed.get("state", ""),
        }
        if not callback.get("code") or not callback.get("state"):
            callback = follow_to_callback(
                session,
                confirmed.get("continue_url") or continue_url,
                template,
                cookie_header,
                args.timeout,
            )
        oauth_code = str(callback.get("code") or "").strip()
        callback_state = str(callback.get("state") or "").strip()
        if not oauth_code or not callback_state:
            raise RuntimeError(
                "确认步骤未返回包含 code/state 的回跳地址"
                f"（{confirmed.get('diagnostic') or 'response=unknown'}；"
                f"validate_continue_url={'set' if continue_url else 'none'}）"
            )
        if expected_oauth_state and callback_state != expected_oauth_state:
            raise RuntimeError("consent/grant 回跳 state 与当前 Sub2 OAuth 会话不匹配")
        oauth_state = callback_state

        if args.exchange_after_bind:
            exchanged_refresh_token, exchange_error = exchange_after_callback(
                session,
                sub2_base_url,
                sub2_admin_api_key,
                sub2_session_id or session_id,
                oauth_code,
                oauth_state,
                sub2_proxy_id,
                args.timeout,
                True,
            )
            if exchanged_refresh_token:
                refresh_token = exchanged_refresh_token
        next_state = {
            **state,
            "session_id": session_id,
            "auth_session_id": auth_session_id,
            "workspace_id": workspace_id,
            "sub2_session_id": sub2_session_id,
            "oauth_code": oauth_code,
            "oauth_state": oauth_state,
            "refresh_token": refresh_token,
            "exchange_error": exchange_error,
            "workflow_stage": "completed" if refresh_token else "rt_pending",
            "cookies": export_cookies(session),
            "updated_at": int(time.time() * 1000),
        }
        save_state(args.state_file, next_state)
        if args.exchange_after_bind and not refresh_token:
            raise RuntimeError(f"手机绑定已确认，但 RT 获取失败: {exchange_error or 'refresh_token 为空'}")
        print(json.dumps({
            "session_id": session_id,
            "auth_session_id": auth_session_id,
            "workspace_id": workspace_id,
            "sub2_session_id": sub2_session_id,
            "oauth_code": oauth_code,
            "oauth_state": oauth_state,
            "refresh_token": refresh_token,
            "exchange_error": exchange_error,
        }, ensure_ascii=False))
        print("[协议] 手机绑定流程已完成到 callback 三元组。")
        return 0

    reusing_saved_auth = bool(args.reuse_saved_auth and session_id and sub2_session_id)
    if reusing_saved_auth:
        print(f"[协议] 复用已保存的 Sub2API session_id: {sub2_session_id}")
    else:
        cleared_auth_cookies = clear_transient_auth_flow_cookies(session)
        if cleared_auth_cookies:
            print(f"[协议] 实时授权前已清理 {cleared_auth_cookies} 条旧流程 Cookie")
        sub2_auth = generate_sub2_auth_url(
            session,
            sub2_base_url,
            sub2_admin_api_key,
            sub2_proxy_id,
            sub2_redirect_uri,
            args.timeout,
        )
        sub2_session_id = sub2_auth["session_id"]
        oauth_state = oauth_state or sub2_auth["state"]
        print(f"[协议] 已实时生成 Sub2API session_id: {sub2_session_id}")

        if args.dump_fields:
            print(json.dumps({
                "session_id": session_id,
                "sub2_session_id": sub2_session_id,
                "auth_url": sub2_auth["auth_url"],
                "workspace_id": workspace_id,
                "oauth_code": oauth_code,
                "oauth_state": oauth_state,
                "login_verifier": str(template.get("login_verifier") or ""),
            }, ensure_ascii=False, indent=2))
            return 0

        live_openai_fields = begin_openai_auth_flow(
            session,
            sub2_auth["auth_url"],
            sub2_base_url,
            template,
            cookie_header,
            args.timeout,
        )
        session_id = session_id or live_openai_fields.get("session_id", "")
        auth_session_id = auth_session_id or live_openai_fields.get("auth_session_id", "")
        if live_openai_fields.get("openai_client_id"):
            template["openai_client_id"] = live_openai_fields["openai_client_id"]
        if live_openai_fields.get("auth_session_logging_id"):
            template["auth_session_logging_id"] = live_openai_fields["auth_session_logging_id"]

    selection_data: dict[str, Any] = {}
    if not args.skip_select:
        if not session_id:
            if live_openai_fields.get("login_required"):
                login_path = live_openai_fields.get("login_path") or "/log-in"
                raise SystemExit(
                    "PHONE_BIND_REAUTH_REQUIRED: auth.openai 登录态已失效，"
                    f"OAuth 落到 {login_path}，需要重新完成邮箱验证/登录后才能继续 session/select。"
                )
            raise SystemExit("实时 auth_url 未能提取 OpenAI session_id，不能继续 session/select。")
        selection_sentinel = sentinel_token_for_action(session, "authorize_continue", "session/select")
        selection_data = post_json(
            session,
            "/api/accounts/session/select",
            {"session_id": session_id},
            "https://auth.openai.com/choose-an-account",
            template,
            cookie_header,
            args.timeout,
            extra_headers={"openai-sentinel-token": selection_sentinel},
        )

        selection_page = selection_data.get("page") if isinstance(selection_data.get("page"), dict) else {}
        selection_page_type = str(selection_data.get("type") or selection_page.get("type") or "").strip()
        if selection_page_type and selection_page_type != "add_phone":
            if not is_chatgpt_consent_page(selection_page):
                raise RuntimeError(
                    f"session/select 返回不支持的授权步骤: {selection_page_type}"
                )
            expected_oauth_state = oauth_state
            confirmed = confirm_phone_verification(
                session,
                selection_data,
                template,
                cookie_header,
                args.timeout,
            )
            workspace_id = str(confirmed.get("workspace_id") or workspace_id).strip()
            callback = {
                "code": confirmed.get("code", ""),
                "state": confirmed.get("state", ""),
            }
            if not callback.get("code") or not callback.get("state"):
                callback = follow_to_callback(
                    session,
                    confirmed.get("continue_url") or extract_continue_url(selection_data),
                    template,
                    cookie_header,
                    args.timeout,
                )
            oauth_code = str(callback.get("code") or "").strip()
            callback_state = str(callback.get("state") or "").strip()
            if not oauth_code or not callback_state:
                raise RuntimeError(
                    "无需手机号的授权确认未返回包含 code/state 的回跳地址"
                    f"（{confirmed.get('diagnostic') or 'response=unknown'}）"
                )
            if expected_oauth_state and callback_state != expected_oauth_state:
                raise RuntimeError("无需手机号的授权回跳 state 与当前 Sub2 OAuth 会话不匹配")
            oauth_state = callback_state
            refresh_token, exchange_error = exchange_after_callback(
                session,
                sub2_base_url,
                sub2_admin_api_key,
                sub2_session_id or session_id,
                oauth_code,
                oauth_state,
                sub2_proxy_id,
                args.timeout,
                True,
            )
            save_state(args.state_file, {
                **state,
                "session_id": session_id,
                "auth_session_id": auth_session_id,
                "workspace_id": workspace_id,
                "sub2_session_id": sub2_session_id,
                "oauth_code": oauth_code,
                "oauth_state": oauth_state,
                "refresh_token": refresh_token,
                "exchange_error": exchange_error,
                "workflow_stage": "completed" if refresh_token else "rt_pending",
                "phone_verification_skipped": True,
                "cookies": export_cookies(session),
                "updated_at": int(time.time() * 1000),
            })
            if not refresh_token:
                raise RuntimeError(
                    f"授权确认完成但 RT 获取失败: {exchange_error or 'refresh_token 为空'}"
                )
            print("[协议] 当前授权无需手机号，已直接完成 consent 并获取 RT。")
            return 0

    if args.authorization_only:
        raise RuntimeError("重新授权仍要求手机号验证，已停止刷新并保留原 RT")

    save_state(args.state_file, {
        **state,
        "authorization_ready": True,
        "workflow_stage": "authorization_ready",
        "session_id": session_id,
        "auth_session_id": auth_session_id,
        "sub2_session_id": sub2_session_id,
        "workspace_id": workspace_id,
        "oauth_code": oauth_code,
        "oauth_state": oauth_state,
        "cookies": export_cookies(session),
        "updated_at": int(time.time() * 1000),
    })
    print("[协议] 已保存可复用的 add-phone 授权状态。")

    phone = (args.phone or input("请输入完整手机号，包含国家/地区区号: ")).strip()
    if not phone.startswith("+"):
        raise SystemExit("手机号必须包含国家/地区区号，并以 + 开头。")
    post_json(
        session,
        "/api/accounts/add-phone/send",
        {"phone_number": phone, "channel": "sms"},
        "https://auth.openai.com/add-phone",
        template,
        cookie_header,
        args.timeout,
        retry_transport_once=True,
        request_timeout=min(args.timeout, 10),
    )
    print("[协议] 验证码已发送。")
    save_state(args.state_file, {
        **state,
        "authorization_ready": True,
        "workflow_stage": "otp_required",
        "phone": phone,
        "session_id": session_id,
          "auth_session_id": auth_session_id,
        "sub2_session_id": sub2_session_id,
        "workspace_id": workspace_id,
        "oauth_code": oauth_code,
        "oauth_state": oauth_state,
        "cookies": export_cookies(session),
        "updated_at": int(time.time() * 1000),
    })

    if args.stage == "send":
        print(json.dumps({
            "session_id": session_id,
            "auth_session_id": auth_session_id,
            "workspace_id": workspace_id,
            "sub2_session_id": sub2_session_id,
            "oauth_code": oauth_code,
            "oauth_state": oauth_state,
        }, ensure_ascii=False))
        print("[协议] 已保存发送阶段状态。")
        return 0

    otp_code = (args.otp or input("请输入短信验证码: ")).strip()
    if not otp_code:
        raise SystemExit("验证码不能为空。")
    data = post_json(
        session,
        "/api/accounts/phone-otp/validate",
        {"code": otp_code},
        "https://auth.openai.com/phone-verification",
        template,
        cookie_header,
        args.timeout,
    )
    print("[协议] 验证码已提交。")
    continue_url = str(data.get("continue_url") or "")
    if continue_url:
        print(f"[协议] 下一步: {continue_url}")

    expected_oauth_state = oauth_state
    confirmed = confirm_phone_verification(session, data, template, cookie_header, args.timeout)
    workspace_id = str(confirmed.get("workspace_id") or workspace_id).strip()
    callback = {
        "code": confirmed.get("code", ""),
        "state": confirmed.get("state", ""),
    }
    if not callback.get("code") or not callback.get("state"):
        callback = follow_to_callback(
            session,
            confirmed.get("continue_url") or continue_url,
            template,
            cookie_header,
            args.timeout,
        )
    oauth_code = str(callback.get("code") or "").strip()
    callback_state = str(callback.get("state") or "").strip()
    if not oauth_code or not callback_state:
        raise RuntimeError(
            "确认步骤未返回包含 code/state 的回跳地址"
            f"（{confirmed.get('diagnostic') or 'response=unknown'}；"
            f"validate_continue_url={'set' if continue_url else 'none'}）"
        )
    if expected_oauth_state and callback_state != expected_oauth_state:
        raise RuntimeError("consent/grant 回跳 state 与当前 Sub2 OAuth 会话不匹配")
    oauth_state = callback_state

    if args.exchange_after_bind:
        exchanged_refresh_token, exchange_error = exchange_after_callback(
            session,
            sub2_base_url,
            sub2_admin_api_key,
            sub2_session_id or session_id,
            oauth_code,
            oauth_state,
            sub2_proxy_id,
            args.timeout,
            True,
        )
        if exchanged_refresh_token:
            refresh_token = exchanged_refresh_token
    save_state(args.state_file, {
        **state,
        "phone": phone,
        "session_id": session_id,
          "auth_session_id": auth_session_id,
        "sub2_session_id": sub2_session_id,
        "workspace_id": workspace_id,
        "oauth_code": oauth_code,
        "oauth_state": oauth_state,
        "refresh_token": refresh_token,
        "exchange_error": exchange_error,
        "workflow_stage": "completed" if refresh_token else "rt_pending",
        "cookies": export_cookies(session),
        "updated_at": int(time.time() * 1000),
    })
    if args.exchange_after_bind and not refresh_token:
        raise RuntimeError(f"手机绑定已确认，但 RT 获取失败: {exchange_error or 'refresh_token 为空'}")

    print(json.dumps({
        "session_id": session_id,
            "auth_session_id": auth_session_id,
            "workspace_id": workspace_id,
            "sub2_session_id": sub2_session_id,
        "oauth_code": oauth_code,
        "oauth_state": oauth_state,
        "refresh_token": refresh_token,
        "exchange_error": exchange_error,
    }, ensure_ascii=False))
    print("[协议] 手机绑定流程已完成到 callback 三元组。")
    if refresh_token:
        print("[协议] 已从 Sub2 exchange-code 获取 RT。")
    elif exchange_error:
        print(f"[协议] RT 未获取: {exchange_error}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        eprint("\n已取消。")
        raise SystemExit(130)
    except Exception as exc:
        eprint(f"[协议] 失败: {exc}")
        raise SystemExit(1)
