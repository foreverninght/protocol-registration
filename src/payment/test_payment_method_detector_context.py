import unittest
from types import SimpleNamespace

from payment_method_detector import UniversalPaymentMethodProbe, browser_context_for_geo


class PaymentMethodDetectorContextTest(unittest.TestCase):
    def test_vietnam_context_accepts_timezone_object(self):
        self.assertEqual(
            browser_context_for_geo({
                "country": "VN",
                "timezone": {"id": "Asia/Ho_Chi_Minh", "offset": 25200},
            }),
            ("vi-VN", "Asia/Ho_Chi_Minh"),
        )

    def test_vietnam_context_accepts_legacy_timezone_string(self):
        self.assertEqual(
            browser_context_for_geo({
                "country": "VN",
                "timezone": "{'id': 'Asia/Ho_Chi_Minh', 'offset': 25200}",
            }),
            ("vi-VN", "Asia/Ho_Chi_Minh"),
        )

    def test_vietnam_context_has_consistent_fallback(self):
        self.assertEqual(
            browser_context_for_geo({"country": "VN"}),
            ("vi-VN", "Asia/Ho_Chi_Minh"),
        )

    def test_vietnam_context_rejects_adjacent_country_timezone(self):
        self.assertEqual(
            browser_context_for_geo({"country": "VN", "timezone": "Asia/Bangkok"}),
            ("vi-VN", "Asia/Ho_Chi_Minh"),
        )


class PaymentMethodProbeCheckoutContextTest(unittest.TestCase):
    def test_probe_uses_promotional_custom_checkout_context(self):
        captured = {}

        class Detector:
            def detect(self, context):
                captured["context"] = context
                return SimpleNamespace(
                    session_type="oaics",
                    session_id="oaics_test",
                    source="test",
                    methods=["card"],
                    to_dict=lambda: {"methods": ["card"]},
                )

        def build_checkout_payload(options, account):
            captured["options"] = dict(options)
            return {"checkout_ui_mode": "custom"}

        def create_checkout(*args, **kwargs):
            captured["kwargs"] = kwargs
            return {
                "data": {"checkout_session_id": "oaics_test", "processor_entity": "openai_ie"},
                "http": object(),
            }

        probe = UniversalPaymentMethodProbe(
            extract_access_token=lambda token: (token, {"email": "probe@example.com", "account_id": "acct"}),
            normalize_proxy=lambda proxy: proxy,
            inspect_proxy=lambda proxy: {"country": "VN", "timezone": "Asia/Ho_Chi_Minh"},
            normalize_currency=lambda country, currency: ("VND", "country"),
            build_billing=lambda *args, **kwargs: {"country": "VN"},
            build_checkout_payload=build_checkout_payload,
            create_checkout=create_checkout,
            detector=Detector(),
        )

        result = probe.probe("token", ["proxy"], max_proxy_attempts=1)
        self.assertTrue(result["ok"])
        self.assertEqual(captured["options"]["link_type"], "custom")
        self.assertTrue(captured["options"]["use_promo"])
        self.assertEqual(captured["options"]["promo_campaign"], "plus-1-month-free")
        self.assertTrue(captured["options"]["promo_from_query_param"])
        self.assertIn("promo_campaign=plus-1-month-free", captured["kwargs"]["frontend_page_url"])


if __name__ == "__main__":
    unittest.main()
