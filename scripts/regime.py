"""regime.py — 市场环境判定（普涨 / 震荡 / 单边下跌）+ 空仓预警

用户要求（原话要点）：
    · 系统要能判断当前市场是"普涨、震荡、还是单边下跌"
    · 如果是单边下跌环境，即使打分再高，也要自动触发"空仓预警"，
      给出"当前市场环境不宜出手"的提示

为什么这件事必须**给出依据**而不是只给结论：
    "系统说现在不宜出手"是个很重的判断，如果只显示一句话，
    使用者没法反驳也没法信任。所以这里的返回值里带着**四个原始数字**
    （指数离 MA20 多少、MA20 是上还是下、近 10 日下跌家数占比、指数 20 日收益），
    页面上一起显示，谁都能复核。

数据来源：**全部用现有产物**（`index_kline.json`、`dashboard.json`、`history.json`），
不需要任何新接口 —— 这也是它能在 CI 里零成本跑起来的原因。
"""

from __future__ import annotations

import logging

log = logging.getLogger("ashare.regime")

#: 判定用的指数（沪深300：A 股最常用的基准，也是回评的超额基准，保持一致）
BENCH_CODE = "1.000300"
#: 兜底指数（沪深300 取不到时用上证指数）
BENCH_FALLBACK = "1.000001"

# ---------------- 阈值（全部可用环境变量覆盖，改成你认可的数不用动代码） ----------------
import os as _os


def _f(name: str, default: float) -> float:
    try:
        return float(_os.environ.get(name, str(default)))
    except ValueError:
        return default


MA_WINDOW = int(_f("ASHARE_REGIME_MA", 20))            # 均线窗口
RET_WINDOW = int(_f("ASHARE_REGIME_RET_DAYS", 20))     # "N 日收益"的窗口
DOWN_RATIO_WINDOW = int(_f("ASHARE_REGIME_DOWN_DAYS", 10))   # 看近 N 日的下跌家数
#: 单边下跌的四个条件（**同时满足**才判定，避免一条就喊狼来了）
DOWN_RET_MAX = _f("ASHARE_REGIME_DOWN_RET", -8.0)      # 指数 N 日收益 ≤ −8%
DOWN_RATIO_MIN = _f("ASHARE_REGIME_DOWN_RATIO", 0.60)  # 近 N 日下跌家数占比中位数 > 60%
#: 普涨
UP_RATIO_MIN = _f("ASHARE_REGIME_UP_RATIO", 1.5)       # 涨跌家数比 > 1.5
#: 判定所需的最少 K 线根数（不够就诚实地说"数据不足"，不硬判）
MIN_BARS = max(MA_WINDOW, RET_WINDOW) + 2


def _mean(xs: list[float]) -> float | None:
    return (sum(xs) / len(xs)) if xs else None


def _median(xs: list[float]) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def index_state(kline: dict | None, *, ma_window: int = MA_WINDOW,
                ret_window: int = RET_WINDOW) -> dict | None:
    """
    指数状态：现价、MA20、MA20 斜率、20 日收益、离 MA20 的百分比。

    返回 None 表示"数据不足"（少于 ma_window+2 根）—— **不要**在这种情况下
    编一个默认值出来，因为下游会用它做"要不要清仓"的判断。
    """
    close = [c for c in ((kline or {}).get("close") or []) if isinstance(c, (int, float))]
    if len(close) < ma_window + 2:
        return None
    ma_now = _mean(close[-ma_window:])
    ma_prev = _mean(close[-ma_window - 1:-1])
    if ma_now is None or ma_prev is None or not ma_now or not ma_prev:
        return None
    cur = close[-1]
    ret = None
    if len(close) > ret_window:
        base = close[-ret_window - 1]
        if base:
            ret = round((cur / base - 1) * 100, 2)
    return {
        "close": round(cur, 2),
        "ma": round(ma_now, 2),
        "ma_slope_pct": round((ma_now / ma_prev - 1) * 100, 2),   # >0 均线上行
        "above_ma": cur >= ma_now,
        "gap_pct": round((cur / ma_now - 1) * 100, 2),            # 正=在均线上方
        "ret_pct": ret,
        "bars": len(close),
    }


def down_ratio_series(history_days: list[dict], window: int = DOWN_RATIO_WINDOW) -> list[float]:
    """
    近 N 个交易日的"下跌家数占比"序列（0~1）。

    为什么用**中位数**而不是最后一天：单看最后一天很容易被某一天的大跌带偏。
    中位数代表"这段时间里大多数交易日是什么状态"，更适合判断趋势性下跌。
    """
    out: list[float] = []
    for d in (history_days or [])[-window:]:
        up = d.get("advancing") or d.get("up_count")
        down = d.get("declining") or d.get("down_count")
        if not up and not down:
            continue
        total = (up or 0) + (down or 0)
        if total:
            out.append(round((down or 0) / total, 4))
    return out


