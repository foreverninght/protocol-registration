import hashlib
import json
import re
import urllib.parse
from dataclasses import dataclass
from typing import Any, Dict, Optional


_GEO_PROFILES = {
    "AE": ("en-AE", "Asia/Dubai"),
    "AR": ("es-AR", "America/Argentina/Buenos_Aires"),
    "AT": ("de-AT", "Europe/Vienna"),
    "AU": ("en-AU", "Australia/Sydney"),
    "BE": ("nl-BE", "Europe/Brussels"),
    "BR": ("pt-BR", "America/Sao_Paulo"),
    "CA": ("en-CA", "America/Toronto"),
    "CH": ("de-CH", "Europe/Zurich"),
    "CL": ("es-CL", "America/Santiago"),
    "DE": ("de-DE", "Europe/Berlin"),
    "DK": ("da-DK", "Europe/Copenhagen"),
    "EG": ("ar-EG", "Africa/Cairo"),
    "ES": ("es-ES", "Europe/Madrid"),
    "FI": ("fi-FI", "Europe/Helsinki"),
    "FR": ("fr-FR", "Europe/Paris"),
    "GB": ("en-GB", "Europe/London"),
    "HK": ("zh-HK", "Asia/Hong_Kong"),
    "ID": ("id-ID", "Asia/Jakarta"),
    "IE": ("en-IE", "Europe/Dublin"),
    "IL": ("he-IL", "Asia/Jerusalem"),
    "IN": ("en-IN", "Asia/Kolkata"),
    "IT": ("it-IT", "Europe/Rome"),
    "JP": ("ja-JP", "Asia/Tokyo"),
    "KR": ("ko-KR", "Asia/Seoul"),
    "MX": ("es-MX", "America/Mexico_City"),
    "MY": ("ms-MY", "Asia/Kuala_Lumpur"),
    "NL": ("nl-NL", "Europe/Amsterdam"),
    "NO": ("nb-NO", "Europe/Oslo"),
    "NZ": ("en-NZ", "Pacific/Auckland"),
    "PH": ("en-PH", "Asia/Manila"),
    "PL": ("pl-PL", "Europe/Warsaw"),
    "PT": ("pt-PT", "Europe/Lisbon"),
    "SA": ("ar-SA", "Asia/Riyadh"),
    "SE": ("sv-SE", "Europe/Stockholm"),
    "SG": ("en-SG", "Asia/Singapore"),
    "TH": ("th-TH", "Asia/Bangkok"),
    "TR": ("tr-TR", "Europe/Istanbul"),
    "TW": ("zh-TW", "Asia/Taipei"),
    "US": ("en-US", "America/Chicago"),
    "VN": ("vi-VN", "Asia/Ho_Chi_Minh"),
    "ZA": ("en-ZA", "Africa/Johannesburg"),
}


def _timezone_for_languages(languages) -> str:
    primary = str((languages or [""])[0])
    for locale, timezone_name in _GEO_PROFILES.values():
        if locale == primary:
            return timezone_name
    return "America/New_York"


def _short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()[:12]


def _proxy_endpoint(proxy: Optional[str]) -> str:
    if not proxy:
        return "direct"
    raw = str(proxy).strip()
    parsed = urllib.parse.urlsplit(raw if "://" in raw else f"http://{raw}")
    host = parsed.hostname or "unknown"
    return f"{host}:{parsed.port}" if parsed.port else host


