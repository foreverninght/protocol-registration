from __future__ import annotations

import time
import uuid
import ast
from dataclasses import asdict, dataclass, field
from typing import Any, Callable

import stripe_checkout as sc


COUNTRY_BROWSER_CONTEXT = {
    "GB": ("en-GB", "Europe/London"),
    "US": ("en-US", "America/New_York"),
    "JP": ("ja-JP", "Asia/Tokyo"),
    "SG": ("en-SG", "Asia/Singapore"),
    "VN": ("vi-VN", "Asia/Ho_Chi_Minh"),
    "PH": ("en-PH", "Asia/Manila"),
    "ID": ("id-ID", "Asia/Jakarta"),
    "IN": ("en-IN", "Asia/Kolkata"),
}


def browser_context_for_geo(geo: dict[str, Any]) -> tuple[str, str]:
    country = str(geo.get("country") or "").strip().upper()
    locale, fallback_timezone = COUNTRY_BROWSER_CONTEXT.get(country, ("en-US", "UTC"))
    if country == "VN":
        return locale, fallback_timezone
    raw_timezone = geo.get("timezone")
    if isinstance(raw_timezone, dict):
        timezone = str(raw_timezone.get("id") or "").strip()
    else:
        timezone = str(raw_timezone or "").strip()
        if timezone.startswith("{"):
            try:
                parsed = ast.literal_eval(timezone)
                timezone = str(parsed.get("id") or "").strip() if isinstance(parsed, dict) else ""
            except (SyntaxError, ValueError):
                timezone = ""
    timezone = timezone or fallback_timezone
    return locale, timezone


@dataclass(slots=True)
class PaymentMethodDetection:
    """Normalized payment-method information from any Checkout implementation."""

    session_type: str
    session_id: str
    source: str
    methods: list[str]
    processor_entity: str = ""
    currency: str = ""
    checkout_amount: Any = None
    custom_method_id: str = ""
    stripe_version: str = ""
    stripe_hosted_url: str = ""
    duration_ms: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class CheckoutDetectionContext:
    """Protocol context required to inspect one already-created Checkout."""

    session_id: str
    token: str = ""
    processor_entity: str = ""
    checkout_http: Any = None
    checkout_proxy: str = ""
    device_id: str = ""
    checkout_data: dict[str, Any] = field(default_factory=dict)
    country: str = "US"
    currency: str = ""


def normalize_oaics_methods(methods: Any) -> tuple[list[str], str]:
    """Convert OAICS custom methods into a provider-neutral method list."""
    if not isinstance(methods, list):
        return [], ""

    normalized: list[str] = []
    custom_method_id = ""
    seen: set[str] = set()
    for item in methods:
        if not isinstance(item, dict):
            continue
        method_id = str(item.get("id") or "").strip()
        method_type = str(
            item.get("type")
            or item.get("paymentMethodType")
            or item.get("payment_method_type")
            or item.get("name")
            or item.get("display_name")
            or item.get("label")
            or ""
        ).strip().lower()

        if method_id.startswith("cpmt_") and not custom_method_id:
            custom_method_id = method_id
        if method_type and method_type not in seen:
            seen.add(method_type)
            normalized.append(method_type)
    return normalized, custom_method_id


def oaics_currency(state: Any) -> str:
    return str(state.get("currency") or "") if isinstance(state, dict) else ""


def oaics_checkout_amount(state: Any) -> Any:
    if not isinstance(state, dict):
        return None
    return state.get("checkout_amount", state.get("amount"))


def identity_proxy(value: str) -> str:
    return str(value or "").strip()


