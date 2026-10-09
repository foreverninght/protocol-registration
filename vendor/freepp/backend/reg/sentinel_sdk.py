# -*- coding: utf-8 -*-
"""
sentinel_sdk.py — 生成 OpenAI 注册所需的 OpenAI-Sentinel-Token / SO-Token。

修复指南（第 4-8 点）对齐：
  4. 不手写拼接 token，加载官方 Sentinel SDK 内部逻辑
  5. so-token 来自 /req 的 so 字段，生成方式类似 PoW，在 SDK 内
  6. observer 等待 5000ms（官方 sdk.js 常量 Xn=5e3）
  7. create_account 前先 /req，flow=oauth_create_account
  8. 从 requirements 生成 sentinel token + so-token

策略（按新 SDK 20260810913b 迭代）：
  - 是否需要 so 由本次 /req challenge 的 so.required 决定，不写死 flow 表：
      email_otp_validate / oauth_create_account / authorize_continue → 带 so
      username_password_create / password_verify → 不带 so
  - t 与 so 统一由 reg.sentinel_vm（依官方 20260810913b sdk.js 重建的 obt VM）
    在纯 Python 内解算；OPENAI_SENTINEL_MODE=browser|node|auto 可改。

日志只记长度/模式/是否含 p、t、so，绝不打印 token 明文。
"""
import os
import json
import time
import uuid
import random
import base64
import hashlib
import urllib.parse
import threading
import re
from typing import Optional, Dict, Any

# 用带重试的 curl_cffi Session 垫片
try:
    from .cf_shim import requests, Session
except Exception:
    import curl_cffi.requests as requests
    from curl_cffi.requests import Session

SENTINEL_REQ_URL = "https://sentinel.openai.com/backend-api/sentinel/req"
SENTINEL_VERSION = "20260810913b"
# 官方 sdk.js 常量 Xn=5e3
OBSERVER_WAIT_MS = 5000
# 观察窗墙钟时长（ms）。真实 so 的 pos0 = collector->snapshot 时长，
# HAR 实测 15210.9 / 23693.7；None 表示由 VM 在真实区间内抽样。
OBSERVER_SPAN_MS: Optional[float] = None
IMPERSONATE = "chrome131"

# 最近一次 /req 失败原因（供 pure-vm 错误备注；不打印 token 明文）
_REQ_STATE = threading.local()


def _set_req_error(value: Optional[str]) -> None:
    _REQ_STATE.error = value


def _get_req_error() -> Optional[str]:
    return getattr(_REQ_STATE, "error", None)


def _short_hash(value: Any) -> Optional[str]:
    if value is None:
        return None
    return hashlib.sha256(
        str(value).encode("utf-8", errors="replace")
    ).hexdigest()[:12]


def _proxy_id(proxy) -> str:
    if isinstance(proxy, dict):
        proxy = proxy.get("https") or proxy.get("http")
    if not proxy:
        endpoint = "direct"
    else:
        raw = str(proxy).strip()
        parsed = urllib.parse.urlsplit(raw if "://" in raw else f"http://{raw}")
        endpoint = parsed.hostname or "unknown"
        if parsed.port:
            endpoint = f"{endpoint}:{parsed.port}"
    return _short_hash(endpoint) or "unknown"


def _redact_error(value: Any) -> str:
    text = str(value)
    text = re.sub(
        r"([a-zA-Z][a-zA-Z0-9+.-]*://)[^/\s@]+@", r"\1***@", text
    )
    text = re.sub(
        r"(?i)(authorization\s*[:=]\s*)(?:bearer\s+)?[^,;\s]+",
        r"\1***", text,
    )
    return re.sub(
        r"(?i)([?&](?:token|key|secret|password)=)[^&\s]+", r"\1***", text
    )


def _request_p_slot_count(request_p: str) -> Optional[int]:
    try:
        raw = str(request_p)
        if not raw.startswith("gAAAAAC") or not raw.endswith("~S"):
            return None
        slots = json.loads(base64.b64decode(raw[7:-2], validate=True))
        return len(slots) if isinstance(slots, list) else None
    except Exception:
        return None


def _is_711_like_proxy(url: Optional[str]) -> bool:
    """711 住宅 / 本机 711 中继不可用于 sentinel.openai.com（出口被 CF 或 CONNECT 不稳）。"""
    if not url:
        return False
    low = str(url).lower()
    if "711proxy" in low or "rotgb" in low:
        return True
    if "127.0.0.1:18792" in low or "localhost:18792" in low:
        return True
    try:
        from core import proxy_711 as _p711
        if _p711.is_711_proxy(url):
            return True
    except Exception:
        pass
    return False


def _sentinel_egress_candidates(explicit_proxies=None) -> list:
    """sentinel /req 出口候选（按优先级）。

    显式代理存在时只返回该出口，确保 /req 与注册业务请求同源。
    未显式传入时才依次探测环境变量、本机 Clash 和直连。
    """
    import socket

    seen = set()
    out = []

    def _add(px, allow_711=False):
        if px is None:
            key = "__direct__"
            if key not in seen:
                seen.add(key)
                out.append(None)
            return
        if isinstance(px, dict):
            u = (px.get("https") or px.get("http") or "").strip()
        else:
            u = str(px).strip()
        if not u or (_is_711_like_proxy(u) and not allow_711):
            return
        key = u.lower()
        if key in seen:
            return
        seen.add(key)
        out.append({"http": u, "https": u})

    # 显式注册代理是严格边界：Sentinel 与业务请求必须走同一出口。
    if explicit_proxies:
        _add(explicit_proxies, allow_711=True)
        return out

    # 无显式代理时才允许环境探测。
    for k in (
        "HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy",
        "ALL_PROXY", "all_proxy",
    ):
        v = (os.environ.get(k) or "").strip()
        if v:
            _add(v)

    # 3) 探测本机 Clash mixed-port
    for item in ("127.0.0.1:7897", "127.0.0.1:17897", "127.0.0.1:7890", "127.0.0.1:10809"):
        host, port_s = item.rsplit(":", 1)
        try:
            sock = socket.create_connection((host, int(port_s)), timeout=0.5)
            sock.close()
            _add(f"http://{item}")
        except OSError:
            continue

    # 4) 真直连兜底（境外 VPS 等可直连场景）
    _add(None)
    return out if out else [None]


