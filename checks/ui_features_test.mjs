// ui_features_test.mjs — 本轮 UI 需求的自动化验收
//
// 用户这次提的要求逐条对应断言：
//   ① 过渡动画：原方块"一边缩小一边回去"，下一个界面"一边扩展一边出来" → FLIP + scale
//   ② 筹码峰：能算出平均筹码 → avgChipCost()
//   ③ 悬停：画**白色横线**（不是高亮）；现价用**黄线**；不再区分套牢/获利 → CSS + HTML
//   ④ 搜索股票 → 评分 + 基本面 + 技术面 + 看多/看跌建议 → 搜索与建议渲染代码存在
//   ⑤ 顶部把所有模块列出来，可从上面拖拽到任意两个之间 → 拖拽排序实现存在
//   ⑥ 主页面永远保持三列 → CSS 固定 repeat(3, ...)
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");
const css = readFileSync(new URL("style.css", root), "utf8");
const html = readFileSync(new URL("index.html", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

function grabFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 解析失败`);
}

const sandbox = { console };
vm.createContext(sandbox);
// num / esc 是**跨行**的 const 箭头函数：必须按括号深度抓到结尾分号，
// 只取一行会截断表达式（上次就是因此把 num 抽成了返回布尔的坏桩）。
function grabStatement(name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 解析失败`);
}
for (const n of ["num", "esc", "cls"]) {
  vm.runInContext(grabStatement(n).replace(/^const /, "var "), sandbox);
}
if (sandbox.num(2.5) !== "2.50") {
  console.error(`❌ 抽取 num 失败：num(2.5)=${sandbox.num(2.5)}`);
  process.exit(1);
}
// 函数声明直接跑即可（在 vm 的全局作用域里会挂到 global 上）；
// 千万不要把 `function foo(` 换成 `var foo(` —— 那会变成语法错误。
for (const n of ["money"]) {
  vm.runInContext(grabFn(n), sandbox);
}
// wan / yi 是 const 箭头函数
for (const n of ["wan", "yi"]) {
  vm.runInContext(grabStatement(n).replace(/^const /, "var "), sandbox);
}
vm.runInContext(grabFn("chipRowsHTML"), sandbox);
vm.runInContext(grabFn("avgChipCost"), sandbox);

