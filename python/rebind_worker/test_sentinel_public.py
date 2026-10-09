import json
import os
import shutil
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from registration_core import sentinel_quickjs as runtime


@unittest.skipUnless(shutil.which("node"), "Node required")
class PublicSdkTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {key: "" for key in (
            "OPENAI_SENTINEL_SDK_URL", "OPENAI_SENTINEL_VERSION",
            "OPENAI_SENTINEL_SDK_FILE", "OPENAI_SENTINEL_SDK_SHA256")})
        env.start()
        self.addCleanup(env.stop)
        self.session = Mock()
        self.challenge = {"token": "fixture-challenge",
            "proofofwork": {"required": False}, "turnstile": {"required": False},
            "so": {"required": False}}
        self.session.post.return_value = Mock(status_code=200)
        self.session.post.return_value.json.return_value = self.challenge

    def run_sdk(self, timeout_ms=15000):
        return runtime.get_sentinel_token_bundle_via_quickjs(
            self.session, "fixture-device", flow="password_verify", timeout_ms=timeout_ms)

    def test_real_bundled_sdk_without_optional_challenges(self):
        result = self.run_sdk()
        envelope = json.loads(result["token"])
        self.assertEqual(envelope["c"], "fixture-challenge")
        self.assertEqual(envelope["id"], "fixture-device")
        self.assertEqual(envelope["flow"], "password_verify")
        self.assertEqual(result["so_token"], "")
        self.session.get.assert_not_called()
        self.assertGreaterEqual(self.session.post.call_count, 1)
        for call in self.session.post.call_args_list:
            self.assertEqual(call.args[0], "https://chatgpt.com/backend-api/sentinel/req")
            self.assertFalse(call.kwargs["allow_redirects"])
            body = json.loads(call.kwargs["data"])
            self.assertEqual(body["id"], "fixture-device")
            self.assertEqual(body["flow"], "password_verify")
            self.assertTrue(body["p"])

    def test_real_sdk_with_easy_proof_challenge(self):
        self.challenge["proofofwork"] = {"required": True, "seed": "fixture-seed", "difficulty": "ffffff"}
        result = self.run_sdk()
        self.assertTrue(json.loads(result["token"])["p"])

    def test_prefetch_does_not_replace_current_challenge(self):
        def respond(*args, **kwargs):
            index = self.session.post.call_count
            challenge = dict(self.challenge, token=f"fixture-{index}")
            if index > 1:
                challenge["so"] = {"required": True}
            response = Mock(status_code=200)
            response.json.return_value = challenge
            return response

        self.session.post.side_effect = respond
        result = self.run_sdk()
        self.assertGreaterEqual(self.session.post.call_count, 2)
        self.assertEqual(json.loads(result["token"])["c"], "fixture-1")
        self.assertEqual(result["so_token"], "")

    def test_delayed_prefetch_preserves_final_result(self):
        def respond(*args, **kwargs):
            index = self.session.post.call_count
            if index == 2:
                time.sleep(6)
            response = Mock(status_code=200)
            response.json.return_value = dict(self.challenge, token=f"delayed-{index}")
            return response

        self.session.post.side_effect = respond
        result = self.run_sdk(timeout_ms=18000)
        self.assertEqual(json.loads(result["token"])["c"], "delayed-1")
        self.assertEqual(self.session.post.call_count, 2)

    def test_rate_limit_stops_without_retry(self):
        self.session.post.return_value.status_code = 429
        with self.assertRaisesRegex(RuntimeError, "HTTP 429"):
            self.run_sdk()
        self.assertEqual(self.session.post.call_count, 1)

    def test_required_observer_is_not_silently_omitted(self):
        self.challenge["so"] = {"required": True}
        with self.assertRaisesRegex(RuntimeError, "required observer"):
            self.run_sdk()

    def test_timeout_cleans_up_blocked_sdk(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "sdk.js"
            path.write_text("var SentinelSDK={init:()=>new Promise(()=>{}),token:()=>null,sessionObserverToken:()=>null};", encoding="utf-8")
            os.environ["OPENAI_SENTINEL_SDK_FILE"] = str(path)
            with self.assertRaisesRegex(RuntimeError, "timed out"):
                self.run_sdk(timeout_ms=1000)


if __name__ == "__main__":
    unittest.main()