# ---------------------------------------------------------------------------
# 客户端 Proof-of-Work 生成器（纯 Python，用于 /req body 的 p 与信封 p）
# ---------------------------------------------------------------------------

class SentinelTokenGenerator:
    MAX_ATTEMPTS = 500000
    ERROR_PREFIX = "wQ8Lk5FbGpA2NcR9dShT6gYjU7VxZ4D"

    def __init__(
        self,
        device_id=None,
        user_agent=None,
        screen=None,
        languages=None,
        hardware_concurrency=None,
        timezone_name=None,
    ):
        self.device_id = device_id or str(uuid.uuid4())
        self.user_agent = user_agent or (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        )
        self.screen = screen or "1920x1080"
        if languages is None:
            self.languages = ("en-US", "en")
        elif isinstance(languages, (list, tuple)):
            self.languages = tuple(languages)
        else:
            self.languages = (str(languages),)
        self.hardware_concurrency = int(hardware_concurrency or 8)
        self.timezone_name = timezone_name or "America/New_York"
        self.requirements_seed = str(random.random())
        self.sid = str(uuid.uuid4())

    @staticmethod
    def _fnv1a_32(text):
        h = 2166136261
        for ch in text:
            h ^= ord(ch)
            h = (h * 16777619) & 0xFFFFFFFF
        h ^= h >> 16
        h = (h * 2246822507) & 0xFFFFFFFF
        h ^= h >> 13
        h = (h * 3266489909) & 0xFFFFFFFF
        h ^= h >> 16
        return format(h & 0xFFFFFFFF, "08x")

    def _get_config(self):
        from datetime import datetime
        from zoneinfo import ZoneInfo
        try:
            now = datetime.now(ZoneInfo(self.timezone_name))
        except Exception:
            now = datetime.now(ZoneInfo("UTC"))
        offset = now.strftime("%z") or "+0000"
        zone_label = now.tzname() or self.timezone_name
        date_str = now.strftime(
            f"%a %b %d %Y %H:%M:%S GMT{offset} ({zone_label})"
        )
        perf_now = random.uniform(1000, 50000)
        time_origin = time.time() * 1000 - perf_now
        nav_prop = random.choice(
            [
                "vendorSub", "productSub", "vendor", "maxTouchPoints",
                "scheduling", "userActivation", "doNotTrack", "geolocation",
                "connection", "plugins", "mimeTypes", "pdfViewerEnabled",
                "webkitTemporaryStorage", "webkitPersistentStorage",
                "hardwareConcurrency", "cookieEnabled", "credentials",
                "mediaDevices", "permissions", "locks", "ink",
            ]
        )
        lang0 = self.languages[0] if self.languages else "en-US"
        lang_joined = ",".join(self.languages) if self.languages else "en-US,en"
        screen_num = 3000
        try:
            width, height = str(self.screen).lower().split("x", 1)
            screen_num = int(float(width)) + int(float(height))
        except (TypeError, ValueError):
            pass
        return [
            screen_num,
            date_str,
            4294705152,
            random.random(),
            self.user_agent,
            f"https://sentinel.openai.com/sentinel/{SENTINEL_VERSION}/sdk.js",
            None,
            lang0,
            lang_joined,
            random.random(),
            f"{nav_prop}\u2212undefined",
            random.choice(["location", "implementation", "URL", "documentURI", "compatMode"]),
            random.choice(["Object", "Function", "Array", "Number", "parseFloat", "undefined"]),
            perf_now,
            self.sid,
            "",
            self.hardware_concurrency,
            time_origin,
            0,
            0,
            0,
            0,
            0,
            0,
            0,
        ]

    @staticmethod
    def _b64_encode(data):
        raw = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        return base64.b64encode(raw).decode("ascii")

    def _run_check(self, start_time, seed, difficulty, config, nonce):
        config[3] = nonce
        config[9] = round((time.time() - start_time) * 1000)
        encoded = self._b64_encode(config)
        digest = self._fnv1a_32(seed + encoded)
        if digest[: len(difficulty)] <= difficulty:
            return encoded + "~S"
        return None

    def generate_token(self, seed=None, difficulty=None):
        seed = seed or self.requirements_seed
        difficulty = difficulty or "0"
        start_time = time.time()
        config = self._get_config()
        for nonce in range(self.MAX_ATTEMPTS):
            value = self._run_check(start_time, seed, difficulty, config, nonce)
            if value:
                return "gAAAAAB" + value
        return "gAAAAAB" + self.ERROR_PREFIX + self._b64_encode(str(None))

    def generate_requirements_token(self):
        config = self._get_config()
        config[3] = 1
        config[9] = round(random.uniform(5, 50))
        return "gAAAAAC" + self._b64_encode(config) + "~S"


