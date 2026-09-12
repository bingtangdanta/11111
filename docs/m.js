/* m.js — 手机版草稿（纯原生 JS，零依赖）。
 *
 * 定位：**先给你一个能在手机上看的版本**，不动正式那套（index.html/app.js）。
 * 数据全部来自同一份 ./data/*.json，所以看到的数字和电脑版完全一致，不做任何编造。
 *
 * 流畅度怎么保证（手机上最容易卡的几个点都避开了）：
 *   · 一次只渲染**一个**标签页的 DOM（不是把 6 页都塞进去再藏起来）
 *   · 数据在内存里缓存，切标签不重新请求
 *   · 列表最多渲染前 N 行（"加载更多"再追加），避免一次插 200 个节点
 *   · 事件用**委托**绑在容器上（不是每行一个监听器）
 *   · 只动 transform 做页面推入动画；不透明模糊、不用第三方库
 */
"use strict";

const DATA = "./data/";
const KEY_VER = "ashare_data_version";
const CACHE = {};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v, d = 2) => (v === null || v === undefined || v === "" || isNaN(Number(v)))
  ? "—" : Number(v).toFixed(d);
const pct = (v, d = 2) => (v === null || v === undefined || isNaN(Number(v)))
  ? "—" : (Number(v) > 0 ? "+" : "") + Number(v).toFixed(d) + "%";
const cls = (v) => { const n = Number(v); return n > 0 ? "up" : (n < 0 ? "down" : "flat"); };
const money = (v) => {
  if (v === null || v === undefined || isNaN(Number(v))) return "—";
  const n = Number(v), a = Math.abs(n);
  const sign = n > 0 ? "+" : (n < 0 ? "-" : "");
  return a >= 1e8 ? sign + (a / 1e8).toFixed(2) + "亿" : sign + (a / 1e4).toFixed(0) + "万";
};
const vol = (v) => {
  const n = Number(v) || 0;
  return n >= 1e8 ? (n / 1e8).toFixed(2) + "亿" : (n >= 1e4 ? (n / 1e4).toFixed(1) + "万" : String(Math.round(n)));
};

// ⚡ 手机版同样按"零成本访问"改：交给浏览器 HTTP 缓存（GitHub Pages 有 ETag），
//    数据没变时是 304，不再每次打开都重下几 MB（原来是 cache:"no-store"）。
async function api(name) {
  if (CACHE[name]) return CACHE[name];
  const r = await fetch(DATA + name + ".json", { cache: "default" });
  if (!r.ok) throw new Error(`数据加载失败 HTTP ${r.status}（data/${name}.json）`);
  const j = await r.json();
  CACHE[name] = j;
  return j;
}

/* ---------------- 小工具：列表 / 分段控件 ---------------- */
/** 行列表：最多先渲染 limit 行，剩下的用"加载更多"追加（手机上一次插几百个节点必卡） */
function renderRows(box, rows, rowHTML, limit = 30) {
  let shown = limit;
  const paint = () => {
    box.innerHTML = rows.slice(0, shown).map(rowHTML).join("")
      + (rows.length > shown
        ? `<button class="btn more" data-more="1" style="width:100%;margin-top:10px">加载更多（还有 ${rows.length - shown} 条）</button>`
        : "");
  };
  paint();
  box.onclick = (e) => {
    const more = e.target.closest("[data-more]");
    if (more) { shown += limit; paint(); }
  };
}

function segHTML(items, active, key) {
  return `<div class="seg">${items.map((x) =>
    `<button data-${key}="${esc(x.v)}" class="${String(x.v) === String(active) ? "on" : ""}">${esc(x.t)}</button>`).join("")}</div>`;
}

/* ---------------- 各标签页 ---------------- */

/* ============================================================
   选股：**两列分数不能混着说**（和电脑版同一条规矩）
   ------------------------------------------------------------
   数据事实：screen.json 有全市场 5900 只，但只有 260 只做过技术面精算
   （`has_tech: true` → 有 `score`「精算分」）；其余 5640 只只有
   `score_light`「快评分」（基本面45+资金35+板块情绪20，**不含技术面**）。

   手机版早期版本的问题：
     · 标题写「共精算 5900 只」——把"全市场只数"说成了"精算只数"，是错的；
     · 排序用 `(b.score || 0) - (a.score || 0)`，于是 5640 只没有精算分的全变 0 分，
       沉到底部、显示"— 分"，而"加载更多（还有 5870 条）"还在邀请用户一条条翻。
   所以现在：默认只列**精算**（这才是"每日 Top 10~15"的语境），
   想全市场就切到「全部」，且每行的分数会**标明是哪一列**。
   ============================================================ */
const SCREEN_MODES = [
  { v: "tech", t: "只看精算" },
  { v: "light", t: "只看快评分" },
  { v: "all", t: "全市场" },
  { v: "inflow", t: "主力净流入" },
];

