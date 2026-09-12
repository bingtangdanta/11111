"""sources.py — 所有数据源的取数函数（默认东方财富免费接口，可选同花顺官方）

数据源策略（按用户要求"优先同花顺，找不到再用公开源"）
----------------------------------------------------
同花顺官方 API（fuyao.aicubes.cn）需要 API Key，且经逐条核对：
    有：个股/指数历史 K 线、涨跌停池、龙虎榜个股明细
    没有：龙虎榜**营业部席位明细**、机构调研、券商研报/评级、筹码分布/获利盘
所以：
    · 若环境变量 HITHINK_FINANCE_API_KEY 存在 → **K 线优先用同花顺官方**（前复权更权威），
      龙虎榜个股明细也优先用它；任何一步失败自动回落东方财富，绝不让整轮抓取失败。
    · 没有 Key（默认）→ 全部走东方财富免费接口，零配置即可跑通。

所有函数拿不到数据时返回 None / 空列表，由上层写"数据缺失"，**不编造**。
"""

from __future__ import annotations

import json
import logging
import os
import time
from datetime import date, datetime, timedelta

from common import (CN_TZ, get_text, chunks, fnum, get_json, get_json_ok,
                    mark_source, order_sources, secid, shortest_cooldown_left, source_available)

log = logging.getLogger("ashare.sources")

PUSH2 = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com",
         "https://82.push2.eastmoney.com"]
#: K 线主机：**编号子域优先**。实测（2026-09-11）裸 push2his 被限流时返回
#: RemoteDisconnected，而 43.push2his 正常。
#: ⚠️ 故意**不把 push2delay 放进列表**：它对 K 线接口永远返回 200 + 空数组
#:    （dktotal=0），放进来只会白等一轮超时，把每只股票的抓取时间拖长。
HIS = ["https://43.push2his.eastmoney.com", "https://push2his.eastmoney.com",
       "https://7.push2his.eastmoney.com"]
DC = "https://datacenter-web.eastmoney.com"
REPORT = "https://reportapi.eastmoney.com"
ZTPOOL = ["https://push2ex.eastmoney.com"]
TENCENT = ["https://web.ifzq.gtimg.cn", "https://proxy.finance.qq.com"]
SINA = ["https://money.finance.sina.com.cn"]
HITHINK = "https://fuyao.aicubes.cn"

#: 全市场 A 股集合（沪深主板 + 中小板 + 创业板 + 科创板 + **北交所**）
#: 北交所实测能取到 355 只（代码 920xxx/83xxxx/43xxxx 等），加进来才叫"所有股票都能搜到"。
#: 注意：北交所只进"搜索库/筛选表"，**不进精算池**（WATCH_PREFIX 仍是 0/60，涨跌幅 30%、
#: 流动性差异大，混在一起算技术分没有可比性）。
ALL_STOCKS_FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
BJ_FS = "m:0+t:81+s:2048"
INDUSTRY_FS = "m:90+t:2"
CONCEPT_FS = "m:90+t:3"
ETF_FS = "b:MK0021,b:MK0022,b:MK0023,b:MK0024"


# ----------------------------------------------------------------------
# 同花顺官方（可选）
# ----------------------------------------------------------------------

class Hithink:
    """同花顺官方 API 的最小封装（只在有 Key 时启用）。"""

    def __init__(self) -> None:
        self.key = (os.environ.get("HITHINK_FINANCE_API_KEY") or "").strip()
        self.enabled = bool(self.key)
        # 没配 Key 就彻底静默：不提示、不重试、不进"数据来源"清单
        # （用户反馈：没有付费 Key 却一直报"未接入/未配置"，很烦且没意义）
        self.stats = {"calls": 0, "errors": 0}

    def _request(self, path: str, params: dict, timeout: int = 25):
        if not self.enabled:
            return None
        import json
        import urllib.parse
        import urllib.request

        from common import MIN_INTERVAL, throttle

        url = HITHINK + path + "?" + urllib.parse.urlencode(params)
        throttle(MIN_INTERVAL)
        req = urllib.request.Request(url, headers={"X-api-key": self.key})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                body = json.loads(resp.read().decode("utf-8", errors="replace"))
            self.stats["calls"] += 1
            if body.get("code") not in (0, None):
                self.stats["errors"] += 1
                return None
            return body.get("data")
        except Exception:  # noqa: BLE001 - 失败就回落东财
            self.stats["errors"] += 1
            return None

    def daily_kline(self, code: str, days: int = 300) -> list[dict] | None:
        """官方前复权日 K。"""
        import calendar

        end = date.today()
        start = end - timedelta(days=int(days * 1.7))
        # ⚠️ 不要用 strftime("%s") —— 那个格式符在 Windows 上不支持，会直接抛异常。
        start_ms = calendar.timegm(start.timetuple()) * 1000
        end_ms = calendar.timegm(end.timetuple()) * 1000
        data = self._request("/api/a-share/prices/historical", {
            "thscode": _thscode(code), "interval": "1d",
            "start": start_ms, "end": end_ms, "adjust": "forward",
        })
        return None if not data else _parse_hithink_kline(data)

    def index_kline(self, thscode: str, days: int = 120) -> list[dict] | None:
        data = self._request("/api/a-share-index/prices/historical", {
            "thscode": thscode, "interval": "1d", "start": 0, "end": 0,
        })
        return None if not data else _parse_hithink_kline(data)


def _thscode(code: str) -> str:
    """A 股代码 → 同花顺 thscode（6/9 沪市、4/8/920 北交所、其余深市）。"""
    c = str(code).strip().zfill(6)
    if c.startswith("920") or c[0] in ("4", "8"):
        return c + ".BJ"
    return c + (".SH" if c[0] in ("6", "9") else ".SZ")


def _parse_hithink_kline(data: dict) -> list[dict] | None:
    """官方 K 线 → 统一结构 [{date, open, high, low, close, volume}]。"""
    items = (data or {}).get("item") or []
    if not items:
        return None
    out = []
    for it in items:
        ms = it.get("date_ms")
        if not ms:
            continue
        d = date.fromtimestamp(int(ms) / 1000)
        out.append({"date": d.isoformat(),
                    "open": fnum(it.get("open_price")), "high": fnum(it.get("high_price")),
                    "low": fnum(it.get("low_price")), "close": fnum(it.get("close_price")),
                    "volume": fnum(it.get("volume")) or 0})
    out.sort(key=lambda x: x["date"])
    return out or None