# ---------------------------------------------------------------------------
# /req 挑战获取 + 纯 Python 信封拼装（仅宽松步骤使用）
# ---------------------------------------------------------------------------

def fetch_sentinel_challenge(
    device_id, flow, proxies, request_p=None, fp=None, strict_egress=False,
    session=None,
):
    """POST /req，返回完整 JSON（含 token / turnstile / proofofwork / so）。

    fp 可选：与 chatgpt 配套指纹对齐 UA / sec-ch-ua / impersonate。

    proxies:
      - None  → strict_egress=False 时探测 env/Clash/直连；True 时仅直连
      - str/dict → 仅使用该显式代理，不做出口回退
    失败摘要保存在当前线程，避免并发注册互相覆盖。
    """
    _set_req_error(None)

    ua = None
    screen = None
    languages = None
    hw = None
    timezone_name = None
    impersonate = IMPERSONATE
    sec_ch_ua = '"Not:A-Brand";v="99", "Google Chrome";v="131", "Chromium";v="131"'
    sec_platform = '"Windows"'
    if isinstance(fp, dict):
        ua = fp.get("ua")
        scr = fp.get("screen") or {}
        if scr.get("width") and scr.get("height"):
            screen = f"{scr['width']}x{scr['height']}"
        languages = fp.get("languages")
        hw = fp.get("hardware_concurrency")
        timezone_name = fp.get("timezone")
        impersonate = fp.get("impersonate") or IMPERSONATE
        cfp = fp.get("chrome_fp") or {}
        if cfp.get("sec-ch-ua"):
            sec_ch_ua = cfp["sec-ch-ua"]
        if cfp.get("sec-ch-ua-platform"):
            sec_platform = cfp["sec-ch-ua-platform"]
        elif fp.get("os_platform"):
            sec_platform = f'"{fp["os_platform"]}"'
    generator = SentinelTokenGenerator(
        device_id=device_id, user_agent=ua, screen=screen,
        languages=languages, hardware_concurrency=hw, timezone_name=timezone_name,
    )
    if request_p is None:
        request_p = generator.generate_requirements_token()
    body = {"p": str(request_p), "id": device_id, "flow": flow}
    body_data = json.dumps(body, separators=(",", ":"))
    headers = {
        "Content-Type": "text/plain;charset=UTF-8",
        "Accept": "*/*",
        "Accept-Encoding": "gzip, deflate, br, zstd",
        "Referer": f"https://sentinel.openai.com/backend-api/sentinel/frame.html?sv={SENTINEL_VERSION}",
        "Origin": "https://sentinel.openai.com",
        "User-Agent": generator.user_agent,
        "sec-ch-ua": sec_ch_ua,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": sec_platform,
        "Sec-Fetch-Dest": "empty",
        "Sec-Fetch-Mode": "cors",
        "Sec-Fetch-Site": "same-origin",
    }

    candidates = [None] if strict_egress and not proxies else _sentinel_egress_candidates(proxies)
    errors = []
    owned_session = Session(trust_env=False) if strict_egress and session is None else None

    for attempt, px in enumerate(candidates):
        px_label = "direct"
        if isinstance(px, dict):
            u = px.get("https") or px.get("http") or ""
            px_label = u.split("@")[-1] if "@" in u else u
        for retry in range(2):
            try:
                active_session = session or owned_session
                post = active_session.post if active_session is not None else requests.post
                resp = post(
                    SENTINEL_REQ_URL,
                    data=body_data,
                    headers=headers,
                    proxies=px,
                    impersonate=impersonate,
                    timeout=20,
                )
                status = resp.status_code
                text = resp.text or ""
                if status != 200:
                    # CF 403 常见于大陆真直连
                    hint = ""
                    low = text[:200].lower()
                    if status == 403 and ("cloudflare" in low or "attention required" in low):
                        hint = " (Cloudflare 403，需本机 Clash/HTTP_PROXY 出口，勿真直连)"
                    errors.append(f"px={px_label} status={status}{hint}")
                    # 403/5xx：换下一个出口；同出口只重试一次
                    if status in (403, 429, 502, 503, 520, 521, 522, 523, 524):
                        break
                    continue
                try:
                    data = resp.json()
                except Exception as je:
                    errors.append(
                        f"px={px_label} status=200 non-JSON "
                        f"ct={resp.headers.get('content-type')} err={je}"
                    )
                    continue
                if not isinstance(data, dict) or not data.get("token"):
                    errors.append(
                        f"px={px_label} JSON 缺 token keys="
                        f"{list(data.keys()) if isinstance(data, dict) else type(data).__name__}"
                    )
                    continue
                _set_req_error(None)
                data = dict(data)
                data["_diagnostics"] = {
                    "http_status": status,
                    "egress_id": _proxy_id(px),
                    "egress_attempt": attempt + 1,
                }
                if owned_session is not None:
                    owned_session.close()
                return data
            except Exception as e:
                errors.append(
                    f"px={px_label} {type(e).__name__}: {_redact_error(e)[:120]}"
                )
                time.sleep(0.3 * (retry + 1))
                continue

    if owned_session is not None:
        owned_session.close()
    _set_req_error("; ".join(errors[-6:]) if errors else "unknown")
    return None


