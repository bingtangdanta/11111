"""ratelimit_test.py — 限流时的**行为**测试：不许"干等"，也不许"整轮白跑"

为什么单独做这一套：
    2026-09-12 实跑踩到过 —— 东财/腾讯/新浪三个 K 线源同时被限流后，
    `_fetch_kline` 对**每一只股票**都"睡 3 秒 + 三个源各失败一次" ≈ 8 秒。
    当时还剩 180 只，等于要再跑 24 分钟；而 GitHub Actions 有 timeout，
    一旦超时，**整轮产物一个都写不出来**（比"这轮少一批 K 线"糟糕得多）。

所以现在的规则是：
    ① 冷却只剩一点点（≤3 秒）→ 等一下强制重试（限流常常是短时的，值得等）
    ② 冷却还很久（> 30 秒）→ **立刻放弃这一只**，不睡、不重试
    ③ "等待"有**整轮总预算**（KLINE_WAIT_BUDGET）→ 用完就不再等
    ④ 连续 KLINE_GIVE_UP_STREAK 只拿不到 K 线 → 本段收工，剩下的标"K 线缺失"

这套测试全部离线（桩掉 sleep 与取数函数），只验"行为决策"，不碰网络。
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import common    # noqa: E402
import sources as src    # noqa: E402
import fetch_data as fd  # noqa: E402

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


# ---------------- 桩：把"睡"和"冷却剩余"接管过来 ----------------
SLEPT: list[float] = []
_real_sleep = time.sleep
src.time.sleep = lambda s: SLEPT.append(s)          # 只拦 sources 里的 sleep
_orig_avail = src.source_available
_orig_left = src.shortest_cooldown_left

EMPTY = [("em", lambda: []), ("tencent", lambda: []), ("sina", lambda: [])]


def scenario(cooldown_left: float):
    """构造"三个源都在冷却、最早还要等 cooldown_left 秒"的场景。"""
    SLEPT.clear()
    src.reset_kline_budget()
    src.source_available = lambda name: True          # 第一轮"可用"→ 每源各失败一次
    src.shortest_cooldown_left = lambda names: cooldown_left


print("=" * 78)
print("① 冷却还很久 → 立刻放弃，不睡不等（这就是那次 24 分钟的来源）")
print("=" * 78)
scenario(280.0)
t0 = time.monotonic()
got = src._fetch_kline(EMPTY, min_bars=20)            # noqa: SLF001（就是要测这个内部函数）
dt = time.monotonic() - t0
note(got == [], "返回空（这一只按 K 线缺失处理）")
note(SLEPT == [], "一次都没睡（不干等）", f"slept={SLEPT}")
note(dt < 0.5, "调用几乎瞬间返回", f"{dt * 1000:.0f} ms")
note(src.kline_budget_state()["waited"] == 0.0, "没有消耗等待预算")

print()
print("=" * 78)
print("② 冷却只剩 2 秒 → 值得等一下再强制重试")
print("=" * 78)
scenario(2.0)
got = src._fetch_kline(EMPTY, min_bars=20)            # noqa: SLF001
note(SLEPT == [2.0], "等的是「剩余冷却时间」而不是固定 3 秒", f"slept={SLEPT}")
note(src.kline_budget_state()["waited"] == 2.0, "等待计入了预算",
     str(src.kline_budget_state()))

print()
print("=" * 78)
print("③ 等待有整轮总预算：用完就不再等")
print("=" * 78)
scenario(3.0)
for _ in range(60):                                   # 3 秒 × 60 = 180 > 预算 120
    src._fetch_kline(EMPTY, min_bars=20)              # noqa: SLF001
st = src.kline_budget_state()
note(st["waited"] <= src.KLINE_WAIT_BUDGET, "累计等待不超过预算", str(st))
note(st["left"] <= 0.0 or st["waited"] >= 120.0, "预算确实被用到了上限附近", str(st))
before = len(SLEPT)
src._fetch_kline(EMPTY, min_bars=20)                  # noqa: SLF001
note(len(SLEPT) == before, "预算用完后不再等待", f"又睡了 {len(SLEPT) - before} 次")

print()
print("=" * 78)
print("④ reset_kline_budget 每轮清零；冷却时间可查询")
print("=" * 78)
src.reset_kline_budget()
note(src.kline_budget_state()["waited"] == 0.0, "reset 后等待归零", str(src.kline_budget_state()))
note(isinstance(common.cooldown_left("em"), float), "common.cooldown_left 返回数字",
     str(common.cooldown_left("em")))
note(common.cooldown_left("根本不存在的源") == 0.0, "没记录过的源返回 0（不误判成冷却）")
common.mark_source("__test_src__", False)
common.mark_source("__test_src__", False)
note(common.cooldown_left("__test_src__") == 0.0, "失败次数没到阈值时不算冷却")
common.mark_source("__test_src__", False)             # 第 3 次 → 熔断
left = common.cooldown_left("__test_src__")
note(left > 0, "连续失败达阈值 → 进入冷却并报出剩余时间", f"{left:.0f}s")
note(common.shortest_cooldown_left(["__test_src__", "根本没有"]) == 0.0,
     "一组源里「最早恢复」的时间取最小（有没冷却的就返回 0）")
common.mark_source("__test_src__", True)
note(common.cooldown_left("__test_src__") == 0.0, "成功一次立刻解除冷却")

print()
print("=" * 78)
print("⑤ 主流程必须真的会「整段收工」，而不是每只都硬试")
print("=" * 78)
fd_src = (ROOT / "scripts" / "fetch_data.py").read_text(encoding="utf-8")
note("KLINE_GIVE_UP_STREAK" in fd_src,
     "有「连续 N 只失败就整段收工」的阈值（可用 ASHARE_KLINE_GIVE_UP_STREAK 调）")
note("kline_gave_up = True" in fd_src and "本段收工" in fd_src,
     "达到阈值后把剩余股票标记为 K 线缺失并继续出数据")
note("src.reset_kline_budget()" in fd_src, "每轮开始清空等待预算")
note("if not kline_gave_up:" in fd_src, "收工后不再对剩余股票发起 K 线请求")
# 阈值本身要有个合理默认值：太小会误伤零星抖动，太大等于没保护
note(10 <= fd.KLINE_GIVE_UP_STREAK <= 100, "阈值默认值合理", str(fd.KLINE_GIVE_UP_STREAK))

# 收尾：把桩还回去，免得影响同进程里后面的检查
src.source_available = _orig_avail
src.shortest_cooldown_left = _orig_left
src.time.sleep = _real_sleep

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