# ----------------------------------------------------------------------
# 东方财富：行情与 K 线
# ----------------------------------------------------------------------

#: 最近一次全市场快照里，**行情自己带的最后时间戳**（clist 的 f124，Unix 秒）。
#: 为什么要记它（而不是看墙上时钟）：
#:   判断"这份快照是哪一天的、是不是收盘价"，数据自己最清楚。墙上时钟会在三种情况下说谎 ——
#:     · 周末/节假日跑（行情还是上一交易日的收盘，时钟却说"今天是周六"）
#:     · 15:02 就跑（A 股收盘后还有几分钟的收尾撮合，时钟说"已收盘"）
#:     · 接口返回的是缓存的旧数据
#:   2026-09-12（周六）实测就踩到了：日志报"现在是盘中"，还会把 trade_date 写成周六。
#: ⚠️ 它是模块级状态：market_snapshot() 跑完才有值，所以调用顺序必须是"先拿快照再问时间"。
_LAST_QUOTE_TS: float = 0.0


def last_snapshot_quote_time() -> datetime | None:
    """快照行情时间（东财口径，北京时间）；没拿到 f124 时返回 None（上层退回墙上时钟）。"""
    if not _LAST_QUOTE_TS:
        return None
    try:
        return datetime.fromtimestamp(_LAST_QUOTE_TS, CN_TZ)
    except (OverflowError, OSError, ValueError):
        return None


def market_snapshot(max_pages: int = 60) -> list[dict]:
    """
    全市场 A 股快照（一次 100 条，实测 clist 单页硬上限就是 100）。

    字段：f12 代码 f14 名称 f2 最新价 f3 涨跌幅 f6 成交额 f8 换手率 f10 量比
          f20 总市值 f21 流通市值 f62 主力净流入(元) f184 主力净占比 f100 行业
          f124 最新行情时间（用来判断"这份快照是哪一天的"，见 _LAST_QUOTE_TS）

    ⚠️ 必须做**响应校验**：东财会返回 HTTP 200 但 `diff` 为空（限流/抖动）。
       旧写法遇到空页直接 break，快照就被**静默截断**成几十只，
       而后面整条筛选链都建立在这份残缺数据上、页面上毫无提示。
       这里用 get_json_ok 要求"单页至少 50 行"，不满足就换主机重试。
    """
    global _LAST_QUOTE_TS
    _LAST_QUOTE_TS = 0.0
    rows: list[dict] = []

    def valid(j: dict) -> bool:
        return len(((j or {}).get("data") or {}).get("diff") or []) >= 50

    for page in range(1, max_pages + 1):
        j = get_json_ok("/api/qt/clist/get", {
            "pn": str(page), "pz": "100", "po": "1", "np": "1", "fltt": "2", "invt": "2",
            "fid": "f6", "fs": ALL_STOCKS_FS,
            # 行情 + 资金 + **基本面**一次取回（f9 PE / f23 PB / f37 ROE / f41 营收同比 /
            # f46 净利同比 / f49 毛利率 / f57 资产负债率 / f115 PE(TTM) / f130 市销率）
            # f124 = 最新行情时间（Unix 秒）→ 用来判断"这份快照到底是哪一天的"
            # f15/f16/f17/f18 = 最高/最低/开盘/昨收 → **决策验证要用**：
            #   · 开盘价是"可执行口径"（T+1 开盘买入）的买入价
            #   · 最高==最低 就是一字板 → 买不进，回评时必须单独剔除
            "fields": ("f12,f14,f2,f3,f6,f8,f10,f20,f21,f62,f184,f100,"
                       "f9,f23,f37,f41,f46,f49,f57,f115,f130,f124,f15,f16,f17,f18"),
        }, PUSH2, valid)
        if not j:
            if page == 1:
                return []          # 首页就拿不到 → 明确失败，让上层报错
            break                  # 后续页拿不到（例如刚好到边界）→ 用已有数据
        data = j.get("data") or {}
        diff = data.get("diff") or []
        for r in diff:
            code = str(r.get("f12") or "").zfill(6)
            if not code or code == "000000":
                continue
            ts = fnum(r.get("f124"))
            if ts and ts > _LAST_QUOTE_TS:
                _LAST_QUOTE_TS = ts
            rows.append({
                "code": code, "name": str(r.get("f14") or ""),
                "price": fnum(r.get("f2")), "change_pct": fnum(r.get("f3")),
                "amount": fnum(r.get("f6")), "turnover": fnum(r.get("f8")),
                "volume_ratio": fnum(r.get("f10")), "market_cap": fnum(r.get("f20")),
                "float_cap": fnum(r.get("f21")), "main_net": fnum(r.get("f62")),
                "main_net_pct": fnum(r.get("f184")), "industry": (r.get("f100") or "").strip(),
                # 当日开高低与昨收：决策验证（可执行口径）与一字板识别要用
                "open": fnum(r.get("f17")), "high": fnum(r.get("f15")),
                "low": fnum(r.get("f16")), "prev_close": fnum(r.get("f18")),
                # 基本面（供"搜索任意股票 → 评分/多空建议"用）
                "pe": fnum(r.get("f9")), "pb": fnum(r.get("f23")),
                "roe": fnum(r.get("f37")), "rev_yoy": fnum(r.get("f41")),
                "np_yoy": fnum(r.get("f46")), "gross": fnum(r.get("f49")),
                "debt": fnum(r.get("f57")), "pe_ttm": fnum(r.get("f115")),
                "ps": fnum(r.get("f130")),
            })
        total = data.get("total") or 0
        if page * 100 >= total:
            break
    return rows


def _em_kline(secid_str: str, bars: int, adjust: str) -> list[dict]:
    """东方财富 K 线（带"200 但空"校验 + 多主机）。失败返回空列表。"""
    end = date.today()
    beg = (end - timedelta(days=int(bars * 1.8))).strftime("%Y%m%d")

    def valid(j: dict) -> bool:
        kl = ((j or {}).get("data") or {}).get("klines") or []
        return len(kl) >= 20          # 少于 20 根一律当失败，换主机/换源

    j = get_json_ok("/api/qt/stock/kline/get", {
        "secid": secid_str, "fields1": "f1,f2,f3,f4,f5",
        "fields2": "f51,f52,f53,f54,f55,f56,f57", "klt": "101", "fqt": adjust,
        "beg": beg, "end": "20500101", "lmt": str(bars),
    }, HIS, valid)
    if not j:
        return []
    lines = ((j.get("data") or {}).get("klines")) or []
    out = []
    for line in lines:
        p = str(line).split(",")
        if len(p) < 6:
            continue
        out.append({"date": p[0], "open": fnum(p[1]), "close": fnum(p[2]),
                    "high": fnum(p[3]), "low": fnum(p[4]), "volume": fnum(p[5]) or 0,
                    "amount": fnum(p[6]) if len(p) > 6 else None})
    return out