def build_sentinel_token(device_id, flow, proxies=None, t_mode="dx"):
    """纯 Python 信封（t 非真实求解）。仅用于宽松步骤，不能用于 create_account。

    t_mode:
      "dx"    -> turnstile.dx 原值（authorize_continue 宽松可用）
      "empty" -> t=""（username_password_create 纯 Python 回退）
    """
    if not device_id:
        return None
    # sentinel.openai.com：自动 env/Clash 出口（勿强制真直连，见 fetch_sentinel_challenge）
    challenge = fetch_sentinel_challenge(device_id, flow, proxies, request_p=None)
    if not isinstance(challenge, dict):
        return None
    c_value = str(challenge.get("token") or "").strip()
    if not c_value:
        return None

    t_raw = (challenge.get("turnstile") or {}).get("dx")
    if t_mode == "empty":
        t_value = ""
    else:
        t_value = "" if t_raw is None else str(t_raw).strip()

    pow_data = challenge.get("proofofwork") or {}
    generator = SentinelTokenGenerator(device_id=device_id, user_agent=None)
    if pow_data.get("required") and pow_data.get("seed"):
        p_value = generator.generate_token(
            seed=str(pow_data.get("seed")),
            difficulty=str(pow_data.get("difficulty", "0")),
        )
    else:
        p_value = ""

    envelope = json.dumps(
        {"p": p_value, "t": t_value, "c": c_value,
         "id": device_id, "flow": flow},
        separators=(",", ":"), ensure_ascii=False,
    )
    return envelope


# ---------------------------------------------------------------------------
# 官方 SDK 路径：Node (quickjs 伪 DOM) / 真实浏览器
# ---------------------------------------------------------------------------

# browser/node 回退拿不到 /req 的 so.required，按已观测协议给出保守默认值。
# pure 路径仍以当次 challenge 为准。
_FALLBACK_SO_REQUIRED_FLOWS = (
    "oauth_create_account",
    "email_otp_validate",
    "authorize_continue",
)

# 走真 t（pure VM / sdk.js）的注册协议流。
# 依据 20260810913b 官方 SDK + 真实 HAR 逐请求核对：
#   POST /api/accounts/email-otp/validate    → openai-sentinel-token[flow=email_otp_validate]
#                                              + openai-sentinel-so-token
#   POST /api/accounts/create_account        → openai-sentinel-token[flow=oauth_create_account]
#                                              + openai-sentinel-so-token
#   POST /api/accounts/user/register         → openai-sentinel-token[flow=username_password_create]
# 每条流的 /sentinel/req 响应里 turnstile.required 恒为 True，
# 而 so.required 由服务端按流下发（username_password_create / password_verify 实测无 so），
# 因此「是否需要 so」绝不能写死在流名上，必须读当次 challenge 的 so.required。
_VM_TSO_FLOWS = (
    "oauth_create_account",
    "username_password_create",
    "email_otp_validate",
    "password_verify",
    "authorize_continue",
    "chatgpt_checkout",
)

# 每个 flow 触发时所在的 auth 页 URL。官方 t 的 URL 槽取
# document.location.href，真值形如
#   email_otp_validate -> https://auth.openai.com/email-verification
#   oauth_create_account -> https://auth.openai.com/about-you
# 只给 origin 会让该槽少 9~18 字符，与真形态偏离。
_FLOW_PAGE_URL = {
    "email_otp_validate": "https://auth.openai.com/email-verification",
    "oauth_create_account": "https://auth.openai.com/about-you",
    "username_password_create": "https://auth.openai.com/create-account/password",
    "password_verify": "https://auth.openai.com/log-in/password",
    "authorize_continue": "https://auth.openai.com/log-in",
    "chatgpt_checkout": "https://chatgpt.com/?promo_campaign=plus-1-month-free",
}


def _flow_page_url(flow: str) -> str:
    return _FLOW_PAGE_URL.get(str(flow), "https://auth.openai.com/")


def _challenge_needs_so(challenge: Any) -> bool:
    """当次 challenge 是否要求 so（服务端下发，不写死在流名上）。"""
    if not isinstance(challenge, dict):
        return False
    so = challenge.get("so")
    return bool(isinstance(so, dict) and so.get("required"))


# 形态启发式（来自 camoufox_captured.json[23] 真解 vs Node 伪 DOM 实测）
# 真 t≈1332 / 真 so≈520；Node 假 t≈950–1012 / 假 so≈400–404。
# 本地 t_ok 原先只查非空，会把「垃圾指纹包」当成功。见 NOBROWSER_TSO_REVERSE.md。
_T_LEN_MIN_LIKELY = 1150
_SO_LEN_MIN_LIKELY = 460


