"""static_serve_test.py — 把 docs/ 当成 GitHub Pages 访问，逐条验证前端要用的文件都在。

为什么必须这么测：Pages 上没有后端，页面只会去取相对路径的 ./data/*.json。
少一个文件，页面上就有一块是空的/报错的，而本地开发时很难发现。

关于"占位数据"这个坑：
    仓库里 docs/data/ 只放一个**占位**的 version.json（真实数据由 GitHub Actions 跑完后提交）。
    如果直接拿 docs/ 测数据类断言，所有 data/*.json 都会 404 → 断言永远假失败。
    所以这里先看本地有没有演示数据（_demo2/data 或 _demo_data）：有就叠一份到临时目录里，
    按"Actions 已经跑过"的状态做**完整**数据校验；没有就只做占位校验，并明确打印说明。
"""

from __future__ import annotations

import functools
import http.server
import json
import shutil
import socketserver
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

FAILED: list[str] = []
SKIPPED: list[str] = []


def note(ok: bool, label: str, extra: str = "") -> None:
    print(f"[{'OK  ' if ok else 'FAIL'}] {label}" + (f"    {extra}" if extra else ""))
    if not ok:
        FAILED.append(label)


def skip(label: str, why: str) -> None:
    print(f"[SKIP] {label}    {why}")
    SKIPPED.append(label)


if not DOCS.exists():
    print(f"❌ 没有 {DOCS}")
    sys.exit(1)


def build_serve_root() -> tuple[Path, Path | None]:
    """返回 (托管根目录, 演示数据目录或 None)。

    docs/ 是发布目录；有演示数据时拷到临时目录并把 data/ 覆盖成真实数据，
    这样"页面文件"与"数据文件"两条线都能测到。
    临时目录放在仓库内的 _test_out/（已 gitignore），不放系统 temp：
    某些受限环境对系统 temp 没有写权限，会直接 PermissionError。
    """
    demo = None
    for cand in (ROOT / "_demo2" / "data", ROOT / "_demo_data"):
        if cand.exists() and any(cand.glob("*.json")):
            demo = cand
            break
    tmp = ROOT / "_test_out" / "static_serve"
    if tmp.exists():
        shutil.rmtree(tmp, ignore_errors=True)
    tmp.mkdir(parents=True, exist_ok=True)
    shutil.copytree(DOCS, tmp, dirs_exist_ok=True)
    if demo is not None:
        shutil.copytree(demo, tmp / "data", dirs_exist_ok=True)
    return tmp, demo


SERVE, DEMO = build_serve_root()


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):  # noqa: D102
        pass


