from __future__ import annotations

import json
import queue
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import urljoin, urlsplit


def run_public_sdk(session, *, sdk_file: Path, source_url: str, node: str,
                   device_id: str, flow: str, profile: dict, timeout_ms: int) -> dict[str, str]:
    bridge = Path(__file__).resolve().parent / "sentinel_assets" / "public_bridge.js"
    deadline = time.monotonic() + max(1, timeout_ms / 1000)
    messages = queue.Queue()
    proc = subprocess.Popen(
        [node, str(bridge)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, encoding="utf-8", bufsize=1,
    )

    def read_output():
        try:
            for line in proc.stdout:
                messages.put(line)
        finally:
            messages.put(None)

    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    challenges = {}
    request_count = 0
    pipe_error = None

    def send(value):
        nonlocal pipe_error
        try:
            proc.stdin.write(json.dumps(value, ensure_ascii=True) + "\n")
            proc.stdin.flush()
        except OSError as exc:
            pipe_error = exc
            return False
        return True

    try:
        if send({"sdk_file": str(sdk_file), "sdk_url": source_url, "device_id": device_id,
                 "flow": flow, "profile": profile}) is False:
            raise RuntimeError("Sentinel bridge closed before initialization")
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RuntimeError("Sentinel SDK timed out")
            try:
                line = messages.get(timeout=remaining)
            except queue.Empty as exc:
                raise RuntimeError("Sentinel SDK timed out") from exc
            if line is None:
                raise RuntimeError("Sentinel SDK process exited without a result") from pipe_error
            message = json.loads(line)
            kind = message.get("kind")
            if kind == "error":
                raise RuntimeError("Sentinel public SDK failed: " + str(message.get("message", "unknown"))[:200])
            if kind == "fetch":
                if pipe_error is not None:
                    raise RuntimeError("Sentinel bridge closed before completing HTTP requests") from pipe_error
                request_count += 1
                url = urljoin("https://sentinel.openai.com/", str(message.get("url", "")))
                parsed = urlsplit(url)
                if (request_count > 4 or parsed.scheme != "https"
                        or parsed.netloc not in {"sentinel.openai.com", "chatgpt.com"}
                        or parsed.path != "/backend-api/sentinel/req"
                        or str(message.get("method", "")).upper() != "POST"):
                    raise RuntimeError(f"Unexpected Sentinel SDK HTTP request: {parsed.hostname}{parsed.path} method={message.get('method')} count={request_count}")
                body = str(message.get("body", ""))
                request = json.loads(body)
                if request.get("id") != device_id or request.get("flow") != flow:
                    raise RuntimeError("Sentinel SDK request context mismatch")
                response = session.post(
                    url, data=body, allow_redirects=False, timeout=max(0.1, deadline - time.monotonic()),
                    headers={
                        "origin": f"https://{parsed.netloc}",
                        "referer": f"https://{parsed.netloc}/backend-api/sentinel/frame.html?sv=" + source_url.split("/")[-2],
                        "content-type": "text/plain;charset=UTF-8", "accept": "*/*",
                    },
                )
                if response.status_code != 200:
                    raise RuntimeError(f"Sentinel challenge HTTP {response.status_code}")
                challenge = response.json()
                if not isinstance(challenge, dict) or not challenge.get("token"):
                    raise RuntimeError("Sentinel challenge missing token")
                challenge_id = challenge["token"]
                if not isinstance(challenge_id, str):
                    raise RuntimeError("Sentinel challenge token must be a string")
                if challenge_id in challenges and challenges[challenge_id] != challenge:
                    raise RuntimeError("Sentinel challenge ID was reused with different requirements")
                challenges[challenge_id] = challenge
                send({"id": message["id"], "status": response.status_code,
                      "headers": {}, "body": json.dumps(challenge)})
                continue
            if kind != "result":
                raise RuntimeError("Unexpected Sentinel bridge output")
            token = str(message.get("token") or "")
            so_token = str(message.get("so_token") or "")
            envelope = json.loads(token)
            if not isinstance(envelope, dict) or envelope.get("e"):
                raise RuntimeError("Sentinel SDK returned an incomplete token")
            challenge_id = envelope.get("c")
            challenge = challenges.get(challenge_id) if isinstance(challenge_id, str) else None
            if challenge is None:
                raise RuntimeError("Sentinel SDK token references an unknown challenge")
            for key, expected in (("id", device_id), ("flow", flow), ("c", challenge["token"])):
                if envelope.get(key) != expected:
                    raise RuntimeError("Sentinel SDK token context mismatch")
            if (challenge.get("proofofwork") or {}).get("required") and not envelope.get("p"):
                raise RuntimeError("Sentinel SDK missing required proof")
            if (challenge.get("turnstile") or {}).get("required") and not envelope.get("t"):
                raise RuntimeError("Sentinel SDK missing required t")
            if (challenge.get("so") or {}).get("required") and not so_token:
                raise RuntimeError("Sentinel SDK missing required observer token")
            if so_token:
                observer = json.loads(so_token)
                if not isinstance(observer, dict) or not observer.get("so"):
                    raise RuntimeError("Sentinel SDK observer token is incomplete")
                for key, expected in (("id", device_id), ("flow", flow), ("c", challenge["token"])):
                    if observer.get(key) != expected:
                        raise RuntimeError("Sentinel SDK observer context mismatch")
            return {"token": token, "so_token": so_token}
    finally:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=5)
        reader.join(timeout=5)
        try:
            proc.stdin.close()
        except OSError:
            pass
        proc.stdout.close()
