"""heal.py — 抓取阶段的**自我修复**与"失败账本"

用户要求（原话要点）：
    · 抓取失败时自动重试
    · 主数据源挂了自动切备用源（同花顺挂了 → 东方财富/新浪）
    · 数据缺失不报错，自动标记"无数据"并继续跑，不影响其他模块

前两条在 `common.py` 里早就有了（重试 3 次 / 多主机轮换 / 熔断冷却 / K 线等待预算），
**缺的是另外三件事**，这个模块就是补它们：

    ① **步骤级隔离**：任何一步炸了都不许中断整轮。旧写法是"哪里没包 try 就整轮挂掉"，
       跑 5 分钟才崩、一个产物都写不出来 —— 比"少一个板块的数据"糟糕得多。
    ② **失败账本**：旧版失败信息只在日志里刷过去，**页面上完全看不出这轮哪里残缺**。
       现在每一步的状态/耗时/换源/补回/仍缺都记下来，写进 health.json，页面上直接看。
    ③ **补抓与跨轮补齐**：主流程结束后对失败项做一轮定向重试；本轮没补上的记进
       `missing_items`，**下一轮优先补**。

设计原则（很重要，别改成"什么都兜住"）：
    · **只兜"拿不到数据"，不兜"代码有 bug"**。真正的逻辑错误（比如变量名写错）应该
      让测试和日志暴露出来，不该被 try/except 吞掉变成"数据缺失"。
      所以 required=True 的步骤（质量闸门）仍然会抛出并让本轮失败。
    · 每一步都要**留下证据**：失败原因、试过哪些源、最后是否补回。没证据的"自愈"等于没修。
"""

from __future__ import annotations

import json
import logging
import os
import time
from typing import Any, Callable

log = logging.getLogger("ashare.heal")

#: 一轮里允许的"等待总预算"（秒）——补抓时不要无限等下去把 CI 拖到超时
REPAIR_BUDGET_S = float(os.environ.get("ASHARE_REPAIR_BUDGET", "180"))
#: 连续多少轮补不上就把该项标成"长期缺失"（页面上会单独列出，不再每轮重试同样的事）
CHRONIC_AFTER_ROUNDS = int(os.environ.get("ASHARE_CHRONIC_ROUNDS", "3"))


class StepFailed(Exception):
    """必需步骤失败（会中断本轮）。只有质量闸门这类"数据太差不该发布"的情况才用它。"""


