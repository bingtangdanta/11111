"""factor_ic_test.py — 因子有效性检验的测试（离线，构造因子快照）

要钉死的四件事（每一条都对应一次"如果不这么做就会出错"的教训）：
    ① **RankIC 算得对**：用一个"因子与收益完全同序"的数据，IC 必须 = 1；
       完全反序必须 = −1；随机小样本必须返回 None（不给数）；
    ② **绝不用未来数据**：只有"后面的交易日已经存在"时才回填未来收益；
       少一份快照就不许算；
    ③ **样本不足不许调权**：只有 3 个交易日时，权重必须原样不动；
    ④ **降权有阶梯也有地板**：连续为负才逐步降，永远不低于名义权重的 30%，
       而且"下线"要标注等待人工确认。
"""

from __future__ import annotations

import json
import math
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import factor_ic as fi    # noqa: E402

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


print("=" * 78)
print("① RankIC 的正确性（手算对照）")
print("=" * 78)
n = 40
# 因子与未来收益完全同序 → Spearman = 1
same = [(float(i), float(i) * 0.5) for i in range(n)]
note(fi.rank_ic(same) == 1.0, "完全同序 → RankIC = 1", str(fi.rank_ic(same)))
rev = [(float(i), -float(i)) for i in range(n)]
note(fi.rank_ic(rev) == -1.0, "完全反序 → RankIC = −1", str(fi.rank_ic(rev)))
# 有并列值时的平均秩（用最小复现手算验证）
note(fi._rank([10, 20, 20, 30]) == [1.0, 2.5, 2.5, 4.0], "并列值取平均秩（手算对照）",
     str(fi._rank([10, 20, 20, 30])))
note(fi.rank_ic([(1.0, 1.0)] * 5) is None, "样本太少 → None（不给一个假 IC）")
note(fi.rank_ic([]) is None, "空输入 → None")
# 噪声数据的 IC 应该在 0 附近（不能出现"随便什么都有 IC"）
import random    # noqa: E402
random.seed(7)
noise = [(random.random(), random.random()) for _ in range(200)]
note(abs(fi.rank_ic(noise)) < 0.2, "纯噪声的 |IC| < 0.2（没有系统性偏差）", str(fi.rank_ic(noise)))

print()
print("=" * 78)
print("② ICIR 与分组收益")
print("=" * 78)
note(fi.icir([0.1] * 10) is None, "IC 全相同 → 标准差 0 → 不编 ICIR（返回 None）")
note(abs(fi.icir([0.1, 0.12, 0.08, 0.11, 0.09]) or 0) > 3, "稳定为正的 IC → ICIR 数值较大",
     str(fi.icir([0.1, 0.12, 0.08, 0.11, 0.09])))
note(fi.icir([0.1, 0.2]) is None, "样本 < 5 天 → 不给 ICIR")
pairs = [(float(100 - i), float(i)) for i in range(50)]      # 因子越小、收益越高
g = fi.group_returns(pairs, groups=5)
note(len(g) == 5 and g[0]["avg_ret"] < g[-1]["avg_ret"],
     "分组收益：第 1 档（因子值最高）收益最低 → 说明这是反向因子", 
     f"第1档 {g[0]['avg_ret']} / 第5档 {g[-1]['avg_ret']}")
note(fi.group_returns([(1.0, 1.0)] * 3) == [], "样本太少 → 不给分组收益（留空）")

print()
print("=" * 78)
print("③ 快照与未来收益：只用后面的快照回填（不许看未来）")
print("=" * 78)
tmp = Path(tempfile.mkdtemp())
out = str(tmp)


def snap(day: str, closes: dict[str, float], factor: dict[str, float]) -> None:
    rows = [{"code": c, "name": c, "close": v,
             **{k: (factor.get(c) if k == "ret_20d" else None) for k in fi.FACTOR_KEYS}}
            for c, v in closes.items()]
    payload = {"date": day, "count": len(rows), "factors": fi.FACTOR_KEYS, "rows": rows}
    (tmp / "factors").mkdir(parents=True, exist_ok=True)
    (tmp / "factors" / f"{day}.json").write_text(json.dumps(payload, ensure_ascii=False),
                                                 encoding="utf-8")


codes = [f"6000{i:02d}" for i in range(40)]
# 第 1 天：因子值 = 序号；第 2 天：收益也与序号同序 → IC 应为 1
f1 = {c: float(i) for i, c in enumerate(codes)}
c1 = {c: 10.0 for c in codes}
c2 = {c: 10.0 * (1 + (i - 20) / 200.0) for i, c in enumerate(codes)}
snap("2026-09-10", c1, f1)
snap("2026-09-11", c2, f1)

ic = fi.forward_returns(out, today="2026-09-11", horizons=(1, 5))
note(ic["sample_dates"] == 2, "读到 2 份快照", str(ic["sample_dates"]))
note(ic["days"][0]["horizons"].get("1", {}).get("ret_20d") == 1.0,
     "第 1 天回填出了 IC = 1（相邻快照算收益）",
     str(ic["days"][0]["horizons"].get("1", {}).get("ret_20d")))
note("5" not in ic["days"][0]["horizons"],
     "只有 2 份快照时**算不出** 5 日收益 → 不许提前算（这就是防未来数据）")
note(ic["samples"]["ret_20d"] == 1, "有效样本天数 = 1", str(ic["samples"]["ret_20d"]))

