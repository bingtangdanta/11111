"""verify_output.py — 检查一轮抓取的产物是否满足所有约定（修复后回归用）。"""

from __future__ import annotations

import json
import pathlib
import sys
from datetime import date

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


d = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "_test_out2/data")
print("=" * 78)
print(f"产物校验：{d}")
print("=" * 78)

# 仓库里的 docs/data 只有**占位** version.json（真实数据由 Actions 生成）。
# 直接拿它跑断言会 FileNotFoundError，看起来像"校验失败"，其实是"还没跑过抓取"。
# 所以这里先看是不是占位状态：是就明确 SKIP，退出码 0，并提示去看哪份数据。
if not (d / "history.json").exists():
    v = {}
    try:
        v = json.loads((d / "version.json").read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        v = {}
    if v.get("placeholder") or not v:
        print("[SKIP] 这个目录还没有抓取产物（只有占位 version.json）——")
        print("       想看真实产物请指定目录，例如：")
        print("         python checks/verify_output.py _demo2/data     # 本地演示数据")
        print("         python checks/verify_output.py docs/data       # 跑完 Actions 之后")
        sys.exit(0)
    note(False, "history.json 存在")
    print()
    print(f"失败项：{len(FAILED)}")
    sys.exit(1)

# history.json
h = json.loads((d / "history.json").read_text(encoding="utf-8"))
days = h.get("days") or []
note(len(days) >= 1, "history.json 有数据", f"{len(days)} 天")
if days:
    e = days[-1]
    for k in ("date", "limit_up", "limit_down", "break", "break_rate",
              "max_continue", "market_score", "scored", "top_avg_score"):
        note(k in e, f"history 含 {k}", str(e.get(k)))

# screen.json：**全市场**筛选表（用户要求 5000 只都能筛到）
s = json.loads((d / "screen.json").read_text(encoding="utf-8"))
rows = s.get("rows") or []
note(bool(rows), "screen.json 有候选行", f"{len(rows)} 行")
note(len(rows) >= 4000, "筛选表覆盖全市场（≥4000 只，不是只挑一小撮）", f"{len(rows)} 行")
note(all("has_detail" in r for r in rows), "每行都带 has_detail 标记")
note(all("has_tech" in r for r in rows), "每行都带 has_tech（是否做过技术面精算）")
no_tech = [r for r in rows if not r.get("has_tech")]
note(all(r.get("score_light") is not None for r in no_tech),
     "没有精算分的行都有「快评分」（全市场每只都有分）",
     f"{len(no_tech)} 行 / 共 {len(rows)} 行")
note(all(r.get("score") is not None for r in rows if r.get("has_tech")),
     "精算行都有「精算分」")
with_detail = [r for r in rows if r.get("has_detail")]
missing = [r["code"] for r in with_detail
           if not (d / "stock" / f"{r['code']}.json").exists()]
note(not missing, "标记 has_detail 的股票都真有详情文件",
     f"缺失 {missing[:5]}" if missing else f"{len(with_detail)} 只全部命中")
top = s.get("top") or []
note(all((d / "stock" / f"{c}.json").exists() for c in top), "Top 榜每只都有详情文件",
     f"{len(top)} 只")
cols = s.get("columns") or []
note(cols and cols[0] in ("精算分", "快评分", "评分"),
     "columns 第一列是评分列（页面按它排序）", str(cols[:2]))

# universe.json：搜索库也必须覆盖全市场
u = json.loads((d / "universe.json").read_text(encoding="utf-8"))
urows = u.get("rows") or []
note(len(urows) >= 4000, "搜索库覆盖全市场（≥4000 只）", f"{u.get('count')} 只")
note(all(r.get("score_light") is not None for r in urows), "搜索库每行都有快评分")
note(any(r.get("is_st") for r in urows), "搜索库包含 ST（不再被过滤掉）")
note(len({r["code"][:2] for r in urows}) >= 6,
     "搜索库覆盖各代码段（沪 60/68、深 00/30、北 43/83/92 等）",
     "、".join(sorted({r["code"][:2] for r in urows})))

# 个股详情内容
if with_detail:
    code = with_detail[0]["code"]
    st = json.loads((d / "stock" / f"{code}.json").read_text(encoding="utf-8"))
    kl = st.get("kline") or {}
    chip = st.get("chip") or {}
    note(len(kl.get("dates") or []) >= 60, f"{code} K 线根数", f"{len(kl.get('dates') or [])} 根")
    note(chip.get("profit_ratio_pct") is not None, "含获利盘估算",
         f"{chip.get('profit_ratio_pct')}%")
    note(chip.get("trapped_ratio_pct") is not None, "含套牢盘估算",
         f"{chip.get('trapped_ratio_pct')}%")
    note(bool(chip.get("rows")), "含筹码直方图", f"{len(chip.get('rows') or [])} 行")
    note(bool((st.get("score") or {}).get("parts")), "含评分构成",
         str((st.get("score") or {}).get("parts")))

# version.json
v = json.loads((d / "version.json").read_text(encoding="utf-8"))
note(v.get("scored"), "version.json 记录了精算只数（修过的 bug）", str(v.get("scored")))
note(v.get("slots") == ["16:00", "18:00", "20:00"], "档位正确")
note(bool(v.get("sources")), "含数据来源清单", f"{len(v.get('sources') or [])} 条")

# 其它文件齐备
for name in ("dashboard", "limitup", "sectors", "dragon", "research", "index_kline"):
    note((d / f"{name}.json").exists(), f"{name}.json 存在")

# funds.json：场外 ETF / 指数基金（用户要求新增的板块）
fp = d / "funds.json"
note(fp.exists(), "funds.json 存在（场外 ETF 板块）")
if fp.exists():
    fu = json.loads(fp.read_text(encoding="utf-8"))
    frows = fu.get("funds") or []
    funi = fu.get("universe") or []
    note(bool(frows), "场外基金排行有数据", f"{len(frows)} 只")
    note(bool(funi), "场外基金可搜索库有数据", f"{len(funi)} 只")
    # 真实性：净值必须有值、净值日期必须非空 —— 这两项是"是不是真数据"的最低门槛。
    note(all((r.get("nav") or 0) > 0 for r in frows), "每只都有单位净值（>0）")
    note(all(str(r.get("nav_date") or "").strip() for r in frows), "每只都标了净值日期")
    note(all(len(str(r.get("code") or "")) == 6 for r in frows), "基金代码都是 6 位")
    # 净值日期不能跑到"未来"（未来函数的一种最直白形态）
    today = date.today().isoformat()
    future = [r["code"] for r in frows if str(r.get("nav_date") or "") > today]
    note(not future, "净值日期没有跑到未来（不是未来函数）", f"异常 {future[:3]}")

idx = json.loads((d / "index_kline.json").read_text(encoding="utf-8"))
note(len(idx) >= 3, "大盘 K 线指数 ≥3", f"{len(idx)} 个")

# ---- 决策验证与自愈产物（本轮新增）----
# 这几条的验收重点是**"不许自欺"**：样本不足必须写"样本不足"、
# 不可成交样本必须单列、基准缺失必须写缺失而不是 0。
scp = d / "selfcheck.json"
note(scp.exists(), "selfcheck.json 存在（决策验证产物）")
if scp.exists():
    sc = json.loads(scp.read_text(encoding="utf-8"))
    for k in ("trade_date", "basis", "rolling", "rating", "regime", "banners",
              "advice_override", "note"):
        note(k in sc, f"selfcheck 含 {k}")
    lvl = (sc.get("rating") or {}).get("level")
    note(lvl in ("良好", "衰减", "失效", "样本不足"), "策略评级是四态之一", str(lvl))
    roll = sc.get("rolling") or {}
    note("untradable" in roll, "滚动统计里**单列**了不可成交样本数",
         f"{roll.get('untradable')} 只")
    note("cost_bp" in roll and roll["cost_bp"] > 0, "记录了成本（bp）", str(roll.get("cost_bp")))
    # 样本不足时不许出现"良好"
    if (roll.get("periods_used") or 0) < (sc.get("rating") or {}).get("thresholds", {}).get("min_periods", 5):
        note(lvl == "样本不足", "样本不足时必须标「样本不足」（不许说良好）", str(lvl))
    note(sc.get("regime", {}).get("regime") in ("普涨", "震荡", "单边下跌", "数据不足"),
         "市场环境是四态之一", str(sc.get("regime", {}).get("regime")))
    note("不能自动下单" in (sc.get("note") or ""), "产物里写明「只提示，不能自动下单」")

hp = d / "health.json"
note(hp.exists(), "health.json 存在（抓取自愈账本）")
if hp.exists():
    h = json.loads(hp.read_text(encoding="utf-8"))
    for k in ("steps", "sources", "repaired", "missing", "summary"):
        note(k in h, f"health 含 {k}")
    note(isinstance(h.get("steps"), list) and h["steps"], "账本里逐步记录了状态",
         f"{len(h.get('steps') or [])} 步")
    note("failed_attempts" in (h.get("sources") or {}), "记录了本轮失败重试次数",
         str((h.get("sources") or {}).get("failed_attempts")))

fp = d / "factor_ic.json"
note(fp.exists(), "factor_ic.json 存在（RankIC 产物）")
if fp.exists():
    fi = json.loads(fp.read_text(encoding="utf-8"))
    note("samples" in fi and "series" in fi, "含每个因子的 IC 序列与有效样本数")
    note(fi.get("sample_dates") is not None, "记录了有效交易日数（调权门槛）",
         str(fi.get("sample_dates")))

wp = d / "weights_override.json"
note(wp.exists(), "weights_override.json 存在（自动降权产物）")
if wp.exists():
    wo = json.loads(wp.read_text(encoding="utf-8"))
    note("dimensions" in wo and "applied" in wo, "含维度倍率与是否生效标记")
    dims = wo.get("dimensions") or {}
    floor = float(wo.get("floor") or 0.3)
    note(all(float(v) >= floor - 1e-9 for v in dims.values()),
         f"所有维度倍率都不低于地板 {floor}", str(dims))
    if not wo.get("applied"):
        note(all(abs(float(v) - 1.0) < 1e-9 for v in dims.values()),
             "未生效时维度倍率必须全是 1.0（不许偷偷改权重）", str(dims))


print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