def _tx_symbol(code: str) -> str:
    """A 股代码 → 腾讯/新浪符号（sh600519 / sz000001 / bj430047）。"""
    c = str(code).strip().zfill(6)
    if c.startswith("920") or c[0] in ("4", "8"):
        return "bj" + c
    return ("sh" if c[0] in ("6", "9") else "sz") + c


def _tencent_kline(symbol: str, bars: int, *, qfq: bool = True) -> list[dict]:
    """
    腾讯日 K（免费、无需 Key）。

    接口：GET {TENCENT}/appstock/app/fqkline/get?param=sh600519,day,,,120,qfq
    实测返回：data.sh600519.qfqday = [[日期, 开, 收, 高, 低, 量(手)], ...]
             （指数用 param=sh000001,day,,,120,qfq，字段名是 day）
    注意字段顺序是 **开-收-高-低**（不是常见的 开-高-低-收），别搞错。
    """
    tag = "qfq" if qfq else "day"
    param = f"{symbol},day,,,{bars},{tag}"

    def valid(j: dict) -> bool:
        d = ((j or {}).get("data") or {}).get(symbol) or {}
        arr = d.get("qfqday") or d.get("day") or []
        return len(arr) >= 20

    j = get_json_ok("/appstock/app/fqkline/get", {"param": param}, TENCENT, valid)
    if not j:
        return []
    d = ((j.get("data") or {}).get(symbol)) or {}
    arr = d.get("qfqday") or d.get("day") or []
    out = []
    for row in arr:
        if len(row) < 6:
            continue
        out.append({"date": str(row[0])[:10], "open": fnum(row[1]), "close": fnum(row[2]),
                    "high": fnum(row[3]), "low": fnum(row[4]), "volume": fnum(row[5]) or 0})
    return out


def _sina_kline(symbol: str, bars: int) -> list[dict]:
    """新浪日 K（备用源；volume 单位是股，与腾讯的"手"差 100 倍——只影响绝对量，不影响筹码相对分布）。"""
    def valid(j) -> bool:
        return isinstance(j, list) and len(j) >= 20

    j = get_json_ok("/quotes_service/api/json_v2.php/CN_MarketData.getKLineData",
                    {"symbol": symbol, "scale": "240", "ma": "no", "datalen": str(bars)},
                    SINA, valid)
    if not j:
        return []
    out = []
    for r in j:
        out.append({"date": str(r.get("day") or "")[:10], "open": fnum(r.get("open")),
                    "close": fnum(r.get("close")), "high": fnum(r.get("high")),
                    "low": fnum(r.get("low")), "volume": fnum(r.get("volume")) or 0})
    return out


#: K 线源"全都在冷却期"时，整轮最多花多少秒在**等待**上。
#: 实测教训（2026-09-12）：东财/腾讯/新浪三个源同时被限流后，
#: `_fetch_kline` 每只股票都要"睡 3 秒 + 三个源各失败一次"≈ 8 秒；
#: 剩下的 180 只就是 24 分钟，而 CI 有 timeout —— 一旦超时，整轮产物一个都写不出来。
#: 现在改成"等待有总预算"：预算用完就**直接跳过等待**，让上层尽快跑完并如实标"K 线缺失"。
KLINE_WAIT_BUDGET = 120.0
#: 冷却剩余时间超过这个值就别等了（等 3 秒也没用，纯浪费）
KLINE_FORCE_RETRY_MAX_LEFT = 30.0
_kline_waited = 0.0


def reset_kline_budget() -> None:
    """每轮抓取开始时调用一次（把"等待预算"清零）。"""
    global _kline_waited
    _kline_waited = 0.0


def kline_budget_state() -> dict:
    """给日志/测试看：等待预算用了多少、还剩多少。"""
    return {"budget": KLINE_WAIT_BUDGET, "waited": round(_kline_waited, 1),
            "left": round(max(0.0, KLINE_WAIT_BUDGET - _kline_waited), 1)}


def _fetch_kline(providers: list[tuple[str, object]], min_bars: int = 20) -> list[dict]:
    """
    按源健康度依次尝试 K 线源，返回第一个合格结果。

    ⚠️ 关键：如果**所有源都处于冷却期**（连续失败被熔断），这里会**强制再试一轮**
       （忽略冷却），否则一轮抓取会因为没有可用源而全军覆没 ——
       熔断是为了省时间，不该变成"彻底放弃"。

    ⚠️ 但"强制再试"必须有**预算**：三个源同时被限流时，每只股票都要
       "睡 3 秒 + 三次失败" ≈ 8 秒，几百只就是几十分钟，CI 会超时、
       整轮产物一个都写不出来（比"少几只 K 线"糟糕得多）。
       所以：冷却只剩一点点才等；冷却还很久就**立刻放弃这一只**，
       由上层按"连续失败次数"决定整段 K 线抓取是否收工。
    """
    global _kline_waited
    names = [p[0] for p in providers]
    table = dict(providers)
    for name in order_sources(names):
        if not source_available(name):
            continue
        got = table[name]()
        if len(got) >= min_bars:
            mark_source(name, True)
            return got
        mark_source(name, False)

    # ---- 全部冷却 ----
    left = shortest_cooldown_left(names)
    wait = min(left, 3.0)
    if left > KLINE_FORCE_RETRY_MAX_LEFT or (_kline_waited + wait) > KLINE_WAIT_BUDGET:
        log.info("K 线源全部冷却（最早 %s 秒后恢复）/或等待预算已用完 → 这只跳过，不再干等",
                 round(left))
        return []
    log.info("所有 K 线源都在冷却期（最早 %s 秒后恢复），等 %.1f 秒后强制重试：%s",
             round(left), wait, names)
    time.sleep(wait)
    _kline_waited += wait
    for name in names:
        got = table[name]()
        if len(got) >= min_bars:
            mark_source(name, True)
            return got
        mark_source(name, False)
    return []