/** 这一行该显示哪一列分数（口径必须能一眼看出来） */
function scoreCell(r) {
  if (r.score !== null && r.score !== undefined) {
    return { txt: `${num(r.score, 1)} 分`, kind: "精算分", cls: "tech" };
  }
  if (r.score_light !== null && r.score_light !== undefined) {
    return { txt: `快评分 ${num(r.score_light, 1)}`, kind: "快评分", cls: "light" };
  }
  return { txt: "—", kind: "无分", cls: "none" };
}

/** 选股列表：先按模式筛，再排序（**精算分优先**，缺精算分的按快评分排） */
function screenRows(rows, mode) {
  let list = rows.slice();
  const hasTech = (r) => (r.score !== null && r.score !== undefined ? 1 : 0);
  if (mode === "tech") list = list.filter((r) => hasTech(r));
  else if (mode === "light") list = list.filter((r) => !hasTech(r)
    && r.score_light !== null && r.score_light !== undefined);
  else if (mode === "inflow") list = list.filter((r) => (r.main_net || 0) > 0);
  const key = (r) => (hasTech(r) ? r.score : (r.score_light || 0));
  list.sort((a, b) => (hasTech(b) - hasTech(a)) || (key(b) - key(a)));
  return list;
}

async function pageScreen(view, state) {
  const d = await api("screen");
  const all = d.rows || [];
  const mode = state.screenMode || "tech";
  const list = screenRows(all, mode);
  const techN = all.filter((r) => r.score !== null && r.score !== undefined).length;
  const lightN = all.filter((r) => r.score === null && r.score_light !== null
    && r.score_light !== undefined).length;
  const segTitle = (x) => {
    if (x.v === "tech") return `${x.t} ${techN}`;
    if (x.v === "light") return `${x.t} ${lightN}`;
    if (x.v === "all") return `全市场 ${all.length}`;
    return x.t;
  };
  view.innerHTML = `
    ${segHTML(SCREEN_MODES.map((x) => ({ v: x.v, t: segTitle(x) })), mode, "smode")}
    <div class="card">
      <h3>选股评分 <span class="sub">精算 ${techN} 只 / 全市场 ${all.length} 只</span></h3>
      <div style="color:var(--txt3);font-size:11.5px">
        「精算分」含技术面（K线/筹码/机构），只有当日精算池才有；
        「快评分」不含技术面，全市场每只都有。<b>两列口径不同，不能混着比</b>。
        点任意一行看 K 线、筹码与多空依据。</div>
    </div>
    <div class="card"><div class="rows" id="sc"></div></div>`;
  renderRows($("#sc"), list, (r, i) => {
    const s = scoreCell(r);
    return `
    <div class="row" data-stock="${esc(r.code)}">
      <span class="idx ${r.is_top ? "top" : ""}">${i + 1}</span>
      <div class="nm"><b>${esc(r.name)}</b>
        <span>${esc(r.code)} · ${esc(r.industry || "—")} · 主力 ${money(r.main_net)}</span></div>
      <div class="rt"><b class="${s.cls === "tech" ? "" : "dim"}">${s.txt}</b>
        <span class="${cls(r.change_pct)}">${pct(r.change_pct)}
          ${r.rating ? " · " + esc(r.rating) : ""}</span></div>
    </div>`;
  }, 30);
  view.querySelectorAll("[data-smode]").forEach((b) =>
    b.addEventListener("click", () => { state.screenMode = b.dataset.smode; pageScreen(view, state); }));
}

/** 场外 ETF / 指数基金（和电脑版同一份 funds.json） */
const FUND_SORTS = [
  { v: "chg_1y", t: "近1年" }, { v: "chg_1m", t: "近1月" },
  { v: "chg_1d", t: "日涨跌" }, { v: "chg_ytd", t: "今年来" },
];

