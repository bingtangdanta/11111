"""commentary.py — **规则化**点评（不使用任何大模型，零 Token 成本）

用户要求（原话要点）：
    · 每天收盘只对**评分最高的前 10 只**生成点评
    · 每只 100~200 字，三段式：过去的发展趋势 → 现在的状态 → 未来可能的发展趋势
    · 结合技术面 / 资金面 / 基本面 / 机构面 / 舆情
    · 客观中立，禁用"必涨""稳赚"这类词，末尾固定加免责声明

为什么是规则而不是大模型：
    ① 零成本、零 Token：一天只在后台跑 3 次（16/18/20 点），算的是字符串拼接；
    ② **可复现**：同样的数据一定得到同样的文字，能回看、能追责；
    ③ 每个数字都能指回产物里的字段，不是"模型觉得"。

三条写作纪律：
    · **只用已抓到的数字**，拿不到的维度明写"该维度数据缺失"，不绕过去也不编；
    · 语言克制：不说"必涨/稳赚/马上"，只说"偏强/偏弱/需要观察"；
    · 每段都要带**具体数字**（否则就是废话）。
"""

from __future__ import annotations

import logging
import os

log = logging.getLogger("ashare.commentary")

#: 每天给多少只写点评（用户要求前 10 只）
TOP_N = int(os.environ.get("ASHARE_COMMENTARY_N", "10"))
MIN_CHARS, MAX_CHARS = 100, 200
DISCLAIMER = "以上为AI分析，仅供参考，不构成投资建议。"

#: 禁用的绝对化措辞（生成后会做一次自检，命中就替换掉）
BANNED = ("必涨", "稳赚", "包涨", "一定会涨", "翻倍", "无风险", "保证收益", "马上买")


def _n(v, digits: int = 2, unit: str = "") -> str:
    if v is None:
        return "数据缺失"
    try:
        return f"{float(v):.{digits}f}{unit}"
    except (TypeError, ValueError):
        return "数据缺失"


def _pct(v, digits: int = 1) -> str:
    if v is None:
        return "数据缺失"
    try:
        return f"{float(v):+.{digits}f}%"
    except (TypeError, ValueError):
        return "数据缺失"


def _past(s: dict, fin: list[dict]) -> str:
    """过去：中期趋势 + 最近两个报告期的盈利变化。返回一串短句（按重要性排序）。"""
    tr = s.get("trend") or {}
    bits = []
    r20 = tr.get("ret_20d_pct")
    if r20 is not None:
        bits.append(f"近 20 个交易日{'上涨' if r20 > 0 else '下跌'} {_pct(r20)}")
    if tr.get("weekly_bull") is True:
        bits.append("周线处于多头排列")
    elif tr.get("weekly_bull") is False:
        bits.append("周线尚未走多头")
    if fin:
        latest = fin[0]
        bits.append(f"最新报告期（{latest.get('date')}）营收同比 {_pct(latest.get('rev_yoy'))}、"
                    f"净利同比 {_pct(latest.get('np_yoy'))}")
        if len(fin) >= 2 and fin[1].get("np_yoy") is not None and latest.get("np_yoy") is not None:
            trend_up = latest["np_yoy"] > fin[1]["np_yoy"]
            bits.append(f"环比上一报告期，净利增速{'在改善' if trend_up else '在放缓'}")
    else:
        bits.append("近几年财务数据本轮未取到")
    return bits


def _now(s: dict, row: dict, chip: dict) -> str:
    """现在：价格位置 + 筹码 + 资金 + 量能。返回一串短句（按重要性排序）。"""
    bits = []
    tr = s.get("trend") or {}
    dev = tr.get("dev_ma20_pct")
    if dev is not None:
        bits.append(f"现价位于 MA20 {'上方' if dev > 0 else '下方'} {_pct(abs(dev))}")
    pr = chip.get("profit_ratio_pct")
    if pr is not None:
        bits.append(f"获利盘约 {_n(pr, 1, '%')}（{'抛压相对轻' if pr < 60 else '兑现压力偏大'}）")
    net = s.get("main_net")
    cap = row.get("float_cap")
    if net is not None and cap:
        ratio = net / cap * 100
        bits.append(f"当日主力净{'流入' if net > 0 else '流出'} {_n(abs(ratio), 2, '%')} 流通市值")
    elif net is not None:
        bits.append("当日主力资金为净" + ("流入" if net > 0 else "流出"))
    vr = row.get("volume_ratio")
    if vr is not None:
        bits.append(f"量比 {_n(vr, 2)}（{'成交较前期活跃' if vr > 1.2 else '成交偏清淡'}）")
    tone = (s.get("advice") or {}).get("label")
    if tone:
        bits.append(f"本工具当前量化倾向为「{tone}」")
    return bits