#: K 线源顺序（可用 ASHARE_KLINE_ORDER 覆盖）。
#: ⚠️ 默认 **腾讯 → 新浪 → 东财**：GitHub Actions 跑在海外 IP，东财对海外请求拦得最凶
#:    （成片 502 / RemoteDisconnected），而腾讯/新浪对海外相对宽容。
#:    想改回去：ASHARE_KLINE_ORDER=em,tencent,sina
KLINE_ORDER = [x.strip() for x in
               (os.environ.get("ASHARE_KLINE_ORDER", "tencent,sina,em").split(","))
               if x.strip()]


def _kline_providers(mk: dict) -> list[tuple[str, object]]:
    """按 KLINE_ORDER 组装 K 线源列表（mk 是 名字→取数函数 的字典）。"""
    out = [(k, mk[k]) for k in KLINE_ORDER if k in mk]
    return out or list(mk.items())


def daily_kline(code: str, bars: int = 300, adjust: str = "1") -> list[dict]:
    """
    个股日 K：东方财富 → 腾讯 → 新浪，逐级回落（带源熔断与粘性优选）。

    ⚠️ 为什么必须多源：实测东财历史接口会被**间歇性限流**（裸 push2his 直接
    RemoteDisconnected，push2delay 返回 200 却给空数组）。只靠一个源，CI 里会
    突然整轮没有 K 线，而页面上什么都看不出来。
    ⚠️ 为什么要熔断：被限流时每台主机都要超时一轮，一只股票白等几秒 × 几百只 =
    CI 跑不完。连续失败 3 次即冷却 5 分钟，期间直接跳过该源，之后自动重试。
    """
    return _fetch_kline(_kline_providers({
        "em": lambda: _em_kline(secid(code), bars, adjust),
        "tencent": lambda: _tencent_kline(_tx_symbol(code), bars, qfq=True),
        "sina": lambda: _sina_kline(_tx_symbol(code), bars),
    }))


def index_kline(secid_str: str, bars: int = 160, symbol: str | None = None) -> list[dict]:
    """指数日 K：默认腾讯 → 新浪 → 东财（同样有熔断与粘性；顺序可用 ASHARE_KLINE_ORDER 调）。"""
    sym = symbol or ("sh" + secid_str.split(".")[1] if secid_str.startswith("1.")
                     else "sz" + secid_str.split(".")[1])
    return _fetch_kline(_kline_providers({
        "em": lambda: _em_kline(secid_str, bars, "0"),
        "tencent": lambda: _tencent_kline(sym, bars, qfq=False),
        "sina": lambda: _sina_kline(sym, bars),
    }))


def industry_and_concept(codes: list[str]) -> dict[str, dict]:
    """批量取个股所属行业(f100)与概念(f103)，一次最多 100 个 secid。"""
    out: dict[str, dict] = {}
    for group in chunks(list(codes), 90):
        j = get_json("", {
            "fltt": "2", "invt": "2", "fields": "f12,f14,f100,f103",
            "secids": ",".join(secid(c) for c in group),
        }, hosts=PUSH2, path="/api/qt/ulist.np/get")
        for r in ((j or {}).get("data") or {}).get("diff") or []:
            code = str(r.get("f12") or "").zfill(6)
            out[code] = {"industry": (r.get("f100") or "").strip(),
                         "concept": (r.get("f103") or "").strip()}
    return out


# ----------------------------------------------------------------------
# 场外基金 / 场外 ETF 联接（天天基金公开接口，免费）
#
# 用户要求"加上场外ETF板块"。实测（2026-09-12）：
#   · 全量基金表 https://fund.eastmoney.com/js/fundcode_search.js → 27828 只，含名称/类型
#   · 开放式基金排行 http://fund.eastmoney.com/data/rankhandler.aspx
#         ft=zs（指数型）total=4535，约 2/3 是"ETF 联接 / 发起式联接"
#         字段：0 代码 1 名称 2 拼音 3 净值日期 4 单位净值 5 累计净值 6 日增长率%
#               7 近1周 8 近1月 9 近3月 10 近6月 11 近1年 12 近2年 13 近3年
#               14 今年来 15 成立来 16 成立日期 19 手续费
#   · 拿不到的：盘中估值（fundgz 接口已 404）、申赎限额、跟踪标的 → 一律标"数据缺失"
# 说明：场外基金净值是 **T 日收盘后**公布（通常 20:00 之后），所以它天然是"盘后数据"，
#      不存在盘中未来函数问题；页面上会写明净值日期。
# ----------------------------------------------------------------------

FUND_LIST_URL = "https://fund.eastmoney.com/js/fundcode_search.js"
FUND_RANK_HOST = "http://fund.eastmoney.com"
FUND_RANK_PATH = "/data/rankhandler.aspx"
#: ⚠️ 必须带这个 Referer：实测（2026-09-12）用默认的 quote.eastmoney.com 去请求排行接口，
#:    服务器返回 **HTTP 200** + `{ErrCode:-999,Data:"无访问权限"}`；
#:    换成 fund.eastmoney.com 才给真数据。这就是那种"不校验就永远查不出来"的坑。
FUND_REFERER = "https://fund.eastmoney.com/"

#: 场外基金排行里的列顺序（按接口返回的 CSV 位置索引）
FUND_COLS = {0: "code", 1: "name", 3: "nav_date", 4: "nav", 5: "nav_total", 6: "chg_1d",
             7: "chg_1w", 8: "chg_1m", 9: "chg_3m", 10: "chg_6m", 11: "chg_1y",
             12: "chg_2y", 13: "chg_3y", 14: "chg_ytd", 15: "chg_since",
             16: "inception", 19: "fee"}


def _looks_like_rank(text: str) -> bool:
    """排行接口的"真数据"判据：必须有 datas:[ 且不是 ErrCode。"""
    return bool(text) and "datas:[" in text and "ErrCode" not in text


def fund_universe() -> list[dict]:
    """
    全量场外基金（代码/名称/类型/拼音）。用于"场外ETF"板块的搜索与类型筛选。

    返回 [{'code','name','type','pinyin'}]；拿不到时返回空列表（上层写数据缺失）。
    """
    text = get_text(FUND_LIST_URL, referer=FUND_REFERER,
                    validate=lambda t: bool(t) and "[" in t and "]" in t)
    if not text or "[" not in text:
        return []
    try:
        raw = json.loads(text[text.index("["):text.rindex("]") + 1])
    except ValueError:
        return []
    out = []
    for row in raw:
        if not isinstance(row, list) or len(row) < 4:
            continue
        out.append({"code": str(row[0]).zfill(6), "pinyin": row[1],
                    "name": row[2], "type": row[3]})
    return out


