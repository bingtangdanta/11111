"""factor_ic.py — 因子有效性检验：因子快照 → RankIC / ICIR / 分组收益 → 自动降权

用户要求（原话要点）：
    · 计算 RankIC（因子与未来收益的相关性）
    · 如果某个因子 RankIC 连续为负，系统自动降低该因子权重甚至下线该因子

这个模块存在的意义：**在此之前，`scoring.py` 里那组权重（趋势26/资金22/…）是手拍的，
从没被数据检验过**。没有这一步，"优化评分逻辑"就只能靠感觉。

三条纪律（不遵守的话，"自动降权"会变成"追着噪音改权重"）：

    ① **绝不用未来数据**：因子快照按交易日存档，未来收益只在"后面的交易日已经存在"时才回填。
       回填靠的是**相邻的两份快照**（不是当前快照），所以不会出现"用今天的数据算昨天的收益"。
    ② **样本不够就不动权重**：至少 MIN_DAYS 个交易日才允许第一次调整；
       不足时页面显示"样本 N/M，暂不调权"，这一点比"能自动调权"更重要。
    ③ **有地板、有阶梯、有留痕**：单次最多砍到 0.7 倍、累计地板是名义权重的 30%；
       "下线"要求连续多次为负，并且写进 weights_override.json 时标注"自动下线，等待人工确认"。
"""

from __future__ import annotations

import json
import logging
import math
import os

log = logging.getLogger("ashare.factor_ic")

#: 要检验的因子：key 必须与 fetch_data 写进 features 的键一致，
#: label 给人看，higher_better 决定"正向因子还是反向因子"（IC 符号解读要用）
FACTORS: list[dict] = [
    {"key": "ret_20d", "label": "20日动量", "dim": "trend", "higher_better": True},
    {"key": "main_net_ratio", "label": "主力净额/流通市值", "dim": "fund", "higher_better": True},
    {"key": "super_ratio", "label": "大单占比", "dim": "fund", "higher_better": True},
    {"key": "dragon_net", "label": "龙虎榜净额", "dim": "fund", "higher_better": True},
    {"key": "profit_ratio", "label": "获利盘比例", "dim": "chip", "higher_better": True},
    {"key": "hhi", "label": "筹码集中度", "dim": "chip", "higher_better": True},
    {"key": "rating_score", "label": "研报评级分", "dim": "inst", "higher_better": True},
    {"key": "upside_pct", "label": "目标价空间", "dim": "inst", "higher_better": True},
    {"key": "survey_orgs", "label": "调研机构家数", "dim": "inst", "higher_better": True},
    {"key": "industry_chg_rank", "label": "行业内涨幅分位", "dim": "sector", "higher_better": True},
    {"key": "fund_score", "label": "基本面分", "dim": "base", "higher_better": True},
    {"key": "vol_20d", "label": "20日波动率", "dim": "risk", "higher_better": False},
    {"key": "turnover", "label": "换手率", "dim": "risk", "higher_better": False},
    {"key": "ret_5d", "label": "近5日涨幅", "dim": "risk", "higher_better": False},
]
FACTOR_KEYS = [f["key"] for f in FACTORS]

# ---------------- 调权规则（可用环境变量覆盖） ----------------
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


MIN_DAYS = _i("ASHARE_IC_MIN_DAYS", 20)             # 至少多少个有效交易日才允许调权
IC_WINDOW = _i("ASHARE_IC_WINDOW", 20)              # 用近多少日的 IC 均值判断
IC_NEG_1 = _f("ASHARE_IC_NEG1", 0.0)                # IC 均值 < 该值 → 一次降权
WEIGHT_STEP1 = _f("ASHARE_IC_STEP1", 0.7)           # 第一次降权系数
WEIGHT_STEP2 = _f("ASHARE_IC_STEP2", 0.5)           # 连续多次为负后的系数
NEG_STREAK_STEP2 = _i("ASHARE_IC_STREAK2", 4)       # 连续 N 次评估为负 → 用 STEP2
NEG_STREAK_OFF = _i("ASHARE_IC_STREAK_OFF", 6)      # 连续 N 次 → 自动下线（等人工确认）
WEIGHT_FLOOR = _f("ASHARE_IC_FLOOR", 0.30)          # 地板：不低于名义权重的 30%
MIN_RANK_N = _i("ASHARE_IC_MIN_N", 30)              # 单日算 IC 至少要有这么多只股票