def _future(s: dict, inst: dict, row: dict, regime: dict | None) -> str:
    """未来：机构态度 + 行业相对强弱 + 环境与风险。返回一串短句（按重要性排序）。"""
    bits = []
    rating = (inst or {}).get("rating") or {}
    orgs = rating.get("org_num")
    if orgs:
        upside = (inst or {}).get("upside_pct")
        bits.append(f"{orgs} 家机构给出评级（{rating.get('stance') or '未评级'}）"
                    + (f"，目标价空间 {_pct(upside)}" if upside is not None else "，暂无目标价空间数据"))
    else:
        bits.append("近期没有机构评级数据")
    survey = (inst or {}).get("survey_orgs") or 0
    bits.append(f"最近有 {survey} 家机构调研" if survey else "近期无调研记录")
    rank = (s.get("features") or {}).get("industry_chg_rank")
    if rank is not None:
        # ⚠️ industry_chg_rank 是行业内涨幅分位（1.0=行业最强，0.0=最弱）。
        #    早期写成"排前 (100-rank*100)%"，当 rank=0 时就变成"排前 100%"——
        #    读起来像很强，其实是最弱，方向正好反了。改成直接报分位。
        bits.append(f"在所属行业内涨幅分位 {round(rank * 100)}%（100=行业最强）")
    if regime and regime.get("regime"):
        bits.append(f"当前市场环境为「{regime['regime']}」"
                    + ("，不宜按评分建仓" if regime.get("empty_warning") else "，仍需注意仓位"))
    risks = s.get("risks") or []
    if risks:
        bits.append("需要留意的风险：" + "、".join(str(x) for x in risks[:3]))
    return bits


def build_one(s: dict, *, row: dict | None = None, inst: dict | None = None,
              fin: list[dict] | None = None, regime: dict | None = None) -> dict:
    """
    给一只股票生成三段式点评。

    返回 {"code","name","text","parts","chars","sources_note","disclaimer","banned_hits"}。
    `parts` 里保留三段原文，页面上可以分开显示，也方便日后核对。
    """
    row = row or {}
    inst = inst or {}
    fin = fin or []
    chip = s.get("chip") or {}
    heads = {"past": "过去看，", "now": "现在看，", "future": "往后看，"}
    clauses = {"past": _past(s, fin), "now": _now(s, row, chip),
               "future": _future(s, inst, row, regime)}
    # ⚠️ 拼装规则：**三段轮流各取一句**（过去→现在→往后→再回来取第二句…），
    #    预算是 200 字减去免责声明。这样绝不会像硬截断那样把整段"往后看"切没。
    budget = MAX_CHARS - len(DISCLAIMER)
    picked = {"past": [], "now": [], "future": []}
    for i in range(max(len(v) for v in clauses.values())):
        for key in ("past", "now", "future"):
            if i < len(clauses[key]):
                picked[key].append(clauses[key][i])
                trial = "".join(heads[k] + "；".join(picked[k]) + "。" for k in picked if picked[k])
                if len(trial) > budget:
                    picked[key].pop()          # 加不进去就退回，继续试后面的短句
    parts = {k: (heads[k] + "；".join(picked[k]) + "。") if picked[k] else ""
             for k in ("past", "now", "future")}
    text = "".join(parts.values())
    hits = [w for w in BANNED if w in text]
    for w in hits:                       # 自检兜底：万一规则里混进绝对化措辞，替换掉
        text = text.replace(w, "值得关注")
    text = text + DISCLAIMER
    return {"code": str(s.get("code") or ""), "name": s.get("name") or "",
            "text": text, "parts": parts, "chars": len(text),
            "banned_hits": hits,
            "sources_note": ("三段分别取自：过去=中期动量与近几期财报；现在=均线位置/获利盘/主力资金/量比；"
                             "未来=机构评级与调研/行业内相对强弱/市场环境与风险标记。"
                             "全部为已抓到的字段，无大模型参与，同一份数据必然得到同一段文字。"),
            "disclaimer": DISCLAIMER}


def build_all(scored: list[dict], *, rows: dict[str, dict] | None = None,
              insts: dict[str, dict] | None = None, fins: dict[str, list[dict]] | None = None,
              regime: dict | None = None, limit: int = TOP_N) -> dict:
    """给评分最高的前 N 只生成点评，返回可直接写盘的 payload。"""
    rows = rows or {}
    insts = insts or {}
    fins = fins or {}
    items = []
    for s in scored[:max(0, limit)]:
        code = str(s.get("code") or "")
        items.append(build_one(s, row=rows.get(code), inst=insts.get(code),
                               fin=fins.get(code), regime=regime))
    short = [x for x in items if x["chars"] < MIN_CHARS]
    return {
        "count": len(items),
        "top_n": limit,
        "disclaimer": DISCLAIMER,
        "engine": "rule-based-v1（规则化，无大模型、零 Token）",
        "items": items,
        "by_code": {x["code"]: x for x in items},
        "note": ("每天收盘后由 GitHub Actions 生成一次（16:00/18:00/20:00），"
                 "前端只读取文字、不做任何计算与调用。"
                 f"本轮 {len(items)} 只，其中 {len(short)} 只字数不足 {MIN_CHARS}（数据缺失较多时会偏短）。"),
    }
