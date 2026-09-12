// zoom_tx_test.mjs — 「三个界面 ↔ 一个界面」的进出场动画验收
//
// 用户原话：「优化三个界面到一个界面的过渡动画」。
// 旧版的实际问题（不是「没动画」，是「动画不完整」）：
//   · 放大时，没被点的那两块**直接从 DOM 移除**，没有任何收场动作 → 看起来像页面闪了一下；
//   · 还原时，那两块是刚新建出来的，只吃到一个 10px 的淡入 → 与「它们本来就并排在这儿」对不上。
// 现在：放大 = 被点的横向长到全宽 + 另外两块变「幽灵卡」缩进切换条；
//       还原 = 被放大的缩回自己的格子 + 另外两块从切换条长回格子。
//
// 这个测试查两件事：
//   ① 静态：接线是否正确（量在改 state 之前 / 播在填内容之后 / 只在点击时播 / 尊重减少动画）
//   ② 行为：真跑一遍 renderShell，验证幽灵卡真的被建出来、还原时没抢被放大那块的动画
import { readFileSync } from "node:fs";
import { loadApp } from "./_fake_dom.mjs";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");
const css = readFileSync(new URL("style.css", root), "utf8");
const flat = css.replace(/\s+/g, " ");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

// deferTimers：动画的"定时兜底清理"在假 DOM 里默认是同步执行的，
// 那等于**刚建出来就删掉**，中间态根本看不到。这里改成手动推进时间。
const app = loadApp({ appSrc: src, innerWidth: 1400, deferTimers: true });
const S = app.state;

