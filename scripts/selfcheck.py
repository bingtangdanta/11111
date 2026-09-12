"""selfcheck.py — 决策验证：回看推荐的**真实结果**，并判断策略是否还有效

用户要求（原话要点）：
    · 每天收盘后自动回看前几日推荐的个股，对比实际涨跌幅
    · 计算"推荐组合"相对大盘的超额收益，连续 N 天跑输就提示"策略可能失效，建议降低仓位"
    · RankIC 连续为负 → 自动降低因子权重（在 factor_ic.py 里）
    · 判断市场环境，单边下跌时触发"空仓预警"
    · 电脑端加"系统自检/决策复盘"模块，顶部醒目提示

这个模块负责把上面除了 RankIC 之外的部分合成一份 `selfcheck.json`。

## 口径（这是整个模块最要紧的事）

旧版回评是"T 日收盘选股 → 取 T+1 的收盘涨跌幅"，**这条口径不可执行**：
收盘那一刻你已经在排队了，买不进去。所以本模块给出**双口径**：

    主口径（可执行）：T+1 **开盘**买入 → T+2 **开盘**卖出，扣掉 ASHARE_COST_BP（默认 20bp）
    对照口径（参考）：T 日收盘 → T+1 收盘（= review.json 里已有的数，用来和旧记录衔接）

开盘价来自**每天快照里的 f17 字段**（东财 clist 本来就返回，加进 fields 即可，零新增请求）。
为什么要靠"当天快照"而不是事后补 K 线：事后补很容易在"中间几天没跑抓取"时**错位**，
而快照是当天定格的，配合 history.json 的交易日序号，能严格判断"今天是不是 T+1 / T+2"。
判断不出来时（比如中间漏了几天）就**明确写"错过采集窗口"**，退回对照口径，绝不硬凑。

## 失败标准（用户确认过的默认值，全部可用环境变量改）

    滚动窗口 = 近 10 个已完成交易日；样本 < 5 日 或 推荐 < 20 只 → "样本不足"（不给"良好"）
    衰减：滚动超额 ≤ −3%  或  滚动胜率 < 45%
    失效：滚动超额 ≤ −6%  或  连续 3 个评估日处于"衰减"
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger("ashare.selfcheck")


def _i(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


def _f(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, str(default)))
    except ValueError:
        return default


WINDOW = _i("ASHARE_CHECK_WINDOW", 10)                 # 滚动窗口（交易日）
COST_BP = _f("ASHARE_COST_BP", 20.0)                   # 双边成本（基点）：佣金+印花税+滑点
DECAY_EXCESS = _f("ASHARE_CHECK_DECAY_EXCESS", -3.0)   # 超额 ≤ 该值 → 衰减
FAIL_EXCESS = _f("ASHARE_CHECK_FAIL_EXCESS", -6.0)     # 超额 ≤ 该值 → 失效
DECAY_WINRATE = _f("ASHARE_CHECK_DECAY_WINRATE", 45.0)  # 胜率 < 该值 → 衰减
DECAY_STREAK_FAIL = _i("ASHARE_CHECK_STREAK_FAIL", 3)  # 连续 N 次衰减 → 失效
MIN_PERIODS = _i("ASHARE_CHECK_MIN_PERIODS", 5)        # 少于此样本量不评价
MIN_PICKS = _i("ASHARE_CHECK_MIN_PICKS", 20)           # 少于此推荐只数不评价
BENCH_CODE = "1.000300"                                # 基准：沪深300
BENCH_FALLBACK = "1.000001"


# ----------------------------------------------------------------------
# 交易日序号（判断"今天"是期初之后的第几个交易日）
# ----------------------------------------------------------------------

def trade_day_index(days: list[str], d: str) -> int | None:
    """某个日期在交易日序列里的下标；找不到返回 None。"""
    try:
        return list(days).index(d)
    except ValueError:
        return None


def is_one_way_limit(bar: dict) -> bool:
    """
    是否"一字板"（最高=最低，全天一个价）。

    一字涨停：**买不进**（开盘就封死）；一字跌停：**卖不出**。
    回评里如果把它们算进去，胜率会凭空变好（买到了根本买不到的票）——
    这是 A 股回测最经典的偏差之一。
    """
    high, low = bar.get("high"), bar.get("low")
    if high is None or low is None:
        return False
    return abs(float(high) - float(low)) < 1e-9


# ----------------------------------------------------------------------
# 主口径：T+1 开盘 → T+2 开盘
# ----------------------------------------------------------------------

def track_picks(periods: list[dict], snapshot_open: dict[str, dict], *,
                days: list[str], today: str, cost_bp: float = COST_BP,
                bench: dict | None = None, prev_periods: list[dict] | None = None) -> list[dict]:
    """
    给每一期推荐记录"可执行口径"的买入/卖出价与收益。

    参数：
        periods       review.json 的 periods（每期有 date / picks[{code,name,score,close}]）
        snapshot_open 当日快照里每只股票的 {open, high, low, prev_close}
        days          history.json 里的交易日序列（用来算"今天是期初之后第几个交易日"）
        today         当前交易日
        cost_bp       双边成本（基点）
        bench         {date: 收盘价} 基准指数收盘价序列，用于算超额
        prev_periods  **上一轮** selfcheck.json 里存下的 periods ——
                      买入价是 T+1 那天记的、收益要到 T+2 才算，跨了两轮，
                      所以必须把上一轮记下的 entry_* 继承过来（否则永远算不出结果）。

    返回：更新后的 periods（**不修改入参**）。每期会带上：
        entry_date / entry_basis / exit_date / basis_used / done / status，
        每只票带上 entry_open / exit_open / gross_pct / net_pct / bench_pct / excess_pct /
        untradable / why。
    """
    today_i = trade_day_index(days, today)
    prev_by_date = {str(p.get("date")): p for p in (prev_periods or [])}
    out: list[dict] = []
    for p in periods or []:
        q = dict(p)
        q["picks"] = [dict(x) for x in (p.get("picks") or [])]
        d = str(p.get("date") or "")

        # ---- 1) 先继承上一轮记下的东西（买入价、已完成的结果） ----
        old = prev_by_date.get(d) or {}
        old_by_code = {str(x.get("code")): x for x in (old.get("picks") or [])}
        for x in q["picks"]:
            o = old_by_code.get(str(x.get("code"))) or {}
            for k in ("entry_open", "entry_high", "entry_low", "entry_prev_close",
                      "exit_open", "gross_pct", "net_pct", "bench_pct", "excess_pct",
                      "untradable", "why"):
                if x.get(k) is None and o.get(k) is not None:
                    x[k] = o[k]
        for k in ("entry_date", "entry_basis", "exit_date", "basis_used", "done", "status"):
            if q.get(k) is None and old.get(k) is not None:
                q[k] = old[k]

        # ---- 2) 再按"今天是 T+几"更新 ----
        d_i = trade_day_index(days, d)
        if d_i is None or today_i is None:
            q["status"] = "未知交易日（不在历史天数里）"
            out.append(q)
            continue
        off = today_i - d_i                      # 今天距期初几个交易日
        q["trade_day_offset"] = off

        if off == 1:
            # 今天是 T+1：记下开盘价（这就是"可执行"的买入价）
            if not q.get("entry_date"):
                q["entry_date"] = today
                q["entry_basis"] = "T+1 开盘"
                for x in q["picks"]:
                    s = snapshot_open.get(str(x.get("code"))) or {}
                    x["entry_open"] = s.get("open")
                    x["entry_high"] = s.get("high")
                    x["entry_low"] = s.get("low")
                    x["entry_prev_close"] = s.get("prev_close")
                    if s.get("open") is None:
                        x["untradable"] = True
                        x["why"] = "T+1 快照里没有这只（停牌/退市？）"
                    elif is_one_way_limit({"high": s.get("high"), "low": s.get("low")}):
                        pct = ((s.get("open") or 0) / (s.get("prev_close") or 1) - 1) * 100
                        x["untradable"] = True
                        x["why"] = (f"T+1 一字板（{pct:+.1f}%），"
                                    + ("开盘封涨停买不进" if pct > 0 else "跌停卖不出"))
                q["status"] = "已记录买入价，等 T+2 卖出"
            out.append(q)
            continue

        if off >= 2:
            if not q.get("entry_date"):
                # 采集窗口错过了（中间几天没跑抓取）→ 不硬凑，退回对照口径
                q["status"] = "错过采集窗口（未在该日运行抓取），退回对照口径"
                q["basis_used"] = "close_to_close"
                out.append(q)
                continue
            q["exit_date"] = today
            for x in q["picks"]:
                s = snapshot_open.get(str(x.get("code"))) or {}
                x["exit_open"] = s.get("open")
                if s.get("open") is None and not x.get("why"):
                    x["untradable"] = True
                    x["why"] = "T+2 快照里没有这只（停牌/退市？）"
                e, xo = x.get("entry_open"), x.get("exit_open")
                if not x.get("untradable") and e and xo:
                    gross = (xo / e - 1) * 100
                    x["gross_pct"] = round(gross, 2)
                    x["net_pct"] = round(gross - cost_bp / 100.0, 2)   # 1bp = 0.01%
                    b = _bench_return(bench, q.get("entry_date"), today)
                    x["bench_pct"] = b
                    if b is not None:
                        x["excess_pct"] = round(x["net_pct"] - b, 2)
            q["basis_used"] = "open_to_open"
            q["done"] = True
            q["status"] = "已完成（T+1 开盘买入 → T+2 开盘卖出）"
            out.append(q)
            continue

        q["status"] = "当日选出，尚未到买入日"
        out.append(q)
    return out


def _bench_return(bench: dict | None, d0: str | None, d1: str | None) -> float | None:
    """基准指数在这两天之间的涨跌幅（%）；缺任一端就返回 None（不填 0）。"""
    if not bench or not d0 or not d1:
        return None
    a, b = bench.get(d0), bench.get(d1)
    if not a or not b:
        return None
    return round((b / a - 1) * 100, 2)


def bench_series(index_kline: dict) -> dict:
    """把指数 K 线整理成 {日期: 收盘价}（回评算超额要用）。"""
    idx = (index_kline or {}).get(BENCH_CODE) or (index_kline or {}).get(BENCH_FALLBACK) or {}
    kl = idx.get("kline") or idx
    dates = kl.get("dates") or []
    closes = kl.get("close") or []
    return {str(d): c for d, c in zip(dates, closes) if c}


# ----------------------------------------------------------------------
# 汇总与评级
# ----------------------------------------------------------------------

def summarize(periods: list[dict], *, window: int = WINDOW) -> dict:
    """
    近 window 个**已完成**交易日的滚动统计（只用可执行口径，剔除不可成交样本）。
    """
    done = [p for p in (periods or []) if p.get("done") and p.get("basis_used") == "open_to_open"]
    done = done[-window:]
    nets, excess, wins, untradable = [], [], 0, 0
    for p in done:
        for x in p.get("picks") or []:
            if x.get("untradable"):
                untradable += 1
                continue
            if x.get("net_pct") is None:
                continue
            nets.append(x["net_pct"])
            if x["net_pct"] > 0:
                wins += 1
            if x.get("excess_pct") is not None:
                excess.append(x["excess_pct"])
    picks = len(nets)
    avg_net = round(sum(nets) / picks, 2) if picks else None
    win_rate = round(wins / picks * 100, 1) if picks else None
    avg_ex = round(sum(excess) / len(excess), 2) if excess else None
    return {
        "window": window,
        "periods_used": len(done),
        "periods_dates": [p.get("date") for p in done],
        "picks": picks,                # 计入胜率分母的样本数（已剔除不可成交）
        "untradable": untradable,      # 不可成交样本**单列**，绝不混进胜率
        "win_rate": win_rate,
        "avg_net": avg_net,
        "avg_excess": avg_ex,
        "bench_available": bool(excess),
        "cost_bp": COST_BP,
    }


def rate(rolling: dict, *, decay_streak: int = 0) -> dict:
    """
    策略有效性评级：良好 / 衰减 / 失效 / 样本不足。

    **样本不足时明确返回"样本不足"，绝不返回"良好"** ——
    拿两三天数据说"策略良好"是最容易让人亏钱的谎话。
    """
    reasons: list[str] = []
    picks = rolling.get("picks") or 0
    periods_used = rolling.get("periods_used") or 0
    if periods_used < MIN_PERIODS or picks < MIN_PICKS:
        return {"level": "样本不足", "decay_streak": decay_streak,
                "reasons": [f"近 {rolling.get('window')} 个交易日里只完成 {periods_used} 期、"
                            f"{picks} 个样本（需要 ≥ {MIN_PERIODS} 期且 ≥ {MIN_PICKS} 个样本）"],
                "thresholds": _thresholds()}
    ex, wr = rolling.get("avg_excess"), rolling.get("win_rate")
    fail = False
    decay = False
    if ex is not None and ex <= FAIL_EXCESS:
        fail = True
        reasons.append(f"滚动超额收益 {ex}% ≤ {FAIL_EXCESS}%")
    if ex is not None and ex <= DECAY_EXCESS:
        decay = True
        reasons.append(f"滚动超额收益 {ex}% ≤ {DECAY_EXCESS}%")
    if wr is not None and wr < DECAY_WINRATE:
        decay = True
        reasons.append(f"滚动胜率 {wr}% < {DECAY_WINRATE}%")
    new_streak = decay_streak + 1 if decay else 0
    if not fail and new_streak >= DECAY_STREAK_FAIL:
        fail = True
        reasons.append(f"连续 {new_streak} 个评估日处于「衰减」")
    if fail:
        return {"level": "失效", "decay_streak": new_streak, "reasons": reasons,
                "thresholds": _thresholds()}
    if decay:
        return {"level": "衰减", "decay_streak": new_streak, "reasons": reasons,
                "thresholds": _thresholds()}
    reasons.append(f"滚动超额 {ex}%、胜率 {wr}%，均在阈值内")
    return {"level": "良好", "decay_streak": 0, "reasons": reasons,
            "thresholds": _thresholds()}


def _thresholds() -> dict:
    return {"window": WINDOW, "decay_excess": DECAY_EXCESS, "fail_excess": FAIL_EXCESS,
            "decay_winrate": DECAY_WINRATE, "decay_streak_fail": DECAY_STREAK_FAIL,
            "min_periods": MIN_PERIODS, "min_picks": MIN_PICKS, "cost_bp": COST_BP}


def banners(rating: dict, regime: dict, rolling: dict) -> list[dict]:
    """
    顶部横幅文案（**只提示，不下单**）。

    顺序 = 严重程度：空仓预警 > 策略失效 > 策略衰减。
    """
    out: list[dict] = []
    if (regime or {}).get("empty_warning"):
        out.append({"level": "danger", "text":
                    "系统自检：当前市场为单边下跌，**不宜出手**（空仓预警）。"
                    "以下是评分参考，不建议按评分建仓。"})
    lvl = (rating or {}).get("level")
    if lvl == "失效":
        out.append({"level": "danger", "text":
                    "系统自检：策略可能失效，建议轻仓观望。"
                    f"（{'；'.join((rating.get('reasons') or [])[:2])}）"})
    elif lvl == "衰减":
        out.append({"level": "warn", "text":
                    "系统自检：策略胜率下降，建议轻仓观望。"
                    f"（{'；'.join((rating.get('reasons') or [])[:2])}）"})
    elif lvl == "样本不足":
        out.append({"level": "info", "text":
                    f"系统自检：样本不足（{rolling.get('periods_used')} 期 / "
                    f"{rolling.get('picks')} 个样本），暂不评价策略有效性。"})
    return out


def advice_override(rating: dict, regime: dict) -> dict:
    """
    是否要把推荐动作统一降级（**只影响页面显示的文字**）。

    失效或空仓预警时，所有个股的建议一律降为"观望"：
    排名还是排名，但"现在该不该动手"是另一件事。
    """
    lvl = (rating or {}).get("level")
    if (regime or {}).get("empty_warning"):
        return {"active": True, "label": "观望",
                "why": "单边下跌环境：空仓预警生效"}
    if lvl == "失效":
        return {"active": True, "label": "观望",
                "why": "策略自检为「失效」：建议轻仓观望"}
    if lvl == "衰减":
        return {"active": True, "label": "观望（轻仓）",
                "why": "策略自检为「衰减」：建议降低仓位"}
    return {"active": False, "label": "", "why": ""}


def build(*, day: str, periods: list[dict], index_kline: dict, dashboard: dict,
          history_days: list[dict], factor_ic: dict | None = None,
          factor_health: dict | None = None, weights_override: dict | None = None,
          health: dict | None = None, prev_decay_streak: int = 0) -> dict:
    """把上面各块合成 selfcheck.json 的内容。"""
    import regime as rg                                   # 局部导入，避免循环依赖
    reg = rg.classify(index_kline=index_kline, dashboard=dashboard, history_days=history_days)
    rolling = summarize(periods)
    r = rate(rolling, decay_streak=prev_decay_streak)
    adv = advice_override(r, reg)
    return {
        "trade_date": day,
        "basis": {
            "main": {"label": "主口径（可执行）", "desc": f"T+1 开盘买入 → T+2 开盘卖出，扣 {COST_BP:.0f}bp 成本"},
            "alt": {"label": "对照口径（参考）", "desc": "T 日收盘 → T+1 收盘（review.json 里的旧口径，不可执行，仅与历史衔接）"},
            "tradability": "一字板（最高=最低）样本单独标记 untradable，**不计入胜率分母**",
            "benchmark": "沪深300（取不到则写基准缺失，不填 0）",
        },
        "periods": periods,
        "rolling": rolling,
        "rating": r,
        "regime": reg,
        "factor_ic": factor_ic or {},
        "factor_health": factor_health or {},
        "weights_override": weights_override or {},
        "collect_health": (health or {}).get("summary") or {},
        "banners": banners(r, reg, rolling),
        "advice_override": adv,
        "note": ("这是**决策验证**结果，不是收益承诺，也不能自动下单："
                 "主口径按 T+1 开盘买入、T+2 开盘卖出并扣成本计算；"
                 "不可成交（一字板）样本单独列出、不计入胜率；"
                 f"滚动窗口 {WINDOW} 个交易日，样本不足时不给评级。"
                 "「策略失效」只是提示你降低仓位，买卖由你自己决定。"),
    }
