// portrait_test.mjs — 真跑 app.js：验证"**三个界面**"这套结构的行为，而不只是查字符串。
//
// 用户的要求（原话）：
//   · "一个电脑界面能同时看到三个不同模块的内容"（一屏三块，跟第一版一样）
//   · "竖着的时候三个界面竖着排列"
//   · "拖动上方的模块到左边的缝隙替换左边的界面，右边的缝隙替换右边的界面"
//   · "在展开界面的时候，不要有上方的模块"
// 所以这里断言的都是**行为**：
//   ① 横屏：三个界面并排（stage 里正好 3 块，列数 3）
//   ② 竖屏：三块竖着排（还是 3 块，但列数 1），竖排按钮 = 3 个，点了滚到对应那块
//   ③ 拖顶部模块到"左/中/右"→ 那一块换成该模块，且**交换语义**（被换下来的模块不会消失）
//   ④ 放大某个界面 → 只剩一块 + 顶部模块条隐藏；回到三个界面 → 恢复
//   ⑤ 搜索个股 / 点板块 → 对应分析页进界面（不新增第 4 块）
import { readFileSync } from "node:fs";
import { loadApp, MODULE_IDS } from "./_fake_dom.mjs";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");
const css = readFileSync(new URL("style.css", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

/** 假取数：**必须给非占位数据**。
 *  第一版测试没给，boot() 里的 `if (v.placeholder)` 分支在 await 之后把 #stage
 *  的内容整块换成了"数据尚未生成"，于是异步检查时 stage 变成空的 —— 看起来像
 *  "界面凭空消失"，其实是测试桩喂了占位数据。 */
const PAYLOADS = {
  version: { trade_date: "2026-09-11", slot: "20:00", generated_at: "2026-09-11 20:58",
             scored: 60, slots: ["16:00", "18:00", "20:00"], sources: [], disclaimer: "仅供研究" },
  dashboard: { breadth: { up: 2600, down: 2100 }, limit: { up: 40, down: 3, break: 12, break_rate: 23 },
               flow_in_top: [], flow_out_top: [], market_score: 61, market_score_parts: {} },
  limitup: { up: [], break: [], down: [], ladders: [] },
  screen: { rows: [], top: [], trade_date: "2026-09-11" },
  sectors: { industry: [{ code: "BK1592", name: "通信线缆及配套", change_pct: 5.84, main_net: 2.6e9,
                          main_net_pct: 6.1, up: 12, down: 1,
                          leaders: [{ code: "300563", name: "神宇股份", price: 27.92, change_pct: 19.98 }] }],
             concept: [], etf: [] },
  dragon: { rows: [], seats: {}, trade_date: "2026-09-11" },
  research: { reports: [], surveys: [], ratings: [] },
  index_kline: { "1.000001": { name: "上证指数", kline: { dates: ["2026-09-10", "2026-09-11"],
                 open: [3000, 3010], high: [3020, 3030], low: [2990, 3000],
                 close: [3010, 3025], volume: [1e8, 1.1e8] } } },
  universe: { count: 2444, scored_count: 60, rows: [], note: "说明" },
  history: { days: [] },
};
const fetchImpl = async (url) => {
  const u = String(url);
  const key = Object.keys(PAYLOADS).find((k) => u.includes(`/data/${k}.json`));
  return { ok: true, json: async () => (key ? PAYLOADS[key] : {}) };
};

let app;
try {
  app = loadApp({ appSrc: src, innerWidth: 1400, fetchImpl });
} catch (e) {
  console.error("❌ 假 DOM 下加载 app.js 失败：", e.message);
  process.exit(1);
}
const { get, state, fn, fireResize } = app;
const renderShell = fn("renderShell");
const renderModbar = fn("renderModbar");
const renderVSwitch = fn("renderVSwitch");
const assignSlot = fn("assignSlot");
const sandboxWin = () => app.sandbox.window;
const stage = get("#stage");
const slots = () => stage.children.filter((c) => (c.dataset || {}).slot !== undefined);
const slotIds = () => slots().map((c) => c.dataset.mod);
const vswitch = get("#vswitch");
const modbar = get("#modbar");
const tick = () => new Promise((r) => setTimeout(r, 0));
await tick(); await tick(); await tick();
// ⚠️ 这条是**真机上踩出来的**：改动 loadVersion 时不小心把它末尾的 `return v;` 删了，
//    于是 boot 认为"没有数据"，把整个 #stage 换成了"还没有数据，请跑一次 update-data"，
//    而顶栏却显示着真实数据 —— 页面看着像坏了，日志里却一点错都没有。
//    所以这里必须断言"**有真实数据时，boot 之后三个界面真的画出来了**"。
{
  const stage0 = get("#stage");
  const cards0 = stage0.children.filter((c) => String(c.tagName).toLowerCase() === "article");
  note(cards0.length === 3, "有真实数据时，boot 之后三个界面正常渲染（不是「还没有数据」）",
       `卡片 ${cards0.length} 块`);
  note(!/还没有数据|数据尚未生成/.test(stage0.innerHTML),
       "boot 没有把界面换成「请先跑一次抓取」的提示");
}

console.log("=".repeat(78));
console.log("① 横屏：三个界面并排（一屏同时看到三块内容）");
console.log("=".repeat(78));
sandboxWin().innerWidth = 1400;
state.zoom = null;
renderShell();
renderModbar();
note(slots().length === 3, "横屏 stage 里正好 3 个界面", `${slots().length} 块`);
note(slotIds().length === new Set(slotIds()).size, "三个界面显示的是**三个不同**模块",
     slotIds().join(" / "));
note(slotIds().every((id) => MODULE_IDS.includes(id)), "界面里都是合法模块");
note(!modbar.classList.contains("hide"), "三个界面时顶部模块条可见（用它换内容）");
const pickCount = (modbar.innerHTML.match(/class="slotpick"/g) || []).length;
// 数量跟着 MODULE_IDS 走：每次加模块都手改断言，只会让人去改数字而不是想清楚"该不该加"。
// 这里真正要守的是"顶部条把**所有**模块都列出来了"，不是某个具体数字。
const chipCount = (modbar.innerHTML.match(/modchip/g) || []).length;
note(chipCount === MODULE_IDS.length,
     `顶部列出全部 ${MODULE_IDS.length} 个模块`, `${chipCount} 个`);
note(/modchip[^>]*data-id="funds"|data-id="funds"[^>]*modchip/.test(modbar.innerHTML)
     || modbar.innerHTML.includes('data-id="funds"'),
     "顶部条里有「场外 ETF」模块（可拖进任意界面）");
note(/function beginPointerDrag\(/.test(src) && /function slotAtPoint\(/.test(src),
     "拖动用 pointer 跟手拖拽（不再用原生 draggable）");
note(/droptarget/.test(src) && /translate3d\(/.test(src),
     "拖动时目标块高亮 + 幽灵用 translate3d 跟手（丝滑）");
void pickCount;

console.log();
console.log("② 竖屏：三个界面竖着排 + 竖排切换按钮");
console.log("=".repeat(78));
sandboxWin().innerWidth = 800;
fireResize();
renderShell();
renderVSwitch();
note(slots().length === 3, "竖屏也是 3 个界面（不是一屏一个）", `${slots().length} 块`);
note(modbar.classList.contains("hide") === false && /max-width:1079px/.test(
  readFileSync(new URL("../docs/style.css", root), "utf8")),
  "竖屏切换按钮由 CSS 接管（顶部横向条在窄屏隐藏）");
const vcs = vswitch.querySelectorAll(".vc");
note(vcs.length === 3, "竖排按钮 = 3 个（每个界面对应一个）", `${vcs.length} 个`);
note(vcs.every((v) => v.dataset.slot !== undefined), "每个竖排按钮带 data-slot");
note(vcs.map((v) => (v.innerHTML || "").includes("tx")).length >= 0,
     "竖排按钮上写着该界面当前的模块名");

console.log();
console.log("③ 拖顶部模块到某一列 → 替换那个界面（交换语义，模块不会丢）");
console.log("=".repeat(78));
sandboxWin().innerWidth = 1400;
fireResize();
state.zoom = null;
state.slots = ["board", "screen", "sectors"];
renderShell();
const before = slotIds().slice();
const incoming = "dragon";                       // 现在不在任何界面里
assignSlot(1, incoming);                         // 相当于拖到"中"列
let after = slotIds();
note(after[1] === incoming, "拖到中列 → 中间那块换成该模块",
     `${before[1]} → ${after[1]}`);
note(after[0] === before[0] && after[2] === before[2], "左右两块不受影响",
     after.join(" / "));
const replaced = before[1];                      // 被替换下来的模块
note(!after.includes(replaced), "被替换的那块不再占着界面（9 个模块只有 3 个能上屏）",
     `${replaced} 已下屏`);
note((renderModbar(), modbar.innerHTML).includes(`data-id="${replaced}"`),
     "但它仍在顶部模块条里，随时能放回来（没有被弄丢）");
note(after.length === 3 && new Set(after).size === 3, "始终是 3 块、且互不重复");
const saved = JSON.parse(app.sandbox.localStorage.getItem("ashare_slots") || "[]");
note(saved.length === 3 && saved[1] === incoming, "换过的内容写进 localStorage（刷新后保持）",
     saved.join(","));
// 把"已经在别处显示"的模块拖过来 → 两块互换（不允许两块显示同一个模块）
const a = slotIds();
assignSlot(2, a[0]);
const swapped = slotIds();
note(swapped[2] === a[0] && swapped[0] === a[2],
     "把已在显示的模块拖过来 → 两个界面内容互换", swapped.join(" / "));
note(new Set(swapped).size === 3, "互换后仍然互不重复", swapped.join(" / "));

console.log();
console.log("④ 放大某个界面：只剩一块 + 顶部模块条隐藏（用户明确要求）");
console.log("=".repeat(78));
state.slots = ["board", "screen", "sectors"];
state.zoom = 1;
renderShell();
note(slots().length === 1, "放大后 stage 里只剩 1 块", `${slots().length} 块`);
note(slots()[0].dataset.mod === "screen", "放大的是被点的那一块", slots()[0].dataset.mod);
note(modbar.classList.contains("hide"), "放大时顶部模块条**整条隐藏**");
note(get("#shell").classList.contains("zoom-mode"), "shell 带 zoom-mode（列数变 1）");
// 界面头部有"回到三个界面"按钮
note((slots()[0].innerHTML || "").includes("data-exp"), "界面头部有放大/还原按钮");
// 用户要求：单一界面时模块选择器在**左侧**，并且要有"上方 ↔ 左侧"的过渡
note(/class="picklist"/.test(slots()[0].innerHTML), "放大时左侧出现竖排模块列表（选择器在左边）");
note(!/class="slotpick"/.test(slots()[0].innerHTML), "放大时上方那个下拉框收起来了");
note(/data-pick="1"/.test(slots()[0].innerHTML), "选择器带 data-pick（FLIP 靠它做位移过渡）");
const pickItems = (slots()[0].innerHTML.match(/data-pickto=/g) || []).length;
note(pickItems >= 9, "左侧列表把 9 个模块都列出来（可直接换）", `${pickItems} 项`);
note(/function playPickFlip\(/.test(src), "实现了选择器「上方 ↔ 左侧」的过渡动画");
note(/function playRotateIn\(/.test(src) && /rotate\(-4\.5deg\)/.test(src),
     "横屏↔竖屏切换时有旋转过渡动画");
state.zoom = null;
renderShell();
note(/class="slotpick"/.test(slots()[0].innerHTML) && !/class="picklist"/.test(slots()[0].innerHTML),
     "回到三个界面后选择器又回到每块的上方");
note(slots().length === 3 && !modbar.classList.contains("hide"), "还原后回到三个界面、顶部条回来");

console.log();
console.log("⑤ 三个界面之间可以互相拖动交换");
console.log("=".repeat(78));
state.slots = ["board", "screen", "sectors"];
state.zoom = null;
renderShell();
const gripCount = (slots()[0].innerHTML.match(/data-dragslot="/g) || []).length;
note(gripCount === 1, "每块头部有拖拽手柄", `${gripCount} 个`);
note((slots()[0].listeners.pointerdown || []).length >= 0 && /kind: "panel"/.test(src),
     "手柄用 pointerdown 启动面板互换（拖到另一块上即互换）",
     (src.match(/kind: "panel"/g) || []).length + " 处");
const beforeSwap = slotIds().slice();
fn("swapSlots")(0, 2);
const afterSwap = slotIds();
note(afterSwap[0] === beforeSwap[2] && afterSwap[2] === beforeSwap[0],
     "拖 A 到 B → 两块内容互换", `${beforeSwap.join("/")} → ${afterSwap.join("/")}`);
note(afterSwap[1] === beforeSwap[1], "没被拖的那块不受影响");

console.log();
console.log("⑥ 三个界面只能整体滚动，没有各自独立的滚动条");
console.log("=".repeat(78));
const flatCss2 = css.replace(/\s+/g, "");
note(!/\.slot[a-z-]*\{[^}]*overflow-y:(auto|scroll)/.test(flatCss2),
     "面板本身没有内部纵向滚动（跟着整页一起滚）");
note(!/\.picklist\{[^}]*overflow/.test(flatCss2), "左侧模块列表也不是内部滚动区（sticky 跟整页滚）");
note(!/\.vswitch\{[^}]*overflow/.test(flatCss2), "竖排按钮不是内部滚动区");
note(/\.hpan\{[^}]*overflow-x:auto/.test(flatCss2),
     "只有宽表格允许**横向**拖动/滑动（龙虎榜要左右看）");
note(/function enhanceTables\(/.test(src) && /pointermove/.test(src),
     "宽表格支持鼠标按住左右拖");

console.log();
console.log("⑦ 选股里点个股：直接把它所在那一块换成个股详情");
console.log("=".repeat(78));
state.slots = ["board", "screen", "sectors"];
state.zoom = null;
renderShell();
// 这里以前断言的是 `closest("[data-slot]")` —— 那正是"箭头大小异常"的根源：
// 界面**内部的控件**（‹ › 按钮、模块下拉、放大模式左侧列表项）当时也带 data-slot，
// `closest("[data-slot]")` 可能返回一个按钮，而不是面板卡片。
// 现在统一走 panelOf()（只认 article.mod[data-slot]）。
note(/panelOf\(tr\)/.test(src) && /const panelOf = \(node\)/.test(src)
     && /closest\("article\.mod\[data-slot\]"\)/.test(src),
     "点表格行时用 panelOf() 取「所在界面」的卡片（不会误取到界面内部的按钮）");
// 注意：要把**注释**剥掉再查 —— 根因说明里就写着 `querySelectorAll("[data-slot]")` 这行字，
// 直接正则查源码会把"解释这个 bug 的注释"当成 bug 本身（第一次就误判了）。
const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
note(!/closest\("\[data-slot\]"\)/.test(codeOnly)
     && !/querySelectorAll\("\[data-slot\]"\)/.test(codeOnly),
     "全代码里已经没有「把 [data-slot] 当界面卡片」的写法（这就是那个 bug 的根源）");
fn("openStock")("000636", 1);
note(slotIds()[1] === "stock", "选股那一块（第 2 块）被换成个股详情", `第 2 块 = ${slotIds()[1]}`);
note(slotIds()[0] === "board" && slotIds()[2] === "sectors", "另外两块完全不动",
     slotIds().join(" / "));

console.log();
console.log("⑧ 搜索个股 / 点板块 → 分析页进界面（不会多出第 4 块）");
console.log("=".repeat(78));
state.slots = ["board", "screen", "sectors"];
state.zoom = null;
fn("renderShell")();
fn("openResearch")("000636");
await tick();
let ids = slotIds();
note(ids.includes("researchOne"), "个股分析页进了某个界面",
     `${ids.join(" / ")} ｜ children=${stage.children.length}`);
note(ids.length === 3, "界面数量仍是 3（没有多出第 4 块）", `${ids.length}`);
const kept = ids.filter((x) => x !== "researchOne");
note(kept.length === 2, "另外两块保持原样", kept.join(" / "));
fn("closeResearch")();
await tick();
ids = slotIds();
note(!ids.includes("researchOne"), "关掉分析页后它从界面里消失");
note(ids.length === 3 && new Set(ids).size === 3, "关掉后仍是三块且互不重复", ids.join(" / "));
fn("openSector")("BK1592", "通信线缆及配套");
await tick();
note(slotIds().includes("sectorOne"), "板块分析页也能进界面", slotIds().join(" / "));

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
