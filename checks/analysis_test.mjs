// analysis_test.mjs — 真跑"搜索→个股分析页"：K 线 / 全部指标 / 筹码峰必须在，且不能报错。
//
// 背景（用户反馈）："为什么我搜出个股分析的个股不能看见它的 K 线和各种指标，只有基本面？"
// 查出来的真实原因有两条，这个测试专门盯住它们：
//   ① 只有当日存档快照里的股票才有 K 线；搜别的股票时 detail 为 null → 页面上只有基本面。
//      现在没有快照就走"浏览器实时抓腾讯日线"（该接口允许跨域），所以照样有 K 线。
//   ② 分析页末尾写了 `positionChipLines(box, rows, cur, avg.all)`，但这三个变量是从
//      fillStock 复制过来的、在本函数里**根本不存在** → 一执行就 ReferenceError，
//      而它包在 requestAnimationFrame 里，浏览器只在控制台里静默报错，页面看起来"就是没图"。
//      所以本测试断言：跑完不出现"加载失败"，且 K 线画布 + 指标按钮 + 筹码峰都在。
import { readFileSync } from "node:fs";
import { loadApp } from "./_fake_dom.mjs";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

/* ---------------- 造数据：一根像样的 K 线（涨跌交替，方便指标有值） ---------------- */
function makeKline(n = 180) {
  const kl = { dates: [], open: [], close: [], high: [], low: [], volume: [] };
  let p = 20;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 9) * 0.6 + (i % 7 === 0 ? -0.5 : 0.25);
    const o = p, c = Math.max(2, p + drift);
    const h = Math.max(o, c) + 0.35, l = Math.min(o, c) - 0.35;
    kl.dates.push(`2026-${String(1 + (i % 9)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, "0")}`);
    kl.open.push(+o.toFixed(2)); kl.close.push(+c.toFixed(2));
    kl.high.push(+h.toFixed(2)); kl.low.push(+l.toFixed(2));
    kl.volume.push(1_200_000 + (i % 13) * 90_000);
    p = c;
  }
  return kl;
}

const SNAP_KL = makeKline(180);
const LIVE_KL = makeKline(160);

const UNIVERSE = {
  count: 2444, scored_count: 60, note: "可搜索库说明",
  rows: [
    { code: "000636", name: "风华高科", price: 45.6, change_pct: 2.1, industry: "电子元件",
      score: 83.2, advice: "偏多", advice_tone: "up", has_detail: true, fund_score: 52.5,
      pe: 110.66, pb: 3.2, roe: 2.3, rev_yoy: 5.1, np_yoy: -12.2, gross: 18.5, debt: 44.2,
      main_net: 32000000, main_net_pct: 4.1, turnover: 6.2, amount: 890000000 },
    { code: "002415", name: "海康威视", price: 31.2, change_pct: -0.8, industry: "安防设备",
      score: 66.0, advice: "中性", advice_tone: "flat", has_detail: false, fund_score: 61.0,
      pe: 22.4, pb: 2.9, roe: 14.1, rev_yoy: 3.2, np_yoy: 6.6, gross: 44.2, debt: 38.0,
      main_net: -12000000, main_net_pct: -1.4, turnover: 2.2, amount: 560000000 },
  ],
};

