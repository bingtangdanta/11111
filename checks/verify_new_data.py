"""verify_new_data.py — 核对本轮新增的数据结构（可搜索库 / 评分 / 基本面 / 多空建议）。"""

from __future__ import annotations

import json
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


d = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "_demo2/data")
print("=" * 78)
print(f"新数据结构核对：{d}")
print("=" * 78)

u = json.loads((d / "universe.json").read_text(encoding="utf-8"))
rows = u.get("rows") or []
note(u.get("count", 0) > 1000, "可搜索库覆盖全市场（>1000 只）", f"{u.get('count')} 只")
note(u.get("scored_count", 0) > 0, "其中带技术面的只数", str(u.get("scored_count")))
required = ["code", "name", "industry", "price", "change_pct", "turnover", "main_net",
            "score", "advice", "advice_tone", "fund_score", "pe", "pb", "roe", "np_yoy",
            "has_tech", "has_detail"]
missing = [k for k in required if k not in rows[0]]
note(not missing, "每行字段齐备", f"缺 {missing}" if missing else f"{len(required)} 项")
note(all(r.get("advice") for r in rows), "每只都有多空建议")
tone_ok = all(r.get("advice_tone") in ("up", "down", "flat") for r in rows)
note(tone_ok, "建议带颜色标记（up/down/flat）")
with_fund = [r for r in rows if (r.get("fund_score") or 0) > 0]
note(len(with_fund) > len(rows) * 0.5, "多数股票能算出基本面分",
     f"{len(with_fund)}/{len(rows)}")

# 排序：按评分从高到低
scores = [r["score"] for r in rows]
note(all(scores[i] >= scores[i + 1] for i in range(len(scores) - 1)), "可搜索库按评分降序")
print()
print("  样例（前 5）：")
for r in rows[:5]:
    print(f"    {r['code']} {r['name'][:6]:8} 评分 {r['score']:5} 基本面 {r['fund_score']:5} "
          f"PE {r['pe']} ROE {r['roe']} → {r['advice']}")

# 个股详情里的评分/基本面/建议
s = json.loads((d / "screen.json").read_text(encoding="utf-8"))
top = (s.get("top") or [None])[0]
if top:
    st = json.loads((d / "stock" / f"{top}.json").read_text(encoding="utf-8"))
    note("score" in st, "个股详情含完整评分")
    note("fund" in st, "个股详情含基本面分")
    note("advice" in st, "个股详情含多空建议")
    adv = st.get("advice") or {}
    print()
    print(f"  {top} 建议:", json.dumps(adv, ensure_ascii=False)[:220])

# 筹码：平均成本可算
if top:
    chip = st.get("chip") or {}
    rows_chip = chip.get("rows") or []
    total = sum(x["share"] for x in rows_chip)
    if total:
        avg = sum(x["price"] * x["share"] for x in rows_chip) / total
        note(abs(avg - (chip.get("avg_cost") or 0)) < max(0.05, avg * 0.02),
             "前端算的平均筹码 ≈ 后端 avg_cost",
             f"前端 {avg:.3f} vs 后端 {chip.get('avg_cost')}")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
