# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import re
import sys
import time
from datetime import timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote

from curl_cffi import requests

COOKIE_NAME = "__Secure-next-auth.session-token"
COOKIE_CHUNK_RE = re.compile(r"^" + re.escape(COOKIE_NAME) + r"\.(\d+)$")


def proxy_url(proxy: dict) -> str:
    host = str(proxy.get("host") or "").strip()
    port = str(proxy.get("port") or "").strip()
    if not host or not port:
        raw = str(proxy.get("raw") or "").strip()
        return raw if "://" in raw else (f"http://{raw}" if raw else "")
    username = str(proxy.get("username") or "")
    password = str(proxy.get("password") or "")
    auth = ""
    if username or password:
        auth = f"{quote(username, safe='')}:{quote(password, safe='')}@"
    return f"http://{auth}{host}:{port}"


def header_values(headers, name: str) -> list[str]:
    try:
        return [str(value) for value in headers.get_list(name)]
    except Exception:
        value = str(headers.get(name) or "")
        return [value] if value else []


def cookie_result(set_cookie: str) -> dict:
    match = re.match(r"\s*([^=]+)=(.*?)(?:;|$)", set_cookie)
    name = match.group(1).strip() if match else COOKIE_NAME
    value = match.group(2) if match else ""
    max_age = re.search(r";\s*Max-Age=([^;]+)", set_cookie, re.I)
    expires_match = re.search(r";\s*Expires=([^;]+)", set_cookie, re.I)
    domain = re.search(r";\s*Domain=([^;]+)", set_cookie, re.I)
    path = re.search(r";\s*Path=([^;]+)", set_cookie, re.I)
    same_site = re.search(r";\s*SameSite=([^;]+)", set_cookie, re.I)
    expires = None
    if expires_match:
        try:
            expires = parsedate_to_datetime(expires_match.group(1)).astimezone(timezone.utc).timestamp()
        except Exception:
            expires = None
    return {
        "name": name,
        "value": value,
        "maxAge": int(max_age.group(1)) if max_age else None,
        "expires": expires,
        "domain": domain.group(1).strip() if domain else ".chatgpt.com",
        "path": path.group(1).strip() if path else "/",
        "httpOnly": bool(re.search(r";\s*HttpOnly(?:;|$)", set_cookie, re.I)),
        "secure": bool(re.search(r";\s*Secure(?:;|$)", set_cookie, re.I)),
        "sameSite": same_site.group(1).strip().capitalize() if same_site else "Lax",
    }


def replace_cookie(header: str, name: str, value: str) -> str:
    pairs: list[tuple[str, str]] = []
    replaced = False
    for part in str(header or "").split(";"):
        key, separator, current = part.strip().partition("=")
        if not separator or not key:
            continue
        if key == name:
            current = value
            replaced = True
        pairs.append((key, current))
    if not replaced:
        pairs.append((name, value))
    return "; ".join(f"{key}={current}" for key, current in pairs)


def session_token_from_cookie_header(header: str) -> str:
    exact = ""
    chunks: list[tuple[int, str]] = []
    for part in str(header or "").split(";"):
        key, separator, value = part.strip().partition("=")
        if not separator or not key or not value:
            continue
        if key == COOKIE_NAME:
            exact = value
            continue
        match = COOKIE_CHUNK_RE.match(key)
        if match:
            try:
                chunks.append((int(match.group(1)), value))
            except Exception:
                pass
    if exact:
        return exact
    if chunks:
        return "".join(value for _, value in sorted(chunks, key=lambda item: item[0]))
    return ""


def normalized_session_cookies(cookies: list[dict]) -> list[dict]:
    has_chunks = any(COOKIE_CHUNK_RE.match(str(cookie.get("name") or "")) for cookie in cookies)
    if has_chunks:
        return [cookie for cookie in cookies if str(cookie.get("name") or "") != COOKIE_NAME]
    return cookies


def authenticated_account(body: object) -> dict | None:
    if not isinstance(body, dict) or not isinstance(body.get("accounts"), dict):
        return None
    for key, entry in body["accounts"].items():
        if not isinstance(entry, dict):
            continue
        nested = entry.get("account") if isinstance(entry.get("account"), dict) else {}
        entitlement = entry.get("entitlement") if isinstance(entry.get("entitlement"), dict) else {}
        account_id = str(
            nested.get("id")
            or nested.get("account_id")
            or nested.get("accountId")
            or entry.get("id")
            or entry.get("account_id")
            or entry.get("accountId")
            or key
            or ""
        ).strip()
        plan = str(
            entitlement.get("subscription_plan")
            or entitlement.get("plan")
            or entitlement.get("plan_type")
            or entry.get("subscription_plan")
            or entry.get("plan")
            or entry.get("plan_type")
            or ""
        ).strip()
        if account_id and account_id.lower() != "default" and "guest" not in plan.lower():
            return {"account_id": account_id, "plan": plan}
    return None


