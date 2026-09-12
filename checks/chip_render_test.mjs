// chip_render_test.mjs — 筹码峰渲染验证（颜色分类 / 现价线 / 悬停数据 / 紧凑行距）
//
// 用户明确要求：
//   · 套牢盘用蓝色、获利盘用红色（要能区分）
//   · 等比例缩小筹码峰尺寸，让不同价格之间的空隙变得很小
//   · 鼠标移动时显示鼠标当前位置的筹码价格
// 这三条都必须能被自动验证，否则下次改动很容易又退回原样。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");
const css = readFileSync(new URL("style.css", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

function grabStatement(name) {
  const keys = [`function ${name}(`, `const ${name} = `];
  let start = -1;
  for (const k of keys) { start = src.indexOf(k); if (start >= 0) break; }
  if (start < 0) throw new Error(`找不到 ${name}`);
  if (src.startsWith("function", start)) {
    let i = src.indexOf("{", start), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
  }
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if ("([{".includes(ch)) depth++;
    else if (")]}".includes(ch)) depth--;
    else if (ch === ";" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} 解析失败`);
}

const sandbox = { console };
vm.createContext(sandbox);
vm.runInContext(grabStatement("num").replace(/^const /, "var "), sandbox);
vm.runInContext(grabStatement("chipRowsHTML"), sandbox);
if (typeof sandbox.chipRowsHTML !== "function") {
  console.error("❌ 抽取 chipRowsHTML 失败");
  process.exit(1);
}

console.log("=".repeat(78));
console.log("筹码峰渲染");
console.log("=".repeat(78));

// 造 10 个档位：现价 25，5 档在上（套牢）、5 档在下（获利）
const rows = [];
for (let i = 0; i < 10; i++) rows.push({ price: 20 + i, share: (i + 1) * 1.5 });
const cur = 25;
const html = sandbox.chipRowsHTML(rows, cur);

const trapped = [...html.matchAll(/chip-row trapped"[\s\S]*?data-price="([\d.]+)"/g)].map((m) => +m[1]);
const profit = [...html.matchAll(/chip-row profit"[\s\S]*?data-price="([\d.]+)"/g)].map((m) => +m[1]);
note(trapped.length + profit.length === 10, "每个价格档位都渲染出一行",
     `${trapped.length + profit.length} 行`);
note(trapped.every((p) => p > cur), "套牢盘 = 现价以上的档位",
     `${trapped.join(",")} > ${cur}`);
note(profit.every((p) => p <= cur), "获利盘 = 现价以下的档位",
     `${profit.join(",")} <= ${cur}`);
note(trapped.length === 4 && profit.length === 6, "上下分类数量正确（>25 有 4 档，≤25 有 6 档）",
     `套牢 ${trapped.length} / 获利 ${profit.length}`);
// 用户最终要求：整幅筹码分布**连续画，不拆开**（中间不插分隔块，拆开影响美感）；
// 现价与平均筹码改用**叠加线**标在图上（黄线 = 现价，紫线 = 平均筹码）。
note(!/chip-now|chip-sep|divider/.test(html), "筹码分布连续，不插分隔块（不拆开）");
note(/function positionChipLines\(/.test(src)
     && /Math\.max\(0, Math\.min\(1, frac\)\)/.test(src),
     "现价/平均筹码用叠加线标注并按价格比例定位（越界自动夹住）");
note(/class="chip-line now"/.test(src) && /class="chip-line avg"/.test(src),
     "叠加线有两条：now（现价）与 avg（平均筹码）");
note(/现价 \$\{num\(cur\)\}/.test(src) && /平均筹码 \$\{num\(avgPrice\)\}/.test(src),
     "两条线上都写了数值标签");
note(/\.chip-line\{[^}]*border-top:1px solid var\(--amber\)/.test(css.replace(/\s+/g, " ")),
     "现价线是黄色 --amber");
note(/\.chip-line\.avg\{[^}]*border-color:var\(--purple\)/.test(css.replace(/\s+/g, " ")),
     "平均筹码线是紫色 --purple");

// 顺序：价格必须从高到低（上面套牢、下面获利）
const order = [...html.matchAll(/data-price="([\d.]+)"/g)].map((m) => +m[1]);
note(order.every((v, i) => i === 0 || order[i - 1] >= v), "价格从高到低排列",
     order.join(" > "));

// 悬停需要的数据属性
note(!/data-price="undefined"/.test(html) && !/data-share="undefined"/.test(html),
     "每行都带 data-price / data-share（悬停用）");
note(/width:\d+(\.\d+)?%/.test(html), "柱宽按占比等比缩放", (html.match(/width:[\d.]+%/) || [""])[0]);

// 边界：全是套牢盘 / 全是获利盘 / 空数据
const allTrapped = sandbox.chipRowsHTML(rows.map((r) => ({ ...r, price: r.price + 20 })), 25);
note(!/chip-row profit"/.test(allTrapped), "全部在现价以上时，所有档位都归为套牢盘（蓝）");
const allProfit = sandbox.chipRowsHTML(rows.map((r) => ({ ...r, price: r.price - 18 })), 25);
note(!/chip-row trapped"/.test(allProfit), "全部在现价以下时，所有档位都归为获利盘（红）");
note(sandbox.chipRowsHTML([], 25) === "", "空数据返回空串");

/* ---------------- 叠加线定位：真跑 positionChipLines（不只查字符串） ----------------
   为什么必须真跑：定位算错（分数线、上下颠倒、越界不夹住）在浏览器里只表现为
   "黄线/紫线画在了错的价格上"，很容易看不出来。这里造一个假 DOM 把 y 坐标算出来对账。 */
vm.runInContext(grabStatement("positionChipLines"), sandbox);

function fakeLine(id) {
  const span = { textContent: "" };
  return {
    id, style: {}, classList: { _s: new Set(), add(c) { this._s.add(c); }, contains(c) { return this._s.has(c); } },
    querySelector: (sel) => (sel === "span" ? span : null), span,
  };
}
function fakeBox(rowCount) {
  const rowEls = [];
  for (let i = 0; i < rowCount; i++) rowEls.push({ offsetTop: i * 8, offsetHeight: 7 });
  const nowLine = fakeLine("now"), avgLine = fakeLine("avg");
  // ⚠️ 现在用的是 **class 选择器**（三个界面可能同时有两块筹码峰，id 会互相抢），
  //    所以假 DOM 也必须按 class 找，否则会"全部找不到"而静默跳过定位。
  const wrap = {
    querySelectorAll: () => rowEls,
    querySelector: (sel) => (sel === ".chip-line.now" ? nowLine
      : sel === ".chip-line.avg" ? avgLine : null),
  };
  const box = { querySelector: (sel) => (sel === ".chips-wrap" ? wrap : null) };
  return { box, nowLine, avgLine, rowEls };
}

console.log();
console.log("=".repeat(78));
console.log("叠加线定位（现价黄线 / 平均筹码紫线）");
console.log("=".repeat(78));
{
  const prices = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29];
  const apiRows = prices.map((p) => ({ price: p, share: 1 }));      // 故意升序：定位不许依赖数组顺序
  const f = fakeBox(prices.length);
  sandbox.positionChipLines(f.box, apiRows, 29, 24.5);
  const total = (prices.length - 1) * 8 + 7;                        // 0 → 79
  note(f.nowLine.classList.contains("show") && f.avgLine.classList.contains("show"),
       "两条线都显示出来了");
  note(f.nowLine.style.top === "0px", "现价 = 最高档 → 落在分布最上方", String(f.nowLine.style.top));
  const expectAvg = ((29 - 24.5) / (29 - 20)) * total;              // 代码不取整，直接写 px
  note(f.avgLine.style.top === `${expectAvg}px`,
       "平均筹码按价格比例落在中间（紫线不贴边）", String(f.avgLine.style.top));
  note(f.nowLine.span.textContent === "现价 29.00", "黄线上写了现价数值",
       f.nowLine.span.textContent);
  note(f.avgLine.span.textContent === "平均筹码 24.50", "紫线上写了平均筹码数值",
       f.avgLine.span.textContent);

  const low = fakeBox(prices.length);
  sandbox.positionChipLines(low.box, apiRows, 20, 20);
  note(low.nowLine.style.top === `${total}px`, "现价 = 最低档 → 落在分布最下方",
       String(low.nowLine.style.top));

  const clamp = fakeBox(prices.length);
  sandbox.positionChipLines(clamp.box, apiRows, 99, -5);
  note(clamp.nowLine.style.top === "0px" && clamp.avgLine.style.top === `${total}px`,
       "价格越界时自动夹在两端（不会画到图外）",
       `${clamp.nowLine.style.top} / ${clamp.avgLine.style.top}`);

  const flat = fakeBox(prices.length);
  sandbox.positionChipLines(flat.box, prices.map((p) => ({ price: 25, share: 1 })), 25, 25);
  note(!flat.nowLine.classList.contains("show"),
       "筹码只有一个价位时不画线（避免除零/画在 0 处）");
}

// CSS：颜色与紧凑行距
console.log();
console.log("=".repeat(78));
console.log("CSS：配色与紧凑度");
console.log("=".repeat(78));
note(/\.chip-row\.trapped \.b > i\{background:var\(--blue\)\}/.test(css.replace(/\s+/g, " ")),
     "套牢盘用蓝色变量 --blue");
note(/\.chip-row\.profit\s*\.b > i\{background:var\(--up\)\}/.test(css.replace(/\s+/g, " ")),
     "获利盘用红色变量 --up");
note(/--blue:#3d7dff/.test(css), "--blue 是蓝色", (css.match(/--blue:#\w+/) || [""])[0]);
note(/--up:#e64545/.test(css), "--up 是红色（A股涨色）", (css.match(/--up:#\w+/) || [""])[0]);
const heightMatch = css.match(/\.chip-row\{[^}]*height:(\d+)px/);
const gapMatch = css.match(/\.chip-row \+ \.chip-row\{margin-top:(\d+)px\}/);
note(heightMatch && +heightMatch[1] <= 8, "筹码行高 ≤8px（紧凑）",
     heightMatch ? heightMatch[1] + "px" : "未找到");
note(gapMatch && +gapMatch[1] <= 1, "行间距 ≤1px（峰与峰之间空隙极小）",
     gapMatch ? gapMatch[1] + "px" : "未找到");
note(/\.chip-tip/.test(css) && /\.chip-tip\.show/.test(css), "有悬停提示样式");

// 滚动条必须被隐藏（用户明确要求）
console.log();
console.log("=".repeat(78));
console.log("滚动条与过渡");
console.log("=".repeat(78));
note(/\*::-webkit-scrollbar\{[^}]*display:none\}/.test(css.replace(/\s+/g, "")),
     "所有滚动条隐藏（含页面右侧拖动条）");
note(!/class="scroll"/.test(src), "app.js 里不再有卡片内滚动容器");
note(!/max-height/.test(src), "app.js 里不再有 max-height 限高滚动区");
note(/function playFlip\(/.test(src), "实现了 FLIP 过渡（方块 ↔ 主舞台）");
note(/el\.animate\(\[/.test(src) && /transformOrigin: "top left"/.test(src),
     "FLIP 用 transform + 统一缓动做平滑位移");
note(/data-mod="\$\{m\.id\}"/.test(src) || /el\.dataset\.mod = m\.id/.test(src),
     "界面卡片带 data-mod（便于识别当前显示的是哪个模块）");
// FLIP 现在按 **data-slot** 匹配：三个界面的位置变化（并排↔竖排↔放大）才是要动画的东西
note(/before\.set\(el\.dataset\.slot/.test(src) && /el\.dataset\.slot = String\(i\)/.test(src),
     "FLIP 按 data-slot 匹配（换内容/放大/横竖屏切换都能连贯动画）");
note(/grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/.test(src) ||
     /grid-template-columns:repeat\(3/.test(css.replace(/\s+/g, "")),
     "横屏三列并排");

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
