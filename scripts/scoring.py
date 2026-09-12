"""scoring.py — 个股评分（满分 100，权重与依据全部公开）

设计依据（为什么是这些权重）
---------------------------
1. **技术 32 分**：C1–C4 是原本筛选就在用的布尔条件，直接复用，不另造指标。
   其中**周线多头排列给最高分(10)**：周线级别趋势噪音小、更稳定，日线容易假突破。
2. **资金 24 分**：资金流是"因"，涨跌是"果"。用**主力净流入 ÷ 流通市值**做归一化，
   否则大市值股票天然数值大、小盘股永远排不上。
3. **筹码 18 分**：对应"获利盘/套牢盘"口径。
   获利盘过低 → 上方套牢盘重、反弹有压力；过高（>85%）→ 获利了结压力大。
   所以**40%–75% 给满分**，两端递减（这是经验区间，写在代码里可调）。
4. **机构 16 分**：研报有明确方向（买入/增持/中性），给分；**调研没有方向**，
   只按"机构家数"折算成关注度分，不当作看多。
5. **板块/情绪 10 分**：个股所在行业当日主力净流入 + 市场情绪，顺势更容易走。
6. **风险扣分 0–20 分**：换手过热、短期涨幅过大、主力净流出等，扣分不封顶到 0，
   避免系统专挑"已经涨到天上"的票。

重要说明（页面也要写）
    · 评分是**本工具自定义的合成指标**，不是官方评级，不构成投资建议。
    · 获利盘/筹码是**估算值**（官方数据不存在）。
    · 权重可用环境变量覆盖（见 fetch_data.py 的 SCORE_WEIGHTS），便于你自己调。
"""

from __future__ import annotations

WEIGHTS = {
    "tech": 32, "fund": 24, "chip": 18, "inst": 16, "sector": 10,
}
MAX_RISK_DEDUCT = 20


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def _linear(value: float | None, zero_at: float, full_at: float) -> float:
    """线性的 0→1 归一化：value<=zero_at 得 0，>=full_at 得 1。"""
    if value is None:
        return 0.0
    if full_at == zero_at:
        return 0.0
    return _clamp((value - zero_at) / (full_at - zero_at), 0.0, 1.0)


def _tent(value: float | None, lo: float, hi: float, soft: float) -> float:
    """梯形打分：在 [lo,hi] 内得 1，往外 soft 宽度内线性降到 0。"""
    if value is None:
        return 0.0
    if lo <= value <= hi:
        return 1.0
    if value < lo:
        return _clamp((value - (lo - soft)) / soft, 0.0, 1.0)
    return _clamp(((hi + soft) - value) / soft, 0.0, 1.0)