with socketserver.TCPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(SERVE))) as httpd:
    port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    print("=" * 78)
    print(f"静态托管冒烟测试（模拟 GitHub Pages）：{base}")
    print(f"托管目录：{SERVE}")
    print(f"数据来源：{'叠加演示数据 ' + str(DEMO.relative_to(ROOT)) if DEMO else '仅仓库占位文件（未跑过 Actions）'}")
    print("=" * 78)

    def get(path: str):
        try:
            with urllib.request.urlopen(base + path, timeout=20) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as exc:
            return exc.code, b""
        except Exception as exc:  # noqa: BLE001
            return 0, str(exc).encode()

    st, html = get("/index.html")
    text = html.decode("utf-8", errors="replace")
    note(st == 200, "index.html 可访问", f"HTTP {st}, {len(html)} 字节")
    note("style.css" in text and "app.js" in text, "引用了 style.css 与 app.js")
    note("<img" not in text.lower(), "页面里没有任何 <img>（纯 CSS，无图片素材）")
    for p in ("/style.css", "/app.js"):
        st2, body = get(p)
        note(st2 == 200 and len(body) > 500, f"{p} 可访问", f"HTTP {st2}, {len(body)} 字节")
    # 三种切换入口都要在页面里
    note('id="modbar"' in text, "页面含顶部横向切换条（横屏用）")
    note('id="vswitch"' in text, "页面含竖排切换按钮（竖屏用）")
    note('id="searchInput"' in text and 'id="searchRes"' in text, "页面含搜索框与结果面板")

    js = (SERVE / "app.js").read_text(encoding="utf-8")
    css = (SERVE / "style.css").read_text(encoding="utf-8")
    flat_css = css.replace(" ", "").replace("\n", "")
    note("./data/" in js, "前端读相对路径 ./data/（Pages 子路径必需）")
    note("url(ht" not in css and "background-image" not in css, "CSS 里没有外链图片/背景图")
    note("--dur:.46s" in flat_css and "--ease:cubic-bezier(.22,1,.36,1)" in flat_css,
         "统一过渡变量（0.46s + 缓出曲线，iOS/MIUI 手感）")
    note("--r-card:14px" in flat_css and "border-radius:var(--r-card)" in flat_css,
         "卡片大圆角 14px（用 CSS 变量统一管理）")
    note("grid-template-columns:repeat(3,minmax(0,1fr))" in flat_css,
         "横屏固定三列（不随宽度变列数）")
    note(".modbar{display:none}" in flat_css and ".vswitch{display:flex}" in flat_css,
         "竖屏隐藏横向切换条、显示竖排切换按钮")

    # ---------- 前端会请求的数据文件（与 app.js 里的 api("xxx") 一一对应） ----------
    need = ["version", "dashboard", "limitup", "screen", "sectors", "dragon",
            "research", "index_kline", "universe", "history"]
    payloads: dict[str, object] = {}
    for n in need:
        st3, raw = get(f"/data/{n}.json")
        ok = st3 == 200
        obj = None
        if ok:
            try:
                obj = json.loads(raw.decode("utf-8"))
            except ValueError:
                ok = False
        payloads[n] = obj
        if DEMO is None:
            # 还没跑过 Actions：version.json 之外的文件本来就不存在，这是**预期**状态
            if n == "version":
                note(ok, "data/version.json 存在且合法", f"HTTP {st3}, {len(raw)} 字节")
            elif ok:
                note(True, f"data/{n}.json 已提前存在", f"HTTP {st3}, {len(raw)} 字节")
            continue
        note(ok, f"data/{n}.json 存在且合法", f"HTTP {st3}, {len(raw)} 字节")

    v = payloads.get("version") or {}
    if DEMO is None:
        note(bool(v) and v.get("placeholder") is True,
             "占位模式：version.json 标记 placeholder（页面会提示先跑 Actions）")
        skip("数据内容类断言（Top 榜 / 个股 K 线 / 大盘指数 / 可搜索库）",
             "本机没有演示数据；跑一次 python scripts/fetch_data.py 或 Actions 后再测")
    else:
        # 选股榜里的每只股票都要有详情文件（点进去不能 404）
        screen = payloads.get("screen") or {}
        top = (screen.get("top") or []) if isinstance(screen, dict) else []
        missing_top = [c for c in top if get(f"/data/stock/{c}.json")[0] != 200]
        note(bool(top), "筛选结果里有 Top 榜", f"{len(top)} 只")
        note(not missing_top, "Top 榜里每只都有个股详情文件",
             f"缺失 {missing_top}" if missing_top else "全部命中")

        # 个股详情内容（K 线 + 筹码 + 评分 + 基本面 + 建议）
        if top:
            st6, raw = get(f"/data/stock/{top[0]}.json")
            d = json.loads(raw.decode("utf-8")) if st6 == 200 else {}
            kl = d.get("kline") or {}
            note(len(kl.get("dates") or []) >= 60, f"{top[0]} 个股 K 线根数充足",
                 f"{len(kl.get('dates') or [])} 根")
            chip = d.get("chip") or {}
            note(chip.get("profit_ratio_pct") is not None, "个股含获利盘估算",
                 f"{chip.get('profit_ratio_pct')}%")
            note(chip.get("trapped_ratio_pct") is not None, "个股含套牢盘估算",
                 f"{chip.get('trapped_ratio_pct')}%")
            note(bool(chip.get("rows")), "筹码直方图行数据存在", f"{len(chip.get('rows') or [])} 行")
            note(bool(chip.get("avg_cost")), "个股含平均筹码成本（紫线要用）",
                 str(chip.get("avg_cost")))
            note(bool((d.get("advice") or {}).get("label")), "个股含量化倾向（看多/看空）",
                 str((d.get("advice") or {}).get("label")))
            note((d.get("fund") or {}).get("score") is not None, "个股含基本面评分")
            note(bool((d.get("score") or {}).get("parts")), "个股含评分构成明细")

        # 大盘 K 线
        idx = payloads.get("index_kline") or {}
        if isinstance(idx, dict):
            note(len(idx) >= 3, "大盘 K 线指数数量 ≥3", f"{len(idx)} 个")
            for code, obj in list(idx.items())[:1]:
                kl = (obj or {}).get("kline") or {}
                note(len(kl.get("dates") or []) >= 60, f"{code} K 线根数充足",
                     f"{len(kl.get('dates') or [])} 根")

        # 可搜索库（搜索框 + 今日评分榜要用）
        uni = payloads.get("universe") or {}
        if isinstance(uni, dict):
            rows = uni.get("rows") or []
            note(len(rows) > 1000, "可搜索库覆盖全市场", f"{len(rows)} 只")
            note(all("score" in r and "advice" in r for r in rows[:200]),
                 "可搜索库每行都带评分与量化倾向（搜索框里能直接看到）")

    # ---------- version.json 关键字段（顶部状态栏要显示） ----------
    if isinstance(v, dict):
        for k in ("trade_date", "slot", "generated_at", "slots", "sources", "disclaimer"):
            note(k in v, f"version.json 含 {k}", str(v.get(k))[:40])
        note(v.get("slots") == ["16:00", "18:00", "20:00"], "档位=16:00/18:00/20:00")

    httpd.shutdown()

print()
print("=" * 78)
print(f"失败项：{len(FAILED)}    跳过：{len(SKIPPED)}")
for f in FAILED:
    print("  ❌", f)
for f in SKIPPED:
    print("  ⏭ ", f)
shutil.rmtree(SERVE, ignore_errors=True)
sys.exit(1 if FAILED else 0)
