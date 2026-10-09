# -*- coding: utf-8 -*-
"""Direct TOTP 2FA setup for ChatGPT accounts.

This script is pure protocol code: no browser, no Selenium, no page clicks.
It follows the explicit API chain:

    GET  /backend-api/accounts/mfa_info
    POST /backend-api/accounts/mfa/enroll
    GET  /backend-api/accounts/mfa_info
    POST /backend-api/accounts/mfa/user/activate_enrollment
    GET  /backend-api/accounts/mfa_info

It expects an access token that is already valid for the account. If OpenAI
returns 401/403, the token is not accepted for this MFA operation; this script
will fail fast and will not fall back to browser automation.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import asdict, dataclass
from typing import Any

import pyotp
import requests


CHATGPT_ORIGIN = "https://chatgpt.com"
MFA_INFO_URL = f"{CHATGPT_ORIGIN}/backend-api/accounts/mfa_info"
MFA_ENROLL_URL = f"{CHATGPT_ORIGIN}/backend-api/accounts/mfa/enroll"
MFA_ACTIVATE_URL = f"{CHATGPT_ORIGIN}/backend-api/accounts/mfa/user/activate_enrollment"


@dataclass
class Totp2faResult:
    success: bool
    secret: str
    enrollment_session_id: str
    active_factor_id: str
    before: dict[str, Any]
    after_enroll: dict[str, Any]
    after_activate: dict[str, Any]
    activated: bool | None = None
    verified: bool = False
    verification_error: dict[str, str] | None = None


class OpenAITotp2faError(RuntimeError):
    pass


def _json_or_text(response: requests.Response) -> Any:
    text = response.text or ""
    try:
        return response.json()
    except ValueError:
        return {"raw": text[:2000]}


def _raise_for_api_error(response: requests.Response, action: str) -> None:
    if 200 <= response.status_code < 300:
        return
    data = _json_or_text(response)
    raise OpenAITotp2faError(
        f"{action} failed: HTTP {response.status_code}: "
        f"{json.dumps(data, ensure_ascii=False)[:2000]}"
    )


def _active_totp_factor_id(mfa_info: dict[str, Any]) -> str:
    factors = mfa_info.get("factors") if isinstance(mfa_info, dict) else None
    if not isinstance(factors, dict):
        return ""
    totp_factors = factors.get("totp") or []
    if not isinstance(totp_factors, list):
        return ""
    for item in totp_factors:
        if isinstance(item, dict) and item.get("id"):
            return str(item["id"])
    return ""


class OpenAITotp2faClient:
    def __init__(
        self,
        access_token: str,
        *,
        cookie: str = "",
        user_agent: str = "",
        oai_device_id: str = "",
        language: str = "en-US",
        proxy: str = "",
        timeout: int = 30,
        session: Any = None,
    ) -> None:
        token = str(access_token or "").strip()
        if token.lower().startswith("bearer "):
            token = token[7:].strip()
        if not token:
            raise ValueError("access_token is required")

        self.timeout = int(timeout or 30)
        self.session = session if session is not None else requests.Session()
        if proxy and session is None:
            self.session.proxies.update({"http": proxy, "https": proxy})

        self.headers = {
            "accept": "application/json",
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "origin": CHATGPT_ORIGIN,
            "referer": f"{CHATGPT_ORIGIN}/",
            "oai-language": language or "en-US",
            "user-agent": user_agent
            or "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "Chrome/124.0.0.0 Safari/537.36",
        }
        if cookie:
            self.headers["cookie"] = cookie
        if oai_device_id:
            self.headers["oai-device-id"] = oai_device_id

    def mfa_info(self) -> dict[str, Any]:
        response = self.session.get(MFA_INFO_URL, headers=self.headers, timeout=self.timeout)
        _raise_for_api_error(response, "GET mfa_info")
        data = _json_or_text(response)
        if not isinstance(data, dict):
            raise OpenAITotp2faError(f"mfa_info returned non-object JSON: {data!r}")
        return data

    def enroll(self) -> tuple[str, str, dict[str, Any]]:
        response = self.session.post(
            MFA_ENROLL_URL,
            headers=self.headers,
            data=json.dumps({"factor_type": "totp"}),
            timeout=self.timeout,
        )
        _raise_for_api_error(response, "POST mfa/enroll")
        data = _json_or_text(response)
        if not isinstance(data, dict):
            raise OpenAITotp2faError(f"enroll returned non-object JSON: {data!r}")
        secret = str(data.get("secret") or "").strip()
        session_id = str(data.get("session_id") or "").strip()
        if not secret or not session_id:
            raise OpenAITotp2faError(
                "enroll response missing secret/session_id: "
                f"{json.dumps(data, ensure_ascii=False)[:2000]}"
            )
        return secret, session_id, data

    def activate(self, secret: str, session_id: str) -> dict[str, Any]:
        code = pyotp.TOTP(secret).now()
        response = self.session.post(
            MFA_ACTIVATE_URL,
            headers=self.headers,
            data=json.dumps({
                "code": code,
                "factor_type": "totp",
                "session_id": session_id,
            }),
            timeout=self.timeout,
        )
        _raise_for_api_error(response, "POST mfa/user/activate_enrollment")
        data = _json_or_text(response)
        if not isinstance(data, dict):
            raise OpenAITotp2faError(f"activate returned non-object JSON: {data!r}")
        if data.get("success") is not True:
            raise OpenAITotp2faError(
                "activate returned success!=true: "
                f"{json.dumps(data, ensure_ascii=False)[:2000]}"
            )
        return data

    def setup_totp(self) -> Totp2faResult:
        before = self.mfa_info()
        existing_factor_id = _active_totp_factor_id(before)
        if existing_factor_id:
            raise OpenAITotp2faError(f"TOTP already enabled: active_factor_id={existing_factor_id}")

        secret, session_id, _enroll_response = self.enroll()
        after_enroll: dict[str, Any] = {}
        after_activate: dict[str, Any] = {}
        active_factor_id = ""
        activated = None
        verification_error = None
        try:
            after_enroll = self.mfa_info()
            self.activate(secret, session_id)
            activated = True
            after_activate = self.mfa_info()
            active_factor_id = _active_totp_factor_id(after_activate)
            if not active_factor_id:
                raise OpenAITotp2faError("activate succeeded but final mfa_info has no active totp factor")
        except Exception as exc:
            verification_error = {"code": "TOTP_VERIFICATION_PENDING", "message": f"{type(exc).__name__}: {exc}"}

        return Totp2faResult(
            success=verification_error is None,
            secret=secret,
            enrollment_session_id=session_id,
            active_factor_id=active_factor_id,
            before=before,
            after_enroll=after_enroll,
            after_activate=after_activate,
            activated=activated,
            verified=verification_error is None,
            verification_error=verification_error,
        )


def setup_totp_2fa(
    access_token: str,
    *,
    cookie: str = "",
    user_agent: str = "",
    oai_device_id: str = "",
    language: str = "en-US",
    proxy: str = "",
    timeout: int = 30,
    session: Any = None,
) -> Totp2faResult:
    client = OpenAITotp2faClient(
        access_token,
        cookie=cookie,
        user_agent=user_agent,
        oai_device_id=oai_device_id,
        language=language,
        proxy=proxy,
        timeout=timeout,
        session=session,
    )
    return client.setup_totp()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Set ChatGPT TOTP 2FA with direct backend API calls.")
    parser.add_argument("--access-token", default=os.getenv("OPENAI_ACCESS_TOKEN", ""), help="ChatGPT access token, or env OPENAI_ACCESS_TOKEN")
    parser.add_argument("--cookie", default=os.getenv("CHATGPT_COOKIE", ""), help="Optional browser Cookie header, or env CHATGPT_COOKIE")
    parser.add_argument("--user-agent", default=os.getenv("CHATGPT_USER_AGENT", ""), help="Optional browser User-Agent")
    parser.add_argument("--oai-device-id", default=os.getenv("OAI_DEVICE_ID", ""), help="Optional oai-device-id header")
    parser.add_argument("--language", default=os.getenv("OAI_LANGUAGE", "en-US"), help="oai-language header")
    parser.add_argument("--proxy", default=os.getenv("HTTPS_PROXY", "") or os.getenv("HTTP_PROXY", ""), help="Optional HTTP(S) proxy")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    try:
        result = setup_totp_2fa(
            args.access_token,
            cookie=args.cookie,
            user_agent=args.user_agent,
            oai_device_id=args.oai_device_id,
            language=args.language,
            proxy=args.proxy,
            timeout=args.timeout,
        )
    except Exception as exc:
        payload = {"success": False, "error": f"{type(exc).__name__}: {exc}"}
        print(json.dumps(payload, ensure_ascii=False, indent=2 if args.pretty else None))
        return 1

    print(json.dumps(asdict(result), ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if result.success else 1


if __name__ == "__main__":
    sys.exit(main())
