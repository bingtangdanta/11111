"""check_repo.py — 交付前自检：目录结构、workflow 结构、数据占位、无图片素材。

为什么单独写：GitHub Actions 的 workflow 一旦写错（缩进、键名、cron 格式），
只有 push 之后才会在 Actions 页面报错，来回改很费时间。这里在本地先把能查的都查掉。
（本机没有 pyyaml，所以用结构化文本检查 + 关键字段断言，而不是完整 YAML 解析。）
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
FAILED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


print("=" * 78)
print("仓库自检")
print("=" * 78)

# ---------- 1. 必要文件 ----------
must = [
    "docs/index.html", "docs/style.css", "docs/app.js", "docs/data/version.json",
    "scripts/common.py", "scripts/chips.py", "scripts/indicators.py",
    "scripts/scoring.py", "scripts/sources.py", "scripts/fetch_data.py",
    ".github/workflows/update.yml", ".gitignore", "README.md",
    # 自检报告：它记录了"已知弱点 + 优先级"，跟代码一起进仓库才不会丢
    "AUDIT.md",
]
for f in must:
    p = ROOT / f
    note(p.exists() and p.stat().st_size > 0, f"存在 {f}",
         f"{p.stat().st_size} B" if p.exists() else "缺失")

# ---------- 2. workflow ----------
wf = (ROOT / ".github/workflows/update.yml").read_text(encoding="utf-8")
note("on:" in wf, "workflow 有 on 段")
note("schedule:" in wf, "有 schedule（定时触发）")
crons = re.findall(r'cron:\s*"([^"]+)"', wf)
note(len(crons) >= 2, "至少两条 cron", str(crons))
for c in crons:
    parts = c.split()
    ok = len(parts) == 5 and all(re.fullmatch(r"[\d\*,\-/]+", p) for p in parts)
    note(ok, f"cron 格式合法：{c}", "分 时 日 月 周")
note(any("8,10,12" in c for c in crons), "含北京 16/18/20 点档（UTC 8/10/12）")
note("workflow_dispatch:" in wf, "支持手动触发（workflow_dispatch）")
note("permissions:" in wf and "contents: write" in wf, "声明 contents: write（否则无法提交数据）")
note("actions/checkout@v4" in wf, "使用 actions/checkout@v4")
note("actions/setup-python@v5" in wf, "使用 actions/setup-python@v5")
note("git commit" in wf and "git push" in wf, "有提交并推送数据的步骤")
note("git diff --cached --quiet" in wf, "无变化时跳过提交（避免空提交刷屏）")
note("concurrency:" in wf, "有 concurrency（避免两次抓取互相覆盖）")
note("timeout-minutes:" in wf, "有超时保护")
note("ASHARE_TOP_N" in wf or "--top" in wf, "传递了每日高评分只数")
note("HITHINK_FINANCE_API_KEY" in wf, "预留了同花顺 Key（走 Secrets，可选）")
# 缩进一致性（YAML 用空格，不能有 tab）
note("\t" not in wf, "workflow 里没有 Tab（YAML 禁用 Tab 缩进）")

# ---------- 3. 占位数据 ----------
v = json.loads((ROOT / "docs/data/version.json").read_text(encoding="utf-8"))
note("slots" in v and v["slots"] == ["16:00", "18:00", "20:00"], "占位 version.json 档位正确")
note(v.get("placeholder") is True, "标记为占位文件（页面会提示先跑一次 Actions）")

# ---------- 4. 前端硬性约束 ----------
html = (ROOT / "docs/index.html").read_text(encoding="utf-8")
css = (ROOT / "docs/style.css").read_text(encoding="utf-8")
js = (ROOT / "docs/app.js").read_text(encoding="utf-8")
note("<img" not in html.lower(), "HTML 里没有 <img>（纯 CSS，无图片素材）")
note("http://" not in css.replace("http://www.w3.org", "") and "url(" not in css.replace("url(#", ""),
     "CSS 没有外链图片/字体")
# 「不引用 CDN」应该查**真实的外链引用**，而不是查源码里有没有出现 "cdn" 这几个字母：
#   · 源码注释里写"为什么不用 CDN 的分栏库"是很正常的说明文字，不该让自检失败
#   · 真正危险的是 <script src="http...">、<link href="http...">、@import url(http...)
ext_js = re.findall(r"""(?:src|href)\s*=\s*["']https?://""", html + js)
ext_css = re.findall(r"""@import\s+(?:url\()?["']?https?://""", css)
note(not ext_js and not ext_css, "没有引用任何外部 CDN/脚本（页面是自包含的）",
     f"发现 {ext_js + ext_css}")
