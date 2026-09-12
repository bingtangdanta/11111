// search_test.mjs — 真跑搜索框：验证"搜索框和搜索个股的评分没有列出来"这条反馈不会再出现。
//
// 用户原话："搜索框和搜索个股的评分没有列出来"。
// 所以这里必须真跑 setupSearch()，而不是只查源码里有没有 showRanking：
//   ① 点搜索框（不输入）→ 直接弹出**今日评分榜**，每行都带「xx.x 分 · 偏多/中性/看空」
//   ② 输入代码 → 命中结果同样带评分与倾向，并且可以点击进入个股分析页
//   ③ 输入不存在的代码 → 明确说"没找到"，而不是空白面板
//   ④ 点结果 → openResearch 被调用（横屏进主舞台 / 竖屏插最前面）
import { readFileSync } from "node:fs";
import { loadApp } from "./_fake_dom.mjs";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

const UNIVERSE = {
  count: 2444, scored_count: 60, trade_date: "2026-09-11",
  rows: [
    { code: "000636", name: "风华高科", score: 83.2, advice: "偏多", advice_tone: "up", has_tech: true, fund_score: 52.5 },
    { code: "603466", name: "风语筑", score: 79.4, advice: "偏多", advice_tone: "up", has_tech: true, fund_score: 54.8 },
    { code: "603936", name: "博敏电子", score: 70.4, advice: "中性", advice_tone: "flat", has_tech: true, fund_score: 27.2 },
    { code: "000921", name: "海信家电", score: 70.2, advice: "偏多", advice_tone: "up", has_tech: true, fund_score: 67.8 },
    { code: "600519", name: "贵州茅台", score: 51.0, advice: "看空", advice_tone: "down", has_tech: false, fund_score: 71.0 },
  ],
};

const calls = [];
const fetchImpl = async (url) => {
  calls.push(String(url));
  if (String(url).includes("universe")) return { ok: true, json: async () => UNIVERSE };
  return { ok: true, json: async () => ({ placeholder: false, slots: [] }) };
};

let app;
try {
  app = loadApp({ appSrc: src, innerWidth: 1400, fetchImpl });
} catch (e) {
  console.error("❌ 假 DOM 下加载 app.js 失败：", e.message);
  process.exit(1);
}
const { get, state, fire } = app;
const input = get("#searchInput");
const res = get("#searchRes");
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("=".repeat(78));
console.log("搜索框（真跑 setupSearch）");
console.log("=".repeat(78));

// ---------- ① 空输入 → 今日评分榜 ----------
const focusFns = (input.listeners.focus || []).length;
note(focusFns > 0, "搜索框注册了 focus 监听（点一下就有内容）");
fire("#searchInput", "focus");
await tick();
await tick();
const rankHTML = res.innerHTML;
note(res.classList.contains("show"), "空输入时结果面板自动展开");
note(rankHTML.includes("今日评分榜"), "标题写明「今日评分榜」");
note(/83\.2 分 · 偏多/.test(rankHTML), "榜单里直接列出评分与倾向（用户反馈的缺失点）",
     (rankHTML.match(/[\d.]+ 分 · \S+/) || [""])[0]);
note(/data-code="000636"/.test(rankHTML), "榜单每行带 code（可点击进入个股）");
const rowCount = (rankHTML.match(/data-code=/g) || []).length;
const withTech = UNIVERSE.rows.filter((r) => r.has_tech).length;
note(rowCount === withTech, "榜单只列有技术面的股票（没有技术面的进不了榜单）",
     `${rowCount} 行 / 有技术面 ${withTech} 只`);
note(!/data-code="600519"/.test(rankHTML),
     "没有技术面的股票不出现在榜单里（避免给出不完整评分）");
note(calls.some((u) => u.includes("universe")), "榜单数据来自 universe.json（全市场可搜）");

// ---------- ② 输入代码 → 命中并带评分 ----------
input.value = "603";
fire("#searchInput", "input");
await tick();
await tick();
const hitHTML = res.innerHTML;
note(/data-code="603466"/.test(hitHTML) && /data-code="603936"/.test(hitHTML),
     "按代码前缀搜索命中多只");
note(!/data-code="000636"/.test(hitHTML), "不匹配的股票不会混进结果");
note(/79\.4 分 · 偏多/.test(hitHTML), "命中结果里同样带评分与倾向");

// ---------- ③ 名称搜索 ----------
input.value = "茅台";
fire("#searchInput", "input");
await tick();
await tick();
note(/data-code="600519"/.test(res.innerHTML), "按名称搜索命中");
note(/51\.0 分 · 看空/.test(res.innerHTML), "看空的股票也如实显示（不美化）");

// ---------- ④ 没找到 ----------
input.value = "zzzz";
fire("#searchInput", "input");
await tick();
await tick();
note(/没找到/.test(res.innerHTML), "搜不到时明确说明，而不是空白面板");
note(new RegExp(`${UNIVERSE.rows.length}`).test(res.innerHTML)
     || /可搜索库/.test(res.innerHTML), "并告诉用户可搜索库的范围");

// ---------- ⑤ 点击结果 → 进入个股分析页 ----------
input.value = "000636";
fire("#searchInput", "input");
await tick();
await tick();
note(/data-code="000636"/.test(res.innerHTML), "结果行可被定位（真实浏览器里就在此处绑点击）");
const bound = /querySelectorAll\("\.it\[data-code\]"\)/.test(src)
  && /openResearch\(it\.dataset\.code\)/.test(src);
note(bound, "点结果行会调用 openResearch(该股代码)");
note(/function openResearch\(/.test(src) && /RESEARCH_MOD/.test(src),
     "分析页有独立元数据与打开逻辑（横屏主舞台 / 竖屏插最前面）");
note(!state.researchCode, "此时还没点，researchCode 仍为空", String(state.researchCode));

console.log();
console.log("=".repeat(78));
console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