# ----------------------------------------------------------------------
# 统计工具（纯标准库）
# ----------------------------------------------------------------------

def _rank(xs: list[float]) -> list[float]:
    """平均秩（并列取平均），Spearman 要用。"""
    order = sorted(range(len(xs)), key=lambda i: xs[i])
    ranks = [0.0] * len(xs)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and xs[order[j + 1]] == xs[order[i]]:
            j += 1
        avg = (i + j) / 2.0 + 1.0
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    return ranks


def _pearson(xs: list[float], ys: list[float]) -> float | None:
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    dy = math.sqrt(sum((y - my) ** 2 for y in ys))
    if dx == 0 or dy == 0:
        return None
    return num / (dx * dy)


def rank_ic(pairs: list[tuple[float, float]]) -> float | None:
    """
    RankIC = 因子值与未来收益的**秩相关**（Spearman）。

    为什么用秩而不是线性相关：A 股因子里有大量极端值（比如某只票主力净额突然放大 50 倍），
    线性相关会被这些极值带跑；秩相关只看"排序对不对"，更贴近"按评分排序选股"这件事本身。
    """
    pairs = [(a, b) for a, b in pairs if a is not None and b is not None]
    if len(pairs) < MIN_RANK_N:
        return None
    xs = _rank([float(a) for a, _ in pairs])
    ys = _rank([float(b) for _, b in pairs])
    r = _pearson(xs, ys)
    return None if r is None else round(r, 4)


def group_returns(pairs: list[tuple[float, float]], groups: int = 5) -> list[dict]:
    """
    按因子值分 N 档，看各档的平均未来收益（因子单调性）。

    为什么 IC 之外还要看这个：IC 是"整体相关"，分组收益能直接回答
    "排在最前面的那一档是不是真的涨得最好" —— 这是使用者最关心的问题。
    """
    rows = [(a, b) for a, b in pairs if a is not None and b is not None]
    if len(rows) < groups * 3:
        return []
    rows.sort(key=lambda x: -x[0])                    # 因子值从高到低
    out = []
    n = len(rows)
    for g in range(groups):
        lo, hi = int(g * n / groups), int((g + 1) * n / groups)
        seg = rows[lo:hi]
        if not seg:
            continue
        out.append({"group": g + 1, "n": len(seg),
                    "avg_ret": round(sum(b for _, b in seg) / len(seg), 4)})
    return out


def icir(ics: list[float]) -> float | None:
    """ICIR = IC 均值 / IC 标准差。衡量"因子是不是稳定地有效"（而不是偶尔灵一次）。"""
    xs = [x for x in ics if x is not None]
    if len(xs) < 5:
        return None
    m = sum(xs) / len(xs)
    var = sum((x - m) ** 2 for x in xs) / (len(xs) - 1)
    sd = math.sqrt(var)
    if sd == 0:
        return None
    return round(m / sd, 3)


# ----------------------------------------------------------------------
# 因子快照：存档 + 回填未来收益（严格 point-in-time）
# ----------------------------------------------------------------------

def snapshot_path(out_dir: str, day: str) -> str:
    return os.path.join(out_dir, "factors", f"{day}.json")


def save_snapshot(out_dir: str, day: str, scored: list[dict],
                  *, extra: dict | None = None) -> int:
    """
    把当日精算池的**原始因子值**存档（+ 当日收盘价，回填收益时要用）。

    为什么存原始因子值而不是存分数：分数是加权后的结果，
    权重一变就没法复用了；原始因子值才是"可被反复检验"的东西。
    """
    rows = []
    for s in scored:
        f = s.get("features") or {}
        bar = (s.get("_bars") or [{}])[-1]
        row = {"code": s["code"], "name": s.get("name"), "close": bar.get("close")}
        for k in FACTOR_KEYS:
            v = f.get(k)
            if isinstance(v, bool):                    # 布尔因子（如 daily_bull）转 0/1
                v = 1.0 if v else 0.0
            row[k] = v if isinstance(v, (int, float)) else None
        rows.append(row)
    payload = {"date": day, "count": len(rows), "factors": FACTOR_KEYS, "rows": rows}
    if extra:
        payload.update(extra)
    os.makedirs(os.path.join(out_dir, "factors"), exist_ok=True)
    path = snapshot_path(out_dir, day)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    return len(rows)


def list_snapshots(out_dir: str) -> list[str]:
    d = os.path.join(out_dir, "factors")
    if not os.path.isdir(d):
        return []
    return sorted(fn[:-5] for fn in os.listdir(d)
                  if fn.endswith(".json") and fn[:-5][:2] == "20")


