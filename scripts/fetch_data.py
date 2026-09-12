"""fetch_data.py — 主流程：抓数据 → 算指标/筹码 → 打分 → 写 JSON

在 GitHub Actions 里跑（也可以本机手动跑一次验证）：

    python scripts/fetch_data.py                    # 完整一轮（收盘后 16:00/18:00/20:00）
    python scripts/fetch_data.py --research-only     # 只刷新机构调研/研报（每 1–2 小时）
    python scripts/fetch_data.py --out docs/data --top 12

产出（默认写到 docs/data/，GitHub Pages 直接读）：
    version.json       数据版本：交易日、档位、生成时间、覆盖数量、数据来源清单
    dashboard.json     市场情绪、涨跌家数、涨跌停/炸板、资金流榜
    limitup.json       涨停池（含连板数/封板时间/炸板次数/首板统计）
    screen.json        评分排序的全部候选 + 每日 Top N（就在同一个界面里排序）
    sectors.json       行业/概念/ETF 资金流排行
    dragon.json        龙虎榜个股明细 + 每只买卖席位 Top5
    research.json      机构调研 + 券商研报 + 评级汇总 + 看多/看空标记
    index_kline.json   主要指数 K 线（上证/深证/创业板/沪深300）
    stock/<code>.json  个股详情（K 线 + 筹码 + 资金 + 行业 + 机构多空）

设计要点
--------
1. **零依赖**（只用标准库），CI 里不需要 pip install。
2. **每一步都容错**：某个数据源挂了就写"数据缺失"，其它部分照常产出，
   绝不会因为一个接口失败导致整轮没有任何数据。
3. **限量抓取**：全市场 5500+ 只不可能每只都拉 K 线（要被封也不礼貌），
   先用快照做粗筛（代码段/非ST/价格/流动性），再按资金与换手排序取前 N 只精算。
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import sys
import time
from datetime import date, datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import chips                      # noqa: E402
import commentary                 # noqa: E402  （规则化点评：无大模型、零 Token）
import factor_ic                  # noqa: E402  （因子快照 / RankIC / 自动降权）
import heal                       # noqa: E402  （抓取自愈：步骤隔离 / 失败账本 / 补抓）
import indicators as ind          # noqa: E402
import scoring                    # noqa: E402
import selfcheck                  # noqa: E402  （决策验证：回评 / 超额 / 策略评级 / 横幅）
import sources as src             # noqa: E402
from common import now_cn, write_json   # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("fetch")

# ---------------- 可调参数（环境变量覆盖，CI 里不用改代码） ----------------
MAX_CANDIDATES = int(os.environ.get("ASHARE_MAX_CANDIDATES", "260"))   # 精算（拉 K 线）只数
TOP_N = int(os.environ.get("ASHARE_TOP_N", "12"))                      # 每日高评分只数（10~15）
MAX_STOCK_FILES = int(os.environ.get("ASHARE_MAX_STOCK_FILES", "300"))  # 个股详情文件上限
#: 为什么从 80 提到 300：用户在搜索框里搜到一只**没有详情文件**的股票时，
#: 页面上就只有基本面、没有 K 线与指标（用户反馈过）。现在前端在缺存档时会自己
#: 实时抓腾讯日线兜底，但存档仍是"主路径"，覆盖面越大越好；300 只的 JSON 约 6~8MB，
#: Pages（1GB 软上限）与 Actions 提交都毫无压力。
KLINE_BARS = int(os.environ.get("ASHARE_KLINE_BARS", "120"))
#: 给多少个板块生成 K 线/指标/筹码峰（用户要求"各板块也能看 K 线和筹码峰"）。
#: 每个板块 1 次 K 线请求，16 个板块约 20~30 秒；其余板块页面写明"本轮未生成 K 线"。
BOARD_DETAIL_N = int(os.environ.get("ASHARE_BOARD_DETAIL_N", "8"))
#: 精算成功的**最少只数**：低于它说明数据源大面积失败，
#: 宁可整轮退出码非 0（Actions 变红）也不要发布一份残缺数据。
MIN_SCORED = int(os.environ.get("ASHARE_MIN_SCORED", "10"))
#: 精算成功率下限（前若干只样本内）：用来尽早发现"源被限流"而不是白跑几百次
MIN_SUCCESS_RATE = float(os.environ.get("ASHARE_MIN_SUCCESS_RATE", "0.4"))
#: 连续多少只拿不到 K 线就"整段收工"（剩下的直接标 K 线缺失，本轮照常出数据）。
#: 取值理由：连续 30 只都失败，基本不可能是零星抖动；继续硬试只会把 CI 拖到超时。
KLINE_GIVE_UP_STREAK = int(os.environ.get("ASHARE_KLINE_GIVE_UP_STREAK", "30"))
#: factor_ic.json / selfcheck.json 里每个因子保留多少天的 IC 序列（够页面画图，又不至于臃肿）
IC_SERIES_KEEP = int(os.environ.get("ASHARE_IC_SERIES_KEEP", "60"))
#: 给多少只个股抓"近几年财务"（每只 1 次请求；只给评分最高的这批）
FIN_HISTORY_N = int(os.environ.get("ASHARE_FIN_HISTORY_N", "120"))
#: 每天给评分最高的多少只写"规则化点评"（用户要求前 10 只）
COMMENTARY_N = int(os.environ.get("ASHARE_COMMENTARY_N", "10"))
WATCH_PREFIX = ("0", "60")            # 需求：代码以 0 或 60 开头
PRICE_MAX = 100.0                     # 需求：股价 < 100 元
INDEXES = [("1.000001", "上证指数"), ("0.399001", "深证成指"),
           ("0.399006", "创业板指"), ("1.000300", "沪深300")]

MISSING = {
    "获利盘比例/筹码分布": "官方与免费渠道都没有真实筹码分布数据；本工具按成交量-价格分布模型估算，"
                          "现价以下=获利盘、以上=套牢盘。",
    "公募基金申赎": "无免费来源，只能用场内 ETF 资金流代理。",
    "北向资金": "交易所已停止实时披露，公开渠道无法获取。",
    "龙虎榜席位（同花顺）": "同花顺官方 API 不提供席位明细，改用东方财富公开报表。",
    "机构调研/研报（同花顺）": "同花顺官方 API 无此两类数据，改用东方财富公开接口。",
}


def log_ok(label: str, n: int | str) -> None:
    log.info("  ✓ %-18s %s", label, n)


def log_skip(label: str, why: str) -> None:
    log.warning("  ✗ %-18s %s", label, why)


def _save_quote_snapshot(out_dir: str, day: date, snapshot: list[dict]) -> int:
    """
    存当日的全市场报价（只要回评需要的四个价格字段）。

    为什么单独存：回评要的是"那一天的开盘价"，而 `universe.json` 等产物都不含开盘价；
    而事后去补 K 线会在"中间几天没跑抓取"时错位。每天存一份小的（约 300KB），
    是**最不容易出错**的做法。保留最近 15 个交易日，自动清理更早的。
    """
    rows = [{"code": r.get("code"), "open": r.get("open"), "high": r.get("high"),
             "low": r.get("low"), "prev_close": r.get("prev_close"),
             "close": r.get("price")} for r in (snapshot or [])]
    d = os.path.join(out_dir, "snapshots")
    os.makedirs(d, exist_ok=True)
    write_json(os.path.join(d, f"{day.isoformat()}.json"),
               {"date": day.isoformat(), "count": len(rows), "rows": rows})
    keep = sorted(fn for fn in os.listdir(d) if fn.endswith(".json"))[-15:]
    for fn in os.listdir(d):
        if fn.endswith(".json") and fn not in keep:
            try:
                os.remove(os.path.join(d, fn))
            except OSError:
                pass
    return len(rows)


def _selfcheck_payload(out_dir: str, day: date, scored: list[dict], review: dict,
                       index_kline: dict, dashboard: dict, *, health: dict) -> tuple[dict, dict]:
    """
    决策验证总装（用户要求的核心新增）。返回 (selfcheck.json 内容, weights_override.json 内容)。

    四件事按顺序做：
      ① **因子快照**存档（原始因子值 + 当日收盘价），供以后算 RankIC；
      ② 用**相邻快照**回填未来收益 → RankIC / 因子健康 → 维度权重倍率（给 scoring 用）；
      ③ 推荐组合的**可执行口径**回评：T+1 开盘买入 → T+2 开盘卖出，扣成本、剔一字板；
      ④ 市场环境 + 策略评级 + 顶部横幅。

    ⚠️ 跨轮记忆：连续为负的计数（因子）与连续衰减的计数（策略）都存在 JSON 里带回来，
       否则每天都是"第一次"，连续判定永远触发不了。
    """
    day_s = day.isoformat()
    # ① 因子快照
    factor_ic.save_snapshot(out_dir, day_s, scored, extra={"trade_date": day_s})

    # ② RankIC → 因子健康 → 权重倍率
    prev_ic = _load_json(os.path.join(out_dir, "factor_ic.json")) or {}
    prev_override = _load_json(os.path.join(out_dir, "weights_override.json")) or {}
    ic = factor_ic.forward_returns(out_dir, today=day_s)
    h = factor_ic.factor_health(ic, extra_series={"neg_streak": prev_override.get("neg_streak") or {}})
    w_override = factor_ic.weights_override(
        h, base_note="这是**系统自动**给出的维度权重倍率（依据因子 RankIC 连续为负的次数）。"
                     "样本不足时 applied=false，scoring 完全按原权重走。")

    # ③ 推荐组合回评（可执行口径）
    prev_sc = _load_json(os.path.join(out_dir, "selfcheck.json")) or {}
    hist = _load_json(os.path.join(out_dir, "history.json")) or {}
    days = [str(x.get("date")) for x in (hist.get("days") or []) if x.get("date")]
    if day_s not in days:
        days.append(day_s)
    snap_open = {str(r.get("code")): {"open": r.get("open"), "high": r.get("high"),
                                      "low": r.get("low"), "prev_close": r.get("prev_close")}
                 for r in scored}
    # ⚠️ 快照要覆盖**全市场**，不能只用精算池：推荐票有可能这一天没进精算池
    snap_open.update(_snapshot_open_all(out_dir, day_s))
    periods = selfcheck.track_picks(review.get("periods") or [], snap_open,
                                    days=days, today=day_s,
                                    bench=selfcheck.bench_series(index_kline),
                                    prev_periods=prev_sc.get("periods"))

    # ④ 合成
    payload = selfcheck.build(day=day_s, periods=periods, index_kline=index_kline,
                              dashboard=dashboard, history_days=hist.get("days") or [],
                              factor_ic={"sample_dates": ic.get("sample_dates"),
                                         "samples": ic.get("samples"),
                                         "groups": ic.get("groups"),
                                         "series": {k: v[-IC_SERIES_KEEP:] for k, v in
                                                    (ic.get("series") or {}).items()}},
                              factor_health=h, weights_override=w_override, health=health,
                              prev_decay_streak=int((prev_sc.get("rating") or {})
                                                    .get("decay_streak") or 0))
    payload["prev_ic_days"] = len(prev_ic.get("days") or [])
    # 把自愈账本的**每一步**也带上：页面「系统自检」里要逐条显示
    # （只给一个汇总数字的话，"到底哪一步没拿到"还是看不见）
    payload["collect_steps"] = (health or {}).get("steps") or []
    payload["collect_missing"] = (health or {}).get("missing") or []
    return payload, w_override


def _snapshot_open_all(out_dir: str, day_s: str) -> dict:
    """
    从当天的**全市场快照**里取开高低（给回评用）。

    为什么要存全市场而不是只用精算池：推荐票在 T+1/T+2 那天可能**没进精算池**
    （精算是按当日成交额等条件挑的），只存精算池会算不出收益，而"算不出"很容易
    被顺手写成 0 —— 那正好是最不该发生的事。
    """
    path = os.path.join(out_dir, "snapshots", f"{day_s}.json")
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return {str(r.get("code")): {"open": r.get("open"), "high": r.get("high"),
                                 "low": r.get("low"), "prev_close": r.get("prev_close")}
            for r in (data.get("rows") or [])}


def _load_json(path: str) -> dict | None:
    try:
        with open(path, encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return None


def _has_missing(out_dir: str) -> bool:
    """
    上一轮账本里是否还有没补上的项（`--repair` 用它决定要不要跑）。

    CI 里可以先跑一次完整抓取，再看这个：没有缺口就**直接跳过**，
    免得每轮都白跑几分钟的补抓流程。
    """
    try:
        with open(os.path.join(out_dir, "health.json"), encoding="utf-8") as fh:
            h = json.load(fh)
    except (OSError, ValueError):
        return False
    return bool((h or {}).get("missing"))


def write_health(out_dir: str, led: "heal.Ledger", day: date) -> int:
    """
    写自愈账本 `health.json`（页面「系统自检」读它）。

    为什么每轮都必须写：自愈最怕的是"悄悄吞掉错误"。有了这份账本，
    页面上就能直接看到"这轮重试了几次、换了哪个源、补回了多少、还缺什么"，
    而不是只有翻 CI 日志才知道 —— 后者等于没有。
    """
    payload = led.payload(day=day.isoformat(), trade_date=day.isoformat())
    return write_json(os.path.join(out_dir, "health.json"), payload)


def repair_pass(led: "heal.Ledger", boards: dict, funds: dict, dragon_seats: dict,
                day: date) -> None:
    """
    **二次补抓**：主流程跑完后，对账本里失败的项做一轮定向重试。

    为什么要有这一步：一轮抓取里最常见的失败是"某个源临时限流"，
    而限流通常是短时的（几十秒）。主流程走到后面时，前面失败的那一项往往已经能用了 ——
    直接放弃等于白丢一块数据。这里只针对**具体缺失项**重试，不重跑全市场（那要几分钟）。

    哪些项值得补：板块 K 线（页面上是"板块分析页"的核心）、场外基金、龙虎榜席位。
    补不上的照旧标"数据缺失"，不留假数据。这里也受 REPAIR_BUDGET_S 总预算约束。
    """
    if not led.missing:
        return
    items = {m["item"] for m in led.missing}
    t0 = time.time()
    log.info("⟳ 二次补抓：对 %d 项缺失做定向重试（预算 %.0fs）", len(items), led.repair_budget_left())

    # ① 板块 K 线
    if any("K线" in i or "板块" in i for i in items) and led.repair_budget_left() > 10:
        fixed = 0
        for group in ("industry", "concept"):
            for b in boards.get(group) or []:
                if b.get("kline") or not b.get("code") or led.repair_budget_left() <= 5:
                    continue
                bars = src.board_kline(b["code"], bars=KLINE_BARS)
                if bars:
                    b["kline"] = _kline_payload(bars)
                    b["chip"] = chips.summarize(bars, bars[-1].get("close"))
                    b["indicators"] = ind.trend_flags(bars)
                    b.pop("kline_missing", None)
                    fixed += 1
        if fixed:
            led.note_repaired("板块K线", "主流程后换主机重试成功", fixed)
        led.spend_repair(time.time() - t0)
        t0 = time.time()

    # ② 场外基金（排行接口偶发"200 但无权限/空"）
    if any("基金" in i for i in items) and led.repair_budget_left() > 5:
        if not funds.get("funds"):
            retry = _funds_payload(day)
            if retry.get("funds"):
                funds.update(retry)
                led.note_repaired("场外基金", "重试后拿到排行数据", len(retry["funds"]))
        led.spend_repair(time.time() - t0)
        t0 = time.time()

    # ③ 龙虎榜席位
    if any("席位" in i for i in items) and led.repair_budget_left() > 5:
        day_d = _last_trade_day(day)
        got = 0
        for code in [c for c, v in dragon_seats.items() if not v][:20]:
            r = src.dragon_seats(day_d, code, top=5)
            if r:
                dragon_seats[code] = r
                got += 1
            if led.repair_budget_left() <= 3:
                break
        if got:
            led.note_repaired("龙虎榜席位明细", "重试后补齐", got)
        led.spend_repair(time.time() - t0)


# ----------------------------------------------------------------------
# 过滤与预筛
# ----------------------------------------------------------------------

def prefilter(snapshot: list[dict], max_candidates: int = MAX_CANDIDATES) -> tuple[list[dict], dict]:
    """
    挑出"值得花 K 线额度去精算"的候选（**只是挑精算池，不是全市场过滤**）。

    用户明确要求：**5000 只都要能筛到、能搜到**。所以这个函数的结果只决定
    "谁去做技术面精算 / 谁生成个股详情文件"，而**不再**决定搜索与筛选的范围 ——
    搜索库(:func:`_universe_payload`)与筛选表(:func:`_screen_payload`)现在都覆盖全市场。

    ⚠️ max_candidates 必须**作为参数传进来**：早期版本这里写死用了模块常量，
       结果 `--max-candidates 40` 传了也不生效，实际还是按 260 只跑。
    """
    funnel = {"全部A股": len(snapshot)}
    step1 = [r for r in snapshot if str(r["code"]).startswith(WATCH_PREFIX)]
    funnel["代码前缀(0/60)"] = len(step1)
    step2 = [r for r in step1 if "ST" not in (r["name"] or "").upper()
             and "退" not in (r["name"] or "")]
    funnel["非ST/非退市"] = len(step2)
    step3 = [r for r in step2 if (r.get("price") or 999) < PRICE_MAX]
    funnel["股价<100元"] = len(step3)
    step4 = [r for r in step3
             if (r.get("amount") or 0) > 3e7 and (r.get("turnover") or 0) > 0.8]
    funnel["成交额>3000万且换手>0.8%"] = len(step4)
    # 精算候选：优先主力净流入为正、资金占比高、换手活跃
    def rank_key(r: dict) -> float:
        ratio = (r.get("main_net") or 0) / max(r.get("float_cap") or 1, 1)
        return ratio * 1000 + math.log10(max(r.get("amount") or 1, 1)) - abs(
            (r.get("turnover") or 0) - 6) * 0.01

    ranked = sorted(step4, key=rank_key, reverse=True)
    funnel["精算候选"] = min(len(ranked), max_candidates)
    return ranked[:max_candidates], funnel


def rank_all(snapshot: list[dict], limit: int | None = None) -> list[dict]:
    """
    全市场排序（**不设门槛**）：把每一只 A 股都按"快评分"能用的口径排一遍。

    与 prefilter 的区别：这里**不过滤**任何条件（ST、股价>100、代码 3/68/8xx 统统保留），
    因为用户要求"5000 只都要能筛到"。过滤交给前端（用户自己勾选），后端只提供数据。
    """
    rows = list(snapshot or [])
    return rows[:limit] if limit else rows



# ----------------------------------------------------------------------
# 单只个股：K 线 → 指标 → 筹码 → 特征
# ----------------------------------------------------------------------

def build_stock_features(row: dict, bars: list[dict], *, industry_net: float | None,
                         market_score: float | None, industry_limitup: int,
                         break_rate: float | None) -> dict:
    flags = ind.trend_flags(bars)
    chip = chips.summarize(bars, price=row.get("price"))
    trapped_peak_above = None
    peaks = chip.get("peaks") or []
    if peaks:
        above = [p for p in peaks if p.get("above_current")]
        below = [p for p in peaks if not p.get("above_current")]
        if above:
            trapped_peak_above = (not below) or (above[0]["share"] >= max(
                (b["share"] for b in below), default=0))
        else:
            trapped_peak_above = False

    float_cap = row.get("float_cap") or 0
    main_net_ratio = (row.get("main_net") or 0) / float_cap * 100 if float_cap else None
    return {
        "trend": flags,
        "chip": chip,
        "features": {
            "c1": bool(flags.get("ma5_rising") and flags.get("close_above_ma5")
                       and flags.get("is_red")),
            "c2": bool(flags.get("macd_golden")),
            "c3": bool(flags.get("daily_bull")),
            "c4": bool(flags.get("weekly_bull")),
            "main_net": row.get("main_net"),
            "main_net_ratio": main_net_ratio,
            "super_ratio": row.get("main_net_pct"),
            "profit_ratio": chip.get("profit_ratio_pct"),
            "hhi": chip.get("hhi"),
            "trapped_peak_above": trapped_peak_above,
            "turnover": row.get("turnover"),
            "ret_5d": flags.get("ret_5d_pct"),
            "price": row.get("price"),
            "industry_net": industry_net,
            "market_score": market_score,
            "industry_limitup": industry_limitup,
            "break_rate": break_rate,
        },
    }


# ----------------------------------------------------------------------
# 市场级数据
# ----------------------------------------------------------------------

def build_dashboard(snapshot: list[dict], pools: dict, boards: dict,
                    market_score: float | None) -> dict:
    up = sum(1 for r in snapshot if (r.get("change_pct") or 0) > 0)
    dn = sum(1 for r in snapshot if (r.get("change_pct") or 0) < 0)
    flat = len(snapshot) - up - dn
    changes = sorted(r["change_pct"] for r in snapshot if r.get("change_pct") is not None)
    median = changes[len(changes) // 2] if changes else None
    ratio = (up / dn) if dn else None
    zt = len(pools.get("up") or [])
    zb = len(pools.get("break") or [])
    dt_ = len(pools.get("down") or [])
    break_rate = (zb / (zt + zb)) if (zt + zb) else None
    max_lb = max([int(p.get("lbc") or 1) for p in (pools.get("up") or [])] or [1])

    industry = boards.get("industry") or []
    return {
        "trade_date": None,      # 由上层填
        "breadth": {"total": len(snapshot), "advancing": up, "declining": dn, "flat": flat,
                    "advance_decline_ratio": round(ratio, 3) if ratio else None,
                    "median_change_pct": round(median, 2) if median is not None else None},
        "limit": {"up": zt, "break": zb, "down": dt_, "max_continue": max_lb,
                  "break_rate": round(break_rate, 4) if break_rate is not None else None},
        "market_score": market_score,
        "flow_in_top": sorted([r for r in snapshot if (r.get("main_net") or 0) > 0],
                              key=lambda r: -(r.get("main_net") or 0))[:10],
        "flow_out_top": sorted([r for r in snapshot if (r.get("main_net") or 0) < 0],
                               key=lambda r: (r.get("main_net") or 0))[:10],
        "sector_top": industry[:5],
    }


def compute_market_score(breadth: dict, limit: dict) -> tuple[float, dict]:
    """
    市场情绪评分（0–100，本工具自定义，公式公开）。

    权重：涨跌家数比 30、涨停家数 25、跌停家数 15、炸板率 15、连板高度 15。
    与原项目已验证的公式一致，便于历史对比。
    """
    parts: dict[str, float] = {}
    weights: list[tuple[float, int]] = []

    ratio = breadth.get("advance_decline_ratio")
    if ratio is None:
        rs = 50.0
    elif ratio <= 0:
        rs = 0.0
    else:
        rs = max(0.0, min(100.0, 50 + 25 * math.log10(ratio) / math.log10(3)))
    parts["涨跌家数比"] = round(rs, 1)
    weights.append((rs, 30))

    def log_map(v: float, full: float) -> float:
        if v <= 0:
            return 0.0
        return max(0.0, min(100.0, 100 * math.log10(1 + v) / math.log10(1 + full)))

    up = limit.get("up") or 0
    parts["涨停家数"] = round(log_map(up, 60), 1)
    weights.append((parts["涨停家数"], 25))
    dn = limit.get("down") or 0
    parts["跌停家数"] = round(100 - log_map(dn, 10), 1)
    weights.append((parts["跌停家数"], 15))
    br = limit.get("break_rate")
    if br is not None:
        bs = max(0.0, min(100.0, 100 - 150 * br))
        parts["炸板率"] = round(bs, 1)
        weights.append((bs, 15))
    lb = limit.get("max_continue") or 0
    ls = log_map(lb, 5)
    parts["连板高度"] = round(ls, 1)
    weights.append((ls, 15))

    total_w = sum(w for _, w in weights)
    score = sum(v * w for v, w in weights) / total_w if total_w else 0.0
    return round(score, 1), parts


# ----------------------------------------------------------------------
# 机构动态（调研 / 研报 / 评级 + 多空标记）
# ----------------------------------------------------------------------

def build_research(candidate_codes: list[str], day: date,
                   as_of: datetime | None = None) -> dict:
    """
    机构数据（调研 / 研报 / 评级汇总）。

    as_of 是**时点纪律**的入口：只有"在这个时刻之前已经可得"的消息才允许进入本轮评分。
    盘后发布的东西会被推到下一个交易日使用（详见 sources.py 顶部那段说明）。
    """
    survey = src.org_survey(pages=8, as_of=as_of)
    reports_stock = src.reports(qtype=0, days=14, page_size=50, as_of=as_of)
    reports_industry = src.reports(qtype=1, days=14, page_size=40, as_of=as_of)
    ratings = src.rating_summary(candidate_codes) if candidate_codes else {}

    # 多空标记：评级家数加权（买入/增持=看多，减持/卖出=看空）
    for code, r in ratings.items():
        bull = (r.get("buy") or 0) + (r.get("add") or 0)
        bear = (r.get("reduce") or 0) + (r.get("sell") or 0)
        r["bull"] = bull
        r["bear"] = bear
        r["stance"] = ("看多" if bull > bear else ("看空" if bear > bull else "中性"))
        r["rating_score"] = scoring.rating_to_score(
            r.get("buy") or 0, r.get("add") or 0, r.get("neutral") or 0,
            r.get("reduce") or 0, r.get("sell") or 0)
        r["upside_pct"] = None     # 目标价空间在个股维度用研报目标价另算

    # 研报多空（单篇级别）
    for r in reports_stock:
        r["stance"] = _stance_of_rating(r.get("rating"))

    # 调研：**没有多空方向**，只给关注度分档（避免编造"机构看多"）
    survey_by_code: dict[str, list] = {}
    for s in survey:
        survey_by_code.setdefault(s["code"], []).append(s)
    for code, rows in survey_by_code.items():
        rows.sort(key=lambda x: x.get("date") or "", reverse=True)
        for r in rows:
            n = r.get("org_num") or 0
            r["attention"] = "高" if n >= 10 else ("中" if n >= 3 else "低")

    return {
        "generated_at": now_cn().strftime("%Y-%m-%d %H:%M"),
        "as_of": (as_of or now_cn()).strftime("%Y-%m-%d %H:%M"),
        "pit_rule": ("时点纪律：只使用 as_of 之前已披露的研报/调研。免费接口只给日期不给时分，"
                     "因此保守按「当日 23:59 才可得」处理 —— 当天盘后发布的消息只用于 "
                     "**下一个交易日**的评分，绝不用于当天，避免未来函数。"),
        "survey": survey[:120],
        "survey_total": len(survey),
        "survey_filtered": {c: survey_by_code.get(c, [])[:5] for c in candidate_codes},
        "reports_stock": reports_stock,
        "reports_industry": reports_industry,
        "ratings": ratings,
        "stance_note": ("研报评级可折算为看多/看空（买入+增持=看多，减持+卖出=看空）；"
                        "**机构调研本身没有方向**，只有关注度（机构家数），"
                        "把它当成看多信号是错的，所以这里只标关注度"),
    }


def _stance_of_rating(rating: str | None) -> str:
    if not rating:
        return "未评级"
    r = str(rating)
    if any(k in r for k in ("买入", "增持", "强烈推荐", "推荐", "优于大市", "跑赢行业")):
        return "看多"
    if any(k in r for k in ("减持", "卖出", "弱于大市", "跑输行业")):
        return "看空"
    if any(k in r for k in ("中性", "持有", "同步大市")):
        return "中性"
    return "未评级"


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

def run(out_dir: str, *, research_only: bool = False, top_n: int = TOP_N,
        max_candidates: int = MAX_CANDIDATES) -> dict:
    t0 = time.time()
    # ⚠️ 时点纪律的基准时刻：本轮所有"消息类"数据（研报/调研/公告）都必须在这之前可得。
    #    理解成"**T 日收盘后、为 T+1 做决策**"这一件事，就不容易写错。
    as_of = now_cn()
    day = as_of.date()
    report: dict = {"trade_date": day.isoformat(), "as_of": as_of.strftime("%Y-%m-%d %H:%M"),
                    "steps": {}}
    os.makedirs(out_dir, exist_ok=True)

    # 自愈账本：每一步的成功/失败/重试/换源/补回都记在里面，最后写 health.json
    # （页面的「系统自检」直接读它，所以"这轮哪里残缺"是看得见的，不用翻 CI 日志）
    led = heal.Ledger()
    led.snapshot_sources("before")
    led.load_previous(os.path.join(out_dir, "health.json"))   # 跨轮补齐：上一轮缺的这轮优先补

    hs = src.Hithink()
    log.info("同花顺官方 Key：%s", "已配置（K 线/龙虎榜优先用官方）" if hs.enabled else "未配置，全部走东方财富免费接口")
    log.info("时点纪律：本轮使用的消息类数据截止 %s（盘后发布的下一个交易日才生效）",
             as_of.strftime("%Y-%m-%d %H:%M"))
    # 快照是不是"收盘快照"：盘中手动跑会拿到盘中价，那是时点污染，必须标记出来。
    # ⚠️ 这里先按墙上时钟给一个初值，**拿到快照之后会用行情自己的时间戳复核** ——
    #    周末/节假日跑的时候，墙上时钟会说"今天是周六/还没收盘"，而行情其实是上一交易日的收盘价。
    post_close = src.is_post_close(as_of)
    report["post_close_snapshot"] = post_close

    if research_only:
        log.info("[research-only] 只刷新机构调研/研报")
        with led.step("⑨ 机构调研/研报（research-only）"):
            research = build_research([], day, as_of)
            write_json(os.path.join(out_dir, "research.json"), research)
            report["steps"]["research"] = {"survey": research["survey_total"],
                                           "reports": len(research["reports_stock"])}
        led.snapshot_sources("after")
        write_health(out_dir, led, day)
        _write_version(out_dir, day, report, t0, extra={"mode": "research-only"})
        return report

    # 1) 全市场快照
    log.info("① 全市场快照…")
    # 快照是**必需**步骤：没有它整条筛选链都没有意义，宁可本轮失败也不发布空数据
    try:
        with led.step("① 全市场快照"):
            snapshot = src.market_snapshot()
            if not snapshot:
                raise heal.StepFailed("全市场快照为空（检查网络或接口是否变更）")
    except heal.StepFailed as exc:
        raise SystemExit(str(exc)) from exc
    log_ok("快照", f"{len(snapshot)} 只")
    # 把当天的开/高/低/昨收单独存一份（**全市场**）：
    # 决策验证要用它算"T+1 开盘买入"的价格，而推荐票在 T+1 那天可能没进精算池。
    # 这份文件很小（只存 4 个价格字段），比事后补 K 线可靠得多。
    with led.step("①b 存当日报价（供回评用）"):
        _save_quote_snapshot(out_dir, day, snapshot)

    # 1b) 用**行情自己的时间戳**确定"这份数据到底是哪一天的、是不是收盘价"。
    #     为什么必须这么做：trade_date 是回评（次日涨跌幅）和历史的键。
    #     墙上时钟写错一天，回评就会拿"周六"去对"周五的涨跌幅"，
    #     算出来的胜率/平均涨幅全是错的 —— 而且看起来完全正常，没人会发现。
    quote_dt = src.last_snapshot_quote_time()
    if quote_dt is not None:
        if quote_dt.date() != day:
            log.warning("⚠️ 行情时间是 %s，与当前日期 %s 不同 → 按 **%s** 归档"
                        "（周末/节假日跑，或接口给的是上一交易日的收盘价）",
                        quote_dt.strftime("%Y-%m-%d %H:%M"), day.isoformat(),
                        quote_dt.date().isoformat())
            day = quote_dt.date()
            report["trade_date"] = day.isoformat()
            report["date_from_quotes"] = True
        post_close = src.is_post_close(quote_dt)
        report["snapshot_quote_time"] = quote_dt.strftime("%Y-%m-%d %H:%M")
    else:
        log.warning("⚠️ 快照里没有行情时间戳（f124），退回墙上时钟判断：%s",
                    as_of.strftime("%Y-%m-%d %H:%M"))
    report["post_close_snapshot"] = post_close
    log.info("快照时点：%s", src.session_note(as_of, quote_dt))
    if not post_close:
        log.warning("⚠️ 这份快照**不是收盘价**（post_close_snapshot=false）—— "
                    "不要当作收盘数据用于回评")

    # 2) 涨停/炸板/跌停池
    log.info("② 涨停/炸板/跌停池…")
    # 从这里开始，每一步都**隔离**：拿不到就让对应模块显示"数据缺失"，本轮照常出数据，
    # 但账本里会记一笔（页面「系统自检」能看到"这轮哪一步没成"）
    with led.step("② 涨停/炸板/跌停池"):
        pools = src.limit_pools(day)
        if not (pools.get("up") or pools.get("break") or pools.get("down")):
            raise RuntimeError("三个池子都是空的")
    log_ok("涨停池", len(pools.get("up") or []))
    log_ok("炸板池", len(pools.get("break") or []))
    log_ok("跌停池", len(pools.get("down") or []))

    # 3) 板块与 ETF 资金流
    log.info("③ 板块/ETF 资金流…")
    with led.step("③ 板块/ETF 资金流"):
        boards = {
            "industry": src.board_flow(src.INDUSTRY_FS, top_n=60),
            "concept": src.board_flow(src.CONCEPT_FS, top_n=60),
            "etf": src.board_flow(src.ETF_FS, top_n=40),
        }
        if not (boards["industry"] or boards["concept"]):
            raise RuntimeError("行业与概念板块都拿不到")
    for _g, _label in (("industry", "行业板块"), ("concept", "概念板块"), ("etf", "ETF")):
        if not boards[_g]:
            led.add_missing(f"{_label}资金流", "接口返回空（限流或字段变更）")
    log_ok("行业板块", len(boards["industry"]))
    log_ok("概念板块", len(boards["concept"]))
    log_ok("ETF", len(boards["etf"]))

    # 3b) 每个板块的 5 只龙头股 + 前若干板块的 K 线/指标/筹码
    #     用户要求："标注出每一个板块的五个龙头股"、"各个板块也要能看 K 线和筹码峰"。
    #     龙头股：全部板块都取（每个板块 1 次请求，按涨幅降序）。
    #     K 线：只给前 BOARD_DETAIL_N 个板块（每个板块 1 次 K 线请求，数据量大），
    #           其余板块页面会明确写"本轮未生成 K 线"，不编造。
    log.info("③b 板块龙头股 / 板块 K 线…")
    leader_ok = kline_ok = 0
    with led.step("③b 板块龙头股"):
        for group in ("industry", "concept"):
            for b in boards[group]:
                code = b.get("code")
                if not code:
                    continue
                b["leaders"] = src.board_leaders(code, top=5)
                leader_ok += 1 if b["leaders"] else 0
        if leader_ok == 0 and (boards["industry"] or boards["concept"]):
            raise RuntimeError("一个板块的龙头股都没拿到")
    with led.step("③b 板块K线"):
        for group in ("industry", "concept"):
            for b in boards[group][:BOARD_DETAIL_N]:
                bars = src.board_kline(b.get("code"), bars=KLINE_BARS)
                if not bars:
                    b["kline_missing"] = True
                    continue
                kline_ok += 1
                b["kline"] = _kline_payload(bars)
                b["chip"] = chips.summarize(bars, bars[-1].get("close"))
                b["indicators"] = ind.trend_flags(bars)
        if kline_ok == 0:
            # 很常见（东财 push2his 全系限流）：记进缺失清单，等一下的补抓环节会再试一轮
            raise RuntimeError("本轮板块 K 线一根都没取到（接口限流）")
    log_ok("板块龙头股", f"{leader_ok} 个板块")
    log_ok("板块K线", f"{kline_ok} 个板块（每个含指标与筹码峰）")

    # 3c) 场外 ETF / 场外指数基金（用户要求新增的板块）
    #     净值是 T 日盘后公布，天然属于"盘后数据"，不存在盘中未来函数问题。
    log.info("③c 场外 ETF / 指数基金…")
    with led.step("③c 场外 ETF / 指数基金"):
        funds = _funds_payload(day)
        if not funds.get("funds"):
            raise RuntimeError(funds.get("note") or "排行接口没返回数据")
    # ⚠️ 这里**不能**写 files["funds.json"]：`files` 到第 9 步（写 JSON）才初始化，
    #    提前用会 UnboundLocalError，整轮数据一个都写不出来。
    #    （这个坑 linter 立刻抓到了，和当年 has_detail 那次是同一类。）
    log_ok("场外ETF/指数基金", f"{len(funds['funds'])} 只在榜 / 可搜索 {len(funds['universe'])} 只")

    # 4) 市场情绪
    dashboard = build_dashboard(snapshot, pools, boards, None)
    market_score, score_parts = compute_market_score(dashboard["breadth"], dashboard["limit"])
    dashboard["market_score"] = market_score
    dashboard["market_score_parts"] = score_parts
    dashboard["trade_date"] = day.isoformat()
    dashboard["break_rate"] = dashboard["limit"]["break_rate"]
    log_ok("市场情绪", market_score)

    # 5) 预筛 + 精算
    log.info("⑤ 预筛…")
    candidates, funnel = prefilter(snapshot, max_candidates)
    log_ok("精算候选", len(candidates))
    #: **全市场**：搜索库与筛选表都用它（用户要求 5000 只都能筛到/搜到，所以不再过滤）
    all_rows = rank_all(snapshot)
    row_by_code = {r["code"]: r for r in snapshot}
    log_ok("全市场（可搜索/可筛选）", len(all_rows))

    industry_net = {b["name"]: b["main_net"] for b in boards["industry"]}
    industry_limitup: dict[str, int] = {}
    for p in (pools.get("up") or []):
        nm = (p.get("hybk") or "").strip()
        if nm:
            industry_limitup[nm] = industry_limitup.get(nm, 0) + 1

    codes = [r["code"] for r in candidates]
    log.info("⑥ 个股行业/概念（批量）…")
    with led.step("⑥ 个股行业/概念"):
        ind_map = src.industry_and_concept(codes)
        if not ind_map:
            raise RuntimeError("一只股票的行业归属都没拿到")
    log_ok("行业归属", len(ind_map))

    log.info("⑦ 逐只精算：K 线 → 指标 → 筹码（最多 %d 只）…", len(candidates))
    src.reset_kline_budget()          # K 线"等待预算"每轮清零（见 sources.KLINE_WAIT_BUDGET）
    led.add_step("⑦ 逐只精算", True, 0.0, f"开始：{len(candidates)} 只")
    t_kline = time.time()
    scored: list[dict] = []
    stock_payloads: dict[str, dict] = {}
    failed = 0
    # 连续失败计数：连续 KLINE_GIVE_UP_STREAK 只拿不到 K 线就整段收工。
    # 为什么要有这个"整段收工"（而不是每只都硬试）：三个源同时被限流时，
    # 每只都要 3 秒等待 + 三次失败，几百只 = 几十分钟 → CI 超时 → **整轮产物一个都写不出来**，
    # 比"这轮少了一批 K 线（页面如实写 K 线缺失）"糟糕得多。
    streak = 0
    kline_gave_up = False
    for i, row in enumerate(candidates, 1):
        code = row["code"]
        bars = None
        if not kline_gave_up:
            bars = hs.daily_kline(code) if hs.enabled else None
            if not bars:
                bars = src.daily_kline(code, bars=300, adjust="1")
        if len(bars or []) < 30:
            failed += 1
            streak += 1
            # 前 20 只里失败率过高 → 立刻中止，不要白跑几百次（数据源被限流的典型表现）
            if i >= 20 and failed / i > (1 - MIN_SUCCESS_RATE):
                raise SystemExit(
                    f"精算失败率过高（{failed}/{i}），K 线数据源可能被限流；"
                    f"已中止本轮，不写入任何数据。稍后重试，或调大 ASHARE_MIN_INTERVAL。")
            if not kline_gave_up and streak >= KLINE_GIVE_UP_STREAK:
                kline_gave_up = True
                log.warning("⚠️ 连续 %d 只拿不到 K 线（%s）→ **本段收工**，"
                            "剩余 %d 只直接标记「K 线缺失」，本轮照常出数据",
                            streak, src.kline_budget_state(), len(candidates) - i)
            continue
        streak = 0
        info = ind_map.get(code) or {}
        industry = info.get("industry") or row.get("industry") or ""
        built = build_stock_features(
            row, bars, industry_net=industry_net.get(industry),
            market_score=market_score, industry_limitup=industry_limitup.get(industry, 0),
            break_rate=dashboard["limit"]["break_rate"])
        feat = built["features"]
        scored.append({"code": code, "name": row["name"], "industry": industry,
                       "concept": info.get("concept", ""), "price": row.get("price"),
                       "change_pct": row.get("change_pct"), "turnover": row.get("turnover"),
                       "amount": row.get("amount"), "float_cap": row.get("float_cap"),
                       "main_net": row.get("main_net"), "main_net_pct": row.get("main_net_pct"),
                       "trend": built["trend"], "chip": built["chip"],
                       "features": feat, "_bars": bars})
        if i % 40 == 0:
            log.info("    …已精算 %d/%d（失败 %d）", i, len(candidates), failed)
    log_ok("精算完成", f"{len(scored)} 只（失败 {failed} 只）")
    # 逐只精算的账本条目单独补一条（数量大、不适合按只记账）：
    # 失败只数 + 是否触发了"整段收工"，都记下来给页面看
    led.steps[-1] = {"name": "⑦ 逐只精算", "ok": failed < len(candidates),
                     "seconds": round(time.time() - t_kline, 1),
                     "note": f"成功 {len(scored)} / 失败 {failed}"
                             + ("（K 线源被限流，已整段收工）" if kline_gave_up else ""),
                     "attempts": 1}
    if failed:
        led.add_missing(f"K线精算（{failed} 只）",
                        f"{failed} 只拿不到 K 线（来源限流），页面按「K 线缺失」显示")

    # ⚠️ 质量闸门：精算结果太少就不要往下写。
    #    实测踩过：三个 K 线源同时被限流时，脚本"成功跑完"却只产出 1 只股票，
    #    如果照样提交，页面上就是一份几乎空的数据 —— 而且没人知道是限流导致的。
    #    宁可这里直接失败（Actions 变红、旧数据保持不变），也不要发布残缺结果。
    if len(scored) < MIN_SCORED:
        # 质量闸门：这是**必需**步骤的失败 —— 记进账本后照旧让本轮失败
        led.add_step("⑦b 质量闸门", False, 0.0,
                     f"精算只数过少（{len(scored)} < {MIN_SCORED}），本轮不写入任何数据")
        led.snapshot_sources("after")
        write_health(out_dir, led, day)
        raise SystemExit(
            f"精算只数过少（{len(scored)} < {MIN_SCORED}）：数据源可能大面积失败。"
            f"本轮**不写入任何数据**，docs/data 保持原样；请稍后重试。")
    led.add_step("⑦b 质量闸门", True, 0.0, f"精算 {len(scored)} 只 ≥ {MIN_SCORED}")

    # 6) 龙虎榜 + 席位
    log.info("⑧ 龙虎榜与席位…")
    with led.step("⑧ 龙虎榜与席位"):
        dragon_list = src.dragon_tiger(_last_trade_day(day))
        dragon_codes = [d["code"] for d in dragon_list]
        if not dragon_list:
            raise RuntimeError("龙虎榜名单为空（可能不是交易日或接口限流）")
    seats: dict[str, dict] = {}
    for code in dragon_codes[:40]:
        seats[code] = src.dragon_seats(_last_trade_day(day), code, top=5)
    if dragon_codes and not any(seats.values()):
        led.add_missing("龙虎榜席位明细", "上榜个股拿到了，但席位一张都没取到（接口限流）")
    log_ok("上榜个股", len(dragon_list))
    log_ok("席位明细", len(seats))

    # 7) 机构数据
    log.info("⑨ 机构调研/研报/评级…")
    with led.step("⑨ 机构调研/研报/评级"):
        research = build_research([s["code"] for s in scored[:120]], day, as_of)
        if not (research.get("reports_stock") or research.get("survey")):
            raise RuntimeError("研报与调研都为空")
    log_ok("调研记录", research["survey_total"])
    log_ok("个股研报", len(research["reports_stock"]))
    log_ok("评级汇总", len(research["ratings"]))

    # 8) 打分（v2：横截面相对评分）
    #    ⚠️ 关键顺序：必须**先把所有候选的原始因子收集齐**，才能算"截面分布"，
    #       否则每只股票只能拿绝对阈值去衡量（就是 v1 的毛病）。
    log.info("⑩ 打分（v2 横截面相对评分）…")
    for s in scored:
        code = s["code"]
        rating = research["ratings"].get(code) or {}
        reports_for = [r for r in research["reports_stock"] if r.get("code") == code]
        target = None
        for r in reports_for:
            if r.get("target_high"):
                target = max(target or 0, r["target_high"])
        upside = ((target / s["price"] - 1) * 100) if (target and s.get("price")) else None
        d_survey = research["survey_filtered"].get(code) or []
        orgs = max([int(x.get("org_num") or 0) for x in d_survey] or [0])
        s["fund"] = scoring.fundamental_score(row_by_code.get(code) or {})
        trend = s.get("trend") or {}
        s["features"].update({
            "rating_score": rating.get("rating_score"),
            "upside_pct": upside,
            "survey_orgs": orgs,
            "dragon_net": next((d["net_amt"] for d in dragon_list if d["code"] == code), None),
            # v2 需要的新因子（全部来自已抓到的数据，不用新接口）
            "daily_bull": trend.get("daily_bull"),
            "weekly_bull": trend.get("weekly_bull"),
            "macd_golden": trend.get("macd_golden"),
            "ma5_rising": trend.get("ma5_rising"),
            "ret_20d": trend.get("ret_20d_pct"),
            "vol_20d": trend.get("vol_20d_pct"),
            "fund_score": s["fund"]["score"],
        })

    # ---- 截面分布：这些是 v2 的"标尺" ----
    feats = [s["features"] for s in scored]
    dist = {
        "main_net_ratio": scoring.build_distributions(feats, "main_net_ratio"),
        "super_ratio": scoring.build_distributions(feats, "super_ratio"),
        "dragon_net": scoring.build_distributions(feats, "dragon_net"),
        "hhi": scoring.build_distributions(feats, "hhi"),
        "upside_pct": scoring.build_distributions(feats, "upside_pct"),
        "survey_orgs": scoring.build_distributions(feats, "survey_orgs"),
        "ret_20d": scoring.build_distributions(feats, "ret_20d"),
    }
    # 行业相对强弱：同一行业内按当日涨幅排名（0~1），比"行业资金净流入>0"精细得多
    by_ind: dict[str, list[dict]] = {}
    for s in scored:
        by_ind.setdefault(s.get("industry") or "其他", []).append(s)
    for rows_ind in by_ind.values():
        order = sorted(rows_ind, key=lambda x: (x.get("change_pct") or -999))
        n = max(1, len(order) - 1)
        for i, s in enumerate(order):
            s["features"]["industry_chg_rank"] = round(i / n, 4)

    # ---- 自动降权：读上一轮的 weights_override.json（依据因子 RankIC）----
    # 注意读的是**上一轮**的产物：本轮打分发生在决策验证之前，
    # 所以"今天用到的权重"来自"昨天算出来的因子健康度"—— 这本来就是唯一正确的顺序
    # （用今天的 IC 去调今天的打分，等于用了未来的信息）。
    _prev_ov = _load_json(os.path.join(out_dir, "weights_override.json")) or {}
    _eff_weights = None
    if _prev_ov.get("applied") and _prev_ov.get("dimensions"):
        _eff_weights = {k: round(scoring.WEIGHTS_V2[k] * float(v or 1.0), 3)
                        for k, v in _prev_ov["dimensions"].items() if k in scoring.WEIGHTS_V2}
        log.warning("⚠️ 本轮使用**自动调整过的**维度权重（依据上一轮因子 RankIC）：%s",
                    {k: v for k, v in _prev_ov["dimensions"].items() if v != 1.0})
    _ctx = {"weights": _eff_weights} if _eff_weights else None

    for s in scored:
        s["score"] = scoring.score_stock_v2(s["features"], dist, _ctx)
        s["advice"] = scoring.advise(s["score"]["score"], fund_score=s["fund"]["score"],
                                     features=s["features"], fundamentals=s["fund"])
        s["inst"] = {"rating": rating_or_empty(research, s["code"]),
                     "reports": [r for r in research["reports_stock"] if r.get("code") == s["code"]][:5],
                     "upside_pct": s["features"].get("upside_pct"),
                     "survey": research["survey_filtered"].get(s["code"]) or [],
                     "survey_orgs": s["features"].get("survey_orgs") or 0}
    report["scoring_version"] = scoring.SCORING_VERSION
    report["weights_auto_applied"] = bool(_eff_weights)

    scored.sort(key=lambda x: -(x["score"]["score"]))
    top = [s["code"] for s in scored[:top_n]]
    log_ok("Top 评分", " ".join(top))

    # 9) 写 JSON
    log.info("⑪ 写 JSON…")
    # ---- 二次补抓：主流程跑完后，对账本里失败的项做一轮定向重试 ----
    #      （限流通常是短时的；等了几分钟后再试往往就好了，直接放弃等于白丢一块数据）
    repair_pass(led, boards, funds, seats, day)

    files: dict[str, int] = {}
    files["dashboard.json"] = write_json(os.path.join(out_dir, "dashboard.json"), dashboard)
    files["limitup.json"] = write_json(os.path.join(out_dir, "limitup.json"),
                                       _limitup_payload(pools, day))
    files["sectors.json"] = write_json(os.path.join(out_dir, "sectors.json"),
                                       {"trade_date": day.isoformat(), **boards})
    files["dragon.json"] = write_json(os.path.join(out_dir, "dragon.json"),
                                      {"trade_date": _last_trade_day(day).isoformat(),
                                       "rows": dragon_list, "seats": seats})
    files["research.json"] = write_json(os.path.join(out_dir, "research.json"), research)
    files["funds.json"] = write_json(os.path.join(out_dir, "funds.json"), funds)
    # ⚠️ index_kline.json 不在这里写：决策验证（第 ⑫ 步）需要先拿到指数 K 线，
    #    所以在那里统一次抓取并写盘（避免对指数 K 线接口发两轮请求）。
    # ⚠️ 顺序很关键：has_detail 必须在**写 screen.json 之前**算好。
    #    曾经先写 screen.json 再算它 → UnboundLocalError，整轮 JSON 一个都没写出来。
    #    规则：表格里能点到的每一只都要有详情文件（否则点进去 404），
    #    超上限的部分标 has_detail=false，前端据此禁止点击。
    detail_codes = [s["code"] for s in scored[:MAX_STOCK_FILES]]
    has_detail = set(detail_codes)
    truncated = [s["code"] for s in scored[MAX_STOCK_FILES:]]
    if truncated:
        log.info("  精算 %d 只，其中前 %d 只生成详情文件，其余 %d 只仅参与评分排序",
                 len(scored), len(detail_codes), len(truncated))

    # 全市场可搜索库 + 筛选表：**都覆盖全部 A 股**（用户要求 5000 只都能筛到/搜到）。
    # 顺序要紧：先算 universe（它算了快评分），screen 直接复用，避免重复计算。
    universe = _universe_payload(all_rows, scored, has_detail, day, market_score, industry_net)
    files["universe.json"] = write_json(os.path.join(out_dir, "universe.json"), universe)

    files["screen.json"] = write_json(os.path.join(out_dir, "screen.json"),
                                      _screen_payload(scored, funnel, top, day, market_score,
                                                      has_detail, universe["rows"]))

    # 个股详情：逐只写文件
    # 近几年盈利状况：每只 1 次请求，只给评分最高的前 FIN_HISTORY_N 只
    #（其余个股页写明"本轮未取到财务历史"，不做假表）
    fin_map: dict[str, list[dict]] = {}
    with led.step("⑪b 近几年财务（前 %d 只）" % FIN_HISTORY_N):
        for s in scored[:FIN_HISTORY_N]:
            got = src.fin_history(s["code"], periods=12)
            if got:
                fin_map[s["code"]] = got
        if scored and not fin_map:
            raise RuntimeError("一只都没取到财务历史（接口限流或字段变更）")

    # 规则化点评：只给评分最高的前 N 只写（用户要求 10 只）。
    # ⚠️ 纯字符串拼装，**不调用任何大模型** → 一天 3 轮、Token 消耗恒为 0。
    with led.step("⑪c 规则化点评（前 %d 只）" % COMMENTARY_N):
        comm_insts = {s["code"]: s.get("inst") or {} for s in scored}
        comm = commentary.build_all(scored, rows=row_by_code, insts=comm_insts,
                                    fins=fin_map, limit=COMMENTARY_N)
        if not comm["items"]:
            raise RuntimeError("没有生成任何点评")
    files["commentary.json"] = write_json(os.path.join(out_dir, "commentary.json"), comm)
    log_ok("规则化点评", f"{comm['count']} 只（规则拼接，无大模型）")
    comm_by_code = comm["by_code"]

    for s in scored:
        if s["code"] not in has_detail:
            continue
        payload = _stock_payload(s, day, row_by_code.get(s["code"]), fin_map.get(s["code"]),
                                 comm_by_code.get(s["code"]))
        files[f"stock/{s['code']}.json"] = write_json(
            os.path.join(out_dir, "stock", f"{s['code']}.json"), payload)

    # 近 5 天热度：每次运行把当日市场温度写进 history.json 累积下来
    heat = _update_history(out_dir, day, snapshot, dashboard, pools, scored, top)

    # 历史股评：把"每日评分最高的那批"记下来，**下一个交易日回填它们的涨跌幅**，
    # 连续保留 REVIEW_KEEP 期，并汇总胜率与平均涨幅（用户要求的新模块）。
    review = _update_stock_review(out_dir, day, snapshot, scored, top_n)
    files["review.json"] = write_json(os.path.join(out_dir, "review.json"), review)

    # ---- 决策验证（用户要求的核心新增）----
    # 顺序很讲究：
    #   ① 因子快照（把今天的原始因子值存档，供以后算 RankIC）
    #   ② 用相邻快照回填未来收益 → RankIC / 因子健康 → 权重覆盖（给 scoring 用）
    #   ③ 推荐组合的可执行口径回评（T+1 开盘买 → T+2 开盘卖，扣成本、剔一字板）
    #   ④ 市场环境 + 策略评级 + 顶部横幅 → selfcheck.json
    log.info("⑫ 决策验证（自检）…")
    idx_payload = _index_payload(hs)
    files["index_kline.json"] = write_json(os.path.join(out_dir, "index_kline.json"), idx_payload)
    with led.step("⑫ 决策验证（自检）"):
        sc_payload, w_override = _selfcheck_payload(
            out_dir, day, scored, review, idx_payload, dashboard,
            health=led.payload(day=day.isoformat(), trade_date=day.isoformat()))
        files["factors/" + day.isoformat() + ".json"] = os.path.getsize(
            factor_ic.snapshot_path(out_dir, day.isoformat()))
        files["factor_ic.json"] = write_json(os.path.join(out_dir, "factor_ic.json"),
                                             sc_payload["factor_ic"])
        files["weights_override.json"] = write_json(
            os.path.join(out_dir, "weights_override.json"), w_override)
        files["selfcheck.json"] = write_json(os.path.join(out_dir, "selfcheck.json"), sc_payload)
    _r = sc_payload["rating"]["level"]
    log_ok("策略自检", f"{_r}（{sc_payload['rolling']['periods_used']} 期 / "
                       f"{sc_payload['rolling']['picks']} 样本）")
    log_ok("市场环境", f"{sc_payload['regime']['regime']}"
                       + ("（空仓预警）" if sc_payload["regime"]["empty_warning"] else ""))
    if sc_payload["banners"]:
        log.warning("  ⚠️ %s", sc_payload["banners"][0]["text"])

    # 10) 版本信息
    # ⚠️ 顺序要紧：scored/top 必须在写 version.json **之前**填好。
    #    早期版本先写 version.json 再赋值，结果页面上一直显示"精算 0 只"。
    report["scored"] = len(scored)
    report["top"] = top
    files["history.json"] = write_json(os.path.join(out_dir, "history.json"), heat)
    files["version.json"] = _write_version(out_dir, day, report, t0)

    # ---- 产物校验 + 自愈账本（放在最后：此时所有文件都已落盘） ----
    # 校验只报警不删数据：把它写进 health.json，页面「系统自检」里能看到
    # "本轮有几处字段不合法"。真正物理上不可能的坏值（负价格、350 分）在
    # 生成 payload 时已经由 heal.repair_rows 置空并记账。
    led.snapshot_sources("after")
    check = heal.validate_artifacts(out_dir, today=now_cn().date().isoformat())
    report["artifact_check"] = {"checked": check["checked"], "issues": len(check["issues"]),
                                "examples": check["issues"][:3]}
    health_payload = led.payload(day=day.isoformat(), trade_date=day.isoformat())
    health_payload["artifact_check"] = check
    files["health.json"] = write_json(os.path.join(out_dir, "health.json"), health_payload)
    for issue in check["issues"][:5]:
        log.warning("  产物校验：%s", issue)

    report["files"] = files
    report["total_bytes"] = sum(files.values())
    _hs = health_payload["summary"]
    log.info("完成：%d 只精算 / Top %d / 共 %.2f MB / 用时 %.0fs",
             len(scored), len(top), report["total_bytes"] / 1024 / 1024, time.time() - t0)
    log.info("自愈账本：%d 步（失败 %d）· 补回 %d 项 · 仍缺 %d 项 · 重试失败 %d 次",
             _hs["steps_total"], _hs["steps_failed"], _hs["repaired"],
             _hs["still_missing"], health_payload["sources"]["failed_attempts"])
    return report


def rating_or_empty(research: dict, code: str) -> dict:
    """取某只股票的评级汇总（拿不到返回空 dict，页面显示"—"，不编造）。"""
    return (research.get("ratings") or {}).get(code) or {}


def _last_trade_day(day: date) -> date:
    """龙虎榜是盘后数据：当天 18 点前通常只有上一交易日的，往前退到工作日。"""
    d = day if now_cn().hour >= 18 else day - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _funds_payload(day: date) -> dict:
    """
    场外 ETF / 指数基金（用户要求新增的板块）。

    为什么单独抽成函数：这个 payload 的字段形状被两个地方用 ——
      · run() 的真实抓取（第 ③c 步）
      · _debug 下的离线样例生成器（没有行情网时给预览造 funds.json）
    形状写在两处必然漂移，所以只留一份。

    ⚠️ 关于"是不是未来函数"：场外基金净值 **T 日收盘后才公布**（一般 20:00 之后），
       所以 20:00 跑出来的就是 T 日净值，属于盘后数据；页面上每只都标了净值日期。
       **拿不到的**：盘中估值（天天基金估值接口已下线，返回 404）、申赎限额、跟踪标的
       → 一律按"数据缺失"显示，绝不编造。
    """
    funds = {"trade_date": day.isoformat(), "funds": [], "universe": [], "note": ""}
    try:
        rank_rows = src.fund_rank("zs", pages=2, page_size=100, sort="1nzf")
        etf_rows = [r for r in rank_rows if r.get("is_etf_link")]
        # 指数型里除了 ETF 联接，还有普通指数基金/增强指数，一并保留但标注类型
        funds["funds"] = (etf_rows or rank_rows)[:200]
        uni = src.fund_universe()
        # 搜索库只留"指数型 + 名字带 ETF/联接"，全量 2.7 万只太大且与股票无关
        funds["universe"] = [u for u in uni
                             if ("ETF" in (u.get("name") or "") or "联接" in (u.get("name") or ""))
                             and "指数" in (u.get("type") or "")][:3000]
        funds["fund_total"] = len(uni)
        funds["note"] = ("场外基金净值 **T 日收盘后公布**，所以这是盘后数据、不存在盘中未来函数；"
                         "页面上标了每只的净值日期。数据来源：天天基金公开接口。"
                         "**拿不到的**：盘中估值（该接口已下线）、申赎限额、跟踪标的 → 一律按数据缺失处理。")
    except Exception as exc:                      # noqa: BLE001
        log.warning("场外基金抓取失败（不影响股票部分）：%s", exc)
        funds["note"] = f"本轮场外基金数据未取到：{exc}"
    return funds


def _limitup_payload(pools: dict, day: date) -> dict:
    def conv(p: dict) -> dict:
        return {"code": str(p.get("c") or "").zfill(6), "name": p.get("n"),
                "price": (p.get("p") or 0) / 1000 if p.get("p") else None,
                "change_pct": p.get("zdp"), "amount": p.get("amount"),
                "float_cap": p.get("ltsz"), "turnover": p.get("hs"),
                "continue_days": p.get("lbc"), "first_seal": _hhmmss(p.get("fbt")),
                "last_seal": _hhmmss(p.get("lbt")), "break_times": p.get("zbc"),
                "seal_fund": p.get("fund") or p.get("fba"), "industry": p.get("hybk"),
                "stat": p.get("zttj"), "open_times": p.get("oc")}

    up = [conv(p) for p in (pools.get("up") or [])]
    up.sort(key=lambda x: (-(x.get("continue_days") or 1), x.get("first_seal") or "99:99:99"))
    return {"trade_date": day.isoformat(),
            "up": up, "break": [conv(p) for p in (pools.get("break") or [])],
            "down": [conv(p) for p in (pools.get("down") or [])],
            "first_board": [x for x in up if (x.get("continue_days") or 1) <= 1][:30],
            "ladder": _ladder(up)}


def _hhmmss(v) -> str | None:
    """92500 → '09:25:00'（涨停池的时间字段是 HHMMSS 整数）。"""
    if not v:
        return None
    s = str(int(v)).zfill(6)
    return f"{s[0:2]}:{s[2:4]}:{s[4:6]}"


def _ladder(up: list[dict]) -> list[dict]:
    """连板天梯：{连板数: [股票…]}，界面用来画梯队。"""
    out: dict[int, list[dict]] = {}
    for x in up:
        n = int(x.get("continue_days") or 1)
        out.setdefault(n, []).append({"code": x["code"], "name": x["name"],
                                      "industry": x.get("industry")})
    return [{"days": k, "stocks": v} for k, v in sorted(out.items(), reverse=True)]


def _index_payload(hs) -> dict:
    out: dict = {}
    for secid_str, name in INDEXES:
        bars = hs.index_kline(secid_str) if hs.enabled else None
        if not bars:
            bars = src.index_kline(secid_str, bars=160)
        out[secid_str] = {"name": name, "kline": _kline_payload(bars)}
    return out


def _kline_payload(bars: list[dict], bars_limit: int = KLINE_BARS) -> dict:
    d = (bars or [])[-bars_limit:]
    return {"dates": [b["date"] for b in d],
            "open": [b.get("open") for b in d], "high": [b.get("high") for b in d],
            "low": [b.get("low") for b in d], "close": [b.get("close") for b in d],
            "volume": [int(b.get("volume") or 0) for b in d],
            # 成交额：光标浮层在"成交量"那一段要显示它（腾讯那条实时路拿不到，会是 None → 页面显示"—"）
            "amount": [b.get("amount") for b in d]}


def _update_history(out_dir: str, day: date, snapshot: list[dict], dashboard: dict, pools: dict,
                    scored: list[dict], top: list[str], keep: int = 30) -> dict:
    """
    累积"近 N 天热度"数据。

    ⚠️ 之前页面上写"每次运行会写入 data/history.json"，但**代码里根本没写这个文件** ——
       页面永远显示"数据需要积累"，等于对用户说了假话。这个函数把欠的实现补上：
       每个交易日一条记录（涨停/跌停/炸板/情绪/精算只数/Top 平均分），最多保留 keep 天。
    """
    path = os.path.join(out_dir, "history.json")
    days: list[dict] = []
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                old = json.load(fh)
            if isinstance(old, dict):
                days = old.get("days") or []
            elif isinstance(old, list):
                days = old
        except (OSError, ValueError):
            days = []

    limit = dashboard.get("limit") or {}
    top_rows = [s for s in scored if s["code"] in set(top)]
    entry = {
        "date": day.isoformat(),
        "limit_up": limit.get("up"),
        "limit_down": limit.get("down"),
        "break": limit.get("break"),
        "break_rate": limit.get("break_rate"),
        "max_continue": limit.get("max_continue"),
        "market_score": dashboard.get("market_score"),
        # ⚠️ 涨跌家数必须存：市场环境判定（普涨/震荡/单边下跌）算"近 10 日下跌家数占比中位数"
        #    要用它。第一版没存 → 实测时环境判定永远是「数据不足」，
        #    等于空仓预警**永远不会触发**（而且日志里看着一切正常）。
        "advancing": (dashboard.get("breadth") or {}).get("advancing"),
        "declining": (dashboard.get("breadth") or {}).get("declining"),
        "flat": (dashboard.get("breadth") or {}).get("flat"),
        "advance_decline_ratio": (dashboard.get("breadth") or {}).get("advance_decline_ratio"),
        "scored": len(scored),
        "top_count": len(top),
        "top_avg_score": (round(sum(s["score"]["score"] for s in top_rows) / len(top_rows), 1)
                          if top_rows else None),
        "top_codes": top[:15],
    }
    days = [d for d in days if d.get("date") != entry["date"]]
    days.append(entry)
    days.sort(key=lambda d: d.get("date") or "")
    days = days[-keep:]
    return {"days": days, "note": f"每次完整抓取追加一条，最多保留 {keep} 个交易日。"}


REVIEW_KEEP = int(os.environ.get("ASHARE_REVIEW_KEEP", "5"))   # 历史股评保留期数（跑满就删旧的）


def _update_stock_review(out_dir: str, day: date, snapshot: list[dict],
                         scored: list[dict], top_n: int, keep: int = REVIEW_KEEP) -> dict:
    """
    历史股评（用户要求的新模块）：把"每日评分最高的那批"记下来，**下一个交易日回填涨跌幅**，
    连续保留 keep 期，然后汇总胜率与平均涨幅。

    怎么回填：今天的全市场快照里有每只股票**当日**的涨跌幅，
    所以"上一期（上个交易日）选出来的股票"的次日表现 = 它们在今天快照里的 change_pct。
    停牌/退市导致快照里没有的，记为 null 并单独统计，不当作 0 混进平均。

    为什么不留全历史：用户明确要求"连续进行 5 天的历史股回评，随后删除"，所以只保留最近 keep 期
    （未回填完的那一期也保留，否则永远等不到次日数据）。旧的自动丢弃，文件不会无限长大。

    ⚠️ 但**胜率要长期保留**（用户明确要求"历史股评的胜率要实时保留，一直保留着"）：
       所以另有一个 `lifetime` 累计器 —— 每期回评完成后把"赢的次数/样本数/涨跌幅合计"累加进去，
       它**永不随明细一起被删**。这样页面上的"累计胜率/累计平均涨幅"是从第一天到今天的，
       而"近 5 期"只是明细窗口。
    """
    path = os.path.join(out_dir, "review.json")
    periods: list[dict] = []
    lifetime: dict = {"periods": 0, "picks": 0, "wins": 0, "sum_change": 0.0, "best": None,
                      "worst": None, "since": None, "last": None}
    if os.path.exists(path):
        try:
            with open(path, encoding="utf-8") as fh:
                old = json.load(fh)
            if isinstance(old, dict):
                periods = old.get("periods") or []
                life = old.get("lifetime") or {}
                if isinstance(life, dict):
                    lifetime.update({k: life.get(k, lifetime[k]) for k in lifetime})
        except (OSError, ValueError):
            periods = []

    today = day.isoformat()
    quote = {str(r.get("code")): r for r in (snapshot or [])}

    # ---------- 1) 给"还没回评"的往期回填次日涨跌幅 ----------
    for p in periods:
        if p.get("done") or not p.get("picks") or (p.get("date") or "") >= today:
            continue
        results = []
        for pick in p["picks"]:
            row = quote.get(str(pick.get("code")))
            if row is None:
                results.append({"code": pick.get("code"), "name": pick.get("name"),
                                "change_pct": None, "note": "当日快照里没有（停牌/退市？）"})
            else:
                results.append({"code": pick.get("code"), "name": pick.get("name"),
                                "change_pct": row.get("change_pct")})
        vals = [x["change_pct"] for x in results if x.get("change_pct") is not None]
        p["next_date"] = today
        p["results"] = results
        p["win_rate"] = round(sum(1 for v in vals if v > 0) / len(vals) * 100, 1) if vals else None
        p["avg_change"] = round(sum(vals) / len(vals), 2) if vals else None
        p["max_gain"] = round(max(vals), 2) if vals else None
        p["max_loss"] = round(min(vals), 2) if vals else None
        p["done"] = bool(vals)
        # 累计器：这一期只累加一次（done 之前是 False，所以不会重复计入）
        if p["done"]:
            lifetime["periods"] = int(lifetime.get("periods") or 0) + 1
            lifetime["picks"] = int(lifetime.get("picks") or 0) + len(vals)
            lifetime["wins"] = int(lifetime.get("wins") or 0) + sum(1 for v in vals if v > 0)
            lifetime["sum_change"] = round(float(lifetime.get("sum_change") or 0) + sum(vals), 4)
            lifetime["best"] = (max(vals) if lifetime.get("best") is None
                                else max(float(lifetime["best"]), max(vals)))
            lifetime["worst"] = (min(vals) if lifetime.get("worst") is None
                                 else min(float(lifetime["worst"]), min(vals)))
            lifetime["best"] = round(float(lifetime["best"]), 2)
            lifetime["worst"] = round(float(lifetime["worst"]), 2)
            lifetime["last"] = today
            if not lifetime.get("since"):
                lifetime["since"] = p.get("date")

    # ---------- 2) 追加今天这一期 ----------
    picks = []
    for s in scored[:top_n]:
        bar = (s.get("bars") or [{}])[-1]
        picks.append({"code": s["code"], "name": s.get("name"),
                      "score": round(float(s["score"]["score"]), 1),
                      "close": bar.get("close"),
                      "advice": (s.get("advice") or {}).get("label")})
    periods = [p for p in periods if (p.get("date") or "") != today]
    if picks:
        periods.append({"date": today, "picks": picks, "done": False})

    # ---------- 3) 只保留最近 keep 期（外加 1 期未完成的） ----------
    periods.sort(key=lambda p: p.get("date") or "")
    done = [p for p in periods if p.get("done")]
    pending = [p for p in periods if not p.get("done")]
    dropped = max(0, len(done) - keep)
    done = done[-keep:]
    periods = sorted(done + pending, key=lambda p: p.get("date") or "")

    # ---------- 4) 汇总（只用已回评的期数） ----------
    all_vals = [x["change_pct"] for p in done for x in (p.get("results") or [])
                if x.get("change_pct") is not None]
    wins = [v for v in all_vals if v > 0]
    summary = {
        "periods": len(done),
        "picks": len(all_vals),
        "win_rate": round(len(wins) / len(all_vals) * 100, 1) if all_vals else None,
        "avg_change": round(sum(all_vals) / len(all_vals), 2) if all_vals else None,
        "best": round(max(all_vals), 2) if all_vals else None,
        "worst": round(min(all_vals), 2) if all_vals else None,
    }
    return {
        "trade_date": today,
        "keep": keep,
        "periods": periods,
        "summary": summary,
        # 长期累计（**永不随明细删除**）：用户要求"胜率要一直保留着"
        "lifetime": {
            "periods": lifetime.get("periods") or 0,
            "picks": lifetime.get("picks") or 0,
            "wins": lifetime.get("wins") or 0,
            "win_rate": (round(int(lifetime.get("wins") or 0)
                               / int(lifetime["picks"]) * 100, 1)
                         if lifetime.get("picks") else None),
            "avg_change": (round(float(lifetime.get("sum_change") or 0)
                                 / int(lifetime["picks"]), 2)
                           if lifetime.get("picks") else None),
            "best": lifetime.get("best"),
            "worst": lifetime.get("worst"),
            "since": lifetime.get("since"),
            "last": lifetime.get("last"),
        },
        "dropped": dropped,
        "note": ("每期记录当日评分最高的 %d 只，下一交易日回填它们的涨跌幅；"
                 "明细只保留最近 %d 期，更早的自动删除，但**累计胜率与累计平均涨幅永不清零**。"
                 "涨跌幅是收盘对收盘，不含手续费，属于规则化回评，不是实盘收益。")
                % (top_n, keep),
    }


def _universe_payload(all_rows: list[dict], scored: list[dict], has_detail: set[str],
                      day: date, market_score: float,
                      industry_net: dict[str, float] | None = None) -> dict:
    """
    全市场可搜索库（搜索框 + 筛选表都用它）。

    **覆盖每一只 A 股**（用户要求："5000 家都要能筛到、能搜到"）：不再做任何前置过滤，
    ST、股价>100、创业板/科创板/北交所统统保留。

    分数分两套，页面必须分开显示（口径不同，不能混着排序）：
        · score（精算分，技术32+资金24+筹码18+机构16+板块10−风险）：只有精算池有，其他为 null
        · score_light（快评分，基本面45+资金35+板块情绪20）：**全市场都有**
    原始字段名沿用前端已有约定（has_tech / has_detail），避免破坏现有页面。
    """
    ind_net = industry_net or {}
    by_code = {s["code"]: s for s in scored}
    rows = []
    for r in all_rows:
        code = str(r.get("code") or "").zfill(6)
        if not code or code == "000000":
            continue
        full = by_code.get(code)
        fund = scoring.fundamental_score(r)
        light = scoring.score_light(fund,
                                    main_net=r.get("main_net"), float_cap=r.get("float_cap"),
                                    industry_net=ind_net.get((r.get("industry") or "").strip()),
                                    market_score=market_score)
        if full:
            score = full["score"]["score"]
            parts = full["score"]["parts"]
            advice = full["advice"]
            has_tech = True
        else:
            score = None
            parts = light["parts"]
            advice = scoring.advise(light["score"], fund_score=fund["score"],
                                    features={"main_net": r.get("main_net")},
                                    fundamentals=fund)
            has_tech = False
        rows.append({
            "code": code, "name": r.get("name"), "industry": r.get("industry"),
            "price": r.get("price"), "change_pct": r.get("change_pct"),
            "turnover": r.get("turnover"), "amount": r.get("amount"),
            "main_net": r.get("main_net"), "main_net_pct": r.get("main_net_pct"),
            # 两套分数并列：前端按哪一列排序由用户决定，但标签写清楚
            "score": score, "score_light": light["score"], "score_parts": parts,
            "advice": advice["label"], "advice_tone": advice["tone"],
            "fund_score": fund["score"], "fund_parts": fund["parts"],
            "pe": r.get("pe"), "pb": r.get("pb"), "roe": r.get("roe"),
            "rev_yoy": r.get("rev_yoy"), "np_yoy": r.get("np_yoy"),
            "gross": r.get("gross"), "debt": r.get("debt"),
            "market_cap": r.get("market_cap"), "float_cap": r.get("float_cap"),
            "volume_ratio": r.get("volume_ratio"),
            "is_st": "ST" in (r.get("name") or "").upper() or "退" in (r.get("name") or ""),
            "has_tech": has_tech, "has_detail": code in has_detail,
        })
    rows.sort(key=lambda x: (-(x["score"] if x["score"] is not None else -1),
                             -(x["score_light"] or 0)))
    return {
        "trade_date": day.isoformat(),
        "count": len(rows),
        "rows": rows,
        "columns": ["精算分", "快评分", "代码", "名称", "行业", "现价", "涨跌幅", "换手率",
                    "主力净额", "基本面分", "PE", "PB", "ROE", "净利同比", "建议"],
        "scored_count": sum(1 for x in rows if x["has_tech"]),
        "note": ("**覆盖全部 A 股**（不设任何前置过滤，ST/高价/各板块都在里面）。"
                 "「精算分」= 技术32+资金24+筹码18+机构16+板块10−风险，只有当日精算池有；"
                 "「快评分」= 基本面45+资金35+板块情绪20，全市场都有、不含技术面。"
                 "两者口径不同，不要直接互相比大小。"),
        "missing": MISSING,
    }


def _screen_payload(scored: list[dict], funnel: dict, top: list[str], day: date,
                    market_score: float, has_detail: set[str] | None = None,
                    universe_rows: list[dict] | None = None) -> dict:
    """
    筛选表。

    用户要求："筛选的时候 5000 家都要能筛到，但做评分/筛选时不要只挑一小撮出来。"
    所以：`rows` = **全市场**（有精算分的用精算分，没有的用快评分），
         `scored_rows` = 当日真正做了技术面精算的那批（保留细节字段，供"只看精算"用）。
    每个精算行的 is_top / risks / c1..c4 / 筹码等字段照旧，页面按列显示即可。
    """
    # 1) 精算明细（有技术面），按代码索引，便于合并进全市场
    detail = {}
    for s in scored:
        f = s["features"]
        detail[s["code"]] = {
            "code": s["code"], "name": s["name"], "industry": s["industry"],
            "price": s["price"], "change_pct": s["change_pct"], "turnover": s["turnover"],
            "amount": s["amount"], "main_net": s["main_net"], "main_net_pct": s["main_net_pct"],
            "score": s["score"]["score"], "score_light": None,
            "score_parts": s["score"]["parts"], "risks": s["score"]["risks"],
            "c1": f.get("c1"), "c2": f.get("c2"), "c3": f.get("c3"), "c4": f.get("c4"),
            "profit_ratio": f.get("profit_ratio"),
            "trapped_ratio": (s["chip"] or {}).get("trapped_ratio_pct"),
            "avg_cost": (s["chip"] or {}).get("avg_cost"),
            "chip_shape": (s["chip"] or {}).get("shape"),
            "rating": (s.get("inst", {}).get("rating") or {}).get("stance"),
            "rating_orgs": (s.get("inst", {}).get("rating") or {}).get("org_num"),
            "upside_pct": s.get("inst", {}).get("upside_pct"),
            "survey_orgs": s.get("inst", {}).get("survey_orgs"),
            "advice": (s.get("advice") or {}).get("label"),
            "advice_tone": (s.get("advice") or {}).get("tone"),
            "fund_score": (s.get("fund") or {}).get("score"),
            "is_top": s["code"] in top,
            "has_tech": True,
            "has_detail": (s["code"] in has_detail) if has_detail is not None else True,
        }

    # 2) 全市场：优先用 universe 已经算好的行（避免重复算两遍分数）
    rows = []
    for u in (universe_rows or []):
        code = u["code"]
        d = detail.get(code)
        if d:
            rows.append(d)
            continue
        rows.append({
            "code": code, "name": u.get("name"), "industry": u.get("industry"),
            "price": u.get("price"), "change_pct": u.get("change_pct"),
            "turnover": u.get("turnover"), "amount": u.get("amount"),
            "main_net": u.get("main_net"), "main_net_pct": u.get("main_net_pct"),
            "score": None, "score_light": u.get("score_light"),
            "score_parts": u.get("score_parts"), "risks": [],
            "advice": u.get("advice"), "advice_tone": u.get("advice_tone"),
            "fund_score": u.get("fund_score"),
            "is_top": False, "has_tech": False, "has_detail": u.get("has_detail", False),
        })
    if not rows:            # 兜底：没传 universe 时退回"只有精算行"
        rows = list(detail.values())

    rows.sort(key=lambda x: (-(x["score"] if x["score"] is not None else -1),
                             -(x["score_light"] or 0)))
    return {
        "trade_date": day.isoformat(),
        "market_score": market_score,
        "funnel": funnel,
        "top_n": len(top),
        "top": top,
        "rows": rows,                                   # ← 全市场
        "scored_count": len(detail),                     # ← 其中做了技术面精算的只数
        "columns": ["精算分", "快评分", "代码", "名称", "行业", "现价", "涨跌幅", "换手率",
                    "主力净额", "主力净占比", "获利盘估算", "套牢盘估算", "机构评级",
                    "目标价空间", "调研机构", "C1", "C2", "C3", "C4", "风险"],
        "note": ("表格覆盖**全部 A 股**：有技术面精算的显示「精算分」（技术32+资金24+筹码18+"
                 "机构16+板块10−风险），其余显示「快评分」（基本面45+资金35+板块情绪20，不含技术面）。"
                 "两列口径不同，排序时请认准自己点的那一列；想看全部指标可以点进个股，"
                 "浏览器会实时取日线补齐技术面与筹码。"),
        "missing": MISSING,
    }


def _basic_block(row: dict | None) -> dict:
    """
    个股基本面一栏（用户要求"市盈率/换手率/量比/流通市值都要列出来"）。

    全部取自**当天快照**里已经抓到的字段（clist 一次请求就带回来了），
    所以不增加任何请求。拿不到的写 None → 页面显示"数据缺失"。

    ⚠️ 市占率（营收占行业比例）**没有免费来源**，这里明确置 None，
       页面上单独写"无免费数据源"，不猜、不编。
    """
    r = row or {}
    def g(k):
        v = r.get(k)
        return v if isinstance(v, (int, float)) else None
    def yi(v):                       # 元 → 亿元（保留 2 位）
        return None if v is None else round(v / 1e8, 2)
    return {
        "pe": g("pe"), "pe_ttm": g("pe_ttm"), "pb": g("pb"), "ps": g("ps"),
        "market_cap_yi": yi(g("market_cap")), "float_cap_yi": yi(g("float_cap")),
        "turnover": g("turnover"), "volume_ratio": g("volume_ratio"),
        "roe": g("roe"), "rev_yoy": g("rev_yoy"), "np_yoy": g("np_yoy"),
        "gross": g("gross"), "debt": g("debt"),
        "amount_yi": yi(g("amount")),
        "main_net_yi": yi(g("main_net")), "main_net_pct": g("main_net_pct"),
        "market_share": None,        # 市占率：无免费数据源（页面会写明）
    }


def _stock_payload(s: dict, day: date, row: dict | None = None,
                   fin: list[dict] | None = None, comm: dict | None = None) -> dict:
    chip = s.get("chip") or {}
    return {
        "ok": True,
        "code": s["code"], "name": s["name"], "industry": s["industry"],
        "concept": s.get("concept", ""),
        "price": s["price"], "change_pct": s["change_pct"],
        "date": day.isoformat(),
        "kline": _kline_payload(s.get("_bars") or []),
        "trend": s.get("trend") or {},
        "chip": {"is_estimate": True, "shape": chip.get("shape"),
                 "profit_ratio_pct": chip.get("profit_ratio_pct"),
                 "trapped_ratio_pct": chip.get("trapped_ratio_pct"),
                 "avg_cost": chip.get("avg_cost"), "hhi": chip.get("hhi"),
                 "top10_band": chip.get("top10_band"), "peaks": chip.get("peaks"),
                 "valleys": chip.get("valleys"), "rows": chip.get("rows"),
                 "note": chip.get("note")},
        "flow": {"主力净流入(万元)": _wan(s.get("main_net")),
                 "主力净占比%": s.get("main_net_pct")},
        # 用户要求的两块：基本面明细 + 近几年盈利状况
        "basic": _basic_block(row),
        "fin_history": fin or [],
        # 规则化点评（前端只显示文字，不做任何计算/调用）
        "commentary": comm or None,
        "market_share_note": "市占率（营收占行业比例）没有任何免费数据源，本工具不提供、也不估算。",
        "score": s.get("score"),
        "fund": s.get("fund"),
        "advice": s.get("advice"),
        "inst": s.get("inst"),
        "sources": {"行情/K线": "同花顺官方（有 Key 时）或东方财富 push2his",
                    "资金/行业": "东方财富 push2",
                    "机构调研/研报/评级": "东方财富公开接口",
                    "筹码/获利盘": "本工具模型估算（非官方）"},
    }


def _wan(v) -> float | None:
    return None if v is None else round(float(v) / 1e4, 2)


def _write_version(out_dir: str, day: date, report: dict, t0: float,
                   extra: dict | None = None) -> int:
    now = now_cn()
    slots = ["16:00", "18:00", "20:00"]
    passed = [s for s in slots if now.strftime("%H:%M") >= s]
    payload = {
        "trade_date": day.isoformat(),
        "generated_at": now.strftime("%Y-%m-%d %H:%M"),
        "slot": passed[-1] if passed else "盘前",
        "slots": slots,
        "scored": report.get("scored", 0),
        "top": report.get("top", []),
        "elapsed_s": round(time.time() - t0, 1),
        "sources": src.describe_sources(),
        "missing": MISSING,
        # 时点存档：**必须写进产物**，不能只打在日志里。
        #   · as_of：本轮"消息类数据"的截止时刻（防未来函数的基准）
        #   · post_close_snapshot：这份快照是不是收盘价（盘中手动跑就是 false）
        #   · snapshot_quote_time：行情自己的时间戳（归档日期就是按它定的）
        #   · date_from_quotes：归档日期与"今天"不同（周末/节假日跑到上一交易日的数据）
        # 页面上会把 post_close_snapshot=false 明确显示出来，避免把盘中价当收盘价用。
        "as_of": report.get("as_of"),
        "post_close_snapshot": report.get("post_close_snapshot"),
        "snapshot_quote_time": report.get("snapshot_quote_time"),
        "date_from_quotes": report.get("date_from_quotes", False),
        "scoring_version": scoring.SCORING_VERSION,
        "disclaimer": ("本工具仅供个人复盘研究，不构成投资建议；免费接口数据可能有延迟，"
                       "请勿用于实盘高频交易。"),
    }
    if extra:
        payload.update(extra)
    return write_json(os.path.join(out_dir, "version.json"), payload)


def main() -> int:
    ap = argparse.ArgumentParser(description="抓取 A 股盘后数据并生成静态 JSON")
    ap.add_argument("--out", default="docs/data", help="输出目录（默认 docs/data）")
    ap.add_argument("--research-only", action="store_true", help="只刷新机构调研/研报")
    #: `--repair`：**只补缺失**，不重抓全市场。
    #: 用途：上一轮某一项被限流没拿到（比如板块 K 线），主流程跑完后再补一次。
    #: ⚠️ 目前它与正常流程共用同一套补抓逻辑（跑完主流程后自动补），
    #:    这个开关是留给 CI 的"第二轮轻量补抓"用的：先看 health.json 有没有缺，
    #:    有缺才跑，没有就直接跳过（省时间）。
    ap.add_argument("--repair", action="store_true",
                    help="只对上一轮 health.json 里缺的项做定向补抓（缺口为空则立即退出）")
    ap.add_argument("--top", type=int, default=TOP_N, help="每日高评分只数（10~15）")
    ap.add_argument("--max-candidates", type=int, default=MAX_CANDIDATES)
    args = ap.parse_args()
    if args.repair and not _has_missing(args.out):
        print("上一轮 health.json 没有缺失项，无需补抓。")
        return 0
    report = run(args.out, research_only=args.research_only, top_n=args.top,
                 max_candidates=args.max_candidates)
    print(f"\n完成：交易日 {report['trade_date']}，Top: {' '.join(report.get('top') or [])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
