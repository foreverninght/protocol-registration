"""Load the bundled SDK and execute its public API through a shared-session bridge.

The historical module name is retained for existing imports.
"""
from __future__ import annotations

import logging
import os
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from .sentinel_sdk import BUNDLED_SHA256, BUNDLED_VERSION, sdk_url, sdk_version, validate_sdk

logger = logging.getLogger(__name__)


_SDK_CACHE_LOCK = threading.Lock()


def _node_action_slot_count() -> int:
    try:
        configured = int(os.getenv("REGISTRATION_SENTINEL_NODE_CONCURRENCY", "4"))
    except ValueError:
        configured = 4
    return max(1, min(16, configured))


_NODE_ACTION_SLOTS = threading.BoundedSemaphore(_node_action_slot_count())


def _resolve_node_binary() -> str:
    return (os.getenv("OPENAI_SENTINEL_NODE_PATH", "") or "").strip() or "node"


def _ensure_sdk_file(session: Any, timeout_ms: int, *, source_url: str = "") -> Path:
    source_url = source_url or sdk_url()
    local_file = os.getenv("OPENAI_SENTINEL_SDK_FILE", "").strip()
    if local_file:
        path = Path(local_file).expanduser().resolve()
        validate_sdk(path.read_bytes())
        return path
    if sdk_version(source_url) == BUNDLED_VERSION:
        path = Path(__file__).resolve().parent / "sentinel_assets" / f"sdk_{BUNDLED_VERSION}.js"
        if validate_sdk(path.read_bytes()) != BUNDLED_SHA256:
            raise RuntimeError("Bundled Sentinel SDK checksum mismatch")
        return path
    raise RuntimeError("Only bundled read-only SDK is supported")


def _sentinel_profile_payload(browser_profile: Optional[dict[str, Any]]) -> dict[str, Any]:
    profile = browser_profile if isinstance(browser_profile, dict) else {}
    languages = profile.get("languages")
    if not isinstance(languages, list):
        accept = str(profile.get("accept_language") or "en-US,en;q=0.9")
        languages = [p.split(";")[0].strip() for p in accept.split(",") if p.split(";")[0].strip()]
    return {
        "profile_id": profile.get("profile_id") or "",
        "profile_seed": profile.get("seed") or "",
        "user_agent": profile.get("user_agent") or "Mozilla/5.0",
        "language": profile.get("language") or (languages[0] if languages else "en-US"),
        "languages": languages or ["en-US", "en"],
        "navigator_platform": profile.get("navigator_platform") or "Win32",
        "screen_width": profile.get("screen_width") or 1920,
        "screen_height": profile.get("screen_height") or 1080,
        "hardware_concurrency": profile.get("hardware_concurrency") or 8,
        "device_memory": profile.get("device_memory") or 8,
        "timezone": profile.get("timezone") or "Asia/Tokyo",
        "webgl_vendor": profile.get("webgl_vendor") or "",
        "webgl_renderer": profile.get("webgl_renderer") or "",
    }


def get_sentinel_token_bundle_via_quickjs(
    session: Any,
    device_id: str,
    *,
    flow: str = "authorize_continue",
    timeout_ms: int = 45000,
    browser_profile: Optional[dict[str, Any]] = None,
    log: Optional[Callable[[str], None]] = None,
) -> Optional[dict[str, str]]:
    from .sentinel_public import run_public_sdk

    source_url = sdk_url()
    sdk_file = _ensure_sdk_file(session, timeout_ms, source_url=source_url)
    with _NODE_ACTION_SLOTS:
        return run_public_sdk(
            session, sdk_file=sdk_file, source_url=source_url, node=_resolve_node_binary(),
            device_id=str(device_id or uuid.uuid4()), flow=flow,
            profile=_sentinel_profile_payload(browser_profile), timeout_ms=timeout_ms,
        )


def get_sentinel_token_via_quickjs(
    session: Any,
    device_id: str,
    *,
    flow: str = "authorize_continue",
    timeout_ms: int = 45000,
    browser_profile: Optional[dict[str, Any]] = None,
    log: Optional[Callable[[str], None]] = None,
) -> Optional[str]:
    """Backward-compatible helper: return only the openai-sentinel-token."""
    bundle = get_sentinel_token_bundle_via_quickjs(
        session,
        device_id,
        flow=flow,
        timeout_ms=timeout_ms,
        browser_profile=browser_profile,
        log=log,
    )
    if not bundle:
        return None
    return bundle.get("token") or None
