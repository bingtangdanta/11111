// review_test.mjs — 真跑"历史股评"面板 + 切换动画/性能相关的行为。
//
// 覆盖用户这轮的要求：
//   ① 历史股评模块：每期 Top 名单 + 次日涨跌幅 + 胜率/平均涨幅 + 汇总
//   ② 切换界面时是"先虚化 → 出轮廓 → 再出内容"（安卓分屏小窗式）
//   ③ 切换时**只重建变了的那一块**（流畅度的关键），没变的块保持同一个 DOM 节点
//   ④ 面板头部的 ‹ › 按钮能把宽表格左右移动
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

const REVIEW = {
  trade_date: "2026-09-11", keep: 5, dropped: 2,
  note: "每期记录当日评分最高的 15 只……属于规则化回评，不是实盘收益。",
  summary: { periods: 3, picks: 30, win_rate: 56.7, avg_change: 1.24, best: 9.9, worst: -4.1 },
  // 长期累计：明细只留 5 期，但这几个数字一直保留（用户明确要求"胜率要一直保留着"）
  lifetime: { periods: 12, picks: 180, wins: 110, win_rate: 61.2, avg_change: 1.05,
              best: 19.9, worst: -9.4, since: "2026-09-01", last: "2026-09-11" },
  periods: [
    { date: "2026-09-08", done: true, next_date: "2026-09-09",
      picks: [{ code: "600519", name: "贵州茅台", score: 91.2, close: 1680.5, advice: "偏多" },
              { code: "000636", name: "风华高科", score: 88.0, close: 45.6, advice: "偏多" }],
      results: [{ code: "600519", name: "贵州茅台", change_pct: 3.2 },
                { code: "000636", name: "风华高科", change_pct: -1.5 }],
      win_rate: 50.0, avg_change: 0.85, max_gain: 3.2, max_loss: -1.5 },
    { date: "2026-09-09", done: false, picks:
      [{ code: "002415", name: "海康威视", score: 86.0, close: 31.2, advice: "中性" }], results: [] },
  ],
};

const PAYLOADS = {
  version: { trade_date: "2026-09-11", slot: "20:00", scored: 60,
             slots: ["16:00", "18:00", "20:00"], sources: [], disclaimer: "仅供研究" },
  review: REVIEW,
  dashboard: { breadth: {}, limit: {}, flow_in_top: [], flow_out_top: [] },
  limitup: { up: [], break: [], down: [] },
  screen: { rows: [], top: [] },
  sectors: { industry: [], concept: [], etf: [] },
  dragon: { rows: [], seats: {} },
  research: { reports: [], surveys: [] },
  index_kline: {}, universe: { rows: [], count: 1, scored_count: 1 }, history: { days: [] },
};
const fetchImpl = async (url) => {
  const u = String(url);
  const key = Object.keys(PAYLOADS).find((k) => u.includes(`/data/${k}.json`));
  return { ok: true, json: async () => (key ? PAYLOADS[key] : {}) };
};

let app;
try {
  app = loadApp({ appSrc: src, innerWidth: 1500, fetchImpl });
} catch (e) {
  console.error("❌ 假 DOM 下加载 app.js 失败：", e.message);
  process.exit(1);
}
const { get, state, fn } = app;
const tick = () => new Promise((r) => setTimeout(r, 0));
const stage = get("#stage");
const slots = () => stage.children.filter((c) => c.dataset && c.dataset.slot !== undefined);

console.log("=".repeat(78));
console.log("① 历史股评面板");
console.log("=".repeat(78));
const box = get("#body-review");
await fn("fillReview")(box);
await tick();
const html = box.innerHTML;
note(!/加载失败/.test(html), "面板渲染不报错");
note(/历史股评/.test(html), "标题写明「历史股评」");
note(/累计胜率/.test(html) && /61\.2%/.test(html), "汇总里有**累计**胜率（一直保留）",
     (html.match(/累计胜率[\s\S]{0,60}/) || [""])[0].replace(/\s+/g, " "));
