"""lint_names.py — 作用域检查器：抓 NameError / UnboundLocalError 类 bug。

为什么需要：这类问题**编译期不报错**，只有真跑到那一行才炸，本次开发已被咬三次：
    · mobile_server.py 用了 os 却没 import
    · sources.py 用了 log 却没定义 logger
    · fetch_data.py 里 has_detail 在赋值前被使用（跑到写 JSON 才崩，整轮数据全没产出）

pyflakes 装不上（沙箱限制），所以用标准库 ast 自己实现。要点：
  · **按作用域递归**：module → function → nested function，逐层解析，
    import 必须注册进作用域（第一版忘了注册 import，导致把 math/os/json 全报成未定义）。
  · 名字解析顺序：当前作用域（参数/赋值/for/with/推导式/except/嵌套 def）→ 外层函数 → 模块 → builtins。
  · 顺序检查：同一作用域内"使用行号 < 首次赋值行号"才报（跨作用域/跨分支不算，避免误报）。

用法：python _debug/lint_names.py [目录，默认 ../scripts]
"""

from __future__ import annotations

import ast
import builtins
import sys
from pathlib import Path

# Windows 控制台默认 GBK，打印 ✅/❌ 会 UnicodeEncodeError（检查器自己先崩，等于白跑）
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BUILTINS = set(dir(builtins)) | {"__file__", "__name__", "__doc__", "self", "cls"}
HARD: list[str] = []
SOFT: list[str] = []


class Scope:
    def __init__(self, kind: str, name: str, parent: "Scope | None" = None) -> None:
        self.kind = kind
        self.name = name
        self.parent = parent
        self.bound: dict[str, int] = {}     # 名字 → 最早绑定行
        self.globals_: set[str] = set()
        #: 只由推导式绑定过的名字（这类名字的"行号顺序"没有意义，
        #  例如 {k: v["x"] for k, v in d.items()} 的值表达式在 for 子句**上一行**，
        #  按行号比会误报"使用早于赋值"）
        self.comp_names: set[str] = set()

    def bind(self, name: str, line: int) -> None:
        # ⚠️ 取**最小行号**，不是"首次登记的行号"。
        #    第一版用 setdefault，于是"预扫描时先遇到的绑定"会覆盖更早的行号，
        #    把 `[b for b in xs if b]` 这种（推导式变量在 61 行、循环里又有个 b 在 87 行）
        #    误报成"使用早于赋值"。取最小值才是"这个名字最早出现的位置"。
        old = self.bound.get(name)
        if old is None or line < old:
            self.bound[name] = line

    def resolve(self, name: str) -> bool:
        scope: Scope | None = self
        while scope is not None:
            if name in scope.bound:
                return True
            scope = scope.parent
        return name in BUILTINS


def bind_target(node: ast.AST, scope: Scope, line: int) -> None:
    if isinstance(node, ast.Name):
        scope.bind(node.id, line)
    elif isinstance(node, (ast.Tuple, ast.List)):
        for elt in node.elts:
            bind_target(elt, scope, line)
    elif isinstance(node, ast.Starred):
        bind_target(node.value, scope, line)