print()
print("=" * 78)
print("④ 样本不足 → 绝不调权")
print("=" * 78)
h = fi.factor_health(ic)
note(h["ready"] is False, f"只有 2 个交易日 < {fi.MIN_DAYS} → 不 ready")
note(all(v["factor"] == 1.0 for v in h["factors"].values()),
     "所有因子权重系数都还是 1.0（一个都没动）")
note("样本不足" in h["factors"]["ret_20d"]["action"], "状态里写明样本不足",
     h["factors"]["ret_20d"]["action"])
ov = fi.weights_override(h)
note(ov["applied"] is False, "weights_override.applied = False（scoring 会按原权重走）")

print()
print("=" * 78)
print("⑤ 样本够了以后：阶梯降权 + 地板 + 下线要人工确认")
print("=" * 78)
# 构造 40 个交易日、IC 恒为负的"IC 历史"
neg_series = {"ret_20d": [{"date": f"2026-08-{i + 1:02d}", "ic_1d": -0.15} for i in range(30)]}
for k in fi.FACTOR_KEYS:
    neg_series.setdefault(k, [{"date": f"2026-08-{i + 1:02d}", "ic_1d": 0.05} for i in range(30)])
ic_neg = {"series": neg_series, "samples": {k: 30 for k in fi.FACTOR_KEYS},
          "sample_dates": 30, "days": [], "groups": {}}
h2 = fi.factor_health(ic_neg)
note(h2["ready"] is True, "30 个交易日 ≥ 20 → ready")
note(h2["factors"]["ret_20d"]["ic_mean"] < 0, "算出近 20 日 IC 均值为负",
     str(h2["factors"]["ret_20d"]["ic_mean"]))
note(h2["factors"]["ret_20d"]["factor"] == fi.WEIGHT_STEP1, "第一次为负 → ×0.7",
     str(h2["factors"]["ret_20d"]["factor"]))
note(h2["factors"]["ret_20d"]["neg_streak"] == 1, "连续为负计数 = 1",
     str(h2["factors"]["ret_20d"]["neg_streak"]))
note(h2["factors"]["main_net_ratio"]["factor"] == 1.0, "IC 为正的因子不动",
     str(h2["factors"]["main_net_ratio"]["factor"]))

# 连续为负的计数要**跨轮累积**（存进 weights_override 再带回来）
streak = {k: 0 for k in fi.FACTOR_KEYS}
streak["ret_20d"] = 3
h3 = fi.factor_health(ic_neg, extra_series={"neg_streak": streak})
note(h3["factors"]["ret_20d"]["neg_streak"] == 4, "跨轮累积：3 + 1 = 4",
     str(h3["factors"]["ret_20d"]["neg_streak"]))
note(h3["factors"]["ret_20d"]["factor"] == fi.WEIGHT_STEP2, "连续 4 次为负 → ×0.5",
     str(h3["factors"]["ret_20d"]["factor"]))
streak["ret_20d"] = fi.NEG_STREAK_OFF - 1
h4 = fi.factor_health(ic_neg, extra_series={"neg_streak": streak})
note(h4["factors"]["ret_20d"]["factor"] == 0.0, "连续 6 次为负 → 权重 0（下线）")
note("人工确认" in h4["factors"]["ret_20d"]["action"], "下线时必须标注等待人工确认",
     h4["factors"]["ret_20d"]["action"])

ov2 = fi.weights_override(h4)
note(ov2["dimensions"]["trend"] == fi.WEIGHT_FLOOR,
     f"维度倍率有地板（trend 被限到 {fi.WEIGHT_FLOOR}，不会归零）",
     str(ov2["dimensions"]))
note(ov2["applied"] is True and ov2["reasons"],
     "样本足够且确有降权 → applied=True，并给出人话原因", str(ov2["reasons"][:1]))
note(all(v >= fi.WEIGHT_FLOOR for v in ov2["dimensions"].values()),
     "所有维度倍率都不低于地板", str(ov2["dimensions"]))
note("neg_streak" in ov2, "连续计数被带出去（下一轮读回来继续累积）",
     str(ov2["neg_streak"]["ret_20d"]))

print()
print("=" * 78)
print("⑥ 快照读写：原始因子值（不是加权后的分数）")
print("=" * 78)
scored = [{"code": "600519", "name": "贵州茅台", "_bars": [{"close": 1700.0}],
           "features": {"ret_20d": 3.5, "main_net_ratio": 1.2, "daily_bull": True,
                        "hhi": None, "买不到的东西": 1}}]
n2 = fi.save_snapshot(out, "2026-09-12", scored)
loaded = fi.load_snapshot(out, "2026-09-12")
note(n2 == 1 and loaded["rows"][0]["close"] == 1700.0, "存了收盘价（回填收益要用）")
note(loaded["rows"][0]["ret_20d"] == 3.5 and loaded["rows"][0]["hhi"] is None,
     "存的是原始因子值，拿不到的存 None")
note("买不到的东西" not in loaded["rows"][0], "没在清单里的键不会被写进快照")
note(fi.list_snapshots(out) == ["2026-09-10", "2026-09-11", "2026-09-12"],
     "快照按日期排序", str(fi.list_snapshots(out)))
note(fi.load_snapshot(out, "1999-01-01") is None, "读不存在的快照返回 None（不抛异常）")
note(all(k in loaded["factors"] for k in ("ret_20d", "vol_20d", "turnover")),
     "快照里记了因子清单（口径可追溯）")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