def load_snapshot(out_dir: str, day: str) -> dict | None:
    try:
        with open(snapshot_path(out_dir, day), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def forward_returns(out_dir: str, *, today: str, horizons: tuple[int, ...] = (1, 5)) -> dict:
    """
    用**相邻快照**回填未来收益，再算每日 IC。

    为什么用相邻快照而不是"当前快照"：当前快照只有今天的收盘价，
    拿它去算 5 天前的"未来 5 日收益"就要求"今天是 5 个交易日之后" ——
    一旦中间的交易日没跑抓取（比如周末、Actions 挂了），这个假设就错了，
    会算出**错位的收益**。用相邻快照序号做差，天然只认"确实隔了 N 份快照"的数据。

    返回：
        {
          "days": [ {date, base_count, horizons: {1: {ic: {...}, n}, 5: {...}} } ],
          "series": { 因子key: [ {date, ic_1d, ic_5d} ... ] },
          "samples": { 因子key: 有效天数 },
          "note": "..."
        }
    """
    dates = [d for d in list_snapshots(out_dir) if d <= today]
    snaps = {d: load_snapshot(out_dir, d) for d in dates}
    days_out: list[dict] = []
    series: dict[str, list[dict]] = {k: [] for k in FACTOR_KEYS}
    for i, d in enumerate(dates):
        base = snaps.get(d) or {}
        rows = {r["code"]: r for r in (base.get("rows") or [])}
        if not rows:
            continue
        entry = {"date": d, "base_count": len(rows), "horizons": {}}
        for h in horizons:
            if i + h >= len(dates):
                continue                                  # 还没到那一天，不许提前算
            fut = snaps.get(dates[i + h]) or {}
            frows = {r["code"]: r for r in (fut.get("rows") or [])}
            for key in FACTOR_KEYS:
                pairs = []
                for code, r in rows.items():
                    fr = frows.get(code)
                    if not fr or not r.get("close") or not fr.get("close"):
                        continue
                    ret = (fr["close"] / r["close"] - 1) * 100
                    pairs.append((r.get(key), ret))
                ic = rank_ic(pairs)
                if ic is not None:
                    entry["horizons"].setdefault(str(h), {})[key] = ic
                if h == 1:
                    series[key].append({"date": d, "ic_1d": ic})
        days_out.append(entry)
    samples = {k: sum(1 for x in v if x.get("ic_1d") is not None) for k, v in series.items()}
    # 分组收益（用最近一份"已经有未来收益"的基准日算，给页面看单调性）
    last_groups: dict[str, list[dict]] = {}
    usable = [d for d in days_out if d["horizons"].get("1")]
    if usable:
        d0 = usable[-1]["date"]
        i0 = dates.index(d0)
        if i0 + 1 < len(dates):
            base = snaps[d0] or {}
            fut = snaps[dates[i0 + 1]] or {}
            frows = {r["code"]: r for r in (fut.get("rows") or [])}
            for key in FACTOR_KEYS:
                pairs = []
                for r in (base.get("rows") or []):
                    fr = frows.get(r["code"])
                    if fr and r.get("close") and fr.get("close"):
                        pairs.append((r.get(key), (fr["close"] / r["close"] - 1) * 100))
                g = group_returns(pairs)
                if g:
                    last_groups[key] = g
    return {"days": days_out, "series": series, "samples": samples,
            "groups": last_groups,
            "sample_dates": len(dates),
            "note": ("未来收益只用**后面的快照**回填（严格 point-in-time，不看未来）；"
                     f"单日算 IC 至少需要 {MIN_RANK_N} 只股票。")}


# ----------------------------------------------------------------------
# 因子健康 → 权重覆盖（带地板与阶梯）
# ----------------------------------------------------------------------

def factor_health(ic: dict, *, extra_series: dict | None = None) -> dict:
    """
    根据 IC 历史给出每个因子的健康状态与**建议权重系数**。

    返回：
        {
          "sample_dates": N, "window": 20, "min_days": 20,
          "ready": bool,                       # 样本够不够调权
          "factors": { key: {label, dim, ic_mean, icir, neg_streak, factor, action} },
          "note": "..."
        }
    """
    series = (ic or {}).get("series") or {}
    sample_dates = int((ic or {}).get("sample_dates") or 0)
    ready = sample_dates >= MIN_DAYS
    old_neg = ((extra_series or {}).get("neg_streak") or {})
    out: dict[str, dict] = {}
    for spec in FACTORS:
        key = spec["key"]
        vals = [x.get("ic_1d") for x in (series.get(key) or []) if x.get("ic_1d") is not None]
        recent = vals[-IC_WINDOW:]
        mean = round(sum(recent) / len(recent), 4) if recent else None
        icr = icir(recent) if recent else None
        # 连续为负的评估次数：**跨轮累积**（存在 weights_override.json 里带过来），
        # 否则每天都是"第一次为负"，永远触发不了连续判定
        streak = int(old_neg.get(key, 0))
        if mean is not None and mean < IC_NEG_1:
            streak += 1
        elif mean is not None:
            streak = 0
        factor = 1.0
        action = "正常"
        if not ready:
            action = f"样本不足（{sample_dates}/{MIN_DAYS} 个交易日），暂不调权"
            streak = int(old_neg.get(key, 0))                 # 样本不足时不推进连续计数
        elif mean is None:
            action = "该因子有效样本不足，暂不调权"
        elif streak >= NEG_STREAK_OFF:
            factor, action = 0.0, f"自动下线（连续 {streak} 次 IC 为负，**等待人工确认**）"
        elif streak >= NEG_STREAK_STEP2:
            factor, action = WEIGHT_STEP2, f"连续 {streak} 次 IC 为负 → 权重 ×{WEIGHT_STEP2}"
        elif streak >= 1:
            factor, action = WEIGHT_STEP1, f"近 {IC_WINDOW} 日 IC 均值为负 → 权重 ×{WEIGHT_STEP1}"
        out[key] = {"label": spec["label"], "dim": spec["dim"],
                    "higher_better": spec["higher_better"],
                    "ic_mean": mean, "icir": icr, "ic_days": len(recent),
                    "neg_streak": streak, "factor": factor, "action": action}
    return {"sample_dates": sample_dates, "window": IC_WINDOW, "min_days": MIN_DAYS,
            "ready": ready, "factors": out,
            "note": ("因子权重只在有效样本 ≥ "
                     f"{MIN_DAYS} 个交易日后才会被自动调整；单次最多 ×{WEIGHT_STEP1}，"
                     f"地板是名义权重的 {int(WEIGHT_FLOOR * 100)}%，"
                     "『下线』需要连续多次为负并标注等待人工确认。"
                     "每天的评估结果会跨轮累积（连续为负的计数存在 weights_override.json）。")}


def weights_override(health: dict, *, base_note: str = "") -> dict:
    """
    把因子健康度翻译成**给 scoring 用的权重倍率**。

    注意：这里给的是"维度倍率"（trend/fund/chip/inst/sector/base），
    不是单个因子的权重 —— 因为 v2 的权重就是按维度设的。
    一个维度里只要有一个因子被判"该降权"，就整体降；取该维度内**最低**的那个因子系数。
    """
    dims = ["trend", "fund", "chip", "inst", "sector", "base"]
    factors = (health or {}).get("factors") or {}
    used = {d: 1.0 for d in dims}
    reasons: list[str] = []
    for key, info in factors.items():
        dim = info.get("dim")
        if dim not in used:
            continue                                     # risk 维度的因子没有独立权重
        # ⚠️ 别写成 `info.get("factor") or 1.0`：**0.0 是假值**，会被悄悄换成 1.0，
        #    于是"自动下线"永远不生效（而且看起来一切正常）—— 这个坑是测试抓出来的。
        raw = info.get("factor")
        f = 1.0 if raw is None else float(raw)
        if f < used[dim]:
            used[dim] = f
        if f < 1.0:
            reasons.append(f"{info.get('label') or key}：{info.get('action')}")
    for d in dims:
        used[d] = max(WEIGHT_FLOOR, round(used[d], 3))    # 地板
    return {"dimensions": used, "reasons": reasons,
            "applied": (not (health or {}).get("ready") is False) and bool(reasons),
            "ready": bool((health or {}).get("ready")),
            "sample_dates": (health or {}).get("sample_dates", 0),
            "min_days": MIN_DAYS, "floor": WEIGHT_FLOOR,
            "neg_streak": {k: v.get("neg_streak", 0) for k, v in factors.items()},
            "note": (base_note or
                     "这是**系统自动**给出的维度权重倍率（依据因子 RankIC）。"
                     "样本不足时 applied=false，scoring 会完全按原权重走。")}
