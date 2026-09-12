"""selfcheck_test.py — 决策验证的测试（离线，构造推荐与快照）

这个文件要钉住的是**「什么叫策略失效」这个判断本身**，而不是代码写没写。
用户明确担心过：「标准不明确，自我修复就会变成乱修」。所以逐条验证：

    ① 主口径必须**可执行**：T+1 开盘买入 → T+2 开盘卖出，并扣掉成本；
    ② 不可成交的（一字板）样本**单独列出、不进胜率分母**
       —— 这是 A 股回测最经典的偏差：买不到的收益不能算进胜率；
    ③ 超额收益对沪深300，基准缺失时写 None，**不填 0 冒充**；
    ④ 评级四态：良好 / 衰减 / 失效 / **样本不足**（样本不足时绝不说「良好」）；
    ⑤ 连续 N 次衰减能升级成「失效」，且计数**跨轮累积**；
    ⑥ 顶部横幅 + 「统一降级为观望」的联动（只提示，不下单）；
    ⑦ 错过采集窗口时**不硬凑**，如实写明并退回对照口径。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import selfcheck as sc    # noqa: E402

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05",
        "2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11", "2026-09-12"]


def snap(**kw) -> dict:
    """构造某天快照里的 (开, 高, 低, 昨收)"""
    return {code: {"open": v[0], "high": v[1], "low": v[2], "prev_close": v[3]}
            for code, v in kw.items()}


def period(date: str, codes: list[str], close: float = 10.0) -> dict:
    return {"date": date,
            "picks": [{"code": c, "name": c, "score": 80.0, "close": close} for c in codes]}


def fake_rolling(**kw) -> dict:
    base = {"window": 10, "periods_used": 10, "picks": 120, "untradable": 0,
            "win_rate": 55.0, "avg_net": 2.0, "avg_excess": 1.5, "bench_available": True,
            "cost_bp": 20.0, "periods_dates": []}
    base.update(kw)
    return base


print("=" * 78)
print("① 主口径：T+1 开盘买入 → T+2 开盘卖出（可执行），并扣成本")
print("=" * 78)
p0 = period("2026-09-10", ["600519", "000001"])
t1 = sc.track_picks([p0], snap(**{"600519": (10.0, 10.8, 9.9, 9.5),
                                  "000001": (10.0, 10.2, 9.8, 9.9)}),
                    days=DAYS, today="2026-09-11")
note(t1[0]["entry_date"] == "2026-09-11", "T+1 记下了买入日", str(t1[0].get("entry_date")))
note(t1[0]["picks"][0]["entry_open"] == 10.0, "买入价 = T+1 **开盘**价（不是收盘价）")
note(t1[0].get("done") is not True, "T+1 当天还不能算收益（要等 T+2）")

t2 = sc.track_picks([p0], snap(**{"600519": (11.0, 11.2, 10.9, 10.8),
                                  "000001": (11.0, 11.1, 10.9, 10.2)}),
                    days=DAYS, today="2026-09-12", prev_periods=t1)
x0 = t2[0]["picks"][0]
note(t2[0]["done"] is True, "T+2 完成回评")
note(x0["entry_open"] == 10.0 and x0["exit_open"] == 11.0,
     "买入价跨轮继承（没丢）", f"{x0['entry_open']} → {x0['exit_open']}")
note(x0["gross_pct"] == 10.0, "毛收益 +10%", str(x0["gross_pct"]))
note(x0["net_pct"] == 9.8, f"净收益 = 毛收益 − {sc.COST_BP:.0f}bp = 9.8%", str(x0["net_pct"]))
note(t2[0]["basis_used"] == "open_to_open", "标明用的是主口径（可执行）")

print()
print("=" * 78)
print("② 一字板：买不进的样本必须单列，且不进胜率分母")
print("=" * 78)
p1 = period("2026-09-10", ["600519", "000001"])
t1b = sc.track_picks([p1], snap(**{"600519": (11.0, 11.0, 11.0, 10.0),   # 一字涨停
                                   "000001": (10.0, 10.5, 9.9, 9.9)}),
                     days=DAYS, today="2026-09-11")
u = t1b[0]["picks"][0]
note(u["untradable"] is True, "一字涨停样本被标记 untradable")
note("买不进" in u["why"], "原因写清楚（买不进，而不是笼统说无效）", u["why"])
t2b = sc.track_picks([p1], snap(**{"600519": (12.0, 12.0, 12.0, 11.0),
                                   "000001": (10.5, 10.6, 10.4, 10.0)}),
                     days=DAYS, today="2026-09-12", prev_periods=t1b)
roll = sc.summarize(t2b)
note(roll["untradable"] == 1, "汇总里把不可成交样本**单列**", str(roll["untradable"]))
note(roll["picks"] == 1, "胜率分母只算能成交的那 1 只（不是 2 只）", str(roll["picks"]))
full = sc.build(day="2026-09-12", periods=t2b, index_kline={}, dashboard={}, history_days=[])
note("untradable" in full["basis"]["tradability"], "产物里写明这条口径")

print()
print("=" * 78)
print("③ 超额收益：对沪深300；基准缺失时不填 0")
print("=" * 78)
bench = {"2026-09-11": 4000.0, "2026-09-12": 4040.0}      # 基准 +1.0%
t2c = sc.track_picks([p1], snap(**{"600519": (11.0, 11.2, 10.9, 10.8),
                                   "000001": (11.0, 11.1, 10.9, 10.2)}),
                     days=DAYS, today="2026-09-12", bench=bench, prev_periods=t1)
note(t2c[0]["picks"][0]["bench_pct"] == 1.0, "基准涨跌幅算对（+1.0%）",
     str(t2c[0]["picks"][0]["bench_pct"]))
note(t2c[0]["picks"][0]["excess_pct"] == 8.8, "超额 = 净收益 9.8% − 基准 1.0% = 8.8%",
     str(t2c[0]["picks"][0]["excess_pct"]))
t2d = sc.track_picks([p1], snap(**{"600519": (11.0, 11.2, 10.9, 10.8),
                                   "000001": (11.0, 11.1, 10.9, 10.2)}),
                     days=DAYS, today="2026-09-12", bench=None, prev_periods=t1)
note(t2d[0]["picks"][0]["bench_pct"] is None, "拿不到基准 → 写 None（不填 0 冒充）")
note(sc.summarize(t2d)["bench_available"] is False, "汇总里标明基准不可用")

print()
print("=" * 78)
print("④ 评级四态：样本不足绝不说「良好」")
print("=" * 78)
r0 = sc.rate(sc.summarize([]))
note(r0["level"] == "样本不足", "没有任何样本 → 样本不足（不是良好）", r0["level"])
note("需要" in r0["reasons"][0], "说明还差多少样本", r0["reasons"][0])
note(sc.rate(fake_rolling())["level"] == "良好", "超额 +1.5%、胜率 55% → 良好")
note(sc.rate(fake_rolling(avg_excess=-3.5))["level"] == "衰减", "超额 −3.5% ≤ −3% → 衰减")
note(sc.rate(fake_rolling(win_rate=40.0))["level"] == "衰减", "胜率 40% < 45% → 衰减")
note(sc.rate(fake_rolling(avg_excess=-7.0))["level"] == "失效", "超额 −7% ≤ −6% → 直接失效")
note(sc.rate(fake_rolling(periods_used=3))["level"] == "样本不足",
     "只完成 3 期 → 样本不足（哪怕涨幅很好）")
note(sc.rate(fake_rolling(picks=12))["level"] == "样本不足", "样本只 12 个 → 样本不足")
r_decay = sc.rate(fake_rolling(avg_excess=-4.0))
note(r_decay["decay_streak"] == 1, "衰减计数 = 1", str(r_decay["decay_streak"]))
note(sc.rate(fake_rolling(avg_excess=-4.0), decay_streak=2)["level"] == "失效",
     "连续第 3 次衰减 → 升级为失效")
note(sc.rate(fake_rolling(avg_excess=1.0), decay_streak=5)["decay_streak"] == 0,
     "恢复正常后连续计数清零")

print()
print("=" * 78)
print("⑤ 顶部横幅 + 统一降级为观望（只提示，不下单）")
print("=" * 78)
reg_down = {"empty_warning": True, "regime": "单边下跌",
            "advice": "空仓预警：当前市场环境不宜出手（单边下跌）。"}
b = sc.banners({"level": "失效", "reasons": ["滚动超额收益 -7% <= -6%"]}, reg_down, fake_rolling())
note(len(b) == 2, "空仓预警 + 策略失效 → 两条横幅", str(len(b)))
note(b[0]["level"] == "danger" and "空仓预警" in b[0]["text"], "最严重的排最前", b[0]["text"][:26])
note("轻仓观望" in b[1]["text"], "横幅明确写出「建议轻仓观望」", b[1]["text"][:40])
b2 = sc.banners({"level": "衰减", "reasons": ["滚动胜率 40% < 45%"]},
                {"empty_warning": False}, fake_rolling())
note(b2[0]["level"] == "warn" and "胜率下降" in b2[0]["text"], "衰减用 warn 级",
     b2[0]["text"][:30])
b3 = sc.banners({"level": "样本不足", "reasons": ["样本不够"]}, {"empty_warning": False},
                sc.summarize([]))
note(b3[0]["level"] == "info" and "样本不足" in b3[0]["text"], "样本不足时如实说明",
     b3[0]["text"][:36])
note(not sc.banners({"level": "良好", "reasons": []}, {"empty_warning": False}, fake_rolling()),
     "一切正常时**不显示**横幅（不制造噪音）")
adv = sc.advice_override({"level": "失效"}, {"empty_warning": False})
note(adv["active"] and adv["label"] == "观望", "失效 → 建议统一降为观望")
note(sc.advice_override({"level": "良好"}, reg_down)["label"] == "观望",
     "空仓预警优先于评级（市场不行时一律观望）")
note(sc.advice_override({"level": "良好"}, {})["active"] is False, "正常时不做任何降级")

print()
print("=" * 78)
print("⑥ 错过采集窗口：不硬凑，如实写明并退回对照口径")
print("=" * 78)
t_miss = sc.track_picks([period("2026-09-10", ["600519"])],
                        snap(**{"600519": (10.0, 10.5, 9.9, 9.9)}),
                        days=DAYS, today="2026-09-12", prev_periods=None)
note(t_miss[0].get("basis_used") == "close_to_close",
     "没有买入价（中间漏跑）→ 退回对照口径，不硬算收益")
note("错过采集窗口" in str(t_miss[0].get("status")), "状态里写明原因",
     str(t_miss[0].get("status")))
note(sc.summarize(t_miss)["picks"] == 0,
     "退回对照口径的期数**不进**主口径统计（否则数字会串）")

print()
print("=" * 78)
print("⑦ 综合产物：连续跑输 → 失效 + 空仓预警（一次完整 build）")
print("=" * 78)
# 先验证一个真实的"亏损周期"（走 track_picks，端到端）
codes = [f"6000{i:02d}" for i in range(40)]
p_loss = period("2026-09-10", codes)
tA = sc.track_picks([p_loss], snap(**{c: (10.0, 10.1, 9.9, 10.0) for c in codes}),
                    days=DAYS, today="2026-09-11")
tB = sc.track_picks([p_loss], snap(**{c: (9.5, 9.6, 9.4, 10.0) for c in codes}),
                    days=DAYS, today="2026-09-12", bench=bench, prev_periods=tA)
roll_loss = sc.summarize(tB)
note(roll_loss["picks"] == 40, "40 个样本都算出来了", str(roll_loss["picks"]))
note(roll_loss["avg_net"] is not None and roll_loss["avg_net"] < 0,
     "平均净收益为负（跌 5% 再扣成本）", str(roll_loss["avg_net"]))
note(roll_loss["avg_excess"] is not None and roll_loss["avg_excess"] < 0,
     "超额收益为负", str(roll_loss["avg_excess"]))
note(sc.rate(roll_loss)["level"] == "样本不足",
     "只有 1 期 → 仍判「样本不足」（护栏生效：绝不用一天的数据下结论）",
     sc.rate(roll_loss)["level"])

# 再构造 6 期已完成的推荐（每期 40 只、每只净亏 → 直接构造聚合输入，
# 因为要凑够 MIN_PERIODS 期才允许评价；这是**测试夹具**，不是伪造线上数据）
def done_period(date: str, net: float, excess: float) -> dict:
    return {"date": date, "done": True, "basis_used": "open_to_open",
            "entry_date": date, "exit_date": date,
            "picks": [{"code": c, "name": c, "net_pct": net, "excess_pct": excess,
                       "gross_pct": net + sc.COST_BP / 100.0} for c in codes]}


periods6 = [done_period(DAYS[i], -5.0, -6.0) for i in range(6)]
idx = {sc.BENCH_CODE: {"name": "沪深300", "kline": {
    "dates": [f"2026-08-{i + 1:02d}" for i in range(30)],
    "close": [4000 - i * 20 for i in range(30)]}}}          # 30 天持续下跌
dash = {"breadth": {"advancing": 900, "declining": 4000, "advance_decline_ratio": 0.22}}
hist = [{"date": d, "advancing": 900, "declining": 4000} for d in DAYS]
payload = sc.build(day="2026-09-12", periods=periods6, index_kline=idx, dashboard=dash,
                   history_days=hist, factor_ic={"sample_dates": 3},
                   factor_health={"ready": False}, weights_override={"applied": False},
                   health={"summary": {"steps_failed": 0, "repaired": 2, "still_missing": 1}})
for k in ("trade_date", "basis", "periods", "rolling", "rating", "regime",
          "factor_ic", "factor_health", "weights_override", "collect_health",
          "banners", "advice_override", "note"):
    note(k in payload, f"产物含 {k}")
note(payload["rolling"]["periods_used"] == 6 and payload["rolling"]["picks"] == 240,
     "滚动窗口统计正确（6 期 / 240 个样本）",
     f"{payload['rolling']['periods_used']} 期 / {payload['rolling']['picks']} 样本")
note(payload["rating"]["level"] == "失效", "连续跑输 → 评级=失效",
     payload["rating"]["level"])
note(payload["regime"]["regime"] == "单边下跌", "市场环境判定接进来了",
     payload["regime"]["regime"])
note(payload["regime"]["empty_warning"] is True, "单边下跌 → 空仓预警生效")
note(len(payload["banners"]) >= 2 and payload["banners"][0]["level"] == "danger",
     "顶部横幅：空仓预警排第一", payload["banners"][0]["text"][:34])
note(any("策略可能失效" in x["text"] for x in payload["banners"]),
     "横幅里写明「策略可能失效，建议轻仓观望」",
     next((x["text"][:34] for x in payload["banners"] if "失效" in x["text"]), ""))
note(payload["advice_override"]["active"] is True
     and payload["advice_override"]["label"] == "观望", "建议统一降级为观望")
note(payload["collect_health"]["repaired"] == 2, "自愈账本摘要接进来了",
     str(payload["collect_health"]))
note("不能自动下单" in payload["note"], "产物里写明「只提示、不能自动下单」")
note(payload["rating"]["thresholds"]["decay_excess"] == sc.DECAY_EXCESS,
     "阈值随产物一起存（可复核）", str(payload["rating"]["thresholds"]))

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)