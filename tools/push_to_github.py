"""push_to_github.py — 把本仓库直接推到 GitHub 并打开 Pages（不需要安装 git）。

为什么写这个：本机（以及不少办公电脑）**没有装 git**，而 GitHub 网页版一次最多拖 100 个文件、
还得手动建目录。这个脚本用 GitHub 官方 REST API（标准库 urllib 就够了）把仓库一次性建好、传完、
并把 Pages 打开，最后打印访问地址。

用法（PowerShell）：
    $env:GITHUB_TOKEN = "ghp_xxx"                 # 令牌，见下面的权限要求
    python tools/push_to_github.py --repo ashare-hunter --public

    # 或者把令牌写进文件（别提交到仓库里！）
    python tools/push_to_github.py --repo ashare-hunter --token-file D:\\token.txt

令牌权限（GitHub → Settings → Developer settings → Personal access tokens）：
    · Fine-grained token：勾 Repository permissions → Contents: Read and write、
      Workflows: Read and write、Administration: Read and write（要建仓库和开 Pages）
    · Classic token：勾 repo + workflow

说明：
    · 只会推 docs/ scripts/ checks/ tools/ .github/ README.md .gitignore，
      不会推 _preview/ _demo*/ _test_out/ __pycache__/（那些是本地预览与临时产物）。
    · 目标是**公开仓库**（只有公开仓库的 Pages 免费）。你的选股会公开可见，
      不接受这点就不要用 --public，改用私有仓库 + 本地预览。
    · 重复执行是安全的：文件内容一致时 GitHub 会返回"没有变化"，脚本会跳过。
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
API = "https://api.github.com"

# 要推送的路径（文件或目录），以及永远不推的目录名
INCLUDE = ["docs", "scripts", "checks", "tools", ".github", "README.md", ".gitignore"]
EXCLUDE_DIRS = {"_preview", "_demo_data", "_demo2", "_test_out", "_debug", "__pycache__",
                ".git", "node_modules", ".venv"}
EXCLUDE_SUFFIX = {".pyc", ".log", ".zip"}


def api(method: str, path: str, token: str, body: dict | None = None) -> tuple[int, dict]:
    """调用 GitHub API。返回 (状态码, 解析后的 JSON)。"""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "ashare-hunter-pusher")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw.decode("utf-8")) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        try:
            obj = json.loads(raw.decode("utf-8"))
        except Exception:  # noqa: BLE001
            obj = {"message": raw.decode("utf-8", errors="replace")}
        return exc.code, obj
    except Exception as exc:  # noqa: BLE001
        return 0, {"message": str(exc)}


def collect_files() -> list[Path]:
    out: list[Path] = []
    for item in INCLUDE:
        p = ROOT / item
        if not p.exists():
            continue
        if p.is_file():
            out.append(p)
            continue
        for f in sorted(p.rglob("*")):
            if not f.is_file():
                continue
            if any(part in EXCLUDE_DIRS for part in f.relative_to(ROOT).parts):
                continue
            if f.suffix in EXCLUDE_SUFFIX:
                continue
            out.append(f)
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description="用 GitHub API 推送仓库并开启 Pages（无需 git）")
    ap.add_argument("--repo", required=True, help="仓库名，例如 ashare-hunter")
    ap.add_argument("--token-file", help="存放令牌的文件（不想用环境变量时）")
    ap.add_argument("--desc", default="A 股盘后复盘面板（GitHub Pages 静态站 + Actions 自动抓数）")
    ap.add_argument("--branch", default="main")
    ap.add_argument("--public", action="store_true", help="建公开仓库（Pages 免费必需）")
    ap.add_argument("--skip-pages", action="store_true", help="只推代码，不动 Pages 设置")
    args = ap.parse_args()

    token = os.environ.get("GITHUB_TOKEN", "").strip()
    if not token and args.token_file:
        token = Path(args.token_file).read_text(encoding="utf-8").strip()
    if not token:
        print("❌ 没有令牌。请设置环境变量 GITHUB_TOKEN，或用 --token-file 指定文件。")
        return 2

    st, me = api("GET", "/user", token)
    if st != 200:
        print(f"❌ 令牌无效或网络不通：HTTP {st} {me.get('message')}")
        return 2
    owner = me["login"]
    print(f"✓ 已登录：{owner}")

    st, repo = api("POST", "/user/repos", token, {
        "name": args.repo,
        "description": args.desc,
        "private": not args.public,
        "auto_init": True,                       # 先有一个 main 分支的初始提交，后面直接覆盖
        "has_issues": False,
        "has_wiki": False,
    })
    if st == 201:
        print(f"✓ 已创建仓库：{repo['full_name']}（{'公开' if args.public else '私有'}）")
    elif st == 422:
        print(f"· 仓库已存在，直接往里推：{owner}/{args.repo}")
    else:
        print(f"❌ 建仓库失败：HTTP {st} {repo.get('message')}")
        return 2

    files = collect_files()
    print(f"· 待推送文件：{len(files)} 个（已排除 _preview/_demo*/_test_out/__pycache__）")

    ok = skipped = failed = 0
    workflow_warned = False
    for f in files:
        rel = f.relative_to(ROOT).as_posix()
        content = base64.b64encode(f.read_bytes()).decode("ascii")

        # 取已存在的 sha：更新文件必须带 sha，否则 422
        st_get, cur = api("GET", f"/repos/{owner}/{args.repo}/contents/{rel}?ref={args.branch}", token)
        sha = cur.get("sha") if st_get == 200 else None
        if st_get == 200 and cur.get("content"):
            try:
                if base64.b64decode(cur["content"]).decode("utf-8") == f.read_text(encoding="utf-8"):
                    skipped += 1
                    continue                      # 内容一致，跳过（省时间也避免空提交）
            except Exception:  # noqa: BLE001
                pass

        body = {"message": f"更新 {rel}", "content": content, "branch": args.branch}
        if sha:
            body["sha"] = sha
        st_put, res = api("PUT", f"/repos/{owner}/{args.repo}/contents/{rel}", token, body)
        if st_put in (200, 201):
            ok += 1
            print(f"  ↑ {rel}")
        elif rel.startswith(".github/workflows/") and not workflow_warned:
            workflow_warned = True
            failed += 1
            print(f"  ✗ {rel} → HTTP {st_put} {res.get('message')}")
            print("    ⚠ 令牌缺少 workflow 权限。两个选择：")
            print("      1) 给令牌加上 workflow 权限（classic: 勾 workflow；fine-grained: Workflows: Read and write）后重跑")
            print("      2) 到仓库网页 Actions → New workflow → 手工粘贴本文件内容")
        else:
            failed += 1
            print(f"  ✗ {rel} → HTTP {st_put} {res.get('message')}")
        time.sleep(0.15)                          # 轻微限速，避免触发滥用检测

    print(f"✓ 推送完成：更新 {ok} / 跳过（内容一致）{skipped} / 失败 {failed}")

    if not args.skip_pages:
        st, pg = api("GET", f"/repos/{owner}/{args.repo}/pages", token)
        if st == 200:
            print(f"· Pages 已开启：{pg.get('html_url')}")
        else:
            st, pg = api("POST", f"/repos/{owner}/{args.repo}/pages", token,
                         {"source": {"branch": args.branch, "path": "/docs"}})
            if st in (201, 204):
                print(f"✓ 已开启 Pages（Deploy from branch: {args.branch} /docs）")
            else:
                print(f"⚠ 自动开启 Pages 失败：HTTP {st} {pg.get('message')}")
                print("  手动开启：仓库 Settings → Pages → Source 选 Deploy from a branch → "
                      f"{args.branch} → /docs → Save")

    print()
    print("=" * 78)
    print(f"仓库：https://github.com/{owner}/{args.repo}")
    print(f"页面：https://{owner}.github.io/{args.repo}/    （首次发布约 1~2 分钟）")
    print("=" * 78)
    print("下一步：到仓库 Actions 页面点一次 update-data（Run workflow），")
    print("       跑完会在 docs/data/ 写入真实数据，页面刷新即可看到完整面板。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