def score_stock(feat: dict, ctx: dict | None = None) -> dict:
    """
    feat 需要的键（拿不到的传 None，会被当作 0 分而不是编造）：
        tech:  c1 / c2 / c3 / c4（布尔）
        fund:  main_net_ratio（主力净流入/流通市值 %）、main_net（元）、
               dragon_net（元，龙虎榜净额）、super_ratio（超大单+大单占比 %）
        chip:  profit_ratio（获利盘估算 %）、hhi（集中度）、
               trapped_peak_above（现价上方是否还有更大的密集峰：布尔）
        inst:  rating_score（0-1，由研报评级折算）、upside_pct（目标价空间 %）、
               survey_orgs（近 30 天调研机构家数）
        sector:industry_net（所属行业主力净流入，元）、market_score（市场情绪 0-100）、
               industry_limitup（同行业涨停家数）
        risk:  turnover（换手 %）、ret_5d（近 5 日涨幅 %）、break_rate（炸板率 0-1）、
               price（股价）
    """
    ctx = ctx or {}
    w = ctx.get("weights") or WEIGHTS
    parts: dict[str, float] = {}
    detail: dict[str, str] = {}

    # ---------------- 技术 32 ----------------
    t = 0.0
    if feat.get("c1"):
        t += 8
    if feat.get("c2"):
        t += 8
    if feat.get("c3"):
        t += 6
    if feat.get("c4"):
        t += 10
    parts["技术"] = round(t, 1)
    detail["技术"] = "C1 MA5向上/站上MA5/收红 8 · C2 MACD金叉 8 · C3 日线多头 6 · C4 周线多头 10"

    # ---------------- 资金 24 ----------------
    f = 0.0
    f += 14 * _linear(feat.get("main_net_ratio"), 0.0, 1.5)      # 主力净流入/流通市值
    f += 6 * _clamp(_linear(feat.get("dragon_net"), 0.0, 5e7), 0, 1)   # 龙虎榜净额（5000万满分）
    f += 4 * _linear(feat.get("super_ratio"), 0.0, 15.0)          # 超大单+大单占比
    parts["资金"] = round(f, 1)
    detail["资金"] = "主力净额/流通市值 14 · 龙虎榜净额 6（5000万满分） · 大单占比 4"

    # ---------------- 筹码 18 ----------------
    c = 0.0
    c += 8 * _tent(feat.get("profit_ratio"), 40, 75, 25)          # 获利盘 40–75% 最健康
    c += 5 * _tent(feat.get("hhi"), 0.01, 0.06, 0.02)             # 集中度适中
    if feat.get("trapped_peak_above") is False:
        c += 5
    parts["筹码"] = round(c, 1)
    detail["筹码"] = "获利盘落在40–75% 8 · 集中度适中 5 · 上方无更大密集峰 5"

    # ---------------- 机构 16 ----------------
    ins = 0.0
    ins += 8 * _clamp(feat.get("rating_score") or 0.0, 0, 1)      # 研报评级折算
    ins += 4 * _linear(feat.get("upside_pct"), 0.0, 20.0)         # 目标价空间 20% 满分
    ins += 4 * _linear(feat.get("survey_orgs"), 0.0, 5.0)         # 调研机构家数 5 家满分
    parts["机构"] = round(ins, 1)
    detail["机构"] = "研报评级 8 · 目标价空间 4（20%满分） · 调研机构家数 4（方向不给分）"

    # ---------------- 板块/情绪 10 ----------------
    s = 0.0
    if (feat.get("industry_net") or 0) > 0:
        s += 4
    ms = feat.get("market_score")
    if ms is not None:
        s += 3 if ms >= 50 else (1 if ms >= 40 else 0)
    if (feat.get("industry_limitup") or 0) >= 2:
        s += 3
    parts["板块情绪"] = round(s, 1)
    detail["板块情绪"] = "行业资金净流入 4 · 市场情绪 3 · 同行业涨停≥2家 3"

    # ---------------- 风险扣分 ----------------
    deduct = 0.0
    risks: list[str] = []
    if (feat.get("turnover") or 0) > 25:
        deduct += 4
        risks.append("换手>25%")
    if (feat.get("ret_5d") or 0) > 25:
        deduct += 6
        risks.append("近5日涨幅>25%")
    if (feat.get("break_rate") or 0) > 0.40:
        deduct += 3
        risks.append("炸板率>40%")
    if (feat.get("main_net") or 0) < 0:
        deduct += 5
        risks.append("主力净流出")
    if (feat.get("price") or 99) < 3:
        deduct += 2
        risks.append("股价<3元")
    deduct = min(deduct, MAX_RISK_DEDUCT)
    parts["风险扣分"] = -round(deduct, 1)

    total = max(0.0, min(100.0, sum(parts.values())))
    return {
        "score": round(total, 1),
        "parts": parts,
        "detail": detail,
        "risks": risks,
        "max": 100,
        "note": ("评分是本工具自定义的合成指标（技术/资金/筹码/机构/板块情绪 − 风险扣分），"
                 "不是官方评级，不构成投资建议；其中获利盘与筹码为估算值。"),
    }


# ----------------------------------------------------------------------
# 全市场快评分（**覆盖每一只 A 股**，只有日线行情的股票也能给分）
#
# 为什么需要它：用户要求"5000 只都要能筛到、能搜到"。但技术面精算必须逐只拉 K 线
# （免费接口限速，一轮跑不了 5000 只）。所以：
#     · 精算分（score_stock）= 技术32+资金24+筹码18+机构16+板块10−风险，只有精算池有
#     · 快评分（score_light）= **基本面45 + 资金35 + 板块情绪20**，全市场都能算
# 两者**量纲相同（0~100）但口径不同**，页面上必须分开显示，绝不能混在一起排序
# 让人以为"全市场都做了技术面精算"。
# ----------------------------------------------------------------------