def fund_rank(ft: str = "zs", pages: int = 2, page_size: int = 100,
              sort: str = "1nzf", *, only_etf_link: bool = False) -> list[dict]:
    """
    场外基金排行（默认 ft=zs 指数型，按近 1 年涨幅降序）。

    sort 可选：1nzf 近1年、rzdf 日增长率、zzf 近1周、1yzf 近1月、3yzf 近3月、
              6yzf 近6月、jnzf 今年来、lnzf 成立来（接口沿用东财的字段名）
    only_etf_link=True 时只保留名称里带 ETF/联接 的（就是"场外 ETF"）。
    """
    out: list[dict] = []
    for page in range(1, max(1, pages) + 1):
        text = get_text(FUND_RANK_PATH, {
            "op": "ph", "dt": "kf", "ft": ft, "rs": "", "gs": "0", "sc": sort, "st": "desc",
            "sd": "", "ed": "", "qdii": "", "tabSubtype": ",,,,,", "pi": str(page),
            "pn": str(page_size), "dx": "1", "v": "0.1",
        }, hosts=[FUND_RANK_HOST], referer=FUND_REFERER, validate=_looks_like_rank)
        if not text or "datas:[" not in text:
            break
        try:
            start = text.index("datas:[") + len("datas:")
            end = text.index("],allRecords")
            rows = json.loads(text[start:end + 1])
        except (ValueError, IndexError):
            break
        if not rows:
            break
        for line in rows:
            p = str(line).split(",")
            if len(p) < 17:
                continue
            item = {}
            for idx, key in FUND_COLS.items():
                v = p[idx] if idx < len(p) else None
                item[key] = (v or "").strip() if key in ("code", "name", "nav_date",
                                                         "inception", "fee") else fnum(v)
            item["code"] = str(item.get("code") or "").zfill(6)
            item["is_etf_link"] = ("ETF" in (item.get("name") or "")) or \
                                  ("联接" in (item.get("name") or ""))
            item["is_qdii"] = "QDII" in (item.get("name") or "")
            if only_etf_link and not item["is_etf_link"]:
                continue
            out.append(item)
        if len(rows) < page_size:
            break
    if out:
        mark_source("场外基金排行", True)
    return out


def fin_history(code: str, periods: int = 12) -> list[dict]:
    """
    近几年（按报告期）的盈利状况：每股收益 / 营收 / 净利润 / ROE / 同比 / 毛利率。

    数据源：东财 datacenter-web 的 RPT_LICO_FN_CPD（同一批公开报表接口，
    和龙虎榜/研报是同一个域名，零新增依赖）。
    取不到就返回空列表 —— 页面写"数据缺失"，**不编**。

    字段说明（东财原始字段 → 本函数输出）：
        REPORTDATE 报告期 / BASIC_EPS 每股收益 / TOTAL_OPERATE_INCOME 营业总收入
        PARENT_NETPROFIT 归母净利润 / WEIGHTAVG_ROE 加权 ROE
        YSTZ 营收同比% / SJLTZ 净利同比% / XSMLL 销售毛利率% / BPS 每股净资产
    """
    code = str(code or "").strip().zfill(6)
    if len(code) != 6 or not code.isdigit():
        return []
    j = get_json("", {
        "reportName": "RPT_LICO_FN_CPD", "columns": "ALL", "pageNumber": "1",
        "pageSize": str(max(1, min(24, periods))), "sortColumns": "REPORTDATE",
        "sortTypes": "-1", "source": "WEB", "client": "WEB",
        "filter": f'(SECURITY_CODE="{code}")',
    }, hosts=[DC], path="/api/data/v1/get")
    data = ((j or {}).get("result") or {}).get("data") or []
    out: list[dict] = []
    for r in data:
        date = str(r.get("REPORTDATE") or "")[:10]
        if not date:
            continue
        out.append({
            "date": date,
            "eps": fnum(r.get("BASIC_EPS")),
            "revenue": fnum(r.get("TOTAL_OPERATE_INCOME")),
            "net_profit": fnum(r.get("PARENT_NETPROFIT")),
            "roe": fnum(r.get("WEIGHTAVG_ROE")),
            "rev_yoy": fnum(r.get("YSTZ")),
            "np_yoy": fnum(r.get("SJLTZ")),
            "gross": fnum(r.get("XSMLL")),
            "bps": fnum(r.get("BPS")),
            "cash_ps": fnum(r.get("MGJYXJJE")),
        })
    if out:
        mark_source("财务指标", True)
    return out


def board_kline(board_code: str, bars: int = 120) -> list[dict]:
    """
    板块指数日线：secid = **90.BKxxxx**（与个股 K 线是同一个接口，只换 secid 前缀）。

    实测（2026-09-11）：clist 用 push2delay 可以拿板块列表；但 push2his 全系主机
    会被临时限流（RemoteDisconnected），这时**返回空列表**，由上层写"数据缺失"。
    绝不拿成分股去"合成"一条假板块指数冒充官方板块 K 线。

    注意：这里不额外调 mark_source —— 健康度由 _em_kline 内部按主机名记账，
    再拿"板块K线"当源名去记会污染那张表（而且签名是 (name, ok)，不是文字描述）。
    """
    code = str(board_code or "").strip().upper()
    if not code.startswith("BK"):
        return []
    return _em_kline(f"90.{code}", bars, "1")


def board_leaders(board_code: str, top: int = 5) -> list[dict]:
    """
    板块成分股里按**涨跌幅**降序取前 N 名 —— 也就是这个板块的"龙头股"。

    接口：clist + fs=b:BKxxxx（按板块代码筛成分股）+ fid=f3（涨跌幅）po=1（降序）。
    实测（2026-09-11，push2delay 可用）：返回 total 与 diff，字段
        f12 代码 f14 名称 f2 现价 f3 涨跌幅 f62 主力净额 f8 换手率 f20 总市值
    """
    code = str(board_code or "").strip().upper()
    if not code.startswith("BK"):
        return []
    j = get_json_ok("/api/qt/clist/get", {
        "pn": "1", "pz": str(max(top, 5)), "po": "1", "np": "1", "fltt": "2", "invt": "2",
        "fid": "f3", "fs": f"b:{code}", "fields": "f12,f14,f2,f3,f62,f184,f8,f20",
    }, PUSH2, lambda j: bool(((j or {}).get("data") or {}).get("diff")))
    if not j:
        return []
    out = []
    for r in ((j.get("data") or {}).get("diff") or [])[:top]:
        out.append({
            "code": str(r.get("f12") or "").zfill(6),
            "name": r.get("f14"),
            "price": fnum(r.get("f2")),
            "change_pct": fnum(r.get("f3")),
            "main_net": fnum(r.get("f62")),
            "main_net_pct": fnum(r.get("f184")),
            "turnover": fnum(r.get("f8")),
            "market_cap": fnum(r.get("f20")),
        })
    return out


