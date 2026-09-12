// frontend_test.mjs — 前端验证（不需要浏览器）
//   ① 指标数学：把 app.js 里的 kSma/kEma/kMacd/kKdj/kRsi/kBoll 抠出来跑确定性序列
//   ② 绘图：用"记录型假 canvas"真跑 drawKline，四种指标模式都不能抛异常，且红涨绿跌都在
//   ③ 结构：9 个模块 id 齐全、每个都有对应渲染函数、排序逻辑正确（点"评分"列）
import { readFileSync } from "node:fs";
import vm from "node:vm";

const src = readFileSync(new URL("../docs/app.js", import.meta.url), "utf8");
let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

function grabStmt(name) {
  const keys = [`function ${name}(`, `const ${name} = `, `let ${name} = `];
  let start = -1;
  for (const k of keys) { start = src.indexOf(k); if (start >= 0) break; }
  if (start < 0) throw new Error(`找不到 ${name}`);
  if (src.startsWith(`function`, start)) {
    let i = src.indexOf("{", start), depth = 0, end = -1;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    return src.slice(start, end);
  }
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 没有结尾分号`);
}

const sandbox = {
  window: { devicePixelRatio: 1, addEventListener() {}, innerWidth: 1440 },
  requestAnimationFrame: (fn) => fn(),
  document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] },
  console, fetch: () => Promise.reject(new Error("测试里不发请求")),
};
vm.createContext(sandbox);
for (const n of ["kSma", "kEma", "kStd", "kMacd", "kKdj", "kRsi", "kBoll", "kPrepare",
                 "_kctx", "_line", "drawKline", "volTxt", "klineInfoHTML", "klinePaneTip",
                 "sortRows", "money", "wan"]) {
  vm.runInContext(grabStmt(n), sandbox);
}
// ⚠️ vm 里 `const X = ...` 是**词法绑定**，不会挂到 sandbox 对象上，
//    所以测试要读 X 时必须把它当 var 跑（这里踩过：sandbox.MODULES 一直是 undefined）。
//    `state` 现在引用 DEFAULT_SLOTS，所以那两行要一起抽。
for (const n of ["KC", "MODULES", "DEFAULT_SLOTS", "RESEARCH_MOD", "SECTOR_MOD"]) {
  vm.runInContext(grabStmt(n).replace(/^const /, "var "), sandbox);
}
vm.runInContext(grabStmt("state").replace(/^const /, "var ").replace(/^let /, "var "), sandbox);
for (const n of ["esc", "num", "cls", "pctTxt"]) {
  vm.runInContext(grabStmt(n).replace(/^const /, "var "), sandbox);
}
if (typeof sandbox.num !== "function" || sandbox.num(1.005) !== "1.00" && sandbox.num(2.5) !== "2.50") {
  console.error(`❌ 抽取格式化函数失败：num(2.5)=${sandbox.num && sandbox.num(2.5)}`);
  process.exit(1);
}

console.log("=".repeat(78));
console.log("① 指标数学（与独立实现对照）");
console.log("=".repeat(78));
const N = 160, closes = [], highs = [], lows = [];
for (let i = 0; i < N; i++) {
  const c = 30 + 6 * Math.sin(i / 8) + i * 0.08;
  closes.push(+c.toFixed(2));
  highs.push(+(c * 1.012).toFixed(2));
  lows.push(+(c * 0.988).toFixed(2));
}
const k = sandbox.kPrepare({ dates: Array.from({ length: N }, (_, i) => `2026-01-${i}`),
                             open: closes, high: highs, low: lows, close: closes,
                             volume: closes.map((_, i) => 1000 + i) });
const refSma = (v, n) => v.map((_, i) => i + 1 < n ? null : v.slice(i + 1 - n, i + 1).reduce((a, b) => a + b, 0) / n);
const cmp = (a, b, label) => {
  let worst = 0, bad = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === null && b[i] === null) continue;
    if (a[i] === null || b[i] === null) { bad++; continue; }
    const d = Math.abs(a[i] - b[i]);
    worst = Math.max(worst, d);
    if (d > 1e-9) bad++;
  }
  note(bad === 0, label, `最大偏差 ${worst.toExponential(2)}`);
};
cmp(k.ma5, refSma(closes, 5), "MA5");
cmp(k.ma20, refSma(closes, 20), "MA20");
cmp(k.ma60, refSma(closes, 60), "MA60");
// MACD 恒等式：bar = 2*(dif-dea)
let macdOk = true;
for (let i = 0; i < N; i++) {
  if (k.macd.bar[i] === null) continue;
  if (Math.abs(k.macd.bar[i] - 2 * (k.macd.dif[i] - k.macd.dea[i])) > 1e-9) macdOk = false;
}
note(macdOk, "MACD 柱 = 2×(DIF−DEA)");
const kdjOk = k.kdj.k.every((v, i) => v === null || (v >= -100 && v <= 200));
note(kdjOk, "KDJ 取值在合理区间");
note(k.rsi.slice(20).every((v) => v === null || (v >= 0 && v <= 100)), "RSI 在 0~100");
note(k.boll.up.every((v, i) => v === null || k.boll.mid[i] === null || v >= k.boll.mid[i]),
     "BOLL 上轨 ≥ 中轨");
note(k.boll.dn.every((v, i) => v === null || k.boll.mid[i] === null || v <= k.boll.mid[i]),
     "BOLL 下轨 ≤ 中轨");

console.log();
console.log("=".repeat(78));
console.log("② 绘图（假 canvas 真跑 drawKline）");
console.log("=".repeat(78));
function makeCtx() {
  const rec = { fillRect: 0, stroke: 0, fillText: 0, fills: [], texts: [] };
  const ctx = {
    fillStyle: "", strokeStyle: "", lineWidth: 1, font: "", textAlign: "", textBaseline: "",
    setTransform() {}, clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
    stroke() { rec.stroke++; }, fill() {},
    fillRect() { rec.fillRect++; rec.fills.push(ctx.fillStyle); },
    fillText(t) { rec.fillText++; rec.texts.push(String(t)); },
    measureText() { return { width: 10 }; },
    createLinearGradient() { throw new Error("不允许渐变"); },
  };
  return { ctx, rec };
}
for (const ind of ["MACD", "KDJ", "RSI", "NONE"]) {
  const { ctx, rec } = makeCtx();
  const canvas = {
    clientWidth: 900, clientHeight: 320, width: 0, height: 0, style: {},
    getContext: () => ctx, addEventListener() {}, parentNode: null,
    getBoundingClientRect: () => ({ width: 900, left: 0 }),
  };
  canvas.__kstate = { data: k, bars: 60, ind, boll: true, cursor: null, info: null };
  let err = null;
  try { sandbox.drawKline(canvas); } catch (e) { err = e; }
  note(!err, `指标=${ind} 绘制不抛异常`, err ? err.message : `fillRect=${rec.fillRect} stroke=${rec.stroke}`);
  if (ind === "MACD") {
    note(rec.fills.includes("#e64545"), "涨用红色 #e64545");
    note(rec.fills.includes("#20a67a"), "跌用绿色 #20a67a");
    note(rec.texts.some((t) => /^\d+\.\d{2}$/.test(t)), "有价格刻度");
  }
}
{
  const { ctx } = makeCtx();
  const canvas = { clientWidth: 900, clientHeight: 320, width: 0, height: 0, style: {},
    getContext: () => ctx, addEventListener() {}, parentNode: null,
    getBoundingClientRect: () => ({ width: 900, left: 0 }) };
  canvas.__kstate = { data: null, bars: 60, ind: "MACD", boll: true, cursor: null, info: null };
  let err = null;
  try { sandbox.drawKline(canvas); } catch (e) { err = e; }
  note(!err, "空数据安全退化");
}
const info = sandbox.klineInfoHTML(k, N - 1, "MACD");
note(/收 \d+\.\d{2}/.test(info), "信息行含收盘价", info.slice(0, 54));
note(!/\b(undefined|NaN|null|false)\b/.test(info), "信息行无 undefined/NaN/false 泄漏");

// 用户反馈："鼠标放在成交量和 MACD 等各种指标的时候，没有鼠标所在位置的指标数据"
// 两个原因：① 悬停要求按住鼠标（e.buttons）才更新；② 明细里没把当前指标的数值列出来。
console.log();
console.log("=".repeat(78));
console.log("④ K 线悬停：鼠标一放上去就要出该位置的完整数据");
console.log("=".repeat(78));
note(/addEventListener\("pointermove", \(e\) => pick\(e\.clientX, e\.clientY\)\)/.test(src),
     "鼠标移动即取数（不再要求按住鼠标），并且带上 Y 坐标用于判断子图");
note(!/pointermove", \(e\) => \{ if \(e\.buttons/.test(src),
     "不再有「必须按住左键才显示」的判断（这正是原来没反应的根因）");
note(/addEventListener\("touchmove"/.test(src), "触屏滑动也能取数（手机可用）");
for (const [ind, must] of [["MACD", ["DIF", "DEA", "MACD柱"]],
                           ["KDJ", ["K ", "D ", "J "]],
                           ["RSI", ["RSI14"]],
                           ["NONE", ["MACD", "KDJ J", "RSI14"]]]) {
  const t = sandbox.klineInfoHTML(k, N - 1, ind);
  note(must.every((m) => t.includes(m)), `指标=${ind}：明细里有该指标数值`,
       t.slice(-58));
}
const infoAll = sandbox.klineInfoHTML(k, N - 1, "MACD");
for (const m of ["开 ", "高 ", "低 ", "收 ", "振幅", "量 ", "MA5", "MA10", "MA20", "MA60",
                 "BOLL", "距MA20"]) {
  note(infoAll.includes(m), `悬停明细含「${m.trim()}」`);
}
note(!/\b(undefined|NaN)\b/.test(sandbox.klineInfoHTML(k, 0, "MACD")),
     "第一根 K 线（没有前一日）也不出现 NaN/undefined");

// 用户反馈："为什么鼠标放在指标上没有显示各指标的？"
// 光有顶部那一行还不够 —— 鼠标停在**哪个子图**上，就要给那个子图的值。
console.log();
console.log("=".repeat(78));
console.log("⑤ 光标浮层：鼠标在哪个子图，就显示哪个指标的数值");
console.log("=".repeat(78));
note(/function klinePaneTip\(/.test(src), "有「按子图给数值」的浮层函数");
for (const [pane, must] of [
  ["vol", ["成交量", "5日均量", "量比"]],
  ["ind", ["DIF", "DEA", "MACD柱"]],
  ["price", ["开", "高", "低", "收", "涨跌幅", "MA5"]],
]) {
  const t = sandbox.klinePaneTip(k, N - 1, "MACD", pane);
  note(must.every((m) => t.includes(m)), `子图=${pane}：浮层给对应的值`, t.replace(/\s+/g, " ").slice(0, 60));
}
note(sandbox.klinePaneTip(k, N - 1, "KDJ", "ind").includes("K")
     && sandbox.klinePaneTip(k, N - 1, "KDJ", "ind").includes("J"),
     "子图=KDJ 时浮层给 K/D/J");
note(sandbox.klinePaneTip(k, N - 1, "RSI", "ind").includes("RSI14"), "子图=RSI 时浮层给 RSI14");
note(!/\b(undefined|NaN)\b/.test(sandbox.klinePaneTip(k, N - 1, "MACD", "vol")),
     "浮层里不出现 undefined/NaN");
note(!/\b(undefined|NaN)\b/.test(sandbox.klinePaneTip(k, 0, "MACD", "ind")),
     "第一根 K 线上浮层也不出现 NaN");
note(/class="ktip"/.test(src) && /tip\.classList\.add\("show"\)/.test(src),
     "每个图表都挂了浮层元素，并在悬停时显示");
note(/const pane = yIn <= padT \+ mainH \? "price"/.test(src),
     "按鼠标纵向位置判断落在哪个子图");
note(/addEventListener\("pointermove", \(e\) => pick\(e\.clientX, e\.clientY\)\)/.test(src),
     "鼠标移动即更新（带动浮层）——不需按住");

console.log();
console.log("=".repeat(78));
console.log("③ 结构：模块清单 + 排序逻辑");
console.log("=".repeat(78));
// 不再钉死具体数字（加一个模块就要来改一次数字，改的人根本不会去想"这模块该不该加"）；
// 真正要守的是"清单里必须有这些 id，且每个模块的元数据齐全"。
note(sandbox.MODULES.length >= 11, "模块数量 ≥ 11（含历史股评、场外 ETF）",
     String(sandbox.MODULES.length));
const ids = sandbox.MODULES.map((m) => m.id);
for (const want of ["board", "limitup", "heat", "screen", "sectors", "dragon", "research",
                    "index", "stock", "review", "funds"]) {
  note(ids.includes(want), `模块 ${want} 存在`);
}
note(new Set(ids).size === ids.length, "模块 id 不重复");
for (const m of sandbox.MODULES) {
  note(typeof m.tag === "string" && typeof m.title === "string" && typeof m.desc === "string",
       `模块 ${m.id} 有标签/标题/描述`);
}
// 页面结构已改为"固定的三个界面"（slot）：横屏三列并排、竖屏三块竖排，
// 每个界面头部有下拉可换内容；展开某个界面时隐藏顶部模块条。
note(src.includes("const SLOT_COUNT = 3") && src.includes("function slotCard("),
     "三个界面（slot）的结构与渲染函数存在");
note(src.includes("function assignSlot(") && src.includes("SLOTS_KEY"),
     "换界面内容 + 存 localStorage 的逻辑存在");
note(/class="slotpick"/.test(src) && /data-exp="\$\{i\}"/.test(src),
     "每个界面头部有模块下拉与放大按钮");
{
  const css = readFileSync(new URL("../docs/style.css", import.meta.url), "utf8");
  // 过渡已统一到 CSS 变量（--dur/--ease，0.46s + 同一条缓动曲线），
  // 这里接受两种写法：变量形式，或早期的字面量形式。
  const usesVars = /transition:[^;]*var\(--dur\)\s*var\(--ease\)/.test(css);
  const literal = /transition:\s*all\s*\.3s\s*ease-in-out/.test(css);
  note(usesVars || literal, "CSS 过渡统一（同一条缓动变量）",
       usesVars ? "使用 --dur/--ease" : "字面量写法");
  note(/function playFlip\(/.test(src), "实现了 FLIP 平滑重排（界面换内容/放大）");
  note(/\.stage\{[^}]*display:flex/.test(css.replace(/\s+/g, "")),
       "横屏用 flex 排三块（grid 的 height:100% 会把面板压扁，实测踩过）");
  note(/\.mod\.slot\{[^}]*height:100%/.test(css.replace(/\s+/g, "")),
       "每块占满舞台高度");
  const narrow = css.slice(css.indexOf("@media (max-width:1079px)"));
  note(/\.stage\{flex-direction:column/.test(narrow.replace(/\s+/g, "")),
       "竖屏三块竖着排（flex 方向改成 column）");
  // 注意：这里不要用"去掉全部空白"的字符串 —— `flex:1 1 auto` 会被并成 `flex:11auto`。
  note(/\.shell\.zoom-mode \.stage>\.mod\{flex:1 1 auto/.test(css),
       "放大某个界面时占满整行");
}

const rows = [
  { code: "A", score: 80, profit_ratio: 50 }, { code: "B", score: 92, profit_ratio: null },
  { code: "C", score: 70, profit_ratio: 66 },
];
const desc = sandbox.sortRows(rows, { key: "score", dir: -1 }).map((r) => r.code).join("");
const asc = sandbox.sortRows(rows, { key: "score", dir: 1 }).map((r) => r.code).join("");
note(desc === "BAC", "按评分降序排序正确", desc);
note(asc === "CAB", "切换为升序排序正确", asc);
note(sandbox.sortRows(rows, { key: "profit_ratio", dir: -1 })[2].code === "B",
     "空值排最后（不当作 0）");

console.log();
console.log("=".repeat(78));
console.log("④ 搜索框：防抖重渲染后光标不能丢");
console.log("=".repeat(78));
// 这个 bug 的现场：筛选/基金面板"改条件"时整块 innerHTML 重建，连输入框都被换掉，
// 于是"打几个字 → 停一下（防抖触发）→ 再打字"时，后面的字**根本打不进去**，
// 用户只会觉得搜索框坏了。修法是重渲染后把光标还回去。
note(/function keepFocus\(/.test(src) && /el\.setSelectionRange/.test(src),
     "有 keepFocus：重渲染后恢复焦点并把光标放到末尾");
note(/keepFocus\(box, "#scQ", f\.focus\)/.test(src),
     "选股筛选表重建后恢复搜索框焦点");
note(/keepFocus\(box, "#fdQ", f\.focus\)/.test(src),
     "场外基金表重建后恢复搜索框焦点");
note(/f\.focus = true; requery\(\);/.test(src) && /f\.focus = true; fillFunds\(box\);/.test(src),
     "只有「用户正在输入」时才抢回焦点（点表头排序不会把光标抢走）");
{
  // 行为验证：keepFocus 在 active=false 时绝不能动焦点，active=true 时要真的聚焦。
  const sandbox2 = vm.createContext({ console });
  vm.runInContext(grabStmt("keepFocus"), sandbox2);
  const calls = [];
  const fake = { value: "600519", focus: () => calls.push("focus"),
                 setSelectionRange: (a, b) => calls.push(`sel:${a},${b}`) };
  const box = { querySelector: () => fake };
  sandbox2.keepFocus(box, "#q", false);
  note(calls.length === 0, "active=false 时完全不碰焦点", calls.join(" "));
  sandbox2.keepFocus(box, "#q", true);
  note(calls.join(" ") === "focus sel:6,6", "active=true 时聚焦并把光标放到末尾", calls.join(" "));
  sandbox2.keepFocus({ querySelector: () => null }, "#q", true);
  note(true, "找不到输入框时安静退出（不抛异常）");
}

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