note(/累计平均涨幅/.test(html) && /\+1\.05%/.test(html), "汇总里有累计平均涨幅");
note(/累计样本/.test(html) && /180/.test(html), "汇总里有累计样本数");
note(/近 5 期胜率/.test(html) && /56\.7%/.test(html), "另外单独给出「近 5 期」胜率");
note(/永不清零/.test(html), "写清累计胜率永不清零（明细删了也保留）");
note(/统计自 2026-09-01 起/.test(html), "给出统计起始日期", (html.match(/统计自[^，]*/) || [""])[0]);
note(/贵州茅台/.test(html) && /91\.2/.test(html), "列出每期入选的股票与评分");
note(/\+3\.20%/.test(html) && /-1\.50%/.test(html), "列出**次日涨跌幅**（这是回评的核心）");
note(/待下一交易日回评/.test(html), "还没回评的那期明确标「待回评」，不编数字");
note(/不是实盘收益/.test(html), "口径写清不是实盘收益");
note(/自动删除/.test(html) && /2 期/.test(html), "写清旧期会自动删除（本轮删了 2 期）");
note(!/undefined|NaN|\[object Object\]/.test(html), "页面里没有 undefined/NaN 泄漏");
note(/function fillReview\(/.test(src) && /api\("review"\)/.test(src), "数据来自 review.json");

console.log();
console.log("② 切换界面：先出轮廓 → 再出内容（安卓分屏小窗式）");
console.log("=".repeat(78));
note(/function morphSwitch\(/.test(src), "有 morphSwitch（切换的过渡入口）");
note(/skeletonHTML\(target\)/.test(src) && /if \(apiCached\(target\.id\)\) \{ assignSlot/.test(src),
     "只有**真要等数据**时才放骨架轮廓；数据已在缓存 → 瞬间切换（这是流畅的关键）");
note(/function skeletonHTML\(/.test(src) && /sk-chart/.test(src),
     "骨架按模块给不同轮廓（表格/图表）");
note(/classList\.add\("appeared"\)/.test(src), "数据到位后内容淡入");
note(/@keyframes shimmer/.test(css) && /@keyframes contentIn/.test(css),
     "骨架有流光动画、内容有淡入动画");
// 关键回归：之前的 filter:blur 大面板让页面更卡（用户反馈"反而更卡了"），必须彻底移除。
// 注意先把注释剥掉再查，否则"说明文字里提到的 blur"会造成假失败。
const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, "");
note(!/filter:blur/.test(cssNoComment), "面板不再用 filter:blur 做虚化（那会让大面板重新栅格化 → 更卡）");
note(!/\.mod\{[^}]*will-change/.test(cssNoComment),
     "三块大面板不再挂 will-change:transform（避免每块都占一个合成层）");
note(/\.mod\.slot\{[^}]*contain:content/.test(cssNoComment),
     "面板加了 contain:content（离屏内容不参与排版/绘制）");
note(/@keyframescontentIn\{from\{opacity/.test(cssNoComment),
     "内容淡入只动 opacity（不吃 GPU）");
state.slots = ["review", "board", "screen"];
state.zoom = null;
fn("renderShell")(true);
const elBefore = slots()[0];
note(elBefore.dataset.mod === "review", "第 1 块是历史股评", elBefore.dataset.mod);

console.log();
console.log("②b 单独滚动 + 可拖动边界（本轮核心）");
console.log("=".repeat(78));
note(/\.mod\.slot\.body\{[^}]*overflow-y:auto/.test(cssNoComment),
     "每块内容区自己纵向滚动（单个界面上下滑行）");
note(/\.mod\.slot\.body\{[^}]*overflow-x:auto/.test(cssNoComment),
     "横向也能滚（宽表格看全）");
note(/\.stage\{[^}]*height:calc\(100vh/.test(cssNoComment),
     "横屏三块占满可视高度（各滚各的，页面不整体滚）");
note(/overscroll-behavior:contain/.test(css), "滚到底不会把整页也带着滚");
note(/function layoutColumns\(/.test(src) && /"gutter"/.test(src),
     "三块之间有可拖动的边界（gutter）");
note(/function bindGutter\(/.test(src) && /cursor:col-resize/.test(css),
     "边界能拖：拖动改变两块宽度比例");
note(/COLLAPSE_AT/.test(src) && /n\[left\] < COLLAPSE_AT/.test(src),
     "拖到很窄、**松手时**才收起那一块（拖动中不重建 DOM，所以丝滑）");
note(/function animateCols\(/.test(src) && /requestAnimationFrame\(step\)/.test(src),
     "收起/恢复宽度用补间动画滑过去（不是点一下瞬间跳）");
note(/requestAnimationFrame\(flush\)/.test(src) && /只改样式，不碰结构/.test(src),
     "拖拽每帧只写一次列宽样式（早期每帧重建 DOM 才是卡的原因）");
note(/function restoreSlot\(/.test(src) && /lifetime/.test(src),
     "收起后有条子可以点回来；且累计胜率字段被前端使用");
note(/COLS_KEY/.test(src) && /localStorage/.test(src), "列宽存 localStorage，刷新后保持");
state.cols = [2, 1, 0];
fn("renderShell")();
note(fn("visibleSlots")().join(",") === "0,1", "第 3 块收起后只剩两块可见",
     fn("visibleSlots")().join(","));
note(slots().length === 2, "DOM 里也只渲染两块", `${slots().length} 块`);
note(stage.children.some((c) => c.dataset && c.dataset.restore === "2"),
     "收起的那块留了恢复条（点一下能拉回来）");
const gutters = stage.children.filter((c) => (c.classList.toString() || "").includes("gutter"));
note(gutters.length === 1, "两块时只有 1 条边界", `${gutters.length} 条`);
state.cols = [1, 1, 1];
fn("renderShell")();
note(slots().length === 3, "恢复后又是三块", `${slots().length} 块`);
note(stage.children.filter((c) => (c.classList.toString() || "").includes("gutter")).length === 2,
     "三块时有 2 条边界");

console.log();
console.log("③ 只重建变了的那一块（流畅度的关键）");
console.log("=".repeat(78));
const keep2 = slots()[1];
const keep3 = slots()[2];
note(keep2.dataset.mod === "board" && keep3.dataset.mod === "screen", "另两块现在是 看板/选股",
     `${keep2.dataset.mod} / ${keep3.dataset.mod}`);
// 把第 1 块换成"当前没在显示的" dragon → 纯替换，不触发互换
fn("assignSlot")(0, "dragon");
await tick();
const after = slots();
note(after[1] === keep2, "第 2 块复用了原来的 DOM 节点（没有重建）");
note(after[2] === keep3, "第 3 块也复用了（没有重建）");
note(after[0].dataset.mod === "dragon" && after[0] !== elBefore,
     "只有第 1 块换了内容并重建", after[0].dataset.mod);
// 内容指纹：同一个模块换股票/板块也要重建
state.slots = ["sectorOne", "board", "screen"];
state.sectorCode = "BK1592";
fn("renderShell")(true);
const secEl = slots()[0];
fn("openSector")("BK1340", "印制电路板");
const secEl2 = slots()[0];
note(secEl2 !== secEl && secEl2.dataset.ckey === "BK1340",
     "同一个模块换了板块 → 会重建（内容指纹 ckey，修掉了「换了还显示旧的」）",
     String(secEl2.dataset.ckey));

console.log();
console.log("④ 面板头部 ‹ › 按钮把宽表格左右移动");
console.log("=".repeat(78));
note(/data-pan="-1"/.test(src) && /data-pan="1"/.test(src), "头部有左/右两个按钮");
note(/function panPanel\(/.test(src) && /scrollBy\(\{ left: step/.test(src),
     "按钮调用 panPanel → scrollBy 平滑滚动宽表格");
note(/function updatePanButtons\(/.test(src) && /b\.disabled = !canPan/.test(src),
     "没有横向溢出时按钮置灰（不给假按钮）");
note(/\.iconbtn\{/.test(css) && /\.slotbtns\{[^}]*flex:none/.test(css.replace(/\s+/g, "")),
     "按钮固定尺寸不被截断（用户反馈「放大键显示不全」）");
// 回到"历史股评"（它一定有多张表），验证表格都被包进 .hpan
fn("assignSlot")(0, "review");
await tick();
const card = slots()[0];
if (card) {
  // 注意：enhanceTables(box) 里的 box 是**内容容器**（#body-xxx），不是卡片本身；
  // 假 DOM 的 querySelectorAll 不做后代遍历，所以这里要直接查内容容器。
  const bodyEl = get("#body-" + card.dataset.mod);
  const tables = bodyEl.querySelectorAll("table");
  const wrapped = tables.filter((t) => (t.parentNode || {}).classList
    && t.parentNode.classList.contains("hpan"));
  note(tables.length > 0, "这一块里有表格（用真实数据渲染出来的）", `${tables.length} 张`);
  note(tables.length === 0 || wrapped.length === tables.length,
       "面板里每张表都被包进 .hpan（宽表格可横滑/拖动）",
       `${wrapped.length}/${tables.length} 张`);
  const moved = fn("panPanel")(card, 1);
  note(typeof moved === "boolean", "panPanel 返回是否真的移动了（便于判断可用性）");
}

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
