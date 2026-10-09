from __future__ import annotations

import asyncio
import json
import re
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any


FREEPP_BACKEND = Path(__file__).resolve().parents[2] / "vendor" / "freepp" / "backend"
FREEPP_PYTHON = Path(sys.executable)


def _languages(locale: str) -> list[str]:
    primary = str(locale or "en-US").strip() or "en-US"
    root = primary.split("-", 1)[0]
    return [primary] if root == primary else [primary, root]


def _chrome_major(user_agent: str) -> str:
    match = re.search(r"(?:Chrome|CriOS)/(\d+)", str(user_agent or ""))
    return match.group(1) if match else "145"


def _timezone_for_locale(locale: str) -> str:
    return {
        "en-GB": "Europe/London",
        "en-US": "America/New_York",
        "ja-JP": "Asia/Tokyo",
        "en-SG": "Asia/Singapore",
        "vi-VN": "Asia/Ho_Chi_Minh",
        "en-PH": "Asia/Manila",
        "id-ID": "Asia/Jakarta",
        "en-IN": "Asia/Kolkata",
    }.get(locale, "UTC")


async def payment_sentinel_headers(
    proxy: str,
    flow: str,
    device_id: str,
    cookie_device_id: str,
    *,
    use_sen: bool = True,
    use_so: bool = True,
    diagnostic_job_id: str = "",
    user_agent: str = "",
    language: str = "",
    impersonate: str = "",
) -> dict[str, str]:
    del diagnostic_job_id
    if not use_sen and not use_so:
        return {}
    did = str(device_id or cookie_device_id or "").strip()
    if not did or did != str(cookie_device_id or did).strip():
        raise RuntimeError("payment Sentinel device id does not match oai-did cookie")
    locale = str(language or "en-US").strip() or "en-US"
    ua = str(user_agent or "").strip()
    major = _chrome_major(ua)
    fp: dict[str, Any] = {
        "ua": ua,
        "impersonate": str(impersonate or f"chrome{major}"),
        "languages": _languages(locale),
        "timezone_name": _timezone_for_locale(locale),
        "hardware_concurrency": 16,
        "screen": {"width": 1920, "height": 1080, "px_ratio": 1.0},
        "sentinel_sdk_url": "https://sentinel.openai.com/backend-api/sentinel/sdk.js",
        "sentinel_session_id": str(uuid.uuid4()),
        "document_build_marker": None,
        "window_feature_flags": [0] * 7,
        "location_search": "",
        "chrome_fp": {
            "sec-ch-ua": (
                f'"Chromium";v="{major}", "Not-A.Brand";v="24", '
                f'"Google Chrome";v="{major}"'
            ),
            "sec-ch-ua-platform": '"Windows"',
        },
    }
    request = {"flow": flow, "proxy": proxy, "did": did, "fp": fp}
    process = await asyncio.to_thread(
        subprocess.run,
        [str(FREEPP_PYTHON), str(Path(__file__).resolve()), "--worker"],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        timeout=90,
        check=False,
    )
    try:
        result = json.loads((process.stdout or "").strip().splitlines()[-1])
    except Exception as exc:
        raise RuntimeError(f"payment Sentinel worker returned invalid output: {type(exc).__name__}") from exc
    if process.returncode != 0:
        raise RuntimeError(f"payment Sentinel worker failed: {result.get('error') or process.returncode}")
    if not result.get("ok"):
        raise RuntimeError(f"payment Sentinel failed: {result.get('error') or 'unknown'}")
    token = result.get("sentinel_token")
    so = result.get("so_token")
    if use_sen and not token:
        raise RuntimeError("payment Sentinel token is missing")
    if use_so and not so:
        raise RuntimeError("payment Sentinel SO token is missing")
    headers: dict[str, str] = {}
    if use_sen:
        headers["OpenAI-Sentinel-Token"] = token if isinstance(token, str) else json.dumps(token, separators=(",", ":"))
    if use_so:
        headers["OpenAI-Sentinel-SO-Token"] = so if isinstance(so, str) else json.dumps(so, separators=(",", ":"))
    return headers


def _worker_main() -> int:
    if str(FREEPP_BACKEND) not in sys.path:
        sys.path.insert(0, str(FREEPP_BACKEND))
    from reg import sentinel_sdk

    try:
        request = json.load(sys.stdin)
        result = sentinel_sdk.sentinel_for(
            str(request.get("flow") or ""),
            str(request.get("proxy") or ""),
            str(request.get("did") or ""),
            request.get("fp") if isinstance(request.get("fp"), dict) else {},
        )
        sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")
        return 0 if result.get("ok") else 1
    except Exception as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}) + "\n")
        return 1


if __name__ == "__main__" and "--worker" in sys.argv:
    raise SystemExit(_worker_main())
