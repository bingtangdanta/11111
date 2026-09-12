"""common.py — 公共工具：HTTP 请求（主机故障转移 + 重试）、数值解析、北京时间。

设计原则（这个仓库要在 GitHub Actions 上无人值守地跑）：
  1. **只用标准库** —— 不装任何第三方包，CI 里不用 pip install，
     少一个环节就少一类失败（依赖装不上、版本冲突、镜像超时）。
  2. 任何一次请求失败都不能让整轮抓取失败：能重试就重试，能换主机就换主机，
     实在不行返回 None，由上层写"数据缺失"，绝不编造。
  3. 节流：公开接口不是无限的，默认每次请求之间隔 0.15s，避免被封。
"""

from __future__ import annotations

import json
import logging
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

log = logging.getLogger("ashare.common")

CN_TZ = timezone(timedelta(hours=8))

UA = {
    "User-Agent": ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                   "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"),
    "Accept": "*/*",
    "Referer": "https://quote.eastmoney.com/",
}

#: 每次请求之间的最小间隔（秒）。可用环境变量调大，降低被限流的概率。
#: 实测教训：把三个 K 线源在十几分钟内打了上千次之后，东财直接 RemoteDisconnected、
#: 腾讯返回 501，只有新浪还能用 —— 公开接口的限流是**按 IP** 的，CI 里也躲不掉。
import os as _os
import random as _random

try:
    MIN_INTERVAL = float(_os.environ.get("ASHARE_MIN_INTERVAL", "0.35"))
except ValueError:
    MIN_INTERVAL = 0.35
_last_call = 0.0
_cache: dict[str, object] = {}

# ----------------------------------------------------------------------
# 数据源健康度（熔断 + 粘性优选）
#
# 为什么必须有：实测东财历史 K 线接口被限流时，**每一台主机都要超时一轮**才轮到
# 备用源。一只股票白等几秒，几百只就是几十分钟，CI 直接跑不完。
# 这里的策略是：
#   · 某个源连续失败 FAILS_TO_TRIP 次 → 进冷却期 COOLDOWN 秒，期间**直接跳过**；
#   · 成功的源会被记住（粘性），下次优先用它；
#   · 冷却结束后自动再试一次，不会永久放弃。
# ----------------------------------------------------------------------
FAILS_TO_TRIP = 3
COOLDOWN = 300.0
_health: dict[str, dict] = {}


def mark_source(name: str, ok: bool) -> None:
    h = _health.setdefault(name, {"fails": 0, "tripped_at": 0.0, "ok_at": 0.0})
    if ok:
        h["fails"] = 0
        h["tripped_at"] = 0.0
        h["ok_at"] = time.monotonic()
    else:
        h["fails"] += 1
        if h["fails"] >= FAILS_TO_TRIP:
            h["tripped_at"] = time.monotonic()


def source_available(name: str) -> bool:
    h = _health.get(name)
    if not h:
        return True
    if h["tripped_at"] and (time.monotonic() - h["tripped_at"]) < COOLDOWN:
        return False
    return True


def order_sources(names: list[str]) -> list[str]:
    """可用的排前面，最近成功的排最前（粘性），被熔断的排最后（本轮直接跳过）。"""
    usable = [n for n in names if source_available(n)]
    cooled = [n for n in names if not source_available(n)]
    usable.sort(key=lambda n: -(_health.get(n, {}).get("ok_at") or 0.0))
    return usable + cooled


def cooldown_left(name: str) -> float:
    """
    该源还要冷却多少秒（没被熔断返回 0）。

    为什么需要：`source_available()` 只回答"现在能不能用"，回答不了"要等多久"。
    上层在"所有源都被熔断"时如果只会**盲等固定 3 秒**，就会变成
    "一只股票等 8 秒 × 几百只" —— 实测踩到过：一整轮抓取卡在 K 线步骤上。
    有了剩余时间，就能判断"再等 2 秒值得"还是"还差 4 分钟，别等了"。
    """
    h = _health.get(name)
    if not h or not h.get("tripped_at"):
        return 0.0
    left = COOLDOWN - (time.monotonic() - h["tripped_at"])
    return max(0.0, left)


