"""pit_test.py — 时点纪律（point-in-time）测试：**盘后消息不得进入当天评分**。

为什么必须先做这条：免费接口只给日期不给时分，一旦拿"当天盘后发布"的研报去解释
"当天走势"，回测会好看得离谱、实盘一用就废。规则必须写在代码里，而不是靠"反正跑得晚"。

这里用桩函数造出"今天 18:32 发布"和"昨天发布"的两条研报 + 两条调研，断言：
  · as_of = 今天 16:05 时 → 只看到昨天那条（今天的看不到）
  · as_of = 明天 09:00 时 → 两条都能看到（今天的变成"昨天"了）
  · available_at 字段本身算得对（无时分的按 23:59 保守处理）
"""

from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

import sources as src      # noqa: E402
import fetch_data as fd    # noqa: E402
from common import CN_TZ   # noqa: E402  （东八区；生产环境 now_cn() 就是带这个时区的）

FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


print("=" * 78)
print("① available_at / filter_as_of 的基础行为")
print("=" * 78)
note(src.available_at("2026-09-11") == datetime(2026, 9, 11, 0, 0, tzinfo=CN_TZ),
     "只有日期时返回当天 00:00（带东八区）", str(src.available_at("2026-09-11")))
note(src.available_at("2026-09-11", assume_time=src.ASSUMED_AVAILABLE_TIME)
     == datetime(2026, 9, 11, 23, 59, tzinfo=CN_TZ),
     "指定 assume_time 时按 23:59 保守处理",
     str(src.available_at("2026-09-11", assume_time=src.ASSUMED_AVAILABLE_TIME)))
note(src.available_at("2026-09-11 18:32") == datetime(2026, 9, 11, 18, 32, tzinfo=CN_TZ),
     "带时分的字符串按真实时分解析")
note(src.available_at("") is None and src.available_at(None) is None, "空值返回 None（不抛错）")

rows = [{"available_at": datetime(2026, 9, 10, 23, 59)}, {"available_at": datetime(2026, 9, 11, 23, 59)}]
note(len(src.filter_as_of(rows, datetime(2026, 9, 11, 16, 5))) == 1,
     "as_of=9/11 16:05 → 只剩 9/10 那条")
note(len(src.filter_as_of(rows, datetime(2026, 9, 12, 9, 0))) == 2,
     "as_of=9/12 09:00 → 两条都在")
note(len(src.filter_as_of(rows, None)) == 2, "as_of=None 时不过滤（显式关闭）")

print()
print("=" * 78)
print("①b 带时区的时间也要能比（生产环境 as_of 来自 now_cn()，是 aware 的）")
print("=" * 78)
# 这条是**真跑一轮之后补上的**：单元测试当时两边都用 naive，掩盖了
# "naive 与 aware 不能比较"的 TypeError，结果本地抓取跑十几分钟后崩在 build_research。
aware = datetime(2026, 9, 11, 16, 5, tzinfo=CN_TZ)
naive_rows = [{"available_at": "2026-09-10"}, {"available_at": "2026-09-11"}]
try:
    kept = src.filter_as_of(naive_rows, aware)
    note(len(kept) == 1, "aware 的 as_of 与字符串日期行也能安全比较（不抛 TypeError）",
         f"保留 {len(kept)} 行")
except TypeError as exc:
    note(False, "aware 的 as_of 与字符串日期行比较不应抛异常", str(exc))
try:
    kept2 = src.filter_as_of([{"available_at": datetime(2026, 9, 10, 23, 59)}], aware)
    note(len(kept2) == 1, "naive 行也会被补上时区后比较（不抛异常）", f"保留 {len(kept2)} 行")
except TypeError as exc:
    note(False, "naive 行与 aware as_of 比较不应抛异常", str(exc))
note(src.available_at("2026-09-11", assume_time=(23, 59)).tzinfo is not None,
     "available_at 返回带时区的时间", str(src.available_at("2026-09-11", assume_time=(23, 59))))
note(src.is_post_close(datetime(2026, 9, 11, 16, 5, tzinfo=CN_TZ)) is True,
     "is_post_close 对 aware 时间同样有效")

print()
print("=" * 78)
print("①c 归档日期必须来自**行情自己的时间戳**，不是墙上时钟")
print("=" * 78)
# 这一组是 2026-09-12（周六）手动跑真实抓取时抓出来的：
#   日志报"现在是盘中（12:02）"，而且 trade_date 会被写成**周六** ——
#   而回评（次日涨跌幅）和历史都是用 trade_date 当键的，
#   写错一天，胜率/平均涨幅会算在一组根本不存在的日期上，且看起来完全正常。
note(src.is_post_close(datetime(2026, 9, 12, 12, 2, tzinfo=CN_TZ)) is True,
     "周六中午算「已收盘」（不开市，行情就是上一交易日的收盘价）")
note(src.is_post_close(datetime(2026, 9, 13, 9, 0, tzinfo=CN_TZ)) is True, "周日清晨同理")
note(src.is_post_close(datetime(2026, 9, 11, 12, 0, tzinfo=CN_TZ)) is False,
     "工作日中午仍是「盘中」（这才是真的盘中，不能被误判成收盘）")
note(src.is_post_close(datetime(2026, 9, 11, 15, 0, tzinfo=CN_TZ)) is True, "工作日 15:00 收盘")
_note_text = src.session_note(datetime(2026, 9, 12, 12, 2, tzinfo=CN_TZ),
                              datetime(2026, 9, 11, 15, 0, tzinfo=CN_TZ))
note("2026-09-11" in _note_text and "收盘价" in _note_text,
     "session_note 会指出「行情时间与当前日期不同 → 是上一交易日的收盘价」", _note_text)