LIGHT_WEIGHTS = {"fundamental": 45, "money": 35, "sector": 20}


def score_light(fundamentals: dict, *, main_net: float | None, float_cap: float | None,
                industry_net: float | None = None, market_score: float | None = None) -> dict:
    """
    全市场快评分（0~100）。输入全是"快照里就有"的字段，不依赖 K 线。

      · 基本面 45：直接用 fundamental_score（ROE/成长/毛利/估值/负债），按 45/100 折算；
        财报字段缺失的股票这一项自然低分，**不猜**。
      · 资金 35：主力净流入 ÷ 流通市值（归一化，避免大市值天然占优），1.5% 记满。
      · 板块情绪 20：所属行业资金净流入 + 市场情绪。

    正常调用时 fundamentals 传 fundamental_score(r) 的结果。
    """
    fund = fundamentals or {}
    f = LIGHT_WEIGHTS["fundamental"] * (float(fund.get("score") or 0) / 100.0)

    ratio = None
    if main_net is not None and float_cap:
        ratio = (main_net or 0) / max(float_cap, 1) * 100
    m = LIGHT_WEIGHTS["money"] * _linear(ratio, -0.5, 1.5)     # 净流出也给一点区分度

    s = 0.0
    if (industry_net or 0) > 0:
        s += LIGHT_WEIGHTS["sector"] * 0.6
    if market_score is not None:
        s += LIGHT_WEIGHTS["sector"] * 0.4 * _clamp((market_score - 30) / 40.0, 0, 1)

    total = round(f + m + s, 1)
    return {
        "score": max(0.0, min(100.0, total)),
        "parts": {"基本面": round(f, 1), "资金": round(m, 1), "板块情绪": round(s, 1)},
        "note": ("快评分 = 基本面45 + 资金35 + 板块情绪20，覆盖全市场；"
                 "**不含技术面**（K 线/均线/筹码需要逐只精算，只有精算池有）。"
                 "与「精算分」口径不同，不要直接比较。"),
    }


# ----------------------------------------------------------------------
# v2：横截面相对评分（2026-09 升级）
#
# v1 的问题（也是"选股评分逻辑"最该改的地方）：
#   1. **绝对阈值**：`_linear(x, 0, 1.5)` 这类"主力净额/流通市值 1.5% 记满分"是拍出来的。
#      牛市里人人 1.5%，熊市里没人到 1.5% —— 同一套阈值在不同市场环境下不可比。
#   2. **数据缺失 = 扣分**：拿不到某个字段就 0 分，等于系统性惩罚"数据不全"的股票
#      （小盘股、次新股、免费接口覆盖差的票）。
#   3. **重复计分**：c1(MA5)/c2(MACD)/c3(日线多头)/c4(周线多头) 四个条件高度相关，
#      等于把"趋势"这件事记了三到四遍，趋势一个维度就吃掉 32 分里的 32 分。
#   4. **行业只判正负**：`industry_net > 0 → +4`，没有强弱之分，也没做行业中性。
#   5. **风险扣分是阶梯**（4/6/3/5/2），阈值附近一档就差 6 分，噪声大。
#
# v2 的做法（都靠同一套公开数据，不需要联网新源）：
#   · 每个连续因子先做**截面百分位**（0~1），权重再乘上去 → 与市场环境无关，只看相对强弱
#   · 拿不到的维度**从分母里剔除**（重新归一化），而不是记 0 分
#   · 趋势合并成"多周期趋势分"（日/周两个级别，MACD 与均线取其一，避免重复计分）
#   · 行业情绪用**行业相对强弱**（行业内涨幅/资金分位）+ 全市场情绪
#   · 风险改为**连续扣分**（超阈值后线性增长），避免一档差 6 分
# 兼容性：v1 的 score_stock 保留（历史对照与回归用），产物里写 scoring_version 便于溯源。
# ----------------------------------------------------------------------

SCORING_VERSION = "v2-2026.09"

#: v2 权重（合计 100，扣分项另算）
WEIGHTS_V2 = {"trend": 26, "fund": 22, "chip": 16, "inst": 16, "sector": 12, "base": 8}
MAX_RISK_DEDUCT_V2 = 18