def shortest_cooldown_left(names: list[str]) -> float:
    """这组源里"最早恢复"的那个还要等多少秒（全都没熔断返回 0）。"""
    lefts = [cooldown_left(n) for n in names]
    return min(lefts) if lefts else 0.0


def source_report() -> dict:
    """给日志/version.json 用的源健康度快照。"""
    return {k: {"fails": v["fails"], "available": source_available(k)}
            for k, v in _health.items()}


def now_cn() -> datetime:
    """北京时间。用固定时差而不是 zoneinfo，避免精简镜像里没有 tzdata。"""
    return datetime.now(CN_TZ)


def throttle(min_interval: float | None = None) -> None:
    """请求间节流（带 ±30% 抖动，避免固定频率被识别为爬虫）。"""
    global _last_call
    base = MIN_INTERVAL if min_interval is None else min_interval
    wait = base * (0.85 + _random.random() * 0.3) - (time.monotonic() - _last_call)
    if wait > 0:
        time.sleep(wait)
    _last_call = time.monotonic()


def fnum(value) -> float | None:
    """把接口里的数字转成 float；'-'、''、None 一律返回 None（不当作 0）。"""
    if value is None or value == "-" or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def get_json(url: str, params: dict | None = None, *, hosts: list[str] | None = None,
             path: str = "", retries: int = 3, timeout: int = 25,
             use_cache: bool = True) -> dict | None:
    """
    GET 一个 JSON 接口。hosts 给了就轮流试（公开接口经常某台机器临时不可用）。

    三种用法都支持（早期版本只认第一种，第二种会把 URL 拼成裸路径而报
    `unknown url type` —— 这是我自己踩过的坑，所以这里显式兼容）：
        ① get_json("/api/x/y", params, hosts=HOSTS)      → 多主机 + 路径
        ② get_json("", params, hosts=HOSTS, path="/api/x/y")  → 同上（旧写法）
        ③ get_json("https://host/api/x/y", params)        → 完整 URL

    返回 dict 或 None（None 表示"这次拿不到"，调用方必须按数据缺失处理）。
    """
    if path:
        base = path
        candidates = hosts or [""]
    elif url.startswith("http"):
        base = ""
        candidates = [url]
    else:
        base = url
        candidates = hosts or [""]

    key = base + json.dumps(params or {}, sort_keys=True, ensure_ascii=False)
    if use_cache and key in _cache:
        return _cache[key]  # type: ignore[return-value]

    last_err: str = ""
    for attempt in range(max(1, retries)):
        for host in candidates:
            full = (host or "") + base
            if params:
                full += "?" + urllib.parse.urlencode(params)
            throttle()
            try:
                req = urllib.request.Request(full, headers=UA)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read()
                data = json.loads(raw.decode("utf-8", errors="replace"))
                if use_cache:
                    _cache[key] = data
                return data
            except urllib.error.HTTPError as exc:
                last_err = f"HTTP {exc.code}"
            except Exception as exc:  # noqa: BLE001 - 网络层什么都可能抛
                last_err = f"{type(exc).__name__}: {exc}"
        if attempt < max(1, retries) - 1:
            time.sleep(0.6 * (2 ** attempt) + random.random() * 0.3)
    log.warning("请求失败 %s（%s）", base or url, last_err)
    return None


