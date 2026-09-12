"""check_encoding.py — 防止源码被"编码往返"写坏（这个坑真的踩过一次）。

事故经过：用 PowerShell 的 `Get-Content -Raw`（没写 -Encoding UTF8，于是按 GBK 解码）
读 `docs/app.js`，再 `WriteAllText` 写回 UTF-8 —— **所有中文变成 `鈥?` 这种乱码**，
而且**不可逆**（解码时非法字节被替换成 '?'，信息已经丢了），只能从旧副本恢复。

判定方法（都是"可复现、零误报"的，不靠乱码字符黑名单 —— 上一版把 银/长/高 这种
正常汉字也算成乱码，到处误报）：
  1. 必须是合法 UTF-8；不能出现替换字符 U+FFFD
  2. **关键文件必须含有哨兵短语**（例如 docs/app.js 里必须有「复盘看板」「三个界面」），
     中文一旦被搞坏，这些短语必然消失 → 直接失败
  3. 兜底：统计"乱码字母表"命中数。字母表不是手写的，而是**用本项目自己的正文
     现场推出来**（把正常文本按 UTF-8→GBK 搞坏一次，收集产生的汉字），
     正常文件命中个位数，被搞坏的文件命中成百上千。
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FAILED: list[str] = []
#: 这些目录不检查（生成物、临时、预览副本）
SKIP_DIRS = {"__pycache__", "_test_out", "_test_out2", "_shots", "_upload",
             "node_modules", ".git", "_debug", "_preview", "_demo_data", "_demo2"}
EXTS = {".py", ".js", ".mjs", ".css", ".html", ".md", ".json", ".yml", ".yaml", ".txt"}

CJK_LO, CJK_HI = 0x4E00, 0x9FFF


def mojibake(text: str) -> str:
    """复现事故机制：把文本的 UTF-8 字节按 GBK 解码。"""
    return text.encode("utf-8").decode("gbk", errors="replace")


def build_alphabet() -> set[str]:
    """用本项目自己的正文现推"乱码字母表"（比手写黑名单可靠得多）。"""
    corpus = ""
    for rel in ("README.md", "docs/app.js", "scripts/fetch_data.py", "checks/README.md"):
        p = ROOT / rel
        if p.exists():
            try:
                corpus += p.read_text(encoding="utf-8")[:20000]
            except UnicodeDecodeError:
                continue
    return {ch for ch in mojibake(corpus) if CJK_LO <= ord(ch) <= CJK_HI}


ALPHABET = build_alphabet()
#: 判定用**命中率**而不是命中个数：个数随文件大小线性增长（764 字的大文件必然命中多）。
#: 实测（_debug/measure_alpha_ratio.py）：正常文件 5%~13%，被搞坏后 84%~100%。
#: 取 50% 作阈值，两边都有很大余量。
ALPHABET_RATIO_LIMIT = 0.5

#: 哨兵短语：这些中文只要还在，就说明文件没被编码往返搞坏
SENTINELS = {
    "docs/app.js": ["复盘看板", "三个界面", "历史股评", "筹码"],
    "docs/style.css": ["界面", "滚动"],
    "docs/index.html": ["口径提示"],
    "README.md": ["量化猎人"],
    "scripts/fetch_data.py": ["可搜索库"],
    "scripts/sources.py": ["板块"],
    "checks/README.md": ["自检"],
    "tools/push_to_github.py": ["令牌"],
}

files = []
for p in ROOT.rglob("*"):
    if not p.is_file() or p.suffix.lower() not in EXTS:
        continue
    if any(part in SKIP_DIRS for part in p.relative_to(ROOT).parts):
        continue
    if p.parent.name in ("_debug", "_preview", "_demo_data", "_demo2"):
        continue
    files.append(p)

print("=" * 78)
print(f"编码自检：{len(files)} 个文本文件")
print("=" * 78)

bad_utf8: list[str] = []
bad_moji: list[str] = []
for p in sorted(files):
    raw = p.read_bytes()
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        bad_utf8.append(f"{p.relative_to(ROOT)}（{exc.reason} @{exc.start}）")
        continue
    if "\ufffd" in text:
        bad_moji.append(f"{p.relative_to(ROOT)}（U+FFFD × {text.count(chr(0xFFFD))}）")
        continue
    hits = sum(1 for ch in text if ch in ALPHABET)
    cjk = sum(1 for ch in text if CJK_LO <= ord(ch) <= CJK_HI)
    ratio = (hits / cjk) if cjk else 0.0
    if cjk >= 40 and ratio > ALPHABET_RATIO_LIMIT:
        bad_moji.append(f"{p.relative_to(ROOT)}（乱码字母表命中率 {ratio:.0%}，疑似编码往返损坏）")


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


note(not bad_utf8, "全部是合法 UTF-8", "；".join(bad_utf8) if bad_utf8 else f"{len(files)} 个文件")
note(not bad_moji, "没有被编码往返搞坏（乱码字母表命中率 / U+FFFD）",
     "；".join(bad_moji) if bad_moji else
     f"字母表 {len(ALPHABET)} 字，各文件命中率均 ≤{ALPHABET_RATIO_LIMIT:.0%}")
# 哨兵短语：中文一旦被搞坏，这些短语必然消失（比统计更直接）
for rel, words in SENTINELS.items():
    p = ROOT / rel
    if not p.exists():
        note(False, f"{rel} 存在")
        continue
    text = p.read_text(encoding="utf-8")
    missing = [w for w in words if w not in text]
    note(not missing, f"{rel} 关键中文短语完好", f"缺少 {missing}" if missing else "、".join(words))
# 关键文件必须真的有中文（防止"中文被整段替换"这种更隐蔽的损坏）
for rel, least in (("docs/app.js", 2000), ("docs/style.css", 500), ("README.md", 300)):
    p = ROOT / rel
    if not p.exists():
        note(False, f"{rel} 存在")
        continue
    text = p.read_text(encoding="utf-8")
    cn = sum(1 for ch in text if CJK_LO <= ord(ch) <= CJK_HI)
    note(cn >= least, f"{rel} 中文数量正常（≥{least} 字）", f"实测 {cn} 字")

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}")
for f in FAILED:
    print("  ❌", f)
sys.exit(1 if FAILED else 0)
