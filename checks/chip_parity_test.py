"""chip_parity_test.py — 前端与后端的筹码算法必须算出一模一样的数（逐项对账）。

为什么要测：搜索任意个股时，前端会用"浏览器实时抓的 K 线"自己算一份筹码分布；
有存档快照的股票则用后端 scripts/chips.py 算好的结果。两套实现如果口径不一致，
同一只股票会出现两个获利盘数字，用户就不会再信这个指标了。
所以这里把同一根 K 线喂给两边，逐项比较。

进程间不用管道：Python 写 fixture 文件 → node 读它、把结果写成文件 → Python 读回来比较。
（受限环境下管道容易踩 EPERM，文件进出最稳。）
"""

from __future__ import annotations

import json
import math
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import chips  # noqa: E402  （必须先把 scripts/ 加进 sys.path）

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "_test_out"
OUT.mkdir(exist_ok=True)
FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


def make_series(n: int = 200, seed: float = 1.0) -> dict:
    """造一根确定性的 K 线（涨跌交替、有量能变化），两边吃同一份数据。"""
    kl = {"dates": [], "open": [], "close": [], "high": [], "low": [], "volume": []}
    p = 20.0
    for i in range(n):
        drift = math.sin(i / 9.0) * 0.6 * seed + (-0.5 if i % 7 == 0 else 0.25)
        o = p
        c = max(2.0, p + drift)
        h = max(o, c) + 0.35
        low = min(o, c) - 0.35
        kl["dates"].append(f"2026-01-{i % 28 + 1:02d}")
        kl["open"].append(round(o, 2))
        kl["close"].append(round(c, 2))
        kl["high"].append(round(h, 2))
        kl["low"].append(round(low, 2))
        kl["volume"].append(1_200_000 + (i % 13) * 90_000)
        p = c
    return kl


def bars_of(kl: dict) -> list[dict]:
    return [{"open": kl["open"][i], "high": kl["high"][i], "low": kl["low"][i],
             "close": kl["close"][i], "volume": kl["volume"][i]}
            for i in range(len(kl["dates"]))]


print("=" * 78)
print("筹码算法一致性：scripts/chips.py（后端） vs docs/app.js chipFromKline（前端）")
print("=" * 78)

for label, kl, price in [
    ("涨跌交替 200 根，现价=最后一根收盘", make_series(200), None),
    ("同一条 K 线，现价=区间中部", make_series(200), 25.0),
    ("短序列 40 根（不足 250 根回看）", make_series(40), None),
    ("单边下跌 120 根", {**make_series(120), "close": [round(60 - i * 0.3, 2) for i in range(120)],
                       "high": [round(60 - i * 0.3 + 0.4, 2) for i in range(120)],
                       "low": [round(60 - i * 0.3 - 0.4, 2) for i in range(120)],
                       "open": [round(60 - i * 0.3 - 0.1, 2) for i in range(120)]}, 30.0),
]:
    cur = price if price is not None else kl["close"][-1]
    py = chips.summarize(bars_of(kl), cur)

    fixture = OUT / "chip_fixture.json"
    jsout = OUT / "chip_js.json"
    fixture.write_text(json.dumps({"kline": kl, "price": price}), encoding="utf-8")
    r = subprocess.run(["node", str(Path(__file__).parent / "_chip_parity.mjs"),
                        str(fixture), str(jsout)],
                       cwd=str(ROOT), capture_output=True, text=True,
                       # node 打印的是 UTF-8 中文，Windows 默认按 GBK 解码会直接抛
                       # UnicodeDecodeError（而且是在子线程里抛，看起来像"node 执行失败"）
                       encoding="utf-8", errors="replace", timeout=120)
    if r.returncode != 0 or not jsout.exists():
        note(False, f"{label}：node 侧执行失败", (r.stderr or "")[-200:])
        continue
    js = json.loads(jsout.read_text(encoding="utf-8"))

    print(f"\n· {label}（现价 {cur}）")
    note(abs(py["profit_ratio_pct"] - js["profit_ratio_pct"]) < 0.05,
         "获利盘比例一致", f"后端 {py['profit_ratio_pct']} / 前端 {js['profit_ratio_pct']}")
    note(abs(py["trapped_ratio_pct"] - js["trapped_ratio_pct"]) < 0.05,
         "套牢盘比例一致", f"后端 {py['trapped_ratio_pct']} / 前端 {js['trapped_ratio_pct']}")
    note(abs(py["avg_cost"] - js["avg_cost"]) < 0.02,
         "平均筹码成本一致", f"后端 {py['avg_cost']} / 前端 {js['avg_cost']}")
    note(abs(py["hhi"] - js["hhi"]) < 1e-4, "集中度 HHI 一致",
         f"后端 {py['hhi']} / 前端 {js['hhi']}")
    note(len(py["rows"]) == len(js["rows"]) == 60, "分箱数一致（60 档）",
         f"{len(py['rows'])} / {len(js['rows'])}")
    maxdiff = max((abs(a["share"] - b["share"]) for a, b in zip(py["rows"], js["rows"])), default=0)
    note(maxdiff < 0.05, "每一档的占比都一致（逐档对账）", f"最大偏差 {maxdiff:.4f} 个百分点")
    note(py["shape"] == js["shape"], "形态判断一致", f"{py['shape']} / {js['shape']}")
    note(py["top10_band"].get("low") == js["top10_band"].get("low")
         and py["top10_band"].get("high") == js["top10_band"].get("high"),
         "密集筹码带一致",
         f"{py['top10_band']} / {js['top10_band']}")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