class Ledger:
    """
    一轮抓取的**自愈账本**。

    结构（也是 health.json 的形状）：
        {
          "generated_at": "...",
          "rounds": {"repair_budget_s": 180},
          "steps": [ {name, ok, seconds, note, attempts} ... ],
          "sources": {"failed_attempts": N, "ok_sources": [...], "cooling": [...]},
          "repaired": [ {item, how, count} ... ],
          "missing":  [ {item, why, chronic} ... ],
          "summary": {"steps_total": N, "steps_failed": M, "repaired": K, "still_missing": J}
        }
    """

    def __init__(self) -> None:
        self.t0 = time.time()
        self.steps: list[dict] = []
        self.repaired: list[dict] = []
        self.missing: list[dict] = []
        self._repair_spent = 0.0
        self._chronic: dict[str, int] = {}
        self.sources_before: dict = {}
        self.sources_after: dict = {}

    # ---------------- 步骤 ----------------
    def step(self, name: str) -> "_Step":
        return _Step(self, name)

    def add_step(self, name: str, ok: bool, seconds: float, note: str = "",
                 attempts: int = 1) -> None:
        self.steps.append({"name": name, "ok": bool(ok),
                           "seconds": round(seconds, 1), "note": note,
                           "attempts": attempts})
        if ok:
            log.info("  ✓ %-18s %s", name, note)
        else:
            log.warning("  ✗ %-18s %s", name, note)

    # ---------------- 缺失与补回 ----------------
    def add_missing(self, item: str, why: str) -> None:
        """记一项"这轮没拿到"。允许重复调用，同样的 item 只留最后一条原因。"""
        for m in self.missing:
            if m["item"] == item:
                m["why"] = why
                return
        self.missing.append({"item": item, "why": why,
                             "chronic": self._chronic.get(item, 0) >= CHRONIC_AFTER_ROUNDS})

    def note_repaired(self, item: str, how: str, count: int = 1) -> None:
        """记一项"刚才没拿到、后来补回来了"。"""
        for r in self.repaired:
            if r["item"] == item:
                r["count"] += count
                r["how"] = how
                return
        self.repaired.append({"item": item, "how": how, "count": count})
        # 补回来的就从缺失清单里撤掉
        self.missing = [m for m in self.missing if m["item"] != item]
        log.info("  ⟳ 补回 %-16s %s（%d）", item, how, count)

    def repair_budget_left(self) -> float:
        return max(0.0, REPAIR_BUDGET_S - self._repair_spent)

    def spend_repair(self, seconds: float) -> None:
        self._repair_spent += seconds

    # ---------------- 源健康 ----------------
    def snapshot_sources(self, which: str = "after") -> None:
        try:
            import common
            snap = common.source_report()
        except Exception:                                  # noqa: BLE001
            snap = {}
        if which == "before":
            self.sources_before = snap
        else:
            self.sources_after = snap

    def source_summary(self) -> dict:
        before, after = self.sources_before, self.sources_after
        failed_attempts = 0
        for name, info in (after or {}).items():
            prev = (before.get(name) or {}).get("fails", 0)
            now = info.get("fails", 0)
            if now > prev:                                  # 只算"本轮新增的失败次数"
                failed_attempts += now - prev
        cooling = [n for n, i in (after or {}).items() if not i.get("available", True)]
        used = [n for n, i in (after or {}).items() if i.get("available", True)]
        return {"failed_attempts": failed_attempts, "ok_sources": sorted(used),
                "cooling": sorted(cooling)}

    # ---------------- 输出 ----------------
    def summary(self) -> dict:
        failed = [s for s in self.steps if not s["ok"]]
        return {"steps_total": len(self.steps), "steps_failed": len(failed),
                "steps_failed_names": [s["name"] for s in failed],
                "repaired": sum(r["count"] for r in self.repaired),
                "still_missing": len(self.missing),
                "repair_seconds": round(self._repair_spent, 1)}

    def payload(self, *, day: str = "", trade_date: str = "") -> dict:
        from common import now_cn
        return {
            "trade_date": trade_date or day,
            "generated_at": now_cn().strftime("%Y-%m-%d %H:%M"),
            "elapsed_s": round(time.time() - self.t0, 1),
            "repair_budget_s": REPAIR_BUDGET_S,
            "steps": self.steps,
            "sources": self.source_summary(),
            "repaired": self.repaired,
            "missing": self.missing,
            "summary": self.summary(),
            "note": ("这是**抓取自愈账本**：本轮每一步是否成功、重试/换源了多少次、"
                     "失败了哪些项、补回了多少、还剩什么没拿到。"
                     "「仍缺」的项目页面上会照实显示为数据缺失，不会用 0 或旧数据填充。"),
        }

    def load_previous(self, path: str) -> None:
        """
        读上一轮的账本（用于"跨轮补齐"与"长期缺失"判定）。

        · 上一轮仍缺的项，本轮会被优先补（见 fetch_data 的 repair pass）
        · 连续 CHRONIC_AFTER_ROUNDS 轮都缺的项，标记为"长期缺失"，
          页面上单独列出 —— 免得每轮都在日志里刷同一条、也没人知道它其实一直没好
        """
        try:
            with open(path, encoding="utf-8") as fh:
                old = json.load(fh)
        except (OSError, ValueError):
            return
        if not isinstance(old, dict):
            return
        for m in old.get("missing") or []:
            item = str(m.get("item") or "")
            if item:
                self._chronic[item] = int(self._chronic.get(item, 0)) + 1
        self.missing = [{"item": m.get("item"), "why": f"上一轮也未拿到：{m.get('why')}",
                         "chronic": self._chronic.get(str(m.get("item")), 0) >= CHRONIC_AFTER_ROUNDS}
                        for m in (old.get("missing") or []) if m.get("item")]