console.log("=".repeat(78));
console.log("① 接线：量快照 / 播动画 / 只在点击时播");
console.log("=".repeat(78));
note(/function captureZoomRects\(/.test(src), "有「前一帧快照」函数 captureZoomRects");
// 关键顺序：必须在 state.zoom 改动**之前**量，否则量到的是新布局（等于没量）。
const handler = src.slice(src.indexOf('const exp = el.querySelector("[data-exp]")'),
                          src.indexOf('const cl = el.querySelector("[data-close]")'));
note(handler.indexOf("captureZoomRects()") >= 0
     && handler.indexOf("captureZoomRects()") < handler.indexOf("state.zoom ="),
     "量快照发生在改 state.zoom 之前");
note(/state\.zoomTx = zoomed \? state\.zoom : null/.test(handler),
     "记下「改动前的放大状态」（还原时要跳过被放大那块）");
note(/function playZoomTx\(/.test(src), "有进出场动画函数 playZoomTx");
note(/if \(state\.zoomTx !== undefined\) \{[\s\S]{0,220}playZoomTx\(prevZoom\)/.test(src),
     "renderShell 只在「点击放大/还原」时播（普通重渲染不播）");
// 播放必须排在 fillModule 之后：还原时那两块是先新建、再填内容。
const shell = src.slice(src.indexOf("function renderShell("), src.indexOf("function playPickFlip("));
note(shell.indexOf("playZoomTx(prevZoom)") > shell.indexOf("if (refill.includes(i)) fillModule"),
     "动画排在 fillModule 之后（那两块先就位再飞进来）");
note(/prefers-reduced-motion: reduce/.test(src) && /function prefersReduced\(/.test(src),
     "尊重系统「减少动画」设置（开了就直接跳过，不硬塞）");
// .coltip 里那句注释提到了 blur，所以只查**真正的声明**（后面跟分号或换行的那种）。
note(!/filter:\s*blur\(/.test(flat.replace(/\/\*[\s\S]*?\*\//g, "")),
     "动画不用 filter: blur（大面板 blur 会强制重新栅格化，卡）");

console.log();
console.log("=".repeat(78));
console.log("② 幽灵卡：只动 transform/opacity，不克隆面板 DOM");
console.log("=".repeat(78));
note(/\.zoomghost\{[^}]*position:fixed/.test(flat), "幽灵卡是 fixed 定位（脱离排版，不影响布局）");
note(/\.zoomghost\{[^}]*pointer-events:none/.test(flat), "幽灵卡不挡鼠标");
note(/\.zoomghost\{[^}]*will-change:transform,opacity/.test(flat), "提层，动画走合成器");
note(/className = "zoomghost"/.test(src) && /className = "zg-head"/.test(src),
     "幽灵卡只有底色+边框+模块名（轻量 div，不 cloneNode）");
note(!/zoomghost[\s\S]{0,400}cloneNode/.test(src), "没有克隆整块面板（克隆表格+canvas 会掉帧）");
note(/scale\(\.12\)/.test(src), "幽灵卡缩小滑走（像收进切换器里）");
note(/railPoint/.test(src) && /#vswitch/.test(src),
     "终点取左侧竖排切换器位置（竖屏下这三块本来就是从那儿选的）");

console.log();
console.log("=".repeat(78));
console.log("③ 行为：真的跑一遍 renderShell");
console.log("=".repeat(78));
const stage = app.get("#stage");
const setZoom = (slot) => {
  // 与点击处理器完全一致的顺序
  app.fn("captureZoomRects")();
  S.zoomTx = S.zoom === null ? null : S.zoom;
  S.zoom = S.zoom === null ? slot : null;
  app.fn("renderShell")();
};
app.fn("renderShell")();                       // 先渲染成三块
const isPanel = (c) => String(c.tagName).toLowerCase() === "article";
const panels0 = stage.children.filter(isPanel);
note(panels0.length === (S.zoom === null ? 3 : 1), "三块并排时 #stage 里有 3 块面板",
     `实际 ${panels0.length}`);
note(S.zoomKeepRects === null && S.zoomTx === undefined,
     "普通重渲染后不留状态（zoomTx/zoomKeepRects 不会误触发动画）");

app.fn("captureZoomRects")();
const kept = Object.keys(S.zoomKeepRects || {});
note(kept.length === 3, "captureZoomRects 记下了 3 个格子的位置", `实际 ${kept.length}`);
note(kept.every((k) => S.zoomKeepRects[k].width > 0), "每个格子都量到了宽高");

setZoom(1);                                    // 放大第 2 块
const ghosts = stage.children.filter((c) => c.classList.contains("zoomghost"));
note(S.zoom === 1, "点放大后 state.zoom = 1");
note(ghosts.length === 2, "另外两块各生成一张幽灵卡（不是瞬间消失）", `实际 ${ghosts.length}`);
note(ghosts.every((g) => String(g.style.cssText || "").includes("width:")),
     "幽灵卡尺寸取自「它们原来的格子」");
note(ghosts.every((g) => (g.children || []).some((k) => k.classList.contains("zg-head"))),
     "幽灵卡带模块名（用户能看出是哪一块收走了）");
const panels1 = stage.children.filter(isPanel);
note(panels1.length === 1 && panels1[0].dataset.slot === "1",
     "放大后 stage 里只剩被点的那一块");
// 时间推进之后幽灵卡必须自己收干净 —— 否则它会永久浮在页面上挡着看内容。
app.flushTimers();
note(stage.children.filter((c) => c.classList.contains("zoomghost")).length === 0,
     "动画时长过后幽灵卡自动收掉（不会留在页面上）");

setZoom(1);                                    // 还原成三块
const panels2 = stage.children.filter(isPanel);
note(S.zoom === null && panels2.length === 3, "还原后又是三块");
note(S.zoomTx === undefined, "播过一次就清掉 zoomTx（不会重复播/卡住）");

console.log();
console.log("=".repeat(78));
console.log("④ 还原时不能抢「被放大那块」自己的收缩动画");
console.log("=".repeat(78));
// playZoomTx 的还原分支必须跳过 prevZoom 那一块，否则它会被「从切换条飞回来」覆盖掉收缩动画。
const fn = src.slice(src.indexOf("function playZoomTx("), src.indexOf("function renderShell("));
note(/if \(i === prevZoom\) return;/.test(fn), "还原时跳过被放大的那一块");
// 放大状态下 DOM 里只有一块 → keep 里也只有它 → 还原时**不能**用 keep 当遍历源。
note(/Array\.from\(stage\.querySelectorAll\("article\.mod"\)\)/.test(fn),
     "还原分支遍历的是当前 DOM（keep 里根本没有那两块的位置）");
note(/getAnimations/.test(fn), "接手前先撤掉 playFlip 的兜底淡入（避免两个动画打架）");
note(/anim && anim\.finished && anim\.finished\.then/.test(fn),
     "动画 API 不齐时不会把渲染流程带崩");
// 真机验证过的一件事：--virtual-time-budget 下 WAAPI 的 .finished 不一定结算，
// 光靠它收幽灵卡，卡就会永久浮在页面上挡内容。所以必须还有一条定时兜底。
note(/setTimeout\(\(\) => \{ if \(g\.parentNode\) g\.remove\(\); \}, DUR \+ 200\)/.test(fn),
     "有定时兜底清理（.finished 不结算时幽灵卡也不会永久留在页面上）");

console.log();
console.log("=".repeat(78));
console.log("⑤ 真机自检入口（?expseq=）");
console.log("=".repeat(78));
// headless Edge 的 --dump-dom 点不了按钮，所以留一个"按真实事件点放大按钮"的入口；
// 这样这段动画才能在真机上被验一遍，而不是只活在假 DOM 的断言里。
note(/q\.get\("expseq"\)/.test(src) && /function scheduleExpSeq\(/.test(src),
     "有 ?expseq=1,1 自检入口（放大→还原）");
note(/document\.querySelector\(`#stage \[data-exp="\$\{slot\}"\]`\)/.test(src) && /btn\.click\(\)/.test(src),
     "走的是**真实 click 事件**（和用户手点同一条路径，不是直接改 state）");
note(/ghosts: document\.querySelectorAll\("\.zoomghost"\)\.length/.test(src)
     && /zoomTx: state\.zoomTx === undefined/.test(src),
     "?debug=1 会输出幽灵卡数量与动画状态（真机可核对）");

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
console.log("=".repeat(78));
process.exit(failed === 0 ? 0 : 1);
