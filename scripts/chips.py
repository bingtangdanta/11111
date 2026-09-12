"""chips.py — 筹码分布 + 获利盘/套牢盘比例（按用户指定的口径实现）

口径（用户要求，也是本文件的核心约定）
--------------------------------------
    现价**以上**的筹码 = 套牢盘
    现价**以下**的筹码 = 获利盘

官方数据不存在（同花顺官方 API 与全网免费渠道都没有真实筹码分布），所以这里是
**模型估算**，页面必须显著标注"估算·非官方"。估算方法（与原项目已验证的实现一致）：

  1. 逐日把当日成交量摊到价格轴上：假设当日成交价在 [最低价, 最高价] 之间呈
     **三角分布**，峰值取 (最高+最低+收盘)/3 —— 比"均匀分布"更贴近真实的成交密集区。
  2. 越久远的交易日权重越低：按**半衰期 120 个交易日**指数衰减
     （weight = volume * 0.5 ** (age / 120)），因为老筹码更容易被换手掉。
  3. 在价格轴上分箱累加，得到成本分布直方图；
     获利盘比例 = 现价以下所有分箱权重 / 总权重；套牢盘 = 现价以上。
  4. 再由直方图推导：平均成本、集中度 HHI、密集筹码带（占比 10% 的最窄价格区间）、
     峰/谷（平滑后的局部极值）。

为什么用"数值采样"而不是解析积分：三角分布与分箱的解析重叠积分容易写错，
采样 40 个分位点后落入分箱，误差 < 1 个分箱，代码可读性和可验证性都更好。
"""

from __future__ import annotations

import math

BINS = 60
HALF_LIFE = 120      # 交易日
SAMPLES = 40         # 每根 K 线的采样点数
LOOKBACK = 250       # 参与估算的交易日数


def _triangular_samples(low: float, high: float, peak: float, n: int) -> list[float]:
    """在 [low, high] 上按三角分布（峰值 peak）取 n 个分位点。"""
    if high <= low:
        return [low] * n
    peak = min(max(peak, low), high)
    # 三角分布 CDF 的逆函数（分两段）
    left = (peak - low) / (high - low)          # 峰值所在的分位点
    left = min(max(left, 1e-6), 1 - 1e-6)
    out = []
    for i in range(n):
        u = (i + 0.5) / n
        if u < left:
            val = low + math.sqrt(u * left) * (peak - low)
        else:
            val = high - math.sqrt((1 - u) * (1 - left)) * (high - peak)
        out.append(val)
    return out


def cost_distribution(bars: list[dict], *, bins: int = BINS, lookback: int = LOOKBACK,
                      half_life: float = HALF_LIFE) -> tuple[list[float], list[float], float, float]:
    """
    成本分布直方图。

    bars: 按时间**升序**的日线列表，元素需含 open/high/low/close/volume。
    返回 (价格中心列表, 权重列表, 最低价, 最高价)。权重已归一化（和为 1）。
    """
    data = [b for b in bars[-lookback:] if b.get("high") and b.get("low")]
    if not data:
        return [], [], 0.0, 0.0

    lows = [float(b["low"]) for b in data]
    highs = [float(b["high"]) for b in data]
    lo, hi = min(lows), max(highs)
    if hi <= lo:
        hi = lo + 0.01

    width = (hi - lo) / bins
    weights = [0.0] * bins

    n_bars = len(data)
    for idx, bar in enumerate(data):
        age = n_bars - 1 - idx                      # 最新一根 age=0
        decay = 0.5 ** (age / float(half_life))
        vol = float(bar.get("volume") or 0)
        if vol <= 0:
            continue
        low = float(bar["low"])
        high = float(bar["high"])
        close = float(bar.get("close") or (low + high) / 2)
        peak = (high + low + close) / 3
        w = vol * decay / SAMPLES
        for price in _triangular_samples(low, high, peak, SAMPLES):
            b = int((price - lo) / width)
            if b < 0:
                b = 0
            elif b >= bins:
                b = bins - 1
            weights[b] += w

    total = sum(weights)
    if total <= 0:
        return [], [], lo, hi
    weights = [w / total for w in weights]
    centers = [lo + width * (i + 0.5) for i in range(bins)]
    return centers, weights, lo, hi


def profit_ratio(centers: list[float], weights: list[float], price: float) -> tuple[float, float]:
    """返回 (获利盘比例%, 套牢盘比例%)。现价以下=获利盘，以上=套牢盘。"""
    if not centers or not weights or not price:
        return 0.0, 0.0
    below = sum(w for c, w in zip(centers, weights) if c <= price)
    return round(below * 100, 2), round((1 - below) * 100, 2)