def pct_rank(value: float | None, dist: list[float] | None) -> float | None:
    """
    截面百分位（0~1）：value 在 dist 里处于什么位置。dist 为空/只有一个值时返回 None。

    用"排名/总数"而不是 scipy 的秩相关：口径简单、可复核，也不需要第三方库。
    缺失值返回 None，由调用方决定"这项不计入"（而不是当 0）。
    """
    if value is None or not dist:
        return None
    vals = [v for v in dist if v is not None]
    if len(vals) < 5:
        return None
    below = sum(1 for v in vals if v <= value)
    return round(below / len(vals), 4)


def build_distributions(rows: list[dict], key) -> list[float]:
    """为一组股票构建某个因子的截面分布（v2 的输入）。key 可以是函数或字段名。"""
    out: list[float] = []
    for r in rows:
        v = key(r) if callable(key) else r.get(key)
        if v is not None:
            out.append(float(v))
    return out


def score_stock_v2(feat: dict, dist: dict[str, list[float]] | None = None,
                   ctx: dict | None = None) -> dict:
    """
    横截面相对评分（v2）。满分 100，扣分另算。

    feat 需要的键（拿不到的传 None，会被"剔除出分母"而不是记 0）：
        趋势类：daily_bull / weekly_bull / macd_golden / ma5_rising / ret_20d
        资金类：main_net_ratio（主力净额/流通市值 %）、super_ratio、dragon_net
        筹码类：profit_ratio、hhi、trapped_peak_above
        机构类：rating_score、upside_pct、survey_orgs
        板块类：industry_chg_rank（行业内涨幅分位）、market_score
        基础类：fund_score（基本面 0~100，来自 fundamental_score）
        风险类：turnover、ret_5d、break_rate、price、main_net
    dist：**全市场（或当日候选池）的截面分布**，由 build_distributions 生成；
          没有 dist 时自动退回 v1 的绝对阈值（保证单独调用也能用）。
    """
    ctx = ctx or {}
    dist = dist or {}
    weights = ctx.get("weights") or WEIGHTS_V2
    detail: dict[str, str] = {}

    def pct(key: str, value):
        """有截面分布就用百分位；没有就退回"绝对阈值"（并标明）。"""
        d = dist.get(key)
        p = pct_rank(value, d)
        if p is not None:
            return p, "percentile"
        return None, "missing"

    # ---------------- 趋势 26：合并成"多周期趋势"，避免 c1~c4 重复计分 ----------------
    trend_parts: list[float] = []
    if feat.get("daily_bull") is not None:
        trend_parts.append(1.0 if feat.get("daily_bull") else 0.0)
    if feat.get("weekly_bull") is not None:
        # 周线级别更稳，给更高权重（0.4）
        trend_parts.append(0.4 if feat.get("weekly_bull") else 0.0)
    if feat.get("macd_golden") is not None or feat.get("ma5_rising") is not None:
        # MACD 与 MA5 只取其一，避免同一件事记两次
        short = 1.0 if (feat.get("macd_golden") or feat.get("ma5_rising")) else 0.0
        trend_parts.append(0.6 * short)
    r20, how20 = pct("ret_20d", feat.get("ret_20d"))
    if r20 is not None:
        trend_parts.append(r20)                      # 20 日动量用截面百分位
    trend = (sum(trend_parts) / len(trend_parts)) if trend_parts else None
    detail["趋势"] = ("日线/周线趋势 + 短期动量，20日动量用当日截面百分位"
                      if how20 == "percentile" else "日线/周线趋势 + 短期动量（无截面数据）")

    # ---------------- 资金 22：全部走截面百分位 ----------------
    m_ratio, how_m = pct("main_net_ratio", feat.get("main_net_ratio"))
    s_ratio, _ = pct("super_ratio", feat.get("super_ratio"))
    d_net, _ = pct("dragon_net", feat.get("dragon_net"))
    fund_parts = [x for x in (m_ratio, s_ratio, d_net) if x is not None]
    fund = (sum(fund_parts) / len(fund_parts)) if fund_parts else None
    detail["资金"] = ("主力净额/流通市值、大单占比、龙虎榜净额的截面百分位（等权）"
                      if how_m == "percentile" else "资金三项（无截面分布时按绝对阈值折算）")

    # ---------------- 筹码 16：获利盘用"距最优区间的距离"，集中度用百分位 ----------------
    chip_vals: list[float] = []
    pr = feat.get("profit_ratio")
    if pr is not None:
        # 40~75% 最健康；越远越低（连续，不再分档）
        chip_vals.append(_tent(pr, 40, 75, 25))
    hhi_p, _ = pct("hhi", feat.get("hhi"))
    if hhi_p is not None:
        chip_vals.append(hhi_p)
    if feat.get("trapped_peak_above") is not None:
        chip_vals.append(1.0 if feat.get("trapped_peak_above") is False else 0.0)
    chip = (sum(chip_vals) / len(chip_vals)) if chip_vals else None
    detail["筹码"] = "获利盘落在40–75%、集中度截面百分位、上方无更大密集峰"

    # ---------------- 机构 16 ----------------
    inst_vals: list[float] = []
    if feat.get("rating_score") is not None:
        inst_vals.append(_clamp(float(feat["rating_score"]), 0, 1))
    up_p, _ = pct("upside_pct", feat.get("upside_pct"))
    if up_p is not None:
        inst_vals.append(up_p)
    su_p, _ = pct("survey_orgs", feat.get("survey_orgs"))
    if su_p is not None:
        inst_vals.append(su_p)
    inst = (sum(inst_vals) / len(inst_vals)) if inst_vals else None
    detail["机构"] = "研报评级 + 目标价空间/调研家数（后两者用截面百分位；调研无方向）"

    # ---------------- 板块 12：行业相对强弱 + 市场情绪 ----------------
    sec_vals: list[float] = []
    ind_rank = feat.get("industry_chg_rank")     # 行业内涨幅分位（0~1）
    if ind_rank is not None:
        sec_vals.append(_clamp(float(ind_rank), 0, 1))
    ms = feat.get("market_score")
    if ms is not None:
        sec_vals.append(_clamp((float(ms) - 30) / 40.0, 0, 1))
    sector = (sum(sec_vals) / len(sec_vals)) if sec_vals else None
    detail["板块情绪"] = "行业相对强弱（行业内分位）+ 全市场情绪分"

    # ---------------- 基础 8：基本面分（搜索/全市场都有） ----------------
    base = _clamp(float(feat.get("fund_score") or 0) / 100.0, 0, 1) \
        if feat.get("fund_score") is not None else None
    detail["基本面"] = "财报口径（ROE/成长/毛利/估值/负债）折算"

    raw = {"trend": trend, "fund": fund, "chip": chip, "inst": inst, "sector": sector,
           "base": base}
    # **缺失维度从分母剔除**：把有用维度的权重按比例放大到 100
    avail = {k: v for k, v in raw.items() if v is not None}
    if avail:
        wsum = sum(weights[k] for k in avail)
        parts = {k: round(weights[k] * v * 100.0 / wsum, 1) for k, v in avail.items()}
    else:
        parts = {}

    # ---------------- 风险扣分：连续（超阈值后线性增长） ----------------
    risks: list[str] = []
    deduct = 0.0
    for key, thr, span, maxd, label in (
            ("turnover", 25, 40, 5, "换手>25%"),
            ("ret_5d", 25, 45, 7, "近5日涨幅>25%"),
            ("break_rate", 0.40, 0.35, 3, "炸板率>40%")):
        v = feat.get(key)
        if v is not None and v > thr:
            deduct += maxd * _clamp((float(v) - thr) / span, 0, 1)
            risks.append(label)
    if (feat.get("main_net") or 0) < 0:
        deduct += 4
        risks.append("主力净流出")
    if (feat.get("price") or 99) < 3:
        deduct += 2
        risks.append("股价<3元")
    deduct = min(deduct, MAX_RISK_DEDUCT_V2)

    total = max(0.0, min(100.0, sum(parts.values()) - deduct))
    pct_detail = {}
    for k, v in raw.items():
        if v is not None:
            pct_detail[k] = round(v * 100, 1)        # 各维度 0~100（相对强弱）
    return {
        "score": round(total, 1),
        "parts": parts,
        "deduct": round(deduct, 1),
        "dimension_pct": pct_detail,                 # 每个维度的相对强弱（可解释性）
        "detail": detail,
        "risks": risks,
        "max": 100,
        "version": SCORING_VERSION,
        "note": ("v2 横截面相对评分：每个因子先取「当日全市场百分位」再加权，"
                 "拿不到的维度从分母剔除（不当作 0 分），风险改为连续扣分。"
                 "权重：趋势26 资金22 筹码16 机构16 板块12 基本面8。"
                 "评分是本工具自定义的合成指标，不是官方评级，不构成投资建议。"),
    }