const DETAIL = {
  code: "000636", name: "风华高科", price: 45.6, change_pct: 2.1, industry: "电子元件",
  kline: SNAP_KL,
  trend: { ma5: 45.1, ma10: 44.8, ma20: 43.9, ma60: 41.2, rsi14: 58.3, volume_ratio: 1.24,
           daily_bull: true, weekly_bull: false, dev_ma20_pct: 3.9, boll_up: 47, boll_mid: 44, boll_dn: 41 },
  chip: { profit_ratio_pct: 66.47, trapped_ratio_pct: 33.53, avg_cost: 45.58, hhi: 0.041,
          top10_band: { low: 44.1, high: 46.2 }, shape: "单峰密集",
          rows: Array.from({ length: 60 }, (_, i) => ({ price: 38 + i * 0.2, share: 0.5 + (i % 5) * 0.4 })),
          note: "估算值" },
  score: { score: 83.2, parts: { 技术面: 30.1, 资金面: 20.2, 筹码面: 12.0, 机构面: 11.0, 板块情绪: 9.9 } },
  fund: { score: 52.5, parts: { ROE: 12.0, 净利同比: 8.0, 营收同比: 9.0, 毛利率: 10.0, PE: 8.0, PB: 3.0, 负债率: 2.5 } },
  advice: { label: "偏多", tone: "up", combined: 75.5, pros: ["周线多头排列"], cons: ["ROE 偏低"], note: "不构成投资建议" },
  inst: { reports: [{ date: "2026-09-01", org: "某券商", title: "维持买入", stance: "看多", target_high: 58 }],
          survey: [{ date: "2026-08-20", orgs: "某基金等", way: "电话会议", org_num: 12 }],
          rating: { stance: "看多" } },
  flow: { "主力净流入(万元)": 3200 },
};

