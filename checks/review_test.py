"""review_test.py — 历史股评的后端逻辑测试（用假数据跑两轮，验证回填/汇总/淘汰）。

为什么要单独测：这段逻辑跨"两次抓取"，本地很难凑出真实的两个交易日数据，
所以直接把 `_update_stock_review` 当纯函数跑：造第 1 天的选股 → 第 2 天的快照（含涨跌幅）
→ 检查它有没有正确回填、算胜率、并按 keep 淘汰旧期。
"""

from __future__ import annotations

import json
import sys
import tempfile
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import fetch_data as fd   # noqa: E402

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


def scored_of(codes: list[tuple[str, float]]) -> list[dict]:
    return [{"code": c, "name": f"股票{c[-2:]}", "score": {"score": s},
             "bars": [{"date": "2026-01-01", "close": 10.0 + i}],
             "advice": {"label": "偏多"}}
            for i, (c, s) in enumerate(codes)]


tmp = Path(tempfile.mkdtemp(prefix="ashare_review_"))
d1 = date(2026, 9, 7)
d2 = date(2026, 9, 8)
d3 = date(2026, 9, 9)

print("=" * 78)
print("① 第 1 天：记录当日评分最高的 3 只（还没回评）")
print("=" * 78)
r1 = fd._update_stock_review(str(tmp), d1,
                             snapshot=[],                       # 第 1 天没有"昨天的票"要回填
                             scored=scored_of([("600519", 91.2), ("000636", 88.0), ("002415", 85.5)]),
                             top_n=3)
(tmp / "review.json").write_text(json.dumps(r1, ensure_ascii=False), encoding="utf-8")
note(len(r1["periods"]) == 1, "只记了 1 期", f"{len(r1['periods'])} 期")
note(r1["periods"][0]["done"] is False, "第 1 期标记为「待回评」")
note(len(r1["periods"][0]["picks"]) == 3, "记录了 Top 3",
     "、".join(p["code"] for p in r1["periods"][0]["picks"]))
note(r1["periods"][0]["picks"][0]["score"] == 91.2, "带上了评分",
     str(r1["periods"][0]["picks"][0]["score"]))
note(r1["summary"]["periods"] == 0 and r1["summary"]["win_rate"] is None,
     "还没有已回评期数 → 汇总为 0/—")

print()
print("=" * 78)
print("② 第 2 天：用当日快照回填第 1 期的次日涨跌幅")
print("=" * 78)
snap2 = [{"code": "600519", "change_pct": 3.2},
         {"code": "000636", "change_pct": -1.5},
         {"code": "002415", "change_pct": 0.8}]
r2 = fd._update_stock_review(str(tmp), d2, snapshot=snap2,
                             scored=scored_of([("300750", 90.0), ("601318", 87.0)]), top_n=3)
# ⚠️ 必须把每一轮结果写回文件：这个函数是"读文件 → 改 → 返回"的形态，
#    生产环境里每轮抓取结束都会 write_json 落盘（GitHub Actions 再提交）。
#    测试里漏写一次，下一轮就读不到上一期，表现为"往期凭空消失"（这里踩过）。
(tmp / "review.json").write_text(json.dumps(r2, ensure_ascii=False), encoding="utf-8")
p1 = r2["periods"][0]
note(p1["done"] is True, "第 1 期被标记为已回评")
note(p1["next_date"] == d2.isoformat(), "记下了回评日期", str(p1["next_date"]))
note([x["change_pct"] for x in p1["results"]] == [3.2, -1.5, 0.8],
     "涨跌幅逐个回填正确", str([x["change_pct"] for x in p1["results"]]))
note(abs(p1["win_rate"] - 66.7) < 0.1, "该期胜率 2/3 ≈ 66.7%", f"{p1['win_rate']}%")
note(abs(p1["avg_change"] - 0.83) < 0.02, "该期平均涨幅 ≈ +0.83%", f"{p1['avg_change']}%")
note(p1["max_gain"] == 3.2 and p1["max_loss"] == -1.5, "最好/最差正确",
     f"{p1['max_gain']} / {p1['max_loss']}")
note(len(r2["periods"]) == 2, "现在有两期（第 1 期已回评 + 第 2 期待回评）")
note(abs(r2["summary"]["win_rate"] - 66.7) < 0.1 and r2["summary"]["picks"] == 3,
     "汇总只用已回评的数据", f"胜率 {r2['summary']['win_rate']}% / {r2['summary']['picks']} 只")

print()
print("=" * 78)
print("③ 停牌/退市的票不能当 0 混进平均")
print("=" * 78)
r3 = fd._update_stock_review(str(tmp), d3,
                             snapshot=[{"code": "300750", "change_pct": 5.0}],   # 只回了一只
                             scored=scored_of([("600036", 80.0)]), top_n=3)
