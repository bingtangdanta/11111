"""indicators.py — 技术指标（纯 Python，标准库实现，供打分与筛选使用）

包含：MA / EMA / MACD / KDJ / RSI / BOLL，以及日线聚合成周线。
口径与国内软件一致：MACD 柱 = 2×(DIF−DEA)；KDJ 的 K/D 用 1/3 平滑（初始 50）；
RSI 用 Wilder 平滑；BOLL 用总体标准差。

注意：前端画图用的是 JS 版同名实现（scripts 里这份只服务打分与筛选），
两边口径必须一致 —— 所以两份实现都写了单元测试，用同一组序列比对数。
"""

from __future__ import annotations


def _std(values: list[float]) -> float:
    """样本标准差（这里用于 20 日波动率；数据不足或全相等时返回 0）。"""
    vals = [float(v) for v in values if v is not None]
    if len(vals) < 2:
        return 0.0
    mean = sum(vals) / len(vals)
    var = sum((v - mean) ** 2 for v in vals) / (len(vals) - 1)
    return var ** 0.5


def sma(values: list[float], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    total, cnt = 0.0, 0
    for i, v in enumerate(values):
        if v is None:
            total, cnt = 0.0, 0
            continue
        total += v
        cnt += 1
        if cnt > n:
            total -= values[i - n]
            cnt = n
        if cnt == n:
            out[i] = total / n
    return out


def ema(values: list[float | None], n: int) -> list[float | None]:
    out: list[float | None] = [None] * len(values)
    a = 2 / (n + 1)
    prev: float | None = None
    for i, v in enumerate(values):
        if v is None:
            continue
        prev = v if prev is None else a * v + (1 - a) * prev
        out[i] = prev
    return out


def macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    ef, es = ema(closes, fast), ema(closes, slow)
    dif = [None if (ef[i] is None or es[i] is None) else ef[i] - es[i] for i in range(len(closes))]
    dea = ema(dif, signal)
    bar = [None if (dif[i] is None or dea[i] is None) else 2 * (dif[i] - dea[i])
           for i in range(len(closes))]
    return {"dif": dif, "dea": dea, "bar": bar}


def kdj(highs: list[float], lows: list[float], closes: list[float], n: int = 9) -> dict:
    length = len(closes)
    K: list[float | None] = [None] * length
    D: list[float | None] = [None] * length
    J: list[float | None] = [None] * length
    pk = pd = 50.0
    for i in range(length):
        if i < n - 1:
            continue
        hh = max(highs[i - n + 1:i + 1])
        ll = min(lows[i - n + 1:i + 1])
        rsv = 50.0 if hh == ll else (closes[i] - ll) / (hh - ll) * 100
        pk = (2 / 3) * pk + (1 / 3) * rsv
        pd = (2 / 3) * pd + (1 / 3) * pk
        K[i], D[i], J[i] = pk, pd, 3 * pk - 2 * pd
    return {"k": K, "d": D, "j": J}


def rsi(closes: list[float], n: int = 14) -> list[float | None]:
    out: list[float | None] = [None] * len(closes)
    avg_g = avg_l = 0.0
    for i in range(1, len(closes)):
        ch = closes[i] - closes[i - 1]
        gain, loss = max(ch, 0.0), max(-ch, 0.0)
        if i <= n:
            avg_g += gain / n
            avg_l += loss / n
            if i == n:
                out[i] = 100.0 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l)
        else:
            avg_g = (avg_g * (n - 1) + gain) / n
            avg_l = (avg_l * (n - 1) + loss) / n
            out[i] = 100.0 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l)
    return out


def boll(closes: list[float], n: int = 20, k: float = 2.0) -> dict:
    mid = sma(closes, n)
    up: list[float | None] = [None] * len(closes)
    dn: list[float | None] = [None] * len(closes)
    for i in range(len(closes)):
        if mid[i] is None:
            continue
        window = closes[i - n + 1:i + 1]
        mean = mid[i]
        var = sum((x - mean) ** 2 for x in window) / n
        sd = var ** 0.5
        up[i], dn[i] = mean + k * sd, mean - k * sd
    return {"mid": mid, "up": up, "dn": dn}