note("盘中" in src.session_note(datetime(2026, 9, 11, 11, 0, tzinfo=CN_TZ), None),
     "工作日上午的说明里明确写「盘中价」")
note(src.last_snapshot_quote_time() is None,
     "还没抓快照时，行情时间访问器返回 None（上层退回墙上时钟，不编一个时间出来）")

print()
print("=" * 78)
print("② 研报：盘后 18:32 发布的，当天看不到、次日才看得到")
print("=" * 78)
REPORTS = {"data": [
    {"publishDate": "2026-09-10 00:00:00", "stockCode": "600519", "stockName": "贵州茅台",
     "orgSName": "某券商", "title": "昨天的研报", "emRatingName": "买入"},
    {"publishDate": "2026-09-11 00:00:00", "stockCode": "000636", "stockName": "风华高科",
     "orgSName": "另一券商", "title": "今天的研报", "emRatingName": "增持"},
]}
SURVEY = {"result": {"data": [
    {"SECURITY_CODE": "600519", "SECURITY_NAME_ABBR": "贵州茅台",
     "RECEIVE_START_DATE": "2026-09-09 00:00:00", "NOTICE_DATE": "2026-09-10 00:00:00", "NUM": 12},
    {"SECURITY_CODE": "000636", "SECURITY_NAME_ABBR": "风华高科",
     "RECEIVE_START_DATE": "2026-09-11 00:00:00", "NOTICE_DATE": "2026-09-11 00:00:00", "NUM": 5},
]}}

orig_get = src.get_json
src.get_json = lambda *a, **k: (REPORTS if k.get("path") == "/report/list" else SURVEY)

r_today = src.reports(qtype=0, as_of=datetime(2026, 9, 11, 16, 5))
note(len(r_today) == 1 and r_today[0]["code"] == "600519",
     "as_of=9/11 16:05：只拿到 9/10 那条研报（今天的被挡住）",
     "、".join(x["code"] for x in r_today))
note(all(x.get("available_at") for x in r_today), "每行都带 available_at（可追溯）",
     str(r_today[0].get("available_at")))

r_next = src.reports(qtype=0, as_of=datetime(2026, 9, 12, 9, 0))
note(len(r_next) == 2, "as_of=9/12 09:00：两条都在（今天的变成可用了）",
     "、".join(x["code"] for x in r_next))

s_today = src.org_survey(as_of=datetime(2026, 9, 11, 16, 5))
note(len(s_today) == 1 and s_today[0]["code"] == "600519",
     "调研同理：9/11 的调研当天看不到", "、".join(x["code"] for x in s_today))
s_next = src.org_survey(as_of=datetime(2026, 9, 12, 9, 0))
note(len(s_next) == 2, "次日两条都在")
note(all(x.get("available_at") for x in s_next), "调研也带 available_at",
     str(s_next[0].get("available_at")))

print()
print("=" * 78)
print("③ 主流程真的把 as_of 传下去了（不是只在 sources 里修）")
print("=" * 78)
src.get_json = orig_get
seen: dict = {}
orig_build = fd.build_research


def spy_build(codes, day, as_of=None):
    seen["as_of"] = as_of
    seen["day"] = day
    return {"generated_at": "", "as_of": as_of.strftime("%Y-%m-%d %H:%M") if as_of else None,
            "survey": [], "survey_total": 0, "survey_filtered": {}, "reports_stock": [],
            "reports_industry": [], "ratings": {}, "stance_note": ""}


fd.build_research = spy_build
try:
    fd.run(str(ROOT / "_test_out" / "pit"), research_only=True)
except SystemExit as exc:            # 数据源不可用时也不影响本断言
    print(f"  （run 提前退出：{exc}）")
except Exception as exc:             # noqa: BLE001
    print(f"  （run 抛异常，但不影响 as_of 断言：{type(exc).__name__}）")
finally:
    fd.build_research = orig_build

note(isinstance(seen.get("as_of"), datetime), "run() 调用 build_research 时传了 as_of",
     str(seen.get("as_of")))
if isinstance(seen.get("as_of"), datetime):
    note(seen["day"] == seen["as_of"].date(), "day 与 as_of 是同一天（不会错位）",
         f"{seen['day']} / {seen['as_of']}")

print()
print("=" * 78)
print("④ research.json 里写明了口径（页面上要能看到这条规则）")
print("=" * 78)
payload = spy_build([], datetime(2026, 9, 11, 16, 5).date(), datetime(2026, 9, 11, 16, 5))
note("as_of" in payload, "产物体里有 as_of")
out = orig_build.__doc__ or ""
note("时点纪律" in out, "build_research 文档里写明时点纪律")
src_text = (ROOT / "scripts" / "sources.py").read_text(encoding="utf-8")
note("防未来函数" in src_text and "ASSUMED_AVAILABLE_TIME" in src_text,
     "sources.py 里有显式的时点规则与保守可得时刻")

print()
print("=" * 78)
print("⑤ 快照是不是「收盘快照」也要标出来（盘中手动跑 = 时点污染）")
print("=" * 78)
note(src.is_post_close(datetime(2026, 9, 11, 16, 5)) is True, "16:05 判定为收盘后")
note(src.is_post_close(datetime(2026, 9, 11, 11, 0)) is False, "11:00 判定为盘中（不是收盘价）")
note(src.is_post_close(datetime(2026, 9, 11, 15, 0)) is True, "15:00 整点算收盘后（边界）")
fd_text = (ROOT / "scripts" / "fetch_data.py").read_text(encoding="utf-8")
note("post_close_snapshot" in fd_text and "is_post_close" in fd_text,
     "主流程会把 post_close_snapshot 写进产物（可供校验）")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
