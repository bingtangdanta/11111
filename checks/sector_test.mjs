// sector_test.mjs — 真跑"板块行情 + 板块分析页"：
//   ① 每个板块都列出 5 只龙头股（用户要求）
//   ② 点板块名 → 打开板块分析页：K 线 + 全部指标 + 筹码峰 + 龙头股
//   ③ 本轮没取到 K 线的板块 → 页面**明确写数据缺失**，不画假图、不编造
import { readFileSync } from "node:fs";
import { loadApp } from "./_fake_dom.mjs";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

function makeKline(n = 90) {
  const kl = { dates: [], open: [], close: [], high: [], low: [], volume: [] };
  let p = 1000;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 7) * 12 + (i % 5 === 0 ? -8 : 5);
    const o = p, c = p + drift;
    kl.dates.push(`2026-09-${String(1 + (i % 28)).padStart(2, "0")}`);
    kl.open.push(+o.toFixed(2)); kl.close.push(+c.toFixed(2));
    kl.high.push(+(Math.max(o, c) + 6).toFixed(2));
    kl.low.push(+(Math.min(o, c) - 6).toFixed(2));
    kl.volume.push(2_000_000 + (i % 9) * 120_000);
    p = c;
  }
  return kl;
}

const KL = makeKline(90);
const LEADERS = [
  { code: "300563", name: "神宇股份", price: 27.92, change_pct: 19.98, main_net: 2.05e8,
    main_net_pct: 6.1, turnover: 18.05, market_cap: 8.1e9 },
  { code: "688143", name: "长盈通", price: 195, change_pct: 15.49, main_net: 1.84e8,
    main_net_pct: 5.2, turnover: 16.88, market_cap: 1.2e10 },
  { code: "601869", name: "长飞光纤", price: 473.99, change_pct: 8.78, main_net: 4.92e8,
    main_net_pct: 4.4, turnover: 4.62, market_cap: 3.6e11 },
  { code: "300913", name: "兆龙互连", price: 42.92, change_pct: 8.63, main_net: 9.07e7,
    main_net_pct: 3.9, turnover: 14.94, market_cap: 5.0e9 },
  { code: "000070", name: "特发信息", price: 17.16, change_pct: 6.06, main_net: 2.87e8,
    main_net_pct: 3.1, turnover: 16.22, market_cap: 1.5e10 },
];

const SECTORS = {
  trade_date: "2026-09-11",
  industry: [
    { code: "BK1592", name: "通信线缆及配套", change_pct: 5.84, main_net: 2.67e9,
      main_net_pct: 6.1, up: 12, down: 1, leaders: LEADERS,
      kline: KL, chip: null, indicators: { daily_bull: true, weekly_bull: false } },
    { code: "BK1340", name: "印制电路板", change_pct: 3.28, main_net: 8.78e8,
      main_net_pct: 2.2, up: 36, down: 12, leaders: LEADERS.slice(0, 5),
      kline_missing: true },
  ],
  concept: [
    { code: "BK0999", name: "某概念", change_pct: 1.1, main_net: 1.0e8, main_net_pct: 0.9,
      up: 10, down: 5, leaders: LEADERS.slice(0, 3), kline_missing: true },
  ],
  etf: [],
};

const PAYLOADS = {
  version: { trade_date: "2026-09-11", slot: "20:00", scored: 60,
             slots: ["16:00", "18:00", "20:00"], sources: [], disclaimer: "仅供研究" },
  sectors: SECTORS,
  dashboard: { breadth: {}, limit: {}, flow_in_top: [], flow_out_top: [] },
  limitup: { up: [], break: [], down: [] },
  screen: { rows: [], top: [] },
  dragon: { rows: [], seats: {} },
  research: { reports: [], surveys: [] },
  index_kline: {},
  universe: { count: 1, scored_count: 1, rows: [], note: "" },
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
const { get, state, fn } = app;
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("=".repeat(78));
console.log("① 板块行情：每个板块都列出 5 只龙头股");
console.log("=".repeat(78));
const box = get("#body-sectors");
await fn("fillSectors")(box);
await tick();
let html = box.innerHTML;
note(!/加载失败/.test(html), "板块行情渲染不报错");
const leadChips = (html.match(/class="leadchip"/g) || []).length;
note(leadChips === 13, "每个板块的 5 只龙头股都列出来了（5 + 5 + 3 = 13 个）",
     `${leadChips} 个`);
note(/神宇股份/.test(html) && /19\.98%/.test(html), "龙头股带名称与涨跌幅",
     (html.match(/神宇股份[\s\S]{0,40}/) || [""])[0].slice(0, 40));
note(/data-board="BK1592"/.test(html) && /class="boardlink"/.test(html),
     "板块名可点（点开看板块 K 线/指标/筹码峰）");
note(/data-stock="300563"/.test(html), "龙头股可点（点开看该股的图）");

console.log();
console.log("② 点板块 → 板块分析页：K 线 + 全部指标 + 筹码峰 + 龙头股");
console.log("=".repeat(78));
fn("openSector")("BK1592", "通信线缆及配套");
await tick();
await tick();
const secBox = get("#body-sectorOne");
html = secBox.innerHTML;
note(!/加载失败/.test(html), "板块分析页渲染不报错");
note(/id="kSec"/.test(html) && /canvas/.test(html), "有板块 K 线画布");
note(/data-k="ind" data-v="MACD"/.test(html) && /data-k="ind" data-v="KDJ"/.test(html)
     && /data-k="ind" data-v="RSI"/.test(html), "MACD/KDJ/RSI 按钮在");
note(/class="kinfo"/.test(html), "有指标数据行（鼠标悬停显示）");
const canvas = get("#kSec");
note(!!canvas.__kstate && canvas.__kstate.data.dates.length === KL.dates.length,
     "板块 K 线已挂载并按 K 线算好指标",
     canvas.__kstate ? `${canvas.__kstate.data.dates.length} 根` : "未挂载");
if (canvas.__kstate) {
  const D = canvas.__kstate.data, li = D.dates.length - 1;
  note(Number.isFinite(D.ma20[li]) && Number.isFinite(D.macd.bar[li]) && Number.isFinite(D.rsi[li]),
       "板块均线/MACD/RSI 都算出来了");
}
note(/chip-row trapped|chip-row profit/.test(html), "板块筹码峰直方图渲染出来了（用户要的）");
note(/chip-line now/.test(html) && /chip-line avg/.test(html), "现价黄线 / 平均筹码紫线在");
note(/获利盘 \/ 套牢盘/.test(html), "有获利盘/套牢盘比例");
note(/5 只龙头股/.test(html) && /神宇股份/.test(html), "板块页里也列出 5 只龙头股");
note(/data-stock="300563"/.test(html), "龙头股可点进个股分析页");
note(!/undefined|NaN|\[object Object\]/.test(html), "页面里没有 undefined/NaN 泄漏");

console.log();
console.log("③ 没取到 K 线的板块：明确写数据缺失，不画假图");
console.log("=".repeat(78));
fn("openSector")("BK1340", "印制电路板");
await tick();
await tick();
html = get("#body-sectorOne").innerHTML;
note(!/id="kSec"/.test(html), "没有 K 线时**不画**图（不拿成分股合成假指数）");
note(/本轮没有取到 K 线/.test(html) && /限流/.test(html),
     "明确写出原因：本轮被限流没取到，下一轮会补",
     (html.match(/本轮没有取到 K 线[\s\S]{0,50}/) || [""])[0].replace(/\s+/g, " "));
note(/神宇股份/.test(html), "K 线缺失时，本轮**确实取到**的龙头股照样展示");

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
