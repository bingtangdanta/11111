"""heal_test.py — 自我修复机制的测试（全部离线，桩掉网络）

为什么单独做这一套：
    "自愈"最容易变成"把错误吞掉"。这个测试文件就是钉住三件事：
      ① **该吞的吞**：某一步拿不到数据 → 记一笔账、继续跑，其它模块照常出数据；
      ② **不该吞的不吞**：必需步骤（质量闸门）失败必须让本轮失败 ——
         宁可 Actions 变红，也不要发布一份残缺数据；
      ③ **有据可查**：每一步的状态、失败原因、补回数量都要写进账本，
         页面上能看出"这轮自愈了几次、还缺什么"（没证据的自愈等于没修）。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import heal    # noqa: E402

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


print("=" * 78)
print("① 步骤级隔离：普通步骤炸了也要继续跑")
print("=" * 78)
led = heal.Ledger()
with led.step("① 会成功的一步"):
    pass
with led.step("② 会炸的一步"):
    raise RuntimeError("模拟接口挂了")
with led.step("③ 后面的一步"):
    pass
names = [s["name"] for s in led.steps]
note(len(led.steps) == 3, "三步都被记下来了（炸的那步没有把流程带走）", str(names))
note(led.steps[0]["ok"] is True and led.steps[1]["ok"] is False and led.steps[2]["ok"] is True,
     "成功/失败状态分别记对")
note("RuntimeError" in led.steps[1]["note"] and "接口挂了" in led.steps[1]["note"],
     "失败原因写进了账本", led.steps[1]["note"])
note(all("seconds" in s and "attempts" in s for s in led.steps), "每步都有耗时与尝试次数")

print()
print("=" * 78)
print("② 必需步骤：失败必须让本轮失败（不许静默降级）")
print("=" * 78)
led2 = heal.Ledger()
raised = False
try:
    with led2.step("⑦ 精算（质量闸门）") as _s:
        raise heal.StepFailed("精算只数过少（3 < 10）")
except heal.StepFailed as exc:
    raised = True
    note("必需步骤失败" in led2.steps[-1]["note"], "必需步骤的原因写进了账本", led2.steps[-1]["note"])
    note("3 < 10" in str(exc), "原始异常也照原样冒泡（不被包装丢信息）", str(exc))
note(raised, "必需步骤失败 → 异常冒泡（本轮会失败，不发布残缺数据）")
note(led2.steps and led2.steps[0]["ok"] is False, "失败也照常记账（日志与账本都有据可查）")

print()
print("=" * 78)
print("③ guarded()：函数式写法 + 缺省值")
print("=" * 78)
led3 = heal.Ledger()
v = heal.guarded(led3, "取一个会失败的数据", lambda: 1 / 0, default=[])
note(v == [], "失败时返回缺省值（调用方拿到空列表而不是异常）", str(v))
note(led3.steps[0]["ok"] is False and "ZeroDivisionError" in led3.steps[0]["note"],
     "失败原因记进账本", led3.steps[0]["note"])
try:
    heal.guarded(led3, "必需步骤", lambda: 1 / 0, required=True)
    note(False, "required=True 应抛出 StepFailed")
except heal.StepFailed:
    note(True, "required=True 会抛出 StepFailed（不会静默返回 None）")

print()
print("=" * 78)
print("④ 缺失 → 补回 → 账本自动销账")
print("=" * 78)
led4 = heal.Ledger()
led4.add_missing("板块K线", "东财 push2his 限流（RemoteDisconnected）")
led4.add_missing("龙虎榜席位", "接口返回空 diff")
note(len(led4.missing) == 2, "两项缺失都记下了")
led4.add_missing("板块K线", "连续 3 次超时")           # 同一项重复记 → 只留一条、更新原因
note(len(led4.missing) == 2, "同一项重复记不会变成两条")
note(led4.missing[0]["why"] == "连续 3 次超时", "原因更新为最新的那条", led4.missing[0]["why"])
led4.note_repaired("板块K线", "换到 43.push2his 重试成功", 8)
note(len(led4.missing) == 1 and led4.missing[0]["item"] == "龙虎榜席位",
     "补回来的项自动从缺失清单里撤掉（页面上不会继续报假缺失）")
note(led4.repaired[0]["count"] == 8, "补回数量记下来了", str(led4.repaired[0]))

print()
print("=" * 78)
print("⑤ 跨轮补齐：上一轮缺的，这一轮要能知道并优先补")
print("=" * 78)
import tempfile    # noqa: E402
tmp = Path(tempfile.mkdtemp())
prev = {"missing": [{"item": "板块K线", "why": "限流"}, {"item": "场外基金", "why": "接口 200 但无权限"}]}
(tmp / "health.json").write_text(json.dumps(prev, ensure_ascii=False), encoding="utf-8")
led5 = heal.Ledger()
led5.load_previous(str(tmp / "health.json"))
note(len(led5.missing) == 2, "上一轮的两项缺失被读进来了")
note(all("上一轮也未拿到" in m["why"] for m in led5.missing), "原因里标明了「上一轮也未拿到」",
     led5.missing[0]["why"])
# 连续多轮都缺 → 标"长期缺失"（页面上单独列，不再每轮刷同一条日志）
last = {"missing": [{"item": "场外基金", "why": "接口 200 但无权限"}]}
for i in range(heal.CHRONIC_AFTER_ROUNDS):
    led6 = heal.Ledger()
    led6.load_previous(str(tmp / f"health{i}.json")) if False else None
    (tmp / f"h{i}.json").write_text(json.dumps(last, ensure_ascii=False), encoding="utf-8")
    led6.load_previous(str(tmp / f"h{i}.json"))
final = heal.Ledger()
final._chronic["场外基金"] = heal.CHRONIC_AFTER_ROUNDS     # 模拟"已经连续缺了 N 轮"
final.add_missing("场外基金", "还是拿不到")
note(final.missing[0]["chronic"] is True, f"连续 {heal.CHRONIC_AFTER_ROUNDS} 轮以上都缺 → 标记长期缺失")

print()
print("=" * 78)
print("⑥ 源健康：本轮新增多少次失败、哪些源在冷却")
print("=" * 78)
led7 = heal.Ledger()
led7.sources_before = {"em": {"fails": 1, "available": True}, "tencent": {"fails": 0, "available": True}}
led7.sources_after = {"em": {"fails": 5, "available": False}, "tencent": {"fails": 0, "available": True},
                      "sina": {"fails": 0, "available": True}}
_sum = led7.source_summary()
note(_sum["failed_attempts"] == 4, "只算**本轮新增**的失败次数（5-1=4，不是把历史失败也算进来）",
     str(_sum["failed_attempts"]))
note(_sum["cooling"] == ["em"], "被熔断冷却的源单独列出", str(_sum["cooling"]))
note("tencent" in _sum["ok_sources"] and "sina" in _sum["ok_sources"], "可用源清单正确")

print()
print("=" * 78)
print("⑦ 产物校验：拦得住「物理上不可能」的数据")
print("=" * 78)
note(heal.validate_number(12.5, lo=0)[0] is True, "正常数字通过")
note(heal.validate_number(None, lo=0)[0] is True, "None 视为数据缺失（不算问题）")
note(heal.validate_number(-1, lo=0)[0] is False, "负数价格不通过")
note(heal.validate_number(350, lo=0, hi=100)[0] is False, "超过 100 的评分不通过")
note(heal.validate_number(float("nan"))[0] is False, "NaN 不通过")
note(heal.validate_number("-")[0] is False, "字符串不通过")

rows = [{"code": "600519", "price": 1700, "score": 80, "change_pct": 3.2},
        {"code": "000636", "price": -1, "score": 350, "change_pct": 99999},
        {"code": "12345", "price": None, "score": None, "change_pct": None}]
issues = heal.check_rows(rows, name="t")
note(len(issues) >= 4, "坏行被逐条报出来（含代码位数、价格、评分、涨跌幅）", f"{len(issues)} 条")
note(any("price" in i["why"] for i in issues), "报出价格问题")
# 这条是**真机踩出来的**：新股上市首日不设涨跌幅限制，
# 实测 2026-09-11 有 `688801 N燧原-U` 当天 +179.22%。
# 第一版把上限写成 ±100%，把真实数据判成非法 —— 顺手接上修复就会把真数据置空。
note(heal.check_rows([{"code": "688801", "price": 397.0, "score": 60,
                       "change_pct": 179.22}], name="t") == [],
     "新股首日 +179% **不算**非法值（放宽上限的回归）")
rows2, fixed = heal.repair_rows(rows)
note(fixed == 3, "就地修复：价格/评分/涨跌幅三处坏值被置为 None", f"修了 {fixed} 处")
note(rows2[1]["price"] is None and rows2[1]["score"] is None, "置空而不是改成 0（0 会被当成真实值）")
note(rows2[0]["price"] == 1700, "好数据不受影响")
note(heal.repair_rows([{"code": "688801", "price": 397.0, "change_pct": 179.22}])[1] == 0,
     "修复也不误伤新股首日的涨幅")

bad_future = {"trade_date": "2099-01-01"}
note(heal.check_future_dates(bad_future, today="2026-09-12"), "未来日期会被抓出来")
note(not heal.check_future_dates({"trade_date": "2026-09-11"}, today="2026-09-12"),
     "过去的日期没问题")

print()
print("=" * 78)
print("⑧ 账本输出（health.json 的形状）")
print("=" * 78)
led8 = heal.Ledger()
with led8.step("① 快照"):
    pass
with led8.step("③b 板块K线"):
    raise RuntimeError("限流")
led8.add_missing("板块K线", "限流")
led8.snapshot_sources("after")
pay = led8.payload(day="2026-09-11", trade_date="2026-09-11")
for k in ("trade_date", "generated_at", "elapsed_s", "steps", "sources", "repaired",
          "missing", "summary", "note"):
    note(k in pay, f"账本含 {k}")
note(pay["summary"]["steps_failed"] == 1 and pay["summary"]["still_missing"] == 1,
     "汇总数字正确", json.dumps(pay["summary"], ensure_ascii=False))
# 产物校验跑一遍真实目录（docs/data 只有占位文件，应能正常返回而不炸）
rep = heal.validate_artifacts(str(ROOT / "docs" / "data"), today="2026-09-12")
note(rep["checked"] >= 1 and isinstance(rep["issues"], list),
     "validate_artifacts 能跑真实目录并返回报告", f"检查 {rep['checked']} 个文件")
note(heal.validate_artifacts(str(tmp / "不存在的目录"), today="2026-09-12")["issues"],
     "目录不存在时如实报告，不抛异常")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
