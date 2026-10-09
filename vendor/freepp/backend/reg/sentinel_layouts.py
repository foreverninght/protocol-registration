# -*- coding: utf-8 -*-
"""Sentinel SDK version and snapshot layout registry.

This module is intentionally free of network/VM dependencies. The protocol
report identified two confirmed snapshot layouts:

  * 21 fields, shipped by sdk.js 20260810913b (current default)
  * 18 fields, shipped by sdk.js 20260219f9f6 (legacy)

The production path must not infer the snapshot width from requestP[5] alone.
Instead it selects a profile, observes the decoded snapshot width, and then
compares selected_layout_id with actual_layout_id.
"""

from __future__ import annotations

from typing import Optional, Sequence

DEFAULT_SENTINEL_VERSION = "20260810913b"

SENTINEL_LAYOUT_18 = "sdk-20260219f9f6-18"
SENTINEL_LAYOUT_21 = "sdk-20260810913b-21"
UNKNOWN_LAYOUT_21 = "unknown-21"

SENTINEL_SDK_VERSIONS = {
    "20260219f9f6": {
        "layout_id": SENTINEL_LAYOUT_18,
        "width": 18,
        "status": "confirmed",
    },
    "20260810913b": {
        "layout_id": SENTINEL_LAYOUT_21,
        "width": 21,
        "status": "confirmed",
    },
}

SENTINEL_21_FIELDS = [
    "observation_duration",
    "valid_keydown_count",
    "untrusted_keydown_count",
    "backspace_ratio",
    "maximum_consecutive_backspaces",
    "key_interval_coefficient_of_variation",
    "paste_event_count",
    "untrusted_input_count",
    "wheel_event_count",
    "wheel_long_gap_count",
    "collector_clock_start",
    "snapshot_clock_end",
    "maximum_key_interval",
    "key_long_gap_count",
    "interaction_event_count",
    "untrusted_interaction_count",
    "click_latency_sum",
    "click_latency_sample_count",
    "pointer_speed_cv",
    "pointer_interval_cv",
    "pointer_curvature_ratio",
]

# The report only fixed the first two fields for 18-field snapshots. Keep this
# prefix intentionally short until an 18-field trace is imported as a fixture.
SENTINEL_18_FIELD_PREFIX = [
    "observation_duration",
    "valid_keydown_count",
]


def sentinel_sdk_url(version: str) -> str:
    return f"https://sentinel.openai.com/sentinel/{version}/sdk.js"


def layout_width_for_sdk_version(sdk_version: Optional[str]) -> Optional[int]:
    profile = SENTINEL_SDK_VERSIONS.get(sdk_version or "")
    return profile["width"] if profile else None


def selected_layout_id(sdk_version: Optional[str]) -> str:
    profile = SENTINEL_SDK_VERSIONS.get(sdk_version or "")
    if profile:
        return profile["layout_id"]
    return UNKNOWN_LAYOUT_21


def actual_layout_id(width: int, field_labels: Optional[Sequence[str]] = None) -> str:
    if width == 18:
        return SENTINEL_LAYOUT_18
    if width == 21:
        labels = list(field_labels or [])
        if len(labels) >= 3 and labels[2] == SENTINEL_21_FIELDS[2]:
            return SENTINEL_LAYOUT_21
        return UNKNOWN_LAYOUT_21
    return f"unknown-{width}"


def layout_matches(selected: str, actual: str) -> bool:
    return selected == actual