note("#e64545" in (css + js) and "#20a67a" in (css + js), "红涨(#e64545)/绿跌(#20a67a)")
# 过渡时长/缓动统一由 CSS 变量管理（0.46s + 缓出曲线 = iOS/MIUI 手感）
note("--dur:.46s" in css.replace(" ", "") and "--ease:cubic-bezier(.22,1,.36,1)" in css.replace(" ", ""),
     "统一过渡（--dur .46s + --ease 缓出曲线）")
note("slotpick" in js and "assignSlot" in js and "SLOTS_KEY" in js,
     "三个界面：每个界面头部有模块下拉，换内容并持久化")
note("beginPointerDrag" in js and "slotAtPoint" in js
     and "droptarget" in css,
     "拖动顶部模块用 pointer 跟手拖拽（不是原生 DnD 的虚线遮罩）")
note(".slothead" in css and "zoom-mode" in css, "界面头部与放大模式样式存在")
note("grid-template-columns:repeat(3,minmax(0,1fr))" in css.replace(" ", ""),
     "横屏固定三列（不随宽度变列数）")
note("@media (max-width:1079px)" in css and "@media (min-width:1080px)" in css,
     "横竖屏断点存在（1080px）")
note(".modbar{display:none}" in css.replace(" ", "") and ".vswitch{display:flex}" in css.replace(" ", ""),
     "竖屏隐藏横向切换条、显示竖排切换按钮")
note("./data/" in js, "前端读相对路径 ./data/")
note("sortRows" in js and 'data-sort="score"' not in js and "th(\"score\"" in js,
     "评分列可排序（sortRows + 表头点击）")
note("MODULES" in js, "模块清单存在")
# 本轮修正：筹码配色 + 叠加线 + 搜索评分榜
# 注意：右侧已经把 css 的空格全部删掉，所以选择器里的空格也要跟着删
note(".chip-row.trapped.b>i{background:var(--blue)}" in css.replace(" ", ""),
     "筹码：现价以上=蓝色（套牢盘），且不拆开分布")
note(".chip-row.profit.b>i{background:var(--up)}" in css.replace(" ", ""),
     "筹码：现价以下=红色（获利盘）")
note("chip-line avg" in js and ".chip-line.avg{border-top-style:dashed;border-color:var(--purple)}"
     in css.replace(" ", ""), "现价黄线 + 平均筹码紫线（叠加在图上）")
note("今日评分榜" in js, "搜索框空输入直接列出今日评分榜（含每只评分）")
# 本轮新增：场外 ETF 模块 + 三块↔一块 的进出场动画 + 时点提示
note('id: "funds"' in js and "function fillFunds(" in js and 'api("funds")' in js,
     "场外 ETF 模块存在（独立取数 + 独立渲染）")
note("function playZoomTx(" in js and "function captureZoomRects(" in js,
     "三块 ↔ 一块 的进出场动画存在")
note(".zoomghost{" in css.replace(" ", ""), "幽灵卡样式存在（只动 transform/opacity）")
note("zoomghost" in js and "cloneNode" not in js.split("function playZoomTx(")[1].split("function ")[0],
     "幽灵卡是轻量 div，不克隆面板 DOM")
note('id="snapTip"' in html and "post_close_snapshot" in js,
     "顶部会显示「这份快照是不是收盘价」（时点提示，可用产物里的存档标记核对）")

# ---------- 5. Python 脚本约束 ----------
for f in ("common.py", "sources.py", "fetch_data.py"):
    src = (ROOT / "scripts" / f).read_text(encoding="utf-8")
    bad = [m for m in ("import requests", "import pandas", "import numpy", "import akshare")
           if m in src]
    note(not bad, f"{f} 只用标准库（不依赖第三方包）", f"发现 {bad}" if bad else "")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