def board_flow(fs: str, top_n: int = 60, fid: str = "f62") -> list[dict]:
    """板块/ETF 资金流排行（行业 m:90+t:2、概念 m:90+t:3、ETF b:MK00xx）。"""
    out: list[dict] = []
    for page in range(1, (top_n // 100) + 2):
        j = get_json("", {
            "pn": str(page), "pz": "100", "po": "1", "np": "1", "fltt": "2", "invt": "2",
            "fid": fid, "fs": fs, "fields": "f12,f14,f2,f3,f62,f184",
        }, hosts=PUSH2, path="/api/qt/clist/get")
        diff = ((j or {}).get("data") or {}).get("diff") or []
        if not diff:
            break
        for r in diff:
            out.append({"code": r.get("f12"), "name": r.get("f14"),
                        "change_pct": fnum(r.get("f3")), "main_net": fnum(r.get("f62")),
                        "main_net_pct": fnum(r.get("f184")), "price": fnum(r.get("f2"))})
        if len(out) >= top_n:
            break
    return out[:top_n]


# ----------------------------------------------------------------------
# 东方财富：涨跌停池
# ----------------------------------------------------------------------

def limit_pools(day: date) -> dict:
    """
    涨停池 / 炸板池 / 跌停池。

    实测字段（2026-09-10 验证）：
        涨停池：c 代码 n 名称 p 价格×1000 zdp 涨跌幅 hs 换手 lbc 连板数
                fbt 首次封板时间 lbt 最后封板时间 fund 封单额 zbc 炸板次数 hybk 行业
                zttj{days,ct} 涨停统计
        炸板池：ztp 涨停价 zbc 炸板次数 zf 振幅
        跌停池：days 连续跌停天数 fund 封单额 oc 开板次数
    """
    ymd = day.strftime("%Y%m%d")
    spec = {
        "up": ("/getTopicZTPool", "fbt:asc", "zt"),
        "break": ("/getTopicZBPool", "fbt:asc", "zb"),
        "down": ("/getTopicDTPool", "fund:asc", "dt"),
    }
    out: dict = {}
    for key, (path, sort, _tag) in spec.items():
        rows: list[dict] = []
        for page in range(0, 6):
            j = get_json("", {
                "ut": "7eea3edcaed734bea9cbfc24409ed989", "dpt": "wz.ztzt",
                "Pageindex": str(page), "pagesize": "100", "sort": sort, "date": ymd,
            }, hosts=ZTPOOL, path=path)
            pool = ((j or {}).get("data") or {}).get("pool") or []
            if not pool:
                break
            rows.extend(pool)
            if len(pool) < 100:
                break
        out[key] = rows
    return out


# ----------------------------------------------------------------------
# 东方财富：龙虎榜（个股明细 + 营业部席位）
# ----------------------------------------------------------------------

def dragon_tiger(day: date) -> list[dict]:
    """龙虎榜个股明细（上榜后 1/2/5/10 日涨跌幅也在内）。"""
    j = get_json("", {
        "reportName": "RPT_DAILYBILLBOARD_DETAILSNEW", "columns": "ALL",
        "pageNumber": "1", "pageSize": "500", "sortColumns": "BILLBOARD_NET_AMT",
        "sortTypes": "-1", "source": "WEB", "client": "WEB",
        "filter": f"(TRADE_DATE='{day.isoformat()}')",
    }, hosts=[DC], path="/api/data/v1/get")
    rows = ((j or {}).get("result") or {}).get("data") or []
    out = []
    for r in rows:
        out.append({
            "code": str(r.get("SECURITY_CODE") or "").zfill(6),
            "name": r.get("SECURITY_NAME_ABBR"),
            "close": fnum(r.get("CLOSE_PRICE")), "change_pct": fnum(r.get("CHANGE_RATE")),
            "turnover": fnum(r.get("TURNOVERRATE")),
            "buy_amt": fnum(r.get("BILLBOARD_BUY_AMT")), "sell_amt": fnum(r.get("BILLBOARD_SELL_AMT")),
            "net_amt": fnum(r.get("BILLBOARD_NET_AMT")), "deal_amt": fnum(r.get("BILLBOARD_DEAL_AMT")),
            "explain": r.get("EXPLAIN"), "reason": r.get("EXPLANATION"),
            "d1": fnum(r.get("D1_CLOSE_ADJCHRATE")), "d2": fnum(r.get("D2_CLOSE_ADJCHRATE")),
            "d5": fnum(r.get("D5_CLOSE_ADJCHRATE")), "d10": fnum(r.get("D10_CLOSE_ADJCHRATE")),
        })
    return out


def dragon_seats(day: date, code: str, top: int = 5) -> dict:
    """
    单只股票的营业部席位买卖 Top N。

    报表：RPT_BILLBOARD_DAILYDETAILSBUY / RPT_BILLBOARD_DAILYDETAILSSELL
        字段 OPERATEDEPT_NAME 营业部、BUY 买入额、SELL 卖出额、NET 净额、
             RISE_PROBABILITY_3DAY 该席位 3 日上涨概率
    """
    out: dict = {"buy": [], "sell": []}
    for side, report in (("buy", "RPT_BILLBOARD_DAILYDETAILSBUY"),
                         ("sell", "RPT_BILLBOARD_DAILYDETAILSSELL")):
        j = get_json("", {
            "reportName": report, "columns": "ALL", "pageNumber": "1", "pageSize": "50",
            "sortColumns": "BUY" if side == "buy" else "SELL",
            "sortTypes": "-1", "source": "WEB", "client": "WEB",
            "filter": f"(TRADE_DATE='{day.isoformat()}')(SECURITY_CODE=\"{code}\")",
        }, hosts=[DC], path="/api/data/v1/get")
        rows = ((j or {}).get("result") or {}).get("data") or []
        seats = []
        for r in rows[:top]:
            seats.append({"dept": r.get("OPERATEDEPT_NAME"), "buy": fnum(r.get("BUY")),
                          "sell": fnum(r.get("SELL")), "net": fnum(r.get("NET")),
                          "win3d": fnum(r.get("RISE_PROBABILITY_3DAY"))})
        out[side] = seats
    return out


# ----------------------------------------------------------------------
# 东方财富：机构调研 / 研报 / 评级
# ----------------------------------------------------------------------
# 时点纪律（point-in-time）：**防未来函数**
#
# 为什么必须有这一层：免费接口大多只给"日期"不给"时分"。如果直接用"最新"的研报/调研/
# 龙虎榜去解释**同一天**的行情，就是在用盘后信息解释盘中走势 —— 回测会好看得离谱，
# 实盘一用就废。规则写死在这里，而不是指望"反正我们跑得晚"：
#     · 研报 / 调研 / 公告：只给日期 → 保守认为**当日 23:59 才可用**，即只能进 T+1 的评分
#     · 行情 / 资金流 / 涨停池（收盘快照）：收盘后可用，可用于 T+1 决策
# 所以 daily run 产出的是"**T 日收盘后、给 T+1 用的决策数据**"，页面上也这么说。
# ----------------------------------------------------------------------

#: 只有日期、没有时分的数据，认为是当天这个时刻才"可得"
ASSUMED_AVAILABLE_TIME = (23, 59)


def available_at(date_str: str | None, *, assume_time: tuple[int, int] | None = None) -> datetime | None:
    """
    把"只有日期"的字段翻译成明确的可得时刻（无时分时按 ASSUMED_AVAILABLE_TIME 保守处理）。

    ⚠️ 返回的是**带时区（东八区）**的时间：生产环境里 `as_of` 来自 `common.now_cn()`，
       它也是带时区的；如果这里返回 naive datetime，`at <= as_of` 会直接抛
       `TypeError: can't compare offset-naive and offset-aware datetimes`
       —— 单元测试当时用的是 naive 值所以没暴露，真跑一轮就崩了。两边必须同为 aware。
    """
    s = str(date_str or "").strip()
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(s[:len(fmt) + 2].strip(), fmt)
        except ValueError:
            continue
        if fmt == "%Y-%m-%d" and assume_time is not None:
            dt = dt.replace(hour=assume_time[0], minute=assume_time[1])
        return dt.replace(tzinfo=CN_TZ)
    return None


def _as_aware(dt: datetime | None) -> datetime | None:
    """把 naive 时间补上东八区，避免与 aware 时间比较时抛异常。"""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=CN_TZ)


def filter_as_of(rows: list[dict], as_of: datetime | None, key: str = "available_at") -> list[dict]:
    """只留下"在 as_of 之前已经可得"的行。as_of 为 None 时**不过滤**（仅在明确不需要时使用）。"""
    if as_of is None:
        return list(rows or [])
    as_of = _as_aware(as_of)
    out = []
    for r in rows or []:
        at = r.get(key)
        if isinstance(at, str):
            at = available_at(at, assume_time=ASSUMED_AVAILABLE_TIME)
        at = _as_aware(at)
        if at is None or at <= as_of:
            out.append(r)
    return out


#: A 股收盘时间（含集合竞价后的收盘）。快照在它之前取，就不是"收盘快照"。
CLOSE_HHMM = (15, 0)


def is_post_close(dt: datetime) -> bool:
    """
    判断某个时刻是否已经收盘（用于标注"这份快照是不是收盘价"）。

    为什么需要：如果有人在盘中手动跑一次，拿到的就是**盘中快照**，
    却会被当成"今日收盘"写进历史、还会被后续 RankIC 当作因子暴露 —— 这是典型的
    时点污染。所以这里给一个明确判定，产物里存档标记，页面/校验都能看到。

    ⚠️ 传进来的最好是**行情自己的时间**（sources.last_snapshot_quote_time()），
       而不是墙上时钟：周末/节假日不开市，那天的行情本身就是上一交易日的收盘价，
       拿墙上时钟去判断只会得出"盘中"这种错误结论（2026-09-12 周六实测踩到过）。
       只有拿不到行情时间时才退回墙上时钟 —— 这时候周末按"已收盘"处理，
       因为周末不可能有新的盘中数据。
    """
    if dt.weekday() >= 5:                 # 周六/周日：不可能有盘中行情
        return True
    return (dt.hour, dt.minute) >= CLOSE_HHMM


def session_note(dt: datetime, quote_dt: datetime | None = None) -> str:
    """
    给日志/产物用的一句话说明（比 True/False 更容易看出到底发生了什么）。

    注意：**节假日无法只靠时钟识别**（工作日但休市）。这种情况下行情时间戳会停在
    上一个交易日，调用方应优先用 quote_dt 来判断 —— 这也是 session_note 收 quote_dt 的原因。
    """
    ref = quote_dt or dt
    if quote_dt is not None and quote_dt.date() != dt.date():
        return f"行情时间 {quote_dt:%Y-%m-%d %H:%M}，与当前日期不同 → 这是 {quote_dt:%m-%d} 的收盘价"
    if ref.weekday() >= 5:
        wd = "周六" if ref.weekday() == 5 else "周日"
        return f"{ref:%Y-%m-%d} 是{wd}，非交易日 → 快照为最近交易日收盘价"
    if (ref.hour, ref.minute) >= CLOSE_HHMM:
        return f"{ref:%H:%M} 已收盘 → 快照为收盘价"
    return f"{ref:%H:%M} 未收盘 → 快照是**盘中价**，不是收盘价"



def org_survey(pages: int = 6, page_size: int = 50, as_of: datetime | None = None) -> list[dict]:
    """
    机构调研（必须带 NUMBERNEW="1"：没有它分页会严重重复；pageSize 上限 50）。

    as_of：只返回该时刻之前已披露的调研（调研公告通常当天盘后披露 → 归到 T+1 使用）。
    """
    rows: list[dict] = []
    for page in range(1, pages + 1):
        j = get_json("", {
            "reportName": "RPT_ORG_SURVEY", "columns": "ALL", "pageNumber": str(page),
            "pageSize": str(page_size), "sortColumns": "RECEIVE_START_DATE", "sortTypes": "-1",
            "source": "WEB", "client": "WEB", "filter": '(NUMBERNEW="1")',
        }, hosts=[DC], path="/api/data/v1/get")
        data = ((j or {}).get("result") or {}).get("data") or []
        if not data:
            break
        rows.extend(data)
        if len(data) < page_size:
            break
    out = []
    for r in rows:
        recv = str(r.get("RECEIVE_START_DATE") or "")[:10]
        notice = str(r.get("NOTICE_DATE") or "")[:10]
        # 可得时刻取"接待日"与"公告日"里较晚的那个（公告日才是市场真正知道的时间）
        avail = available_at(notice or recv, assume_time=ASSUMED_AVAILABLE_TIME)
        out.append({
            "code": str(r.get("SECURITY_CODE") or "").zfill(6),
            "name": r.get("SECURITY_NAME_ABBR"),
            "date": recv,
            "notice": notice,
            "available_at": avail.strftime("%Y-%m-%d %H:%M") if avail else None,
            "orgs": r.get("RECEIVE_OBJECT"), "org_type": r.get("RECEIVE_OBJECT_TYPE"),
            "way": r.get("RECEIVE_WAY_EXPLAIN"), "place": r.get("RECEIVE_PLACE"),
            "investigators": r.get("INVESTIGATORS"), "hosts": r.get("RECEPTIONIST"),
            "org_num": fnum(r.get("NUM")),
            "content": str(r.get("CONTENT") or "").replace("\n", " ")[:200],
        })
    return filter_as_of(out, as_of)


def reports(qtype: int = 0, days: int = 14, page_size: int = 50,
            as_of: datetime | None = None) -> list[dict]:
    """
    券商研报（qType=0 个股 / 1 行业），含评级、目标价、盈利预测。

    as_of：**时点纪律**。接口只给 publishDate（无时分），所以保守按"当日 23:59 才可得"
    处理 —— 也就是说当天发布的研报只用于 **T+1 及以后**的评分，绝不用于当天。
    """
    end = date.today()
    j = get_json("", {
        "pageSize": str(page_size), "pageNo": "1", "qType": str(qtype),
        "beginTime": (end - timedelta(days=days)).isoformat(), "endTime": end.isoformat(),
        "fields": "", "rating": "", "ratingChange": "",
    }, hosts=[REPORT], path="/report/list")
    rows = (j or {}).get("data") or []
    out = []
    for r in rows:
        pub = str(r.get("publishDate") or "")[:10]
        avail = available_at(pub, assume_time=ASSUMED_AVAILABLE_TIME)
        out.append({
            "date": pub,
            "available_at": avail.strftime("%Y-%m-%d %H:%M") if avail else None,
            "code": str(r.get("stockCode") or "").zfill(6),
            "name": r.get("stockName"), "org": r.get("orgSName"), "title": r.get("title"),
            "rating": r.get("emRatingName") or r.get("sRatingName"),
            "rating_change": r.get("ratingChange"),
            "target_high": fnum(r.get("indvAimPriceT")), "target_low": fnum(r.get("indvAimPriceL")),
            "eps_this": fnum(r.get("predictThisYearEps")), "eps_next": fnum(r.get("predictNextYearEps")),
            "pe_this": fnum(r.get("predictThisYearPe")), "pe_next": fnum(r.get("predictNextYearPe")),
            "researcher": r.get("researcher"), "industry": r.get("indvInduName"),
        })
    return filter_as_of(out, as_of)


def rating_summary(codes: list[str], batch: int = 40) -> dict[str, dict]:
    """券商评级家数汇总（RPT_WEB_RESPREDICT，按代码分批 in (...) 查询）。"""
    out: dict[str, dict] = {}
    for group in chunks(list(codes), batch):
        quoted = ",".join(f'"{c}"' for c in group)
        j = get_json("", {
            "reportName": "RPT_WEB_RESPREDICT", "columns": "ALL", "pageNumber": "1",
            "pageSize": "200", "source": "WEB", "client": "WEB",
            "filter": f"(SECURITY_CODE in ({quoted}))",
        }, hosts=[DC], path="/api/data/v1/get")
        rows = ((j or {}).get("result") or {}).get("data") or []
        for r in rows:
            code = str(r.get("SECURITY_CODE") or "").zfill(6)
            if not code or code == "000000":
                continue
            out[code] = {
                "name": r.get("SECURITY_NAME_ABBR"),
                "org_num": int(fnum(r.get("RATING_ORG_NUM")) or 0),
                "buy": int(fnum(r.get("RATING_BUY_NUM")) or 0),
                "add": int(fnum(r.get("RATING_ADD_NUM")) or 0),
                "neutral": int(fnum(r.get("RATING_NEUTRAL_NUM")) or 0),
                "reduce": int(fnum(r.get("RATING_REDUCE_NUM")) or 0),
                "sell": int(fnum(r.get("RATING_SALE_NUM")) or 0),
                "industry": r.get("INDUSTRY_BOARD"),
                "eps": {str(r.get(f"YEAR{i}")): fnum(r.get(f"EPS{i}")) for i in range(1, 5)},
            }
    return out


def describe_sources() -> list[dict]:
    """数据来源清单（页面展示，让每个数字都能溯源）。"""
    return [
        {"item": "个股/指数 K 线", "source": "同花顺官方 API（有 Key 时）→ 否则东方财富 push2his",
         "note": "个股默认前复权，指数无复权；日线"},
        {"item": "主力资金净流入", "source": "东方财富 push2（f62 = 超大单+大单）",
         "note": "单位换算为万元；占流通市值比例用于打分归一化"},
        {"item": "基金流入", "source": "东方财富 ETF 资金流（1599 只）",
         "note": "公募基金申赎份额无免费来源，只能用场内 ETF 代理"},
        {"item": "龙虎榜个股明细", "source": "同花顺官方（有 Key）→ 否则东方财富 RPT_DAILYBILLBOARD_DETAILSNEW",
         "note": "含上榜后 1/2/5/10 日涨跌幅"},
        {"item": "龙虎榜营业部席位 Top5", "source": "东方财富 RPT_BILLBOARD_DAILYDETAILSBUY/SELL",
         "note": "同花顺官方不提供席位明细"},
        {"item": "个股所属行业/概念", "source": "东方财富 push2（f100 行业 / f103 概念）",
         "note": "官方同花顺对应接口尚未开放"},
        {"item": "机构调研", "source": "东方财富 RPT_ORG_SURVEY",
         "note": "同花顺官方无此数据；调研只有关注度、没有多空方向"},
        {"item": "券商研报/评级", "source": "东方财富 reportapi + RPT_WEB_RESPREDICT",
         "note": "同花顺官方无此数据；评级可折算看多/看空"},
        {"item": "获利盘比例/筹码分布", "source": "本工具模型估算",
         "note": "官方与免费渠道均无真实筹码分布；现价以下=获利盘、以上=套牢盘"},
        {"item": "涨停/炸板/跌停池", "source": "东方财富 push2ex",
         "note": "含连板数、封板时间、炸板次数、封单额"},
    ]
