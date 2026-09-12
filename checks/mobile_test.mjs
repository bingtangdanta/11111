// mobile_test.mjs — 手机版（docs/m.html + m.js）的行为测试
//
// 为什么现在才补：手机版一直是"草稿"，**一条自动化断言都没有** ——
// 结果就是它悄悄落后于电脑版好几轮（没有场外 ETF、没有历史股评、
// 选股页把 5900 只全市场说成"共精算 5900 只"、评级汇总只显示代码不显示股票名）。
// 这个文件把这几条钉住，免得再退化。
//
// 假 DOM 跑 m.js 的要点：m.js 直接操作 `#view/#tabbar/#abTitle` 这些元素，
// 所以先给对应的桩元素塞上 m.html 里的真实标签结构（七个 .tab），
// 再喂一份和线上同形状的 fetch 桩，然后逐页调用。
import { readFileSync } from "node:fs";
import { loadApp } from "./_fake_dom.mjs";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("m.js", root), "utf8");
const html = readFileSync(new URL("m.html", root), "utf8");
const css = readFileSync(new URL("m.css", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};
// 源码断言要**剥掉注释**：根因说明里就写着那些错误写法，
// 直接正则查源码会把"解释 bug 的注释"当成 bug（这个误判已经踩过两次）。
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ---------------- 与线上同形状的数据桩 ----------------
const PAY = {
  version: { trade_date: "2026-09-11", slot: "盘前", post_close_snapshot: true,
             snapshot_quote_time: "2026-09-11 16:12", scoring_version: "v2-2026.09" },
  dashboard: { market_score: 45.2, trade_date: "2026-09-11",
               breadth: { advancing: 643, declining: 4870, flat: 387, advance_decline_ratio: 0.132 },
               limit: { up: 40, down: 21, break: 18, break_rate: 0.31, max_continue: 4 },
               flow_in_top: [{ code: "300308", name: "中际旭创", change_pct: 4.03, main_net: 1e8, turnover: 2.95 }],
               flow_out_top: [{ code: "000001", name: "平安银行", change_pct: -3.1, main_net: -2e8, turnover: 1.1 }] },
  history: { days: [{ date: "2026-09-11", limit_up: 40 }] },
  limitup: { up: [{ code: "002790", name: "瑞尔特", price: 12.3, change_pct: 10, turnover: 4.1,
                    continue_days: 4, first_seal: "09:31", industry: "家居用品" }],
             break: [], down: [], ladder: [{ days: 4, stocks: [{ code: "002790", name: "瑞尔特" }] }] },
  // 关键：既有精算行（有 score）也有只有快评分的行（只有 score_light）
  screen: { top_n: 12, rows: [
    { code: "600371", name: "万向德农", industry: "种植业", score: 78.0, score_light: null,
      has_tech: true, change_pct: 4.45, main_net: 2.4e8, is_top: true, rating: "看多" },
    { code: "002902", name: "铭普光磁", industry: "通信设备", score: 77.4, score_light: null,
      has_tech: true, change_pct: 10.02, main_net: 3.3e8, is_top: true },
    { code: "001232", name: "嘉立创", industry: "元件", score: null, score_light: 87.7,
      has_tech: false, change_pct: 1.2, main_net: -1e6 },
  ] },
  funds: { funds: [{ code: "019454", name: "华泰柏瑞中韩半导体ETF发起式联接A", nav: 3.549,
                     nav_date: "2026-09-11", chg_1d: -2.7, chg_1m: 2.47, chg_1y: 113.33,
                     chg_ytd: 74.98, is_etf_link: true, is_qdii: true }], universe: [], note: "净值 T 日盘后公布" },
  review: { keep: 5, note: "规则化回评，不是实盘收益",
            lifetime: { periods: 0, picks: 0, win_rate: null, avg_change: null, since: null },
            periods: [{ date: "2026-09-11", win_rate: null, avg_change: null,
                        picks: [{ code: "600371", name: "万向德农", score: 78.0, advice: "偏多" }] }] },
  sectors: { industry: [{ code: "BK0448", name: "通信设备", change_pct: 0.52, main_net: 4.7e9,
                          leaders: [{ code: "300563", name: "神宇股份", change_pct: 19.98 }] }],
             concept: [], etf: [] },
  research: { pit_rule: "消息类数据截止 as_of", ratings: { "600104": { name: "上汽集团", org_num: 13,
              industry: "乘用车", stance: "看多", rating_score: 0.94 } },
              reports_stock: [], survey: [] },
  universe: { rows: [{ code: "600104", name: "上汽集团", industry: "乘用车", score: 68.7, advice: "偏多" }] },
};

const fetchImpl = async (url) => {
  const u = String(url);
  // ⚠️ 回调参数别写成和外面同名的 `key`：那样会踩 TDZ，每次 fetch 都抛 ReferenceError，
  //    页面全变「加载失败」，而源码级断言照样通过 —— 看着像"页面没渲染"，
  //    其实是桩函数自己坏了（我第一次就是这么写的）。
  const hit = Object.keys(PAY).find((k) => u.includes(k + ".json"));
  if (u.includes("/stock/")) return { ok: false, status: 404, json: async () => ({}) };
  return { ok: !!hit, status: hit ? 200 : 404, json: async () => (hit ? PAY[hit] : {}) };
};

console.log("=".repeat(78));
console.log("① 结构：标签栏与页面清单");
console.log("=".repeat(78));
const tabNames = [...html.matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]);
const want = ["board", "limitup", "screen", "sectors", "funds", "review", "research"];
note(tabNames.length === 7, "底部 7 个标签", tabNames.join(" / "));
for (const t of want) note(tabNames.includes(t), `标签 ${t} 存在`);
// 写死列数是老坑：加一个标签要回来改 CSS，忘了就挤成一团
note(/grid-template-columns:repeat\(auto-fit,minmax\(0,1fr\)\)/.test(css.replace(/\s+/g, "")),
     "标签栏用 auto-fit（写死列数时加标签会挤坏）");