async function pageFunds(view, state) {
  const d = await api("funds");
  const sortKey = state.fundSort || "chg_1y";
  const rows = (d.funds || []).slice()
    .sort((a, b) => (b[sortKey] ?? -999) - (a[sortKey] ?? -999));
  const etf = rows.filter((x) => x.is_etf_link).length;
  view.innerHTML = `
    ${segHTML(FUND_SORTS, sortKey, "fsort")}
    <div class="card">
      <h3>场外 ETF / 指数基金 <span class="sub">在榜 ${rows.length} 只 · ETF联接 ${etf} 只</span></h3>
      <div style="color:var(--txt3);font-size:11.5px">
        净值 <b>T 日收盘后</b>公布，所以这是盘后数据；每行都标了自己的净值日期。
        ${esc(d.note ? "" : "")}
        <b>拿不到的</b>：盘中估值（接口已下线）、申赎限额、跟踪标的 —— 按数据缺失处理，不含申赎建议。</div>
    </div>
    <div class="card"><div class="rows" id="fd"></div></div>`;
  renderRows($("#fd"), rows, (r) => `
    <div class="row">
      <div class="nm"><b>${esc(r.name)}</b>
        <span>${esc(r.code)} · 净值 ${num(r.nav, 4)} · ${esc(r.nav_date || "—")}
          ${r.is_qdii ? " · QDII" : ""}</span></div>
      <div class="rt"><b class="${cls(r[sortKey])}">${pct(r[sortKey], 1)}</b>
        <span>日 ${pct(r.chg_1d, 2)} · 今年 ${pct(r.chg_ytd, 1)}</span></div>
    </div>`, 30);
  view.querySelectorAll("[data-fsort]").forEach((b) =>
    b.addEventListener("click", () => { state.fundSort = b.dataset.fsort; pageFunds(view, state); }));
}

/** 历史股评（近 5 期明细 + **永不归零**的累计胜率） */
async function pageReview(view) {
  const d = await api("review");
  const life = d.lifetime || {};
  const periods = (d.periods || []).slice().reverse();
  const pickRows = (p) => (p.results && p.results.length ? p.results : p.picks || []).map((x) => `
    <div class="row">
      <div class="nm"><b>${esc(x.name || x.code)}</b><span>${esc(x.code)}${x.score ? " · " + num(x.score, 1) + " 分" : ""}</span></div>
      <div class="rt">${x.change_pct === null || x.change_pct === undefined
        ? '<span class="muted">待回评</span>'
        : `<b class="${cls(x.change_pct)}">${pct(x.change_pct)}</b>`}</div>
    </div>`).join("");
  view.innerHTML = `
    <div class="card">
      <h3>累计（从第一天到现在，永不清零）</h3>
      <div class="kpis">
        <div><div class="k">期数</div><div class="v">${life.periods ?? 0}</div></div>
        <div><div class="k">样本</div><div class="v">${life.picks ?? 0}</div></div>
        <div><div class="k">累计胜率</div><div class="v up">${life.win_rate === null || life.win_rate === undefined ? "—" : num(life.win_rate, 1) + "%"}</div></div>
        <div><div class="k">累计均涨</div><div class="v">${life.avg_change === null || life.avg_change === undefined ? "—" : pct(life.avg_change)}</div></div>
      </div>
      <div style="color:var(--txt3);font-size:11.5px;margin-top:8px">
        ${life.since ? `统计区间 ${esc(life.since)} 起 · ` : ""}口径：收盘对收盘、不含手续费，
        <b>规则化回评，不是实盘收益</b>；明细只留最近 ${d.keep ?? 5} 期，累计不随明细删除。</div>
    </div>
    ${periods.map((p) => `
      <div class="card">
        <h3>${esc(p.date)} 期
          <span class="sub">${p.win_rate === null || p.win_rate === undefined
            ? "待下一交易日回评" : `胜率 ${num(p.win_rate, 1)}% · 均涨 ${pct(p.avg_change)}`}</span></h3>
        <div class="rows">${pickRows(p)}</div>
      </div>`).join("") || '<div class="state">还没有记录：跑一轮抓取后就有当期名单</div>'}
    <div class="card"><div style="color:var(--txt3);font-size:11px">${esc(d.note || "")}</div></div>`;
}