def _validate_envelope(sentinel_token: Optional[str], so_token: Optional[str] = None):
    """校验信封：t 不能是 '0'/空；create_account 需要 so 字段。

    另附形态启发式 t_morph_ok / so_morph_ok：
      真 Chrome 解出的 t/so 明显长于 Node 伪 DOM 的「假成功」包。
      不替代服务端密码学校验，仅避免 node 路径误报 ok。
    """
    t_ok = False
    so_ok = False
    t_struct_ok = False
    so_struct_ok = False
    t_len = 0
    so_field_len = 0
    t_prefix = ""
    so_prefix = ""
    if sentinel_token:
        try:
            env = json.loads(sentinel_token) if isinstance(sentinel_token, str) else sentinel_token
            if isinstance(env, dict):
                t_val = env.get("t")
                t_str = str(t_val or "")
                t_len = len(t_str)
                t_prefix = t_str[:16]
                t_ok = bool(t_val) and t_str not in ("0", "null", "None", "")
                decoded_t = base64.b64decode(t_str, validate=True)
                t_struct_ok = len(decoded_t) >= 128 and len(set(decoded_t)) >= 16
        except Exception:
            pass
    if so_token:
        try:
            so_env = json.loads(so_token) if isinstance(so_token, str) else so_token
            if isinstance(so_env, dict) and so_env.get("so"):
                so_str = str(so_env.get("so") or "")
                so_field_len = len(so_str)
                so_prefix = so_str[:16]
                from .sentinel_vm import unpack_so
                unpacked = unpack_so(so_str)
                so_struct_ok = bool(unpacked and len(unpacked.get("outer") or {}) == 29)
                so_ok = so_struct_ok
            elif isinstance(so_token, str) and len(so_token) > 20:
                # 裸 so 串也算部分成功（但 create_account 抓包要整包）
                so_ok = False
        except Exception:
            pass
    t_morph_ok = t_ok and t_struct_ok and t_len >= _T_LEN_MIN_LIKELY
    so_morph_ok = (not so_token) or (
        so_ok and so_struct_ok and so_field_len >= _SO_LEN_MIN_LIKELY
    )
    return {
        "t_ok": t_ok,
        "so_ok": so_ok,
        "t_struct_ok": t_struct_ok,
        "so_struct_ok": so_struct_ok,
        "t_len": t_len,
        "so_field_len": so_field_len,
        "t_morph_ok": t_morph_ok,
        "so_morph_ok": so_morph_ok,
        "t_prefix": t_prefix,
        "so_prefix": so_prefix,
    }


def _node_sdk_tokens(flow: str, did: str, logger=None):
    """尝试用 Node 跑官方 sdk.js 生成 sentinel + so。

    注意：伪 DOM 下 turnstile 常解出 t='0'，sessionObserverToken 常为 null。
    若校验不通过则返回 ok=False，由调用方回退浏览器。
    """
    log = logger or (lambda _m: None)
    try:
        from . import sentinel_quickjs as sq
    except Exception as e:
        return {"ok": False, "error": f"import sentinel_quickjs: {e}"}

    logs = []
    try:
        # 新接口：一次产出 token + so（内部 5000ms observer 等待）
        if hasattr(sq, "build_tokens_quickjs"):
            r = sq.build_tokens_quickjs(
                device_id=did, flow=flow, observer_wait_ms=OBSERVER_WAIT_MS,
                logger=lambda m: logs.append(m))
            if isinstance(r, dict) and r.get("sentinel_token"):
                v = _validate_envelope(r.get("sentinel_token"), r.get("so_token"))
                # create_account 硬步骤：除非空外还要求形态接近浏览器真解
                # （Node 伪 DOM 常 t_ok=so_ok=True 但 t≈1k/so≈400，服务端拒）
                need_so = flow in _FALLBACK_SO_REQUIRED_FLOWS
                morph_pass = v.get("t_morph_ok") and (
                    not r.get("so_token") or v.get("so_morph_ok")
                )
                if v["t_ok"] and (not need_so or v["so_ok"]) and morph_pass:
                    return {
                        "ok": True, "mode": "node-sdk",
                        "sentinel_token": r.get("sentinel_token"),
                        "so_token": r.get("so_token"),
                        "sdk_version": SENTINEL_VERSION,
                        "observer_wait_ms": OBSERVER_WAIT_MS,
                        **v,
                    }
                return {
                    "ok": False, "mode": "node-sdk",
                    "error": (
                        f"node 产出无效/形态偏短 t_ok={v['t_ok']} so_ok={v['so_ok']} "
                        f"t_len={v['t_len']} so_len={v.get('so_field_len')} "
                        f"t_morph={v.get('t_morph_ok')} so_morph={v.get('so_morph_ok')} "
                        f"logs={'; '.join(logs)[:200]}"
                    ),
                    **v,
                }
        # 旧接口：仅 sentinel 信封
        tok = sq.build_sentinel_token_quickjs(
            device_id=did, flow=flow, logger=lambda m: logs.append(m))
        if tok:
            v = _validate_envelope(tok, None)
            if v["t_ok"] and v["t_morph_ok"] and flow not in _FALLBACK_SO_REQUIRED_FLOWS:
                return {
                    "ok": True, "mode": "node-sdk",
                    "sentinel_token": tok, "so_token": None,
                    "sdk_version": SENTINEL_VERSION, **v,
                }
            return {
                "ok": False, "mode": "node-sdk",
                "error": f"node t 无效 t_ok={v['t_ok']} t_len={v['t_len']} "
                         f"(伪 DOM 常返回 t='0') logs={'; '.join(logs)[:200]}",
                **v,
            }
        return {"ok": False, "mode": "node-sdk",
                "error": "; ".join(logs) or "build_sentinel_token_quickjs 返回空"}
    except Exception as e:
        return {"ok": False, "mode": "node-sdk",
                "error": f"{type(e).__name__}: {e}"}


def _browser_sdk_tokens(flow: str, did: str, logger=None, proxy=None):
    """真实 Chrome + 官方 SDK：token(flow) → 等 5000ms → sessionObserverToken(flow)。"""
    log = logger or (lambda _m: None)
    try:
        from . import sentinel_browser as _sb
        r = _sb.generate_tokens(
            flow, did=did, proxy=proxy or "",
            observer_wait_ms=OBSERVER_WAIT_MS,
            logger=log,
        )
        st = r.get("sentinel_token")
        so = r.get("so_token")
        v = _validate_envelope(st, so)
        need_so = flow in _FALLBACK_SO_REQUIRED_FLOWS
        ok = (
            bool(st) and v["t_ok"] and v["t_morph_ok"]
            and (not need_so or v["so_ok"])
            and (not so or v["so_morph_ok"])
        )
        return {
            "ok": ok,
            "mode": "browser",
            "sentinel_token": st,
            "so_token": so,
            "sdk_version": r.get("sdk_version") or SENTINEL_VERSION,
            "observer_wait_ms": r.get("observer_wait_ms", OBSERVER_WAIT_MS),
            "error": None if ok else (
                r.get("error") or f"browser 产出不完整 t_ok={v['t_ok']} so_ok={v['so_ok']}"
            ),
            **v,
        }
    except Exception as e:
        return {"ok": False, "mode": "browser",
                "sentinel_token": None, "so_token": None,
                "error": f"{type(e).__name__}: {e}"}