class CheckoutPaymentMethodDetector:
    """Generic two-engine detector for OAICS and Stripe Checkout sessions.

    The detector knows nothing about business profiles, countries, proxies,
    retry policies, or whether a specific payment method should be considered
    successful. Its only job is to normalize the methods exposed by a Checkout.
    """

    def __init__(
        self,
        *,
        fetch_oaics_checkout: Callable[..., dict[str, Any]],
        extract_oaics_method_types: Callable[[Any], list[str]],
        normalize_oaics_method_list: Callable[[Any], tuple[list[str], str]] = normalize_oaics_methods,
        extract_oaics_currency: Callable[[Any], str] = oaics_currency,
        extract_oaics_checkout_amount: Callable[[Any], Any] = oaics_checkout_amount,
    ):
        self.fetch_oaics_checkout = fetch_oaics_checkout
        self.extract_oaics_method_types = extract_oaics_method_types
        self.normalize_oaics_method_list = normalize_oaics_method_list
        self.extract_oaics_currency = extract_oaics_currency
        self.extract_oaics_checkout_amount = extract_oaics_checkout_amount

    @staticmethod
    def session_type(session_id: str) -> str:
        value = str(session_id or "").strip()
        if value.startswith("oaics_"):
            return "oaics"
        if value.startswith("cs_live_"):
            return "cslive"
        if value.startswith("cs_test_"):
            return "cstest"
        if not value:
            raise ValueError("Checkout session_id 为空")
        raise ValueError(f"不支持的 Checkout session 类型：{value[:16]}")

    def detect(self, context: CheckoutDetectionContext) -> PaymentMethodDetection:
        kind = self.session_type(context.session_id)
        if kind == "oaics":
            return self._detect_oaics(
                session_id=context.session_id,
                token=context.token,
                processor_entity=context.processor_entity,
                checkout_http=context.checkout_http,
                device_id=context.device_id,
                currency=context.currency,
            )
        result = self._detect_stripe(
            session_id=context.session_id,
            checkout_proxy=context.checkout_proxy,
            checkout_data=context.checkout_data,
            country=context.country,
            currency=context.currency,
        )
        result.session_type = kind
        return result

    def _detect_oaics(
        self,
        *,
        session_id: str,
        token: str,
        processor_entity: str,
        checkout_http: Any,
        device_id: str,
        currency: str,
    ) -> PaymentMethodDetection:
        started = time.time()
        state = self.fetch_oaics_checkout(
            checkout_http,
            token,
            session_id,
            processor_entity,
            device_id,
        )
        methods, custom_method_id = self.normalize_oaics_method_list(state.get("custom_payment_methods"))
        for method in self.extract_oaics_method_types(state):
            normalized = str(method or "").strip().lower()
            if normalized and normalized not in methods:
                methods.append(normalized)
        return PaymentMethodDetection(
            session_type="oaics",
            session_id=session_id,
            source="oaics.custom_payment_methods",
            methods=methods,
            processor_entity=processor_entity,
            currency=str(self.extract_oaics_currency(state) or currency).upper(),
            checkout_amount=self.extract_oaics_checkout_amount(state),
            custom_method_id=custom_method_id,
            duration_ms=int((time.time() - started) * 1000),
        )

    @staticmethod
    def _detect_stripe(
        *,
        session_id: str,
        checkout_proxy: str,
        checkout_data: dict[str, Any],
        country: str,
        currency: str,
    ) -> PaymentMethodDetection:
        started = time.time()
        stripe_http = sc.build_http(checkout_proxy, impersonate="chrome145")
        stripe_profile = sc._profile(str(country or "US").upper())
        publishable_key = str(checkout_data.get("publishable_key") or "") or sc.verify_pk(
            stripe_http,
            session_id,
            lambda _message: None,
        )
        init_data, stripe_version, context = sc.init_checkout(
            stripe_http,
            session_id,
            publishable_key,
            stripe_profile,
            lambda _message: None,
        )
        methods = [
            str(method).strip().lower()
            for method in (context.get("payment_method_types") or [])
            if str(method or "").strip()
        ]
        processor_entity = str(
            checkout_data.get("processor_entity")
            or sc._entity_from_return_url(context.get("return_url") or init_data.get("return_url") or "")
            or ""
        )
        return PaymentMethodDetection(
            session_type="cslive",
            session_id=session_id,
            source="stripe.payment_method_types",
            methods=list(dict.fromkeys(methods)),
            processor_entity=processor_entity,
            currency=str(context.get("currency") or currency).upper(),
            checkout_amount=context.get("checkout_amount"),
            stripe_version=stripe_version,
            stripe_hosted_url=str(context.get("stripe_hosted_url") or ""),
            duration_ms=int((time.time() - started) * 1000),
        )