async function pageBoard(view) {
  const d = await api("dashboard");
  const b = d.breadth || {}, L = d.limit || {};
  let heat = { days: [] };
  try { heat = await api("history"); } catch (e) { /* 热度可选 */ }
  const days = (heat.days || []).slice(-5);
  const maxUp = Math.max(1, ...days.map((x) => x.limit_up || 0));
  const flowRow = (r, i, up) => `
    <div class="row" data-stock="${esc(r.code)}">
      <span class="idx ${i < 3 ? "top" : ""}">${i + 1}</span>
      <div class="nm"><b>${esc(r.name)}</b><span>${esc(r.code)} · 换手 ${num(r.turnover, 2)}%</span></div>
      <div class="rt"><b class="${cls(r.change_pct)}">${pct(r.change_pct)}</b>
        <span class="${up ? "up" : "down"}">${money(r.main_net)}</span></div>
    </div>`;

  view.innerHTML = `
    <div class="card">
      <h3>市场情绪 <span class="sub">${esc(d.trade_date || "")}</span></h3>
      <div class="big ${(d.market_score || 0) >= 50 ? "up" : "down"}">${num(d.market_score, 1)}
        <span style="font-size:13px;font-weight:400;color:var(--txt3)">/100</span></div>
      <div class="kpis" style="margin-top:12px">
        <div><div class="k">上涨</div><div class="v up">${b.advancing ?? "—"}</div></div>
        <div><div class="k">下跌</div><div class="v down">${b.declining ?? "—"}</div></div>
        <div><div class="k">平盘</div><div class="v flat">${b.flat ?? "—"}</div></div>
        <div><div class="k">涨停</div><div class="v up">${L.up ?? "—"}</div></div>
        <div><div class="k">跌停</div><div class="v down">${L.down ?? "—"}</div></div>
        <div><div class="k">炸板率</div><div class="v">${L.break_rate ? (L.break_rate * 100).toFixed(0) + "%" : "—"}</div></div>
      </div>
      <div style="margin-top:10px;color:var(--txt3);font-size:11.5px">
        最高连板 ${L.max_continue ?? "—"} 板 · 涨跌家数比 ${num(b.advance_decline_ratio, 3)}
        · 中位涨跌幅 ${pct(b.median_change_pct)}</div>
    </div>

    ${days.length ? `<div class="card"><h3>近 ${days.length} 天涨停家数</h3>
      <canvas id="heat" height="120"></canvas></div>` : ""}

    <div class="card"><h3>主力净流入前 10</h3><div class="rows" id="fin"></div></div>
    <div class="card"><h3>主力净流出前 10</h3><div class="rows" id="fout"></div></div>`;

  renderRows($("#fin"), d.flow_in_top || [], (r, i) => flowRow(r, i, true), 10);
  renderRows($("#fout"), d.flow_out_top || [], (r, i) => flowRow(r, i, false), 10);
  const c = $("#heat");
  if (c && days.length) drawBars(c, days.map((x) => x.limit_up || 0), maxUp);
}

async function pageLimit(view, state) {
  const d = await api("limitup");
  const mode = state.limitMode || "up";
  const pools = { up: d.up || [], break: d.break || [], down: d.down || [] };
  const list = pools[mode] || [];
  view.innerHTML = `
    ${segHTML([{ v: "up", t: `涨停 ${pools.up.length}` },
               { v: "break", t: `炸板 ${pools.break.length}` },
               { v: "down", t: `跌停 ${pools.down.length}` }], mode, "mode")}
    ${mode === "up" && (d.ladder || []).length ? `<div class="card"><h3>连板天梯</h3>
      ${(d.ladder || []).map((x) => `<div style="margin:6px 0">
        <span class="tag lb">${x.days} 板</span>
        ${(x.stocks || []).slice(0, 12).map((s) => `<span class="pill" data-stock="${esc(s.code)}">${esc(s.name)}</span>`).join("")}
      </div>`).join("")}</div>` : ""}
    <div class="card"><h3>${mode === "up" ? "涨停池" : mode === "break" ? "炸板池" : "跌停池"}
      <span class="sub">点一行看个股</span></h3>
      <div class="rows" id="pool"></div></div>`;
  renderRows($("#pool"), list, (r) => `
    <div class="row" data-stock="${esc(r.code)}">
      <div class="nm"><b>${esc(r.name)}</b><span>${esc(r.code)} · 换手 ${num(r.turnover, 1)}%
        ${r.industry ? " · " + esc(r.industry) : ""}</span></div>
      <div class="rt"><b class="${cls(r.change_pct)}">${num(r.price)}</b>
        <span>${r.continue_days ? `${r.continue_days} 板` : ""} ${r.first_seal ? "封 " + esc(r.first_seal) : ""}</span></div>
    </div>`, 30);
  view.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { state.limitMode = b.dataset.mode; pageLimit(view, state); }));
}

async function pageSectors(view, state) {
  const d = await api("sectors");
  const group = state.sectorGroup || "industry";
  const list = (d[group] || []).slice(0, 40);
  view.innerHTML = `
    ${segHTML([{ v: "industry", t: `行业 ${(d.industry || []).length}` },
               { v: "concept", t: `概念 ${(d.concept || []).length}` },
               { v: "etf", t: "ETF" }], group, "group")}
    <div class="card"><h3>板块资金流 + 龙头股</h3>
      <div class="rows" id="sec"></div></div>`;
  renderRows($("#sec"), list, (r) => `
    <div class="row" style="flex-direction:column;align-items:stretch;gap:6px">
      <div style="display:flex;align-items:center;gap:10px">
        <div class="nm"><b>${esc(r.name)}</b><span>${esc(r.code || "")}</span></div>
        <div class="rt"><b class="${cls(r.change_pct)}">${pct(r.change_pct)}</b>
          <span class="${cls(r.main_net)}">${money(r.main_net)}</span></div>
      </div>
      ${(r.leaders || []).length ? `<div class="leads">
        ${(r.leaders || []).slice(0, 5).map((x) =>
          `<button data-stock="${esc(x.code)}"><b>${esc(x.name)}</b>
            <span class="${cls(x.change_pct)}">${pct(x.change_pct)}</span></button>`).join("")}
      </div>` : '<span class="muted" style="font-size:11.5px">龙头股数据缺失</span>'}
    </div>`, 15);
  view.querySelectorAll("[data-group]").forEach((b) =>
    b.addEventListener("click", () => { state.sectorGroup = b.dataset.group; pageSectors(view, state); }));
}

