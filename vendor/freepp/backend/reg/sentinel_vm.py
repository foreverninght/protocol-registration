# -*- coding: utf-8 -*-
"""
sentinel_vm.py — 依官方 sdk.js@20260810913b 重建的纯 Python obt VM

本文件是唯一权威实现（backend/reg/sentinel_vm.py）。
早期开发阶段曾在 research/sentinel_vm_new.py 迭代，该副本已废弃，
请勿再以它为源回拷 —— 直接改本文件。

规范来源（逐条从官方混淆源码核实并解码）：
    research/live/sdk_20260810913b.js            官方源码（与线上逐字节一致）
    research/sdk_tables.json                     11 张混淆字符串表
    research/sdk_opcodes_deobf.json              34 个 opcode 的真实实现

官方核心事实：
  1. At = new Map，普通 Map（非自定义类）
  2. 数据槽：9=指令队列(tt)  10=window(nt)  16=seed(st)
     opcode 槽：0-8, 11-15, 17-30, 33, 34, 35（31/32 官方未定义）
  3. 入口 Et(dx, seed):
       首次：At.clear(); 装 opcode; At.set(16, seed)
       At.set(9, JSON.parse(_t(atob(dx), ""+At.get(16)))); Pt()
  4. 执行循环 Pt():
       while At.get(9).length > 0:
         [n, ...e] = At.get(9).shift(); r = At.get(n)(...e)
         if r && typeof r.then === "function": await r
         Ot += 1
     参数不预解析：每个 opcode 自行决定是否 At.get 解引用
  5. 出口：op3 → resolve(btoa(""+t))；op4 → reject(btoa(""+t))
  6. _t(text,key) 逐 UTF-16 代码单元异或，key 循环
  7. "__oai_so_" 在官方 SDK 中出现 0 次 —— 29 槽容器完全由字节码构造，
     故忠实 VM 不含任何业务字段逻辑
"""
from __future__ import annotations

import asyncio
import base64
import json
import math
import random
import struct
import time


def struct_unpack_f(x: float) -> float:
    """JS Math.fround：先转 float32 再回 float64。"""
    try:
        return struct.unpack("<f", struct.pack("<f", float(x)))[0]
    except (OverflowError, ValueError):
        return float(x)
from typing import Any, Callable, Dict, List, Optional


# ---------------------------------------------------------------------------
# JS 语义基础件
# ---------------------------------------------------------------------------

class _Drop:
    """JSON.stringify 里代表「该属性被丢弃」。"""

    def __repr__(self):
        return "<drop>"


_DROP = _Drop()


class _Undefined:
    _inst = None

    def __new__(cls):
        if cls._inst is None:
            cls._inst = super().__new__(cls)
        return cls._inst

    def __repr__(self):
        return "undefined"

    def __bool__(self):
        return False


undefined = _Undefined()


def is_undefined(v: Any) -> bool:
    return v is undefined


def js_truthy(v: Any) -> bool:
    if v is undefined or v is None or v is False:
        return False
    if v is True:
        return True
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return not (v == 0 or (isinstance(v, float) and math.isnan(v)))
    if isinstance(v, str):
        return len(v) > 0
    return True


def js_div(a: float, b: float) -> float:
    """JS 除法：0/0 = NaN，x/0 = ±Infinity。"""
    if a != a or b != b:
        return float("nan")
    if b == 0:
        if a == 0:
            return float("nan")
        sign = -1.0 if (a < 0) != (math.copysign(1.0, b) < 0) else 1.0
        return math.copysign(float("inf"), sign)
    try:
        return a / b
    except (ZeroDivisionError, OverflowError):
        return float("nan")


def js_mul(a: float, b: float) -> float:
    """JS 乘法：溢出到 ±Infinity，Infinity*0 = NaN。"""
    if a != a or b != b:
        return float("nan")
    if (a in (float("inf"), float("-inf")) and b == 0) or \
       (b in (float("inf"), float("-inf")) and a == 0):
        return float("nan")
    try:
        return a * b
    except OverflowError:
        return math.copysign(float("inf"), a * b if b else a)


def num_to_js(v: float) -> Any:
    """把 Python 数值还原为 JS 风格输出（整数用 int）。"""
    if isinstance(v, float):
        if v != v:
            return float("nan")
        if v in (float("inf"), float("-inf")):
            return v
        if v.is_integer() and abs(v) < 1e15:
            return int(v)
    return v


def js_num2str(v: Any) -> str:
    """JS String(number)。"""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        if v != v:
            return "NaN"
        if v == float("inf"):
            return "Infinity"
        if v == float("-inf"):
            return "-Infinity"
        if v.is_integer() and abs(v) < 1e21:
            return str(int(v))
        r = repr(v)
        if "e" in r or "E" in r:
            m, e = r.lower().split("e")
            ei = int(e)
            if 1e-7 <= abs(v) < 1e21:
                s = ("%.20f" % v).rstrip("0").rstrip(".")
                return s if s else "0"
            sign = "+" if ei >= 0 else "-"
            return "%se%s%d" % (m, sign, abs(ei))
        return r
    return js_to_str(v)


def js_to_str(v: Any) -> str:
    """JS String(v)。"""
    if v is undefined:
        return "undefined"
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return js_num2str(v)
    if isinstance(v, str):
        return v
    if isinstance(v, (list, tuple)):
        return ",".join("" if (x is None or x is undefined) else js_to_str(x) for x in v)
    if isinstance(v, dict):
        return "[object Object]"
    if callable(v):
        return "function () { [native code] }"
    # JS String(obj) 走 obj.toString()。伪 DOM 对象（如 PseudoLocation）
    # 必须给出真实 href/字符串，否则会被 str() 变成 <...object at 0x...>，
    # 直接污染官方 t 的 URL 槽。
    ts = getattr(v, "toString", None)
    if callable(ts):
        try:
            r = ts()
            if isinstance(r, str):
                return r
        except Exception:
            pass
    return str(v)


def js_plus(a: Any, b: Any) -> Any:
    """JS 的 + ：任一侧为字符串则拼接，否则数值相加。"""
    if isinstance(a, str) or isinstance(b, str):
        return js_to_str(a) + js_to_str(b)
    if isinstance(a, (list, tuple)) or isinstance(b, (list, tuple)):
        return js_to_str(a) + js_to_str(b)
    an, bn = to_number(a), to_number(b)
    if an != an or bn != bn:
        return float("nan")
    return num_to_js(an + bn)


def js_xor(text: Any, key: Any) -> str:
    """官方 _t(t,n)：逐 UTF-16 代码单元异或。"""
    t = js_to_str(text)
    k = js_to_str(key)
    if not k:
        return t
    return "".join(chr((ord(c) ^ ord(k[i % len(k)])) & 0xFFFF) for i, c in enumerate(t))


def b64_encode_latin1(s: Any) -> str:
    """JS btoa。"""
    return base64.b64encode(js_to_str(s).encode("latin1", "replace")).decode("ascii")


def b64_decode_latin1(s: Any) -> str:
    """JS atob。"""
    t = js_to_str(s)
    pad = (-len(t)) % 4
    return base64.b64decode(t + "=" * pad).decode("latin1")


def to_number(v: Any) -> float:
    """JS Number(v)。"""
    if v is undefined:
        return float("nan")
    if v is None:
        return 0.0
    if v is True:
        return 1.0
    if v is False:
        return 0.0
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v)
    if isinstance(v, str):
        s = v.strip()
        if s == "":
            return 0.0
        try:
            return float(s)
        except ValueError:
            return float("nan")
    return float("nan")


def to_int(v: Any) -> int:
    n = to_number(v)
    if n != n or n in (float("inf"), float("-inf")):
        return 0
    return int(n)


class OrderedMap(dict):
    """对应 JS Map；Python dict 保插入序，语义一致。"""

    def get(self, k, default=undefined):  # type: ignore[override]
        return super().get(k, default)


class JSObject(OrderedMap):
    """可同时以 obj["k"] 与 obj.k 访问的普通 JS 对象。"""

    def __getattr__(self, k: str) -> Any:
        try:
            return self[k]
        except KeyError:
            raise AttributeError(k)


class JSArray(list):
    """数组；here 仅为语义清晰，Python list 已足够。"""


def _is_index_key(key: Any) -> bool:
    """JS 下标键判定：数字，或可精确解析为整数的字符串。

    注意不能用 to_int()：to_int("pop") == 0，会把 "pop"/"split" 这类
    原型方法名误当成下标 0，从而静默返回首元素（新版 SDK 崩溃根因）。
    """
    if isinstance(key, bool):
        return False
    if isinstance(key, int):
        return True
    if isinstance(key, float):
        return key.is_integer()
    if isinstance(key, str):
        s = key.strip()
        if not s:
            return False
        try:
            return float(s).is_integer()
        except ValueError:
            return False
    return False


def _bind_wrap(fn: Any, this: Any, bound: List[Any]) -> Any:
    """Function.prototype.bind 的最小实现。"""
    def _bound(*args):
        return js_call(fn, list(bound) + list(args))
    _bound.__name__ = "bound"
    return _bound


def _fn_member(fn: Any, key: str) -> Any:
    if key == "bind":
        return lambda this, *a: _bind_wrap(fn, this, list(a))
    if key == "call":
        return lambda this, *a: js_call(fn, list(a))
    if key == "apply":
        return lambda this, a=None: js_call(fn, list(a or []))
    if key in ("name", "length"):
        return getattr(fn, "__name__", "") if key == "name" else 0
    if key == "prototype":
        return OrderedMap()
    if key == "constructor":
        return OrderedMap()
    return undefined