def _smooth(values: list[float], window: int = 3) -> list[float]:
    if len(values) < window:
        return list(values)
    half = window // 2
    out = []
    for i in range(len(values)):
        seg = values[max(0, i - half):i + half + 1]
        out.append(sum(seg) / len(seg))
    return out


def _peaks_valleys(centers: list[float], weights: list[float], price: float,
                   *, window: int = 3, min_share: float = 0.015) -> tuple[list, list]:
    """平滑后找局部极大/极小（过滤掉占比过小的噪声峰）。"""
    if len(weights) < window * 2 + 1:
        return [], []
    sm = _smooth(weights, window)
    peaks, valleys = [], []
    for i in range(1, len(sm) - 1):
        if sm[i] >= sm[i - 1] and sm[i] > sm[i + 1] and sm[i] >= min_share:
            peaks.append({"price": round(centers[i], 2),
                          "share": round(sm[i] * 100, 2),
                          "above_current": centers[i] > price})
        elif sm[i] <= sm[i - 1] and sm[i] < sm[i + 1]:
            valleys.append({"price": round(centers[i], 2),
                            "share": round(sm[i] * 100, 2)})
    peaks.sort(key=lambda p: -p["share"])
    return peaks[:4], valleys[:4]


def _top_band(centers: list[float], weights: list[float], target: float = 0.10) -> dict:
    """占比约 target 的最窄价格带（从权重最高的分箱向两侧扩展）。"""
    if not weights:
        return {}
    order = sorted(range(len(weights)), key=lambda i: -weights[i])
    chosen, acc = [], 0.0
    for i in order:
        chosen.append(i)
        acc += weights[i]
        if acc >= target:
            break
    idx = sorted(chosen)
    return {"low": round(centers[idx[0]], 2), "high": round(centers[idx[-1]], 2),
            "share": round(acc * 100, 2)}


def summarize(bars: list[dict], price: float | None = None) -> dict:
    """
    一次算出界面要用的全部筹码指标。

    返回：
        profit_ratio_pct   获利盘比例（估算，%）
        trapped_ratio_pct  套牢盘比例（估算，%）
        avg_cost           加权平均成本（估算）
        hhi                集中度（赫芬达尔指数，越大越集中）
        top10_band         密集筹码带（占比 10% 的最窄区间）
        peaks / valleys    峰 / 谷
        shape              形态文字（单峰密集 / 多峰分散 / 双峰 …）
        rows               直方图（价格, 占比%）供前端画图
        note               口径说明（页面必须显示）
    """
    centers, weights, lo, hi = cost_distribution(bars or [])
    note = ("估算值：按「当日成交量在最低~最高价之间呈三角分布、峰值取(高+低+收)/3、"
            "半衰期 120 个交易日衰减」的模型推算；现价以下计为获利盘、以上计为套牢盘。"
            "官方筹码分布数据不存在，本值不可当作官方数据，也不宜跨股票比较。")
    if not centers or not weights:
        return {"profit_ratio_pct": None, "trapped_ratio_pct": None, "avg_cost": None,
                "hhi": None, "top10_band": {}, "peaks": [], "valleys": [], "shape": "数据缺失",
                "rows": [], "note": note}

    cur = float(price) if price else None
    if cur is None:
        # ⚠️ 这里曾经写成 centers[-1]（价格轴的**最高档**），一旦快照没给现价，
        #    就会用最高价当现价 → 获利盘被算成接近 100%，看起来"全都在赚钱"，
        #    而且不会报错。正确兜底是**最后一根 K 线的收盘价**。
        last_bar = (bars or [{}])[-1]
        cur = float(last_bar.get("close") or 0) or centers[-1]
    prof, trap = profit_ratio(centers, weights, cur)
    avg_cost = sum(c * w for c, w in zip(centers, weights))
    hhi = sum(w * w for w in weights)
    peaks, valleys = _peaks_valleys(centers, weights, cur)

    if len(peaks) == 0:
        shape = "单峰密集" if hhi > 0.05 else "分布平坦"
    elif len(peaks) == 1:
        shape = "单峰密集" if peaks[0]["share"] >= 6 else "单峰偏弱"
    elif len(peaks) == 2:
        shape = "双峰（上下各一密集区）"
    else:
        shape = f"多峰分散（{len(peaks)} 个峰）"

    rows = [{"price": round(c, 2), "share": round(w * 100, 2)}
            for c, w in zip(centers, weights)]
    return {"profit_ratio_pct": prof, "trapped_ratio_pct": trap,
            "avg_cost": round(avg_cost, 2), "hhi": round(hhi, 5),
            "top10_band": _top_band(centers, weights),
            "peaks": peaks, "valleys": valleys, "shape": shape,
            "rows": rows, "note": note}