async function pageResearch(view) {
  const d = await api("research");
  const rep = (d.reports_stock || []).slice(0, 20);
  const sur = (d.survey || []).slice(0, 20);
  const ratings = Object.entries(d.ratings || {})
    .map(([code, r]) => ({ code, ...r }))
    .filter((r) => r.stance)
    .slice(0, 20);
  const tag = (s) => `<span class="tag ${s === "看多" ? "up" : s === "看空" ? "down" : "flat"}">${esc(s || "未评级")}</span>`;
  view.innerHTML = `
    <div class="card"><h3>评级汇总 <span class="sub">买入+增持=看多</span></h3>
      <div class="rows">${ratings.map((r) => `
        <div class="row" data-stock="${esc(r.code)}">
          <div class="nm"><b>${esc(r.name || r.code)}</b>
            <span>${esc(r.code)}${r.industry ? " · " + esc(r.industry) : ""} · ${r.org_num ?? "—"} 家机构</span></div>
          <div class="rt">${tag(r.stance)}<span>评分 ${num(r.rating_score, 2)}</span></div>
        </div>`).join("") || '<div class="state">暂无评级数据</div>'}</div></div>
    <div class="card"><h3>个股研报 <span class="sub">近 14 天</span></h3>
      <div class="rows">${rep.map((r) => `
        <div class="row">
          <div class="nm"><b>${esc(r.name || r.code)}</b>
            <span>${esc(r.org || "")} · ${esc(r.date || "")}</span></div>
          <div class="rt">${tag(r.stance)}<span>${r.target_high ? "目标 " + num(r.target_high) : ""}</span></div>
        </div>`).join("") || '<div class="state">暂无研报</div>'}</div></div>
    <div class="card"><h3>机构调研 <span class="sub">只有关注度，没有多空</span></h3>
      <div class="rows">${sur.map((s) => `
        <div class="row" data-stock="${esc(s.code)}">
          <div class="nm"><b>${esc(s.name || s.code)}</b>
            <span>${esc(s.date || "")} · ${esc((s.orgs || "").slice(0, 18))}</span></div>
          <div class="rt"><b>${s.org_num ?? "—"}</b><span>家机构</span></div>
        </div>`).join("") || '<div class="state">暂无调研</div>'}</div></div>
    <div class="card"><div style="color:var(--txt3);font-size:11.5px">${esc(d.pit_rule || "")}</div></div>`;
}