def _str_member(s: str, key: str) -> Any:
    """String.prototype 成员。"""
    if key == "length":
        return len(s)
    if key == "charCodeAt":
        return lambda i=0: (ord(s[to_int(i)]) if 0 <= to_int(i) < len(s) else float("nan"))
    if key == "charAt":
        return lambda i=0: (s[to_int(i)] if 0 <= to_int(i) < len(s) else "")
    if key == "codePointAt":
        return lambda i=0: (ord(s[to_int(i)]) if 0 <= to_int(i) < len(s) else undefined)
    if key == "at":
        return lambda i=0: (s[to_int(i)] if -len(s) <= to_int(i) < len(s) else undefined)
    if key == "indexOf":
        return lambda sub, start=0: s.find(js_to_str(sub), to_int(start))
    if key == "lastIndexOf":
        return lambda sub, start=None: s.rfind(js_to_str(sub))
    if key == "includes":
        return lambda sub, start=0: js_to_str(sub) in s[to_int(start):]
    if key == "startsWith":
        return lambda sub, start=0: s.startswith(js_to_str(sub), to_int(start))
    if key == "endsWith":
        return lambda sub, end=None: s.endswith(js_to_str(sub))
    if key == "slice":
        def _slice(a=0, b=None):
            i = to_int(a)
            j = len(s) if b is None or b is undefined else to_int(b)
            i = max(0, len(s) + i) if i < 0 else min(i, len(s))
            j = max(0, len(s) + j) if j < 0 else min(j, len(s))
            return s[i:j] if j > i else ""
        return _slice
    if key == "substring":
        def _sub(a=0, b=None):
            i = max(0, min(to_int(a), len(s)))
            j = len(s) if b is None or b is undefined else max(0, min(to_int(b), len(s)))
            return s[min(i, j):max(i, j)]
        return _sub
    if key == "substr":
        def _substr(a=0, n=None):
            i = to_int(a)
            i = max(0, len(s) + i) if i < 0 else i
            j = len(s) if n is None or n is undefined else i + to_int(n)
            return s[i:j]
        return _substr
    if key == "split":
        def _split(sep=None, limit=None):
            if sep is None or sep is undefined:
                parts = [s]
            else:
                sp = js_to_str(sep)
                parts = list(s) if sp == "" else s.split(sp)
            if limit is not None and limit is not undefined:
                parts = parts[:to_int(limit)]
            return parts
        return _split
    if key == "replace":
        return lambda a, b: s.replace(js_to_str(a), js_to_str(b), 1)
    if key == "replaceAll":
        return lambda a, b: s.replace(js_to_str(a), js_to_str(b))
    if key == "toLowerCase":
        return lambda: s.lower()
    if key == "toUpperCase":
        return lambda: s.upper()
    if key == "trim":
        return lambda: s.strip()
    if key == "trimStart":
        return lambda: s.lstrip()
    if key == "trimEnd":
        return lambda: s.rstrip()
    if key == "padStart":
        return lambda n, ch=" ": s.rjust(to_int(n), js_to_str(ch)[:1] or " ")
    if key == "padEnd":
        return lambda n, ch=" ": s.ljust(to_int(n), js_to_str(ch)[:1] or " ")
    if key == "repeat":
        return lambda n: s * max(0, to_int(n))
    if key == "concat":
        return lambda *a: s + "".join(js_to_str(x) for x in a)
    if key == "match":
        return lambda pat: _simple_match(s, pat)
    if key == "search":
        return lambda pat: _simple_search(s, pat)
    if key == "localeCompare":
        return lambda o: (s > js_to_str(o)) - (s < js_to_str(o))
    if key == "toString" or key == "valueOf":
        return lambda: s
    return undefined


def _simple_match(s: str, pat: Any) -> Any:
    import re as _re
    p = pat
    if hasattr(p, "source"):
        p = getattr(p, "source")
    src = js_to_str(p)
    flags = 0
    if hasattr(pat, "flags"):
        f = js_to_str(getattr(pat, "flags"))
        if "i" in f:
            flags |= _re.I
    try:
        m = _re.search(src, s, flags)
    except Exception:
        return None
    if not m:
        return None
    out = [m.group(0)]
    out.extend(g if g is not None else undefined for g in m.groups())
    out.append(m.start())
    out.append(s)
    return out


def _simple_search(s: str, pat: Any) -> int:
    import re as _re
    p = pat
    if hasattr(p, "source"):
        p = getattr(p, "source")
    try:
        m = _re.search(js_to_str(p), s)
    except Exception:
        return -1
    return m.start() if m else -1


def _list_member(arr: Any, key: str) -> Any:
    """Array.prototype 成员。"""
    if key == "length":
        return len(arr)
    if key == "push":
        return lambda *a: (arr.extend(a) or len(arr))
    if key == "pop":
        return lambda: (arr.pop() if arr else undefined)
    if key == "shift":
        return lambda: (arr.pop(0) if arr else undefined)
    if key == "unshift":
        return lambda *a: ([arr.insert(i, v) for i, v in enumerate(a)] and len(arr))
    if key == "slice":
        return lambda a=0, b=None: list(arr[to_int(a): (len(arr) if b is None or b is undefined else to_int(b))])
    if key == "splice":
        def _splice(start, delete_count=None, *items):
            i = to_int(start)
            if i < 0:
                i = max(0, len(arr) + i)
            if delete_count is None or delete_count is undefined:
                deleted = list(arr[i:])
                del arr[i:]
                return deleted
            n = max(0, to_int(delete_count))
            deleted = list(arr[i:i + n])
            arr[i:i + n] = list(items)
            return deleted
        return _splice
    if key == "concat":
        return lambda *a: list(arr) + [x for o in a for x in (list(o) if isinstance(o, list) else [o])]
    if key == "join":
        return lambda sep=",": js_to_str(sep).join(js_to_str(x) for x in arr)
    if key == "indexOf":
        return lambda x, start=0: (arr.index(x, to_int(start)) if x in arr[to_int(start):] else -1)
    if key == "lastIndexOf":
        return lambda x: (len(arr) - 1 - arr[::-1].index(x) if x in arr else -1)
    if key == "includes":
        return lambda x: x in arr
    if key == "forEach":
        return lambda fn: [js_call(fn, [x, i, arr]) for i, x in enumerate(list(arr))]
    if key == "map":
        return lambda fn: [js_call(fn, [x, i, arr]) for i, x in enumerate(list(arr))]
    if key == "filter":
        return lambda fn: [x for i, x in enumerate(list(arr)) if js_truthy(js_call(fn, [x, i, arr]))]
    if key == "find":
        return lambda fn: next((x for i, x in enumerate(list(arr)) if js_truthy(js_call(fn, [x, i, arr]))), undefined)
    if key == "findIndex":
        return lambda fn: next((i for i, x in enumerate(list(arr)) if js_truthy(js_call(fn, [x, i, arr]))), -1)
    if key == "some":
        return lambda fn: any(js_truthy(js_call(fn, [x, i, arr])) for i, x in enumerate(list(arr)))
    if key == "every":
        return lambda fn: all(js_truthy(js_call(fn, [x, i, arr])) for i, x in enumerate(list(arr)))
    if key == "reduce":
        def _reduce(fn, init=None):
            seq = list(arr)
            if init is None or init is undefined:
                if not seq:
                    return undefined
                acc, seq = seq[0], seq[1:]
            else:
                acc = init
            for i, x in enumerate(seq):
                acc = js_call(fn, [acc, x, i, arr])
            return acc
        return _reduce
    if key == "reverse":
        return lambda: (arr.reverse() or arr)
    if key == "sort":
        return lambda fn=None: (arr.sort() if fn is None or fn is undefined else arr.sort(key=None)) or arr
    if key == "flat":
        def _flat(d=1):
            out = []
            for x in arr:
                out.extend(x if isinstance(x, list) and to_int(d) > 0 else [x])
            return out
        return _flat
    if key == "at":
        return lambda i=0: (arr[to_int(i)] if -len(arr) <= to_int(i) < len(arr) else undefined)
    if key == "fill":
        return lambda v, a=0, b=None: arr.__setitem__(slice(to_int(a), b if b is None else to_int(b)), [v] * len(arr[to_int(a): (len(arr) if b is None or b is undefined else to_int(b))])) or arr
    if key == "keys":
        return lambda: list(range(len(arr)))
    if key == "values":
        return lambda: list(arr)
    if key == "entries":
        return lambda: [[i, x] for i, x in enumerate(arr)]
    if key == "toString":
        return lambda: ",".join(js_to_str(x) for x in arr)
    return undefined


def js_getitem(obj: Any, key: Any) -> Any:
    """obj[key]，含字符串/数组/存储的 JS 原型成员解析与 undefined 语义。"""
    if obj is undefined or obj is None:
        # 对齐 V8 的真实 TypeError 文本。官方 t 的错误槽直接把这个字符串
        # 原样拼进指纹（真实样本 121 字符：
        #  TypeError: Cannot read properties of undefined
        #  (reading 'clientBootstrap')undefined...）。
        # 少 "TypeError: " 前缀与 "(reading 'KEY')" 会让该槽短 70+ 字符。
        raise JSError(v8_type_error(obj, key))
    # PseudoStorage 是 dict 子类，必须先于 dict 分支判定
    if isinstance(obj, PseudoStorage):
        sk = js_to_str(key)
        if sk == "length":
            return len(obj)
        if sk in ("getItem", "setItem", "removeItem", "clear", "key", "keys"):
            return getattr(obj, sk if sk != "keys" else "keys_")
        return obj.getItem(sk)
    if callable(obj) and not isinstance(obj, (type, BoundMethod)):
        if isinstance(key, str) and not _is_index_key(key):
            return _fn_member(obj, key)
    if isinstance(obj, dict):
        if isinstance(key, float) and key.is_integer():
            key = int(key)
        else:
            key = js_to_str(key)
        return obj.get(key, undefined)
    if isinstance(obj, str):
        sk = js_to_str(key)
        if not _is_index_key(sk):
            return _str_member(obj, sk)
        i = to_int(sk)
        return obj[i] if 0 <= i < len(obj) else undefined
    if isinstance(obj, (list, tuple)):
        if not _is_index_key(key):
            return _list_member(obj, js_to_str(key))
        i = to_int(key)
        return obj[i] if 0 <= i < len(obj) else undefined
    if isinstance(key, str) and not _is_index_key(key) and hasattr(obj, key):
        return getattr(obj, key)
    if isinstance(key, str) and hasattr(obj, "getAttribute"):
        return obj.getAttribute(key)
    return undefined


class BoundMethod:
    """op24 (Q)：obj[method].bind(obj)"""

    def __init__(self, obj: Any, name: str):
        self.obj = obj
        self.name = name

    def __call__(self, *args):
        fn = js_getitem(self.obj, self.name)
        return js_call(fn, list(args))

    def __repr__(self):
        return "function () { [native code] }"