def classify(*, index_kline: dict, dashboard: dict, history_days: list[dict]) -> dict:
    """
    判定市场环境。返回：

        {
          "regime": "普涨" | "震荡" | "单边下跌" | "数据不足",
          "empty_warning": bool,          # 是否触发"空仓预警"
          "advice": "...",                # 给页面顶部的原文案
          "evidence": {...},              # 判定的四个原始数字（必须显示给用户）
          "reasons": ["...", "..."],      # 人话解释，逐条对应 evidence
          "thresholds": {...}             # 这轮用的阈值（可复核）
        }

    ⚠️ 数据不足时返回"数据不足"而不是"震荡"：
       "震荡"是个**结论**，缺数据时给结论就是编。
    """
    idx = (index_kline or {}).get(BENCH_CODE) or (index_kline or {}).get(BENCH_FALLBACK) or {}
    kl = idx.get("kline") or idx
    st = index_state(kl)
    breadth = (dashboard or {}).get("breadth") or {}
    up, down = breadth.get("advancing"), breadth.get("declining")
    adr = breadth.get("advance_decline_ratio")
    if adr is None and up and down:
        adr = round(up / down, 3)
    drs = down_ratio_series(history_days)
    down_med = _median(drs)

    evidence = {
        "index_name": idx.get("name") or "沪深300",
        "index": st,
        "advance_decline_ratio": adr,
        "down_ratio_median_10d": down_med,
        "down_ratio_days": len(drs),
        "history_days": len(history_days or []),
    }
    thresholds = {"ma_window": MA_WINDOW, "ret_window": RET_WINDOW,
                  "down_ret_max": DOWN_RET_MAX, "down_ratio_min": DOWN_RATIO_MIN,
                  "up_ratio_min": UP_RATIO_MIN, "down_ratio_window": DOWN_RATIO_WINDOW}

    if st is None or down_med is None:
        return {
            "regime": "数据不足",
            "empty_warning": False,
            "advice": "市场环境无法判定：指数 K 线或历史天数不足，本项按数据缺失处理。",
            "evidence": evidence, "thresholds": thresholds,
            "reasons": [f"指数 K 线 {len((kl or {}).get('close') or [])} 根（需要 ≥ {MIN_BARS} 根）",
                        f"涨跌家数历史 {len(history_days or [])} 天（需要 ≥ 1 天）"],
            "note": "数据不足时**不给结论**（不给『震荡』），避免用缺数据硬判。",
        }

    reasons_all: list[str] = []
    # ---- 单边下跌：四个条件必须同时满足 ----
    c_below = not st["above_ma"]
    c_slope = st["ma_slope_pct"] < 0
    c_down = down_med > DOWN_RATIO_MIN
    c_ret = st["ret_pct"] is not None and st["ret_pct"] <= DOWN_RET_MAX
    reasons_all.append(
        f"{st['close']} vs MA{MA_WINDOW} {st['ma']}（{st['gap_pct']:+.2f}%）"
        f"{'，在均线下方' if c_below else '，在均线上方'}")
    reasons_all.append(f"MA{MA_WINDOW} 斜率 {st['ma_slope_pct']:+.2f}%"
                       f"（{'下行' if c_slope else '上行/走平'}）")
    reasons_all.append(f"近 {DOWN_RATIO_WINDOW} 日下跌家数占比中位数 {down_med * 100:.1f}%"
                       f"（阈值 >{DOWN_RATIO_MIN * 100:.0f}%）")
    if st["ret_pct"] is not None:
        reasons_all.append(f"指数 {RET_WINDOW} 日收益 {st['ret_pct']:+.2f}%"
                           f"（阈值 ≤{DOWN_RET_MAX:.0f}%）")

    if c_below and c_slope and c_down and c_ret:
        return {
            "regime": "单边下跌",
            "empty_warning": True,
            "advice": "⚠️ 空仓预警：当前市场环境不宜出手（单边下跌）。"
                      "系统仍会给出评分，但**不建议按评分建仓**。",
            "evidence": evidence, "thresholds": thresholds, "reasons": reasons_all,
            "note": "四个条件同时满足才判定单边下跌（指数在均线下方、均线下行、"
                    "多数股票在跌、指数 N 日跌幅够大）。这是本工具的自定义规则，不是官方结论。",
        }
    # ---- 普涨 ----
    if adr is not None and adr > UP_RATIO_MIN and st["above_ma"]:
        return {
            "regime": "普涨",
            "empty_warning": False,
            "advice": "市场偏普涨：赚钱效应较好，可正常参考评分。",
            "evidence": evidence, "thresholds": thresholds,
            "reasons": reasons_all + [f"涨跌家数比 {adr}（阈值 >{UP_RATIO_MIN}）"],
            "note": "普涨不代表每只都涨；评分仍是相对强弱。",
        }
    return {
        "regime": "震荡",
        "empty_warning": False,
        "advice": "市场偏震荡：评分可用，但注意仓位与止损。",
        "evidence": evidence, "thresholds": thresholds, "reasons": reasons_all,
        "note": "不满足单边下跌的四个条件、也不满足普涨条件时归为震荡。",
    }