p2 = [p for p in r3["periods"] if p["date"] == d2.isoformat()][0]
missing = [x for x in p2["results"] if x["change_pct"] is None]
note(len(missing) == 1, "快照里没有的那只标为 null（不当 0）", str([x["code"] for x in missing]))
note("停牌" in (missing[0].get("note") or ""), "并写清原因", str(missing[0].get("note")))
note(abs(p2["avg_change"] - 5.0) < 0.02, "平均值只用真正取到的数据", f"{p2['avg_change']}%")

print()
print("=" * 78)
print("④ 只保留最近 keep 期，旧的自动删除（用户要求「5 天后删掉」）")
print("=" * 78)
tmp2 = Path(tempfile.mkdtemp(prefix="ashare_review_keep_"))
snap_all = [{"code": "600519", "change_pct": 1.0}, {"code": "000636", "change_pct": -1.0}]
cur = date(2026, 8, 3)
last = None
for _ in range(9):                      # 连续 9 个交易日（每轮都要落盘，模拟 Actions 提交）
    last = fd._update_stock_review(str(tmp2), cur, snapshot=snap_all,
                                   scored=scored_of([("600519", 90.0), ("000636", 80.0)]), top_n=2)
    (tmp2 / "review.json").write_text(json.dumps(last, ensure_ascii=False), encoding="utf-8")
    cur = cur + timedelta(days=1)
final = json.loads((tmp2 / "review.json").read_text(encoding="utf-8"))
done = [p for p in final["periods"] if p["done"]]
note(len(done) == final["keep"] == fd.REVIEW_KEEP,
     f"已回评期数被裁到 keep={fd.REVIEW_KEEP} 期", f"{len(done)} 期")
note(final["dropped"] >= 1, "记录了本轮丢掉了几期", str(final["dropped"]))
dates = [p["date"] for p in done]
note(dates == sorted(dates), "保留的是**最近**的几期", f"{dates[0]} → {dates[-1]}")
note(final["summary"]["periods"] == len(done), "汇总期数与保留期数一致")

print()
print("=" * 78)
print("④b 胜率要「一直保留」：明细被删了，累计胜率也不能清零")
print("=" * 78)
life = final.get("lifetime") or {}
note("lifetime" in final, "产物里有 lifetime 累计字段")
note(life.get("periods", 0) > len(done),
     "累计期数 > 明细期数（说明更早的期数被删了但**累计还在**）",
     f"累计 {life.get('periods')} 期 / 明细 {len(done)} 期")
note(life.get("picks") == life.get("periods", 0) * 2,
     "累计样本数 = 累计期数 × 每期只数", f"{life.get('picks')} 只")
# 8 期已回评、每期 2 只、每期 1 赢 1 亏（+1.0% / -1.0%）
note(abs((life.get("win_rate") or 0) - 50.0) < 0.1, "累计胜率 = 50%（8 期 16 只各半）",
     f"{life.get('win_rate')}%")
note(abs((life.get("avg_change") or 0)) < 0.01, "累计平均涨幅 ≈ 0%", f"{life.get('avg_change')}%")
note(life.get("best") == 1.0 and life.get("worst") == -1.0, "累计最好/最差也保留",
     f"{life.get('best')} / {life.get('worst')}")
note(life.get("since") and life.get("last"), "记录统计起止日期",
     f"{life.get('since')} → {life.get('last')}")
# 再跑一天：累计期数必须继续增长（而不是被 5 期上限卡住）
cur = cur + timedelta(days=1)
after = fd._update_stock_review(str(tmp2), cur, snapshot=snap_all,
                                scored=scored_of([("600519", 90.0), ("000636", 80.0)]), top_n=2)
note((after["lifetime"].get("periods") or 0) == (life.get("periods") or 0) + 1,
     "又跑一天 → 累计期数 +1（不受 5 期明细上限影响）",
     f"{life.get('periods')} → {after['lifetime'].get('periods')}")
note(len([p for p in after["periods"] if p["done"]]) <= fd.REVIEW_KEEP,
     "明细仍然只留 5 期", f"{len([p for p in after['periods'] if p['done']])} 期")

print()
print("=" * 78)
print("⑤ 产物字段与前端约定一致（前端 fillReview 读这些键）")
print("=" * 78)
f = json.loads((tmp / "review.json").read_text(encoding="utf-8"))
for k in ("trade_date", "keep", "periods", "summary", "note"):
    note(k in f, f"顶层含 {k}")
per = f["periods"][0]
for k in ("date", "picks", "results", "win_rate", "avg_change", "done"):
    note(k in per, f"每期含 {k}")
note(all(k in per["picks"][0] for k in ("code", "name", "score", "close")),
     "每只入选股含 代码/名称/评分/入选价")
note("不是实盘收益" in f["note"] or "规则化回评" in f["note"],
     "口径说明里写清不是实盘收益", f["note"][:28] + "…")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for x in FAILED:
    print("  ❌", x)
sys.exit(1 if FAILED else 0)