note(/\.dim\{/.test(css.replace(/\s+/g, "")), "有 .dim 样式（快评分要比精算分弱一档）");

console.log();
console.log("=".repeat(78));
console.log("② 选股页：两列分数不能混着说（这是手机版最误导的一处）");
console.log("=".repeat(78));
note(!/共精算 \$\{rows\.length\} 只/.test(code),
     "标题不再把「全市场只数」说成「精算只数」（旧文案：共精算 5900 只）");
note(/精算 \$\{techN\} 只 \/ 全市场 \$\{all\.length\} 只/.test(src), "标题分别给出精算只数与全市场只数");
note(/function screenRows\(/.test(src) && /function scoreCell\(/.test(src),
     "有 screenRows / scoreCell 两个可测的纯函数");
note(/快评分 \$\{num\(r\.score_light, 1\)\}/.test(src), "没有精算分的行明确标成「快评分 xx.x」");
note(!/\(b\.score \|\| 0\) - \(a\.score \|\| 0\)/.test(code),
     "排序不再用 score||0（那会把 5640 只没有精算分的全当 0 分沉底）");

// ---- 行为：用桩数据真的跑一遍 ----
const app = loadApp({ appSrc: src, innerWidth: 390, fetchImpl });
// 把 m.html 的标签栏结构塞进假 DOM（m.js 靠 document.querySelectorAll(".tab") 高亮）
const tabbar = app.get("#tabbar");
// loadApp 的 get() 直接给元素，这里手动把七个标签建出来
{
  const { makeEl } = await import("./_fake_dom.mjs");
  tabbar.children = [];
  for (const t of tabNames) {
    const b = makeEl("button");
    b.className = "tab";
    b.dataset.tab = t;
    tabbar.appendChild(b);
  }
}
const view = app.get("#view");
const show = app.fn("show");

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
// 先等启动那一次 show("board") 跑完再开始逐页测 ——
// 否则它和测试里的 show() 会**抢着写同一个 #view**（这正是我加"过期渲染"保护的原因）。
await wait(30);

await show("screen");
await wait();
note(view.innerHTML.includes("只看精算") && view.innerHTML.includes("全市场"),
     "选股页有分段控件（只看精算 / 只看快评分 / 全市场 / 主力净流入）");
note(view.innerHTML.includes("精算 2 只 / 全市场 3 只"),
     "标题按桩数据算对了（2 只精算 / 3 只全市场）", (view.innerHTML.match(/精算 \d+ 只[^<]*/) || [""])[0]);
note(app.get("#sc").innerHTML.includes("78.0 分"), "精算行显示精算分",
     app.get("#sc").innerHTML.replace(/\\s+/g, " ").slice(0, 90));
// 纯函数级断言：口径分开 + 排序把精算放前面
const screenRows = app.fn("screenRows"), scoreCell = app.fn("scoreCell");
const rows = PAY.screen.rows;
note(screenRows(rows, "tech").length === 2, "「只看精算」只给有 score 的行",
     String(screenRows(rows, "tech").length));
note(screenRows(rows, "light").length === 1, "「只看快评分」只给没有精算分的行",
     String(screenRows(rows, "light").length));
note(screenRows(rows, "light")[0].code === "001232", "快评分那行确实被挑出来了");
note(screenRows(rows, "all")[2].code === "001232", "「全市场」里精算行优先、快评分行在后");
note(scoreCell({ score: null, score_light: 87.7 }).txt === "快评分 87.7",
     "scoreCell 对只有快评分的行标出「快评分」", scoreCell({ score: null, score_light: 87.7 }).txt);
note(scoreCell({ score: 78 }).kind === "精算分", "scoreCell 对精算行标出「精算分」");

console.log();
console.log("=".repeat(78));
console.log("③ 场外 ETF / 历史股评：手机版也要有（用户明确要过的两个板块）");
console.log("=".repeat(78));
await show("funds"); await wait();
const fdHTML = app.get("#fd").innerHTML;
note(fdHTML.includes("华泰柏瑞") && fdHTML.includes("019454"),
     "场外 ETF 页渲染出真实基金（代码+名称）", fdHTML.replace(/\\s+/g, " ").slice(0, 80));
note(fdHTML.includes("113.3"), "显示近 1 年涨幅");
note(view.innerHTML.includes("净值 T 日收盘后") || view.innerHTML.includes("T 日收盘后"),
     "写明净值是盘后公布（时点口径）");
note(/data-fsort/.test(src) && ["chg_1y", "chg_1m", "chg_1d", "chg_ytd"].every((k) => src.includes(k)),
     "四种排序可选（近1年/近1月/日涨跌/今年来）");

await show("review"); await wait();
note(view.innerHTML.includes("累计") && view.innerHTML.includes("永不清零"),
     "历史股评页有「累计（永不清零）」");
note(view.innerHTML.includes("待下一交易日回评") || view.innerHTML.includes("待回评"),
     "没到回评时间的期数写「待下一交易日回评」（不编数字）");
note(view.innerHTML.includes("万向德农"), "当期名单渲染出来");
note(!/win_rate[^}]*\|\| 0/.test(code), "胜率为 null 时不当作 0 显示");

console.log();
console.log("=".repeat(78));
console.log("④ 其余页面 + 手机端专属行为");
console.log("=".repeat(78));
await show("research"); await wait();
note(view.innerHTML.includes("上汽集团"),
     "评级汇总显示股票名（旧版只显示 600104 这样的代码）");
note(/esc\(r\.name \|\| r\.code\)/.test(src), "评级行 name 缺失时回退到代码（不是留空）");

await show("board"); await wait();
note(view.innerHTML.includes("45.2"), "看板渲染市场情绪");
await show("limitup"); await wait();
note(view.innerHTML.includes("连板天梯"), "涨停页渲染天梯");

// 安卓返回键：点进个股详情后按返回，应该关掉详情而不是退出网页
note(/history\.pushState\(\{ sheet: code \}/.test(src), "打开个股详情时压一条 history（返回键先关详情）");
note(/addEventListener\("popstate"/.test(src), "监听 popstate 来关闭详情");
note(/if \(history\.state && history\.state\.sheet\) history\.back\(\)/.test(src),
     "详情页的‹返回按钮走 history.back()（与安卓返回键同一路径）");

// 顶部时点提示：手机版必须和电脑版口径一致
note(/function snapshotTip\(/.test(src), "有 snapshotTip()：手机版也显示时点信息");
const tip = app.fn("snapshotTip")({ post_close_snapshot: false, snapshot_quote_time: "2026-09-12 14:30" });
note(tip.includes("盘中快照"), "非收盘快照时会明确警示", tip);
note(app.fn("snapshotTip")(PAY.version).includes("收盘快照"), "收盘快照时给出正常提示");

// 触控目标：手机上按钮太小会点错（m.css 用 --tab 变量控制底栏高度）
note(/--tab:/.test(css) && /\.tabbar\{[^}]*height:calc\(var\(--tab\)/.test(css.replace(/\s+/g, "")),
     "底栏高度由 --tab 统一控制");

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
console.log("=".repeat(78));
process.exit(failed === 0 ? 0 : 1);
