// panel_selector_test.mjs — 回归："界面卡片"的定位必须唯一（箭头大小异常的根因）
//
// 【用户报的 bug】
//   “选股评分”模块顶部那两个 ‹ › 方块，在主界面切换模块之后**大小变得很怪**。
//
// 【真实原因】（不是按钮自己的样式问题，是 FLIP 动画量错了元素）
//   面板卡片是 `article.mod[data-slot="i"]`，但界面**内部的控件**当时也带了 data-slot：
//       · 模块下拉 <select class="slotpick" data-slot="i">
//       · ‹ 按钮 / › 按钮 data-slot="i"
//       · 放大模式左侧的每个模块列表项 .pickitem data-slot="i"
//       · 竖排切换器按钮 .vc data-slot="i"
//   于是 `document.querySelectorAll("[data-slot]")` 对同一个 slot 一次命中 **5 个元素**：
//       [.vc(0x0), article.mod(514x692), select(26x26), ‹(26x26), ›(26x26)]
//   而 renderShell / playFlip 是按 `data-slot` 建 Map 的 —— **后面的同名键覆盖前面的**，
//   最后 Map 里留下的是 `›` 按钮那个 26×26 的小方块。
//   结果：
//     · 面板被当成"从 26px 小方块长出来"（scale≈0.05）→ 整块闪一下
//     · 两个箭头拿到别人的 rect，缩放比高达 21 倍 → **用户看到的"大小异常"**
//
// 【修法】给"面板卡片"一个唯一入口，别再用 data-slot 泛指：
//     PANEL_SEL = "#stage > article.mod[data-slot]"
//     panelEl(i) / panelOf(node)
//   界面内部的控件改用 data-panel="i"（只表示"我属于哪个界面"，不参与任何"找卡片"的查询）。
//
// 【怎么保证不再犯】下面的行为断言直接构造"同名键互相覆盖"的场景：
//   把各种元素都塞进 #stage，然后真的跑一遍 renderShell，检查 FLIP 只动了面板卡片。
import { readFileSync } from "node:fs";
import { loadApp } from "./_fake_dom.mjs";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");
const css = readFileSync(new URL("style.css", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};
// 只查**代码**，不查注释：根因说明里就写着那些错误选择器，
// 不剥注释的话会把"解释 bug 的注释"当成 bug 本身（这个误判真的发生过）。
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

console.log("=".repeat(78));
console.log("① 选择器约定：data-slot 只给「界面卡片」，界面内部控件用 data-panel");
console.log("=".repeat(78));
note(/const PANEL_SEL = "#stage > article\.mod\[data-slot\]"/.test(code),
     "定义了唯一的面板选择器 PANEL_SEL");
note(/const panelEl = \(i\) =>/.test(code) && /const panelOf = \(node\) =>/.test(code),
     "有 panelEl(i) / panelOf(node) 两个取卡片的入口");
note(!/querySelectorAll\("\[data-slot\]"\)/.test(code),
     "没有裸查 [data-slot]（对同一个 slot 会命中 5 个元素，Map 会互相覆盖）");
note(!/closest\("\[data-slot\]"\)/.test(code), "没有 closest(\"[data-slot]\")（可能命中按钮而不是面板）");
// 模板串里的 data-slot 只应出现在"卡片本体"和竖排切换器上
const htmlSlots = [...code.matchAll(/data-slot="?\$\{[^}]*\}?"?/g)].length;
const htmlPanels = [...code.matchAll(/data-panel="?\$\{[^}]*\}?"?/g)].length;
note(htmlSlots <= 2, "模板里 data-slot 只用在卡片本体/竖排按钮上", `${htmlSlots} 处`);
note(htmlPanels >= 4, "界面内部控件（下拉/‹/›/左侧列表项）都用 data-panel", `${htmlPanels} 处`);
note(/panelEl\(i\)/.test(code) && !/`#stage \[data-slot="\$\{i\}"\]`/.test(code),
     "按序号取卡片统一走 panelEl(i)");

console.log();
console.log("=".repeat(78));
console.log("② FLIP / 点击绑定 / 滚动联动都只针对面板卡片");
console.log("=".repeat(78));
const playFlip = code.slice(code.indexOf("function playFlip("), code.indexOf("function onPointerDragStart"));
note(/querySelectorAll\(PANEL_SEL\)/.test(playFlip), "playFlip 只动面板卡片（不再动内部按钮）");
const shell = code.slice(code.indexOf("function renderShell("), code.indexOf("function playPickFlip("));
note(/querySelectorAll\(PANEL_SEL\)/.test(shell), "renderShell 的 before 表只记面板卡片");
note(/before\.set\(el\.dataset\.slot/.test(shell), "before 表仍按 data-slot 建键（面板之间一一对应）");
const spy = code.slice(code.indexOf("function wireScrollSpy("), code.indexOf("async function fillModule("));
note(/querySelectorAll\(PANEL_SEL\)/.test(spy),
     "竖屏滚动联动只量面板卡片（否则会用某个按钮的位置判断「当前在第几屏」）");
note(/panelOf\(/.test(code), "fillModule / 表格行点击用 panelOf() 找卡片");

console.log();
console.log("=".repeat(78));
console.log("③ 行为：真的塞进「同名元素」，跑一遍 renderShell 看谁被动画了");
console.log("=".repeat(78));
// 页面每次渲染都会重建卡片，这里直接观察：一次 renderShell 之后，
// 被 FLIP 动过的元素必须**只有** article.mod（内部按钮一个都不能有）。
const app = loadApp({ appSrc: src, innerWidth: 1400 });
const stage = app.get("#stage");
const animated = [];
// 假 DOM 的 animate 只返回 {cancel}，这里换成"记账 + 记录选择器归属"
const origCreate = app.sandbox.document.createElement;
app.sandbox.document.createElement = (t) => {
  const el = origCreate(t);
  el.animate = () => { animated.push({ tag: t, cls: String(el.className || ""), ds: el.dataset || {} }); return { cancel() {} }; };
  return el;
};
app.fn("renderShell")();
const panels0 = stage.children.filter((c) => String(c.tagName).toLowerCase() === "article");
note(panels0.length === 3, "先渲染出三块面板", `${panels0.length} 块`);

// 手动塞一个"同名元素"进 stage，模拟真实页面里 data-slot 撞车的情形
const fake = origCreate("button");
fake.className = "btn btn-mini iconbtn";
fake.dataset.slot = "0";
fake.dataset.panel = "0";
stage.appendChild(fake);

animated.length = 0;
app.fn("renderShell")();
const bad = animated.filter((a) => a.tag !== "article");
note(bad.length === 0, "FLIP 没有动画任何非面板元素（内部按钮不会被缩放）",
     bad.map((b) => `${b.tag}.${b.cls}`).join("、") || "无");

console.log();
console.log("=".repeat(78));
console.log("④ 那两个箭头自己是干净的：没有 transform、尺寸由 CSS 固定");
console.log("=".repeat(78));
note(/\.iconbtn\{width:26px;padding:0;justify-content:center;font-size:12px\}/.test(
       css.replace(/\s+/g, "")),
     "‹ › 是固定 26px 的方形按钮（宽度写死，不会被内容挤变形）");
note(/\.btn:active\{transform:scale\(\.97\)\}/.test(css.replace(/\s+/g, "")),
     "按钮唯一的 transform 是按下时的 scale(.97)（不会出现 20 倍缩放）");
note(/\.slotbtns\{display:flex;gap:4px;flex:none;align-items:center\}/.test(css.replace(/\s+/g, "")),
     ".slotbtns 是 flex:none（不给按钮被压缩的机会）");

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
console.log("=".repeat(78));
process.exit(failed === 0 ? 0 : 1);