const calls = [];
const fetchImpl = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes("universe")) return { ok: true, json: async () => UNIVERSE };
  if (u.includes("stock/000636")) return { ok: true, json: async () => DETAIL };
  if (u.includes("gtimg.cn")) {
    // 腾讯真实返回形状：data.<sym>.qfqday = [[日期, 开, 收, 高, 低, 量], ...]
    const rows = LIVE_KL.dates.map((d, i) => [d, String(LIVE_KL.open[i]), String(LIVE_KL.close[i]),
                                               String(LIVE_KL.high[i]), String(LIVE_KL.low[i]),
                                               String(LIVE_KL.volume[i])]);
    return { ok: true, json: async () => ({ code: 0, data: { sz002415: { qfqday: rows } } }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

let app;
try {
  app = loadApp({ appSrc: src, innerWidth: 1400, fetchImpl });
} catch (e) {
  console.error("❌ 假 DOM 下加载 app.js 失败：", e.message);
  process.exit(1);
}
const { get, state, fn } = app;
const fillModule = fn("fillModule");
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("=".repeat(78));
console.log("个股分析页（搜索出来的股票）");
console.log("=".repeat(78));

// ---------- ① 有存档快照的股票 ----------
state.researchCode = "000636";
let box = get("#body-researchOne");
await fillModule("researchOne");
await tick();
await tick();
let html = box.innerHTML;

note(!/加载失败/.test(html), "有存档的股票：页面渲染不报错");
note(/id="kOne"/.test(html) && /canvas/.test(html), "有 K 线画布（用户反馈的核心缺失）");
note(/data-k="ind" data-v="MACD"/.test(html) && /data-k="ind" data-v="KDJ"/.test(html)
     && /data-k="ind" data-v="RSI"/.test(html), "MACD / KDJ / RSI 指标按钮都在");
note(/data-k="bars" data-v="120"/.test(html) && /data-k="bars" data-v="250"/.test(html),
     "区间按钮（60/120/250 根）在");
note(/class="kinfo"/.test(html), "有指标数据行（鼠标悬停显示用）");
const canvas = get("#kOne");
note(!!canvas.__kstate && Array.isArray(canvas.__kstate.data.dates),
     "K 线已挂载并算好指标", canvas.__kstate ? `${canvas.__kstate.data.dates.length} 根` : "未挂载");
if (canvas.__kstate) {
  const D = canvas.__kstate.data;
  const li = D.dates.length - 1;
  note(Number.isFinite(D.ma5[li]) && Number.isFinite(D.ma20[li]) && Number.isFinite(D.ma60[li]),
       "均线算出来了（MA5/MA20/MA60）");
  note(Number.isFinite(D.macd.dif[li]) && Number.isFinite(D.macd.bar[li]), "MACD 算出来了");
  note(Number.isFinite(D.kdj.j[li]) && Number.isFinite(D.rsi[li]), "KDJ / RSI 算出来了");
  note(Number.isFinite(D.boll.up[li]) && Number.isFinite(D.boll.dn[li]), "BOLL 算出来了");
}
note(/chip-row trapped|chip-row profit/.test(html), "筹码峰直方图渲染出来了（原来完全没有）");
note(/chip-line now/.test(html) && /chip-line avg/.test(html), "现价黄线 / 平均筹码紫线容器在");
note(/chip-hline/.test(html) && /chip-tip/.test(html), "悬停白线与浮层在");
note(/平均筹码成本/.test(html) && !/平均筹码成本（按价格加权）<\/div>\s*<div class="v"[^>]*>—/.test(html),
     "平均筹码成本有数值（不是 —）");
note(/数据来源：当日存档快照/.test(html), "明确标注数据来源=当日存档快照");
note(/机构研报/.test(html) && /看多/.test(html), "有存档时展示机构研报与多空");

// ---------- ② 没有存档的股票：必须走"浏览器实时抓取" ----------
calls.length = 0;
state.researchCode = "002415";
box = get("#body-researchOne");     // fillModule 写的就是这个容器（别用别的选择器，会读到空节点）
await fillModule("researchOne");
await tick();
await tick();
await tick();
html = box.innerHTML;

note(calls.some((u) => u.includes("gtimg.cn") && u.includes("sz002415")),
     "没有存档 → 自动改用浏览器实时抓腾讯日线（该接口允许跨域）",
     (calls.find((u) => u.includes("gtimg")) || "").slice(0, 58) + "…");
note(!/加载失败/.test(html), "实时抓取路径渲染不报错");
note(/id="kOne"/.test(html), "实时路径也有 K 线画布");
note(/本页由浏览器实时抓取/.test(html) && /腾讯行情/.test(html),
     "显著标注「本页由浏览器实时抓取（腾讯行情 · 前复权）」——不冒充存档快照");
const c2 = get("#kOne");
note(!!c2.__kstate && c2.__kstate.data.dates.length === LIVE_KL.dates.length,
     "实时 K 线挂载成功且根数正确",
     c2.__kstate ? `${c2.__kstate.data.dates.length} 根` : "未挂载");
note(/chip-row trapped|chip-row profit/.test(html), "实时路径也算了筹码峰（前端与后端同口径）");
note(!/筹码（估算）[\s\S]{0,200}数据缺失/.test(html), "实时路径的筹码不是「数据缺失」");
note(/机构研报\/调研：<b>数据缺失<\/b>/.test(html),
     "机构数据实时抓不到 → 如实标「数据缺失」，不编造");
note(!/undefined|NaN|\[object Object\]/.test(html), "页面里没有 undefined / NaN / [object Object] 泄漏");

// ---------- ③ 筹码口径必须与后端一致 ----------
const chipFromKline = fn("chipFromKline");
const chip = chipFromKline(LIVE_KL, 31.2);
note(chip.profit_ratio_pct > 0 && chip.profit_ratio_pct < 100,
     "前端筹码：获利盘在 0~100% 之间", `${chip.profit_ratio_pct}%`);
note(Math.abs(chip.profit_ratio_pct + chip.trapped_ratio_pct - 100) < 0.5,
     "获利盘 + 套牢盘 ≈ 100%",
     `${chip.profit_ratio_pct} + ${chip.trapped_ratio_pct}`);
note(chip.rows.length === 60, "筹码分箱 60 档（与后端 chips.py 一致）", `${chip.rows.length} 档`);
note(Math.abs(chip.rows.reduce((s, r) => s + r.share, 0) - 100) < 1.5,
     "各档占比合计 ≈ 100%");
note(chip.avg_cost > 0 && chip.shape && chip.note.includes("估算"),
     "平均成本 / 形态 / 口径说明齐全", `${chip.avg_cost} · ${chip.shape}`);
const noPrice = chipFromKline(LIVE_KL, null);
note(Math.abs(noPrice.profit_ratio_pct + noPrice.trapped_ratio_pct - 100) < 0.5,
     "不给现价时用最后一根收盘价兜底（不会把最高档当现价）");

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