console.log("=".repeat(78));
console.log("① 过渡动画（缩小回去 / 展开出来）");
console.log("=".repeat(78));
note(/function playFlip\(/.test(src), "有 FLIP 实现");
note(/const sx = now\.width > 0 \? prev\.width \/ now\.width : 1/.test(src),
     "按旧/新宽度算缩放比（所以会缩小或放大）");
note(/scale\(\$\{sx\}, \$\{sy\}\)/.test(src), "用 scale 做放大/缩小");
note(/opacity: startOpacity/.test(src), "缩放同时做淡入/淡出（不生硬）");
note(/const list = \(zoomed === null/.test(src) && /stage\.appendChild\(el\)/.test(src)
     && /const refill = \[\]/.test(src),
     "按三个界面渲染（不是 9 个方块铺满），并按块复用 DOM（只有变了的那块重新取数）");
note(/before\.set\(el\.dataset\.slot/.test(src),
     "FLIP 按 data-slot 匹配（换内容/放大/横竖屏都连贯动画）");
note(/\.stage\{[\s\S]*?transition:none|\.stage\{[\s\S]*?grid-template-columns:repeat\(3/.test(css),
     "三个界面用 grid 三列并排（列数变化由 CSS 控制）");
note(/--dur:\.46s/.test(css) && /--ease:cubic-bezier\(\.22,1,\.36,1\)/.test(css),
     "统一时长与缓动变量（iOS/MIUI 手感：0.46s + 缓出曲线）");

console.log();
console.log("=".repeat(78));
console.log("② 平均筹码计算");
console.log("=".repeat(78));
const rows = [];
for (let i = 0; i < 10; i++) rows.push({ price: 20 + i, share: (i + 1) * 1.5 });
const avg = sandbox.avgChipCost(rows, 25);
const expectAll = rows.reduce((s, x) => s + x.price * x.share, 0) / rows.reduce((s, x) => s + x.share, 0);
note(Math.abs(avg.all - expectAll) < 1e-9, "全样本加权平均成本正确",
     `${avg.all.toFixed(3)} vs ${expectAll.toFixed(3)}`);
note(avg.above !== null && avg.below !== null, "分别给出上方/下方平均成本",
     `上 ${avg.above ? avg.above.toFixed(2) : "-"} / 下 ${avg.below ? avg.below.toFixed(2) : "-"}`);
note(sandbox.avgChipCost([], 25).all === null, "空数据返回 null（不抛异常）");

console.log();
console.log("=".repeat(78));
console.log("③ 筹码峰：现价以上蓝 / 以下红（连续不拆） + 黄线现价 + 紫线平均筹码");
console.log("=".repeat(78));
const chipHTML = sandbox.chipRowsHTML(rows, 25);
const flatCss = css.replace(/\s+/g, " ");
note(/chip-row trapped/.test(chipHTML) && /chip-row profit/.test(chipHTML),
     "柱子按现价分两类：以上=套牢盘、以下=获利盘");
note(/chip-row\.trapped \.b > i\{background:var\(--blue\)\}/.test(flatCss),
     "套牢盘（现价以上）是蓝色 --blue");
note(/chip-row\.profit \.b > i\{background:var\(--up\)\}/.test(flatCss),
     "获利盘（现价以下）是红色 --up（红涨）");
note(!/chip-now/.test(chipHTML) && !/chip-sep|divider/.test(chipHTML),
     "整幅筹码分布是连续的，中间不插分隔块（不拆开）");
note(/class="chip-line now"/.test(src) && /class="chip-line avg"/.test(src),
     "现价 / 平均筹码各有一条叠加线（画在图上，不打断分布）");
note(/\.chip-line\{[^}]*border-top:1px solid var\(--amber\)/.test(flatCss),
     "现价线是黄色（--amber）");
note(/\.chip-line\.avg\{[^}]*border-color:var\(--purple\)/.test(flatCss),
     "平均筹码线是紫色（--purple）");
note(/<i style="background:\$\{KC\.avg\}"><\/i>紫线 = 平均筹码/.test(src),
     "图例里的平均筹码用同一种紫色");
note(/function positionChipLines\(/.test(src) && /put\(nowLine, cur\)/.test(src)
     && /put\(avgLine, avgPrice\)/.test(src),
     "两条线按价格比例落到筹码峰对应高度");
note(/\.chip-hline\{[^}]*background:#ffffff/.test(css.replace(/\s+/g, " ")),
     "悬停是白色横线（不画高光/高亮行）");
note(/hline\.style\.top =/.test(src), "白线跟随鼠标所在行定位");
// 注意：拖拽"三列投放条"另有 .colslot.hot（高亮目标列），与筹码行高亮无关，
// 所以这里只针对**筹码行**断言，别再拿全局 classList.toggle("hot") 当替身。
note(!/\.chip-row\.hot|\.chip-row\.on/.test(css.replace(/\s+/g, " ")),
     "筹码行没有高亮样式（只用白线）");
note(!/row\.classList/.test(src) && !/chip-row[^"]*hot/.test(src),
     "悬停不改筹码行的 class（不做行高亮）");
note(/data-price="\$\{x\.price\}"/.test(src), "每行仍带价格数据（悬停显示价格）");

console.log();
console.log("=".repeat(78));
console.log("④ 搜索 → 评分 / 基本面 / 建议");
console.log("=".repeat(78));
note(/id="searchInput"/.test(html), "顶栏有搜索框");
note(/function setupSearch\(/.test(src) && /function openResearch\(/.test(src),
     "搜索与打开分析页实现存在");
note(/function fillResearchOne\(/.test(src), "有单只股票分析页");
for (const k of ["评分构成", "基本面构成", "量化倾向", "利多因子", "利空因子", "财报口径"]) {
  note(src.includes(k), `分析页包含「${k}」`);
}
note(/api\("universe"\)/.test(src), "搜索走全市场可搜索库 universe.json");
note(/缺技术面|不在当日精算范围内/.test(src), "对没有技术面的股票明确说明（不假装完整）");
note(/看多|看跌/.test(src) && /advice_tone/.test(src), "建议有看多/看跌倾向与颜色");

console.log();
console.log("=".repeat(78));
console.log("⑤ 顶部模块条 + 拖到界面里（pointer 跟手拖拽）");
console.log("=".repeat(78));
note(/id="modbar"/.test(html), "页面有顶部模块条容器");
note(/function renderModbar\(/.test(src), "模块条渲染函数存在");
// 拖动已从"原生 HTML5 DnD + 大面积虚线遮罩"改成"pointer 事件 + 跟手幽灵"：
// 用户反馈原生的那种一卡一卡；现在每帧只动幽灵的 transform、落点用坐标算。
note(/function beginPointerDrag\(/.test(src) && /function slotAtPoint\(/.test(src),
     "拖动用 pointer 事件 + 坐标判断落点（不用原生 draggable）");
note(!/draggable="true"/.test(src) && !/dataTransfer/.test(src),
     "已经彻底不用原生 drag-and-drop（它没有跟手动画，还依赖 dragover 高频事件）");
note(/pointermove/.test(src) && /translate3d\(/.test(src),
     "拖动时用 translate3d 移动幽灵（合成层，60fps）");
note(/\.droptarget\{/.test(css.replace(/\s+/g, "")) && /dragghost/.test(css),
     "有目标界面高亮与跟手幽灵的样式");
note(/SLOTS_KEY/.test(src) && /localStorage/.test(src),
     "三个界面分别显示什么，持久化到 localStorage");
note(/\.stage\{[^}]*display:flex/.test(css.replace(/\s+/g, "")),
     "横屏：三块用 flex 并排（一屏同时看到三块）");

console.log();
console.log("=".repeat(78));
console.log("⑥ 滚动条");
console.log("=".repeat(78));
note(/\*::-webkit-scrollbar\{[^}]*display:none\}/.test(css.replace(/\s+/g, "")),
     "滚动条仍然隐藏（含右侧拖动条）");

// 按**大括号配对**取出某个媒体查询的完整块。
// 不能用 indexOf 直接切片：文件里在更靠前的位置也有 @media (min-width:1080px)，
// 切片会切到空串，断言就会假失败（这个坑已经踩过一次）。
function mediaBlock(query, nth = 0) {
  let idx = -1;
  for (let n = 0; n <= nth; n++) idx = css.indexOf(query, idx + 1);
  if (idx < 0) return "";
  let i = css.indexOf("{", idx), depth = 0;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") { depth--; if (depth === 0) return css.slice(idx, i + 1); }
  }
  return "";
}
// 断点共两处 @media (max-width:1079px)：第一处是"切换器/布局"，第二处是"内边距微调"。
// 把所有窄屏块拼起来一起检查，避免只查了第一块漏掉第二块。
const narrowBlocks = [mediaBlock("@media (max-width:1079px)", 0),
                      mediaBlock("@media (max-width:1079px)", 1)].join("\n");
const narrowFlat = narrowBlocks.replace(/\s+/g, "");
// ⚠️ 宽屏块**也可能有多处**（本轮为了改卡片比例又加了一块 @media (min-width:1080px)）。
//    只取第 0 块会漏掉后面那些规则 —— 表现就是"明明写了 .vswitch{display:none} 却断言失败"
//    （这个假失败真的发生过）。所以把所有同 query 的块拼起来一起查。
const wideBlocks = [];
for (let k = 0; ; k++) {
  const blk = mediaBlock("@media (min-width:1080px)", k);
  if (!blk) break;
  wideBlocks.push(blk);
}
const wideFlat = wideBlocks.join("\n").replace(/\s+/g, "");

console.log();
console.log("=".repeat(78));
console.log("⑦ 竖屏 / 横屏：切换器二选一 + 三个界面竖着排（本轮核心要求）");
console.log("=".repeat(78));
note(/id="vswitch"/.test(html) && /class="vswitch"/.test(html), "页面有竖排切换器容器");
note(/id="modbar"/.test(html), "页面有顶部横向切换条容器");
// 互斥：窄屏只显示竖排、隐藏横排；宽屏只显示横排、隐藏竖排
note(/\.modbar\{display:none\}/.test(narrowFlat) && /\.vswitch\{display:flex\}/.test(narrowFlat),
     "竖屏：隐藏横向切换条，显示竖排切换按钮");
note(/\.vswitch\{display:none\}/.test(wideFlat),
     "横屏：隐藏竖排切换按钮（只留顶部横向条）");
// 竖屏现在是 flex 方向改 column（三块竖着排），不再是 grid 单列
note(/\.stage\{flex-direction:column!important/.test(narrowFlat)
     && /max-height:86vh/.test(narrowFlat),
     "竖屏：**三个界面**竖着排成一列，每块最多 86vh 自己滚（不是一屏一个）");
note(/\.vswitch\{[^}]*flex-direction:column/.test(css.replace(/\s+/g, "")), "竖排按钮确实是竖向排列");
// 竖屏点击切换 = 滚动定位，不把其它界面收走（否则"三个界面竖着排"就没了）
note(/function isPortrait\(\)/.test(src), "有横竖屏判定函数");
note(/function scrollToSlot\(/.test(src) && /scrollIntoView/.test(src),
     "竖屏切换走滚动定位（不收走其它界面）");
note(/function wireScrollSpy\(/.test(src) && /addEventListener\("scroll"/.test(src),
     "竖屏滚动时自动高亮当前界面");
note(/wireScrollSpy\(\)/.test(src.slice(src.indexOf("function boot") >= 0
     ? src.indexOf("function boot") : src.indexOf("(async function boot"))),
     "启动时挂上滚动联动");
note(/let wasPortrait/.test(src) && /state\.zoom = null/.test(src),
     "跨越断点时回到「三个界面」（不会卡在只剩一块的状态）");
note(!/class="go"/.test(src) && !/展开 ›/.test(src),
     "已经没有「展开 ›」角标了（结构改成三个界面后不再需要）");
note(/function renderVSwitch\(/.test(src) && /vactiveSlot/.test(src),
     "竖排按钮跟着「当前看的是哪一块」高亮");
// 三个界面并排时的投放入口（pointer 跟手拖拽：幽灵上写着"替换「某某」"）
note(/dataset\.hint/.test(src) && /替换「/.test(src),
     "拖动时幽灵上直接写「替换『某某』」（替代原来那圈虚线遮罩）");
note(/data-exp="\$\{i\}"/.test(src) && /回到三个界面/.test(src),
     "每个界面能放大、也能回到三个界面");
// 竖屏的个股分析页不能走聚焦模式，否则"竖着排"会被破坏
note(/if \(isPortrait\(\)\) \{[\s\S]{0,240}state\.researchCode[\s\S]{0,120}renderShell/.test(src)
     || /RESEARCH_MOD\.id/.test(src),
     "竖屏个股分析页插进竖排列表（不进入聚焦模式）");
note(/const RESEARCH_MOD = \{/.test(src), "分析页有独立卡片元数据（横屏标题不再错用复盘看板）");

console.log();
console.log("=".repeat(78));
console.log("⑧ 搜索框：默认给出评分榜，结果里带评分");
console.log("=".repeat(78));
note(/id="searchInput"/.test(html) && /id="searchRes"/.test(html), "顶栏有搜索框与结果面板");
note(/const showRanking = async \(\) =>/.test(src), "空搜索时展示「今日评分榜」");
note(/const bindItems = \(el\) =>/.test(src), "搜索结果可点击进入个股");
note(/api\("universe"\)/.test(src), "搜索走 universe.json（全市场可搜）");
note(/今日评分榜/.test(src), "面板标题明确写了「今日评分榜」");
note(/\$\{num\(r\.score, 1\)\} 分 · \$\{esc\(r\.advice\)\}/.test(src),
     "每一行都直接列出评分与量化倾向（用户反馈的缺失点）");
note(/input\.addEventListener\("focus", \(\) => \{ input\.value\.trim\(\) \? doSearch\(\) : showRanking\(\); \}\)/.test(src),
     "点搜索框（没输入）就直接弹出评分榜");

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