class _Step:
    """`with ledger.step("① 全市场快照"):` —— 成功记 ok，抛异常记失败并继续（除非 required）。"""

    def __init__(self, ledger: Ledger, name: str) -> None:
        self.led = ledger
        self.name = name
        self.t = 0.0

    def __enter__(self) -> "_Step":
        self.t = time.time()
        return self

    def __exit__(self, exc_type, exc, tb) -> bool:
        dt = time.time() - self.t
        if exc_type is None:
            self.led.add_step(self.name, True, dt)
        elif isinstance(exc, StepFailed):
            # 必需步骤：记账后**继续抛出**，让本轮失败（宁可 Actions 变红，也不要发布残缺数据）
            self.led.add_step(self.name, False, dt, f"必需步骤失败：{exc}")
            return False
        else:
            # 普通步骤：记账后**吞掉异常**，本轮继续跑其它模块
            self.led.add_step(self.name, False, dt, f"{exc_type.__name__}: {exc}")
            log.warning("步骤「%s」失败但不中断本轮：%s: %s", self.name, exc_type.__name__, exc)
        return True


def guarded(led: Ledger, name: str, fn: Callable[[], Any], *, default: Any = None,
            required: bool = False) -> Any:
    """
    函数式写法（不想用 with 的时候用）。

    required=True 时失败会抛 StepFailed（质量闸门用），否则返回 default 并记一笔账。
    """
    t = time.time()
    try:
        out = fn()
        led.add_step(name, True, time.time() - t)
        return out
    except Exception as exc:                               # noqa: BLE001
        msg = f"{type(exc).__name__}: {exc}"
        led.add_step(name, False, time.time() - t, msg)
        if required:
            raise StepFailed(f"{name}：{msg}") from exc
        log.warning("步骤「%s」失败但不中断本轮：%s", name, msg)
        return default


# ======================================================================
# 产物校验与"就地修复"
# ======================================================================

#: 校验规则：(文件, 描述, 取值为 None 时算不算问题)
#: 这里只放**能自动判定对错**的硬规则。主观的东西（评分高低）不在这里管。
def validate_number(v, *, lo=None, hi=None) -> tuple[bool, str]:
    """数值合法性：None 是允许的（表示数据缺失），但不许超范围。"""
    if v is None:
        return True, ""
    if not isinstance(v, (int, float)) or isinstance(v, bool):
        return False, "不是数字"
    if v != v:                                             # NaN
        return False, "NaN"
    if lo is not None and v < lo:
        return False, f"小于 {lo}"
    if hi is not None and v > hi:
        return False, f"大于 {hi}"
    return True, ""


#: 涨跌幅的合理上限。
#: ⚠️ **不能按 ±10%/20% 去卡**：新股上市首日不设涨跌幅限制，实测（2026-09-11）
#: 就有 `688801 N燧原-U` 当天 +179.22%。第一版我写的是 ±100%，
#: 结果把真实数据判成了"非法值"—— 如果顺手接上 repair_rows，就会把这只票的
#: 涨跌幅**置空**，那才是真正的数据损坏。宁可放宽上限，也不要误伤真数据。
CHANGE_LIMIT = 1000.0


