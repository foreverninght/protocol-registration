from __future__ import annotations

import json
import os
import sys
from pathlib import Path


PAY153_ROOT = Path(os.getenv("PAY153_RUNTIME_ROOT", str(Path(__file__).resolve().parents[2] / "optional" / "pay153"))).resolve()
if str(PAY153_ROOT) not in sys.path:
    sys.path.insert(0, str(PAY153_ROOT))
if str(Path(__file__).resolve().parent) not in sys.path:
    sys.path.insert(0, str(Path(__file__).resolve().parent))

import app as pay153  # noqa: E402
from payment_sentinel_adapter import payment_sentinel_headers  # noqa: E402
from payment_method_detector import (  # noqa: E402
    CheckoutPaymentMethodDetector,
    UniversalPaymentMethodProbe,
)

# The universal detector uses the same maintained Sentinel implementation as
# registration. Other pay153 flows keep their existing provider untouched.
pay153.sentinel_headers = payment_sentinel_headers


def build_probe() -> UniversalPaymentMethodProbe:
    detector = CheckoutPaymentMethodDetector(
        fetch_oaics_checkout=pay153.fetch_custom_checkout_session,
        extract_oaics_method_types=pay153.oaics_payment_method_types_from_state,
        extract_oaics_currency=pay153.custom_checkout_currency,
        extract_oaics_checkout_amount=pay153.custom_checkout_amount_minor,
    )
    return UniversalPaymentMethodProbe(
        extract_access_token=pay153.extract_access_token,
        normalize_proxy=pay153.normalize_proxy,
        inspect_proxy=pay153.proxy_geo_live,
        normalize_currency=pay153.normalize_checkout_currency,
        build_billing=pay153.default_billing,
        build_checkout_payload=pay153.checkout_payload,
        create_checkout=pay153.create_checkout,
        detector=detector,
    )


def main() -> int:
    try:
        request = json.load(sys.stdin)
        access_token = str(request.get("accessToken") or request.get("access_token") or "").strip()
        proxy_pool = request.get("proxyPool") or request.get("proxy_pool") or []
        if isinstance(proxy_pool, str):
            proxy_pool = [line.strip() for line in proxy_pool.splitlines() if line.strip()]
        if not isinstance(proxy_pool, list):
            raise ValueError("proxyPool must be an array or newline-delimited string")
        result = build_probe().probe(
            access_token,
            proxy_pool,
            max_proxy_attempts=int(request.get("maxProxyAttempts") or 1),
        )
        sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
        return 0
    except Exception as exc:
        sys.stdout.write(json.dumps({
            "ok": False,
            "error": {
                "type": type(exc).__name__,
                "message": str(exc)[:1200],
            },
        }, ensure_ascii=False, separators=(",", ":")) + "\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