def to_weekly(bars: list[dict]) -> list[dict]:
    """
    日线聚合为周线（官方只提供日线，周线是**派生数据**，界面需注明）。

    按 ISO 周（年-周）分组：开=首日开、高=区间最高、低=区间最低、收=末日收、
    量=区间合计。
    """
    weeks: dict[tuple[int, int], dict] = {}
    order: list[tuple[int, int]] = []
    for b in bars:
        d = b.get("date") or ""
        try:
            y, m, day = (int(x) for x in str(d)[:10].split("-"))
        except ValueError:
            continue
        import datetime as _dt

        iso = _dt.date(y, m, day).isocalendar()
        key = (iso[0], iso[1])
        if key not in weeks:
            weeks[key] = {"date": str(d)[:10], "open": b.get("open"), "high": b.get("high"),
                          "low": b.get("low"), "close": b.get("close"),
                          "volume": b.get("volume") or 0}
            order.append(key)
        else:
            w = weeks[key]
            w["high"] = max(w["high"] or 0, b.get("high") or 0)
            w["low"] = min(w["low"] or 1e18, b.get("low") or 1e18)
            w["close"] = b.get("close")
            w["volume"] = (w.get("volume") or 0) + (b.get("volume") or 0)
    return [weeks[k] for k in order]


def trend_flags(bars: list[dict]) -> dict:
    """
    计算筛选与打分用的技术特征：
        ma5/10/20/60 最新值、ma5_rising（MA5 是否上行）、close_above_ma5、is_red（收红）
        macd_dif/dea/金叉、日线多头排列、周线多头排列、RSI、BOLL 位置、量比（对 5 日均量）
    """
    if len(bars) < 30:
        return {"insufficient": True}
    closes = [float(b["close"]) for b in bars]
    highs = [float(b["high"]) for b in bars]
    lows = [float(b["low"]) for b in bars]
    vols = [float(b.get("volume") or 0) for b in bars]

    ma5, ma10, ma20, ma60 = (sma(closes, n) for n in (5, 10, 20, 60))
    m = macd(closes)
    r = rsi(closes)
    b_ = boll(closes)
    weekly = to_weekly(bars)
    w_closes = [float(w["close"]) for w in weekly]
    w_ma5, w_ma10, w_ma20 = (sma(w_closes, n) for n in (5, 10, 20))

    last = len(closes) - 1
    golden = None
    for i in range(max(1, last - 5), last + 1):
        if (m["dif"][i] is not None and m["dea"][i] is not None and
                m["dif"][i - 1] is not None and m["dea"][i - 1] is not None):
            if m["dif"][i - 1] <= m["dea"][i - 1] and m["dif"][i] > m["dea"][i]:
                golden = True
                break
    if golden is None and m["dif"][last] is not None and m["dea"][last] is not None:
        golden = m["dif"][last] > m["dea"][last]

    daily_bull = all(x is not None for x in (ma5[last], ma10[last], ma20[last])) and \
        ma5[last] > ma10[last] > ma20[last]
    weekly_bull = all(x is not None for x in (w_ma5[-1], w_ma10[-1], w_ma20[-1])) and \
        w_ma5[-1] > w_ma10[-1] > w_ma20[-1]
    ma5_rising = (ma5[last] is not None and ma5[last - 1] is not None
                  and ma5[last] > ma5[last - 1])
    vol_ma5 = sma(vols, 5)
    volume_ratio = (vols[last] / vol_ma5[last]) if vol_ma5[last] else None

    return {
        "insufficient": False,
        "close": closes[last],
        "open": float(bars[last]["open"]),
        "is_red": closes[last] >= float(bars[last]["open"]),
        "ma5": ma5[last], "ma10": ma10[last], "ma20": ma20[last], "ma60": ma60[last],
        "ma5_rising": ma5_rising,
        "close_above_ma5": (ma5[last] is not None and closes[last] > ma5[last]),
        "macd_golden": bool(golden),
        "macd_dif": m["dif"][last], "macd_dea": m["dea"][last],
        "daily_bull": bool(daily_bull),
        "weekly_bull": bool(weekly_bull),
        "rsi14": r[last],
        "boll_up": b_["up"][last], "boll_mid": b_["mid"][last], "boll_dn": b_["dn"][last],
        "volume_ratio": round(volume_ratio, 2) if volume_ratio else None,
        "dev_ma20_pct": (round((closes[last] / ma20[last] - 1) * 100, 2)
                         if ma20[last] else None),
        "ret_5d_pct": (round((closes[last] / closes[last - 5] - 1) * 100, 2)
                       if len(closes) > 5 else None),
        # 20 日动量：v2 评分用它做截面百分位（比"5 日涨幅"稳，不容易被一两根大阳线带偏）
        "ret_20d_pct": (round((closes[last] / closes[last - 20] - 1) * 100, 2)
                        if len(closes) > 20 else None),
        # 20 日年化波动率（%）：用于风险项与后续因子分析，拿不到就是 None
        "vol_20d_pct": (round(_std(closes[last - 20:last]) / closes[last] * 100
                              * (252 ** 0.5), 2) if len(closes) > 20 and closes[last] else None),
    }