def check_rows(rows: list[dict], *, name: str, price_key: str = "price",
               score_key: str = "score", change_key: str = "change_pct") -> list[dict]:
    """
    对"一行一只标的"的表做通用校验，返回问题清单（不修改数据）。

    为什么只报不改：行级修复很容易把**真实异常**抹平成"看起来正常"。
    真正要改的（价格 ≤ 0 这种明显坏值）由 `repair_rows` 显式处理并记账。
    """
    issues: list[dict] = []
    for i, r in enumerate(rows or []):
        if not isinstance(r, dict):
            issues.append({"row": i, "why": "不是对象"})
            continue
        code = str(r.get("code") or "")
        if len(code) != 6 or not code.isdigit():
            issues.append({"row": i, "code": code, "why": "代码不是 6 位数字"})
        ok, why = validate_number(r.get(price_key), lo=0)
        if not ok:
            issues.append({"row": i, "code": code, "why": f"{price_key} {why}"})
        ok, why = validate_number(r.get(score_key), lo=0, hi=100)
        if not ok:
            issues.append({"row": i, "code": code, "why": f"{score_key} {why}"})
        ok, why = validate_number(r.get(change_key), lo=-CHANGE_LIMIT, hi=CHANGE_LIMIT)
        if not ok:
            issues.append({"row": i, "code": code, "why": f"{change_key} {why}"})
    return issues


def repair_rows(rows: list[dict], *, price_key: str = "price") -> tuple[list[dict], int]:
    """
    把明显坏掉的值改成 None（表示数据缺失），返回(修好的行, 修了几处)。

    改的是什么：价格 ≤ 0、评分超 0~100、涨跌幅超 ±CHANGE_LIMIT 这种**物理上不可能**的值。
    为什么要改：页面拿 -1 的价格去算筹码、拿 350 分去排序，会得到一屏胡说八道，
    而"置空 + 页面显示数据缺失"至少是诚实的。

    ⚠️ 涨跌幅的上限是 CHANGE_LIMIT（±1000%），**不是 ±10%**：
       新股首日不设涨跌幅限制，实测有 +179% 的真实数据。
    """
    fixed = 0
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        for key, lo, hi in ((price_key, 0, None), ("score", 0, 100), ("score_light", 0, 100),
                            ("change_pct", -CHANGE_LIMIT, CHANGE_LIMIT)):
            if key not in r:
                continue
            ok, _ = validate_number(r.get(key), lo=lo, hi=hi)
            if not ok:
                r[key] = None
                fixed += 1
    return rows or [], fixed


def check_future_dates(payload: dict, *, today: str, key: str = "trade_date") -> list[str]:
    """日期不许跑到"今天"之后（未来函数最直白的一种形态）。返回问题描述。"""
    out = []
    v = str(payload.get(key) or "")
    if v and v > today:
        out.append(f"{key}={v} 在未来（今天 {today}）")
    nav = payload.get("nav_date")
    if nav and str(nav) > today:
        out.append(f"nav_date={nav} 在未来")
    return out


def validate_artifacts(out_dir: str, *, today: str) -> dict:
    """
    遍历产物做一轮硬校验，返回报告（写进 health.json）。

    覆盖：文件能否解析、行级字段是否合法、日期是否越界、文件是否明显过小。
    """
    report: dict = {"checked": 0, "issues": [], "files": {}}
    if not os.path.isdir(out_dir):
        report["issues"].append(f"输出目录不存在：{out_dir}")
        return report
    for fn in sorted(os.listdir(out_dir)):
        if not fn.endswith(".json"):
            continue
        path = os.path.join(out_dir, fn)
        size = os.path.getsize(path)
        report["checked"] += 1
        report["files"][fn] = {"bytes": size}
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
        except (OSError, ValueError) as exc:
            report["issues"].append(f"{fn} 无法解析：{exc}")
            continue
        if isinstance(data, dict):
            for msg in check_future_dates(data, today=today):
                report["issues"].append(f"{fn}: {msg}")
            rows = data.get("rows")
            if isinstance(rows, list) and rows and isinstance(rows[0], dict):
                bad = check_rows(rows, name=fn)
                if bad:
                    report["files"][fn]["row_issues"] = len(bad)
                    report["issues"].append(
                        f"{fn}: {len(bad)} 行字段不合法，例如 {bad[0]}")
    return report