@dataclass(frozen=True)
class RegistrationContext:
    proxy: Optional[str]
    did: str
    fingerprint_json: str
    context_id: str
    did_id: str
    proxy_id: str
    exit_ip: Optional[str]
    country: Optional[str]
    expected_exit_ip: Optional[str]

    @classmethod
    def create(
        cls, proxy: Optional[str], did: str, fingerprint: Dict[str, Any],
        country: Optional[str] = None, exit_ip: Optional[str] = None,
        expected_exit_ip: Optional[str] = None,
    ):
        if not did:
            raise ValueError("registration context requires did")
        proxy_value = str(proxy).strip() if proxy else None
        fingerprint = json.loads(json.dumps(fingerprint))
        actual_country = str(country or "").strip().upper() or None
        if actual_country in _GEO_PROFILES:
            locale, timezone_name = _GEO_PROFILES[actual_country]
            language = locale.split("-", 1)[0]
            languages = [locale] if language == locale else [locale, language]
            fingerprint["languages"] = languages
            fingerprint["chrome_fp"]["accept-language"] = ",".join(
                [languages[0]] + [f"{item};q={0.9 - index * 0.1:.1f}" for index, item in enumerate(languages[1:])]
            )
            fingerprint["timezone"] = timezone_name
            fingerprint["geo_country"] = actual_country
        else:
            fingerprint.setdefault(
                "timezone", _timezone_for_languages(fingerprint.get("languages"))
            )
            fingerprint["geo_country"] = None
        cls._validate_fingerprint(fingerprint)
        payload = json.dumps(
            fingerprint, sort_keys=True, separators=(",", ":"), ensure_ascii=True
        )
        material = (
            f"{did}\n{proxy_value or 'direct'}\n{exit_ip or 'unknown'}\n"
            f"{actual_country or 'unknown'}\n{payload}"
        )
        return cls(
            proxy=proxy_value,
            did=did,
            fingerprint_json=payload,
            context_id=_short_hash(material),
            did_id=_short_hash(did),
            proxy_id=_short_hash(_proxy_endpoint(proxy_value)),
            exit_ip=str(exit_ip).strip() if exit_ip else None,
            country=actual_country,
            expected_exit_ip=(
                str(expected_exit_ip).strip() if expected_exit_ip else None
            ),
        )

    @staticmethod
    def _validate_fingerprint(fp: Dict[str, Any]) -> None:
        ua = str(fp.get("ua") or "")
        major = str(fp.get("chrome_major") or "")
        impersonate = str(fp.get("impersonate") or "")
        headers = fp.get("chrome_fp") or {}
        languages = fp.get("languages") or []
        screen = fp.get("screen") or {}

        ua_match = re.search(r"Chrome/(\d+)", ua)
        imp_match = re.search(r"chrome(\d+)", impersonate, re.I)
        if not ua_match or ua_match.group(1) != major:
            raise ValueError("fingerprint UA/chrome_major mismatch")
        if not imp_match or imp_match.group(1) != major:
            raise ValueError("fingerprint impersonate/chrome_major mismatch")
        if f'v="{major}"' not in str(headers.get("sec-ch-ua") or ""):
            raise ValueError("fingerprint sec-ch-ua/chrome_major mismatch")
        if str(headers.get("user-agent") or "") != ua:
            raise ValueError("fingerprint header UA mismatch")
        expected_platform = f'"{fp.get("os_platform")}"'
        if headers.get("sec-ch-ua-platform") != expected_platform:
            raise ValueError("fingerprint Client Hints platform mismatch")
        accept_language = str(headers.get("accept-language") or "")
        if not languages or accept_language.split(",", 1)[0] != str(languages[0]):
            raise ValueError("fingerprint language headers mismatch")
        if int(screen.get("width") or 0) <= 0 or int(screen.get("height") or 0) <= 0:
            raise ValueError("fingerprint screen is invalid")
        if int(fp.get("hardware_concurrency") or 0) <= 0:
            raise ValueError("fingerprint hardware_concurrency is invalid")
        if not str(fp.get("timezone") or ""):
            raise ValueError("fingerprint timezone is invalid")

    def fingerprint(self) -> Dict[str, Any]:
        return json.loads(self.fingerprint_json)

    def proxies(self) -> Optional[Dict[str, str]]:
        if not self.proxy:
            return None
        return {"http": self.proxy, "https": self.proxy}

    def summary(self) -> Dict[str, Any]:
        fp = self.fingerprint()
        return {
            "context_id": self.context_id,
            "did_id": self.did_id,
            "proxy_id": self.proxy_id,
            "fp_id": fp.get("id"),
            "chrome_major": fp.get("chrome_major"),
            "impersonate": fp.get("impersonate"),
            "geo_country": fp.get("geo_country"),
            "timezone": fp.get("timezone"),
            "exit_ip_id": _short_hash(self.exit_ip) if self.exit_ip else None,
            "country": self.country,
            "expected_exit_ip_id": (
                _short_hash(self.expected_exit_ip) if self.expected_exit_ip else None
            ),
        }

    def assert_session(self, session) -> None:
        if getattr(session, "_registration_context_id", None) != self.context_id:
            raise RuntimeError("session registration context mismatch")
        fp = self.fingerprint()
        session_ua = session.headers.get("user-agent") or session.headers.get("User-Agent")
        if session_ua != fp["ua"]:
            raise RuntimeError("session UA mismatch")
        if getattr(session, "_anti_fuzz_impersonate", None) != fp["impersonate"]:
            raise RuntimeError("session impersonate mismatch")
        if getattr(session, "trust_env", True):
            raise RuntimeError("session environment proxy inheritance is enabled")
        actual_proxies = dict(getattr(session, "proxies", None) or {})
        if actual_proxies != dict(self.proxies() or {}):
            raise RuntimeError("session proxy mismatch")
        cookie_jar = getattr(session.cookies, "jar", session.cookies)
        cookie_values = {
            cookie.value for cookie in cookie_jar if cookie.name == "oai-did"
        }
        if cookie_values != {self.did}:
            raise RuntimeError("session oai-did mismatch")

    def assert_request(self, session, headers: Dict[str, str]) -> None:
        self.assert_session(session)
        request_did = headers.get("oai-device-id") or headers.get("OAI-Device-Id")
        if request_did != self.did:
            raise RuntimeError("business request did mismatch")