def get_text(url: str, params: dict | None = None, *, hosts: list[str] | None = None,
             path: str = "", retries: int = 3, timeout: int = 25,
             encodings: tuple[str, ...] = ("utf-8", "gbk"),
             use_cache: bool = True, referer: str | None = None,
             validate=None) -> str | None:
    """
    GET 一个**非 JSON** 接口（天天基金的排行是 `var datas:[...]` 这种 JS 文本，
    全量基金表是 `var r = [...]` 的 js 文件），返回解码后的字符串。

    为什么单独写一个而不是改 get_json：JSON 解析失败时的重试/换主机逻辑不一样，
    硬塞进 get_json 会让"文本接口"和"JSON 接口"互相污染错误信息。
    编码这里按 utf-8 → gbk 依次尝试（东财部分老接口仍是 GBK）。

    referer：有些接口会**校验来源页**。实测（2026-09-12）天天基金排行接口在默认
      Referer（quote.eastmoney.com）下返回 `{ErrCode:-999,Data:"无访问权限"}`，
      换成 `https://fund.eastmoney.com/` 才给数据 —— 而这是 **HTTP 200**，
      不看内容根本发现不了。

    validate：正因为上面那种"200 + 一段错误信息"的存在，这里允许传一个校验函数。
      返回 False 就当作**这次请求失败** —— 会重试、换主机、并记进数据源健康度，
      而不是把"无访问权限"当成数据交给上层（上层只会解析出空列表，
      最后页面显示"数据缺失"，谁都不知道真正原因是 Referer）。
    """
    if path:
        base, candidates = path, (hosts or [""])
    elif url.startswith("http"):
        base, candidates = "", [url]
    else:
        base, candidates = url, (hosts or [""])

    key = "TEXT:" + base + json.dumps(params or {}, sort_keys=True, ensure_ascii=False)
    if use_cache and key in _cache:
        return _cache[key]  # type: ignore[return-value]

    headers = dict(UA)
    if referer:
        headers["Referer"] = referer

    last_err = ""
    for attempt in range(max(1, retries)):
        for host in candidates:
            full = (host or "") + base
            if params:
                full += "?" + urllib.parse.urlencode(params)
            throttle()
            try:
                req = urllib.request.Request(full, headers=headers)
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read()
                text = None
                for enc in encodings:
                    try:
                        text = raw.decode(enc)
                        break
                    except UnicodeDecodeError:
                        continue
                text = text if text is not None else raw.decode("utf-8", "replace")
                if validate is not None and not validate(text):
                    last_err = f"返回内容不符预期（{len(text or '')} 字节）"
                    continue
                if use_cache:
                    _cache[key] = text
                return text
            except urllib.error.HTTPError as exc:
                last_err = f"HTTP {exc.code}"
            except Exception as exc:  # noqa: BLE001
                last_err = f"{type(exc).__name__}: {exc}"
        if attempt < max(1, retries) - 1:
            time.sleep(0.6 * (2 ** attempt) + random.random() * 0.3)
    log.warning("文本请求失败 %s（%s）", base or url, last_err)
    return None


def secid(code: str) -> str:
    """A 股代码 → 东财 secid（沪市 1.，深市/北交所 0.）。"""
    code = str(code).strip().zfill(6)
    return ("1." if code[0] in ("6", "9") else "0.") + code


def pool_code(code: str) -> str:
    """北交所 4/8 开头与深市同为 0. 前缀，这里只为可读性保留一个入口。"""
    return secid(code)


def chunks(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def get_json_ok(path: str, params: dict | None, hosts: list[str], validate,
                *, retries: int = 2, timeout: int = 25) -> dict | None:
    """
    按主机顺序请求，返回**第一个通过 validate 校验**的响应。

    为什么需要这个：公开接口会返回"HTTP 200 但内容是空的"。
    实测（2026-09-11）：`push2delay.eastmoney.com` 的 K 线接口永远返回
    `{"data":{"dktotal":0,"klines":[]}}`——HTTP 200、rc=0，看起来完全成功，
    但一根 K 线都没有。只判断"请求有没有成功"的代码会把这种空响应当成有效数据，
    于是整轮抓取拿到 0 只股票却以为一切正常（真实踩过：40 只候选精算结果 0 只）。

    所以：**每类数据都要带一个 validate 函数**，不满足就换下一台主机/下一个源。
    """
    last: str = ""
    for attempt in range(max(1, retries)):
        for host in hosts:
            data = get_json(path, params, hosts=[host], timeout=timeout,
                            use_cache=False, retries=1)
            if data is None:
                last = "请求失败"
                continue
            try:
                if validate(data):
                    return data
                last = "响应为空/字段不符"
            except Exception as exc:  # noqa: BLE001 - 校验函数自己出问题也不许中断
                last = f"校验异常 {type(exc).__name__}"
        if attempt < max(1, retries) - 1:
            time.sleep(0.5 * (attempt + 1))
    log.warning("所有主机返回的数据都不合格（%s）：%s", last, path)
    return None


def write_json(path, payload) -> int:
    """写 JSON（无多余空格，省体积），返回字节数。"""
    import os

    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), default=str)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return len(text.encode("utf-8"))