def prebind(body: list[ast.stmt], scope: Scope) -> None:
    """
    预扫描一个作用域的**所有**绑定（Python 的作用域是整个函数级别，不看语句顺序）。

    ⚠️ 只扫描"本层"语句，不进入嵌套函数体（嵌套函数有它自己的作用域）。
    """
    for stmt in body:
        if isinstance(stmt, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # ⚠️ 只把**函数名**绑到外层；参数属于函数自己的作用域。
            #    早期版本把参数也绑到外层，于是函数内部对参数的引用会"穿透"到外层去解析：
            #    一旦函数体里**又给这个参数赋了值**（例如 `as_of = _as_aware(as_of)`），
            #    内层的赋值行号（更大）就会盖过参数，误报"使用早于赋值"——
            #    一个正确的写法被自己的检查器判红，这种误报比不检查更坏。
            scope.bind(stmt.name, stmt.lineno)
        elif isinstance(stmt, ast.ClassDef):
            scope.bind(stmt.name, stmt.lineno)
        elif isinstance(stmt, ast.Assign):
            for t in stmt.targets:
                bind_target(t, scope, stmt.lineno)
        elif isinstance(stmt, (ast.AugAssign, ast.AnnAssign)):
            bind_target(stmt.target, scope, stmt.lineno)
        elif isinstance(stmt, (ast.For, ast.AsyncFor)):
            bind_target(stmt.target, scope, stmt.lineno)
        elif isinstance(stmt, ast.With):
            for item in stmt.items:
                if item.optional_vars is not None:
                    bind_target(item.optional_vars, scope, stmt.lineno)
        elif isinstance(stmt, ast.Try):
            for h in stmt.handlers:
                if h.name:
                    scope.bind(h.name, h.lineno)
        elif isinstance(stmt, ast.Global):
            scope.globals_.update(stmt.names)
            for n in stmt.names:
                scope.bind(n, stmt.lineno)
        elif isinstance(stmt, (ast.Import, ast.ImportFrom)):
            for a in getattr(stmt, "names", []):
                scope.bind((a.asname or a.name).split(".")[0], stmt.lineno)
        elif isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Lambda):
            for a in stmt.value.args.args:
                scope.bind(a.arg, stmt.lineno)
        # 复合语句要下钻（if/for/while/try/with 里的赋值也是本作用域绑定）
        for field in ("body", "orelse", "finalbody"):
            inner = getattr(stmt, field, None)
            if isinstance(inner, list):
                prebind(inner, scope)
        if isinstance(stmt, ast.Try):
            for h in stmt.handlers:
                prebind(h.body, scope)
        if isinstance(stmt, (ast.If, ast.While, ast.For, ast.AsyncFor)):
            prebind(getattr(stmt, "body", []), scope)


def collect_lambda_bindings(body: list[ast.stmt], scope: Scope) -> None:
    for node in ast.walk(ast.Module(body=body, type_ignores=[])):
        if isinstance(node, ast.comprehension):
            before = set(scope.bound)
            bind_target(node.target, scope, getattr(node.target, "lineno", 0))
            for nm in set(scope.bound) - before:
                scope.comp_names.add(nm)
            for nm in _target_names(node.target):
                scope.comp_names.add(nm)
        elif isinstance(node, ast.Lambda):
            for a in node.args.args:
                scope.bind(a.arg, node.lineno)


def _target_names(node: ast.AST) -> list[str]:
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, (ast.Tuple, ast.List)):
        out: list[str] = []
        for elt in node.elts:
            out.extend(_target_names(elt))
        return out
    if isinstance(node, ast.Starred):
        return _target_names(node.value)
    return []