def rating_to_score(buy: int, add: int, neutral: int, reduce: int, sell: int) -> float:
    """
    券商评级 → 0~1 分。

    口径：看多 = 买入 + 增持，看空 = 减持 + 卖出，中性单列。
    以"加权平均评级"映射：买入=1.0、增持=0.75、中性=0.45、减持=0.15、卖出=0.0，
    再按机构家数加权；没有评级数据返回 0（不猜）。
    """
    total = buy + add + neutral + reduce + sell
    if total <= 0:
        return 0.0
    weighted = (buy * 1.0 + add * 0.75 + neutral * 0.45 + reduce * 0.15 + sell * 0.0)
    return round(weighted / total, 4)


# ----------------------------------------------------------------------
# 基本面评分（搜索任意股票时用；日筛选的主评分不掺杂它，保持权重口径不变）
# ----------------------------------------------------------------------

def fundamental_score(f: dict) -> dict:
    """
    基本面 0~100 分。输入字段（拿不到的按"数据缺失"处理，不当作 0 分）：
        pe 市盈率(动) / pb 市净率 / roe 净资产收益率% / rev_yoy 营收同比%
        np_yoy 净利润同比% / gross 毛利率% / debt 资产负债率%

    打分依据（每条都写清为什么）：
      · ROE 25 分：盈利能力最直接的口径，长期 15%+ 属优秀；
      · 净利同比 20 分：成长性；**负增长要扣分**，不是"越低越中性"；
      · 营收同比 15 分、毛利率 15 分：收入扩张与定价权（行业差异大，故不给高分值）；
      · 市盈率 15 分：5~40 倍视为合理，亏损（PE≤0）直接 0 分；
      · 市净率 5 分、资产负债率 5 分：估值与杠杆的辅助校验。
    """
    parts: dict[str, float] = {}
    reasons: list[str] = []

    roe = f.get("roe")
    if roe is None:
        parts["ROE"] = 0.0
    else:
        parts["ROE"] = round(25 * _linear(roe, 0.0, 15.0), 1)
        if roe >= 15:
            reasons.append(f"ROE {roe:.1f}%（优秀）")
        elif roe < 5:
            reasons.append(f"ROE 仅 {roe:.1f}%（偏弱）")

    np_yoy = f.get("np_yoy")
    if np_yoy is None:
        parts["净利同比"] = 0.0
    else:
        parts["净利同比"] = round(20 * _tent(np_yoy, 0.0, 100.0, 60.0), 1)
        if np_yoy >= 50:
            reasons.append(f"净利润同比 +{np_yoy:.0f}%（高增长）")
        elif np_yoy < 0:
            reasons.append(f"净利润同比 {np_yoy:.0f}%（负增长）")

    rev_yoy = f.get("rev_yoy")
    if rev_yoy is None:
        parts["营收同比"] = 0.0
    else:
        parts["营收同比"] = round(15 * _tent(rev_yoy, 0.0, 60.0, 40.0), 1)

    gross = f.get("gross")
    if gross is None:
        parts["毛利率"] = 0.0
    else:
        parts["毛利率"] = round(15 * _linear(gross, 10.0, 45.0), 1)

    pe = f.get("pe")
    if pe is None:
        parts["市盈率"] = 0.0
    elif pe <= 0:
        parts["市盈率"] = 0.0
        reasons.append("市盈率为负（亏损）")
    else:
        parts["市盈率"] = round(15 * _tent(pe, 5.0, 40.0, 40.0), 1)
        if pe > 100:
            reasons.append(f"市盈率 {pe:.0f} 倍（估值偏高）")

    pb = f.get("pb")
    if pb is None or pb <= 0:
        parts["市净率"] = 0.0
    else:
        parts["市净率"] = round(5 * _tent(pb, 0.5, 5.0, 5.0), 1)

    debt = f.get("debt")
    if debt is None:
        parts["资产负债率"] = 0.0
    else:
        parts["资产负债率"] = round(5 * _tent(debt, 10.0, 60.0, 20.0), 1)

    total = round(sum(parts.values()), 1)
    return {"score": max(0.0, min(100.0, total)), "parts": parts, "reasons": reasons[:4],
            "note": "基本面分只反映财报口径（盈利/成长/估值/负债），"
                    "不含股价位置与资金流向，也不能替代同行业横向比较。"}


