"""regime_test.py — 市场环境判定的测试（离线，构造指数 K 线与历史天数）

要钉住的三件事：
    ① **四个条件必须同时满足**才算单边下跌（一条就喊"清仓"是不可接受的误报）；
    ② **数据不足时不给结论**（不许把"缺数据"硬判成"震荡"）；
    ③ 每个结论都要带**可复核的原始数字**（页面要显示依据，不能只给一句"不宜出手"）。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import regime as rg    # noqa: E402

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


def mk_index(closes: list[float], name: str = "沪深300") -> dict:
    return {rg.BENCH_CODE: {"name": name, "kline": {
        "dates": [f"2026-08-{i % 28 + 1:02d}" for i in range(len(closes))],
        "close": closes, "open": closes, "high": closes, "low": closes,
        "volume": [1e8] * len(closes)}}}


def mk_history(down_flags: list[float]) -> list[dict]:
    """down_flags: 每天的"下跌家数占比"（0~1）"""
    out = []
    for i, r in enumerate(down_flags):
        total = 5000
        down = int(total * r)
        out.append({"date": f"2026-09-{i + 1:02d}", "advancing": total - down,
                    "declining": down, "limit_up": 30, "limit_down": 5})
    return out


def mk_dashboard(adr: float | None) -> dict:
    return {"breadth": {"advancing": 3000, "declining": 2000, "advance_decline_ratio": adr}}


print("=" * 78)
print("① 单边下跌：四个条件同时满足才判定")
print("=" * 78)
# 60 天下跌、均线下行、指数 20 日 −12%
down_closes = [4000 - i * 20 for i in range(60)]
idx = mk_index(down_closes)
hist = mk_history([0.72] * 10)
r = rg.classify(index_kline=idx, dashboard=mk_dashboard(0.45), history_days=hist)
note(r["regime"] == "单边下跌", "慢性下跌 → 判为单边下跌", r["regime"])
note(r["empty_warning"] is True, "触发空仓预警")
note("不宜出手" in r["advice"], "给出「当前市场环境不宜出手」的提示", r["advice"][:40])
ev = r["evidence"]
note(ev["index"] and ev["index"]["above_ma"] is False, "依据里带「指数在均线下方」")
note(ev["index"]["ma_slope_pct"] < 0, "依据里带「均线下行」", f"{ev['index']['ma_slope_pct']}%")
note(ev["down_ratio_median_10d"] > 0.6, "依据里带「近 10 日下跌家数占比中位数」",
     f"{ev['down_ratio_median_10d']:.0%}")
note(ev["index"]["ret_pct"] <= -8, "依据里带「指数 20 日收益」", f"{ev['index']['ret_pct']}%")
note(len(r["reasons"]) >= 4, "四条人话解释逐条给出", f"{len(r['reasons'])} 条")

print()
print("=" * 78)
print("② 只满足三条 → 不许判成单边下跌（防误报）")
print("=" * 78)
# 指数跌了但跌幅不够（−4%），其余三条都满足
mild = [4000 - i * 2 for i in range(60)]        # 20 日约 −1%，60 日缓跌
r2 = rg.classify(index_kline=mk_index(mild), dashboard=mk_dashboard(0.45),
                 history_days=mk_history([0.72] * 10))
note(r2["regime"] != "单边下跌", "跌幅不够 → 不判单边下跌", r2["regime"])
note(r2["empty_warning"] is False, "不触发空仓预警")

# 下跌家数不够（只有 40% 在跌）→ 也不许判
r3 = rg.classify(index_kline=mk_index(down_closes), dashboard=mk_dashboard(1.6),
                 history_days=mk_history([0.40] * 10))
note(r3["regime"] != "单边下跌", "下跌家数不足 → 不判单边下跌", r3["regime"])

print()
print("=" * 78)
print("③ 普涨")
print("=" * 78)
up_closes = [3000 + i * 15 for i in range(60)]
r4 = rg.classify(index_kline=mk_index(up_closes), dashboard=mk_dashboard(2.2),
                 history_days=mk_history([0.25] * 10))
note(r4["regime"] == "普涨", "均线上方 + 涨跌家数比 > 1.5 → 普涨", r4["regime"])
note(r4["empty_warning"] is False, "普涨不触发空仓预警")
note("普涨" in r4["advice"], "给出口径说明", r4["advice"][:30])

print()
print("=" * 78)
print("④ 震荡（默认档）+ 数据不足时不硬判")
print("=" * 78)
flat = [3000 + (i % 3) * 4 - 4 for i in range(60)]
r5 = rg.classify(index_kline=mk_index(flat), dashboard=mk_dashboard(1.05),
                 history_days=mk_history([0.5] * 10))
note(r5["regime"] == "震荡", "既不单边跌也不普涨 → 震荡", r5["regime"])

r6 = rg.classify(index_kline=mk_index([3000, 3010, 3020]), dashboard=mk_dashboard(1.0),
                 history_days=mk_history([0.5]))
note(r6["regime"] == "数据不足", "K 线太少 → 明确说「数据不足」", r6["regime"])
note(r6["empty_warning"] is False, "数据不足时不触发空仓预警（不拿缺数据吓人）")
note("数据不足" in r6["note"], "说明「不给结论」的理由")

r7 = rg.classify(index_kline=mk_index(down_closes), dashboard=mk_dashboard(0.45), history_days=[])
note(r7["regime"] == "数据不足", "没有涨跌家数历史 → 同样说数据不足", r7["regime"])

print()
print("=" * 78)
print("⑤ 工具函数：指数状态与下跌占比")
print("=" * 78)
st = rg.index_state({"close": [100 + i for i in range(30)]})
note(st and st["above_ma"] is True and st["ma_slope_pct"] > 0, "一路上涨 → 站上均线且均线上行")
note(rg.index_state({"close": [100, 101]}) is None, "数据太少 → None（不编默认值）")
note(rg.index_state(None) is None, "传 None 也不炸")
dr = rg.down_ratio_series(mk_history([0.9, 0.8, 0.7]), window=10)
note(dr == [0.9, 0.8, 0.7], "下跌占比序列正确", str(dr))
note(rg.down_ratio_series([], window=10) == [], "空历史返回空（上层据此判数据不足）")
note(rg.down_ratio_series([{"advancing": 0, "declining": 0}]) == [], "全 0 的脏数据跳过")

print()
print("=" * 78)
print("⑥ 阈值可配置（改成你认可的数不用动代码）")
print("=" * 78)
note("thresholds" in r and r["thresholds"]["down_ret_max"] == rg.DOWN_RET_MAX,
     "返回值里带本轮使用的阈值（可复核）", str(r["thresholds"]))

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