class JSError(Exception):
    pass


def v8_type_error(obj: Any, key: Any) -> str:
    """构造 V8 风格的对象属性访问 TypeError 文案。

    V8 实际格式（Chrome 146）：
      Cannot read properties of undefined (reading 'clientBootstrap')
    若 key 是数字索引，V8 用读/写之外的路径但仍带 (reading '0')；
    对象名为 undefined / null 两种前缀。
    """
    who = "undefined" if obj is undefined else "null"
    if isinstance(key, str):
        k = key
    else:
        k = js_to_str(key)
    return "TypeError: Cannot read properties of %s (reading '%s')" % (who, k)


def js_call(fn: Any, args: List[Any]) -> Any:
    if fn is undefined or fn is None:
        raise JSError("not a function")
    if isinstance(fn, BoundMethod):
        return fn(*args)
    if callable(fn):
        return fn(*args)
    raise JSError("not a function")


async def js_call_async(fn: Any, args: List[Any]) -> Any:
    r = js_call(fn, args)
    if hasattr(r, "__await__"):
        return await r
    return r


# ---------------------------------------------------------------------------
# 伪浏览器环境（字节码通过 window[...] 取全局对象）
# ---------------------------------------------------------------------------

def _mk_math() -> Dict[str, Any]:
    """Math 全局对象（surface 必须够全）。

    官方 obt 字节码用 Math.hypot 算指针位移距离；缺失会让调用返回
    undefined，随后 "not a function" 字符串混进算术、产出 NaN，
    直接污染官方 so 的速率槽。
    """
    class _M:
        E = math.e
        LN2 = math.log(2)
        LN10 = math.log(10)
        LOG2E = 1 / math.log(2)
        LOG10E = 1 / math.log(10)
        PI = math.pi
        SQRT1_2 = math.sqrt(0.5)
        SQRT2 = math.sqrt(2)

        @staticmethod
        def abs(x):
            n = to_number(x)
            return num_to_js(abs(n))

        @staticmethod
        def floor(x): return num_to_js(math.floor(to_number(x)))
        @staticmethod
        def ceil(x): return num_to_js(math.ceil(to_number(x)))

        @staticmethod
        def round(x):
            # JS Math.round(-0.5) === -0，且 -1.5 -> -1（向 +Infinity 取半）
            n = to_number(x)
            if n != n or n in (float("inf"), float("-inf")):
                return num_to_js(n)
            return num_to_js(math.floor(n + 0.5))

        @staticmethod
        def trunc(x):
            n = to_number(x)
            if n != n or n in (float("inf"), float("-inf")):
                return num_to_js(n)
            return num_to_js(math.trunc(n))

        @staticmethod
        def sign(x):
            n = to_number(x)
            if n != n:
                return float("nan")
            return num_to_js(0 if n == 0 else (1 if n > 0 else -1))

        @staticmethod
        def random():
            return random.random()

        @staticmethod
        def max(*a):
            vals = [to_number(x) for x in a]
            if not vals:
                return float("-inf")
            if any(v != v for v in vals):
                return float("nan")
            return num_to_js(max(vals))

        @staticmethod
        def min(*a):
            vals = [to_number(x) for x in a]
            if not vals:
                return float("inf")
            if any(v != v for v in vals):
                return float("nan")
            return num_to_js(min(vals))

        @staticmethod
        def pow(a, b):
            try:
                return num_to_js(float(to_number(a)) ** float(to_number(b)))
            except (OverflowError, ValueError):
                return float("inf")

        @staticmethod
        def sqrt(x):
            n = to_number(x)
            if n != n or n < 0:
                return float("nan")
            return num_to_js(math.sqrt(n))

        @staticmethod
        def cbrt(x):
            n = to_number(x)
            if n != n:
                return float("nan")
            return num_to_js(math.copysign(abs(n) ** (1.0 / 3.0), n))

        @staticmethod
        def hypot(*a):
            vals = [to_number(x) for x in a]
            if any(v != v or v in (float("inf"), float("-inf")) for v in vals):
                return float("inf") if any(v in (float("inf"), float("-inf")) for v in vals) else float("nan")
            return num_to_js(math.hypot(*vals) if vals else 0.0)

        @staticmethod
        def exp(x):
            n = to_number(x)
            try:
                return num_to_js(math.exp(n))
            except OverflowError:
                return float("inf")

        @staticmethod
        def expm1(x): return num_to_js(math.expm1(to_number(x)))

        @staticmethod
        def log(x):
            n = to_number(x)
            if n != n or n < 0:
                return float("nan")
            if n == 0:
                return float("-inf")
            return num_to_js(math.log(n))

        @staticmethod
        def log2(x):
            n = to_number(x)
            if n != n or n < 0:
                return float("nan")
            if n == 0:
                return float("-inf")
            return num_to_js(math.log2(n))

        @staticmethod
        def log10(x):
            n = to_number(x)
            if n != n or n < 0:
                return float("nan")
            if n == 0:
                return float("-inf")
            return num_to_js(math.log10(n))

        @staticmethod
        def log1p(x): return num_to_js(math.log1p(to_number(x)))

        @staticmethod
        def sin(x): return num_to_js(math.sin(to_number(x)))
        @staticmethod
        def cos(x): return num_to_js(math.cos(to_number(x)))
        @staticmethod
        def tan(x): return num_to_js(math.tan(to_number(x)))
        @staticmethod
        def asin(x): return num_to_js(math.asin(to_number(x)))
        @staticmethod
        def acos(x): return num_to_js(math.acos(to_number(x)))
        @staticmethod
        def atan(x): return num_to_js(math.atan(to_number(x)))

        @staticmethod
        def atan2(y, x): return num_to_js(math.atan2(to_number(y), to_number(x)))

        @staticmethod
        def sinh(x): return num_to_js(math.sinh(to_number(x)))
        @staticmethod
        def cosh(x): return num_to_js(math.cosh(to_number(x)))
        @staticmethod
        def tanh(x): return num_to_js(math.tanh(to_number(x)))

        @staticmethod
        def fround(x): return num_to_js(float(struct_unpack_f(to_number(x))))

        @staticmethod
        def imul(a, b):
            x = to_int(a) & 0xFFFFFFFF
            y = to_int(b) & 0xFFFFFFFF
            r = (x * y) & 0xFFFFFFFF
            return r - 0x100000000 if r >= 0x80000000 else r

        @staticmethod
        def clz32(x):
            n = to_int(x) & 0xFFFFFFFF
            return 32 if n == 0 else (32 - n.bit_length())

    return _M


def json_stringify(v: Any) -> Any:
    """JSON.stringify 语义（op15 与 JSON.stringify 共用）。

    JS 数字没有 int/float 之分：14.0 必须序列化成 14，否则官方 t 的
    getBoundingClientRect 槽会长出多余的 ".0"。
    undefined / 函数 -> 属性被丢弃（顶层则返回 undefined）。
    """
    def prep(o: Any) -> Any:
        if o is undefined or callable(o):
            return _DROP
        if isinstance(o, bool):
            return o
        if isinstance(o, float):
            if o != o or o in (float("inf"), float("-inf")):
                return None
            return num_to_js(o)
        if isinstance(o, dict):
            out = OrderedMap()
            for k, x in o.items():
                p = prep(x)
                if p is not _DROP:
                    out[js_to_str(k)] = p
            return out
        if isinstance(o, (list, tuple)):
            return [_DROP if (p := prep(x)) is _DROP else p for x in o]
        ts = getattr(o, "toString", None)
        if callable(ts) and not isinstance(o, (str, int)):
            try:
                r = ts()
                if isinstance(r, str):
                    return r
            except Exception:
                pass
        return o

    def conv(o: Any) -> Any:
        ts = getattr(o, "toString", None)
        if callable(ts):
            try:
                r = ts()
                if isinstance(r, str):
                    return r
            except Exception:
                pass
        raise TypeError

    p = prep(v)
    if p is _DROP:
        return undefined
    try:
        return json.dumps(p, ensure_ascii=False, separators=(",", ":"), default=conv)
    except (TypeError, ValueError):
        return None


def _mk_json() -> Dict[str, Any]:
    class _J:
        @staticmethod
        def parse(s):
            t = js_to_str(s)
            try:
                return json.loads(t)
            except Exception:
                raise JSError("JSON.parse failed")

        @staticmethod
        def stringify(v):
            return json_stringify(v)
    return _J


class PseudoElement:
    def __init__(self, tag="div", src=None):
        self.tagName = tag.upper()
        self.nodeName = self.tagName
        self.src = src if src is not None else ""
        self.href = self.src
        self.textContent = ""
        self.innerHTML = ""
        self.children = []
        self.attributes = {}
        self.style = {}
        self.id = ""
        self.className = ""
        self.width = 300
        self.height = 150
        self.parentNode = None
        self._page_url = ""

    def getAttribute(self, k):
        return self.attributes.get(k, None)

    def setAttribute(self, k, v):
        self.attributes[k] = v

    def appendChild(self, c):
        self.children.append(c)
        try:
            c.parentNode = self
        except Exception:
            pass
        return c

    def removeChild(self, c):
        if c in self.children:
            self.children.remove(c)
        return c

    def getContext(self, _kind):
        return None

    def toDataURL(self, *_a):
        return "data:image/png;base64,"

    # 真实 auth 页上的实测布局盒（HAR 逐条比对得到的两个真实矩形）：
    #   /email-verification 19.140625 x 14  @ y=718.6875
    #   /about-you          31.765625 x 29  @ y=569.6875
    # 字节码只问一个匿名 DIV 的盒，故按**页面**分派而非按标签 —— 同一字节码
    # 在两步流程里量的是各自页面上那个主控件。
    _BOX_BY_PAGE = {
        "/email-verification": (19.140625, 14.0, -0.015625, 718.6875),
        "/about-you": (31.765625, 29.0, -0.015625, 569.6875),
    }
    _BOX_DEFAULT = (19.140625, 14.0, -0.015625, 569.6875)

    def getBoundingClientRect(self):
        # 真实 t 的 rect 槽是 DOM 实际布局盒：字段顺序 x,y,width,height,top,right,
        # bottom,left，且 right=x+width / bottom=y+height 自洽。
        # 纯 Python 无排版引擎，按当前页面查实测盒。
        page = js_to_str(getattr(self, "_page_url", "") or "")
        box = None
        for frag, b in self._BOX_BY_PAGE.items():
            if frag in page:
                box = b
                break
        if box is None:
            box = self._BOX_DEFAULT
        w, h, x, y = box
        return {"x": x, "y": y, "width": w, "height": h,
                "top": y, "right": x + w, "bottom": y + h, "left": x}