/* ---------------- 个股详情（全屏推入） ---------------- */
async function openStock(code) {
  const sh = $("#sheet"), body = $("#sheetBody");
  sh.classList.add("on");
  sh.setAttribute("aria-hidden", "false");
  // 压一条历史记录：这样**安卓的返回键/侧滑手势**会先关掉详情，而不是直接退出网页。
  // （手机上"点进去之后按返回就整个退出"是最容易让人烦躁的体验之一。）
  try {
    if (!(history.state && history.state.sheet)) history.pushState({ sheet: code }, "", location.hash || "");
  } catch (e) { /* 某些隐私模式会禁用 history，忽略即可 */ }
  body.innerHTML = `<div class="state">加载中…</div>`;
  let d = null;
  try {
    // 个股详情也不再用 no-store：同一天反复点开同一只股票时走浏览器缓存
    const r = await fetch(DATA + "stock/" + code + ".json", { cache: "default" });
    if (r.ok) d = await r.json();
  } catch (e) { d = null; }
  let uni = null;
  try {
    const u = await api("universe");
    uni = (u.rows || []).find((x) => x.code === code) || null;
  } catch (e) { uni = null; }

  const row = d || uni || {};
  const name = row.name || code;
  $("#shName").textContent = name;
  $("#shCode").textContent = `${code}${row.industry ? " · " + row.industry : ""}`;
  const price = d ? d.price : (uni ? uni.price : null);
  const chg = d ? d.change_pct : (uni ? uni.change_pct : null);
  $("#shPrice").innerHTML = `${num(price)} <span class="${cls(chg)}">${pct(chg)}</span>`;

  const chip = (d && d.chip) || {};
  const adv = (d && d.advice) || {};
  const sc = (d && d.score) || { score: uni && uni.score, parts: uni && uni.score_parts };
  const fu = (d && d.fund) || { score: uni && uni.fund_score };
  const tr = (d && d.trend) || {};
  const rows = chip.rows || [];
  const cur = Number(price) || 0;
  const avg = rows.length ? rows.reduce((s, x) => s + x.price * x.share, 0)
    / Math.max(1e-9, rows.reduce((s, x) => s + x.share, 0)) : null;

  body.innerHTML = `
    <div class="card">
      <div class="kpis">
        <div><div class="k">评分</div><div class="v">${num(sc.score, 1)}</div></div>
        <div><div class="k">基本面</div><div class="v">${num(fu.score, 1)}</div></div>
        <div><div class="k">量化倾向</div>
          <div class="v ${adv.tone === "up" ? "up" : adv.tone === "down" ? "down" : "flat"}"
               style="font-size:16px">${esc(adv.label || (uni && uni.advice) || "—")}</div></div>
      </div>
    </div>

    ${d && d.kline && (d.kline.dates || []).length ? `
    <div class="card"><h3>K 线（收盘 / MA20 / 成交量）</h3>
      <canvas id="mk" height="150"></canvas>
      <div style="color:var(--txt3);font-size:11px;margin-top:6px">
        最近 ${(d.kline.dates || []).length} 个交易日 · 前复权 · 黄线=现价</div></div>` : ""}

    ${rows.length ? `
    <div class="card"><h3>筹码分布（估算 · 非官方）</h3>
      <div class="chips" id="mchips"></div>
      <div class="kv" style="margin-top:10px"><span class="k">获利盘（现价以下）</span>
        <span class="v up">${num(chip.profit_ratio_pct)}%</span></div>
      <div class="kv"><span class="k">套牢盘（现价以上）</span>
        <span class="v down">${num(chip.trapped_ratio_pct)}%</span></div>
      <div class="kv"><span class="k">平均筹码成本</span>
        <span class="v" style="color:var(--purple)">${num(chip.avg_cost || avg)}</span></div>
      <div class="kv"><span class="k">形态 / 集中度</span>
        <span class="v">${esc(chip.shape || "—")} / ${chip.hhi ? Number(chip.hhi).toFixed(4) : "—"}</span></div>
      <div style="color:var(--txt3);font-size:11px;margin-top:6px">${esc(chip.note || "")}</div>
    </div>` : ""}

    <div class="card"><h3>技术面 / 财务</h3>
      <div class="kv"><span class="k">MA5 / MA20 / MA60</span>
        <span class="v">${num(tr.ma5)} / ${num(tr.ma20)} / ${num(tr.ma60)}</span></div>
      <div class="kv"><span class="k">RSI14 / 量比</span>
        <span class="v">${num(tr.rsi14, 1)} / ${num(tr.volume_ratio, 2)}</span></div>
      <div class="kv"><span class="k">市盈率 / 市净率</span>
        <span class="v">${num(row.pe)} / ${num(row.pb)}</span></div>
      <div class="kv"><span class="k">ROE / 净利同比</span>
        <span class="v">${num(row.roe, 1)}% / ${pct(row.np_yoy, 1)}</span></div>
    </div>

    ${(adv.pros || []).length || (adv.cons || []).length ? `
    <div class="card"><h3>依据</h3>
      ${(adv.pros || []).map((x) => `<div class="kv"><span class="k">利多</span>
        <span class="v up">${esc(x)}</span></div>`).join("")}
      ${(adv.cons || []).map((x) => `<div class="kv"><span class="k">利空</span>
        <span class="v down">${esc(x)}</span></div>`).join("")}
    </div>` : ""}

    ${!d && uni ? `<div class="card"><div style="color:var(--txt3);font-size:11.5px">
      这只股票不在当日精算名单里，所以没有 K 线与筹码（只有资金/基本面/评分）。
      评分只用了可得的维度，不代表完整评分。</div></div>` : ""}
    <div class="card"><div style="color:var(--txt3);font-size:11px">
      ${esc(adv.note || "评分是本工具自定义的合成指标，不构成投资建议。")}</div></div>`;

  if (d && d.kline && (d.kline.dates || []).length) drawMiniK($("#mk"), d.kline, cur);
  if (rows.length) drawChips($("#mchips"), rows, cur, chip.avg_cost || avg);
}

/* ---------------- 画图（手机版只画必要的东西，省电省流量） ---------------- */
function drawBars(canvas, values, max) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 320, h = 120;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const bw = w / values.length;
  values.forEach((v, i) => {
    const bh = Math.max(2, (v / Math.max(1, max)) * (h - 26));
    ctx.fillStyle = "#e64545";
    ctx.fillRect(i * bw + bw * 0.2, h - 20 - bh, bw * 0.6, bh);
    ctx.fillStyle = "#6f6f7a"; ctx.font = "10px system-ui";
    ctx.fillText(String(v), i * bw + bw * 0.28, h - 6);
  });
}

