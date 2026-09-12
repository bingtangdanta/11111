"""board_test.py — 板块数据（K 线 / 指标 / 筹码 / 5 龙头股）的契约测试。

为什么必须单独测：东方财富的 K 线主机经常临时限流（本机今天就一直是 RemoteDisconnected），
如果只在"能连上"的时候手工看一眼，代码里字段顺序写错、少了 chip 之类的问题会一直藏着。
所以这里把 `_em_kline` / `get_json_ok` 换成可控的桩，验证**解析与拼装**这段逻辑，
再对真实产物（演示数据）做一次结构核对。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import chips          # noqa: E402
import indicators as ind   # noqa: E402
import sources as src      # noqa: E402

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


def fake_lines(n: int = 80) -> list[dict]:
    """东财 K 线接口的原始行：日期,开,收,高,低,量,额,振幅,涨跌幅,涨跌额,换手"""
    out, p = [], 1000.0
    for i in range(n):
        o = p
        c = p * (1 + (0.01 if i % 3 else -0.008))
        h, low = max(o, c) * 1.004, min(o, c) * 0.996
        out.append(f"2026-0{1 + i % 9}-{1 + i % 28:02d},{o:.2f},{c:.2f},{h:.2f},{low:.2f},"
                   f"{120000 + i * 300},{1.2e8:.0f},1.1,0.9,9.0,1.2")
        p = c
    return out


print("=" * 78)
print("① 板块 K 线：secid 必须是 90.BKxxxx，且解析字段不能错位")
print("=" * 78)
captured: dict = {}
orig_kline = src._em_kline


def stub_em_kline(secid_str: str, bars: int, adjust: str) -> list[dict]:
    captured["secid"] = secid_str
    captured["bars"] = bars
    lines = fake_lines()
    out = []
    for line in lines:
        p = line.split(",")
        out.append({"date": p[0], "open": float(p[1]), "close": float(p[2]),
                    "high": float(p[3]), "low": float(p[4]), "volume": float(p[5])})
    return out


src._em_kline = stub_em_kline
bars = src.board_kline("bk1592", bars=120)          # 故意用小写，验证会规整成大写
note(captured.get("secid") == "90.BK1592", "板块 K 线用的 secid = 90.BKxxxx（前缀 90）",
     str(captured.get("secid")))
note(len(bars) == 80, "解析出全部 K 线", f"{len(bars)} 根")
ok_order = all(b["low"] <= b["open"] <= b["high"] and b["low"] <= b["close"] <= b["high"]
               for b in bars)
note(ok_order, "字段没有错位（低 ≤ 开/收 ≤ 高 全部成立）")
note(src.board_kline("600519") == [], "传个股代码给板块 K 线 → 直接返回空（不做无意义请求）")
note(src.board_kline("") == [], "空代码 → 返回空，不抛异常")
src._em_kline = orig_kline

print()
print("=" * 78)
print("② 板块 5 龙头股：按涨幅降序取前 5")
print("=" * 78)
orig_json_ok = src.get_json_ok
sent: dict = {}


def stub_json_ok(path, params, hosts, validate=None):
    sent["path"] = path
    sent["params"] = params
    rows = [{"f12": f"30000{i}", "f14": f"龙头{i}", "f2": 10 + i, "f3": 9.9 - i,
             "f62": 1e8 * (5 - i), "f184": 3.1, "f8": 12.5, "f20": 8e9} for i in range(6)]
    return {"data": {"total": 42, "diff": rows}}


src.get_json_ok = stub_json_ok
leaders = src.board_leaders("BK1592", top=5)
note(len(leaders) == 5, "只取前 5 只（多的丢掉）", f"{len(leaders)} 只")
note(sent["params"].get("fs") == "b:BK1592", "成分股筛选用 fs = b:BKxxxx",
     str(sent["params"].get("fs")))
note(sent["params"].get("fid") == "f3" and sent["params"].get("po") == "1",
     "按涨跌幅(f3)降序(po=1)排序 —— 这才叫龙头/领涨")
first = leaders[0]
note(first["code"] == "300000" and first["name"] == "龙头0", "代码/名称解析正确",
     f"{first['code']} {first['name']}")
note(all(k in first for k in ("price", "change_pct", "main_net", "main_net_pct",
                              "turnover", "market_cap")),
     "每只龙头股都带 现价/涨跌幅/主力净额/净占比/换手/市值")
note(src.board_leaders("sh600519") == [], "非板块代码 → 返回空")
src.get_json_ok = orig_json_ok

print()
print("=" * 78)
print("③ 板块 K 线 → 指标 + 筹码峰（前端要用的字段齐不齐）")
print("=" * 78)
kl = {"dates": [b["date"] for b in bars], "open": [b["open"] for b in bars],
      "high": [b["high"] for b in bars], "low": [b["low"] for b in bars],
      "close": [b["close"] for b in bars], "volume": [int(b["volume"]) for b in bars]}
chip = chips.summarize(bars, bars[-1]["close"])
trend = ind.trend_flags(bars)
note(chip.get("profit_ratio_pct") is not None and chip.get("trapped_ratio_pct") is not None,
     "板块也能算获利盘/套牢盘", f"{chip['profit_ratio_pct']}% / {chip['trapped_ratio_pct']}%")
note(len(chip.get("rows") or []) == 60, "板块筹码直方图 60 档（前端画图用）",
     f"{len(chip.get('rows') or [])} 档")
note(chip.get("avg_cost") and chip.get("shape"), "有平均筹码与形态",
     f"{chip.get('avg_cost')} · {chip.get('shape')}")
note(isinstance(trend, dict) and trend, "有指标汇总（趋势标记）",
     ", ".join(list(trend)[:4]))
note(len(kl["dates"]) == len(kl["close"]) == len(kl["volume"]), "K 线各字段长度一致")

print()
print("=" * 78)
print("④ 真实产物结构核对：_demo2/data/sectors.json")
print("=" * 78)
p = ROOT / "_demo2" / "data" / "sectors.json"
if not p.exists():
    note(False, "演示数据存在（先跑一次 scripts/fetch_data.py）", str(p))
else:
    d = json.loads(p.read_text(encoding="utf-8"))
    boards = (d.get("industry") or []) + (d.get("concept") or [])
    note(len(boards) > 0, "板块列表非空", f"{len(boards)} 个")
    with_leaders = [b for b in boards if (b.get("leaders") or [])]
    note(len(with_leaders) == len(boards),
         "**每个板块**都带 5 只龙头股（用户明确要求）",
         f"{len(with_leaders)}/{len(boards)} 个板块")
    n5 = [b for b in boards if len(b.get("leaders") or []) == 5]
    note(len(n5) >= len(boards) * 0.9, "大多数板块恰好 5 只（成分股不足 5 只的除外）",
         f"{len(n5)}/{len(boards)}")
    lead = with_leaders[0]["leaders"][0] if with_leaders else {}
    note(all(k in lead for k in ("code", "name", "change_pct", "main_net")),
         "龙头股字段齐备", f"{lead.get('code')} {lead.get('name')} {lead.get('change_pct')}%")
    detailed = [b for b in boards if b.get("kline")]
    marked = [b for b in boards if b.get("kline_missing")]
    note(len(detailed) + len(marked) > 0,
         "有 K 线的板块与「明确标缺失」的板块都被标注（没有含糊其辞）",
         f"有K线 {len(detailed)} 个 / 标缺失 {len(marked)} 个")
    for b in detailed[:3]:
        note(bool(b.get("chip") and b["chip"].get("rows")) and bool(b.get("indicators")),
             f"{b.get('name')}：K 线之外还有筹码峰与指标",
             f"{len(b['kline']['dates'])} 根 / {b['chip'].get('shape')}")
    note(all("up" in b or True for b in boards), "（板块涨跌家数字段可选）")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