class PseudoClock:
    """可推进的虚拟时钟：performance.now() 与 Date.now() 同源。

    真实 t/so 的 pos0 是「collector 初始化 -> snapshot 执行」的墙钟时长
    （真实样本 15210.9 / 23693.7 ms），且满足 pos12 - pos11 == pos0。
    纯 Python 瞬时执行该窗口只有 ~105ms —— 等于自报「非人类会话」。
    故这里提供一个可显式推进的时钟：观察窗内 advance(ms) 让两个 API
    同步前进，保持三处同源（TimeOrigin/Date.now/事件 timeStamp 基准）。
    """

    def __init__(self):
        self._base_perf = time.perf_counter()
        self._base_wall = time.time() * 1000.0
        self._offset_ms = 0.0

    def advance(self, ms: float) -> None:
        """把时钟向前推进 ms（用于模拟人类停留时长，不真实 sleep）。"""
        try:
            self._offset_ms += max(0.0, float(ms))
        except Exception:
            pass

    def _elapsed_ms(self) -> float:
        return (time.perf_counter() - self._base_perf) * 1000.0 + self._offset_ms

    def perf_now(self) -> float:
        return self._elapsed_ms()

    def wall_now(self) -> float:
        return self._base_wall + self._elapsed_ms()


class PseudoPerformance:
    def __init__(self, clock: Optional["PseudoClock"] = None):
        self._clock = clock or PseudoClock()
        self._t0 = time.perf_counter()
        self.timeOrigin = time.time() * 1000.0

    def now(self):
        return self._clock.perf_now()

    def getEntriesByType(self, _t=""):
        return []

    def getEntries(self):
        return []

    def measure(self, *a): return None
    def mark(self, *a): return None
    def clearMarks(self, *a): return None
    def clearMeasures(self, *a): return None
    def getEntriesByName(self, *a): return []


class PseudoNavigator:
    def __init__(self):
        self.userAgent = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
                          " (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")
        self.appVersion = "5.0 (Windows NT 10.0; Win64; x64)"
        self.appName = "Netscape"
        self.product = "Gecko"
        self.language = "en-US"
        self.languages = ["en-US", "en"]
        self.platform = "Win32"
        self.hardwareConcurrency = 8
        self.deviceMemory = 8
        self.webdriver = False
        self.vendor = "Google Inc."
        self.vendorSub = ""
        self.productSub = "20030107"
        self.maxTouchPoints = 0
        self.onLine = True
        self.cookieEnabled = True
        self.doNotTrack = None
        self.plugins = []
        self.mimeTypes = []
        self.pdfViewerEnabled = True
        self.userAgentData = {"brands": [], "mobile": False, "platform": "Windows"}

    def javaEnabled(self):
        return False


class PseudoScreen:
    def __init__(self):
        self.width = 1920
        self.height = 1080
        self.availWidth = 1920
        # 真实 t 的 screen 槽：Windows 任务栏占 48px → availHeight 1032，非 1040
        self.availHeight = 1032
        self.colorDepth = 32
        self.pixelDepth = 32
        self.availLeft = 0
        self.availTop = 0
        self.orientation = {"type": "landscape-primary", "angle": 0}


class PseudoDocument:
    def __init__(self, href: str = "https://auth.openai.com/"):
        self.scripts = []
        self.cookie = ""
        self._location = None
        self.readyState = "complete"
        self.hidden = False
        self.visibilityState = "visible"
        self.referrer = ""
        self.URL = href
        self.title = ""
        self.characterSet = "UTF-8"
        self.contentType = "text/html"
        self.documentElement = PseudoElement("html")
        self.body = PseudoElement("body")
        self.head = PseudoElement("head")
        self.currentScript = PseudoElement("script")
        self.documentURI = self.URL
        self.baseURI = self.URL
        self.cookieEnabled = True
        self.forms = []
        self.images = []
        self.links = []
        self.embeds = []
        self.plugins = []

    def getElementById(self, _i):
        return None

    def querySelector(self, _s):
        return None

    def querySelectorAll(self, _s):
        return []

    def getElementsByTagName(self, _t):
        return []

    def getElementsByClassName(self, _c):
        return []

    def getElementsByName(self, _n):
        return []

    def createElement(self, tag):
        e = PseudoElement(tag)
        # 传下当前页 URL：同一字节码在不同 auth 页上量到的控件盒不同
        e._page_url = self.URL
        return e

    def createTextNode(self, s):
        e = PseudoElement("text")
        e.textContent = s
        return e

    def createDocumentFragment(self):
        return PseudoElement("fragment")

    def addEventListener(self, *_a):
        return None

    def removeEventListener(self, *_a):
        return None

    def hasFocus(self):
        return True

    def exitFullscreen(self):
        return None

    @property
    def location(self):
        # 官方 t 的 URL 槽取 document.location.href（当前 auth 页 URL）。
        # 真实样本为 https://auth.openai.com/email-verification
        # 与 .../about-you —— 必须给出完整 href，只给 origin 会短 18-9 字符。
        if isinstance(self._location, PseudoLocation):
            return self._location
        if isinstance(self._location, str):
            return PseudoLocation(self._location)
        return PseudoLocation(self.URL)

    @location.setter
    def location(self, v):
        self._location = v


class PseudoLocation:
    def __init__(self, href="https://auth.openai.com/"):
        self.href = href
        self.protocol = "https:"
        self.host = "auth.openai.com"
        self.hostname = "auth.openai.com"
        self.origin = "https://auth.openai.com"
        self.pathname = "/"
        self.search = ""
        self.hash = ""
        self.port = ""

    def toString(self):
        return self.href


class PseudoHistory:
    def __init__(self):
        self.length = 2
        self.state = None
        self.scrollRestoration = "auto"

    def pushState(self, *a):
        return None

    def replaceState(self, *a):
        return None

    def back(self):
        return None

    def forward(self):
        return None

    def go(self, *a):
        return None


class PseudoStorage(dict):
    """localStorage / sessionStorage。

    真实浏览器里 statsig SDK 会预先写入若干键，官方 obt 字节码
    把它们枚举拼进指纹槽（真实样本：statsig.session_id.* /
    statsig.last_modified_time.evaluations / statsig.cached.evaluations.* /
    statsig.stable_id.*）。伪 DOM 需给同类预置键，否则该槽恒为空。
    """

    def __init__(self, init=None):
        super().__init__(init or {})

    def getItem(self, k):
        # 缺失键返回 JS null（非空串），与浏览器一致
        return self.get(js_to_str(k), None)

    def setItem(self, k, v):
        self[js_to_str(k)] = js_to_str(v)

    def removeItem(self, k):
        self.pop(js_to_str(k), None)

    def clear(self):
        dict.clear(self)

    def key(self, i):
        ks = list(self.keys())
        return ks[i] if 0 <= i < len(ks) else None

    def keys_(self):
        return list(self.keys())


def _noop(*_a, **_k):
    return None


def _mk_console():
    class _C:
        @staticmethod
        def log(*a): return None
        @staticmethod
        def warn(*a): return None
        @staticmethod
        def error(*a): return None
        @staticmethod
        def info(*a): return None
        @staticmethod
        def debug(*a): return None
        @staticmethod
        def table(*a): return None
        @staticmethod
        def trace(*a): return None
    return _C


def _statsig_seed_keys(page_url: str = "") -> Dict[str, str]:
    """真实 auth 页上 statsig SDK 预置的 localStorage 键。

    官方 obt 字节码会把这些键名枚举并拼成指纹槽
    （真实样本例：
     statsig.session_id.444584300,
     statsig.last_modified_time.evaluations,
     statsig.cached.evaluations.2503246393,
     statsig.stable_id.444584300）。
    伪 DOM 若不预置，该槽恒为空串。
    """
    sid = str(random.randint(100000000, 999999999))
    cached = str(random.randint(1000000000, 9999999999))
    # 顺序必须与真实样本一致：槽是按 localStorage 键的枚举顺序拼出来的。
    #   /email-verification : session_id, last_modified_time, cached, stable_id          (133)
    #   /about-you          : session_id, last_modified_time, <hex16>, cached, stable_id (150)
    keys: Dict[str, str] = {
        "statsig.session_id.%s" % sid: "{}",
        "statsig.last_modified_time.evaluations": str(int(time.time() * 1000)),
    }
    # 多出的 16 位 hex 键（如 b8f570c035b1466b）仅在 /about-you 出现。
    # 归属到页面的判断基于 2 个样本，属相关性推断而非确证。
    if "about-you" in (page_url or ""):
        keys["%016x" % random.getrandbits(64)] = "{}"
    keys["statsig.cached.evaluations.%s" % cached] = "[]"
    keys["statsig.stable_id.%s" % sid] = sid
    return keys


