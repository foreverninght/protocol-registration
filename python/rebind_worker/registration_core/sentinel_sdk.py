from __future__ import annotations

import hashlib
import os
import re
from urllib.parse import urlparse

BUNDLED_VERSION = "20260810913b"
BUNDLED_SHA256 = "97bc85bf6072d10329ff68c373aac488984450f8fe971f58265953a74eeb71c3"


def sdk_url() -> str:
    url = os.getenv("OPENAI_SENTINEL_SDK_URL", "").strip()
    version = os.getenv("OPENAI_SENTINEL_VERSION", "").strip()
    if not url and not version:
        version = BUNDLED_VERSION
    if not url and version:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", version):
            raise RuntimeError("Invalid OPENAI_SENTINEL_VERSION")
        url = f"https://sentinel.openai.com/sentinel/{version}/sdk.js"
    parsed = urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.netloc != "sentinel.openai.com"
        or not re.fullmatch(r"/sentinel/[A-Za-z0-9_-]+/sdk\.js", parsed.path)
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError(
            "Set OPENAI_SENTINEL_SDK_URL to a verified versioned official SDK URL "
            "or set OPENAI_SENTINEL_VERSION; the bundled old SDK version was removed"
        )
    if version and parsed.path.split("/")[2] != version:
        raise RuntimeError("OPENAI_SENTINEL_SDK_URL and OPENAI_SENTINEL_VERSION disagree")
    return url


def sdk_version(url: str) -> str:
    return urlparse(url).path.split("/")[2]


def validate_sdk(content: bytes) -> str:
    text = content.decode("utf-8-sig").lstrip()
    if not text or text.startswith(("<", "{")) or "SentinelSDK" not in text:
        raise RuntimeError("SDK response is not recognizable Sentinel JavaScript")
    digest = hashlib.sha256(content).hexdigest()
    expected = os.getenv("OPENAI_SENTINEL_SDK_SHA256", "").strip().lower()
    if expected and not re.fullmatch(r"[0-9a-f]{64}", expected):
        raise RuntimeError("OPENAI_SENTINEL_SDK_SHA256 must contain 64 hex characters")
    if expected and digest != expected:
        raise RuntimeError("Sentinel SDK SHA256 mismatch")
    return digest