def _sentinel_mode() -> str:
    """create_account 的 t/so 生成策略。

    OPENAI_SENTINEL_MODE:
      pure    — 纯 Python obt/collector VM，无 Chrome/Node（默认；见 sentinel_vm）
      browser — 真实 Chrome + 官方 SDK（回退 / 对照）
      node    — Node 伪 DOM 跑官方 sdk.js（形态常偏短）
      auto    — pure → browser → node
    """
    m = (os.environ.get("OPENAI_SENTINEL_MODE") or "pure").strip().lower()
    if m in ("pure", "pure-vm", "vm"):
        return "pure"
    if m in ("browser", "node", "auto", "node-sdk", "chrome"):
        if m in ("node-sdk",):
            return "node"
        if m in ("chrome",):
            return "browser"
        return m
    return "pure"


def _pure_vm_tokens(
    flow: str, did: str, logger=None, fp=None, proxy=None, strict_egress=False,
    session=None,
):
    """纯 Python obt VM：按当次 challenge 生成真 t（+ 服务端要求的 so）。

    迭代说明：旧版 sentinel_pure_vm 的 opcode 表来自第三方，
    与官方 sdk.js@20260810913b 的槽语义已不一致（et 用子串匹配 script src、
    document.location 缺失等），导致版本槽/URL 槽恒为空。
    现改用逐条对照官方 SDK 重建的 reg.sentinel_vm。

    fp: 可选配套指纹 dict（chatgpt.choose_fp），与 HTTP Session 对齐。
    """
    log = logger or (lambda _m: None)
    try:
        from . import sentinel_vm as vm_mod
    except Exception as e:
        return {"ok": False, "mode": "pure-vm", "error": f"import sentinel_vm: {e}"}

    page_url = _flow_page_url(flow)
    try:
        ua = None
        screen = None
        languages = None
        hw = None
        timezone_name = None
        if isinstance(fp, dict):
            ua = fp.get("ua")
            scr = fp.get("screen") or {}
            if scr.get("width") and scr.get("height"):
                screen = f"{scr['width']}x{scr['height']}"
            languages = fp.get("languages")
            hw = fp.get("hardware_concurrency")
            timezone_name = fp.get("timezone")
        gen = SentinelTokenGenerator(
            device_id=did, user_agent=ua, screen=screen,
            languages=languages, hardware_concurrency=hw, timezone_name=timezone_name,
        )
        request_p = gen.generate_requirements_token()
        # 注册路径启用 strict_egress，/req 与业务请求共享同一出口。
        challenge = fetch_sentinel_challenge(
            did, flow, proxy, request_p=request_p, fp=fp,
            strict_egress=strict_egress, session=session,
        )
        if not isinstance(challenge, dict):
            detail = _get_req_error() or "无响应"
            return {
                "ok": False, "mode": "pure-vm",
                "error": f"/req 失败或非 JSON: {detail}",
            }

        need_so = _challenge_needs_so(challenge)
        ts = challenge.get("turnstile") or {}
        so_ch = challenge.get("so") or {}
        diagnostics = dict(challenge.get("_diagnostics") or {})
        diagnostics.update({
            "flow": flow,
            "request_p_id": _short_hash(request_p),
            "request_p_slots": _request_p_slot_count(request_p),
            "request_p_suffix_ok": str(request_p).endswith("~S"),
            "challenge_id": _short_hash(challenge.get("token")),
            "turnstile_dx_id": _short_hash(ts.get("dx")),
            "collector_dx_id": _short_hash(so_ch.get("collector_dx")),
            "snapshot_dx_id": _short_hash(so_ch.get("snapshot_dx")),
            "did_id": _short_hash(did),
            "proxy_id": _proxy_id(proxy),
            "page_url": page_url,
        })
        diagnostics["egress_consistent"] = (
            diagnostics.get("egress_id") == diagnostics["proxy_id"]
        )

        # t：turnstile 字节码，seed = 本次 /req 的 p
        t_value = None
        steps_t = 0
        errs = []
        if ts.get("dx"):
            try:
                vmt = vm_mod.SentinelVM(
                    SENTINEL_VERSION, page_url=page_url, fingerprint=fp
                )
                t_value = vmt.run(ts["dx"], seed=request_p, reinit=True)
                steps_t = vmt.steps
                if vmt.last_error():
                    errs.append(f"t: {vmt.last_error()}")
            except Exception as e:
                errs.append(f"t: {type(e).__name__}: {e}")

        # so：collector -> 观察窗 -> snapshot（同一 VM 实例续跑）
        so_value = None
        steps_collector = steps_snapshot = 0
        if need_so and so_ch.get("collector_dx") and so_ch.get("snapshot_dx"):
            try:
                vms = vm_mod.EventedSentinelVM(
                    SENTINEL_VERSION, page_url=page_url, fingerprint=fp
                )
                vms.run(so_ch["collector_dx"], seed=request_p, reinit=True)
                steps_collector = vms.steps
                # 事件条数按 OBSERVER_WAIT_MS 定，观察窗墙钟时长按 OBSERVER_SPAN_MS 定
                vms.simulate_session(float(OBSERVER_WAIT_MS),
                                     span_ms=OBSERVER_SPAN_MS)
                so_value = vms.run(so_ch["snapshot_dx"], seed=None, reinit=False)
                steps_snapshot = vms.steps - steps_collector
                if vms.last_error():
                    errs.append(f"so: {vms.last_error()}")
            except Exception as e:
                errs.append(f"so: {type(e).__name__}: {e}")

        c_value = str(challenge.get("token") or "").strip()
        pow_data = challenge.get("proofofwork") or {}
        if pow_data.get("required") and pow_data.get("seed"):
            p_value = gen.generate_token(
                seed=str(pow_data.get("seed")),
                difficulty=str(pow_data.get("difficulty", "0")),
            )
        else:
            p_value = ""

        st = so = None
        if t_value and c_value:
            st = json.dumps(
                {"p": p_value, "t": t_value, "c": c_value,
                 "id": did, "flow": flow},
                separators=(",", ":"), ensure_ascii=False,
            )
        if so_value and c_value:
            so = json.dumps(
                {"so": so_value, "c": c_value, "id": did, "flow": flow},
                separators=(",", ":"), ensure_ascii=False,
            )

        v = _validate_envelope(st, so)
        diagnostics["t_decoded_len"] = 0
        if t_value:
            try:
                diagnostics["t_decoded_len"] = len(
                    base64.b64decode(t_value, validate=True)
                )
            except Exception:
                pass
        diagnostics["so_slots"] = 0
        diagnostics["so_timing_0_11_12"] = None
        if so_value:
            unpacked = vm_mod.unpack_so(so_value)
            plain = (unpacked or {}).get("plain_unknown") or []
            diagnostics["so_slots"] = len((unpacked or {}).get("outer") or {})
            if len(plain) >= 13:
                diagnostics["so_timing_0_11_12"] = [plain[0], plain[11], plain[12]]
        morph_pass = v.get("t_morph_ok") and (not so or v.get("so_morph_ok"))
        ok = bool(st) and v["t_ok"] and (not need_so or v["so_ok"]) and morph_pass
        if ok:
            log(
                f"[pure] ok t_len={v.get('t_len')} so_len={v.get('so_field_len')} "
                f"need_so={need_so} steps_t={steps_t} steps_so="
                f"{steps_collector}+{steps_snapshot}"
            )
        else:
            log(
                f"[pure] fail t_ok={v.get('t_ok')} so_ok={v.get('so_ok')} "
                f"need_so={need_so} t_len={v.get('t_len')} "
                f"so_len={v.get('so_field_len')} "
                f"t_morph={v.get('t_morph_ok')} so_morph={v.get('so_morph_ok')} "
                f"err={'; '.join(errs)}"
            )
        return {
            "ok": ok,
            "mode": "pure-vm",
            "sentinel_token": st,
            "so_token": so,
            "so_required": need_so,
            "sdk_version": SENTINEL_VERSION,
            "observer_wait_ms": 0,
            "error": None if ok else (
                "; ".join(errs)
                or f"pure-vm 形态不足 t_len={v.get('t_len')} so_len={v.get('so_field_len')}"
            ),
            **v,
            "steps_t": steps_t,
            "steps_collector": steps_collector,
            "steps_snapshot": steps_snapshot,
            "diagnostics": diagnostics,
        }
    except Exception as e:
        return {
            "ok": False, "mode": "pure-vm",
            "sentinel_token": None, "so_token": None,
            "error": f"{type(e).__name__}: {e}",
        }