function drawMiniK(canvas, kl, cur) {
  const n = Math.min(60, (kl.dates || []).length);
  const close = (kl.close || []).slice(-n), high = (kl.high || []).slice(-n),
        low = (kl.low || []).slice(-n), v = (kl.volume || []).slice(-n);
  if (!close.length) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 320, h = 150;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const padT = 8, padB = 30, mainH = h - padT - padB;
  const hi = Math.max(...high), lo = Math.min(...low);
  const yOf = (p) => padT + mainH - (p - lo) / Math.max(1e-6, hi - lo) * mainH;
  const xOf = (i) => (i + 0.5) * (w / n);
  // 收盘线
  ctx.strokeStyle = "#ececf1"; ctx.lineWidth = 1.4; ctx.beginPath();
  close.forEach((c, i) => { const x = xOf(i), y = yOf(c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // MA20（不足 20 根就不画，不假装）
  if (close.length >= 20) {
    const ma = [];
    for (let i = 0; i < close.length; i++) {
      if (i < 19) { ma.push(null); continue; }
      let s = 0; for (let j = i - 19; j <= i; j++) s += close[j];
      ma.push(s / 20);
    }
    ctx.strokeStyle = "#e8c07d"; ctx.lineWidth = 1; ctx.beginPath();
    let started = false;
    ma.forEach((m, i) => {
      if (m === null) return;
      const x = xOf(i), y = yOf(m);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  // 现价黄线
  const yc = yOf(cur);
  ctx.strokeStyle = "#e8a33d"; ctx.setLineDash([4, 3]); ctx.beginPath();
  ctx.moveTo(0, yc); ctx.lineTo(w, yc); ctx.stroke(); ctx.setLineDash([]);
  // 量
  const vmax = Math.max(1, ...v);
  const vh = padB - 8;
  v.forEach((x, i) => {
    const bh = Math.max(1, (x / vmax) * vh);
    ctx.fillStyle = (close[i] >= (close[i - 1] ?? close[i])) ? "#e64545" : "#20a67a";
    ctx.fillRect(i * (w / n) + 1, h - vh - 2 + (vh - bh), (w / n) - 2, bh);
  });
}

function drawChips(box, rows, cur, avgCost) {
  const list = rows.slice().sort((a, b) => b.price - a.price);
  const max = Math.max(...list.map((x) => x.share || 0), 0.01);
  box.innerHTML = list.map((x) => {
    const above = cur > 0 && x.price > cur;
    const w = Math.max(1, (x.share / max) * 100);
    return `<div class="cr"><i style="width:${w}%;background:${above ? "#3d7dff" : "#e64545"}"></i></div>`;
  }).join("");
  box.insertAdjacentHTML("afterend", `<div style="color:var(--txt3);font-size:10.5px;margin-top:6px">
    蓝 = 现价以上（套牢盘）· 红 = 现价以下（获利盘）
    ${avgCost ? ` · 平均筹码 ${num(avgCost)}（紫）` : ""} · 现价 ${num(cur)}（黄）</div>`);
}

/* ---------------- 搜索 ---------------- */
function setupSearch() {
  const lay = $("#searchLay"), q = $("#q"), res = $("#qRes");
  const close = () => { lay.classList.remove("on"); q.value = ""; res.innerHTML = ""; };
  $("#btnSearch").addEventListener("click", () => {
    lay.classList.add("on"); q.focus();
  });
  $("#qCancel").addEventListener("click", close);
  let timer = null;
  const run = async () => {
    const s = (q.value || "").trim();
    if (!s) { res.innerHTML = ""; return; }
    let uni;
    try { uni = await api("universe"); } catch (e) {
      res.innerHTML = `<div class="state err">可搜索库加载失败：${esc(e.message)}</div>`; return;
    }
    const hits = (uni.rows || []).filter((r) => r.code.startsWith(s) || (r.name || "").includes(s)).slice(0, 20);
    res.innerHTML = hits.map((r) => `
      <div class="row" data-stock="${esc(r.code)}" style="padding:10px 12px">
        <div class="nm"><b>${esc(r.name)}</b><span>${esc(r.code)} · ${esc(r.industry || "")}</span></div>
        <div class="rt"><b>${num(r.score, 1)} 分</b><span>${esc(r.advice || "")}</span></div>
      </div>`).join("") || `<div class="state">没找到「${esc(s)}」</div>`;
  };
  q.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 160); });
  res.addEventListener("click", (e) => {
    const it = e.target.closest("[data-stock]");
    if (it) { close(); openStock(it.dataset.stock); }
  });
}

/* ---------------- 启动 ---------------- */
const state = { tab: "board", limitMode: "up", sectorGroup: "industry",
                screenMode: "tech", fundSort: "chg_1y" };
const PAGES = { board: pageBoard, limitup: pageLimit, screen: pageScreen,
                sectors: pageSectors, research: pageResearch,
                funds: pageFunds, review: pageReview };
const TITLES = { board: "复盘看板", limitup: "涨停与首板", screen: "选股评分",
                 sectors: "板块行情", research: "机构动态",
                 funds: "场外 ETF / 指数基金", review: "历史股评" };

/**
 * 页面切换。
 *
 * ⚠️ 这里有个"过期渲染"的坑：每次 show() 都是"先写加载中 → await 取数 → 写内容"，
 *    在手机上数据是网络来的、有快有慢。如果用户点得快（先点「选股」再马上点「板块」），
 *    选股那一页的 await 可能**后**才返回，把已经显示出来的板块页覆盖掉 ——
 *    表现就是"点了板块，出来的却是选股"。所以用一个递增序号，
 *    只有**最后一次**切换才有资格写 DOM，过期的直接丢掉。
 */
let showSeq = 0;

async function show(tab) {
  const seq = ++showSeq;
  state.tab = tab;
  const view = $("#view");
  $("#abTitle").textContent = TITLES[tab] || "量化猎人";
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
  view.innerHTML = `<div class="state">加载中…</div>`;
  try {
    await PAGES[tab](view, state);
    if (seq !== showSeq) return;          // 已经有更新的切换了 → 这一页的结果作废
    // 列表里任何带 data-stock 的行都能点（事件委托，不用给每行绑）
    view.onclick = (e) => {
      const it = e.target.closest("[data-stock]");
      if (it && it.dataset.stock) openStock(it.dataset.stock);
    };
  } catch (e) {
    if (seq !== showSeq) return;          // 过期请求的报错也不许盖掉当前页
    view.innerHTML = `<div class="state err">加载失败：${esc(e.message)}</div>`;
  }
}

/**
 * 顶部副标题里的**时点信息**。
 *
 * 为什么手机版也要写：电脑版顶栏已经会显示"这份快照是不是收盘价"，
 * 手机上要是只写"交易日 + 档位"，同一份数据在两个端上的说法就不一致了 ——
 * 万一有人在盘中手动跑过一轮 Actions，手机上会看不出这份是**盘中价**。
 */
function snapshotTip(v) {
  const parts = [];
  if (v && v.post_close_snapshot === false) parts.push("⚠️ 盘中快照（非收盘价）");
  else if (v && v.post_close_snapshot === true) parts.push("收盘快照");
  if (v && v.snapshot_quote_time) parts.push(`行情 ${v.snapshot_quote_time.slice(5)}`);
  if (v && v.scoring_version) parts.push(`评分 ${v.scoring_version}`);
  return parts.join(" · ");
}

(async function boot() {
  $("#tabbar").addEventListener("click", (e) => {
    const b = e.target.closest(".tab");
    if (b) show(b.dataset.tab);
  });
  const closeSheet = () => {
    $("#sheet").classList.remove("on");
    $("#sheet").setAttribute("aria-hidden", "true");
  };
  $("#sheetBack").addEventListener("click", () => {
    // 用 history.back() 走同一条路径：这样"点返回"和"按安卓返回键"行为一致
    if (history.state && history.state.sheet) history.back();
    else closeSheet();
  });
  // 安卓的返回键/手势：不该直接退出网页，应该先关掉个股详情
  // （手机版早期版本没处理这个，点进去之后按返回就整页退出了）
  window.addEventListener("popstate", () => {
    if (document.getElementById("sheet").classList.contains("on")) closeSheet();
  });
  $("#btnRefresh").addEventListener("click", async () => {
    // 只在数据真的更新了才丢弃缓存 —— 否则"刷新"等于把大文件重下一遍（用户要求零成本）
    try {
      const r = await fetch(DATA + "version.json", { cache: "no-cache" });
      const v = await r.json();
      const stamp = `${v.generated_at || ""}|${v.trade_date || ""}`;
      if (localStorage.getItem(KEY_VER) !== stamp) {
        localStorage.setItem(KEY_VER, stamp);
        Object.keys(CACHE).forEach((k) => delete CACHE[k]);
      }
    } catch (e) {
      Object.keys(CACHE).forEach((k) => delete CACHE[k]);
    }
    await show(state.tab);
  });
  setupSearch();
  try {
    const v = await api("version");
    $("#abSub").textContent = `交易日 ${v.trade_date || "—"} · 档位 ${v.slot || "—"}`
      + (snapshotTip(v) ? " · " + snapshotTip(v) : "");
    if (v.placeholder) {
      $("#view").innerHTML = `<div class="state">数据尚未生成：到仓库 Actions 跑一次
        <b>update-data</b>，几分钟后刷新本页即可。</div>`;
      return;
    }
  } catch (e) {
    $("#abSub").textContent = "数据未生成";
  }
  show("board");
})();