def main() -> int:
    try:
        config = json.load(sys.stdin)
        email = str(config.get("email") or "").strip().lower()
        cookie = str(config.get("cookie") or "").strip()
        old_token = session_token_from_cookie_header(cookie)
        if not email or not old_token:
            raise RuntimeError("SESSION_COOKIE_MISSING: email or session cookie is missing")
        proxy = proxy_url(config.get("proxy") or {})
        if not proxy:
            raise RuntimeError("SESSION_COOKIE_PROXY_MISSING: proxy is missing")
        headers = {
            "accept": "application/json",
            "cookie": cookie,
            "user-agent": str(config.get("user_agent") or "Mozilla/5.0"),
        }
        if config.get("device_id"):
            headers["oai-device-id"] = str(config["device_id"])
        nonce = int(time.time() * 1000)
        session_paths = [
            f"/api/auth/session?refresh={nonce}&reason=checkout_preflight",
            f"/api/auth/session?workspace_update=true&reason=checkout_preflight&refresh={nonce + 1}",
        ]
        response = None
        body = {}
        target = ""
        current_cookie = cookie
        for session_path in session_paths:
            request_headers = {
                **headers,
                "cookie": current_cookie,
                "cache-control": "no-cache",
                "pragma": "no-cache",
            }
            candidate = requests.get(
                f"https://chatgpt.com{session_path}",
                headers=request_headers,
                proxies={"http": proxy, "https": proxy},
                impersonate="chrome131",
                timeout=30,
                allow_redirects=False,
            )
            try:
                candidate_body = candidate.json()
            except Exception:
                candidate_body = {}
            observed = str(((candidate_body.get("user") or {}).get("email") if isinstance(candidate_body, dict) else "") or "").lower()
            access_token = str((candidate_body.get("accessToken") if isinstance(candidate_body, dict) else "") or "")
            if candidate.status_code != 200 or observed != email or not access_token:
                continue
            response = candidate
            body = candidate_body
            rotated_values = [
                value for value in header_values(candidate.headers, "set-cookie")
                if value.lstrip().startswith(f"{COOKIE_NAME}=") or re.match(r"\s*" + re.escape(COOKIE_NAME) + r"\.\d+=", value)
            ]
            if rotated_values:
                target = rotated_values[0]
                for rotated in rotated_values:
                    parsed_cookie = cookie_result(rotated)
                    current_cookie = replace_cookie(current_cookie, parsed_cookie["name"], parsed_cookie["value"])
        if response is None:
            print(json.dumps({
                "ok": False,
                "code": "SESSION_COOKIE_IDENTITY_NOT_PROVEN",
                "status": 0,
                "error": "saved cookie did not prove the expected account identity",
            }))
            return 2
        access_token = str((body.get("accessToken") if isinstance(body, dict) else "") or "")
        if not access_token:
            print(json.dumps({
                "ok": False,
                "code": "SESSION_ACCESS_TOKEN_MISSING",
                "status": response.status_code,
                "error": "authenticated session did not return an access token",
            }))
            return 3
        renewed_cookies = normalized_session_cookies([cookie_result(value) for value in header_values(response.headers, "set-cookie") if value.lstrip().startswith(f"{COOKIE_NAME}=") or re.match(r"\s*" + re.escape(COOKIE_NAME) + r"\.\d+=", value)])
        if not renewed_cookies and target:
            renewed_cookies = normalized_session_cookies([cookie_result(target)])
        renewed_token = session_token_from_cookie_header(current_cookie) or old_token
        renewed = {
            "name": COOKIE_NAME,
            "value": renewed_token,
            "maxAge": None,
            "expires": renewed_cookies[0].get("expires") if renewed_cookies else None,
            "domain": ".chatgpt.com",
            "path": "/",
            "httpOnly": True,
            "secure": True,
            "sameSite": "Lax",
        }
        validated_cookie = current_cookie
        check_headers = {
            "accept": "application/json",
            "authorization": f"Bearer {access_token}",
            "cookie": validated_cookie,
            "origin": "https://chatgpt.com",
            "referer": "https://chatgpt.com/",
            "user-agent": headers["user-agent"],
            "oai-language": "en-US",
        }
        if config.get("device_id"):
            check_headers["oai-device-id"] = str(config["device_id"])
        check_response = requests.get(
            "https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27",
            headers=check_headers,
            proxies={"http": proxy, "https": proxy},
            impersonate="chrome131",
            timeout=30,
            allow_redirects=False,
        )
        try:
            check_body = check_response.json()
        except Exception:
            check_body = {}
        verified_account = authenticated_account(check_body)
        access_token_validated = check_response.status_code == 200 and bool(verified_account)
        print(json.dumps({
            "ok": True,
            "status": response.status_code,
            "renewed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "session_cookie": renewed,
            "session_cookies": renewed_cookies,
            "cookie_changed": renewed["value"] != old_token,
            "access_token": access_token,
            "access_token_validated": access_token_validated,
            "accounts_check_status": check_response.status_code,
            "validated_account_id": verified_account["account_id"] if verified_account else None,
            "validated_plan": verified_account["plan"] if verified_account else None,
        }))
        return 0
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "code": "SESSION_COOKIE_RENEWAL_FAILED",
            "error": f"{type(exc).__name__}: {str(exc)[:500]}",
        }))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