def _pack_ok(src: Dict[str, Any], mode_name: str, did: str) -> Dict[str, Any]:
    """把某个 mode 的成功结果归一成 sentinel_for 的返回形状。"""
    st, so = src.get("sentinel_token"), src.get("so_token")
    return {
        "ok": True, "mode": mode_name,
        "sentinel_token": st, "so_token": so,
        "oai_did": did, "cf_turnstile_response": None,
        "sdk_version": src.get("sdk_version") or SENTINEL_VERSION,
        "so_present": bool(so), "so_required": src.get("so_required"),
        "sentinel_len": len(st or ""), "so_len": len(so or ""),
        "observer_wait_ms": src.get("observer_wait_ms", OBSERVER_WAIT_MS),
        "t_ok": src.get("t_ok"), "so_ok": src.get("so_ok"),
        "t_len": src.get("t_len"), "so_field_len": src.get("so_field_len"),
        "t_morph_ok": src.get("t_morph_ok"), "so_morph_ok": src.get("so_morph_ok"),
        "diagnostics": src.get("diagnostics") or {},
        "error": None,
    }


def sentinel_for(
    flow: str,
    proxy: Optional[str] = None,
    did: Optional[str] = None,
    fp: Optional[Dict[str, Any]] = None,
    strict_egress: bool = False,
    session=None,
) -> Dict[str, Any]:
    """为某步骤生成 Sentinel 信封。did 必须传入（=oai-did）。

    全部注册/登录 flow：
      - 默认 pure（sentinel_vm：Turnstile t + collector 事件采样 → snapshot so）
      - 是否带 so 由本次 challenge 的 so.required 决定（见 _challenge_needs_so）
      - OPENAI_SENTINEL_MODE=browser|node|auto 可改；auto = pure→browser→node
      - 形态门禁 t≥1150 / so≥460；不回退「无 so 的假信封」
    fp: 可选配套指纹（chatgpt.choose_fp），使 pure-vm 与 HTTP 头/TLS 同一套。
    """
    if not did:
        return {"ok": False, "mode": "none", "sentinel_token": None,
                "so_token": None, "oai_did": None, "cf_turnstile_response": None,
                "sdk_version": SENTINEL_VERSION, "so_present": False,
                "sentinel_len": 0, "so_len": 0,
                "observer_wait_ms": OBSERVER_WAIT_MS,
                "error": "缺少 did(oai-did)，无法绑定设备"}

    logs = []
    _log = lambda m: logs.append(m)

    # ── 注册协议流：真 t（+ 服务端要求的 so）──
    if flow in _VM_TSO_FLOWS:
        mode = _sentinel_mode()
        pure_r: Dict[str, Any] = {}
        node_r: Dict[str, Any] = {}
        br: Dict[str, Any] = {}

        # 1) pure-vm（默认 / auto 优先）— 无 Chrome；传入 fp 配套对齐
        if mode in ("pure", "auto"):
            pure_r = _pure_vm_tokens(
                flow, did, logger=_log, fp=fp, proxy=proxy,
                strict_egress=strict_egress, session=session,
            )
            if pure_r.get("ok") and pure_r.get("sentinel_token"):
                # so 只在服务端要求时才是硬条件
                if pure_r.get("so_token") or not pure_r.get("so_required"):
                    return _pack_ok(pure_r, "pure-vm", did)

        # 2) browser（显式 browser，或 auto 在 pure 失败后）
        if mode in ("browser", "auto"):
            br = _browser_sdk_tokens(flow, did, logger=_log, proxy=proxy)
            if br.get("ok") and br.get("sentinel_token"):
                return _pack_ok(br, "browser", did)

        # 3) node（仅 mode=node 或 auto 最后回退）
        if mode in ("node", "auto"):
            node_r = _node_sdk_tokens(flow, did, logger=_log)
            if node_r.get("ok") and node_r.get("sentinel_token"):
                if mode == "node":
                    _log("WARN: OPENAI_SENTINEL_MODE=node — 伪 DOM t/so 可能被服务端拒绝")
                return _pack_ok(node_r, node_r.get("mode") or "node-sdk", did)

        # 4) 失败
        reason_parts = [f"sentinel_mode={mode}"]
        if pure_r.get("error"):
            reason_parts.append(f"pure: {pure_r['error']}")
        if br.get("error"):
            reason_parts.append(f"browser: {br['error']}")
        if node_r.get("error"):
            reason_parts.append(f"node: {node_r['error']}")
        if logs:
            reason_parts.append(" | ".join(logs[-3:]))
        st_fb = (pure_r.get("sentinel_token") or br.get("sentinel_token")
                 or node_r.get("sentinel_token"))
        so_fb = (pure_r.get("so_token") or br.get("so_token") or node_r.get("so_token"))
        return {
            "ok": False, "mode": "sdk-failed",
            "sentinel_token": st_fb,
            "so_token": so_fb,
            "oai_did": did, "cf_turnstile_response": None,
            "sdk_version": SENTINEL_VERSION, "so_present": bool(so_fb),
            "sentinel_len": len(st_fb or ""),
            "so_len": len(so_fb or ""),
            "observer_wait_ms": OBSERVER_WAIT_MS,
            "diagnostics": pure_r.get("diagnostics") or br.get("diagnostics") or {},
            "error": f"{flow} 需要真 t（+ 服务端要求的 so），"
                     "pure-vm/browser/node 均未过形态门禁；"
                     + ("; ".join(reason_parts) or "all modes failed"),
        }

    # ── 未列名 flow：同样走新 SDK 的 obt VM（不再回退「未求解的 dx 原值」）──
    # 旧实现把 challenge.turnstile.dx 原样当 t 用（t_mode="dx"）或直接给空串，
    # 二者都不是真解；20260810913b 起统一由 sentinel_vm 解算。
    pure_r = _pure_vm_tokens(
        flow, did, logger=_log, fp=fp, proxy=proxy,
        strict_egress=strict_egress, session=session,
    )
    if pure_r.get("ok") and pure_r.get("sentinel_token"):
        return _pack_ok(pure_r, "pure-vm", did)
    return {"ok": False, "mode": "sdk-failed", "sentinel_token": None,
            "so_token": None, "oai_did": did, "cf_turnstile_response": None,
            "sdk_version": SENTINEL_VERSION, "so_present": False,
            "sentinel_len": 0, "so_len": 0,
            "observer_wait_ms": OBSERVER_WAIT_MS,
            "error": f"{flow} obt VM 未就绪: "
                     f"{pure_r.get('error') or '未知原因'}"}


def close_browser():
    """关闭浏览器 SDK 实例（进程退出或注册完成后调用）。"""
    try:
        from . import sentinel_browser as _sb
        _sb.close_all_browsers()
    except Exception:
        pass


if __name__ == "__main__":
    import sys
    p = sys.argv[1] if len(sys.argv) > 1 else "oauth_create_account"
    did_arg = sys.argv[2] if len(sys.argv) > 2 else str(uuid.uuid4())
    m = sentinel_for(p, proxy=None, did=did_arg)
    print(json.dumps({k: v for k, v in m.items()
                     if k not in ("sentinel_token", "so_token", "cf_turnstile_response")},
                    ensure_ascii=False, indent=2))
    close_browser()