class Checker(ast.NodeVisitor):
    def __init__(self, path: Path) -> None:
        self.path = path

    def check(self, tree: ast.Module) -> None:
        self.scope = Scope("module", "<module>")
        prebind(tree.body, self.scope)
        collect_lambda_bindings(tree.body, self.scope)
        self.report_unused_imports(tree)
        self.visit_body(tree.body)

    # ---- 作用域进入 ----
    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        self._function(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self._function(node)

    def _function(self, node) -> None:
        parent = self.scope
        inner = Scope("function", node.name, parent)
        # ⚠️ 参数绑定在**函数自己的**作用域，且行号取 def 那一行（早于函数体）。
        #    这才是 Python 的真实语义（参数在进入函数体前就存在），
        #    也避免"函数体内再次给参数赋值"时被误判成"使用早于赋值"。
        a = node.args
        for arg in (a.posonlyargs + a.args + a.kwonlyargs):
            inner.bind(arg.arg, node.lineno)
        if a.vararg:
            inner.bind(a.vararg.arg, node.lineno)
        if a.kwarg:
            inner.bind(a.kwarg.arg, node.lineno)
        prebind(node.body, inner)
        collect_lambda_bindings(node.body, inner)
        # 默认值表达式是在**外层**作用域求值的，先在外层检查
        for d in list(node.args.defaults) + [d for d in node.args.kw_defaults if d]:
            self.visit(d)
        self.scope = inner
        self.visit_body(node.body)
        self.scope = parent

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        parent = self.scope
        inner = Scope("class", node.name, parent)
        prebind(node.body, inner)
        self.scope = inner
        self.visit_body(node.body)
        self.scope = parent

    def visit_Lambda(self, node: ast.Lambda) -> None:
        parent = self.scope
        inner = Scope("lambda", "<lambda>", parent)
        for a in node.args.args:
            inner.bind(a.arg, node.lineno)
        self.scope = inner
        self.visit(node.body)
        self.scope = parent

    def visit_body(self, body: list[ast.stmt]) -> None:
        for stmt in body:
            self.visit(stmt)

    # ---- 名字使用 ----
    def visit_Name(self, node: ast.Name) -> None:
        if not isinstance(node.ctx, ast.Load):
            return
        name = node.id
        if name in self.scope.globals_:
            return
        if not self.scope.resolve(name):
            HARD.append(f"{self.path.name}:{node.lineno}: 未定义的名字 '{name}'"
                        f"（作用域 {self.scope.name}）→ 运行到这里会 NameError")
            return
        # 顺序检查：同一作用域内，使用行号早于首次绑定行号
        owner = self.scope
        probe: Scope | None = self.scope
        while probe is not None:
            if name in probe.bound:
                owner = probe
                break
            probe = probe.parent
        if owner is self.scope and name in self.scope.bound:
            if name in self.scope.comp_names:      # 推导式变量不参与顺序检查
                return
            first = self.scope.bound[name]
            if node.lineno < first and name not in ("self", "cls"):
                HARD.append(f"{self.path.name}:{node.lineno}: '{name}' 在第 {node.lineno} 行使用，"
                            f"但直到第 {first} 行才赋值（作用域 {self.scope.name}）"
                            f"→ 运行到这里会 UnboundLocalError")

    def visit_Global(self, node: ast.Global) -> None:
        self.scope.globals_.update(node.names)

    def report_unused_imports(self, tree: ast.Module) -> None:
        imported: dict[str, int] = {}
        for node in tree.body:      # 只看顶层 import
            if isinstance(node, ast.Import):
                for a in node.names:
                    imported.setdefault((a.asname or a.name).split(".")[0], node.lineno)
            elif isinstance(node, ast.ImportFrom):
                for a in node.names:
                    if a.name != "*" and a.name != "annotations":
                        imported.setdefault(a.asname or a.name, node.lineno)
        used = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        used |= {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        for name, line in imported.items():
            root = name.split(".")[0]
            if root not in used:
                SOFT.append(f"{self.path.name}:{line}: 导入了 '{name}' 但没用到")


def main() -> int:
    root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent.parent / "scripts"
    files = sorted(p for p in root.glob("*.py") if p.name != "__init__.py")
    print("=" * 78)
    print(f"作用域静态检查：{root}（{len(files)} 个文件）")
    print("=" * 78)
    for f in files:
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"), filename=str(f))
        except SyntaxError as exc:
            HARD.append(f"{f.name}:{exc.lineno}: 语法错误 {exc.msg}")
            continue
        Checker(f).check(tree)
    # 去重（同一处可能被多次报告）
    for msg in dict.fromkeys(HARD):
        print("  ❌ " + msg)
    for msg in dict.fromkeys(SOFT):
        print("  ⚠️  " + msg)
    if not HARD:
        print("  ✅ 没有未定义名 / 使用顺序问题")
    print()
    print(f"严重问题：{len(set(HARD))}    提示：{len(set(SOFT))}")
    return 1 if HARD else 0


if __name__ == "__main__":
    sys.exit(main())