# ----------------------------------------------------------------------
# 看多 / 看跌建议
# ----------------------------------------------------------------------

ADVICE_LEVELS = (
    (78, "看多", "up"),
    (62, "偏多", "up"),
    (45, "中性", "flat"),
    (30, "偏空", "down"),
    (0, "看跌", "down"),
)


def advise(total_score: float, *, fund_score: float | None = None,
           features: dict | None = None, fundamentals: dict | None = None) -> dict:
    """
    看多 / 看跌建议（**明确说明这是本工具的量化倾向，不是投资建议**）。

    规则（透明可复核）：
      · 以技术+资金+筹码+机构+板块的合成分为主（0~100）；
      · 基本面分（0~100）按 25% 权重并入，得到"综合分"；
      · 综合分 ≥78 看多 / 62~78 偏多 / 45~62 中性 / 30~45 偏空 / <30 看跌；
      · 同时列出主要利多、利空因子（来自各维度明细，避免"只有结论没有依据"）。
    """
    features = features or {}
    combined = total_score if fund_score is None else round(total_score * 0.75 + fund_score * 0.25, 1)
    label, tone = "看跌", "down"
    for threshold, name, t in ADVICE_LEVELS:
        if combined >= threshold:
            label, tone = name, t
            break

    pros: list[str] = []
    cons: list[str] = []
    if features.get("c4"):
        pros.append("周线多头排列")
    if features.get("c3"):
        pros.append("日线多头排列")
    if features.get("c2"):
        pros.append("MACD 金叉/多头")
    if (features.get("main_net") or 0) > 0:
        pros.append("主力资金净流入")
    if 40 <= (features.get("profit_ratio") or 0) <= 85:
        pros.append(f"获利盘 {features.get('profit_ratio'):.0f}%（筹码结构尚可）")
    if (features.get("upside_pct") or 0) >= 15:
        pros.append(f"券商目标价空间 {features.get('upside_pct'):.0f}%")
    if (features.get("industry_net") or 0) > 0:
        pros.append("所属行业资金净流入")
    if (features.get("turnover") or 0) > 25:
        cons.append(f"换手 {features.get('turnover'):.0f}%（过热）")
    if (features.get("ret_5d") or 0) > 25:
        cons.append(f"5 日涨幅 {features.get('ret_5d'):.0f}%（短线过热）")
    if (features.get("main_net") or 0) < 0:
        cons.append("主力资金净流出")
    if (features.get("profit_ratio") or 0) > 85:
        cons.append("获利盘 >85%（兑现压力大）")
    if (features.get("profit_ratio") or 100) < 25:
        cons.append(f"获利盘仅 {features.get('profit_ratio'):.0f}%（上方套牢盘重）")
    for r in (fundamentals or {}).get("reasons", []):
        if any(k in r for k in ("偏弱", "负增长", "亏损", "偏高")):
            cons.append(r)
        else:
            pros.append(r)

    return {
        "label": label, "tone": tone, "combined": combined,
        "tech_score": round(total_score, 1),
        "fund_score": None if fund_score is None else round(fund_score, 1),
        "pros": pros[:5], "cons": cons[:5],
        "note": ("这是本工具按公开数据做出的**量化倾向**（技术 32 + 资金 24 + 筹码 18 + 机构 16 + "
                 "板块 10 − 风险扣分，再并入 25% 基本面分），**不是投资建议**，不构成买卖依据。"),
    }