def build_window(sdk_version: str = "20260810913b",
                 page_url: str = "https://auth.openai.com/",
                 local_storage: Optional[Dict[str, Any]] = None,
                 clock: Optional["PseudoClock"] = None,
                 fingerprint: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """构造字节码可见的全局 window。

    page_url: 当前 auth 页 URL（官方 t 的 URL 槽取 document.location.href）。
    local_storage: 覆盖默认预置键（不传则用 statsig 预置键）。
    clock: 共享虚拟时钟；传入则 performance.now / Date.now 同源，可 advance。
    """
    w: Dict[str, Any] = {}
    clk = clock or PseudoClock()
    doc = PseudoDocument(page_url)
    nav = PseudoNavigator()
    scr = PseudoScreen()
    fp = fingerprint if isinstance(fingerprint, dict) else {}
    if fp.get("ua"):
        nav.userAgent = str(fp["ua"])
    if fp.get("platform"):
        nav.platform = str(fp["platform"])
    if fp.get("languages"):
        nav.languages = list(fp["languages"])
        nav.language = str(nav.languages[0])
    if fp.get("hardware_concurrency"):
        nav.hardwareConcurrency = int(fp["hardware_concurrency"])
    if fp.get("device_memory"):
        nav.deviceMemory = float(fp["device_memory"])
    screen_fp = fp.get("screen") or {}
    if screen_fp.get("width") and screen_fp.get("height"):
        scr.width = scr.availWidth = int(screen_fp["width"])
        scr.height = int(screen_fp["height"])
        scr.availHeight = max(0, scr.height - 48)
    perf = PseudoPerformance(clk)
    loc = PseudoLocation(page_url)

    sdk_url = "https://sentinel.openai.com/sentinel/%s/sdk.js" % sdk_version
    se = PseudoElement("script", src=sdk_url)
    doc.scripts.append(se)
    doc.currentScript = se
    doc.documentElement.appendChild(PseudoElement("head"))
    doc.documentElement.appendChild(doc.body)

    title = PseudoElement("title")
    title.text = "Sign in"
    doc.head.appendChild(title)
    doc.title = "Sign in - OpenAI"

    w["window"] = w
    w["self"] = w
    w["top"] = w
    w["parent"] = w
    w["globalThis"] = w
    w["frames"] = []
    w["length"] = 0
    w["document"] = doc
    w["navigator"] = nav
    w["screen"] = scr
    w["performance"] = perf
    w["location"] = loc
    w["history"] = PseudoHistory()
    _ls = dict(_statsig_seed_keys(page_url))
    if local_storage:
        _ls.update(local_storage)
    w["localStorage"] = PseudoStorage(_ls)
    w["sessionStorage"] = PseudoStorage()
    w["console"] = _mk_console()
    w["Math"] = _mk_math()
    w["JSON"] = _mk_json()
    w["Reflect"] = _mk_reflect()
    w["Object"] = _mk_object()
    w["Array"] = _mk_array()
    w["String"] = _mk_string()
    w["Number"] = _mk_number()
    w["Boolean"] = _mk_boolean()
    w["Date"] = _mk_date(clk, fp.get("timezone"))
    w["Promise"] = _mk_promise()
    w["RegExp"] = object()
    w["Error"] = _mk_error()
    w["Symbol"] = object()
    w["Map"] = OrderedMap
    w["Set"] = list
    w["WeakMap"] = OrderedMap
    w["WeakSet"] = list
    w["Uint8Array"] = list
    w["Int8Array"] = list
    w["Float64Array"] = list
    w["ArrayBuffer"] = list
    w["DataView"] = object()
    w["TextEncoder"] = _mk_textencoder()
    w["TextDecoder"] = _mk_textdecoder()
    w["URL"] = _mk_url()
    w["URLSearchParams"] = _mk_urlsearch()
    w["Blob"] = object()
    w["FormData"] = object()
    w["Headers"] = OrderedMap
    w["Request"] = object()
    w["Response"] = object()
    w["AbortController"] = object()
    w["AbortSignal"] = object()
    w["Event"] = _mk_event()
    w["CustomEvent"] = _mk_event()
    w["EventTarget"] = object()
    w["MessageChannel"] = object()
    w["MessagePort"] = object()
    w["isNaN"] = lambda v: to_number(v) != to_number(v)
    w["isFinite"] = lambda v: math.isfinite(to_number(v))
    w["parseInt"] = _parse_int
    w["parseFloat"] = lambda v: to_number(v)
    w["encodeURIComponent"] = _encode_uri_component
    w["decodeURIComponent"] = _decode_uri_component
    w["escape"] = lambda s: js_to_str(s)
    w["unescape"] = lambda s: js_to_str(s)
    w["btoa"] = b64_encode_latin1
    w["atob"] = b64_decode_latin1
    w["setTimeout"] = _set_timeout
    w["clearTimeout"] = _noop
    w["setInterval"] = _noop
    w["clearInterval"] = _noop
    w["queueMicrotask"] = _noop
    w["requestAnimationFrame"] = _noop
    w["cancelAnimationFrame"] = _noop
    w["fetch"] = _noop
    w["XHR"] = object()
    w["addEventListener"] = _noop
    w["removeEventListener"] = _noop
    w["dispatchEvent"] = _noop
    w["postMessage"] = _noop
    w["getComputedStyle"] = lambda e: e.style if hasattr(e, "style") else {}
    w["matchMedia"] = _mk_matchmedia()
    pixel_ratio = float(screen_fp.get("px_ratio") or 1.0)
    w["devicePixelRatio"] = pixel_ratio
    w["innerWidth"] = scr.width
    w["innerHeight"] = max(0, scr.availHeight - 52)
    w["outerWidth"] = scr.width
    w["outerHeight"] = scr.height
    w["screenX"] = 0
    w["screenY"] = 0
    w["screenLeft"] = 0
    w["screenTop"] = 0
    w["pageXOffset"] = 0
    w["pageYOffset"] = 0
    w["scrollX"] = 0
    w["scrollY"] = 0
    w["devicePixelRatio"] = pixel_ratio
    w["isSecureContext"] = True
    w["crossOriginIsolated"] = False
    w["origin"] = loc.origin
    w["name"] = ""
    w["closed"] = False
    w["opener"] = None
    w["chrome"] = {"runtime": OrderedMap(), "loadTimes": _noop, "csi": _noop}
    w["crypto"] = _mk_crypto()
    w["indexedDB"] = None
    w["external"] = OrderedMap()
    w["speechSynthesis"] = OrderedMap()
    w["visualViewport"] = OrderedMap()
    w["CSS"] = OrderedMap()
    w["Notification"] = _noop
    w["Worker"] = _noop
    w["SharedWorker"] = _noop
    w["ServiceWorker"] = _noop
    w["WebSocket"] = _noop
    w["XMLHttpRequest"] = _noop
    w["MutationObserver"] = _noop
    w["IntersectionObserver"] = _noop
    w["ResizeObserver"] = _noop
    w["performanceObserver"] = _noop
    w["Intl"] = OrderedMap()
    w["undefined"] = undefined
    return w


# ---------------------------------------------------------------------------
# 各 JS 内建对象的最小实现
# ---------------------------------------------------------------------------

def _mk_reflect():
    """JS Reflect：字节码用它给对象写属性。"""
    class _R:
        @staticmethod
        def set(t, k, v):
            kk = k if isinstance(k, (int, float)) and not isinstance(k, bool) else js_to_str(k)
            if isinstance(t, dict):
                t[kk] = v
            elif isinstance(t, list):
                i = to_int(kk)
                while len(t) <= i:
                    t.append(None)
                t[i] = v
            elif hasattr(t, "__dict__"):
                setattr(t, js_to_str(kk), v)
            return True

        @staticmethod
        def get(t, k, recv=None):
            try:
                return js_getitem(t, k)
            except Exception:
                return undefined

        @staticmethod
        def has(t, k):
            try:
                return js_getitem(t, k) is not undefined
            except Exception:
                return False

        @staticmethod
        def deleteProperty(t, k):
            if isinstance(t, dict):
                t.pop(k, None)
                t.pop(js_to_str(k), None)
            return True

        @staticmethod
        def ownKeys(t):
            if isinstance(t, dict):
                return list(t.keys())
            if hasattr(t, "__dict__"):
                return [x for x in t.__dict__ if not x.startswith("_")]
            return []

        @staticmethod
        def defineProperty(t, k, d):
            v = d.get("value", undefined) if isinstance(d, dict) else undefined
            return _R.set(t, k, v)

        @staticmethod
        def getOwnPropertyDescriptor(t, k):
            v = js_getitem(t, k)
            if v is undefined:
                return undefined
            return {"value": v, "writable": True, "enumerable": True, "configurable": True}

        @staticmethod
        def apply(fn, this, args):
            return js_call(fn, list(args) if isinstance(args, (list, tuple)) else [])

        @staticmethod
        def construct(fn, args):
            return js_call(fn, list(args) if isinstance(args, (list, tuple)) else [])

        @staticmethod
        def getPrototypeOf(t):
            return None

        @staticmethod
        def setPrototypeOf(t, pr):
            return True

        @staticmethod
        def isExtensible(t):
            return True

        @staticmethod
        def preventExtensions(t):
            return True

        @staticmethod
        def defineProperties(t, ds):
            return t
    return _R



def _mk_object():
    class _O:
        @staticmethod
        def keys(o):
            if isinstance(o, dict):
                return [k for k in o.keys() if not isinstance(k, int) or True]
            if hasattr(o, "__dict__"):
                return [k for k in o.__dict__ if not k.startswith("_")]
            return []
        @staticmethod
        def values(o):
            if isinstance(o, dict):
                return list(o.values())
            if hasattr(o, "__dict__"):
                return [v for k, v in o.__dict__.items() if not k.startswith("_")]
            return []
        @staticmethod
        def entries(o):
            return [[k, v] for k, v in zip(_O.keys(o), _O.values(o))]
        @staticmethod
        def assign(t, *srcs):
            for s in srcs:
                if isinstance(s, dict):
                    t.update(s)
            return t
        @staticmethod
        def create(proto):
            return OrderedMap()
        @staticmethod
        def defineProperty(o, k, desc):
            if isinstance(o, dict) and isinstance(desc, dict) and "value" in desc:
                o[k] = desc["value"]
            return o
        @staticmethod
        def getOwnPropertyNames(o):
            return _O.keys(o)
        @staticmethod
        def getPrototypeOf(o):
            return None
        @staticmethod
        def freeze(o):
            return o
        @staticmethod
        def fromEntries(e):
            d = OrderedMap()
            for kv in e:
                d[kv[0]] = kv[1]
            return d
    return _O


def _mk_array():
    class _A:
        @staticmethod
        def isArray(v):
            return isinstance(v, list)
        @staticmethod
        def from_(v):
            if isinstance(v, (list, tuple)):
                return list(v)
            if isinstance(v, str):
                return list(v)
            if isinstance(v, dict):
                return list(v.keys())
            return []
        @staticmethod
        def of(*a):
            return list(a)
    setattr(_A, "from", _A.from_)
    return _A


def _mk_string():
    class _S:
        @staticmethod
        def fromCharCode(*a):
            return "".join(chr(to_int(x) & 0xFFFF) for x in a)
        @staticmethod
        def fromCodePoint(*a):
            return "".join(chr(to_int(x)) for x in a)
    return _S


def _mk_number():
    class _N:
        MAX_SAFE_INTEGER = 9007199254740991
        MIN_SAFE_INTEGER = -9007199254740991
        MAX_VALUE = 1.7976931348623157e308
        MIN_VALUE = 5e-324
        EPSILON = 2.220446049250313e-16
        POSITIVE_INFINITY = float("inf")
        NEGATIVE_INFINITY = float("-inf")
        NaN = float("nan")

        @staticmethod
        def isInteger(v):
            if isinstance(v, bool):
                return False
            if isinstance(v, int):
                return True
            if isinstance(v, float):
                return v == v and v not in (float("inf"), float("-inf")) and v.is_integer()
            return False

        @staticmethod
        def isSafeInteger(v):
            if not _N.isInteger(v):
                return False
            return abs(to_number(v)) <= 9007199254740991

        @staticmethod
        def isFinite(v):
            n = to_number(v)
            return math.isfinite(n)

        @staticmethod
        def isNaN(v):
            n = to_number(v)
            return n != n

        @staticmethod
        def parseFloat(v):
            return to_number(v)

        @staticmethod
        def parseInt(v, r=10):
            return _parse_int(v, r)
    return _N


def _mk_boolean():
    class _B:
        @staticmethod
        def isBoolean(v):
            return isinstance(v, bool)
    return _B


def _mk_date(clock: Optional["PseudoClock"] = None, timezone_name: Optional[str] = None):
    import datetime
    from zoneinfo import ZoneInfo

    _clk = clock or PseudoClock()
    try:
        _timezone = ZoneInfo(timezone_name or "America/New_York")
    except Exception:
        _timezone = ZoneInfo("UTC")

    class _D:
        @staticmethod
        def now():
            return int(_clk.wall_now())
        @staticmethod
        def parse(s):
            return 0
        def __init__(self, *_a):
            self._v = int(_clk.wall_now())

        def getTime(self):
            return self._v

        def toISOString(self):
            value = datetime.datetime.fromtimestamp(
                self._v / 1000.0, datetime.timezone.utc
            )
            return value.isoformat(timespec="milliseconds").replace("+00:00", "Z")

        def getTimezoneOffset(self):
            value = datetime.datetime.fromtimestamp(self._v / 1000.0, _timezone)
            return -int(value.utcoffset().total_seconds() // 60)

        def toString(self):
            value = datetime.datetime.fromtimestamp(self._v / 1000.0, _timezone)
            offset = value.strftime("%z") or "+0000"
            label = value.tzname() or str(_timezone)
            return value.strftime(
                f"%a %b %d %Y %H:%M:%S GMT{offset} ({label})"
            )
    return _D


def _mk_promise():
    class _P:
        @staticmethod
        def resolve(v=None):
            return _Resolved(v)
        @staticmethod
        def reject(v=None):
            return _Rejected(v)
        @staticmethod
        def all(vs):
            return _Resolved([getattr(v, "value", v) for v in vs])

        def __init__(self, fn=None):
            self.value = None
            if callable(fn):
                try:
                    fn(lambda v: setattr(self, "value", v), lambda e: None)
                except Exception:
                    pass
    return _P


class _Resolved:
    def __init__(self, v):
        self.value = v
        self._ok = True
        self._rej = False

    def __await__(self):
        async def _g():
            return self.value
        return _g().__await__()

    def then(self, onf=None, onr=None):
        return _Resolved(onf(self.value) if callable(onf) else self.value)

    def catch(self, onr=None):
        return self

    def finally_(self, onf=None):
        if callable(onf):
            onf()
        return self


class _Rejected:
    def __init__(self, v):
        self.value = v

    def __await__(self):
        async def _g():
            raise JSError(js_to_str(self.value))
        return _g().__await__()

    def then(self, onf=None, onr=None):
        if callable(onr):
            return _Resolved(onr(self.value))
        return self

    def catch(self, onr=None):
        if callable(onr):
            return _Resolved(onr(self.value))
        return _Resolved(None)

    def finally_(self, onf=None):
        if callable(onf):
            onf()
        return self


def _mk_error():
    class _E(Exception):
        def __init__(self, msg=""):
            super().__init__(js_to_str(msg))
            self.message = js_to_str(msg)
            self.name = "Error"
            self.stack = "Error: " + self.message

        def toString(self):
            return "Error: " + self.message
    return _E


def _mk_textencoder():
    class _TE:
        encoding = "utf-8"

        def encode(self, s):
            return list(js_to_str(s).encode("utf-8"))
    return _TE


def _mk_textdecoder():
    class _TD:
        def decode(self, b):
            if isinstance(b, (list, tuple)):
                return bytes(x & 0xFF for x in b).decode("utf-8", "replace")
            return js_to_str(b)
    return _TD


def _mk_url():
    class _U:
        def __init__(self, href, base=None):
            self.href = js_to_str(href)
            self.searchParams = _mk_urlsearch()(self.href.split("?")[1] if "?" in self.href else "")
            self.origin = ""
            self.pathname = "/"
            self.search = ""
            self.hash = ""
            try:
                import urllib.parse as up
                p = up.urlparse(self.href)
                self.protocol = p.scheme + ":"
                self.host = p.netloc
                self.hostname = p.hostname or ""
                self.port = str(p.port or "")
                self.origin = "%s://%s" % (p.scheme, p.netloc)
                self.pathname = p.path or "/"
                self.search = ("?" + p.query) if p.query else ""
                self.hash = ("#" + p.fragment) if p.fragment else ""
            except Exception:
                pass

        def toString(self):
            return self.href
    return _U


def _mk_urlsearch():
    class _US:
        def __init__(self, init=""):
            self._d = OrderedMap()
            if init:
                if isinstance(init, str):
                    for pair in init.lstrip("?").split("&"):
                        if not pair:
                            continue
                        if "=" in pair:
                            k, v = pair.split("=", 1)
                            self._d[k] = _urldec(v)
                        else:
                            self._d[pair] = ""
                elif isinstance(init, dict):
                    for k, v in init.items():
                        self._d[js_to_str(k)] = js_to_str(v)
                elif isinstance(init, list):
                    for pair in init:
                        if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                            self._d[js_to_str(pair[0])] = js_to_str(pair[1])

        def get(self, k):
            return self._d.get(js_to_str(k), None)

        def has(self, k):
            return js_to_str(k) in self._d

        def set(self, k, v):
            self._d[js_to_str(k)] = js_to_str(v)

        def append(self, k, v):
            self._d[js_to_str(k)] = js_to_str(v)

        def delete(self, k):
            self._d.pop(js_to_str(k), None)

        def keys(self):
            return list(self._d.keys())

        def values(self):
            return list(self._d.values())

        def entries(self):
            return [[k, v] for k, v in self._d.items()]

        def toString(self):
            return "&".join("%s=%s" % (k, v) for k, v in self._d.items())
    return _US


def _mk_event():
    class _Ev:
        def __init__(self, type_="event", init=None):
            self.type = js_to_str(type_) if type_ is not undefined else "event"
            self.isTrusted = True
            self.bubbles = False
            self.cancelable = False
            self.defaultPrevented = False
            self.timeStamp = 0.0
            if isinstance(init, dict):
                for k, v in init.items():
                    setattr(self, k, v)

        def preventDefault(self):
            self.defaultPrevented = True

        def stopPropagation(self):
            return None

        def stopImmediatePropagation(self):
            return None
    return _Ev


def _mk_crypto():
    class _C:
        @staticmethod
        def getRandomValues(arr):
            import os
            if isinstance(arr, list):
                for i in range(len(arr)):
                    arr[i] = os.urandom(1)[0]
                return arr
            return arr
        @staticmethod
        def randomUUID():
            import uuid as _u
            return str(_u.uuid4())
    return _C


def _mk_matchmedia():
    class _MM:
        def __init__(self, q):
            self.media = js_to_str(q)
            self.matches = False

        def addListener(self, *_a):
            return None

        def removeListener(self, *_a):
            return None

        def addEventListener(self, *_a):
            return None

        def removeEventListener(self, *_a):
            return None
    return _MM


SUBS = {}


def _set_timeout(fn, _ms=0):
    SUBS["n"] = SUBS.get("n", 0) + 1
    if callable(fn):
        try:
            fn({"timeRemaining": lambda: 1, "didTimeout": False})
        except Exception:
            pass
    return SUBS["n"]


def _parse_int(v, radix=10):
    s = js_to_str(v).strip()
    try:
        r = to_int(radix) or 10
        sign = 1
        if s.startswith("-"):
            sign = -1
            s = s[1:]
        elif s.startswith("+"):
            s = s[1:]
        digits = "0123456789abcdefghijklmnopqrstuvwxyz"[:r]
        acc = 0
        got = False
        for ch in s.lower():
            if ch not in digits:
                break
            acc = acc * r + digits.index(ch)
            got = True
        return sign * acc if got else float("nan")
    except Exception:
        return float("nan")


def _encode_uri_component(s):
    import urllib.parse as up
    return up.quote(js_to_str(s), safe="!'()*-._~")


def _decode_uri_component(s):
    import urllib.parse as up
    return up.unquote(js_to_str(s))


def _urldec(s):
    import urllib.parse as up
    return up.unquote_plus(s)


# ---------------------------------------------------------------------------
# VM 核心 —— 逐条对应 research/sdk_opcodes_deobf.json
# ---------------------------------------------------------------------------

class SentinelVM:
    """官方 sdk.js@20260810913b 的 obt 字节码解释器（纯 Python）。

    只实现 opcode 语义与伪 window；不含任何业务字段逻辑。
    """

    QUEUE = 9      # tt
    WINDOW = 10    # nt
    SEED = 16      # st

    def __init__(self, sdk_version: str = "20260810913b",
                 page_url: str = "https://auth.openai.com/",
                 clock: Optional["PseudoClock"] = None,
                 fingerprint: Optional[Dict[str, Any]] = None):
        self.clock = clock or PseudoClock()
        self.window = build_window(
            sdk_version, page_url=page_url, clock=self.clock, fingerprint=fingerprint
        )
        self.m = OrderedMap()
        self.m[self.WINDOW] = self.window
        self._result: Any = None
        self._error: Any = None
        self._settled = False
        self.steps = 0
        self.depth = 0
        self._install()

    # ---- 队列 ----
    def _queue(self) -> List[Any]:
        q = self.m.get(self.QUEUE)
        if not isinstance(q, list):
            q = []
            self.m[self.QUEUE] = q
        return q

    def _resolve(self, v: Any) -> None:
        if not self._settled:
            self._settled = True
            self._result = v

    def _reject(self, v: Any) -> None:
        if not self._settled:
            self._settled = True
            self._error = v

    async def _run_queue(self) -> None:
        """对应官方 Pt()。"""
        self.depth += 1
        if self.depth > 60:
            raise JSError("max depth")
        try:
            while True:
                q = self.m.get(self.QUEUE)
                if not isinstance(q, list) or not q:
                    break
                instr = q.pop(0)
                if not isinstance(instr, list) or not instr:
                    continue
                op = instr[0]
                args = instr[1:]
                fn = self.m.get(op)
                if fn is undefined or fn is None or not callable(fn):
                    self.steps += 1
                    continue
                res = fn(*args)
                if hasattr(res, "__await__"):
                    await res
                self.steps += 1
        finally:
            self.depth -= 1

    # ------------------------------------------------------------------
    def _install(self) -> None:
        M = self.m

        def op_0(dx):                        # [0] W = qt : 嵌套执行 dx
            seed = js_to_str(M.get(self.SEED))
            raw = b64_decode_latin1(dx)
            payload = js_xor(raw, seed)
            M[self.QUEUE] = json.loads(payload)
            return self._run_queue()

        def op_1(n, e):                      # [1] z : XOR
            M[n] = js_xor(js_to_str(M.get(n)), js_to_str(M.get(e)))
            return None

        def op_2(n, v):                      # [2] H : 存字面量
            M[n] = v
            return None

        def op_3(v):                         # [3] V : resolve(btoa(v))
            self._resolve(b64_encode_latin1(v))
            return None

        def op_4(v):                         # [4] B : reject(btoa(v))
            self._reject(b64_encode_latin1(v))
            return None

        def op_5(n, e):                      # [5] Z : push 或 +
            o = M.get(n)
            ev = M.get(e)
            if isinstance(o, list):
                o.append(ev)
            else:
                M[n] = js_plus(o, ev)
            return None

        def op_6(n, e, r):                   # [6] K : 取属性
            M[n] = js_getitem(M.get(e), M.get(r))
            return None

        async def op_7(n, *e):               # [7] Y : 调用（参数解引用）
            return await js_call_async(M.get(n), [M.get(x) for x in e])

        def op_8(n, e):                      # [8] X : 复制
            M[n] = M.get(e)
            return None

        def op_11(n, e):                     # [11] et : scripts 匹配
            # 官方语义：
            #   (Array.from(document.scripts||[])
            #      .map(s => s?.src?.match(At.get(e)))   // match 接收 RegExp
            #      .filter(s => s?.["length"])[0] ?? [])[0] ?? null
            # 注意 src.match(x) 在 JS 里对标量子串不成立 —— 必须按正则匹配，
            # 否则 sdk.js 的 script 永远匹配失败，字节码会退回 '/sdk.js' 分支，
            # 导致 t 的版本槽为空。
            try:
                pat = M.get(e)
                out = None
                for sc in getattr(self.window.get("document"), "scripts", []) or []:
                    src = getattr(sc, "src", "")
                    if not src:
                        continue
                    m = _simple_match(js_to_str(src), pat)
                    if m and js_getitem(m, "length"):
                        out = js_getitem(m, 0)
                        break
                M[n] = out
            except Exception:
                M[n] = None
            return None

        def op_12(n):                        # [12] rt : 暴露映射
            M[n] = M
            return None

        async def op_13(n, e, *r):           # [13] ot : try 调用（参数原样）
            try:
                await js_call_async(M.get(e), list(r))
            except Exception as exc:
                M[n] = js_to_str(exc)
            return None

        def op_14(n, e):                     # [14] ct : JSON.parse
            M[n] = json.loads(js_to_str(M.get(e)))
            return None

        def op_15(n, e):                     # [15] it : JSON.stringify
            M[n] = json_stringify(M.get(e))
            return None

        async def op_17(n, e, *r):           # [17] ut : 调用 + then/catch（参数解引用）
            try:
                res = js_call(M.get(e), [M.get(x) for x in r])
                if isinstance(res, (_Resolved, _Rejected)):
                    try:
                        M[n] = await res
                    except Exception as exc:
                        M[n] = js_to_str(exc)
                    return None
                if hasattr(res, "__await__"):
                    try:
                        M[n] = await res
                    except Exception as exc:
                        M[n] = js_to_str(exc)
                    return None
                M[n] = res
            except Exception as exc:
                M[n] = js_to_str(exc)
            return None

        def op_18(n):                        # [18] at : atob
            M[n] = b64_decode_latin1(M.get(n))
            return None

        def op_19(n):                        # [19] lt : btoa
            M[n] = b64_encode_latin1(M.get(n))
            return None

        async def op_20(n, e, r, *o):        # [20] dt : 相等则调用（参数原样）
            if M.get(n) == M.get(e):
                return await js_call_async(M.get(r), list(o))
            return None

        async def op_21(n, e, r, o, *c):     # [21] ht : 差值超阈值则调用
            a, b = to_number(M.get(n)), to_number(M.get(e))
            if abs(a - b) > to_number(M.get(r)):
                return await js_call_async(M.get(o), list(c))
            return None

        async def op_22(n, e):               # [22] pt : 子队列执行
            saved = list(self._queue())
            self.m[self.QUEUE] = list(e if isinstance(e, list) else [])
            try:
                await self._run_queue()
            except Exception as exc:
                M[n] = js_to_str(exc)
            finally:
                self.m[self.QUEUE] = saved
            return None

        async def op_23(n, e, *r):           # [23] ft : 已定义则调用（参数原样）
            if M.get(n) is not undefined:
                return await js_call_async(M.get(e), list(r))
            return None

        def op_24(n, e, r):                  # [24] Q : 绑定方法
            M[n] = BoundMethod(M.get(e), js_to_str(M.get(r)))
            return None

        def op_25(*_a):                      # [25] mt : 空
            return None

        def op_26(*_a):                      # [26] wt : 空
            return None

        def op_27(n, e):                     # [27] gt : 弹出 / 相减
            o = M.get(n)
            if isinstance(o, list):
                try:
                    o.remove(M.get(e))
                except ValueError:
                    pass
            else:
                M[n] = num_to_js(to_number(o) - to_number(M.get(e)))
            return None

        def op_28(*_a):                      # [28] yt : 空
            return None

        def op_29(n, e, r):                  # [29] vt : 小于
            M[n] = to_number(M.get(e)) < to_number(M.get(r))
            return None

        async def op_30(t, n, e, r=None):    # [30] bt : 定义闭包
            as_fn = isinstance(r, list)
            params = e if as_fn else []
            body = r if as_fn else e
            body = body if isinstance(body, list) else []

            async def _closure(*call_args):
                saved = list(self._queue())
                try:
                    for i, slot in enumerate(params or []):
                        M[slot] = call_args[i] if i < len(call_args) else undefined
                    self.m[self.QUEUE] = list(body)
                    try:
                        await self._run_queue()
                    except Exception as exc:
                        return js_to_str(exc)
                    finally:
                        self.m[self.QUEUE] = saved
                    return M.get(n)
                finally:
                    self.m[self.QUEUE] = saved

            M[t] = _closure
            return None

        def op_33(n, e, r):                  # [33] St : 相乘
            M[n] = num_to_js(js_mul(to_number(M.get(e)), to_number(M.get(r))))
            return None

        async def op_34(n, e):               # [34] Ct : Promise.resolve(...).then(set)
            value = M.get(e)
            if hasattr(value, "__await__"):
                value = await value
            M[n] = value
            return None

        def op_35(n, e, r):                  # [35] kt : 除数为零时写 0
            numerator = to_number(M.get(e))
            denominator = to_number(M.get(r))
            M[n] = 0 if denominator == 0 else num_to_js(js_div(numerator, denominator))
            return None

        for slot, fn in ((0, op_0), (1, op_1), (2, op_2), (3, op_3), (4, op_4),
                         (5, op_5), (6, op_6), (7, op_7), (8, op_8),
                         (11, op_11), (12, op_12), (13, op_13), (14, op_14), (15, op_15),
                         (17, op_17), (18, op_18), (19, op_19), (20, op_20), (21, op_21),
                         (22, op_22), (23, op_23), (24, op_24), (25, op_25), (26, op_26),
                         (27, op_27), (28, op_28), (29, op_29), (30, op_30),
                         (33, op_33), (34, op_34), (35, op_35)):
            M[slot] = fn

    # ------------------------------------------------------------------
    # 官方入口 Et(dx, seed)
    # ------------------------------------------------------------------
    async def run_async(self, dx: str, seed: Optional[Any] = None,
                        reinit: bool = True):
        if reinit:
            self.m = OrderedMap()
            self.m[self.WINDOW] = self.window
            self._install()
            self.m[self.QUEUE] = []
        if seed is not None:
            self.m[self.SEED] = seed
        self._settled = False
        self._result = None
        self._error = None

        raw = b64_decode_latin1(dx)
        payload = js_xor(raw, js_to_str(self.m.get(self.SEED)))
        self.m[self.QUEUE] = json.loads(payload)
        try:
            await self._run_queue()
        except Exception as exc:
            self._reject("VM: %s" % exc)
        return self._result

    def run(self, dx: str, seed: Optional[Any] = None, reinit: bool = True):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            return asyncio.run(self.run_async(dx, seed=seed, reinit=reinit))

        import threading

        result: Dict[str, Any] = {}

        def _worker():
            try:
                result["value"] = asyncio.run(
                    self.run_async(dx, seed=seed, reinit=reinit)
                )
            except BaseException as exc:
                result["error"] = exc

        thread = threading.Thread(target=_worker, daemon=True)
        thread.start()
        thread.join()
        if "error" in result:
            raise result["error"]
        return result.get("value")

    def last_error(self):
        return self._error


class EventedSentinelVM(SentinelVM):
    """带事件分发的 VM。

    collector_dx 只做两件事：注册 7 类事件监听器 + 把 __oai_so_* 计数器清零。
    so 的值来自监听器在观察窗内累加的结果，因此必须真正派发事件。
    """

    def __init__(self, sdk_version: str = "20260810913b",
                 page_url: str = "https://auth.openai.com/",
                 clock: Optional["PseudoClock"] = None,
                 fingerprint: Optional[Dict[str, Any]] = None):
        super().__init__(
            sdk_version, page_url=page_url, clock=clock, fingerprint=fingerprint
        )
        self.listeners: Dict[str, List[Any]] = {}
        # 事件 timeStamp 与 performance.now/Date.now 同源，避免三处互相矛盾
        self._clock_ms = 0.0
        # 每个事件的平均推进量（ms），由 simulate_session 按目标观察窗时长设定
        self._pace_ms = 40.0

        def add_event_listener(t, fn=None, *_r):
            if fn is not None:
                self.listeners.setdefault(js_to_str(t), []).append(fn)
            return None

        def remove_event_listener(*_a):
            return None

        self.window["addEventListener"] = add_event_listener
        self.window["removeEventListener"] = remove_event_listener
        doc = self.window.get("document")
        if doc is not None:
            doc.addEventListener = add_event_listener
            doc.removeEventListener = remove_event_listener

    def fire(self, event_type: str, times: int = 1,
             payload: Optional[Dict[str, Any]] = None):
        """向已注册监听器派发事件。

        timeStamp 单调递增：官方 scroll/wheel 速率槽用相邻事件的
        timeStamp 差做分母，若恒定则算出 0/0 = NaN 并污染 so。
        payload 里的可调用值按事件序号取参，便于给每次事件不同坐标。
        """
        handlers = self.listeners.get(js_to_str(event_type), [])
        if not handlers:
            return 0
        for i in range(max(0, int(times))):
            # 事件 timeStamp 走**独立**的事件时钟：真实样本里事件间隔是毫秒级
            # （pos17=148.4ms），而观察窗长达 15~24s —— 说明窗口大部分是静止的，
            # 窗口时长 != 事件间隔之和。二者必须分开，否则 pos17 会长到比窗口还大。
            self._clock_ms += random.uniform(4.0, 40.0)
            ev: Dict[str, Any] = {
                "type": event_type,
                "isTrusted": True,
                "timeStamp": self._clock_ms,
                "target": self.window.get("document"),
                "currentTarget": self.window,
            }
            # payload 可以是 dict，也可以是「按事件序号生成 dict」的工厂
            p = payload(i) if callable(payload) else payload
            if p:
                for k, v in p.items():
                    ev[k] = v(i) if callable(v) else v
            for fn in list(handlers):
                try:
                    r = js_call(fn, [ev])
                    if hasattr(r, "__await__"):
                        loop = asyncio.new_event_loop()
                        try:
                            loop.run_until_complete(r)
                        finally:
                            loop.close()
                except Exception:
                    pass
        return len(handlers)

    # 真实观察窗时长区间（ms）：摘自 HAR 两处真实 so 的 pos0
    #   email_otp_validate 15210.9 / oauth_create_account 23693.7
    OBSERVER_SPAN_MS = (15000.0, 24500.0)

    def simulate_session(self, collect_ms: float = 5000.0,
                         span_ms: Optional[float] = None) -> Dict[str, Any]:
        """按真实观察窗时长派发人类风格的输入序列。

        官方 obt 计数器读的是「事件序列的形状」：位移增量、时间增量、
        按键修饰符。因此必须给出变化的坐标与递增的 timeStamp，
        固定坐标会让速率槽 0/0 变成 NaN。

        span_ms: 目标观察窗墙钟时长。不传则从真实区间抽样。
        事件条数按 collect_ms 定，时长按 span_ms 定，二者独立 ——
        这样 pos0（时长）落在人类区间，同时事件计数形状保持不变。
        """
        n = max(0.0, float(collect_ms)) / 1000.0
        if span_ms is None:
            lo, hi = self.OBSERVER_SPAN_MS
            span_ms = random.uniform(lo, hi)
        scr = self.window.get("screen")
        w = float(getattr(scr, "width", 1920) or 1920)
        h = float(getattr(scr, "height", 1080) or 1080)
        pos = [random.uniform(w * 0.3, w * 0.7), random.uniform(h * 0.3, h * 0.7)]
        keys = "abcdefghijklmnopqrstuvwxyz0123456789"

        def _pointer(_i: int) -> Dict[str, Any]:
            pos[0] = min(max(0.0, pos[0] + random.uniform(-40, 40)), w - 1)
            pos[1] = min(max(0.0, pos[1] + random.uniform(-30, 30)), h - 1)
            return {"clientX": pos[0], "clientY": pos[1], "pageX": pos[0],
                    "pageY": pos[1], "screenX": pos[0], "screenY": pos[1],
                    "movementX": random.uniform(-5, 5),
                    "movementY": random.uniform(-5, 5),
                    "pointerType": "mouse", "buttons": 0, "button": -1,
                    "altKey": False, "ctrlKey": False, "metaKey": False,
                    "shiftKey": False}

        def _click(_i: int) -> Dict[str, Any]:
            return {"clientX": pos[0], "clientY": pos[1], "pageX": pos[0],
                    "pageY": pos[1], "screenX": pos[0], "screenY": pos[1],
                    "button": 0, "buttons": 1, "detail": 1,
                    "altKey": False, "ctrlKey": False, "metaKey": False,
                    "shiftKey": False}

        def _key(_i: int) -> Dict[str, Any]:
            k = random.choice(keys)
            return {"key": k, "code": "Key" + k.upper(), "keyCode": ord(k),
                    "which": ord(k), "altKey": False, "ctrlKey": False,
                    "metaKey": False, "shiftKey": False,
                    "repeat": False, "isComposing": False}

        def _wheel(_i: int) -> Dict[str, Any]:
            return {"clientX": pos[0], "clientY": pos[1],
                    "deltaX": random.uniform(-10, 10),
                    "deltaY": random.uniform(30, 120),
                    "deltaZ": 0, "deltaMode": 0,
                    "altKey": False, "ctrlKey": False, "metaKey": False,
                    "shiftKey": False}

        plan = (
            ("pointermove", max(8, int(16 * n)), _pointer),
            ("keydown", max(4, int(7 * n)), _key),
            ("click", max(1, int(2 * n)), _click),
            ("scroll", max(2, int(4 * n)), _pointer),
            ("wheel", max(1, int(3 * n)), _wheel),
            ("input", max(1, int(3 * n)), _key),
        )
        done: Dict[str, Any] = {}
        for t, c, mk in plan:
            done[t] = self.fire(t, c, mk)

        # 观察窗时长一次性推进共享时钟：performance.now / Date.now 同步前进，
        # 于是 so 的 pos0（窗口时长）与 pos12-pos11（墙钟差）同时落在人类区间，
        # 而事件 timeStamp 的密集度保持不变。
        self.clock.advance(max(0.0, float(span_ms)))
        return done


def solve_so_evented(collector_dx: str, snapshot_dx: str, seed: str,
                     collect_ms: float = 1200.0,
                     sdk_version: str = "20260810913b") -> Dict[str, Any]:
    """完整官方流程（含观察窗事件）：Et(C,seed) → 观察窗 → Et(S) → so"""
    vm = EventedSentinelVM(sdk_version)
    vm.run(collector_dx, seed=seed, reinit=True)
    c_steps = vm.steps
    act = vm.simulate_session(collect_ms)
    so = vm.run(snapshot_dx, seed=None, reinit=False)
    return {"so": so, "collector_steps": c_steps, "snapshot_steps": vm.steps - c_steps,
            "handlers": act, "error": vm.last_error()}


def solve_so(collector_dx: str, snapshot_dx: str, seed: str,
             sdk_version: str = "20260810913b") -> Dict[str, Any]:
    """官方流程：Et(collector_dx, seed) → Et(snapshot_dx) → so"""
    vm = SentinelVM(sdk_version)
    vm.run(collector_dx, seed=seed, reinit=True)
    c_steps = vm.steps
    so = vm.run(snapshot_dx, seed=None, reinit=False)
    return {
        "so": so,
        "collector_steps": c_steps,
        "snapshot_steps": vm.steps - c_steps,
        "error": vm.last_error(),
    }


def unpack_so(raw: str, key_len: int = 5) -> Optional[Dict[str, Any]]:
    """解开 so 容器：外层 JSON 的每个值再 XOR。

    当前 SDK 先四舍五入到两位小数，再按 JavaScript Number 转字符串，
    因此尾零会被移除，例如 7.31 / 79.06 / 86.4。
    key_len 保留用于兼容旧调用方。
    """
    b = base64.b64decode(raw + "=" * ((-len(raw)) % 4))
    for whole in range(100):
        for frac in range(100):
            k = str(whole) if frac == 0 else f"{whole}.{frac:02d}".rstrip("0")
            kb = k.encode("ascii")
            key_size = len(kb)
            if (b[0] ^ kb[0]) != 0x7B or (b[1] ^ kb[1 % key_size]) != 0x22:
                continue
            try:
                out = bytes(
                    b[i] ^ kb[i % key_size] for i in range(len(b))
                ).decode("utf-8", "strict")
                outer = json.loads(out)
            except Exception:
                continue
            if isinstance(outer, dict) and len(outer) == 29:
                values = {}
                for name, value in outer.items():
                    try:
                        inner = base64.b64decode(value + "=" * ((-len(value)) % 4))
                        values[name] = bytes(
                            inner[i] ^ kb[i % key_size] for i in range(len(inner))
                        ).decode("utf-8", "strict")
                    except Exception:
                        values[name] = None
                return {"key": k, "outer": outer, "plain": values,
                        "plain_unknown": [values[name] for name in outer]}
    return None