class UniversalPaymentMethodProbe:
    """Build and inspect a geo-aligned Checkout from only AT + proxy pool.

    Business payment profiles are intentionally absent. The selected proxy
    determines country, currency, and billing; the returned session ID then
    selects the OAICS or Stripe inspection engine.
    """

    def __init__(
        self,
        *,
        extract_access_token: Callable[[str], tuple[str, dict[str, Any]]],
        normalize_proxy: Callable[[str], str] = identity_proxy,
        inspect_proxy: Callable[[str], dict[str, str]],
        normalize_currency: Callable[[str, str], tuple[str, str]],
        build_billing: Callable[..., dict[str, Any]],
        build_checkout_payload: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
        create_checkout: Callable[..., dict[str, Any]],
        detector: CheckoutPaymentMethodDetector,
    ):
        self.extract_access_token = extract_access_token
        self.normalize_proxy = normalize_proxy
        self.inspect_proxy = inspect_proxy
        self.normalize_currency = normalize_currency
        self.build_billing = build_billing
        self.build_checkout_payload = build_checkout_payload
        self.create_checkout = create_checkout
        self.detector = detector

    def probe(
        self,
        access_token: str,
        proxy_pool: list[str],
        *,
        max_proxy_attempts: int = 3,
    ) -> dict[str, Any]:
        """Detect methods with only an AT and proxy pool as runtime input."""
        token, account = self.extract_access_token(access_token)
        proxies = [self.normalize_proxy(proxy) for proxy in proxy_pool if str(proxy or "").strip()]
        proxies = [proxy for proxy in proxies if proxy]
        if not proxies:
            raise ValueError("代理池至少需要 1 条代理")
        attempt_limit = min(len(proxies), max(1, int(max_proxy_attempts or 1)), 10)
        errors: list[str] = []

        for index, proxy in enumerate(proxies[:attempt_limit], start=1):
            try:
                geo = dict(self.inspect_proxy(proxy) or {})
                country = str(geo.get("country") or "").strip().upper()
                if len(country) != 2:
                    raise RuntimeError("代理出口国家未识别")
                currency, currency_source = self.normalize_currency(
                    country,
                    str(geo.get("currency") or ""),
                )
                currency = str(currency or "").upper()
                billing = self.build_billing(
                    country,
                    str(account.get("email") or ""),
                    geo=geo,
                    real_random=False,
                )
                options = {
                    "plan": "plus",
                    "link_type": "custom",
                    "country": country,
                    "checkout_country": country,
                    "currency": currency,
                    "checkout_currency": currency,
                    "use_promo": True,
                    "promo_campaign": "plus-1-month-free",
                    "promo_from_query_param": True,
                }
                payload = self.build_checkout_payload(options, account)
                locale, timezone = browser_context_for_geo(geo)
                geo["timezone"] = timezone
                device_id = str(uuid.uuid4())
                did = device_id
                created = self.create_checkout(
                    token,
                    payload,
                    proxy,
                    device_id,
                    did,
                    lambda _message: None,
                    use_sen=True,
                    use_so=True,
                    diagnostic_job_id="",
                    oaics_warmup=False,
                    frontend_page_url="https://chatgpt.com/?promo_campaign=plus-1-month-free",
                    frontend_locale=locale,
                    frontend_timezone=timezone,
                    account_id=str(account.get("account_id") or ""),
                    user_agent=sc.CHROME_UA,
                    impersonate="chrome145",
                )
                checkout_data = dict(created.get("data") or {})
                session_id = str(checkout_data.get("checkout_session_id") or "").strip()
                processor = str(checkout_data.get("processor_entity") or "").strip() or (
                    "openai_llc" if country == "US" else "openai_ie"
                )
                detection = self.detector.detect(CheckoutDetectionContext(
                    session_id=session_id,
                    token=token,
                    processor_entity=processor,
                    checkout_http=created.get("http"),
                    checkout_proxy=proxy,
                    device_id=device_id,
                    checkout_data=checkout_data,
                    country=country,
                    currency=currency,
                ))
                return {
                    "ok": True,
                    "account_email": str(account.get("email") or ""),
                    "account_id_suffix": str(account.get("account_id") or "")[-8:],
                    "proxy_index": index,
                    "proxy_geo": geo,
                    "checkout_config": {
                        "country": country,
                        "currency": currency,
                        "currency_source": currency_source,
                        "billing": billing,
                    },
                    "session_type": detection.session_type,
                    "checkout_type": detection.session_type,
                    "session_id": detection.session_id,
                    "source": detection.source,
                    "methods": detection.methods,
                    "detection": detection.to_dict(),
                }
            except Exception as exc:
                errors.append(f"代理#{index} {type(exc).__name__}: {str(exc)[:240]}")

        raise RuntimeError("代理池检测失败：" + " / ".join(errors[-attempt_limit:]))
