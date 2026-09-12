/* ============================================================
   量化猎人 · 前端逻辑（纯原生 JS，无任何第三方库/图片）
   ------------------------------------------------------------
   数据来源：同目录 ./data/*.json（GitHub Pages 静态托管，
   数据由 GitHub Actions 每天盘后自动抓取并提交回仓库）

   两个来源模式：
     · 静态站点（GitHub Pages）：读 ./data/*.json
     · 本机预览（python -m http.server）：同样读 ./data/*.json
   两者一致，不存在"本地能跑线上不行"的分支。
   ============================================================ */
"use strict";

const DATA = "./data/";
const CACHE = {};
/** 点"刷新数据"时置 true：让所有 api() 都绕过缓存重新拉（一次刷新全站生效） */
let FORCE = false;

/* ---------------- 小工具 ---------------- */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v, d = 2) => (v === null || v === undefined || v === "" || isNaN(Number(v)))
  ? "—" : Number(v).toFixed(d);
const cls = (v) => { const n = Number(v); return n > 0 ? "up" : (n < 0 ? "down" : "flat"); };
const pctTxt = (v, d = 2) => (v === null || v === undefined || isNaN(Number(v)))
  ? "—" : (Number(v) > 0 ? "+" : "") + Number(v).toFixed(d) + "%";
function money(wan, signed = true) {
  if (wan === null || wan === undefined || wan === "" || isNaN(Number(wan))) return "—";
  const n = Number(wan), a = Math.abs(n);
  const sign = signed && n > 0 ? "+" : (n < 0 ? "-" : "");
  if (a >= 10000) return sign + (a / 10000).toFixed(2) + "亿";
  return sign + a.toFixed(0) + "万";
}
/** 元 → 万元/亿元（接口回来的是元） */
const wan = (v) => (v === null || v === undefined ? null : Number(v) / 1e4);
const yi = (v) => (v === null || v === undefined ? null : Number(v) / 1e8);
function volTxt(v) {
  const n = Number(v) || 0;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + "亿";
  if (n >= 1e4) return (n / 1e4).toFixed(1) + "万";
  return String(Math.round(n));
}
function bust(url) { return url + (url.includes("?") ? "&" : "?") + "_=" + Date.now(); }

/* ---------------- 取数 ---------------- */
/** 模块 id → 数据文件名（骨架屏要不要等，就看这个名字在不在缓存里） */
const DATA_NAME = {
  board: "dashboard", limitup: "limitup", heat: "history", screen: "screen",
  sectors: "sectors", dragon: "dragon", research: "research", index: "index_kline",
  review: "review", stock: "stock", researchOne: "universe", sectorOne: "sectors",
};

/**
 * 取一份静态 JSON。
 *
 * ⚡ 零成本访问的三条规则（用户要求"一天刷 100 次，成本依然是 0"）：
 *   ① 内存缓存：同一个会话里同一份文件只解析一次；
 *   ② **交给浏览器 HTTP 缓存**（`cache: "default"` + GitHub Pages 的 ETag）：
 *      数据没变时服务器回 304，几乎不传数据体；
 *   ③ **版本闸门**：只有 `version.json` 里的 `generated_at` 变了，才丢弃缓存重下。
 *      Actions 一天只跑三次，所以你一天刷 100 次，最多只有 3 次会真的下载数据。
 *
 * ⚠️ 之前这里是 `cache: "no-store"` —— 那等于**每次打开都重新下 7MB**，
 *    正是"重复请求"的最大来源（用户这次点名要查的就是这个）。
 */
const STORE_KEY = "ashare_data_version";     // 记住"上次拿到的是哪一版数据"

async function api(name, force) {
  const useForce = !!(force || FORCE);
  if (!useForce && CACHE[name]) return CACHE[name];     // ① 内存缓存
  const url = DATA + name + ".json";
  // ⚠️ 连"强制刷新"也**不再加时间戳绕过缓存**：刷新按钮的职责是"重新读已生成的 JSON"，
  //    不是"把 7MB 重下一遍"。真正需要新数据时，版本号会变，缓存自然失效。
  void useForce;
  let r;
  try {
    r = await fetch(url, { cache: "default" });
  } catch (e) {
    throw new Error(`数据加载失败：${e.message}（data/${name}.json）`);
  }
  if (!r.ok) throw new Error(`数据加载失败 HTTP ${r.status}（data/${name}.json）`);
  const j = await r.json();
  CACHE[name] = j;
  return j;
}

/**
 * 刷新按钮用的"轻量检查"：只重新校验 version.json（约 2.7KB，命中 ETag 时是 304 空响应）。
 * 版本没变 → 返回 false，调用方**什么都不用重新下载**。
 */
async function dataChanged() {
  try {
    const r = await fetch(DATA + "version.json", { cache: "no-cache" });  // 只校验这一个文件
    if (!r.ok) return true;
    const v = await r.json();
    const seen = localStorage.getItem(STORE_KEY) || "";
    const now = `${v.generated_at || ""}|${v.trade_date || ""}`;
    if (seen && seen === now) return false;
    localStorage.setItem(STORE_KEY, now);
    return true;
  } catch (e) {
    return true;      // 校验失败就当有更新（宁可多下一次，也不要显示旧数据）
  }
}

/* ---------------- 浏览器实时补数：腾讯行情日线 ----------------
   为什么需要：GitHub Pages 是纯静态站，只有 Actions 预生成的那批股票有 K 线快照。
   用户在搜索框搜到别的股票时就没有 K 线和指标可看（用户反馈"只有基本面"）。
   腾讯这个接口返回 `Access-Control-Allow-Origin: *`（已实测），所以**浏览器可以直接取**，
   搜任意股票都能立刻画出前复权日 K，指标仍在前端本地算。
   注意：这条路径是"实时抓取"，不是当日存档快照，页面会显著标注来源与时间。 */
function codePrefix(code) {
  const c = String(code || "");
  if (/^(60|68|9|5)/.test(c)) return "sh";
  if (/^(00|30|20|1)/.test(c)) return "sz";
  if (/^(4|8)/.test(c)) return "bj";
  return "sh";
}

/** 实时取日线（前复权）。返回与后端 kline 完全相同的结构，后面所有代码可直接复用。 */
//: 是否允许"前端直连腾讯取日线"这条兜底路径。
//  为什么留着：Pages 上只有 Actions 生成的那批股票有 K 线；搜索别的股票就没图可看。
//  它**免费、无需 Key、不消耗任何 Token**，但严格说确实是"前端调外部接口"——
//  按你的要求留了这个开关：改成 false 就彻底关掉（关掉后搜索非存档股票只显示基本面）。
const ALLOW_LIVE_KLINE = true;

async function liveKline(code, bars = 260) {
  const sym = codePrefix(code) + code;
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${bars},qfq`;
  // 当天缓存：同一只股票一天只请求一次（日线当天不会变），
  // 这样即使你一天点开 100 次同一只股票，外部请求也只有 1 次。
  const key = `ashare_live_${sym}_${new Date().toISOString().slice(0, 10)}`;
  try {
    const hit = localStorage.getItem(key);
    if (hit) return JSON.parse(hit);
  } catch (e) { /* 隐私模式/超限，忽略 */ }
  if (!ALLOW_LIVE_KLINE) throw new Error("前端实时取数已关闭（ALLOW_LIVE_KLINE=false）");
  const r = await fetch(url, { cache: "default" });
  if (!r.ok) throw new Error(`实时行情 HTTP ${r.status}`);
  const j = await r.json();
  const node = (j && j.data && j.data[sym]) || {};
  const raw = node.qfqday || node.day || [];
  // 存回当天缓存（注意：下面解析完还会再写一次，因为这里拿到的还是原始结构）
  try { localStorage.setItem(key, JSON.stringify({ __raw: raw, sym })); } catch (e) { /* 忽略 */ }
  // ⚠️ 腾讯的字段顺序是「日期, 开, 收, 高, 低, 量」——不是 OHLCV。
  //    按 OHLCV 解析会把"最高价"当收盘价画，图能画出来但全是错的（已踩过）。
  const out = { dates: [], open: [], close: [], high: [], low: [], volume: [] };
  raw.forEach((row) => {
    if (!row || row.length < 6) return;
    out.dates.push(String(row[0]));
    out.open.push(Number(row[1]));
    out.close.push(Number(row[2]));
    out.high.push(Number(row[3]));
    out.low.push(Number(row[4]));
    out.volume.push(Number(row[5]));
  });
  if (!out.dates.length) throw new Error("实时行情返回为空（该代码可能已退市或非交易品种）");
  return out;
}

/* ============================================================
   技术指标（纯函数，前端本地计算 —— 后端只传 OHLCV，数据小、离线也能算）
   口径：MACD 柱=2×(DIF−DEA)；KDJ 的 K/D 用 1/3 平滑；RSI 用 Wilder；BOLL 用总体标准差
   ============================================================ */
function kSma(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0, cnt = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || isNaN(v)) { sum = 0; cnt = 0; continue; }
    sum += v; cnt++;
    if (cnt > n) { sum -= values[i - n]; cnt = n; }
    if (cnt === n) out[i] = sum / n;
  }
  return out;
}
function kEma(values, n) {
  const out = new Array(values.length).fill(null);
  const a = 2 / (n + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || isNaN(v)) continue;
    prev = prev === null ? v : a * v + (1 - a) * prev;
    out[i] = prev;
  }
  return out;
}
function kStd(values, n) {
  const out = new Array(values.length).fill(null);
  for (let i = n - 1; i < values.length; i++) {
    let s = 0, ok = true;
    for (let j = i - n + 1; j <= i; j++) {
      if (values[j] === null || isNaN(values[j])) { ok = false; break; }
      s += values[j];
    }
    if (!ok) continue;
    const mean = s / n;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (values[j] - mean) ** 2;
    out[i] = Math.sqrt(sq / n);
  }
  return out;
}
function kMacd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = kEma(closes, fast), es = kEma(closes, slow);
  const dif = closes.map((_, i) => (ef[i] === null || es[i] === null) ? null : ef[i] - es[i]);
  const dea = kEma(dif, signal);
  const bar = dif.map((v, i) => (v === null || dea[i] === null) ? null : 2 * (v - dea[i]));
  return { dif, dea, bar };
}
function kKdj(highs, lows, closes, n = 9) {
  const len = closes.length;
  const K = new Array(len).fill(null), D = new Array(len).fill(null), J = new Array(len).fill(null);
  let pk = 50, pd = 50;
  for (let i = 0; i < len; i++) {
    if (i < n - 1) continue;
    let hh = -Infinity, ll = Infinity;
    for (let j = i - n + 1; j <= i; j++) {
      if (highs[j] > hh) hh = highs[j];
      if (lows[j] < ll) ll = lows[j];
    }
    const rsv = hh === ll ? 50 : (closes[i] - ll) / (hh - ll) * 100;
    pk = (2 / 3) * pk + (1 / 3) * rsv;
    pd = (2 / 3) * pd + (1 / 3) * pk;
    K[i] = pk; D[i] = pd; J[i] = 3 * pk - 2 * pd;
  }
  return { k: K, d: D, j: J };
}
function kRsi(closes, n = 14) {
  const len = closes.length;
  const out = new Array(len).fill(null);
  let avgG = 0, avgL = 0;
  for (let i = 1; i < len; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = Math.max(ch, 0), l = Math.max(-ch, 0);
    if (i <= n) {
      avgG += g / n; avgL += l / n;
      if (i === n) out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    } else {
      avgG = (avgG * (n - 1) + g) / n;
      avgL = (avgL * (n - 1) + l) / n;
      out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }
  }
  return out;
}
function kBoll(closes, n = 20, k = 2) {
  const mid = kSma(closes, n), sd = kStd(closes, n);
  return {
    mid,
    up: mid.map((m, i) => (m === null || sd[i] === null) ? null : m + k * sd[i]),
    dn: mid.map((m, i) => (m === null || sd[i] === null) ? null : m - k * sd[i]),
  };
}
function kPrepare(kl) {
  if (!kl || !kl.dates || !kl.dates.length) return null;
  const o = kl.open || [], h = kl.high || [], l = kl.low || [], c = kl.close || [],
        v = kl.volume || [];
  return {
    dates: kl.dates, open: o, high: h, low: l, close: c, volume: v,
    amount: kl.amount || null,   // 成交额（浏览器实时抓腾讯那条路拿不到 → 浮层显示"—"）
    ma5: kSma(c, 5), ma10: kSma(c, 10), ma20: kSma(c, 20), ma60: kSma(c, 60),
    macd: kMacd(c), kdj: kKdj(h, l, c), rsi: kRsi(c), boll: kBoll(c),
  };
}

/* ============================================================
   K 线绘制（canvas，红涨绿跌）
   ============================================================ */
const KC = {
  up: "#e64545", down: "#20a67a", trapped: "#3d7dff", chip: "#5f86ad", amber: "#e8a33d",
  avg: "#a06ee8",                       // 平均筹码紫线
  grid: "#1f1f24", axis: "#5a5a62",
  text: "#a8a8b0", ma5: "#e8c07d", ma10: "#7dc8e8", ma20: "#c48fe8", ma60: "#8ee8b0",
  boll: "#4a4a52", dif: "#e8c07d", dea: "#7dc8e8", k: "#e8c07d", d: "#7dc8e8",
  j: "#c48fe8", rsi: "#e8c07d",
};

function _kctx(canvas) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth || 640;
  const h = canvas.clientHeight || 320;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function _line(ctx, pts, color, width) {
  ctx.strokeStyle = color; ctx.lineWidth = width || 1;
  ctx.beginPath();
  let started = false;
  for (const p of pts) {
    if (p === null || p === undefined) { started = false; continue; }
    if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.stroke();
}
function drawKline(canvas) {
  const st = canvas.__kstate;
  if (!st || !st.data) return;
  const { ctx, w, h } = _kctx(canvas);
  const D = st.data;
  const total = D.dates.length;
  const n = Math.max(20, Math.min(st.bars || total, total));
  const from = total - n;
  const padL = 4, padR = 52, padT = 8, padB = 20;
  const plotW = w - padL - padR;
  const showInd = st.ind !== "NONE";
  const gap = 14;
  const avail = h - padT - padB - gap * (showInd ? 2 : 1);
  const mainH = showInd ? avail * 0.58 : avail * 0.78;
  const volPaneH = showInd ? avail * 0.18 : avail * 0.20;
  const volTop = padT + mainH + gap;
  const indTop = volTop + volPaneH + gap;
  const indH = showInd ? h - padB - indTop : 0;

  let hi = -Infinity, lo = Infinity;
  for (let i = from; i < total; i++) {
    if (D.high[i] > hi) hi = D.high[i];
    if (D.low[i] < lo) lo = D.low[i];
    for (const key of ["up", "dn"]) {
      const b = D.boll[key][i];
      if (b !== null && b !== undefined) { if (b > hi) hi = b; if (b < lo) lo = b; }
    }
  }
  if (!isFinite(hi) || !isFinite(lo)) return;
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  hi += pad; lo -= pad;

  const step = plotW / n;
  const xOf = (i) => padL + (i - from + 0.5) * step;
  const yOf = (p) => padT + mainH - (p - lo) / (hi - lo) * mainH;
  const bodyW = Math.max(1.6, step * 0.62);

  ctx.font = "10px -apple-system, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let g = 0; g <= 4; g++) {
    const y = padT + mainH * g / 4;
    ctx.strokeStyle = KC.grid; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(padL + plotW, y + 0.5); ctx.stroke();
    ctx.fillStyle = KC.axis; ctx.textAlign = "left";
    ctx.fillText((hi - (hi - lo) * g / 4).toFixed(2), padL + plotW + 4, y);
  }
  if (st.boll !== false) {
    _line(ctx, D.boll.up.map((v, i) => v === null ? null : [xOf(i), yOf(v)]), KC.boll, 1);
    _line(ctx, D.boll.dn.map((v, i) => v === null ? null : [xOf(i), yOf(v)]), KC.boll, 1);
  }
  for (let i = from; i < total; i++) {
    const o = D.open[i], c = D.close[i], hh = D.high[i], ll = D.low[i];
    if (o === null || c === null) continue;
    ctx.strokeStyle = ctx.fillStyle = (c >= o) ? KC.up : KC.down;
    const x = xOf(i);
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yOf(hh)); ctx.lineTo(x, yOf(ll)); ctx.stroke();
    const y1 = yOf(Math.max(o, c)), y2 = yOf(Math.min(o, c));
    ctx.fillRect(x - bodyW / 2, y1, bodyW, Math.max(1, y2 - y1));
  }
  for (const [key, color] of [["ma5", KC.ma5], ["ma10", KC.ma10],
                              ["ma20", KC.ma20], ["ma60", KC.ma60]]) {
    _line(ctx, D[key].map((v, i) => v === null ? null : [xOf(i), yOf(v)]), color, 1);
  }

  let vmax = 0;
  for (let i = from; i < total; i++) vmax = Math.max(vmax, D.volume[i] || 0);
  ctx.strokeStyle = KC.grid;
  ctx.beginPath(); ctx.moveTo(padL, volTop + volPaneH + 0.5);
  ctx.lineTo(padL + plotW, volTop + volPaneH + 0.5); ctx.stroke();
  if (vmax > 0) {
    for (let i = from; i < total; i++) {
      const o = D.open[i], c = D.close[i], vol = D.volume[i] || 0;
      ctx.fillStyle = (c >= o) ? KC.up : KC.down;
      const bh = Math.max(1, vol / vmax * (volPaneH - 4));
      ctx.fillRect(xOf(i) - bodyW / 2, volTop + volPaneH - bh, bodyW, bh);
    }
    ctx.fillStyle = KC.text; ctx.textAlign = "left";
    ctx.fillText("量 " + volTxt(vmax), padL + plotW + 4, volTop + 8);
  }

  if (showInd) {
    ctx.strokeStyle = KC.grid;
    ctx.beginPath(); ctx.moveTo(padL, indTop + 0.5); ctx.lineTo(padL + plotW, indTop + 0.5);
    ctx.stroke();
    if (st.ind === "MACD") {
      let m = 0;
      for (let i = from; i < total; i++) {
        const b = D.macd.bar[i];
        if (b !== null) m = Math.max(m, Math.abs(b));
      }
      const y0 = indTop + indH / 2;
      ctx.strokeStyle = KC.grid;
      ctx.beginPath(); ctx.moveTo(padL, y0 + 0.5); ctx.lineTo(padL + plotW, y0 + 0.5); ctx.stroke();
      if (m > 0) {
        for (let i = from; i < total; i++) {
          const b = D.macd.bar[i];
          if (b === null) continue;
          ctx.fillStyle = b >= 0 ? KC.up : KC.down;
          const bh = Math.max(1, Math.abs(b) / m * (indH / 2 - 2));
          ctx.fillRect(xOf(i) - bodyW / 2, b >= 0 ? y0 - bh : y0, bodyW, bh);
        }
        const yM = (v) => y0 - v / m * (indH / 2 - 2);
        _line(ctx, D.macd.dif.map((v, i) => v === null ? null : [xOf(i), yM(v)]), KC.dif, 1);
        _line(ctx, D.macd.dea.map((v, i) => v === null ? null : [xOf(i), yM(v)]), KC.dea, 1);
      }
      ctx.fillStyle = KC.text; ctx.textAlign = "left";
      ctx.fillText("MACD", padL + plotW + 4, indTop + 8);
    } else if (st.ind === "KDJ") {
      const yK = (v) => indTop + indH - Math.max(0, Math.min(100, v)) / 100 * indH;
      for (const lvl of [20, 50, 80]) {
        ctx.strokeStyle = KC.grid;
        ctx.beginPath(); ctx.moveTo(padL, yK(lvl) + 0.5); ctx.lineTo(padL + plotW, yK(lvl) + 0.5);
        ctx.stroke();
        ctx.fillStyle = KC.axis; ctx.textAlign = "left";
        ctx.fillText(String(lvl), padL + plotW + 4, yK(lvl));
      }
      _line(ctx, D.kdj.k.map((v, i) => v === null ? null : [xOf(i), yK(v)]), KC.k, 1);
      _line(ctx, D.kdj.d.map((v, i) => v === null ? null : [xOf(i), yK(v)]), KC.d, 1);
      _line(ctx, D.kdj.j.map((v, i) => v === null ? null : [xOf(i), yK(v)]), KC.j, 1);
    } else if (st.ind === "RSI") {
      const yR = (v) => indTop + indH - Math.max(0, Math.min(100, v)) / 100 * indH;
      for (const lvl of [30, 50, 70]) {
        ctx.strokeStyle = KC.grid;
        ctx.beginPath(); ctx.moveTo(padL, yR(lvl) + 0.5); ctx.lineTo(padL + plotW, yR(lvl) + 0.5);
        ctx.stroke();
        ctx.fillStyle = KC.axis; ctx.textAlign = "left";
        ctx.fillText(String(lvl), padL + plotW + 4, yR(lvl));
      }
      _line(ctx, D.rsi.map((v, i) => v === null ? null : [xOf(i), yR(v)]), KC.rsi, 1);
    }
  }

  ctx.fillStyle = KC.axis; ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let t = 0; t <= 4; t++) {
    const i = Math.min(total - 1, from + Math.round((n - 1) * t / 4));
    let x = xOf(i);
    x = Math.max(padL + 18, Math.min(padL + plotW - 18, x));
    ctx.fillText(String(D.dates[i] || "").slice(5), x, h - padB + 4);
  }
  if (st.cursor !== null && st.cursor !== undefined && st.cursor >= from && st.cursor < total) {
    const x = xOf(st.cursor), y = yOf(D.close[st.cursor]);
    ctx.strokeStyle = "#6b6b74"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x + 0.5, padT); ctx.lineTo(x + 0.5, padT + mainH); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(padL + plotW, y + 0.5); ctx.stroke();
    ctx.fillStyle = KC.text; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillText(num(D.close[st.cursor]), padL + plotW + 4, y);
  }
}

/**
 * 光标处浮层：显示"鼠标所在位置那一段"的指标数值。
 *
 * 用户反馈："为什么鼠标放在指标上没有显示各指标的？"
 * 原来只有顶部那一行文字（而且早期还必须按住鼠标才更新）。现在：
 *   · 顶部那一行仍然给该日的**完整**明细
 *   · 另外在光标旁边浮出一个小框，**按光标落在哪个子图**给对应的值：
 *       价格区 → 开/高/低/收 + 涨跌 + MA
 *       成交量区 → 量、量比（对 5 日均量）
 *       指标区   → 当前指标（MACD 的 DIF/DEA/柱 或 KDJ 或 RSI 或 BOLL）
 *     这样"鼠标放在 MACD 上就看 MACD、放在成交量上就看成交量"。
 */
function klinePaneTip(D, idx, ind, pane) {
  if (!D || idx === null || idx === undefined || idx >= D.dates.length) return "";
  const o = D.open[idx], h = D.high[idx], l = D.low[idx], c = D.close[idx], v = D.volume[idx];
  const prev = idx > 0 ? D.close[idx - 1] : null;
  const chg = prev ? (c - prev) / prev * 100 : null;
  const row = (k, val, cls2) =>
    `<div class="tr"><span>${esc(k)}</span><b class="${cls2 || ""}">${val}</b></div>`;
  let title = "", body = "";
  if (pane === "vol") {
    title = "成交量";
    const avg5 = D.volume.slice(Math.max(0, idx - 4), idx + 1);
    const ma5v = avg5.length ? avg5.reduce((s, x) => s + (Number(x) || 0), 0) / avg5.length : null;
    body = row("成交量", volTxt(v))
      + row("5日均量", ma5v ? volTxt(ma5v) : "—")
      + row("量比", ma5v ? num((Number(v) || 0) / ma5v, 2) : "—")
      + row("成交额", D.amount && D.amount[idx] !== undefined
        ? money(yi(D.amount[idx]), false) + "亿" : "—");
  } else if (pane === "ind") {
    if (ind === "MACD") {
      title = "MACD(12,26,9)";
      body = row("DIF", num(D.macd.dif[idx], 3))
        + row("DEA", num(D.macd.dea[idx], 3))
        + row("MACD柱", num(D.macd.bar[idx], 3), cls(D.macd.bar[idx]));
    } else if (ind === "KDJ") {
      title = "KDJ(9,3,3)";
      body = row("K", num(D.kdj.k[idx], 1)) + row("D", num(D.kdj.d[idx], 1))
        + row("J", num(D.kdj.j[idx], 1));
    } else if (ind === "RSI") {
      title = "RSI(14)";
      body = row("RSI14", num(D.rsi[idx], 1));
    } else {
      title = "以上都显示（未选子图）";
      body = row("MACD柱", num(D.macd.bar[idx], 3), cls(D.macd.bar[idx]))
        + row("KDJ J", num(D.kdj.j[idx], 1)) + row("RSI14", num(D.rsi[idx], 1));
    }
  } else {
    title = "价格";
    body = row("开", num(o)) + row("高", num(h)) + row("低", num(l))
      + row("收", num(c), cls(chg)) + row("涨跌幅", pctTxt(chg), cls(chg))
      + row("MA5 / MA20", `${num(D.ma5[idx])} / ${num(D.ma20[idx])}`);
  }
  return `<div class="tt">${esc(D.dates[idx])} · ${esc(title)}</div>${body}`;
}

function klineInfoHTML(D, idx, ind) {
  if (!D || idx === null || idx === undefined || idx >= D.dates.length) return "";
  const o = D.open[idx], h = D.high[idx], l = D.low[idx], c = D.close[idx], v = D.volume[idx];
  const prev = idx > 0 ? D.close[idx - 1] : null;
  const chg = prev ? (c - prev) / prev * 100 : null;
  const ampl = (o && l) ? (h - l) / (prev || o) * 100 : null;       // 振幅
  const parts = [
    `<b>${esc(D.dates[idx])}</b>`, `开 ${num(o)}`, `高 ${num(h)}`, `低 ${num(l)}`,
    `<span class="${cls(chg)}">收 ${num(c)}${chg === null ? "" : ` (${pctTxt(chg)})`}</span>`,
    `振幅 ${pctTxt(ampl)}`,
    `量 ${volTxt(v)}`,
    `MA5 ${num(D.ma5[idx])}`, `MA10 ${num(D.ma10[idx])}`,
    `MA20 ${num(D.ma20[idx])}`, `MA60 ${num(D.ma60[idx])}`,
    `BOLL ${num(D.boll.up[idx])}/${num(D.boll.mid[idx])}/${num(D.boll.dn[idx])}`,
  ];
  // 当前下方子图用的是哪个指标，就把哪个指标的**该日数值**一起给出来
  if (ind === "MACD") {
    parts.push(`DIF ${num(D.macd.dif[idx], 3)}`, `DEA ${num(D.macd.dea[idx], 3)}`,
               `MACD柱 ${num(D.macd.bar[idx], 3)}`);
  } else if (ind === "KDJ") {
    parts.push(`K ${num(D.kdj.k[idx], 1)}`, `D ${num(D.kdj.d[idx], 1)}`, `J ${num(D.kdj.j[idx], 1)}`);
  } else if (ind === "RSI") {
    parts.push(`RSI14 ${num(D.rsi[idx], 1)}`);
  } else {
    parts.push(`MACD ${num(D.macd.bar[idx], 3)}`, `KDJ J ${num(D.kdj.j[idx], 1)}`,
               `RSI14 ${num(D.rsi[idx], 1)}`);
  }
  const ma20 = D.ma20[idx];
  if (ma20) parts.push(`距MA20 ${pctTxt((c - ma20) / ma20 * 100)}`);
  return parts.join(" · ");
}

/**
 * 挂载图表：设置数据、绑定交互（只绑一次）、绘制。
 * opts.info 是**面板内的选择器**（如 ".kinfo"），不是全局 id：
 *   页面固定三个界面，可能同时有 3 张 K 线图，用 id 会全部挤到第一个面板上。
 */
function mountKline(canvas, kl, opts) {
  if (!canvas) return;
  const data = kPrepare(kl);
  if (!data) {
    canvas.style.display = "none";
    const tip = canvas.parentNode && canvas.parentNode.querySelector(".kempty");
    if (tip) tip.style.display = "block";
    return;
  }
  const o = opts || {};
  const card = canvas.closest ? (canvas.closest(".mod") || document) : document;
  const infoOf = () => (o.info ? card.querySelector(o.info) : null);
  const tipOf = () => (canvas.parentNode ? canvas.parentNode.querySelector(".ktip") : null);
  canvas.__kstate = { data, bars: o.bars || 60, ind: o.ind || "MACD",
                      boll: o.boll !== false, cursor: null, info: o.info || null, card };
  if (!canvas.__kbound) {
    canvas.__kbound = true;
    // ⚡ 性能：pointermove 一秒能来上百次，每次都重画整张 canvas（含指标线）会明显卡顿。
    //    改成"记录最新坐标 + 每帧只画一次"（rAF 合并），手感不变但掉帧消失。
    let pendingX = null, pendingY = null, frame = 0;
    const flush = () => {
      frame = 0;
      if (pendingX === null) return;
      pickNow(pendingX, pendingY);
    };
    const queue = (x, y) => {
      pendingX = x; pendingY = y;
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const pick = (clientX, clientY) => queue(clientX, clientY);
    const pickNow = (clientX, clientY) => {
      const st = canvas.__kstate;
      if (!st) return;
      const rect = canvas.getBoundingClientRect();
      const plotW = rect.width - 4 - 52;
      const total = st.data.dates.length;
      const n = Math.min(st.bars, total);
      const from = total - n;
      const step = plotW / n;
      let idx = from + Math.floor((clientX - rect.left - 4) / step);
      idx = Math.max(from, Math.min(total - 1, idx));
      if (idx === st.cursor && clientY === undefined) return;   // 同一根就不重画
      st.cursor = idx;
      const box = st.info ? (st.card || document).querySelector(st.info) : null;
      if (box) box.innerHTML = klineInfoHTML(st.data, idx, st.ind);
      // ---- 光标处浮层：按纵向位置判断鼠标在哪个子图 ----
      const tip = tipOf();
      if (tip && clientY !== undefined) {
        const H = rect.height || 320;
        const padT = 8, padB = 20, gap = 14;
        const showInd = st.ind !== "NONE";
        const avail = H - padT - padB - gap * (showInd ? 2 : 1);
        const mainH = showInd ? avail * 0.58 : avail * 0.78;
        const volH = showInd ? avail * 0.18 : avail * 0.20;
        const yIn = clientY - rect.top;
        const pane = yIn <= padT + mainH ? "price"
          : (yIn <= padT + mainH + gap + volH ? "vol" : "ind");
        const html = klinePaneTip(st.data, idx, st.ind, pane);
        if (tip.__html !== html) { tip.innerHTML = html; tip.__html = html; }
        tip.classList.add("show");
        const wrapRect = canvas.parentNode.getBoundingClientRect();
        const tw = tip.offsetWidth || 150;
        let left = clientX - wrapRect.left + 14;
        if (left + tw > wrapRect.width) left = Math.max(4, clientX - wrapRect.left - tw - 14);
        tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(Math.max(4, yIn - 10))}px)`;
      }
      drawKline(canvas);
    };
    canvas.addEventListener("pointerdown", (e) => pick(e.clientX, e.clientY));
    // 关键修复：原来这里要求 `e.buttons`（必须**按住鼠标**才更新），
    // 所以"鼠标放上去"什么也不显示（用户反馈"为什么没有鼠标所在位置的指标数据"）。
    // 现在只要指针在图上移动就取数：鼠标、触屏、手写笔都直接出数据。
    canvas.addEventListener("pointermove", (e) => pick(e.clientX, e.clientY));
    canvas.addEventListener("touchmove", (e) => {
      const t = e.touches && e.touches[0];
      if (t) pick(t.clientX, t.clientY);
    }, { passive: true });
    canvas.addEventListener("pointerleave", () => {
      const st = canvas.__kstate;
      if (!st) return;
      st.cursor = null;
      const box = st.info ? (st.card || document).querySelector(st.info) : null;
      if (box) box.innerHTML = klineInfoHTML(st.data, st.data.dates.length - 1, st.ind);
      const tip = tipOf();
      if (tip) tip.classList.remove("show");
      drawKline(canvas);
    });
  }
  const info = infoOf();
  if (info) info.innerHTML = klineInfoHTML(data, data.dates.length - 1, canvas.__kstate.ind);
  requestAnimationFrame(() => drawKline(canvas));
}

/** 指标 / 区间切换按钮（canvasId 在同一时刻唯一：一个模块只会出现在一个界面里） */
function klineSet(canvasId, key, value) {
  const c = document.getElementById(canvasId);
  if (!c || !c.__kstate) return;
  const st = c.__kstate;
  if (key === "ind") st.ind = value;
  if (key === "bars") { st.bars = Number(value); st.cursor = null; }
  const box = st.info ? (st.card || document).querySelector(st.info) : null;
  if (box) box.innerHTML = klineInfoHTML(st.data, st.data.dates.length - 1, st.ind);
  const card = c.closest(".mod") || document;
  card.querySelectorAll(`[data-k="${key}"]`).forEach((b) =>
    b.classList.toggle("on", String(b.dataset.v) === String(value)));
  drawKline(c);
}
window.addEventListener("resize", () => {
  document.querySelectorAll("canvas.kc").forEach((c) => { if (c.__kstate) drawKline(c); });
});
/* 横竖屏切换：跨越断点时重排一次（竖屏=三个界面竖着排；横屏=三个界面并排），
   并加一个"旋转翻面"的过渡动画（用户要求：横向↔竖向要有旋转过渡）。
   顺便把"放大的界面"收回三列——否则横屏放大的状态带到竖屏会只剩一块。 */
let wasPortrait = window.innerWidth < 1080;
window.addEventListener("resize", () => {
  const now = window.innerWidth < 1080;
  sizeStage();
  if (now === wasPortrait) { applyCols($("#stage")); return; }
  wasPortrait = now;
  state.zoom = null;
  state.vactiveSlot = state.activeSlot;
  renderShell();
  playRotateIn();
});

/* ============================================================
   9 个功能模块 —— 它们是"可以放进三个界面的内容"，不是页面结构本身
   （页面结构固定是三个界面，见下面的 slot 说明）
   ============================================================ */
const MODULES = [
  { id: "board", tag: "复盘", cls: "b-blue", short: "看板", title: "复盘看板",
    desc: "市场情绪、涨跌家数、涨停/跌停/炸板、主力资金流入流出榜" },
  { id: "limitup", tag: "盘面", cls: "b-red", short: "涨停", title: "涨停与首板",
    desc: "涨停池、连板天梯、首板梳理（含封板时间/封单额/炸板次数）" },
  { id: "heat", tag: "近5天", cls: "b-amber", short: "热度", title: "近 5 天热度",
    desc: "近 5 个交易日涨停家数与情绪变化，看赚钱效应在升温还是降温" },
  { id: "screen", tag: "选股", cls: "b-purple", short: "选股", title: "选股评分（每日 Top 10~15）",
    desc: "对全部候选逐只打分并按评分排序，点“评分”表头可切换升/降序；点一行看个股详情" },
  { id: "sectors", tag: "板块", cls: "b-cyan", short: "板块", title: "板块行情",
    desc: "行业/概念/ETF 资金流排行 + 每个板块的 5 只龙头股；点板块看它的 K 线、指标与筹码峰" },
  { id: "dragon", tag: "龙虎榜", cls: "b-amber", short: "龙虎", title: "龙虎榜与席位",
    desc: "上榜个股明细 + 每只买卖席位 Top5（营业部、净额、3日胜率）" },
  { id: "research", tag: "机构", cls: "b-purple", short: "机构", title: "机构动态",
    desc: "机构调研 + 券商研报 + 评级汇总，标注看多/看空（调研只有关注度）" },
  { id: "index", tag: "大盘", cls: "b-blue", short: "大盘", title: "大盘 K 线",
    desc: "上证 / 深证 / 创业板 / 沪深300 日 K（成交量、MA、MACD、KDJ、RSI、BOLL）" },
  { id: "stock", tag: "个股", cls: "b-green", short: "个股", title: "个股详情",
    desc: "在“选股评分”里点任意一行进入：K 线、筹码分布、资金、机构多空" },
  { id: "review", tag: "回评", cls: "b-purple", short: "股评", title: "历史股评（近 5 期）",
    desc: "每日评分最高的那批，下一交易日回填涨跌幅，汇总胜率与平均涨幅；只留最近 5 期" },
  { id: "selfcheck", tag: "自检", cls: "b-amber", short: "自检", title: "系统自检 / 决策复盘",
    desc: "推荐组合的真实结果（可执行口径）、相对沪深300的超额、策略有效性评级、市场环境与空仓预警、因子健康度、抓取自愈账本" },
  { id: "funds", tag: "场外", cls: "b-cyan", short: "场外ETF", title: "场外 ETF / 指数基金",
    desc: "场外 ETF 联接与指数基金排行：净值、日涨跌、近1周/1月/3月/1年、今年来；可按周期排序与筛选" },
];
const MODULE_IDS = MODULES.map((m) => m.id);

/* 搜索出来的"个股分析页"：按需出现的第 10 个模块（只在搜过股票后才进下拉框） */
const RESEARCH_MOD = {
  id: "researchOne", tag: "个股", cls: "b-green", short: "个股分析",
  title: "个股分析（搜索结果）",
  desc: "K 线 + 全部指标、筹码分布、评分构成、基本面、机构多空与量化倾向",
};

/* 板块分析页：按需出现（从"板块行情"点某个板块进来） */
const SECTOR_MOD = {
  id: "sectorOne", tag: "板块", cls: "b-cyan", short: "板块分析",
  title: "板块分析",
  desc: "板块指数 K 线 + 全部指标 + 筹码峰 + 该板块 5 只龙头股",
};

const STANCE_CLS = { "看多": "tag-u", "看空": "tag-d", "中性": "tag-n", "未评级": "tag-n" };
function stanceTag(s) {
  const k = STANCE_CLS[s] || "tag-n";
  return `<span class="stance ${k}">${esc(s || "未评级")}</span>`;
}
/* ---------------- 三个界面（slot）：页面的真实结构 ----------------
   用户要求（原话）：
     · "一个电脑界面能同时看到三个不同模块的内容"、"跟第一版一样"
     · "拖动上方的模块到左边的缝隙替换左边的界面，右边的缝隙替换右边的界面"
     · "竖着的时候三个界面竖着排列"
     · "在展开界面的时候，不要有上方的模块"

   所以页面结构是**固定的三个界面**（slot 0 / 1 / 2）：
     · 横屏：三列并排（一屏同时看到三块内容）
     · 竖屏：三块竖着排（同第一版）
     · 9 个模块是"可以放进界面的内容"，由顶部模块条（横屏）或每个界面自己的下拉来更换
     · 换内容用**交换**语义：把 A 放进已经有 B 的界面时，B 回到 A 原来那个界面 ——
       既不会两个界面显示同一个模块，也不会把任何模块弄丢
     · 某个界面可以「⤢ 放大」占满整行；**放大时顶部模块条整条隐藏**（用户明确要求）
   ============================================================ */
const SLOT_COUNT = 3;
const SLOTS_KEY = "ashare_slots";
const DEFAULT_SLOTS = ["board", "screen", "sectors"];

/* ============================================================
   界面卡片的**唯一定位方式**（这里踩过一个很隐蔽的坑，务必看完再改）
   ------------------------------------------------------------
   历史：面板卡片本来是 `article.mod[data-slot="i"]`，但界面**内部的控件**
   （模块下拉、‹ › 翻页按钮、放大模式左侧的模块列表项）当时也带了 `data-slot="i"`。
   于是 `document.querySelectorAll("[data-slot]")` 一次命中 5 个元素：
       1) 竖排切换器按钮 .vc   2) 面板卡片 article.mod
       3) 模块下拉 select      4) ‹ 按钮    5) › 按钮
   而 FLIP 动画（playFlip / renderShell）是按 `data-slot` 建 Map 的 ——
   **同名的后一个会覆盖前一个**，最后 Map 里留下的是 `›` 按钮那 26×26 的方块。
   结果：面板被按 26px 的"旧位置"做缩放（scale ≈ 26/500 ≈ 0.05，整块从小方块炸开），
   而顶部那两个 ‹ › 箭头则拿到别的元素的 rect，缩放比能到 21 倍 ——
   这就是用户看到的"顶部两个箭头大小异常"。

   所以现在的约定（**不要再混用**）：
     · `data-slot`  —— 只给"一个界面的卡片本体"，以及竖排切换器的按钮
                       （竖排按钮不在 #stage 里，不会被 PANEL_SEL 命中）
     · `data-panel` —— 界面**内部**的控件要知道自己属于哪个界面时用这个
     · 任何"按界面找卡片 / 量卡片"的地方，一律用 PANEL_SEL 或 panelEl(i)
   ============================================================ */
const PANEL_SEL = "#stage > article.mod[data-slot]";
/** 按序号取界面卡片本体（不是它内部的按钮/下拉）。 */
const panelEl = (i) => document.querySelector(`#stage > article.mod[data-slot="${i}"]`);
/** 从面板内部的任意节点往上找它所属的界面卡片。 */
const panelOf = (node) => ((node && node.closest) ? node.closest("article.mod[data-slot]") : null);

const state = {
  slots: DEFAULT_SLOTS.slice(),      // 三个界面各自显示哪个模块
  zoom: null,                        // 放大的界面序号（null = 三个界面并排/竖排）
  activeSlot: 0,                     // 顶部模块条点一下，会放进这个界面
  vactiveSlot: 0,                    // 竖屏滚动时"当前看的是哪个界面"
  researchCode: null,                // 搜索出来的个股
  researchPrev: null,                // 该界面原来显示什么（关掉分析页就还回去）
  sectorCode: null,                  // 从板块行情点进来的板块
  sectorName: "",
  sectorPrev: null,
  stock: null,                       // 从选股评分点进来的个股
  stockPrev: null,
  dragSlot: null,                    // 正在拖动哪个界面（面板互换用）
  cols: [1, 1, 1],                   // 三块的宽度权重（可拖动边界改变；0 = 收起）
  morph: true,                       // 是否给"要等数据"的切换加骨架屏
  sort: { key: "score", dir: -1 },
  index: "1.000001",
  stockPrice: 0,
  // 进出场动画用的"前一帧快照"：见 captureZoomRects / playZoomTx。
  // zoomTx 用 undefined 表示"这次渲染不是放大/还原触发的"，null 表示"上一次是三个界面"。
  zoomTx: undefined,
  zoomKeepRects: null,
};

function loadSlots() {
  try {
    const raw = JSON.parse(localStorage.getItem(SLOTS_KEY) || "null");
    if (Array.isArray(raw)) state.slots = sanitizeSlots(raw);
  } catch (e) { /* 忽略：用默认 */ }
}
function saveSlots() {
  try { localStorage.setItem(SLOTS_KEY, JSON.stringify(state.slots)); } catch (e) { /* 忽略 */ }
}
/** 保证正好三个界面、id 合法且不重复（顺序错乱/删过模块时也能自愈） */
function sanitizeSlots(list) {
  const seen = new Set();
  const out = [];
  list.forEach((id) => {
    if (MODULE_IDS.includes(id) && !seen.has(id) && out.length < SLOT_COUNT) {
      out.push(id); seen.add(id);
    }
  });
  DEFAULT_SLOTS.forEach((id) => {
    if (out.length < SLOT_COUNT && !seen.has(id)) { out.push(id); seen.add(id); }
  });
  return out;
}

/** 当前可用的全部模块（9 个固定模块 + 需要时才出现的分析页） */
function allModules() {
  const extra = [];
  if (state.researchCode) extra.push(RESEARCH_MOD);
  if (state.sectorCode) extra.push(SECTOR_MOD);
  return MODULES.concat(extra);
}
function moduleById(id) {
  return allModules().find((m) => m.id === id)
    || MODULES.find((m) => m.id === id) || MODULES[0];
}

/**
 * 把模块 id 放进第 i 个界面。
 * 交换语义：如果这个模块已经在别的界面里，两块内容**互换**（和电视换台一个道理），
 * 这样"把已在显示的模块拖过来"不会出现两个界面显示同一个模块。
 * 如果它本来没显示，就是纯粹的替换（被换下来的模块仍然留在顶部模块条里，随时能放回来）。
 */
function assignSlot(i, id) {
  if (i < 0 || i >= SLOT_COUNT || !id) return;
  const cur = state.slots[i];
  if (cur === id) return;
  const other = state.slots.indexOf(id);
  if (other >= 0) {
    // ⚠️ 两边都要写：只写 slots[other] = cur 的话第 i 块还是原值，
    //    结果同一个模块同时出现在两个界面里（这个 bug 是 portrait_test 抓出来的）。
    state.slots[other] = cur;
    state.slots[i] = id;
  } else if (id === RESEARCH_MOD.id) {
    state.researchPrev = cur;                    // 分析页替进来，记住原来是谁
    state.slots[i] = id;
  } else if (id === SECTOR_MOD.id) {
    state.sectorPrev = cur;
    state.slots[i] = id;
  } else if (cur === RESEARCH_MOD.id) {
    state.researchCode = null;                   // 分析页被换走 → 收起
    state.slots[i] = id;
  } else if (cur === SECTOR_MOD.id) {
    state.sectorCode = null;                     // 板块分析被换走 → 收起
    state.slots[i] = id;
  } else state.slots[i] = id;
  state.activeSlot = i;
  saveSlots();
  renderShell();
  scrollToSlot(i);
}

/** 搜索出来的个股分析页：优先复用已经在显示的界面，否则替换"当前界面" */
function openResearch(code) {
  state.researchCode = code;
  const at = state.slots.indexOf(RESEARCH_MOD.id);
  const i = at >= 0 ? at : state.activeSlot;
  if (at < 0) state.researchPrev = state.slots[i];
  state.slots[i] = RESEARCH_MOD.id;
  state.activeSlot = i;
  renderShell();
  scrollToSlot(i);
}
function closeResearch() {
  const at = state.slots.indexOf(RESEARCH_MOD.id);
  if (at >= 0) state.slots[at] = state.researchPrev || DEFAULT_SLOTS[at] || "board";
  state.researchCode = null;
  state.researchPrev = null;
  saveSlots();
  renderShell();
}

/** 板块分析页（板块 K 线 + 指标 + 筹码峰 + 5 龙头股） */
function openSector(code, name) {
  state.sectorCode = code;
  state.sectorName = name || "";
  const at = state.slots.indexOf(SECTOR_MOD.id);
  const i = at >= 0 ? at : state.activeSlot;
  if (at < 0) state.sectorPrev = state.slots[i];
  state.slots[i] = SECTOR_MOD.id;
  state.activeSlot = i;
  renderShell();
  scrollToSlot(i);
}
function closeSector() {
  const at = state.slots.indexOf(SECTOR_MOD.id);
  if (at >= 0) state.slots[at] = state.sectorPrev || DEFAULT_SLOTS[at] || "board";
  state.sectorCode = null;
  saveSlots();
  renderShell();
}

/**
 * 宽表格左右拖动查看。
 *
 * 用户要求原话："龙虎榜的模块为什么不能左右滑动？应该增加一个功能"。
 * 龙虎榜一张表有 8 列（含买卖席位 Top5），窄一点的窗口根本放不下。
 * 所以：把每个 table 包进一个 .hpan 容器 —— 可以横向滚动（触控板/触屏/Shift+滚轮），
 * 也可以用鼠标**按住左右拖**；滚动条依旧全局隐藏，不破坏观感。
 */
function enhanceTables(box) {
  if (!box || !box.querySelectorAll) return;
  box.querySelectorAll("table").forEach((tb) => {
    if (tb.parentElement && tb.parentElement.classList.contains("hpan")) return;  // 已经包过
    const wrap = document.createElement("div");
    wrap.className = "hpan";
    tb.parentNode.insertBefore(wrap, tb);
    wrap.appendChild(tb);
    let down = false, startX = 0, startLeft = 0, moved = 0;
    wrap.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      down = true; moved = 0;
      startX = e.clientX; startLeft = wrap.scrollLeft;
      wrap.classList.add("grabbing");
    });
    wrap.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      moved = Math.max(moved, Math.abs(dx));
      wrap.scrollLeft = startLeft - dx;
      if (moved > 4) e.preventDefault();
    });
    const up = () => { down = false; wrap.classList.remove("grabbing"); };
    wrap.addEventListener("pointerup", up);
    wrap.addEventListener("pointerleave", up);
    wrap.addEventListener("pointercancel", up);
    // 拖动过之后抑制"点一下"（否则左右拖会误触发表格里的链接）
    wrap.addEventListener("click", (e) => {
      if (moved > 6) { e.stopPropagation(); e.preventDefault(); moved = 0; }
    }, true);
  });
}

/** 从筛选表点一行进入个股。
 *
 * 用户要求原话："点击某个个股的时候，不要出现现在界面，直接将某个换成个股的详情页"，
 * 后来又要求"**5000 家都要能筛到、能搜到**，但评分/筛选不要只挑一小撮出来"。
 * 两条合起来的结果：**表里每一行都能点**，但行为分两种：
 *   · 有精算详情文件（has_detail）→ 进「个股详情」面板（读本地 JSON，最快）
 *   · 没有（绝大多数）→ 进「个股分析页」，由浏览器实时抓日线补 K 线/指标/筹码，
 *     绝不给用户报"没有数据"。
 */
function openStock(code, fromSlot, hasDetail) {
  state.stock = code;
  const useAnalysis = hasDetail === false;
  let i = (fromSlot === undefined || fromSlot === null) ? state.slots.indexOf("screen") : Number(fromSlot);
  if (!(i >= 0 && i < SLOT_COUNT)) i = state.activeSlot;
  const prev = state.slots[i];
  if (useAnalysis) {
    state.researchCode = code;
    state.researchPrev = prev;
    state.slots[i] = RESEARCH_MOD.id;
  } else {
    state.stockPrev = prev;
    state.slots[i] = "stock";
  }
  state.activeSlot = i;
  saveSlots();
  renderShell();
  scrollToSlot(i);
}

function scrollToSlot(i) {
  if (!isPortrait()) return;                 // 横屏本来就都看得见，不用滚
  const el = panelEl(i);
  if (el && el.scrollIntoView) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ---------------- 卡片外壳 ---------------- */
function cardHead(mod) {
  return `<div class="hd"><span class="tag ${mod.cls}">${esc(mod.tag)}</span></div>
    <h3>${esc(mod.title)}</h3><p class="desc">${esc(mod.desc)}</p>`;
}
function summaryHTML(mod, summary) {
  if (!summary || !summary.length) return "";
  return `<div class="kpi">${summary.map((s) =>
    `<div><div class="k">${esc(s.k)}</div><div class="v ${s.cls || ""}">${s.v}</div></div>`).join("")}</div>`;
}

/**
 * 某个界面的卡片。
 *
 * 用户要求：
 *   · 三个界面时，模块选择器在**每个界面的上方**（下拉框）
 *   · 放大成单一界面时，模块选择器跑到**左侧**（竖排列表），并且要有
 *     "上方 ↔ 左侧" 的过渡动画
 *   · 三个界面之间可以**互相拖动交换**
 * 所以这里把选择器做成一个带 data-pick 的容器：
 *   三界面模式 → .slothead（横排，含 select）
 *   放大模式   → .picklist（竖排列表，左侧）
 * FLIP 按 data-pick 匹配，于是"上方那个下拉"会平滑飞到左侧变成列表。
 */
function pickerHTML(i, m, zoomed) {
  if (zoomed) {
    return `<div class="picklist" data-pick="${i}">
      <div class="picktitle">模块</div>
      ${allModules().map((x) => `
        <div class="pickitem ${x.id === m.id ? "on" : ""}" data-pickto="${esc(x.id)}" data-panel="${i}"
             title="${esc(x.desc)}">
          <span class="ic">${VICONS[x.id] || "•"}</span><span class="tx">${esc(x.title)}</span>
        </div>`).join("")}
    </div>`;
  }
  // ⚠️ 这里的 select / ‹ › 都用 data-panel（不是 data-slot）：见 PANEL_SEL 那段说明
  return `<div class="slothead" data-pick="${i}">
      <span class="tag ${m.cls}">${esc(m.tag)}</span>
      <select class="slotpick" data-panel="${i}" title="这个界面显示哪个模块">
        ${allModules().map((x) => `<option value="${esc(x.id)}"${x.id === m.id ? " selected" : ""}>${esc(x.title)}</option>`).join("")}
      </select>
      <span class="slotbtns">
        <button class="btn btn-mini iconbtn" data-pan="-1" data-panel="${i}"
                title="内容向左看（宽表格）">‹</button>
        <button class="btn btn-mini iconbtn" data-pan="1" data-panel="${i}"
                title="内容向右看（宽表格）">›</button>
        <span class="dragslot" data-dragslot="${i}" title="按住拖到另一个界面可互换">⠿</span>
        <button class="btn btn-mini iconbtn" data-exp="${i}" title="放大这个界面">⤢</button>
      </span>
    </div>`;
}

/** 骨架屏：切换界面时先给"轮廓"，再填真内容（安卓分屏小窗那种先出框再出内容） */
function skeletonHTML(mod) {
  const kind = (mod && mod.id) || "";
  const many = ["screen", "dragon", "sectors", "research", "limitup", "review"].includes(kind);
  const rows = many ? 6 : 3;
  const bars = Array.from({ length: rows }, (_, i) =>
    `<div class="sk-row" style="animation-delay:${i * 60}ms">
       <span class="sk-cell w1"></span><span class="sk-cell w2"></span><span class="sk-cell w3"></span>
     </div>`).join("");
  const chart = ["index", "stock", "researchOne", "sectorOne", "review"].includes(kind)
    ? `<div class="sk-chart" style="animation-delay:${rows * 60}ms"></div>` : "";
  return `<div class="skeleton">
    <div class="sk-head" style="animation-delay:0ms"></div>
    ${bars}${chart}
  </div>`;
}

function slotCard(i, zoomed) {
  const m = moduleById(state.slots[i]);
  const el = document.createElement("article");
  el.className = "mod slot" + (zoomed ? " zoomed" : "");
  el.dataset.mod = m.id;
  el.dataset.slot = String(i);
  const head = zoomed
    // ⚠️ 放大模式的头部**不带 data-pick**：真正"模块选择器"是左边那个 .picklist。
    //    早期两边都写了 data-pick="${i}"，FLIP 的 Map 又被后一个覆盖，
    //    于是"上方下拉 ↔ 左侧列表"的过渡会把两个元素都从同一个位置飞过来（看着很怪）。
    ? `<div class="slothead zoomhead">
         <span class="tag ${m.cls}">${esc(m.tag)}</span>
         <span class="zoomtitle">${esc(m.title)}</span>
         <span class="slotbtns">
           <button class="btn btn-mini iconbtn" data-pan="-1" data-panel="${i}"
                   title="内容向左看（宽表格）">‹</button>
           <button class="btn btn-mini iconbtn" data-pan="1" data-panel="${i}"
                   title="内容向右看（宽表格）">›</button>
           ${m.id === RESEARCH_MOD.id || m.id === SECTOR_MOD.id
             ? `<button class="btn btn-mini" data-close="${esc(m.id)}">✕ 关闭</button>` : ""}
           <button class="btn btn-mini" data-exp="${i}" title="回到三个界面">‹ 回到三个界面</button>
         </span>
       </div>`
    : pickerHTML(i, m, false);
  el.innerHTML = `
    <div class="slotwrap ${zoomed ? "haslist" : ""}">
      ${zoomed ? pickerHTML(i, m, true) : ""}
      <div class="slotmain">
        ${head}
        <div class="body" id="body-${m.id}">${skeletonHTML(m)}</div>
      </div>
    </div>`;
  const sel = el.querySelector(".slotpick");
  if (sel) sel.addEventListener("change", (e) => {
    e.stopPropagation();
    morphSwitch(i, sel.value);          // 安卓分屏小窗式过渡后再换内容
  });
  el.querySelectorAll("[data-pickto]").forEach((it) =>
    it.addEventListener("click", (e) => {
      e.stopPropagation();
      morphSwitch(i, it.dataset.pickto);
    }));
  el.querySelectorAll("[data-pan]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      panPanel(el, Number(b.dataset.pan));
    }));
  const exp = el.querySelector("[data-exp]");
  if (exp) exp.addEventListener("click", (e) => {
    e.stopPropagation();
    state.activeSlot = i;
    // 先量下"现在三块各自在哪"，进场/出场动画要用（量在改动 state 之前）。
    captureZoomRects();
    // 记住"改动之前是放大状态吗"（null=原来是三个界面 → 这次是放大；
    // 整数=原来是那一块被放大 → 这次是还原，那个序号要留着，别抢它自己的收缩动画）。
    state.zoomTx = zoomed ? state.zoom : null;
    state.zoom = zoomed ? null : i;
    renderShell();
  });
  const cl = el.querySelector("[data-close]");
  if (cl) cl.addEventListener("click", (e) => {
    e.stopPropagation();
    if (cl.dataset.close === RESEARCH_MOD.id) closeResearch(); else closeSector();
  });
  const grip = el.querySelector("[data-dragslot]");
  if (grip) {
    // 按住 ⠿ 往另一块上拖 → 两块互换（pointer 事件，跟手丝滑；见 beginPointerDrag）
    grip.addEventListener("pointerdown", (e) => {
      el.classList.add("dragging");
      beginPointerDrag(e, { kind: "panel", fromSlot: i, id: m.id, label: m.title });
    });
  }
  return el;
}

/** 互换两个界面的内容（拖拽面板用；和 assignSlot 的"换台"语义一致） */
function swapSlots(a, b) {
  if (a === b || a < 0 || b < 0 || a >= SLOT_COUNT || b >= SLOT_COUNT) return;
  const t = state.slots[a];
  state.slots[a] = state.slots[b];
  state.slots[b] = t;
  state.activeSlot = b;
  saveSlots();
  renderShell();
}

/**
 * 切换某个界面的内容 —— **安卓分屏小窗那种过渡**（用户要求）：
 *   第 1 步：先摆**轮廓骨架**（灰块，先告诉你要换成什么形状）
 *   第 2 步：真内容渲染完成后，内容淡入
 *
 * ⚠️ 早期版本第一步用的是 `filter: blur(7px)`"整体虚化"，结果**更卡**：
 *    对大面板做 filter 会强制整块重新栅格化（面板里有表格和 canvas），代价极高。
 *    而且数据大多在缓存里（api() 有内存缓存），根本不需要过渡 —— 直接渲染最快。
 *    所以现在：**只有真的要等数据（首次加载）才放骨架**，其余情况瞬间切换。
 */
function morphSwitch(i, id) {
  if (state.slots[i] === id) return;
  const el = panelEl(i);                     // 只取面板卡片本体（见 PANEL_SEL 那段说明）
  if (!el || !state.morph) {                 // 关掉动画时直接换（也方便测试/无障碍）
    assignSlot(i, id);
    return;
  }
  const target = moduleById(id);
  // 数据已在缓存里 → 不放骨架，直接换（切换几乎零延迟，这是流畅的关键）
  if (apiCached(target.id)) { assignSlot(i, id); return; }
  const body = el.querySelector("[id^='body-']");
  if (body) body.innerHTML = skeletonHTML(target);
  assignSlot(i, id);
}

/** 这个模块的数据是否已经在内存缓存里（在的话就别再放骨架屏了） */
function apiCached(id) {
  const name = DATA_NAME[id];
  return !name || !!CACHE[name];
}

/**
 * 面板里宽表格左右移动（用户要求：三连模式下也要能看清左右）
 * 面板头部的 ‹ › 按钮：把这块里所有可横滑的 .hpan 一起滚 60% 宽度。
 */
function panPanel(el, dir) {
  const pans = Array.from(el.querySelectorAll(".hpan"));
  if (!pans.length) return false;
  let moved = false;
  pans.forEach((p) => {
    const step = Math.max(80, Math.round(p.clientWidth * 0.6)) * (dir < 0 ? -1 : 1);
    if (p.scrollWidth > p.clientWidth + 2) {
      p.scrollBy({ left: step, behavior: "smooth" });
      moved = true;
    }
  });
  return moved;
}

/** 面板头部 ‹ › 按钮的可用状态：没有横向溢出就置灰（别给用户假按钮） */
function updatePanButtons(el) {
  const pans = Array.from(el.querySelectorAll(".hpan"));
  const canPan = pans.some((p) => p.scrollWidth > p.clientWidth + 2);
  el.querySelectorAll("[data-pan]").forEach((b) => {
    b.classList.toggle("dim", !canPan);
    b.disabled = !canPan;
  });
  el.classList.toggle("haspan", canPan);
}



/* ============================================================
   三个界面的**左右边界可以拖**（用户要求）：
     · 拖缝隙 → 两边宽度此消彼长（比例存在浏览器里，刷新后保持）
     · 把某一块拖到很窄（<12%）→ 它**收起来**变成一条细边，
       于是"只看两个模块 / 一个模块占 2/3"就实现了
     · 点细边 → 该块恢复默认宽度
   为什么不用 CDN 的分栏库：只要 grid 的 fr 比例 + 一个 6px 的拖拽条就够了，
   自己写反而没有额外依赖、也不会有布局抖动。
   ============================================================ */
const COLS_KEY = "ashare_cols";
const COLLAPSE_AT = 0.12;              // 低于这个比例就收起

function loadCols() {
  try {
    const raw = JSON.parse(localStorage.getItem(COLS_KEY) || "null");
    if (Array.isArray(raw) && raw.length === SLOT_COUNT
        && raw.every((x) => typeof x === "number" && x >= 0)) {
      state.cols = raw;
    }
  } catch (e) { /* 忽略：用默认等宽 */ }
}
function saveCols() {
  try { localStorage.setItem(COLS_KEY, JSON.stringify(state.cols)); } catch (e) { /* 忽略 */ }
}
/** 归一化：可见的那几块加起来是 1（收起的保持 0） */
function normCols() {
  const sum = state.cols.reduce((s, x) => s + x, 0) || 1;
  return state.cols.map((x) => (x > 0 ? x / sum : 0));
}
function visibleSlots() {
  return [0, 1, 2].filter((i) => state.cols[i] > COLLAPSE_AT / 2);
}
function resetCols() {
  const stage = $("#stage");
  const target = [1, 1, 1];
  if (stage && stage.clientWidth) animateCols(stage, target, 260);
  else { state.cols = target; saveCols(); }
  setTimeout(() => { state.cols = target; saveCols(); renderShell(); }, 280);
}

/** 只写"每块宽度 + 每条缝隙的位置"，**不碰 DOM 结构**（拖动时每帧都会调用，必须极轻） */
function applyCols(stage) {
  if (!stage) return;
  const zoomed = state.zoom !== null && state.zoom !== undefined;
  const total = stage.clientWidth || 0;
  const vis = visibleSlots();
  const n = normCols();
  // 竖屏：三块竖着排，宽度交给 CSS，别用 px 覆盖
  if (isPortrait()) {
    Array.from(stage.children).forEach((el) => {
      if (!el.dataset || el.dataset.slot === undefined || !el.classList.contains("mod")) return;
      el.style.flexBasis = "";
      el.style.width = "";
      el.style.display = vis.includes(Number(el.dataset.slot)) ? "" : "none";
    });
    return;
  }
  // 逐块写宽度（flex-basis）。拖动时只改这一处样式。
  Array.from(stage.children).forEach((el) => {
    if (!el.dataset || el.dataset.slot === undefined || !el.classList.contains("mod")) return;
    const i = Number(el.dataset.slot);
    if (zoomed) { el.style.flexBasis = "auto"; el.style.width = "100%"; return; }
    if (!vis.includes(i)) { el.style.display = "none"; return; }
    el.style.display = "";
    const px = Math.max(0, Math.round(n[i] * total));
    el.style.flexBasis = px + "px";
    el.style.width = px + "px";
  });
  if (zoomed) return;
  Array.from(stage.querySelectorAll(".collapsed")).forEach((c) => { c.style.display = "none"; });
  let acc = 0;
  const bounds = [];
  vis.forEach((i) => { acc += n[i] * total; bounds.push(acc); });
  let k = 0;
  Array.from(stage.querySelectorAll(".gutter")).forEach((g) => {
    if (k + 1 >= vis.length) { g.classList.add("hidden"); return; }
    g.classList.remove("hidden");
    g.dataset.gap = `${vis[k]}-${vis[k + 1]}`;
    g.style.left = Math.round(bounds[k]) + "px";
    k++;
  });
}

/**
 * 让三块**正好填满可视高度**（横屏）：高度 = 视口高 − 舞台顶部 − 页脚/边距。
 * 为什么用 JS 算而不是写死 calc(100vh - 176px)：顶部状态栏、提示条、页脚的高度
 * 都会随窗口宽度变化，写死会留下一条多余的整页滚动（用户会以为"面板不能自己滚"）。
 */
function sizeStage() {
  const stage = $("#stage");
  if (!stage) return;
  if (isPortrait()) { stage.style.height = ""; return; }   // 竖屏由 CSS 决定（三块竖排）
  const top = stage.getBoundingClientRect().top + (window.scrollY || 0);
  // ⚠️ 原来这里写的是"没有页脚就按 90px 扣" —— 而上一轮把页脚删掉之后，
  //    这 90px 就**白扣**了：卡片明明可以更高，却被一个不存在的页脚压着。
  //    用户这轮要求"整体往下加长"，这根因就在这儿。现在按真实高度算：
  //    有页脚就量它，没有就是 0。
  const foot = document.querySelector(".foot");
  const footH = foot ? Math.round(foot.getBoundingClientRect().height) : 0;
  const shell = $("#shell");
  // 还要减掉 .shell 自己的下内边距 —— 漏掉它就会多出一条几十像素的整页滚动，
  // 让人误以为"面板不能自己滚"（实测 pageScrolls=true 就是这么来的）。
  // 注意 getComputedStyle 要防一手：测试用的假 DOM 里没有它。
  let shellPad = 0;
  try {
    if (shell && typeof getComputedStyle === "function") {
      shellPad = parseFloat(getComputedStyle(shell).paddingBottom) || 0;
    }
  } catch (e) { shellPad = 0; }
    // 底部再留一点空白：用户先说"整体往下加长"，接着说"有点过长，再缩短一点"。
  // 这个常量就是"卡片底边到视口底边"的距离 —— 调大 = 卡片变矮、下方留白变多。
  // 44px 是个"稍微收一点"的量（1700×1000 下卡片 666 → 约 626px），不是大改。
  const h = Math.max(320, Math.round(window.innerHeight - top - footH - shellPad - BOTTOM_GAP));
  stage.style.height = h + "px";
  capStageWidth(stage);
}

/**
 * 把三块的整体宽度**收窄到接近 9:16 的竖长比例**（用户要求"模块比例参考 9:16"）。
 *
 * 为什么必须在 JS 里算、CSS 做不到：
 *   卡片高度是"视口高 − 顶部栏 − 底部"算出来的**动态值**，CSS 里没有
 *   "按高度反推宽度"又能被 `layoutColumns()` 的 inline 宽度认可的做法
 *   （inline style 会盖掉样式表里的 width/aspect-ratio）。
 *   而这里只是给舞台加一个 `max-width`：**列宽分配逻辑一行没动**，
 *   拖动边界、收起、放大全部照旧（它们都是按 stage.clientWidth 算的）。
 *
 * 9:16 意味着"每块宽度 ≈ 高度 × 0.5625"。三块加起来的宽度上限就是
 * `3 × h × 9/16`（卡片之间的 20px 视觉缝隙是靠透明边框做的，不占额外宽度）。
 * 同时保一个下限 300px/块：屏幕不够宽时宁可比例不准，也不能让表格窄到没法看。
 */
// 宽 : 高。用户先要求"参考 9:16"（=0.5625），随后要求"三个界面再宽一些：
// 一块的宽度要跟『占 40%』时一样宽（现在三块各占 33%），高度不变"。
// 40 ÷ 33.3 = 1.2 → 0.5625 × 1.2 = 0.675：每块比 9:16 时再宽 20%，高度一点没动。
// 用户的口径："398px 现在占 33%，要增加到 40%"。
// 注意这里是**占比**从 33% 提到 40%：倍率 = 40 / 33.33 = 1.2 倍（不是"再加 8 个点"），
// 因为面板宽度是按比例缩放的：0.675 × (40/33.33) = 0.81。
// 高度完全不动（只改宽度）。
// 每块的最大宽度 = 视口宽度的 28%（1700 视口 → 476px，与用户确认的当前宽度一致）。
// ⚠️ 为什么改成"按视口宽度"而不是"按卡片高度 × 比例"：
//    用户这一轮明确要求"上下变动，左右不要再变动"。
//    而原来的算法是 width = 高度 × 比例 —— 高度一涨，宽度跟着涨，等于每加高一次就改一次宽度。
//    改成按视口宽度算之后，**高度怎么变都不会再动宽度**，两边彻底解耦。
const CARD_MAX_VW = 0.28;           // 每块宽度上限 = 视口宽 × 0.28
const CARD_MIN_W = 260;             // 每块最小可用宽度（再窄表格就没法看了）
//: 卡片底边到视口底边的留白（px）。调大 = 卡片变矮、下方空白变多。
const BOTTOM_GAP = 44;

function capStageWidth(stage) {
  if (isPortrait()) { stage.style.maxWidth = ""; return; }
  if (state.zoom !== null && state.zoom !== undefined) { stage.style.maxWidth = ""; return; }
  const vis = (typeof visibleSlots === "function" ? visibleSlots() : [0, 1, 2]).length || 3;
  const per = Math.max(CARD_MIN_W, Math.round(window.innerWidth * CARD_MAX_VW));
  stage.style.maxWidth = (vis * per) + "px";
}


/** 依据列宽摆放三块 + 画缝隙拖拽条（结构变化时才调用；拖动中只用 applyCols） */
function layoutColumns(stage) {
  const zoomed = state.zoom !== null && state.zoom !== undefined;
  // 清掉旧的拖拽条/收起条（任何模式切换都先清干净，避免残留）
  Array.from(stage.querySelectorAll(".gutter, .collapsed")).forEach((x) => x.remove());
  stage.dataset.gutters = "0";        // 自检用：真实渲染后能被 headless dump 看到
  // ⚠️ 放大成"单一界面"时**不画缝隙、也不画收起条**。
  //    早期版本在这里漏了判断：只显示一块，却仍然按 [0,1,2] 生成"收起条"，
  //    于是单一界面最左边会残留一个属于别的界面小方块（用户报的 bug）。
  if (zoomed) {
    stage.style.gridTemplateColumns = "";     // flex 布局下不需要（保留写法无害）
    applyCols(stage);
    return;
  }
  const vis = visibleSlots();
  for (let k = 0; k + 1 < vis.length; k++) {
    const g = document.createElement("div");
    g.className = "gutter";
    g.dataset.gap = `${vis[k]}-${vis[k + 1]}`;
    g.title = "按住左右拖：两块宽度随手变；拖到很窄就收起那一块（只剩两块时是 1/3 与 2/3）";
    bindGutter(g, vis[k], vis[k + 1]);
    stage.appendChild(g);
    stage.dataset.gutters = String(Number(stage.dataset.gutters || 0) + 1);
  }
  // 收起的那几块：画一条细边，点一下恢复（宽度用补间动画，不是"啪"地跳过去）
  [0, 1, 2].forEach((i) => {
    if (vis.includes(i)) return;
    const c = document.createElement("div");
    c.className = "collapsed";
    const m = moduleById(state.slots[i]);
    c.dataset.restore = String(i);
    c.innerHTML = `<span class="ic">${VICONS[state.slots[i]] || "•"}</span>
      <span class="tx">${esc((m.short || m.title).slice(0, 4))}</span>`;
    c.title = `把第 ${i + 1} 个界面拉回来（${m.title}）`;
    c.addEventListener("click", (e) => {
      e.stopPropagation();
      restoreSlot(i);
    });
    stage.appendChild(c);
  });
  applyCols(stage);
}

/** 补间动画改列宽：程序性变化（收起/恢复）也是"滑过去"的，不是瞬间跳 */
function animateCols(stage, target, ms) {
  const from = state.cols.slice();
  const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
  const dur = ms || 260;
  const step = () => {
    const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
    const t = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - t, 3);          // easeOutCubic
    state.cols = from.map((v, i) => v + (target[i] - v) * e);
    applyCols(stage);
    if (t < 1) requestAnimationFrame(step);
    else { state.cols = target.slice(); applyCols(stage); saveCols(); }
  };
  requestAnimationFrame(step);
}

/** 把收起的那一块拉回来：优先变成 1/3 + 2/3（用户要的"只看两块"） */
function restoreSlot(i) {
  const stage = $("#stage");
  const vis = visibleSlots();
  // 目标：恢复的这块占 1/3，已显示的那块占 2/3（两块时最符合"一个 1/3、一个 2/3"）
  let target;
  if (vis.length === 1) {
    target = [0, 0, 0];
    target[vis[0]] = 2;
    target[i] = 1;
  } else {
    target = [1, 1, 1];
    target[i] = 1.4;
  }
  animateCols(stage, target, 280);
  // 补间结束后把 DOM 补齐（新出现的块需要渲染内容）
  setTimeout(() => { renderShell(); }, 300);
}

/**
 * 缝隙拖拽：**连续拖动**（不是点一下跳过去）。
 * ⚡ 性能要点：拖动过程中**绝对不能**重建 DOM —— 早期版本每帧都
 *    querySelectorAll + remove + appendChild + 重新绑事件，所以"拖起来很卡很卡"。
 *    现在每帧只做两件事：写一次 grid-template-columns、挪一下缝隙的 left。
 */
function bindGutter(el, left, right) {
  let dragging = false, raf = 0, lastX = 0, stageRect = null;
  const flush = () => {
    raf = 0;
    const stage = $("#stage");
    if (!stage || !stageRect) return;
    const total = stageRect.width || 1;
    const vis = visibleSlots();
    const n = normCols();
    const idx = vis.indexOf(left);
    if (idx < 0) return;
    let before = 0;
    for (let k = 0; k < idx; k++) before += n[vis[k]];
    const pairSum = n[left] + n[right];
    const leftFr = (lastX - stageRect.left) / total - before;
    // 拖到很窄 → **松手时**才收起（拖动中不重建 DOM，保证丝滑）
    const clamped = Math.max(0.06, Math.min(pairSum - 0.06, leftFr));
    const n2 = state.cols.slice();
    const sumAll = n2.reduce((s, v) => s + v, 0) || 1;
    n2[left] = clamped * sumAll;
    n2[right] = (pairSum - clamped) * sumAll;
    state.cols = n2;
    applyCols(stage);                       // 只改样式，不碰结构
    // 拖动中在屏幕中间显示 1/3、2/3 这种比例，拖起来心里有数
    const tip = $("#colTip");
    if (tip) {
      const a = Math.round(clamped * 100), b = Math.round((pairSum - clamped) * 100);
      tip.textContent = `${a}% / ${b}%`;
      tip.classList.add("show");
    }
  };
  const onMove = (e) => {
    if (!dragging) return;
    lastX = e.clientX;
    if (!raf) raf = requestAnimationFrame(flush);   // 每帧最多算一次
    e.preventDefault();
  };
  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    lastX = e.clientX;
    stageRect = $("#stage").getBoundingClientRect();
    el.classList.add("dragging");
    document.body.classList.add("col-dragging");     // 拖动时全局禁选/禁过渡
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* 忽略 */ }
    e.preventDefault();
  });
  el.addEventListener("pointermove", onMove);
  const up = () => {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    document.body.classList.remove("col-dragging");
    const tip = $("#colTip");
    if (tip) tip.classList.remove("show");
    const vis = visibleSlots();
    const i = vis.indexOf(left);
    if (i >= 0) {
      const n = normCols();
      if (n[left] < COLLAPSE_AT) {                  // 拖得太窄 → 收起这一块（只在这里重建一次）
        const rest = state.cols.reduce((s, v, k) => s + (k === left ? 0 : v), 0);
        state.cols = state.cols.map((v, k) => (k === left ? 0 : (k === right ? rest : v)));
        saveCols();
        renderShell();
        return;
      }
    }
    saveCols();
    applyCols($("#stage"));
    // 拖动中**故意不重画 canvas**（那是最大的一笔开销，图表会被 CSS 拉伸一点点）；
    // 松手后统一重画一次，恢复清晰。
    document.querySelectorAll("canvas.kc").forEach((c) => { if (c.__kstate) drawKline(c); });
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("dblclick", () => resetCols());   // 双击缝隙 = 恢复等宽
}

/** 拖动列宽时显示的比例提示（1/3、2/3 这种），拖完就隐藏 */
function ensureColTip() {
  let tip = $("#colTip");
  if (tip) return tip;
  tip = document.createElement("div");
  tip.id = "colTip";
  tip.className = "coltip";
  document.body.appendChild(tip);
  return tip;
}


/**
 * ?debug=1 → 把关键布局数据写进页面（`#debugMetrics`）。
 * 为什么需要：**"每块能不能自己上下滚"这种事，只有真实浏览器能回答**。
 * 假 DOM 测不出来，我也不该靠猜；有了它就能用 headless 的 --dump-dom 直接读到实测值。
 */
function dumpDebugMetrics() {
  // ⚠️ 先把元素建出来再算：否则一旦中途抛错，元素不存在 → 外面看到的只是"没输出"，
  //    查错的人（我）会以为是没调用，而不是"调用里出错"。
  let box = document.getElementById("debugMetrics");
  if (!box) {
    box = document.createElement("pre");
    box.id = "debugMetrics";
    box.style.display = "none";
    document.body.appendChild(box);
  }
  try {
    const stage = $("#stage");
    if (!stage) { box.textContent = JSON.stringify({ error: "没有 #stage" }); return; }
    // 只量**面板卡片本体**：stage 内部的下拉/按钮也带 data-slot，
    // 早期用 "#stage [data-slot]" 会量到一堆子元素，数字看着莫名其妙。
    const cards = Array.from(document.querySelectorAll("#stage > article.mod"));
    const stageCs = getComputedStyle(stage);
    const first = cards[0];
    const firstCs = first ? getComputedStyle(first) : null;
    const rows = cards.map((el) => {
      const body = el.querySelector("[id^='body-']");
      const cs = body ? getComputedStyle(body) : null;
      const ccs = getComputedStyle(el);
      return {
        slot: el.dataset.slot,
        mod: el.dataset.mod,
        // offsetHeight 是**布局高度**（不受 transform 影响）；getBoundingClientRect 会被
        // FLIP 动画的 scale 改小，虚拟时间下动画可能停在中途 → 只看它会误判成"面板塌了"。
        cardOffsetH: el.offsetHeight,
        cardH: Math.round(el.getBoundingClientRect().height),
        flex: ccs.flex,
        bodyClientH: body ? body.clientHeight : 0,
        bodyScrollH: body ? body.scrollHeight : 0,
        canScrollY: body ? body.scrollHeight > body.clientHeight + 2 : false,
        overflowY: cs ? cs.overflowY : "",
      };
    });
    const out = {
      innerWidth: window.innerWidth,
      stageH: Math.round(stage.getBoundingClientRect().height),
      stageDisplay: stageCs.display,
      stageDirection: stageCs.flexDirection,
      stageHeightCss: stageCs.height,
      firstCardCss: firstCs ? firstCs.height : "",
      docScrollH: document.documentElement.scrollHeight,
      viewportH: window.innerHeight,
      pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 2,
      cols: state.cols.map((x) => Math.round(x * 100) / 100),
      zoom: state.zoom,
      // 进出场动画的自检：幽灵卡还剩几张、上一次动画是否已经清干净。
      // 这两个值只有在放大的一瞬间才是 2，动画结束后必须回到 0。
      ghosts: document.querySelectorAll(".zoomghost").length,
      zoomTx: state.zoomTx === undefined ? "idle" : String(state.zoomTx),
      gutters: document.querySelectorAll("#stage .gutter").length,
      collapsed: document.querySelectorAll("#stage .collapsed").length,
      rows,
    };
    box.textContent = JSON.stringify(out);
  } catch (e) {
    box.textContent = JSON.stringify({ error: String(e && e.message || e) });
  }
}

/**
 * 深链：用网址直接指定"三个界面显示什么"，例如
 *   ?slots=board,screen,sectors   三个界面分别显示什么
 *   ?sector=BK0448&name=通信设备   直接在某个界面打开板块分析
 *   ?code=600519 / ?stock=000636  直接在某个界面打开个股分析
 * 好处：刷新/分享/截图/测试都能直达同一个画面，不用手点。参数写错就当没写（不影响正常使用）。
 */
function applyDeepLink() {
  try {
    if (typeof location === "undefined" || typeof URLSearchParams === "undefined") return;
    const q = new URLSearchParams(location.search || "");
    const slots = (q.get("slots") || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (slots.length) state.slots = sanitizeSlots(slots);
    const at = Math.max(0, Math.min(SLOT_COUNT - 1, Number(q.get("at") || state.activeSlot) || 0));
    const code = q.get("code");
    if (code) { state.researchCode = code; state.slots[at] = RESEARCH_MOD.id; state.activeSlot = at; }
    const sector = q.get("sector");
    if (sector) {
      state.sectorCode = sector;
      state.sectorName = q.get("name") || "";
      state.slots[at] = SECTOR_MOD.id;
      state.activeSlot = at;
    }
    const stock = q.get("stock");
    if (stock) { state.stock = stock; state.slots[at] = "stock"; state.activeSlot = at; }
    // ?zoom=1 → 直接放大第 2 个界面（单一界面 + 左侧模块列表）
    const zoom = q.get("zoom");
    if (zoom !== null && zoom !== "" && zoom !== undefined) {
      const z = Number(zoom);
      state.zoom = (z >= 0 && z < SLOT_COUNT) ? z : null;
    }
    // ?cols=2,1,0 → 直接指定三块宽度（0 = 收起），用来直达"一块占 2/3、只看两块"的画面
    const cols = (q.get("cols") || "").split(",").map((x) => Number(x.trim()));
    if (cols.length === SLOT_COUNT && cols.every((x) => Number.isFinite(x) && x >= 0)) {
      state.cols = cols;
    }
    // ?expseq=1,1 → 自检用：依次"点一下第 N 块的放大按钮"。
    //   为什么需要：放大/还原的进出场动画**只有真按下去才会播**，
    //   而 headless 的 --dump-dom 没法点按钮 —— 没有这个入口，这段动画就永远没被真机验证过
    //   （"假 DOM 里跑通了"≠"浏览器里对"）。所以这里派发**真实 click 事件**，
    //   走的是和用户点击**完全一样**的代码路径（不是直接改 state）。
    //   两个数字 500ms 间隔，就能一次跑完"放大 → 还原"。
    scheduleExpSeq(q.get("expseq"));
  } catch (e) { /* 忽略：深链只是可选入口 */ }
}

/** 见 applyDeepLink 里对 ?expseq 的说明；只在自检/截图时用。 */
function scheduleExpSeq(spec) {
  if (!spec) return;
  const seq = String(spec).split(",").map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 0 && n < SLOT_COUNT);
  if (!seq.length || typeof setTimeout !== "function" || typeof document === "undefined") return;
  seq.forEach((slot, i) => {
    setTimeout(() => {
      const btn = document.querySelector(`#stage [data-exp="${slot}"]`);
      if (btn && btn.click) btn.click();
      else if (typeof console !== "undefined") console.warn("expseq: 找不到放大按钮", slot);
    }, 700 + i * 500);
  });
}

/**
 * "内容指纹"：同一个模块也可能显示不同内容（个股分析换了股票、板块分析换了板块）。
 * 复用面板 DOM 时必须把它一起比较，否则会出现**换了股票但界面还是上一只**的假象
 * （这个 bug 是 sector_test 抓出来的：从 BK1592 切到 BK1340 后页面还是旧内容）。
 */
function contentKeyOf(id) {
  if (id === SECTOR_MOD.id) return state.sectorCode || "";
  if (id === RESEARCH_MOD.id) return state.researchCode || "";
  if (id === "stock") return state.stock || "";
  return "";
}

/** 用户是否要求"减少动画"（系统设置）；尊重它，别硬塞动画。 */
function prefersReduced() {
  try {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch (e) { return false; }
}

/**
 * 进出场动画的"前一帧快照"：记下当前每个格子（#stage 下的面板卡片）的位置和大小。
 * 必须在改 state.zoom 之前调用 —— 改完之后 DOM 就重排了，量到的已经是新位置。
 */
function captureZoomRects() {
  const stage = $("#stage");
  const keep = {};
  if (!stage) { state.zoomKeepRects = keep; return; }
  stage.querySelectorAll("article.mod").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return;
    keep[Number(el.dataset.slot)] = { left: r.left, top: r.top, width: r.width, height: r.height };
  });
  state.zoomKeepRects = keep;
}

/**
 * 三个界面 ↔ 一个界面的**进出场动画**（用户要求优化这一段）。
 *
 * 旧版的问题：放大时另外两块**瞬间消失**，只有被点的那块在动，看起来像"页面闪了一下"；
 * 还原时另外两块是从底下"淡入"出来的，和"它们本来就在旁边"这件事对不上。
 * 现在（全部只动 transform / opacity，不碰布局属性，`prefers-reduced-motion` 时直接跳过）：
 *   · 放大：被点的那块**横向长到全宽**（交给 playFlip 的 FLIP）；
 *           消失的那两块复制成一张**轻量幽灵卡**，缩成小条滑向左边的切换条再淡出。
 *   · 还原：被放大的那块缩回自己的格子；重新出现的两块**从切换条位置长回格子**。
 * 落点选"左侧切换条"是因为竖屏下这三块本来就是从左侧那条切换器里选的，方向一致。
 * 幽灵卡只是 div + 文字，不克隆面板 DOM —— 克隆一块 500px 高的表格会掉帧。
 */
function playZoomTx(prevZoom) {
  const stage = $("#stage");
  if (!stage || prefersReduced()) return;
  const rail = $("#vswitch") || $("#modbar");
  const rr = rail ? rail.getBoundingClientRect() : null;
  const railPoint = (rr && rr.width)
    ? { x: rr.left + rr.width * 0.5, y: rr.top + Math.min(rr.height * 0.5, 24) }
    : { x: 24, y: 96 };
  const keep = state.zoomKeepRects || {};
  const zoomedNow = state.zoom;
  const DUR = 300;
  const EASE = "cubic-bezier(.22,1,.36,1)";
  Array.from(stage.querySelectorAll(".zoomghost")).forEach((g) => g.remove());

  if (zoomedNow !== null && zoomedNow !== undefined) {
    // —— 进入放大：给"要消失的那两块"做缩走动画 ——
    Object.keys(keep).map(Number).forEach((i) => {
      if (i === zoomedNow) return;
      const r = keep[i];
      if (!r) return;
      const m = moduleById(state.slots[i]);
      const g = document.createElement("div");
      g.className = "zoomghost";
      g.style.cssText = `left:${Math.round(r.left)}px;top:${Math.round(r.top)}px;`
        + `width:${Math.round(r.width)}px;height:${Math.round(r.height)}px`;
      const head = document.createElement("div");
      head.className = "zg-head";
      head.textContent = (VICONS[state.slots[i]] || "•") + " " + (m.short || m.title);
      g.appendChild(head);
      stage.appendChild(g);                // 挂在 stage 里，跟着 stage 一起被清掉
      const anim = g.animate([
        { transform: "none", opacity: 1 },
        { transform: `translate(${railPoint.x - r.left - r.width / 2}px, `
            + `${railPoint.y - r.top - r.height / 2}px) scale(.12)`, opacity: 0 },
      ], { duration: DUR, easing: EASE });
      // 假 DOM / 老浏览器可能不给 .finished（动画对象本身也可能为 undefined），
      // 这里绝不能因为动画 API 不齐就把整个渲染流程带崩。
      if (anim && anim.finished && anim.finished.then) {
        anim.finished.then(() => g.remove()).catch(() => g.remove());
      }
      // 双保险：万一 .finished 一直不结算（虚拟时间/后台标签页都可能不推进动画），
      // 也必须在动画时长之后把幽灵卡收掉 —— 否则它会**永久浮在页面上**挡着看内容。
      setTimeout(() => { if (g.parentNode) g.remove(); }, DUR + 200);
    });
    return;
  }

  // —— 还原成三个界面：让重新出现的那两块"从切换条长回格子" ——
  // ⚠️ 放大状态下 DOM 里只有一块，所以**不能**用 keep 里的旧位置（那里面只有被放大的那块）；
  //    还原时那两块是刚新建出来的，它们的"起点"只可能是切换条，终点才是当前位置。
  Array.from(stage.querySelectorAll("article.mod")).forEach((el) => {
    const i = Number(el.dataset.slot);
    if (i === prevZoom) return;            // 被放大的那块自己会缩回去，别抢它的动画
    const now = el.getBoundingClientRect();
    if (!now.width) return;
    // playFlip 给"新出现的元素"兜了个淡入；这里要改成"从切换条飞回来"，先把它撤掉。
    if (el.getAnimations) el.getAnimations().forEach((a) => a.cancel());
    el.animate([
      { transform: `translate(${railPoint.x - now.left - now.width / 2}px, `
          + `${railPoint.y - now.top - now.height / 2}px) scale(.12)`, opacity: 0 },
      { transform: "none", opacity: 1 },
    ], { duration: DUR, easing: EASE });
  });
}

/**
 * 渲染页面：三个界面（或放大的那一个）。
 *
 * ⚡ 性能要点（用户反馈"切换太卡"）：**不要每次把整个 stage 重建**。
 *    旧写法 `stage.innerHTML = ""` + 全部重新创建，会把三块里所有 canvas、
 *    表格、事件监听全部销毁重建，然后再重新取数渲染 —— 一次切换几百毫秒。
 *    现在改成**按块复用**：
 *      · 某一块的模块没变 → 直接复用原来的 DOM（连 canvas 都不重建）
 *      · 只有模块变了的那一块才重建，并且只重新取数那一块
 *      · 顺序变化（拖动互换）只是 appendChild 移动节点，零渲染成本
 *    `force` = true 时（点"刷新数据"）才整体重填。
 */
function renderShell(force) {
  const shell = $("#shell");
  const stage = $("#stage");
  const zoomed = state.zoom;

  // ---------- FLIP 第一步：记录切换前每个界面的位置（按 data-slot 匹配） ----------
  // ⚠️ 必须只取**面板卡片本体**（PANEL_SEL）。早期这里写的是 `[data-slot]`，
  //    而界面内部的 ‹ › 按钮、模块下拉、竖排按钮也都带 data-slot —— 一次命中 5 个元素，
  //    Map 里后一个覆盖前一个，最后留下的是 `›` 按钮的 26×26。
  //    于是两个箭头被按错误的旧位置做 FLIP，缩放比能到 21 倍（用户报的"箭头大小异常"）。
  const before = new Map();
  const pickBefore = new Map();
  document.querySelectorAll(PANEL_SEL).forEach((el) => {
    // 先把上一轮还没播完的动画掐掉再量位置。
    // 为什么：动画进行中 `getBoundingClientRect()` 拿到的是**正在缩放中的尺寸**，
    // 拿它当"旧位置"，下一次 FLIP 的缩放比就会层层累积 ——
    // 连续快速换模块时面板（和它头部的按钮）会越变越大 / 越变越小。
    if (el.getAnimations) el.getAnimations().forEach((a) => a.cancel());
    el.style.animation = "none";
    before.set(el.dataset.slot, el.getBoundingClientRect());
  });
  document.querySelectorAll("[data-pick]").forEach((el) => {
    // 同上：量之前先掐掉未播完的动画，避免"在缩放中途量到的尺寸"被当成起点
    if (el.getAnimations) el.getAnimations().forEach((a) => a.cancel());
    pickBefore.set(el.dataset.pick, el.getBoundingClientRect());
  });

  const barEl = $("#modbar");
  // 用户要求：放大某个界面时，顶部模块条整条不要出现
  if (barEl) barEl.classList.toggle("hide", zoomed !== null && zoomed !== undefined);
  shell.classList.toggle("zoom-mode", zoomed !== null && zoomed !== undefined);

  const list = (zoomed === null || zoomed === undefined) ? visibleSlots() : [zoomed];
  const zoomNow = list.length === 1 && (zoomed !== null && zoomed !== undefined);

  // ---------- 按块复用：把还在用的卡片留下来，只重建"换了模块"的那块 ----------
  const existing = new Map();
  Array.from(stage.children).forEach((el) => {
    if (el.dataset && el.dataset.slot !== undefined) existing.set(el.dataset.slot, el);
  });
  const refill = [];                      // 需要重新取数渲染的界面
  list.forEach((i) => {
    const id = state.slots[i];
    const key = contentKeyOf(id);
    let el = existing.get(String(i));
    const isZoom = el ? el.classList.contains("zoomed") : zoomNow;
    const same = !!el && el.dataset.mod === id && el.dataset.ckey === key
                 && isZoom === zoomNow && !force;
    if (!same) {
      const fresh = slotCard(i, zoomNow);
      fresh.dataset.ckey = key;
      if (el && el.parentNode && el.parentNode.replaceChild) el.parentNode.replaceChild(fresh, el);
      el = fresh;
      refill.push(i);
    }
    stage.appendChild(el);                // 同时负责按新顺序排列
  });
  // 放大的那块回去时，其它块会重新出现（会被上面的循环补回来）；
  // 不再显示的块必须显式移除，否则会留在 DOM 里（虽然不占网格位，但白占内存）。
  Array.from(stage.children).forEach((el) => {
    if (el.dataset && el.dataset.slot !== undefined
        && !list.includes(Number(el.dataset.slot))) el.remove();
  });
  // 点哪一块就把哪一块设为"当前界面"（顶部模块条点一下会放进它）。
  // ⚠️ 只绑在**面板卡片**上：内部的 ‹ › / 下拉 / 放大按钮自己会 stopPropagation，
  //    而且面板是冒泡的祖先，绑在卡片上就够了 —— 早期绑到 `#stage [data-slot]`
  //    等于每个界面绑了 5 次（按钮上也绑），纯属浪费且容易误改 activeSlot。
  document.querySelectorAll(PANEL_SEL).forEach((el) => {
    if (el.__clickbound) return;
    el.__clickbound = true;
    el.addEventListener("click", () => {
      state.activeSlot = Number(el.dataset.slot);
      renderModbar();
    });
  });

  playFlip(before, { enterOpacity: 0.25 });
  playPickFlip(pickBefore);            // "上方下拉 ↔ 左侧列表" 的位移过渡
  sizeStage();                         // 三块正好填满可视高度（横屏不留整页滚动）
  layoutColumns(stage);                // 列宽（可拖）+ 缝隙拖拽条 + 收起条
  // 只填"新出现的 / 换了模块的"那些块；其它块保持原样（这是流畅度的关键）
  list.forEach((i) => {
    if (refill.includes(i)) fillModule(state.slots[i]);
    else {
      const el = panelEl(i);
      if (el) updatePanButtons(el);
    }
  });
  // 三块 ↔ 一块 的进出场（只有"点了放大/还原"才播；普通重渲染不播）。
  // 必须放在 fillModule 之后：还原时那两块是先新建再填内容，得等它们就位。
  // zoomTx = 改动**之前**的放大状态：null=原来三块并排（这次是放大），整数=原来那一块在放大（这次是还原）。
  if (state.zoomTx !== undefined) {
    const prevZoom = state.zoomTx;
    state.zoomTx = undefined;
    playZoomTx(prevZoom);
  }
  renderModbar();
  renderVSwitch();
}

/**
 * 模块选择器的过渡：从"界面顶部的下拉"变成"界面左侧的列表"（或反过来）时，
 * 用 FLIP 把它从旧位置平滑移动到新位置，看起来像是同一个控件挪过去了。
 */
function playPickFlip(before) {
  if (prefersReduced()) return;            // 减少动画时直接落在终点位置
  document.querySelectorAll("[data-pick]").forEach((el) => {
    const prev = before.get(el.dataset.pick);
    if (!prev) return;
    const now = el.getBoundingClientRect();
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    el.animate([
      { transform: `translate(${dx}px, ${dy}px)`, opacity: 0.35 },
      { transform: "none", opacity: 1 },
    ], { duration: 420, easing: "cubic-bezier(.22,1,.36,1)" });
  });
}

/**
 * 横屏 ↔ 竖屏切换时的**旋转过渡**（用户明确要求"旋转的横向到竖向/竖向到横向"）。
 * 做法：跨越 1080px 断点时给舞台加一个短促的 rotate+scale 动画，
 * 同时 FLIP 负责把每块面板从旧位置补到新位置 —— 一个转、一个滑，看起来是一次"翻面"。
 */
function playRotateIn() {
  const stage = $("#stage");
  if (!stage || !stage.animate) return;
  stage.animate([
    { transform: "rotate(-4.5deg) scale(.965)", opacity: 0.55 },
    { transform: "rotate(0deg) scale(1)", opacity: 1 },
  ], { duration: 460, easing: "cubic-bezier(.22,1,.36,1)" });
}

/* ============================================================
   竖屏（窄屏）用的**竖排切换按钮**
   用户要求：竖着的时候不要显示横着的切换条，改用竖排按钮；
             横着的时候反过来，只显示顶部横向条。
   竖屏是"三个界面竖着排"，所以竖排按钮 = 每个界面一个，
   点一下滚到那个界面，滚到哪、按钮自动高亮到哪。
   ============================================================ */
const VICONS = {
  board: "▦", limitup: "▲", heat: "◔", screen: "▽", sectors: "◍",
  dragon: "♛", research: "◈", index: "◨", stock: "▪", review: "✓", funds: "◎",
  selfcheck: "⛨", researchOne: "★", sectorOne: "◉",
};

function renderVSwitch() {
  const v = $("#vswitch");
  if (!v) return;
  const act = state.vactiveSlot;
  v.innerHTML = state.slots.map((id, i) => {
    const m = moduleById(id);
    return `<div class="vc ${act === i ? "on" : ""}" data-slot="${i}" title="${esc(m.title)}">
      <span class="ic">${VICONS[id] || "•"}</span>
      <span class="tx">${esc((m.short || m.title).slice(0, 4))}</span>
    </div>`;
  }).join("");
  v.querySelectorAll(".vc").forEach((el) =>
    el.addEventListener("click", () => {
      const i = Number(el.dataset.slot);
      state.vactiveSlot = i;
      state.activeSlot = i;
      renderVSwitch();
      renderModbar();
      scrollToSlot(i);
    }));
}

/**
 * FLIP：量新位置 → 用 transform 把差值补回去 → 释放动画。
 * 只动 transform / opacity（合成层），时长和缓动与 CSS 变量一致，
 * 所以"缩小回去"与"展开出来"是同一个节奏，看起来是一套连贯动作。
 */
function playFlip(before, opts) {
  const o = opts || {};
  const DUR = 340;
  const EASE = "cubic-bezier(.4,0,.2,1)";
  // 系统开了"减少动画"就**直接跳到终态**：这些位移/缩放对前庭敏感的人是真的难受，
  // 而且顺带让"最终布局"变得可测量（动画中途量到的是起始帧，不是终点）。
  if (prefersReduced()) return;
  // ⚠️ 只动**面板卡片**（PANEL_SEL）。这里如果写成 `[data-slot]`，
  //    界面内部的 ‹ › 按钮/模块下拉都会被当成"要飞的面板"，
  //    用别人的 rect 做出 20 倍以上的缩放 —— 用户报的"箭头大小异常"就是这个。
  document.querySelectorAll(PANEL_SEL).forEach((el) => {
    const prev = before.get(el.dataset.slot);
    const now = el.getBoundingClientRect();
    if (!prev) {
      el.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
                 { duration: DUR, easing: EASE });
      return;
    }
    const dx = prev.left - now.left;
    const dy = prev.top - now.top;
    const sx = now.width > 0 ? prev.width / now.width : 1;
    const sy = now.height > 0 ? prev.height / now.height : 1;
    const moved = Math.abs(dx) > 1 || Math.abs(dy) > 1
                  || Math.abs(sx - 1) > 0.02 || Math.abs(sy - 1) > 0.02;
    if (!moved) return;
    // 透明度规则：
    //  · 只横向伸缩（放大/还原那一下）→ 保持不透明，让它看起来是"同一块布在拉宽/收窄"，
    //    淡出会显得像是重新加载了一个页面；
    //  · 同时纵向长大（原来是被压扁的）→ 淡入，避免"从一条线里挤出来"的怪异感；
    //  · 同时纵向缩小 → 略淡，暗示它要让位。
    const pureWidth = Math.abs(sy - 1) <= 0.02;
    const startOpacity = el.parentElement && el.parentElement.id === "stage"
      ? (pureWidth ? 1 : (sy > 1 ? (o.enterOpacity ?? 0.25) : 0.45))
      : 1;
    el.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`,
        transformOrigin: "top left", opacity: startOpacity },
      { transform: "none", transformOrigin: "top left", opacity: 1 },
    ], { duration: DUR, easing: EASE });
  });
}

/* ============================================================
   拖动交互：**统一用 pointer 事件**，不用浏览器原生 drag-and-drop。
   用户要求："三个界面的模块向下拖动的时候，我也希望你做成这种（跟左右拖一样的）平滑拖动"。
   原生 HTML5 DnD 的问题：拖影由浏览器控制、dragover 每秒几十次、还要靠大面积的虚线遮罩
   提示落点 —— 又卡又飘。现在改成：
     · 自己画一个"跟手"的小幽灵（只动 transform，合成层，60fps）
     · 落点用坐标算（O(1)），只给目标面板加一个 class 高亮
     · 松手才真正换内容：拖动过程零 DOM 重建、零重排
   ============================================================ */
function ensureGhost() {
  let g = document.getElementById("dragGhost");
  if (!g) {
    g = document.createElement("div");
    g.id = "dragGhost";
    g.className = "dragghost";
    document.body.appendChild(g);
  }
  return g;
}

function beginPointerDrag(e, info) {
  if (e.button !== undefined && e.button !== 0) return;
  state.pd = Object.assign({ active: false, sx: e.clientX, sy: e.clientY,
                             x: e.clientX, y: e.clientY, target: null }, info);
  window.addEventListener("pointermove", onPointerDragMove, { passive: true });
  window.addEventListener("pointerup", onPointerDragEnd);
  window.addEventListener("pointercancel", onPointerDragEnd);
}

function onPointerDragMove(e) {
  const pd = state.pd;
  if (!pd) return;
  pd.x = e.clientX; pd.y = e.clientY;
  if (!pd.active) {
    if (Math.abs(e.clientX - pd.sx) + Math.abs(e.clientY - pd.sy) < 6) return;  // 6px 内算点击
    pd.active = true;
    const g = ensureGhost();
    g.textContent = pd.label || pd.id;
    g.classList.add("show");
    document.body.classList.add("chip-dragging");
  }
  const g = document.getElementById("dragGhost");
  if (g) g.style.transform = `translate3d(${Math.round(e.clientX + 14)}px, ${Math.round(e.clientY + 12)}px, 0)`;
  const slot = slotAtPoint(e.clientX, e.clientY);
  if (slot !== pd.target) {
    pd.target = slot;
    document.querySelectorAll("#stage > article.mod").forEach((el) =>
      el.classList.toggle("droptarget", slot !== null && Number(el.dataset.slot) === slot));
    if (g) {
      const m = slot === null ? null : moduleById(state.slots[slot]);
      g.dataset.hint = slot === null ? "松开取消"
        : (pd.kind === "panel" ? `与「${m.title}」互换` : `替换「${m.title}」`);
    }
  }
  e.preventDefault();
}

function onPointerDragEnd() {
  const pd = state.pd;
  state.pd = null;
  window.removeEventListener("pointermove", onPointerDragMove);
  window.removeEventListener("pointerup", onPointerDragEnd);
  window.removeEventListener("pointercancel", onPointerDragEnd);
  const g = document.getElementById("dragGhost");
  if (g) { g.classList.remove("show"); g.dataset.hint = ""; }
  document.body.classList.remove("chip-dragging");
  document.querySelectorAll("#stage > article.mod").forEach((el) =>
    el.classList.remove("droptarget", "dragging"));
  if (!pd || !pd.active || pd.target === null) return;
  if (pd.kind === "panel") {
    if (pd.fromSlot !== pd.target) swapSlots(pd.fromSlot, pd.target);
  } else {
    assignSlot(pd.target, pd.id);
  }
}

/** 坐标 → 第几块（不在任何一块上时返回 null） */
function slotAtPoint(x, y) {
  const cards = document.querySelectorAll("#stage > article.mod");
  for (const el of cards) {
    if (el.style.display === "none") continue;
    const r = el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return Number(el.dataset.slot);
  }
  return null;
}

/* ============================================================
   顶部模块条（横屏）：列出所有模块
     · 点一下 → 放进"当前界面"（当前界面 = 最后点过的那个，或刚放进过的那个）
     · **按住拖到某一列** → 直接替换那一块（跟手幽灵 + 目标块高亮）
   已经在某个界面里显示的模块会高亮，一眼能看出三块现在是什么。
   ============================================================ */
function renderModbar() {
  const bar = $("#modbar");
  if (!bar) return;
  const list = MODULES.concat(state.researchCode ? [RESEARCH_MOD] : []);
  // 自检模块有「失效/空仓预警」时给标签上个警示色：不新增元素、
  // 也不往主界面塞横幅，但一眼能看出这块不对劲（点进去就是完整说明）。
  const scLvl = selfcheckLevel();
  bar.innerHTML = `<span class="lead">模块</span>` + list.map((m) => {
    const at = state.slots.indexOf(m.id);
    const warn = (m.id === "selfcheck" && scLvl) ? " " + scLvl : "";
    return `<span class="modchip ${at >= 0 ? "on" : ""}${warn}" data-id="${m.id}"
        title="${esc(m.desc)}">${at >= 0 ? `<span class="pin">${at + 1}</span>` : `<span class="grip">⠿</span>`}${esc(m.title)}</span>`;
  }).join("")
    + `<span class="hint">点一下放进「第 ${state.activeSlot + 1} 个界面」 · 或直接拖到某一列替换它</span>`;
  const chips = Array.from(bar.querySelectorAll(".modchip"));
  chips.forEach((chip) => {
    chip.addEventListener("click", (e) => {
      e.stopPropagation();
      assignSlot(state.activeSlot, chip.dataset.id);
    });
    // 按住就往界面里拖（pointer 事件 + 跟手幽灵，拖起来是丝滑的）
    chip.addEventListener("pointerdown", (e) => {
      beginPointerDrag(e, { kind: "module", id: chip.dataset.id, label: chip.textContent.trim() });
    });
  });
}

/* ---------------- 拖动模块 → 某一列/某一块 ----------------
   现在由 beginPointerDrag / slotAtPoint 处理（跟手幽灵 + 目标块高亮），
   不再需要大面积的虚线遮罩 —— 那个每帧重绘整个舞台，正是"一卡一卡"的来源。 */
function wireColumnDropOnce() {
  if (wireColumnDropOnce.done) return;
  wireColumnDropOnce.done = true;
  ensureGhost();                       // 提前建好幽灵节点，拖动时零创建
}

/** 竖屏？横屏？以 1080 为界，与 CSS 媒体查询保持一致 */
function isPortrait() { return window.innerWidth < 1080; }

/**
 * 竖屏滚动时，竖排按钮自动高亮"当前正在看的那一块"（滚到哪亮到哪），
 * 像 iOS 的分段控件一样始终告诉你现在在哪一屏。
 */
function wireScrollSpy() {
  if (wireScrollSpy.done) return;
  wireScrollSpy.done = true;
  let ticking = false;
  const tick = () => {
    ticking = false;
    if (!isPortrait()) return;
    // 只量**面板卡片本体**：PANEL_SEL 就是为此存在的 ——
    // 界面内部的下拉/‹ › 按钮虽然属于这个界面，但它们不该参与"整块飞过去"的动画。
    const cards = Array.from(document.querySelectorAll(PANEL_SEL));
    if (!cards.length) return;
    const line = 130;                       // 顶部 130px 视作"当前所在"
    let best = Number(cards[0].dataset.slot), bestD = Infinity;
    cards.forEach((el) => {
      const r = el.getBoundingClientRect();
      const inside = r.top <= line && r.bottom >= line;
      const d = inside ? 0 : Math.min(Math.abs(r.top - line), Math.abs(r.bottom - line));
      if (d < bestD) { bestD = d; best = Number(el.dataset.slot); }
    });
    if (best !== state.vactiveSlot) {
      state.vactiveSlot = best;
      state.activeSlot = best;
      // ⚡ 只更新按钮的高亮 class，不重建 innerHTML：
      //    滚动时每一帧都重建 10 个标签是白白的开销（用户反馈过"滚动很卡"）
      const v = $("#vswitch");
      if (v) {
        v.querySelectorAll(".vc").forEach((el) =>
          el.classList.toggle("on", Number(el.dataset.slot) === best));
      }
    }
  };
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(tick);
  }, { passive: true });
}

/* ---------------- 各模块内容 ---------------- */
async function fillModule(id) {
  const box = document.getElementById("body-" + id);
  if (!box) return;
  // 先摆骨架（安卓分屏小窗那种"先出轮廓"），数据到了再换成真内容
  const mod = moduleById(id);
  if (!box.querySelector(".skeleton")) box.innerHTML = skeletonHTML(mod);
  try {
    if (id === "board") await fillBoard(box);
    else if (id === "limitup") await fillLimitup(box);
    else if (id === "heat") await fillHeat(box);
    else if (id === "screen") await fillScreen(box);
    else if (id === "sectors") await fillSectors(box);
    else if (id === "dragon") await fillDragon(box);
    else if (id === "research") await fillResearch(box);
    else if (id === "index") await fillIndex(box);
    else if (id === "stock") await fillStock(box);
    else if (id === "review") await fillReview(box);             // 历史股评（新模块）
    else if (id === "funds") await fillFunds(box);               // 场外 ETF / 指数基金
    else if (id === "selfcheck") await fillSelfcheck(box);       // 系统自检 / 决策复盘
    else if (id === "researchOne") await fillResearchOne(box);   // 搜索出来的个股分析页
    else if (id === "sectorOne") await fillSectorOne(box);       // 点进某个板块：K线+指标+筹码+龙头股
    enhanceTables(box);                                          // 宽表格可左右拖动
  } catch (e) {
    box.innerHTML = `<div class="state err">加载失败：${esc(e.message)}</div>`;
  }
  // 内容到位：内容淡入（只动 opacity，不吃 GPU）；刷新 ‹ › 按钮状态
  const card = panelOf(box);
  if (card) {
    box.classList.add("appeared");
    updatePanButtons(card);
    requestAnimationFrame(() => {
      updatePanButtons(card);
      // 表格宽度是渲染后才确定的，等一帧再判一次，避免刚展开时按钮是灰的
      setTimeout(() => updatePanButtons(card), 120);
    });
  }
}

async function fillBoard(box) {
  const d = await api("dashboard");
  const b = d.breadth || {}, L = d.limit || {};
  const rowsIn = (d.flow_in_top || []).slice(0, 8).map((r) => `<tr>
      <td class="l">${esc(r.code)} ${esc(r.name)}</td>
      <td class="${cls(r.change_pct)}">${pctTxt(r.change_pct)}</td>
      <td class="up">${money(wan(r.main_net))}</td></tr>`).join("");
  const rowsOut = (d.flow_out_top || []).slice(0, 8).map((r) => `<tr>
      <td class="l">${esc(r.code)} ${esc(r.name)}</td>
      <td class="${cls(r.change_pct)}">${pctTxt(r.change_pct)}</td>
      <td class="down">${money(wan(r.main_net))}</td></tr>`).join("");
  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "市场情绪", v: num(d.market_score, 1) },
      { k: "涨停 / 跌停", v: `${L.up ?? "—"} / ${L.down ?? "—"}` },
      { k: "炸板", v: L.break ?? "—", cls: "flat" },
      { k: "涨跌家数", v: `${b.advancing ?? "—"} / ${b.declining ?? "—"}` },
    ])}
    <div class="grid2" style="margin-top:12px">
      <div class="box"><div class="k">涨跌家数比</div><div class="v num">${num(b.advance_decline_ratio, 2)}</div></div>
      <div class="box"><div class="k">涨幅中位数</div><div class="v num ${cls(b.median_change_pct)}">${pctTxt(b.median_change_pct)}</div></div>
      <div class="box"><div class="k">最高连板</div><div class="v num">${L.max_continue ?? "—"} 板</div></div>
      <div class="box"><div class="k">炸板率</div><div class="v num">${L.break_rate === null || L.break_rate === undefined ? "—" : (L.break_rate * 100).toFixed(1) + "%"}</div></div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <div><div class="note">主力净流入 Top（单位：万元）</div>
        <table><tbody>${rowsIn || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table></div>
      <div><div class="note">主力净流出 Top</div>
        <table><tbody>${rowsOut || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table></div>
    </div>
    <div class="note">市场情绪评分公式公开：涨跌家数比 30% + 涨停家数 25% + 跌停家数 15% + 炸板率 15% + 连板高度 15%。</div>`;
}

async function fillLimitup(box) {
  const d = await api("limitup");
  const rows = (d.up || []).slice(0, 40).map((r) => `<tr>
      <td class="l">${esc(r.code)} ${esc(r.name)}</td>
      <td class="l">${esc(r.industry || "—")}</td>
      <td class="up">${pctTxt(r.change_pct)}</td>
      <td>${r.continue_days ?? "—"}</td>
      <td>${esc(r.first_seal || "—")}</td>
      <td>${r.break_times ?? 0}</td>
      <td>${money(wan(r.seal_fund))}</td></tr>`).join("");
  const ladder = (d.ladder || []).slice(0, 6).map((x) =>
    `<div class="kv"><span class="k">${x.days} 连板（${x.stocks.length} 只）</span>
      <span class="v">${x.stocks.slice(0, 6).map((s) => esc(s.name)).join(" · ")}</span></div>`).join("");
  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "涨停", v: (d.up || []).length, cls: "up" },
      { k: "首板", v: (d.first_board || []).length },
      { k: "炸板", v: (d.break || []).length, cls: "flat" },
      { k: "跌停", v: (d.down || []).length, cls: "down" },
    ])}
    <div style="margin-top:12px" class="note">连板天梯</div>${ladder || '<div class="state">无数据</div>'}
    <div class="note">涨停明细（按连板数与封板时间排序）</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">股票</th><th class="l">行业</th><th>涨幅</th><th>连板</th>
        <th>首封</th><th>炸板次数</th><th>封单额</th></tr></thead>
      <tbody>${rows || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table></div>`;
}

async function fillHeat(box) {
  let d = null;
  try { d = await api("history"); } catch (e) { d = null; }
  const days = ((d && d.days) || []).slice(-8);
  if (!days.length) {
    box.innerHTML = `<div class="state">还没有历史数据：每次完整抓取会往
      <b>data/history.json</b> 追加一条当日市场温度，跑满 2~5 个交易日后这里就有趋势了。</div>`;
    return;
  }
  const maxUp = Math.max(...days.map((x) => x.limit_up || 0), 1);
  const rows = days.slice().reverse().map((x) => {
    const w = Math.max(2, ((x.limit_up || 0) / maxUp) * 100);
    return `<tr>
      <td class="l">${esc(x.date || "")}</td>
      <td class="up">${x.limit_up ?? "—"}</td>
      <td class="down">${x.limit_down ?? "—"}</td>
      <td>${x.break ?? "—"}</td>
      <td>${x.break_rate === null || x.break_rate === undefined ? "—" : (x.break_rate * 100).toFixed(1) + "%"}</td>
      <td>${x.max_continue ?? "—"}</td>
      <td>${num(x.market_score, 1)}</td>
      <td>${x.scored ?? "—"}</td>
      <td>${num(x.top_avg_score, 1)}</td>
      <td class="l" style="width:22%"><span style="display:block;height:8px;background:#2a2a30;border-radius:2px">
        <i style="display:block;height:8px;width:${w}%;background:#e64545;border-radius:2px"></i></span></td>
    </tr>`;
  }).join("");
  const first = days[0], last = days[days.length - 1];
  const delta = (last.market_score ?? 0) - (first.market_score ?? 0);
  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "最新交易日", v: esc(last.date || "—") },
      { k: "情绪变化", v: `${delta >= 0 ? "+" : ""}${num(delta, 1)}`, cls: cls(delta) },
      { k: "涨停（当日）", v: last.limit_up ?? "—", cls: "up" },
      { k: "覆盖天数", v: days.length },
    ])}
    <div class="note">红条 = 当日涨停家数（相对本期最高值）。数据来自每次完整抓取写入的
      data/history.json，最多保留 30 个交易日。</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">日期</th><th>涨停</th><th>跌停</th><th>炸板</th><th>炸板率</th>
        <th>最高连板</th><th>情绪</th><th>精算</th><th>Top均分</th><th class="l">热度</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

/**
 * 选股评分（全市场筛选表）。
 *
 * 用户要求："5000 家都要能筛到、能搜到，但评分/筛选不要只挑一小撮出来。"
 * 所以现在 `screen.rows` 是**全市场**（5000+ 行），前端必须扛得住：
 *   · **分页渲染**：一次只插 80 行 DOM，滚到底/点"加载更多"再追加（5000 行一次插进去必卡死）
 *   · **表内过滤**：只看精算 / 只看主力净流入 / 涨跌幅≥x / 行业 / 关键字（代码或名称）
 *   · **事件委托**：所有行共用一个点击处理器，不给 5000 行各绑一个
 *   · 排序只对内存数组做一次，不重建整张表以外的 DOM
 */
/**
 * 重渲染之后把输入框的光标放回去。
 *
 * 为什么需要（这是个真实的坑）：筛选/基金这些面板在"改条件"时是整块 `innerHTML` 重建的，
 * 连输入框本身都会被销毁重建 —— 于是"打几个字 → 停 220ms（防抖触发）→ 再打字"时，
 * 光标已经不在输入框里了，后面的字**打不进去**，用户只会觉得"搜索框坏了"。
 * 只在该输入框原本有焦点时恢复（`active`），避免抢走别的焦点。
 */
function keepFocus(box, sel, active) {
  if (!active || !box || !box.querySelector) return;
  const el = box.querySelector(sel);
  if (!el) return;
  if (el.focus) el.focus();
  const n = String(el.value || "").length;
  if (el.setSelectionRange) {
    try { el.setSelectionRange(n, n); } catch (e) { /* 某些类型不支持，忽略 */ }
  }
}

const SCREEN_PAGE = 80;

function screenFilteredRows(allRows) {
  const f = state.screenFilter || (state.screenFilter = { mode: "all", q: "", industry: "", minChg: null });
  let rows = allRows;
  if (f.mode === "tech") rows = rows.filter((r) => r.has_tech);
  else if (f.mode === "inflow") rows = rows.filter((r) => (r.main_net || 0) > 0);
  else if (f.mode === "rise") rows = rows.filter((r) => (r.change_pct || 0) > 0);
  if (f.industry) rows = rows.filter((r) => (r.industry || "") === f.industry);
  if (f.minChg !== null && f.minChg !== undefined && f.minChg !== "") {
    const v = Number(f.minChg);
    if (!isNaN(v)) rows = rows.filter((r) => (r.change_pct || 0) >= v);
  }
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) => (r.code || "").startsWith(q) || (r.name || "").toLowerCase().includes(q));
  }
  return rows;
}

async function fillScreen(box) {
  const d = await api("screen");
  const all = d.rows || [];
  const f = state.screenFilter || (state.screenFilter = { mode: "all", q: "", industry: "", minChg: "" });
  const rows = sortRows(screenFilteredRows(all), state.sort);
  state.screenShown = SCREEN_PAGE;                 // 换条件/排序后从头开始分页

  const th = (key, label, cls2 = "") =>
    `<th class="sortable ${cls2}" data-sort="${key}">${label}${
      state.sort.key === key ? (state.sort.dir < 0 ? " ▼" : " ▲") : ""}</th>`;
  const industries = Array.from(new Set(all.map((r) => r.industry).filter(Boolean))).sort();

  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "全市场股票", v: all.length },
      { k: "精算（含技术面）", v: d.scored_count ?? all.filter((r) => r.has_tech).length },
      { k: "筛选结果", v: rows.length },
      { k: "每日高评分", v: d.top_n ?? 0 },
      { k: "市场情绪", v: num(d.market_score, 1) },
    ])}
    <div class="note">${esc(d.note || "")}</div>
    <div class="screentools">
      <input class="mini" id="scQ" placeholder="表内搜索：代码/名称" value="${esc(f.q)}">
      <div class="chips">
        ${[["all", `全部 ${all.length}`], ["tech", "只看精算"], ["inflow", "主力净流入"], ["rise", "上涨"]]
          .map(([v, t]) => `<button class="chip ${f.mode === v ? "on" : ""}" data-mode="${v}">${t}</button>`).join("")}
        <select class="mini" id="scInd">
          <option value="">全部行业</option>
          ${industries.map((x) => `<option value="${esc(x)}"${x === f.industry ? " selected" : ""}>${esc(x)}</option>`).join("")}
        </select>
        <select class="mini" id="scChg">
          <option value="">不限涨跌幅</option>
          ${[5, 3, 0, -3, -5].map((v) => `<option value="${v}"${String(v) === String(f.minChg) ? " selected" : ""}>涨跌幅 ≥ ${v}%</option>`).join("")}
        </select>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        ${th("score", "精算分")}${th("score_light", "快评分")}
        <th class="l">代码</th><th class="l">名称</th><th class="l">行业</th>
        <th>现价</th>${th("change_pct", "涨跌幅")}${th("turnover", "换手")}
        ${th("main_net", "主力净额")}<th>主力占比</th>
        <th>获利盘*</th><th>套牢盘*</th><th>机构</th><th>目标空间</th><th>调研</th>
        <th>C1</th><th>C2</th><th>C3</th><th>C4</th><th class="l">风险</th>
      </tr></thead>
      <tbody id="scBody"></tbody></table></div>
    <div class="screenfoot">
      <span id="scCount" class="muted"></span>
      <button class="btn btn-mini" id="scMore">加载更多</button>
      <button class="btn btn-mini" id="scAll">一次显示全部（可能卡）</button>
    </div>
    <div class="note">「精算分」= 技术32+资金24+筹码18+机构16+板块10−风险（当日精算池才有）；
      「快评分」= 基本面45+资金35+板块情绪20（全市场都有，**不含技术面**）。
      两列口径不同，排序时认准自己点的那一列。带 * 的获利盘/套牢盘为<b>模型估算</b>。
      点任意一行进入个股页——即使没有精算，也会用浏览器实时取日线补齐 K 线/指标/筹码。</div>`;

  // 行渲染（分页）
  const tbody = box.querySelector("#scBody");
  const paintRows = () => {
    const shown = Math.min(state.screenShown, rows.length);
    tbody.innerHTML = rows.slice(0, shown).map((r) => `<tr class="${r.is_top ? "top-pick" : ""}"
        data-code="${esc(r.code)}" data-detail="${r.has_detail ? 1 : 0}">
        <td><b>${r.score === null || r.score === undefined ? "—" : num(r.score, 1)}</b></td>
        <td class="muted">${r.score_light === null || r.score_light === undefined ? "—" : num(r.score_light, 1)}</td>
        <td class="l">${esc(r.code)}</td>
        <td class="l">${esc(r.name)}</td>
        <td class="l">${esc(r.industry || "—")}</td>
        <td>${num(r.price)}</td>
        <td class="${cls(r.change_pct)}">${pctTxt(r.change_pct)}</td>
        <td>${num(r.turnover, 1)}%</td>
        <td class="${cls(r.main_net)}">${money(wan(r.main_net))}</td>
        <td class="${cls(r.main_net_pct)}">${num(r.main_net_pct, 2)}%</td>
        <td>${r.profit_ratio === null || r.profit_ratio === undefined ? "—" : num(r.profit_ratio, 1) + "%"}</td>
        <td>${r.trapped_ratio === null || r.trapped_ratio === undefined ? "—" : num(r.trapped_ratio, 1) + "%"}</td>
        <td>${r.rating ? stanceTag(r.rating) : "—"}</td>
        <td>${r.upside_pct === null || r.upside_pct === undefined ? "—" : pctTxt(r.upside_pct, 1)}</td>
        <td>${r.survey_orgs || 0}</td>
        <td>${r.c1 ? "✓" : "—"}</td><td>${r.c2 ? "✓" : "—"}</td>
        <td>${r.c3 ? "✓" : "—"}</td><td>${r.c4 ? "✓" : "—"}</td>
        <td class="l muted">${esc((r.risks || []).join("、") || "")}</td>
      </tr>`).join("") || '<tr><td class="l muted">没有符合条件的股票</td></tr>';
    const c = box.querySelector("#scCount");
    if (c) c.textContent = `显示 ${shown} / ${rows.length} 只（全市场 ${all.length} 只）`;
    const m = box.querySelector("#scMore");
    if (m) m.style.display = shown >= rows.length ? "none" : "";
    // 重渲染后把光标还给搜索框（否则"打一半停一下再打"就再也打不进去了）
    keepFocus(box, "#scQ", f.focus);
    f.focus = false;
  };
  paintRows();

  // ---- 工具条（输入框防抖，避免每敲一个字就重排 5000 行）----
  let t = null;
  const requery = () => { rows.length = 0; fillScreen(box); };
  const q = box.querySelector("#scQ");
  if (q) q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { f.q = q.value.trim(); f.focus = true; requery(); }, 220);
  });
  const ind = box.querySelector("#scInd");
  if (ind) ind.addEventListener("change", () => { f.industry = ind.value; requery(); });
  const chg = box.querySelector("#scChg");
  if (chg) chg.addEventListener("change", () => { f.minChg = chg.value; requery(); });
  box.querySelectorAll("[data-mode]").forEach((b) =>
    b.addEventListener("click", (e) => { e.stopPropagation(); f.mode = b.dataset.mode; requery(); }));
  box.querySelectorAll("th.sortable").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const key = el.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: -1 };
      fillScreen(box);
    });
  });
  const more = box.querySelector("#scMore");
  if (more) more.addEventListener("click", (e) => {
    e.stopPropagation();
    state.screenShown += SCREEN_PAGE * 3;           // 一次多给几页，少点几次
    paintRows();
  });
  const allBtn = box.querySelector("#scAll");
  if (allBtn) allBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    state.screenShown = rows.length;
    paintRows();
  });
  // 行点击：**事件委托**（5000 行只绑一个监听器）
  tbody.addEventListener("click", (e) => {
    const tr = e.target.closest ? e.target.closest("tr[data-code]") : null;
    if (!tr) return;
    e.stopPropagation();
    const card = panelOf(tr);
    openStock(tr.dataset.code, card ? card.dataset.slot : undefined, tr.dataset.detail !== "0");
  });
}

function sortRows(rows, sort) {
  const k = sort.key, dir = sort.dir;
  return rows.slice().sort((a, b) => {
    const x = a[k], y = b[k];
    const nx = (x === null || x === undefined || x === "") ? -Infinity : Number(x);
    const ny = (y === null || y === undefined || y === "") ? -Infinity : Number(y);
    if (isNaN(nx) && isNaN(ny)) return 0;
    if (isNaN(nx)) return 1;
    if (isNaN(ny)) return -1;
    return (nx - ny) * dir;
  });
}

async function fillSectors(box) {
  const d = await api("sectors");
  // 龙头股**汇总**（用户问"总结出来的龙头股放在哪里"）：
  // 全市场各板块的"涨幅第一"集中排在最上面，按涨幅降序，一眼看到今天谁最强。
  const allBoards = [].concat(d.industry || [], d.concept || []);
  const tops = [];
  const seen = new Set();
  allBoards.forEach((b) => {
    const ld = (b.leaders || [])[0];
    if (!ld || seen.has(ld.code)) return;
    seen.add(ld.code);
    tops.push({ ...ld, board: b.name, boardCode: b.code });
  });
  tops.sort((a, b) => (b.change_pct || -99) - (a.change_pct || -99));
  const leadSummary = tops.length ? `
    <div class="note" style="margin-top:10px">龙头股汇总（各板块涨幅第一，按涨幅排序 · 共 ${tops.length} 只）</div>
    <div class="leadgrid">
      ${tops.slice(0, 18).map((x) => `
        <div class="leadcard" data-stock="${esc(x.code)}" title="点开看 ${esc(x.name)} 的 K 线/指标/筹码">
          <div class="l1">${esc(x.code)} <b>${esc(x.name)}</b>
            <span class="${cls(x.change_pct)}">${pctTxt(x.change_pct)}</span></div>
          <div class="l2">板块：${esc(x.board || "")}</div>
          <div class="l2">主力 ${money(wan(x.main_net))} · 换手 ${num(x.turnover, 2)}%</div>
        </div>`).join("")}
    </div>` : "";
  // 每个板块一行：资金流 + **5 只龙头股**（按涨幅降序，后端算好）
  // 点板块名 → 把"板块分析"放进当前界面（板块 K 线 + 指标 + 筹码峰 + 龙头股）
  const table = (title, arr) => {
    const rows = (arr || []).slice(0, 15).map((r, i) => {
      const ld = (r.leaders || []).slice(0, 5);
      const ldHTML = ld.length
        ? ld.map((x) => `<span class="leadchip" data-stock="${esc(x.code)}"
             title="点开看这只股票的 K 线/指标/筹码">${esc(x.name)}
             <b class="${cls(x.change_pct)}">${pctTxt(x.change_pct)}</b></span>`).join("")
        : '<span class="muted">龙头股数据缺失</span>';
      const canOpen = !!(r.kline || r.kline_missing);
      return `<tr>
        <td>${i + 1}</td>
        <td class="l">
          <span class="${canOpen ? "boardlink" : ""}" data-board="${esc(r.code || "")}"
                data-name="${esc(r.name || "")}">${esc(r.name)}</span>
          ${r.kline ? "" : '<span class="muted" title="本轮未生成该板块 K 线">·</span>'}
        </td>
        <td class="${cls(r.change_pct)}">${pctTxt(r.change_pct)}</td>
        <td class="${cls(r.main_net)}">${money(wan(r.main_net))}</td>
        <td>${num(r.main_net_pct, 2)}%</td>
        <td class="l">${ldHTML}</td></tr>`;
    }).join("");
    return `<div><div class="note">${title}</div><table>
      <thead><tr><th>#</th><th class="l">板块</th><th>涨跌幅</th><th>主力净额</th>
        <th>净占比</th><th class="l">5 只龙头股（按涨幅）</th></tr></thead>
      <tbody>${rows || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table></div>`;
  };
  box.innerHTML = `
    <div class="note">点<b>板块名</b>看它的 K 线 + 全部指标 + 筹码峰；点<b>龙头股</b>看这只个股的图。</div>
    ${leadSummary}
    <div class="grid2">
      ${table("行业板块（按主力净流入）", d.industry)}
      ${table("概念板块", d.concept)}
      ${table("ETF（基金流入代理）", d.etf)}
    </div>
    <div class="note">资金流单位：万元 → 自动换算为亿；主力 = 超大单 + 大单。公募基金申赎份额无免费来源，用场内 ETF 代理。</div>`;

  box.querySelectorAll("[data-board]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!el.dataset.board) return;
      openSector(el.dataset.board, el.dataset.name);
    }));
  box.querySelectorAll("[data-stock]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openResearch(el.dataset.stock);
    }));
}

/**
 * 板块分析页：板块指数 K 线 + 全部指标 + 筹码峰 + 该板块 5 只龙头股。
 * 数据来自后端（sectors.json 里每个板块的 kline/chip/leaders）；
 * 本轮没取到 K 线时**明确写"数据缺失"**，不拿成分股合成一条假指数冒充板块指数。
 */
async function fillSectorOne(box) {
  const code = state.sectorCode;
  if (!code) { box.innerHTML = `<div class="state">在「板块行情」里点一个板块名。</div>`; return; }
  const d = await api("sectors");
  const all = [].concat(d.industry || [], d.concept || [], d.etf || []);
  const b = all.find((x) => x.code === code);
  if (!b) {
    box.innerHTML = `<div class="state err">这一轮数据里没有板块 ${esc(code)}（板块名单每轮可能变化）</div>`;
    return;
  }
  const kl = b.kline || null;
  const chip = b.chip || (kl ? chipFromKline(kl, kl.close[kl.close.length - 1]) : {});
  const rows = chip.rows || [];
  const cur = kl ? Number(kl.close[kl.close.length - 1]) : 0;
  const avg = avgChipCost(rows, cur);
  state.stockPrice = cur;
  const ind = b.indicators || {};
  const leaders = (b.leaders || []).slice(0, 5);
  const leadRows = leaders.map((x, i) => `<tr>
      <td>${i + 1}</td>
      <td class="l"><span class="boardlink" data-stock="${esc(x.code)}">${esc(x.code)} ${esc(x.name)}</span></td>
      <td>${num(x.price)}</td>
      <td class="${cls(x.change_pct)}">${pctTxt(x.change_pct)}</td>
      <td class="${cls(x.main_net)}">${money(wan(x.main_net))}</td>
      <td>${num(x.turnover, 2)}%</td>
      <td>${x.market_cap ? money(yi(x.market_cap), false) + "亿" : "—"}</td></tr>`).join("");

  box.innerHTML = `
    <div class="grid2">
      <div class="box"><div class="k">板块</div>
        <div class="v" style="font-size:15px">${esc(b.name || "")}
          <span class="muted" style="font-size:12px">${esc(code)}</span></div></div>
      <div class="box"><div class="k">涨跌幅</div>
        <div class="v ${cls(b.change_pct)}">${pctTxt(b.change_pct)}</div></div>
      <div class="box"><div class="k">主力净额 / 净占比</div>
        <div class="v ${cls(b.main_net)}" style="font-size:15px">${money(wan(b.main_net))}
          <span class="muted" style="font-size:12px">${num(b.main_net_pct, 2)}%</span></div></div>
      <div class="box"><div class="k">成分股涨/跌 家数</div>
        <div class="v" style="font-size:15px">${b.up ?? "—"} / ${b.down ?? "—"}</div></div>
    </div>

    ${kl ? `
    <div class="kinfo" style="margin-top:10px"></div>
    <div class="tabs">
      ${["MACD", "KDJ", "RSI", "NONE"].map((k) =>
        `<button class="btn btn-mini ${k === "MACD" ? "on" : ""}" data-k="ind" data-v="${k}">${k === "NONE" ? "只看K线" : k}</button>`).join("")}
      ${[60, 120].map((n) =>
        `<button class="btn btn-mini ${n === 60 ? "on" : ""}" data-k="bars" data-v="${n}">${n}根</button>`).join("")}
    </div>
    <div class="chart-wrap"><div class="ktip"></div><canvas class="kc" id="kSec"></canvas>
      <div class="kempty" style="display:none">没有该板块 K 线数据</div></div>
    <div class="legend">
      <span><i style="background:${KC.ma5}"></i>MA5</span>
      <span><i style="background:${KC.ma10}"></i>MA10</span>
      <span><i style="background:${KC.ma20}"></i>MA20</span>
      <span><i style="background:${KC.ma60}"></i>MA60</span>
      <span><i style="background:${KC.boll}"></i>BOLL(20,2)</span>
      <span class="muted">鼠标移到图上：显示该日全部数据与当前指标数值</span>
    </div>
    <div class="grid2" style="margin-top:12px">
      <div><div class="note">板块技术面（由板块指数 K 线本地计算）</div>
        <div class="kv"><span class="k">MA5 / MA10 / MA20 / MA60</span><span class="v">${
          [5, 10, 20, 60].map((n) => num(kSma(kl.close, n)[kl.close.length - 1])).join(" / ")}</span></div>
        <div class="kv"><span class="k">RSI14 / MACD柱</span><span class="v">${
          num(kRsi(kl.close)[kl.close.length - 1], 1)} / ${
          num(kMacd(kl.close).bar[kl.close.length - 1], 3)}</span></div>
        <div class="kv"><span class="k">KDJ J / BOLL 上/中/下</span><span class="v">${
          num(kKdj(kl.high, kl.low, kl.close).j[kl.close.length - 1], 1)} / ${
          [kBoll(kl.close).up, kBoll(kl.close).mid, kBoll(kl.close).dn]
            .map((a) => num(a[kl.close.length - 1])).join("/")}</span></div>
        <div class="kv"><span class="k">多头排列（日线/周线）</span><span class="v">${
          ind.daily_bull ? "是" : "否"} / ${ind.weekly_bull ? "是" : "否"}</span></div>
      </div>
      <div><div class="note">板块筹码（估算 · 非官方）</div>
        <div class="kv"><span class="k">形态</span><span class="v">${esc(chip.shape || "—")}</span></div>
        <div class="kv"><span class="k">获利盘 / 套牢盘</span><span class="v">${
          num(chip.profit_ratio_pct)}% / ${num(chip.trapped_ratio_pct)}%</span></div>
        <div class="kv"><span class="k">平均筹码（指数点位）</span><span class="v">${num(chip.avg_cost)}</span></div>
        <div class="kv"><span class="k">密集筹码带</span><span class="v">${
          chip.top10_band && chip.top10_band.low
            ? `${num(chip.top10_band.low)} ~ ${num(chip.top10_band.high)}` : "—"}</span></div>
      </div>
    </div>
    <div class="note" style="margin-top:12px">板块筹码分布（估算 · 非官方）</div>
    <div class="chip-legend">
      <span><i style="background:${KC.trapped}"></i>现价以上（套牢盘 ${num(chip.trapped_ratio_pct)}%）</span>
      <span><i style="background:${KC.up}"></i>现价以下（获利盘 ${num(chip.profit_ratio_pct)}%）</span>
      <span><i style="background:${KC.amber}"></i>黄线 = 现价</span>
      <span><i style="background:${KC.avg}"></i>紫线 = 平均筹码</span>
    </div>
    <div class="chips-wrap">
      <div class="chip-tip"></div>
      <div class="chip-hline"></div>
      <div class="chip-line now"><span></span></div>
      <div class="chip-line avg"><span></span></div>
      ${chipRowsHTML(rows, cur) || '<div class="state">无筹码数据</div>'}
    </div>
    <div class="note">${esc(chip.note || "")}</div>
    ` : `<div class="state" style="text-align:left;padding:12px 0">
      ⚠️ <b>这个板块本轮没有取到 K 线</b>，所以看不到它的 K 线、指标与筹码峰。
      原因是东方财富 K 线接口当天被限流（免费接口的常见情况），
      <b>不是本工具不做</b>——下一轮抓取会补上；也可以点上方"刷新"后再看。
      下面的龙头股与资金数据是本轮真实取到的。</div>`}

    <div class="note" style="margin-top:12px">本板块 5 只龙头股（按当日涨幅降序）</div>
    <table><thead><tr><th>#</th><th class="l">股票</th><th>现价</th><th>涨跌幅</th>
      <th>主力净额</th><th>换手</th><th>总市值</th></tr></thead>
      <tbody>${leadRows || '<tr><td class="l muted">龙头股数据缺失</td></tr>'}</tbody></table>
    <div class="note">点任意一只龙头股 → 打开它的个股分析页（K 线 / 全部指标 / 筹码峰 / 机构多空）。</div>`;

  if (kl) {
    mountKline(document.getElementById("kSec"), kl, { info: ".kinfo", bars: 60, ind: "MACD" });
    box.querySelectorAll("[data-k]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        klineSet("kSec", btn.dataset.k, btn.dataset.v);
      }));
  }
  if (rows.length) {
    wireChipHover(box);
    requestAnimationFrame(() => positionChipLines(box, rows, cur, avg.all));
  }
  box.querySelectorAll("[data-stock]").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      openResearch(el.dataset.stock);
    }));
}

/**
 * 历史股评（新模块，用户要求）：
 *   每期记录"当日评分最高的一批"，下一交易日回填它们的涨跌幅，
 *   连续保留 5 期，汇总**胜率**与**平均涨幅**。旧期自动删除（后端负责）。
 * 口径写清楚：收盘对收盘、不含手续费、不是实盘收益。
 */
async function fillReview(box) {
  const d = await api("review");
  const periods = (d.periods || []).slice().reverse();      // 最新一期在最上面
  const s = d.summary || {};
  const life = d.lifetime || {};                            // 长期累计（明细删了也不清零）
  const done = periods.filter((p) => p.done);
  const pending = periods.filter((p) => !p.done);
  const pct = (v) => (v === null || v === undefined ? "—" : pctTxt(v));
  const clsOf = (v) => cls(v);

  const pickRows = (p) => (p.picks || []).map((x, i) => {
    const r = (p.results || []).find((y) => y.code === x.code);
    const chg = r ? r.change_pct : null;
    return `<tr>
      <td>${i + 1}</td>
      <td class="l">${esc(x.code)} ${esc(x.name || "")}</td>
      <td>${num(x.score, 1)}</td>
      <td>${num(x.close)}</td>
      <td>${esc(x.advice || "—")}</td>
      <td class="${clsOf(chg)}">${p.done ? pct(chg) : '<span class="muted">待回评</span>'}</td>
    </tr>`;
  }).join("");

  const periodCards = periods.map((p) => `
    <div class="rvcard">
      <div class="rvhead">
        <b>${esc(p.date)}</b>
        <span class="muted">选 ${ (p.picks || []).length } 只</span>
        ${p.done
          ? `<span class="muted">→ 次日 ${esc(p.next_date || "")} 回评</span>
             <span class="rvstat">胜率 <b class="${(p.win_rate || 0) >= 50 ? "up" : "down"}">${num(p.win_rate, 1)}%</b></span>
             <span class="rvstat">平均 <b class="${clsOf(p.avg_change)}">${pct(p.avg_change)}</b></span>
             <span class="rvstat muted">最好 ${pct(p.max_gain)} / 最差 ${pct(p.max_loss)}</span>`
          : '<span class="tag-n stance">待下一交易日回评</span>'}
      </div>
      <table><thead><tr><th>#</th><th class="l">股票</th><th>评分</th><th>入选价</th>
        <th>倾向</th><th>次日涨跌幅</th></tr></thead>
        <tbody>${pickRows(p) || '<tr><td class="l muted">无</td></tr>'}</tbody></table>
    </div>`).join("");

  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "累计胜率（一直保留）",
        v: life.win_rate === null || life.win_rate === undefined ? "—" : num(life.win_rate, 1) + "%",
        cls: (life.win_rate || 0) >= 50 ? "up" : "down" },
      { k: "累计平均涨幅",
        v: life.avg_change === null || life.avg_change === undefined ? "—" : pctTxt(life.avg_change),
        cls: clsOf(life.avg_change) },
      { k: "累计样本（只）", v: life.picks ?? 0 },
      { k: "累计期数", v: life.periods ?? 0 },
      { k: "近 5 期胜率", v: s.win_rate === null || s.win_rate === undefined ? "—" : num(s.win_rate, 1) + "%",
        cls: (s.win_rate || 0) >= 50 ? "up" : "down" },
      { k: "近 5 期平均", v: s.avg_change === null || s.avg_change === undefined ? "—" : pctTxt(s.avg_change),
        cls: clsOf(s.avg_change) },
      { k: "累计最好 / 最差", v: `${pct(life.best)} / ${pct(life.worst)}` },
    ])}
    <div class="note" style="margin-top:8px">
      <b>历史股评</b>：每期把当天评分最高的那批记下来，<b>下一个交易日</b>用当日快照回填它们的涨跌幅
      （收盘对收盘，不含手续费）。
      <b>明细</b>只保留最近 <b>${d.keep ?? 5}</b> 期，更早的自动删除${d.dropped ? `（本轮删了 ${d.dropped} 期）` : ""}；
      但<b>累计胜率与累计平均涨幅永不清零</b>${life.since ? `，统计自 ${esc(life.since)} 起` : ""}，
      每跑一轮自动累加${life.last ? `（最近一次 ${esc(life.last)}）` : ""}。
      <b>这是规则化回评，不是实盘收益，也不构成投资建议。</b>
    </div>
    <div class="note">${esc(d.note || "")}</div>
    ${periodCards || '<div class="state">还没有回评数据：第一次完整抓取后开始记录，第二次抓取就能看到次日回评。</div>'}`;
}

/**
 * 场外 ETF / 指数基金（用户要求新增）。
 *
 * 数据：天天基金公开接口（排行 + 全量基金表），**净值是 T 日收盘后公布**，
 * 所以它天然是盘后数据、不存在盘中未来函数；每行都显示自己的净值日期。
 * 拿不到的（盘中估值接口已下线、申赎限额、跟踪标的）一律标"—"，不编造。
 */
const FUND_PERIODS = [
  ["chg_1d", "日"], ["chg_1w", "近1周"], ["chg_1m", "近1月"], ["chg_3m", "近3月"],
  ["chg_6m", "近6月"], ["chg_1y", "近1年"], ["chg_ytd", "今年来"], ["chg_since", "成立来"],
];

async function fillFunds(box) {
  const d = await api("funds");
  const all = d.funds || [];
  const f = state.fundFilter || (state.fundFilter = { q: "", onlyEtf: true, sort: "chg_1y" });
  const sortKey = f.sort;
  let rows = all.filter((x) => (!f.onlyEtf || x.is_etf_link));
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((x) => (x.code || "").includes(q) || (x.name || "").toLowerCase().includes(q));
  }
  rows = rows.slice().sort((a, b) => (b[sortKey] ?? -999) - (a[sortKey] ?? -999));

  const th = (key, label) =>
    `<th class="sortable" data-fsort="${key}">${label}${sortKey === key ? " ▼" : ""}</th>`;

  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "在榜基金", v: all.length },
      { k: "其中 ETF 联接", v: all.filter((x) => x.is_etf_link).length },
      { k: "可搜索（ETF/联接）", v: (d.universe || []).length },
      { k: "净值日期", v: esc(all[0] ? all[0].nav_date || "—" : "—") },
      { k: "全量基金库", v: d.fund_total ?? "—" },
    ])}
    <div class="note">${esc(d.note || "")}</div>
    <div class="screentools">
      <input class="mini" id="fdQ" placeholder="搜索基金代码/名称" value="${esc(f.q)}">
      <div class="chips">
        <button class="chip ${f.onlyEtf ? "on" : ""}" data-fetf="1">只看 ETF 联接</button>
        <button class="chip ${f.onlyEtf ? "" : "on"}" data-fetf="0">全部指数基金</button>
      </div>
    </div>
    <div class="table-wrap"><table>
      <thead><tr>
        ${th("chg_1y", "近1年")}${th("chg_1m", "近1月")}
        <th class="l">代码</th><th class="l">名称</th>
        ${th("nav", "单位净值")}${th("chg_1d", "日涨跌")}
        ${th("chg_1w", "近1周")}${th("chg_3m", "近3月")}${th("chg_ytd", "今年来")}
        <th>近6月</th><th>成立来</th><th>成立日</th><th>费率</th>
      </tr></thead>
      <tbody>${rows.slice(0, 200).map((x) => `<tr>
        <td class="${cls(x.chg_1y)}"><b>${pctTxt(x.chg_1y, 1)}</b></td>
        <td class="${cls(x.chg_1m)}">${pctTxt(x.chg_1m, 1)}</td>
        <td class="l">${esc(x.code)}</td>
        <td class="l">${esc(x.name)}${x.is_qdii ? ' <span class="tag flat">QDII</span>' : ""}</td>
        <td>${num(x.nav, 4)}</td>
        <td class="${cls(x.chg_1d)}">${pctTxt(x.chg_1d, 2)}</td>
        <td class="${cls(x.chg_1w)}">${pctTxt(x.chg_1w, 1)}</td>
        <td class="${cls(x.chg_3m)}">${pctTxt(x.chg_3m, 1)}</td>
        <td class="${cls(x.chg_ytd)}">${pctTxt(x.chg_ytd, 1)}</td>
        <td class="${cls(x.chg_6m)}">${pctTxt(x.chg_6m, 1)}</td>
        <td class="${cls(x.chg_since)}">${pctTxt(x.chg_since, 1)}</td>
        <td class="muted">${esc(x.inception || "—")}</td>
        <td class="muted">${esc(x.fee || "—")}</td>
      </tr>`).join("") || '<tr><td class="l muted">没有符合条件的基金</td></tr>'}</tbody></table></div>
    <div class="note">共 ${rows.length} 只（表内最多显示 200 只）。点表头可按「近1年/近1月/单位净值/日涨跌/近1周/近3月/今年来」排序。
      <b>场外基金按当日净值成交</b>（15:00 前申购按当日净值、之后按下一交易日），与股票 T+1 撮合不同；
      本表只做信息展示，<b>不含申赎建议</b>。</div>`;
  // 同上：整块重建会把输入框一起换掉，得把光标还回去
  keepFocus(box, "#fdQ", f.focus);
  f.focus = false;

  let t = null;
  const q = box.querySelector("#fdQ");
  if (q) q.addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(() => { f.q = q.value.trim(); f.focus = true; fillFunds(box); }, 220);
  });
  box.querySelectorAll("[data-fetf]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      f.onlyEtf = b.dataset.fetf === "1";
      fillFunds(box);
    }));
  box.querySelectorAll("th.sortable").forEach((el) =>
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      f.sort = el.dataset.fsort;
      fillFunds(box);
    }));
}

/**
 * 系统自检 / 决策复盘（用户要求的核心新增模块）。
 *
 * 这个面板只回答四个问题，每个都**带依据**（不能只给一句「不宜出手」）：
 *   ① 我的推荐到底赚没赚？—— 逐只列出，用**可执行口径**（T+1 开盘买 → T+2 开盘卖，扣成本）
 *   ② 相对大盘有没有超额？—— 对沪深300，滚动 10 个交易日
 *   ③ 这套策略现在还有效吗？—— 良好 / 衰减 / 失效 / **样本不足**
 *   ④ 现在的市场适不适合出手？—— 普涨 / 震荡 / 单边下跌（附四个原始数字）
 *
 * 另外把「抓取自愈账本」也放在这里：这轮重试了几次、补回了多少、还缺什么。
 * 数据来自 selfcheck.json（Actions 生成），拿不到就如实写"数据缺失"。
 */
const RATING_CLS = { "良好": "up", "衰减": "flat", "失效": "down", "样本不足": "muted" };

function selfcheckRows(periods) {
  const rows = [];
  for (const p of (periods || []).slice().reverse()) {
    for (const x of (p.picks || [])) {
      rows.push({ date: p.date, status: p.status, basis: p.basis_used, ...x });
    }
  }
  return rows.slice(0, 40);
}

async function fillSelfcheck(box) {
  const d = await api("selfcheck");
  const roll = d.rolling || {}, rat = d.rating || {}, reg = d.regime || {};
  const ev = reg.evidence || {}, idx = ev.index || {};
  const fh = (d.factor_health || {}).factors || {};
  const ov = d.weights_override || {};
  const ch = d.collect_health || {};
  const adv = d.advice_override || {};
  const rows = selfcheckRows(d.periods);

  const rowsHTML = rows.map((r) => {
    const net = r.net_pct;
    const untradable = r.untradable;
    // data-stock：整行可点开个股（用户要求"自检里的点个股也能点进去"）
    return `<tr class="clickable" data-stock="${esc(r.code || "")}">
      <td class="l">${esc(r.date || "—")}</td>
      <td class="l">${esc(r.code || "")} ${esc(r.name || "")}</td>
      <td>${r.entry_open === null || r.entry_open === undefined ? "—" : num(r.entry_open)}</td>
      <td>${r.exit_open === null || r.exit_open === undefined ? "—" : num(r.exit_open)}</td>
      <td class="${net === null || net === undefined ? "muted" : cls(net)}">${
        net === null || net === undefined ? "待回评" : pctTxt(net)}</td>
      <td class="${r.bench_pct === null || r.bench_pct === undefined ? "muted" : cls(r.bench_pct)}">${
        r.bench_pct === null || r.bench_pct === undefined ? "基准缺失" : pctTxt(r.bench_pct)}</td>
      <td class="${r.excess_pct === null || r.excess_pct === undefined ? "muted" : cls(r.excess_pct)}">${
        r.excess_pct === null || r.excess_pct === undefined ? "—" : pctTxt(r.excess_pct)}</td>
      <td class="l muted">${untradable ? "不可成交：" + esc(r.why || "") : esc(r.status || "")}</td></tr>`;
  }).join("") || '<tr><td class="l muted">还没有可回评的推荐（主口径要等 T+2 才有结果）</td></tr>';

  const factorHTML = Object.entries(fh).map(([k, v]) => `<tr>
      <td class="l">${esc(v.label || k)}</td>
      <td class="l muted">${esc(v.dim || "")}</td>
      <td class="${v.ic_mean === null || v.ic_mean === undefined ? "muted" : cls(v.ic_mean)}">${
        v.ic_mean === null || v.ic_mean === undefined ? "—" : num(v.ic_mean, 3)}</td>
      <td>${v.icir === null || v.icir === undefined ? "—" : num(v.icir, 2)}</td>
      <td>${v.ic_days ?? 0}</td>
      <td class="${v.factor < 1 ? "down" : "muted"}">${v.factor === undefined ? "—" : "×" + v.factor}</td>
      <td class="l muted">${esc(v.action || "")}</td></tr>`).join("")
    || '<tr><td class="l muted">因子样本还不够（需要至少 20 个交易日）</td></tr>';

  box.innerHTML = `
    <div data-selfcheck-root="1">
    ${(sysInfo.banners || []).map((b) => `<div class="warnbar ${esc(b.level)}">${esc(b.text)}
      <div class="sw-foot">系统自检仅供参考，不构成投资建议，也不会自动下单。</div></div>`).join("")}
    ${summaryHTML(null, [
      { k: "策略评级", v: `<span class="${RATING_CLS[rat.level] || ""}">${esc(rat.level || "—")}</span>` },
      { k: "滚动胜率", v: roll.win_rate === null || roll.win_rate === undefined ? "—" : num(roll.win_rate, 1) + "%" },
      { k: "滚动超额", v: roll.avg_excess === null || roll.avg_excess === undefined ? "基准缺失" :
        `<span class="${cls(roll.avg_excess)}">${pctTxt(roll.avg_excess)}</span>` },
      { k: "市场环境", v: `<span class="${reg.empty_warning ? "down" : ""}">${esc(reg.regime || "—")}</span>` },
      { k: "本轮自愈", v: `${ch.repaired ?? 0} 项补回 / 仍缺 ${ch.still_missing ?? 0}` },
    ])}
    <div class="note">${esc(d.note || "")}</div>

    <div class="grid2" style="margin-top:12px">
      <div class="box">
        <div class="k">策略有效性评级：<b class="${RATING_CLS[rat.level] || ""}">${esc(rat.level || "—")}</b></div>
        <div class="note" style="margin-top:6px">判定依据</div>
        <ul class="bullets">${(rat.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul>
        <div class="note">阈值：窗口 ${rat.thresholds?.window ?? "—"} 个交易日 ·
          超额 ≤${rat.thresholds?.decay_excess ?? "—"}% 判衰减 ·
          ≤${rat.thresholds?.fail_excess ?? "—"}% 或连续 ${rat.thresholds?.decay_streak_fail ?? "—"} 日衰减判失效 ·
          胜率 <${rat.thresholds?.decay_winrate ?? "—"}% 判衰减 ·
          成本 ${rat.thresholds?.cost_bp ?? "—"}bp</div>
      </div>
      <div class="box">
        <div class="k">市场环境：<b class="${reg.empty_warning ? "down" : ""}">${esc(reg.regime || "—")}</b></div>
        <div class="note" style="margin-top:6px">判定依据（可自行复核）</div>
        <ul class="bullets">${(reg.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>—</li>"}</ul>
        <div class="note">指数：${esc(ev.index_name || "—")} · 涨跌家数比 ${
          ev.advance_decline_ratio ?? "—"} · 近 10 日下跌占比中位数 ${
          ev.down_ratio_median_10d === null || ev.down_ratio_median_10d === undefined ? "—"
            : (ev.down_ratio_median_10d * 100).toFixed(0) + "%"}${idx.bars ? ` · K线 ${idx.bars} 根` : ""}</div>
      </div>
    </div>

    <div class="note" style="margin-top:12px">推荐明细（主口径：T+1 开盘买入 → T+2 开盘卖出，已扣成本；
      一字板样本标「不可成交」且**不计入胜率**）</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">选出日</th><th class="l">股票</th><th>买入(开)</th><th>卖出(开)</th>
        <th>净收益</th><th>沪深300</th><th>超额</th><th class="l">状态</th></tr></thead>
      <tbody>${rowsHTML}</tbody></table></div>

    <div class="note" style="margin-top:12px">因子健康度（RankIC，近 20 个交易日）</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">因子</th><th class="l">维度</th><th>IC 均值</th><th>ICIR</th>
        <th>有效天数</th><th>权重系数</th><th class="l">系统动作</th></tr></thead>
      <tbody>${factorHTML}</tbody></table></div>
    <div class="note">${esc((d.factor_health || {}).note || "")}</div>
    ${ov.applied ? `<div class="note">⚠️ 本轮打分**已使用自动调整的维度权重**：${
      esc(JSON.stringify(ov.dimensions || {}))}（依据：${esc((ov.reasons || []).join("；"))}）</div>`
      : `<div class="note">权重未被自动调整：${esc(ov.note || "样本不足或因子均正常")}</div>`}

    <div class="note" style="margin-top:12px">抓取自愈账本（这轮哪里没拿到、补回了多少）</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">步骤</th><th>状态</th><th>耗时(s)</th><th class="l">说明</th></tr></thead>
      <tbody>${((d.collect_steps || [])).map((s) => `<tr>
        <td class="l">${esc(s.name || "")}</td>
        <td>${s.ok ? '<span class="up">成功</span>' : '<span class="down">失败</span>'}</td>
        <td>${num(s.seconds, 1)}</td><td class="l muted">${esc(s.note || "")}</td></tr>`).join("")
        || '<tr><td class="l muted">账本数据缺失（本轮的 health.json 没读到）</td></tr>'}</tbody>
    </table></div>
    ${ch.steps_failed_names && ch.steps_failed_names.length
      ? `<div class="note">本轮失败步骤：${esc(ch.steps_failed_names.join("、"))}</div>` : ""}
    ${adv.active ? `<div class="note">⚠️ 建议动作统一降级为「${esc(adv.label)}」：${esc(adv.why)}</div>` : ""}

    <!-- 口径提示 / 数据来源 / 免责声明：从主界面搬到这里（用户要求"不要放在主界面"） -->
    <div class="metabox">
      <div class="mb-title">口径与数据来源</div>
      <div class="note">${sysInfo.notice || NOTICE_TEXT}</div>
      ${sysInfo.snapshotTip
        ? `<div class="note" style="margin-top:6px">时点：${sysInfo.snapshotTip}</div>` : ""}
      <div class="note" style="margin-top:6px">${sysInfo.sourcesHTML
        || "数据来源尚未加载（version.json 未读到）"}</div>
      <div class="note" style="margin-top:6px">${esc(sysInfo.disclaimer
        || "本工具仅供个人复盘研究，不构成投资建议。")}</div>
    </div>
    </div>`;

  // 点推荐明细里的任意一行 → 直接看那只个股（和「选股评分」点行是同一套委托写法）
  box.addEventListener("click", (e) => {
    const tr = e.target.closest ? e.target.closest("tr[data-stock]") : null;
    if (!tr || !tr.dataset.stock) return;
    const card = panelOf(tr);
    openStock(tr.dataset.stock, card ? card.dataset.slot : undefined, true);
  });
}

async function fillDragon(box) {  const d = await api("dragon");
  const seats = d.seats || {};
  const rows = (d.rows || []).slice(0, 30).map((r) => {
    const s = seats[r.code] || {};
    const fmt = (arr) => (arr || []).slice(0, 5).map((x) =>
      `<div class="kv"><span class="k">${esc((x.dept || "").slice(0, 14))}</span>
       <span class="v num ${cls(x.net)}">${money(wan(x.net))}</span></div>`).join("");
    return `<tr>
      <td class="l">${esc(r.code)} ${esc(r.name)}</td>
      <td class="${cls(r.change_pct)}">${pctTxt(r.change_pct)}</td>
      <td class="${cls(r.net_amt)}">${money(wan(r.net_amt))}</td>
      <td>${r.d1 === null || r.d1 === undefined ? "—" : pctTxt(r.d1)}</td>
      <td>${r.d5 === null || r.d5 === undefined ? "—" : pctTxt(r.d5)}</td>
      <td class="l">${esc((r.reason || "").slice(0, 18))}</td>
      <td class="l">${s.buy ? fmt(s.buy) : '<span class="muted">—</span>'}</td>
      <td class="l">${s.sell ? fmt(s.sell) : '<span class="muted">—</span>'}</td></tr>`;
  }).join("");
  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "上榜个股", v: (d.rows || []).length },
      { k: "席位明细", v: Object.keys(seats).length },
      { k: "榜单日期", v: esc(d.trade_date || "—") },
    ])}
    <div class="note">买一/卖一席位按金额排序取前 5；「净额」为席位买入−卖出。同花顺官方不提供席位明细，此表来自东方财富公开报表。</div>
    <div class="table-wrap"><table>
      <thead><tr><th class="l">股票</th><th>涨跌幅</th><th>榜单净额</th><th>次日</th><th>5日</th>
        <th class="l">上榜原因</th><th class="l">买入席位 Top5</th><th class="l">卖出席位 Top5</th></tr></thead>
      <tbody>${rows || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table></div>`;
}

async function fillResearch(box) {
  const d = await api("research");
  const ratings = Object.entries(d.ratings || {})
    .sort((a, b) => (b[1].org_num || 0) - (a[1].org_num || 0));
  const ratingRows = ratings.slice(0, 20).map(([code, r]) => `<tr>
      <td class="l">${esc(code)} ${esc(r.name || "")}</td>
      <td class="l">${esc(r.industry || "—")}</td>
      <td>${stanceTag(r.stance)}</td>
      <td>${r.org_num ?? 0}</td><td class="up">${r.bull ?? 0}</td>
      <td class="down">${r.bear ?? 0}</td><td>${r.neutral ?? 0}</td></tr>`).join("");
  const reportRows = (d.reports_stock || []).slice(0, 25).map((r) => `<tr>
      <td>${esc(r.date || "")}</td><td class="l">${esc(r.code)} ${esc(r.name || "")}</td>
      <td class="l">${esc(r.org || "")}</td><td>${stanceTag(r.stance)}</td>
      <td class="l">${esc((r.title || "").slice(0, 34))}</td>
      <td>${r.target_high ? num(r.target_high) : "—"}</td></tr>`).join("");
  const surveyRows = (d.survey || []).slice(0, 25).map((s) => `<tr>
      <td>${esc(s.date || "")}</td><td class="l">${esc(s.code)} ${esc(s.name || "")}</td>
      <td class="l">${esc((s.orgs || "").slice(0, 22))}</td>
      <td>${esc(s.way || "—")}</td><td>${s.org_num ?? "—"}</td>
      <td>${esc(s.attention || "—")}</td></tr>`).join("");
  box.innerHTML = `
    ${summaryHTML(null, [
      { k: "调研记录", v: d.survey_total ?? 0 },
      { k: "个股研报", v: (d.reports_stock || []).length },
      { k: "评级汇总", v: ratings.length },
      { k: "行业研报", v: (d.reports_industry || []).length },
    ])}
    <div class="note">${esc(d.stance_note || "")}</div>
    <div class="note">① 评级汇总（看多 = 买入 + 增持；看空 = 减持 + 卖出）</div>
    <table><thead><tr><th class="l">股票</th><th class="l">行业</th><th>态度</th><th>机构数</th>
      <th>看多</th><th>看空</th><th>中性</th></tr></thead>
      <tbody>${ratingRows || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table>
    <div class="note" style="margin-top:14px">② 最新个股研报（含评级与目标价）</div>
    <div class="table-wrap"><table><thead><tr><th>日期</th><th class="l">股票</th><th class="l">券商</th>
      <th>评级</th><th class="l">标题</th><th>目标价</th></tr></thead>
      <tbody>${reportRows || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table></div>
    <div class="note" style="margin-top:14px">③ 机构调研（只有关注度，没有多空方向）</div>
    <div class="table-wrap"><table><thead><tr><th>接待日</th><th class="l">股票</th>
      <th class="l">调研机构</th><th>方式</th><th>机构家数</th><th>关注度</th></tr></thead>
      <tbody>${surveyRows || '<tr><td class="l muted">无数据</td></tr>'}</tbody></table></div>`;
}

async function fillIndex(box) {
  const d = await api("index_kline");
  const codes = Object.keys(d || {});
  if (!codes.length) { box.innerHTML = `<div class="state">没有大盘 K 线数据</div>`; return; }
  if (!codes.includes(state.index)) state.index = codes[0];
  const cur = d[state.index] || {};
  const kl = cur.kline || {};
  const tabs = codes.map((c) => `<button class="btn btn-mini ${c === state.index ? "on" : ""}"
      data-idx="${c}">${esc((d[c] || {}).name || c)}</button>`).join("");
  box.innerHTML = `
    <div class="tabs">${tabs}</div>
    <div class="kinfo"></div>
    <div class="tabs">
      <button class="btn btn-mini on" data-k="ind" data-v="MACD" id="idxMACD">MACD</button>
      <button class="btn btn-mini" data-k="ind" data-v="KDJ" id="idxKDJ">KDJ</button>
      <button class="btn btn-mini" data-k="ind" data-v="RSI" id="idxRSI">RSI</button>
      <button class="btn btn-mini" data-k="ind" data-v="NONE" id="idxNONE">只看K线</button>
      <button class="btn btn-mini on" data-k="bars" data-v="60" id="idxB60">60根</button>
      <button class="btn btn-mini" data-k="bars" data-v="120" id="idxB120">120根</button>
    </div>
    <div class="chart-wrap"><div class="ktip"></div><canvas class="kc tall" id="kIndex"></canvas>
      <div class="kempty" style="display:none">该指数没有 K 线数据</div></div>
    <div class="legend">
      <span><i style="background:${KC.ma5}"></i>MA5</span>
      <span><i style="background:${KC.ma10}"></i>MA10</span>
      <span><i style="background:${KC.ma20}"></i>MA20</span>
      <span><i style="background:${KC.ma60}"></i>MA60</span>
      <span><i style="background:${KC.boll}"></i>BOLL(20,2)</span>
      <span>红涨绿跌</span></div>
    <div class="note">按住图表左右滑动可查看任意一天的 OHLC 与指标值。</div>`;
  box.querySelectorAll("[data-idx]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      state.index = b.dataset.idx;
      fillIndex(box);
    }));
  const wire = (id, key, val) => {
    const el = box.querySelector(id);
    if (el) el.addEventListener("click", (e) => { e.stopPropagation(); klineSet("kIndex", key, val); });
  };
  wire("#idxMACD", "ind", "MACD"); wire("#idxKDJ", "ind", "KDJ");
  wire("#idxRSI", "ind", "RSI"); wire("#idxNONE", "ind", "NONE");
  wire("#idxB60", "bars", 60); wire("#idxB120", "bars", 120);
  mountKline(document.getElementById("kIndex"), kl, { info: ".kinfo", bars: 60, ind: "MACD" });
}

/** 筹码峰 HTML（按用户最终要求）
 *   · **连续画，不拆开**：整幅图是一条连续的筹码分布，中间**不插分隔块**（拆开影响美感）
 *   · 颜色只表示位置：现价**以上=蓝色**（套牢盘）、现价**以下=红色**（获利盘）
 *   · 柱长按占比等比缩放
 *   · 现价（黄线）与平均筹码（紫线）用**叠加线**标注，落在图上，不打断分布
 *   · 每行带 data-price / data-share，供鼠标白色横线定位与显示价格
 *
 *  ⚠️ 这里用 **class 而不是 id**：页面固定有三个界面，可能同时显示
 *     "个股分析"和"板块分析"两块筹码峰。用 id 的话 getElementById 只能拿到第一块，
 *     另一块的黄线/紫线/悬停就会全部失效（以前只有一个面板时不会暴露这个问题）。
 */
function chipRowsHTML(rows, curPrice) {
  const list = (rows || []).slice().reverse();      // 价格从高到低
  if (!list.length) return "";
  const maxShare = Math.max(...list.map((x) => x.share || 0), 0.01);
  const cur = Number(curPrice) || 0;
  return list.map((x) => {
    const trapped = cur > 0 && x.price > cur;
    const w = Math.max(1, (x.share / maxShare) * 100);
    return `<div class="chip-row ${trapped ? "trapped" : "profit"}"
        data-price="${x.price}" data-share="${x.share}">
      <span class="p">${num(x.price)}</span>
      <span class="b"><i style="width:${w}%"></i></span>
      <span class="m">${num(x.share, 1)}%</span></div>`;
  }).join("");
}

/* ---------------- 筹码估算（前端版，口径与后端 scripts/chips.py 完全一致） ----------------
   为什么前端也要有一份：搜索任意个股时用的是**浏览器实时抓的 K 线**，没有后端算好的筹码；
   如果两边口径不一致，"存档快照"和"实时抓取"的获利盘会互相打架（同一只股票两个数）。
   所以这里严格照搬后端：60 个价格分箱、每根 K 线采样 40 个三角分布分位点、
   半衰期 120 个交易日、回看 250 个交易日、现价以下=获利盘 / 以上=套牢盘。 */
const CHIP_BINS = 60, CHIP_HALF_LIFE = 120, CHIP_SAMPLES = 40, CHIP_LOOKBACK = 250;
const CHIP_NOTE = "估算值：按「当日成交量在最低~最高价之间呈三角分布、峰值取(高+低+收)/3、"
  + "半衰期 120 个交易日衰减」的模型推算；现价以下计为获利盘、以上计为套牢盘。"
  + "官方筹码分布数据不存在，本值不可当作官方数据，也不宜跨股票比较。";

/** 三角分布（峰值 peak）在 [low, high] 上的 n 个分位点 */
function _triSamples(low, high, peak, n) {
  if (high <= low) return new Array(n).fill(low);
  const p = Math.min(Math.max(peak, low), high);
  let left = (p - low) / (high - low);
  left = Math.min(Math.max(left, 1e-6), 1 - 1e-6);
  const out = [];
  for (let i = 0; i < n; i++) {
    const u = (i + 0.5) / n;
    out.push(u < left ? low + Math.sqrt(u * left) * (p - low)
                      : high - Math.sqrt((1 - u) * (1 - left)) * (high - p));
  }
  return out;
}

function _smooth(values, window = 3) {
  if (values.length < window) return values.slice();
  const half = window >> 1;
  return values.map((_, i) => {
    const seg = values.slice(Math.max(0, i - half), i + half + 1);
    return seg.reduce((s, x) => s + x, 0) / seg.length;
  });
}

/** 平滑后找局部极大/极小（过滤掉占比过小的噪声峰） */
function _peaksValleys(centers, weights, price, window = 3, minShare = 0.015) {
  if (weights.length < window * 2 + 1) return { peaks: [], valleys: [] };
  const sm = _smooth(weights, window);
  const peaks = [], valleys = [];
  for (let i = 1; i < sm.length - 1; i++) {
    const r2 = (x) => Math.round(x * 100) / 100;
    if (sm[i] >= sm[i - 1] && sm[i] > sm[i + 1] && sm[i] >= minShare) {
      peaks.push({ price: r2(centers[i]), share: r2(sm[i] * 100), above_current: centers[i] > price });
    } else if (sm[i] <= sm[i - 1] && sm[i] < sm[i + 1]) {
      valleys.push({ price: r2(centers[i]), share: r2(sm[i] * 100) });
    }
  }
  peaks.sort((a, b) => b.share - a.share);
  return { peaks: peaks.slice(0, 4), valleys: valleys.slice(0, 4) };
}

/** 占比约 target 的最窄价格带（从权重最高的分箱往两侧扩展） */
function _topBand(centers, weights, target = 0.10) {
  if (!weights.length) return {};
  const order = weights.map((w, i) => i).sort((a, b) => weights[b] - weights[a]);
  const chosen = [];
  let acc = 0;
  for (const i of order) {
    chosen.push(i); acc += weights[i];
    if (acc >= target) break;
  }
  chosen.sort((a, b) => a - b);
  const r2 = (x) => Math.round(x * 100) / 100;
  return { low: r2(centers[chosen[0]]), high: r2(centers[chosen[chosen.length - 1]]),
           share: r2(acc * 100) };
}

/** 由 K 线估算筹码分布（结构与后端 chip 字段一一对应） */
function chipFromKline(kl, price) {
  const empty = { profit_ratio_pct: null, trapped_ratio_pct: null, avg_cost: null, hhi: null,
                  top10_band: {}, peaks: [], valleys: [], shape: "数据缺失", rows: [],
                  note: CHIP_NOTE };
  if (!kl || !kl.dates || !kl.dates.length) return empty;
  const total = kl.dates.length;
  const bars = [];
  for (let i = Math.max(0, total - CHIP_LOOKBACK); i < total; i++) {
    const l = Number(kl.low[i]), h = Number(kl.high[i]);
    if (!l || !h) continue;
    bars.push({ low: l, high: h, close: Number(kl.close[i]) || (l + h) / 2,
                volume: Number(kl.volume[i]) || 0 });
  }
  if (!bars.length) return empty;
  const lo = Math.min(...bars.map((b) => b.low));
  let hi = Math.max(...bars.map((b) => b.high));
  if (hi <= lo) hi = lo + 0.01;
  const width = (hi - lo) / CHIP_BINS;
  const weights = new Array(CHIP_BINS).fill(0);
  bars.forEach((b, idx) => {
    const vol = b.volume;
    if (vol <= 0) return;
    const decay = Math.pow(0.5, (bars.length - 1 - idx) / CHIP_HALF_LIFE);
    const peak = (b.high + b.low + b.close) / 3;
    const w = vol * decay / CHIP_SAMPLES;
    _triSamples(b.low, b.high, peak, CHIP_SAMPLES).forEach((p) => {
      let i = Math.floor((p - lo) / width);
      if (i < 0) i = 0; else if (i >= CHIP_BINS) i = CHIP_BINS - 1;
      weights[i] += w;
    });
  });
  const sum = weights.reduce((s, w) => s + w, 0);
  if (!(sum > 0)) return empty;
  const norm = weights.map((w) => w / sum);
  const centers = norm.map((_, i) => lo + width * (i + 0.5));
  // 现价兜底：用**最后一根 K 线的收盘价**——绝不能拿 centers 的最高档当现价，
  // 否则获利盘会被算成接近 100%（看起来"人人都在赚钱"）而且不报错。
  const cur = Number(price) || Number(kl.close[total - 1]) || centers[centers.length - 1];
  const below = centers.reduce((s, c, i) => s + (c <= cur ? norm[i] : 0), 0);
  const avgCost = centers.reduce((s, c, i) => s + c * norm[i], 0);
  const hhi = norm.reduce((s, w) => s + w * w, 0);
  const { peaks, valleys } = _peaksValleys(centers, norm, cur);
  let shape;
  if (!peaks.length) shape = hhi > 0.05 ? "单峰密集" : "分布平坦";
  else if (peaks.length === 1) shape = peaks[0].share >= 6 ? "单峰密集" : "单峰偏弱";
  else if (peaks.length === 2) shape = "双峰（上下各一密集区）";
  else shape = `多峰分散（${peaks.length} 个峰）`;
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    profit_ratio_pct: r2(below * 100), trapped_ratio_pct: r2((1 - below) * 100),
    avg_cost: r2(avgCost), hhi: Math.round(hhi * 1e5) / 1e5,
    top10_band: _topBand(centers, norm), peaks, valleys, shape,
    rows: centers.map((c, i) => ({ price: r2(c), share: r2(norm[i] * 100) })),
    note: CHIP_NOTE,
  };
}

/** 平均筹码（价格加权平均成本），并给出上方/下方各自的平均 */function avgChipCost(rows, curPrice) {
  const list = rows || [];
  const total = list.reduce((s, x) => s + (x.share || 0), 0);
  if (!total) return { all: null, above: null, below: null };
  const cur = Number(curPrice) || 0;
  const w = (arr) => {
    const t = arr.reduce((s, x) => s + (x.share || 0), 0);
    return t ? arr.reduce((s, x) => s + x.price * (x.share || 0), 0) / t : null;
  };
  return {
    all: list.reduce((s, x) => s + x.price * (x.share || 0), 0) / total,
    above: w(list.filter((x) => x.price > cur)),
    below: w(list.filter((x) => x.price <= cur)),
  };
}

/** 把"现价黄线 / 平均筹码紫线"定位到筹码峰上（按价格在图中的比例）
 *  全部选择器都**限定在 box 内部**：三个界面可能同时有两块筹码峰，
 *  用 getElementById 会永远只拿到第一块（另一块的线就不会出现）。 */
function positionChipLines(box, rows, cur, avgPrice) {
  const wrap = box.querySelector(".chips-wrap");
  if (!wrap || !rows || !rows.length) return;
  const prices = rows.map((x) => x.price);
  const hi = Math.max(...prices), lo = Math.min(...prices);
  const rowsEl = wrap.querySelectorAll(".chip-row");
  if (!rowsEl.length) return;
  const top0 = rowsEl[0].offsetTop;
  const last = rowsEl[rowsEl.length - 1];
  const height = (last.offsetTop + last.offsetHeight) - top0;
  const put = (el, price) => {
    if (!el || price === null || price === undefined || hi === lo) return;
    const frac = (hi - price) / (hi - lo);
    const y = top0 + Math.max(0, Math.min(1, frac)) * height;
    el.style.top = y + "px";
    el.classList.add("show");
  };
  const nowLine = wrap.querySelector(".chip-line.now");
  const avgLine = wrap.querySelector(".chip-line.avg");
  if (nowLine) nowLine.querySelector("span").textContent = `现价 ${num(cur)}`;
  if (avgLine) avgLine.querySelector("span").textContent = `平均筹码 ${num(avgPrice)}`;
  put(nowLine, cur);
  put(avgLine, avgPrice);
}

/** 筹码峰悬停：白色横线跟随鼠标 + 右上角浮出该价位的筹码价格/占比（不做行高亮） */
function wireChipHover(box) {
  const wrap = box.querySelector(".chips-wrap");
  const tip = wrap ? wrap.querySelector(".chip-tip") : null;
  const hline = wrap ? wrap.querySelector(".chip-hline") : null;
  if (!wrap || !tip || !hline) return;
  const rows = Array.from(wrap.querySelectorAll(".chip-row"));
  if (!rows.length) return;
  const show = (row, clientY) => {
    const price = row.dataset.price, share = row.dataset.share;
    const cur = Number(state.stockPrice) || 0;
    const diff = cur ? ((Number(price) / cur - 1) * 100) : null;
    tip.innerHTML = `<b>${num(price)}</b> 元 · 筹码 <b>${num(share, 2)}%</b>`
      + (diff === null ? "" : ` · 距现价 ${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%`);
    tip.classList.add("show");
    // 白线定位到该行中心
    const wr = wrap.getBoundingClientRect();
    const rr = row.getBoundingClientRect();
    hline.style.top = (rr.top - wr.top + rr.height / 2) + "px";
    hline.classList.add("show");
    void clientY;
  };
  const hide = () => {
    tip.classList.remove("show");
    hline.classList.remove("show");
  };
  wrap.addEventListener("mousemove", (e) => {
    const el = e.target.closest ? e.target.closest(".chip-row") : null;
    if (el) show(el, e.clientY);
    else hide();
  });
  wrap.addEventListener("mouseleave", hide);
  wrap.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (!t) return;
    const el = document.elementFromPoint(t.clientX, t.clientY);
    const row = el && el.closest ? el.closest(".chip-row") : null;
    if (row) show(row, t.clientY);
  }, { passive: true });
  wrap.addEventListener("touchend", hide);
}

/* ============================================================
   股票搜索 → 评分 + 基本面 + 技术面 + 多空建议
   （搜索范围 = 通过基础过滤的全部 A 股；技术面只有当日精算过的股票才有）
   ============================================================ */
function setupSearch() {
  const input = $("#searchInput");
  const res = $("#searchRes");
  if (!input || !res) return;
  let timer = null;

  const close = () => { res.classList.remove("show"); res.innerHTML = ""; };

  /** 空查询时直接列出**今日评分榜**（用户反馈"搜索框和评分没列出来"就是缺这个） */
  const showRanking = async () => {
    let uni;
    try { uni = await api("universe"); }
    catch (e) {
      res.innerHTML = `<div class="it"><span class="c">可搜索库加载失败：${esc(e.message)}</span></div>`;
      res.classList.add("show");
      return;
    }
    const top = (uni.rows || []).filter((r) => r.has_tech).slice(0, 12);
    res.innerHTML = `<div class="it" style="cursor:default;color:#6f6f78;font-size:11.5px">
        今日评分榜（前 ${top.length} 名，共 ${uni.scored_count} 只精算 / 可搜 ${uni.count} 只）</div>`
      + top.map((r) => `<div class="it" data-code="${esc(r.code)}">
          <span class="c">${esc(r.code)}</span><span>${esc(r.name)}</span>
          <span class="s ${r.advice_tone === "up" ? "up" : (r.advice_tone === "down" ? "down" : "flat")}">
            ${num(r.score, 1)} 分 · ${esc(r.advice)}</span></div>`).join("");
    res.classList.add("show");
    bindItems(res);
  };

  const bindItems = (el) => {
    el.querySelectorAll(".it[data-code]").forEach((it) =>
      it.addEventListener("click", () => {
        close();
        openResearch(it.dataset.code);
      }));
  };

  const doSearch = async () => {
    const q = (input.value || "").trim();
    if (!q) { showRanking(); return; }
    let uni;
    try { uni = await api("universe"); }
    catch (e) { res.innerHTML = `<div class="it">可搜索库加载失败：${esc(e.message)}</div>`;
                res.classList.add("show"); return; }
    const rows = uni.rows || [];
    const ql = q.toLowerCase();
    const hits = rows.filter((r) => r.code.startsWith(q) || (r.name || "").includes(q)
      || (r.name || "").toLowerCase().includes(ql)).slice(0, 10);
    // 场外基金也一起搜（用户要求"加场外ETF"，那它至少要能被搜到）
    let fundHits = [];
    try {
      const fd = await api("funds");
      fundHits = (fd.universe || [])
        .filter((x) => (x.code || "").startsWith(q) || (x.name || "").includes(q)
          || (x.pinyin || "").toLowerCase().startsWith(ql))
        .slice(0, 6);
    } catch (e) { fundHits = []; }
    const html = hits.map((r) => `<div class="it" data-code="${esc(r.code)}">
        <span class="c">${esc(r.code)}</span><span>${esc(r.name)}</span>
        <span class="s ${r.advice_tone === "up" ? "up" : (r.advice_tone === "down" ? "down" : "flat")}">
          ${r.score === null || r.score === undefined
            ? `快评 ${num(r.score_light, 1)}` : `${num(r.score, 1)} 分`} · ${esc(r.advice)}</span></div>`).join("")
      + fundHits.map((x) => `<div class="it" data-fund="${esc(x.code)}">
        <span class="c">${esc(x.code)}</span><span>${esc(x.name)}</span>
        <span class="s muted">场外基金 · ${esc(x.type || "")}</span></div>`).join("");
    if (!html) {
      res.innerHTML = `<div class="it"><span class="c">没找到「${esc(q)}」</span>
        <span class="s muted">股票库 ${rows.length} 只（全市场）+ 场外基金库</span></div>`;
      res.classList.add("show");
      return;
    }
    res.innerHTML = html;
    res.classList.add("show");
    bindItems(res);
    // 基金命中：点一下把"场外ETF"面板放进当前界面并高亮该基金
    res.querySelectorAll(".it[data-fund]").forEach((it) =>
      it.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        state.fundFilter = { q: it.dataset.fund, onlyEtf: false, sort: "chg_1y" };
        assignSlot(state.activeSlot, "funds");
      }));
  };

  input.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(doSearch, 180);
  });
  // 聚焦即展开：有内容就搜、没内容就显示今日评分榜（评分直接可见）
  input.addEventListener("focus", () => { input.value.trim() ? doSearch() : showRanking(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const first = res.querySelector(".it[data-code]");
      if (first) { close(); openResearch(first.dataset.code); }
    } else if (e.key === "Escape") { close(); }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest || !e.target.closest(".search")) close();
  });
}

/**
 * 分析页（搜索出来的个股）
 *
 * 修过的问题（用户反馈"搜出来的个股只有基本面，看不到 K 线/指标"）：
 *   ① 原来只有 `has_detail` 的股票才有 K 线——而存档只有当日精算的那一批，
 *      搜别的一律"只有基本面"。现在没有存档就**用浏览器实时抓腾讯日线**（允许跨域，已实测），
 *      K 线 + 均线 + MACD/KDJ/RSI/BOLL + 成交量全部照画，指标仍在前端本地算。
 *   ② 原来末尾写了 `positionChipLines(box, rows, cur, avg.all)`，但这三个变量在本函数里
 *      **根本不存在**（是从 fillStock 复制过来的），一执行就 ReferenceError →
 *      筹码峰永远画不出来、控制台还看不到报错。现在变量在本函数内正确计算。
 *   ③ 原来分析页压根没渲染筹码直方图（只有文字数字）。现在补齐，与个股详情页一致。
 */
/**
 * 个股页的「基本面明细 + 近几年盈利状况」两块 HTML。
 *
 * 用户要求（原话）："个股的市盈率、换手率、量比、流通市值都没有给我列出来，
 * 最好能列出来近几年的盈利状况"。
 *
 * 数据来源：
 *   · d.basic      —— 存档详情里的当天快照（PE/PB/PS/总市值/流通市值/换手/量比/ROE/增速/毛利/负债）
 *   · d.fin_history—— 近几年财务（每股收益/营收/净利/ROE/同比/毛利率，按报告期）
 *   · row          —— 搜索路径下没有详情文件时，退回可搜索库那一行（字段少一些，有就显示）
 *
 * ⚠️ 只在**一个**函数里写死作用域：两个渲染函数都调它，参数由调用方兜底传入，
 *    避免"复制一段 HTML 到另一个函数里、结果引用了不存在的变量"这类事故
 *    （上一轮就是这么把个股页搞成「加载失败」的）。
 * ⚠️ 市占率没有任何免费数据源 → 明确写"数据缺失"，不编数字。
 */
function stockBasicsHTML(d, row) {
  const dd = d || {};
  const rr = row || {};
  const pick = (a, b) => (a === null || a === undefined ? b : a);
  const yi = (v) => (v === null || v === undefined ? null : Math.round(v / 1e8 * 100) / 100);
  const b = Object.assign({
    pe: rr.pe, pe_ttm: rr.pe_ttm, pb: rr.pb, ps: rr.ps,
    market_cap_yi: yi(rr.market_cap), float_cap_yi: yi(rr.float_cap),
    turnover: rr.turnover, volume_ratio: rr.volume_ratio,
    roe: rr.roe, rev_yoy: rr.rev_yoy, np_yoy: rr.np_yoy,
    gross: rr.gross, debt: rr.debt,
    amount_yi: yi(rr.amount), main_net_yi: yi(rr.main_net),
  }, dd.basic || {});
  const fin = dd.fin_history || [];
  // 规则化点评（每天由 Actions 生成，前端只读文字；见 scripts/commentary.py）
  const cm = dd.commentary || null;
  const cmHTML = (cm && cm.text) ? `
    <div class="card cmtcard"><h3>点评 <span class="sub">规则化生成 · 无大模型 · 每天 16/18/20 点各更新一次</span></h3>
      <div class="cmttext">${esc(cm.text)}</div>
      ${cm.parts ? `<div class="cmtparts">
        <div><b>过去</b>${esc(cm.parts.past || "")}</div>
        <div><b>现在</b>${esc(cm.parts.now || "")}</div>
        <div><b>往后</b>${esc(cm.parts.future || "")}</div>
      </div>` : ""}
      <div class="note">${esc(cm.sources_note || "")}</div>
    </div>` : `
    <div class="card"><div class="note">点评：<b>本轮未生成</b>
      （只给当日评分最高的前 10 只写点评；该股不在其中，或本轮点评数据未取到）—— 不编造。</div></div>`;
  const mv = (v, unit) => (v === null || v === undefined || v === ""
    ? '<span class="muted">数据缺失</span>' : num(v, 2) + (unit || ""));
  return `
    <div class="note" style="margin-top:12px">基本面明细（当日快照；市值单位：亿元）</div>
    <div class="grid2">
      <div>
        <div class="kv"><span class="k">市盈率 PE / PE(TTM)</span><span class="v">${mv(b.pe)} / ${mv(b.pe_ttm)}</span></div>
        <div class="kv"><span class="k">市净率 PB / 市销率 PS</span><span class="v">${mv(b.pb)} / ${mv(b.ps)}</span></div>
        <div class="kv"><span class="k">总市值 / 流通市值</span><span class="v">${mv(b.market_cap_yi, " 亿")} / ${mv(b.float_cap_yi, " 亿")}</span></div>
        <div class="kv"><span class="k">换手率 / 量比</span><span class="v">${mv(b.turnover, " %")} / ${mv(b.volume_ratio)}</span></div>
      </div>
      <div>
        <div class="kv"><span class="k">ROE（加权）</span><span class="v">${mv(b.roe, " %")}</span></div>
        <div class="kv"><span class="k">营收同比 / 净利同比</span><span class="v">${mv(b.rev_yoy, " %")} / ${mv(b.np_yoy, " %")}</span></div>
        <div class="kv"><span class="k">毛利率 / 资产负债率</span><span class="v">${mv(b.gross, " %")} / ${mv(b.debt, " %")}</span></div>
        <div class="kv"><span class="k">成交额 / 主力净额</span><span class="v">${mv(b.amount_yi, " 亿")} / ${mv(b.main_net_yi, " 亿")}</span></div>
      </div>
    </div>
    ${cmHTML}
    <div class="note">市占率（营收占行业比例）：<b>数据缺失</b> —— ${esc(dd.market_share_note
      || "没有任何免费数据源提供这个口径，本工具不估算。")}</div>
    ${fin.length ? `
      <div class="note" style="margin-top:12px">近几年盈利状况（按报告期，来源：东财公开报表，原样展示不做预测）</div>
      <div class="table-wrap"><table>
        <thead><tr><th class="l">报告期</th><th>每股收益</th><th>营收(亿)</th><th>净利润(亿)</th>
          <th>ROE%</th><th>营收同比</th><th>净利同比</th><th>毛利率%</th></tr></thead>
        <tbody>${fin.map((x) => `<tr>
          <td class="l">${esc(x.date || "")}</td>
          <td>${mv(x.eps)}</td><td>${mv(x.revenue === null || x.revenue === undefined ? null : x.revenue / 1e8, "")}</td>
          <td>${mv(x.net_profit === null || x.net_profit === undefined ? null : x.net_profit / 1e8, "")}</td>
          <td>${mv(x.roe, "")}</td>
          <td class="${cls(x.rev_yoy)}">${pctTxt(x.rev_yoy, 1)}</td>
          <td class="${cls(x.np_yoy)}">${pctTxt(x.np_yoy, 1)}</td>
          <td>${mv(x.gross, "")}</td></tr>`).join("")}</tbody>
      </table></div>
      <div class="note">同一列里既有一季报也有年报（报告期不同，不可直接横向比）。</div>`
      : '<div class="note" style="margin-top:8px">近几年盈利状况：<b>本轮未取到</b>（财务接口限流，或该股不在前 120 只里）—— 不编造。</div>'}`;
}

async function fillResearchOne(box) {
  const code = state.researchCode;
  if (!code) { box.innerHTML = `<div class="state">在上方搜索框输入代码或名称，选一只股票。</div>`; return; }
  const uni = await api("universe");
  const row = (uni.rows || []).find((r) => r.code === code);
  if (!row) {
    box.innerHTML = `<div class="state err">可搜索库里没有 ${esc(code)}
      （范围：**全部 A 股**，含 ST/高价/各板块；数据是当日快照，刚上市或长期停牌的除外）</div>`;
    return;
  }

  // ---------- 1. 优先用当日存档快照 ----------
  let detail = null;
  if (row.has_detail) {
    try {
      // 个股详情：去掉时间戳与 no-store，并加内存缓存 ——
    // 同一次会话里反复点开同一只股票只联网一次（用户要求"刷新成本几乎为零"）
    const ck = "stock:" + code;
    let r = null;
    if (!CACHE[ck]) {
      r = await fetch(DATA + "stock/" + code + ".json", { cache: "default" });
      if (r.ok) CACHE[ck] = await r.json();
    }
      if (r.ok) detail = await r.json();
    } catch (e) { detail = null; }
  }

  // ---------- 2. 没有存档就用浏览器实时抓日线（这是"搜任意个股都能看 K 线"的关键） ----------
  let live = null, liveErr = "";
  if (!detail) {
    try {
      live = await liveKline(code, 260);
    } catch (e) { liveErr = e.message || String(e); }
  }
  const kl = (detail && detail.kline) || live || null;
  const isLive = !detail && !!live;
  const chip = (detail && detail.chip) || (kl ? chipFromKline(kl, row.price) : {});

  const adv = detail ? (detail.advice || {}) : {};
  const sc = detail ? (detail.score || {}) : { score: row.score, parts: row.score_parts };
  const fund = detail ? (detail.fund || {}) : { score: row.fund_score, parts: row.fund_parts };
  const trend = (detail && detail.trend) || {};
  const inst = (detail && detail.inst) || {};
  const adviceLabel = adv.label || row.advice;
  const tone = adv.tone || row.advice_tone || "flat";
  const toneCls = tone === "up" ? "up" : (tone === "down" ? "down" : "flat");
  const partsHTML = Object.entries(sc.parts || {}).map(([k, v]) =>
    `<div class="kv"><span class="k">${esc(k)}</span>
      <span class="v ${v < 0 ? "down" : ""}">${num(v, 1)}</span></div>`).join("");
  const fundHTML = Object.entries(fund.parts || {}).map(([k, v]) =>
    `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${num(v, 1)}</span></div>`).join("");
  const pros = (adv.pros || []).map((x) => `<div class="kv"><span class="k">利多</span>
      <span class="v up" style="text-align:left">${esc(x)}</span></div>`).join("");
  const cons = (adv.cons || []).map((x) => `<div class="kv"><span class="k">利空</span>
      <span class="v down" style="text-align:left">${esc(x)}</span></div>`).join("");

  // ---------- 3. 筹码直方图（与个股详情页同一套渲染） ----------
  state.stockPrice = Number((kl && kl.close && kl.close[kl.close.length - 1]) || row.price) || 0;
  const chipRows = chip.rows || [];
  const cur = state.stockPrice;
  const bars = chipRowsHTML(chipRows, cur);
  const avg = avgChipCost(chipRows, cur);
  const lastBar = kl ? {
    date: kl.dates[kl.dates.length - 1],
    close: kl.close[kl.close.length - 1],
    high: kl.high[kl.high.length - 1],
    low: kl.low[kl.low.length - 1],
    volume: kl.volume[kl.volume.length - 1],
  } : null;

  const dataNote = detail
    ? `<span class="muted">数据来源：当日存档快照（Actions 生成）</span>`
    : (live
      ? `<span class="muted">K 线与筹码：<b>本页由浏览器实时抓取</b>（腾讯行情 · 前复权 · ${kl.dates.length} 根），
          基本面来自当日快照。实时抓取的数据不随存档更新时间变化。</span>`
      : `<span class="err">拿不到 K 线：${esc(liveErr || "未知原因")}</span>`);

  box.innerHTML = `
    <div class="grid2">
      <div class="box"><div class="k">${esc(row.code)} ${esc(row.name)}</div>
        <div class="v">${num(row.price)}
          <span class="${cls(row.change_pct)}" style="font-size:13px">${pctTxt(row.change_pct)}</span></div></div>
      <div class="box"><div class="k">所属行业</div><div class="v" style="font-size:14px">${esc(row.industry || "—")}</div></div>
      <div class="box"><div class="k">量化倾向</div>
        <div class="v ${toneCls}" style="font-size:16px">${esc(adviceLabel)}</div></div>
      <div class="box"><div class="k">综合分 / 技术分 / 基本面分</div>
        <div class="v" style="font-size:14px">${num(adv.combined ?? row.score, 1)}
          <span class="muted">/ ${num(sc.score ?? row.score, 1)} / ${num(fund.score ?? row.fund_score, 1)}</span></div></div>
    </div>
    <div class="note" style="margin-top:8px">${dataNote}</div>
    ${detail ? "" : (live ? "" : `<div class="state" style="text-align:left;padding:10px 0">
      ⚠️ 这只股票<b>既不在当日精算范围内，也没能实时取到日线</b>，
      所以没有 K 线/均线/筹码的技术面分，上面的评分只用了
      <b>资金 + 基本面 + 市场情绪</b>三个可得维度。</div>`)}

    ${kl ? `
    <div class="kinfo" style="margin-top:10px"></div>
    <div class="tabs">
      ${["MACD", "KDJ", "RSI", "NONE"].map((k) =>
        `<button class="btn btn-mini ${k === "MACD" ? "on" : ""}" data-k="ind" data-v="${k}">${k === "NONE" ? "只看K线" : k}</button>`).join("")}
      ${[60, 120, 250].map((n) =>
        `<button class="btn btn-mini ${n === 60 ? "on" : ""}" data-k="bars" data-v="${n}">${n}根</button>`).join("")}
    </div>
    <div class="chart-wrap"><div class="ktip"></div><canvas class="kc" id="kOne"></canvas>
      <div class="kempty" style="display:none">没有该股 K 线数据</div></div>
    <div class="legend">
      <span><i style="background:${KC.ma5}"></i>MA5</span>
      <span><i style="background:${KC.ma10}"></i>MA10</span>
      <span><i style="background:${KC.ma20}"></i>MA20</span>
      <span><i style="background:${KC.ma60}"></i>MA60</span>
      <span><i style="background:${KC.boll}"></i>BOLL(20,2)</span>
      <span class="muted">鼠标移到图上：显示该日全部数据（开高低收/涨跌/振幅/量/均线 + 当前指标数值）</span>
    </div>` : ""}

    <div class="grid2" style="margin-top:12px">
      <div><div class="note">评分构成（技术32 资金24 筹码18 机构16 板块10 − 风险扣分）</div>
        ${partsHTML || '<div class="state">无</div>'}</div>
      <div><div class="note">基本面构成（ROE25 净利同比20 营收15 毛利15 PE15 PB5 负债5）</div>
        ${fundHTML || '<div class="state">无</div>'}</div>
    </div>
    <div class="grid2" style="margin-top:12px">
      <div><div class="note">财报口径</div>
        <div class="kv"><span class="k">市盈率(动) / 市净率</span><span class="v">${num(row.pe)} / ${num(row.pb)}</span></div>
        <div class="kv"><span class="k">ROE</span><span class="v">${num(row.roe, 1)}%</span></div>
        <div class="kv"><span class="k">营收同比 / 净利同比</span><span class="v">${pctTxt(row.rev_yoy, 1)} / ${pctTxt(row.np_yoy, 1)}</span></div>
        <div class="kv"><span class="k">毛利率 / 资产负债率</span><span class="v">${num(row.gross, 1)}% / ${num(row.debt, 1)}%</span></div>
      </div>
      <div><div class="note">今日资金</div>
        <div class="kv"><span class="k">主力净流入</span><span class="v ${cls(row.main_net)}">${money(wan(row.main_net))}</span></div>
        <div class="kv"><span class="k">主力净占比</span><span class="v">${num(row.main_net_pct, 2)}%</span></div>
        <div class="kv"><span class="k">换手率 / 成交额</span><span class="v">${num(row.turnover, 2)}% / ${money(yi(row.amount), false)}亿</span></div>
        ${lastBar ? `<div class="kv"><span class="k">最近交易日</span>
          <span class="v">${esc(lastBar.date)} 收 ${num(lastBar.close)} · 量 ${volTxt(lastBar.volume)}</span></div>` : ""}
      </div>
    </div>
    ${stockBasicsHTML((typeof d !== "undefined" ? d : null), (typeof row !== "undefined" ? row : null))}
    ${kl ? `
    <div class="grid2" style="margin-top:12px">
      <div><div class="note">技术面（由 K 线本地计算）</div>
        <div class="kv"><span class="k">MA5 / MA10 / MA20 / MA60</span><span class="v">${
          [5, 10, 20, 60].map((n) => num(kSma(kl.close, n)[kl.close.length - 1])).join(" / ")}</span></div>
        <div class="kv"><span class="k">RSI14</span><span class="v">${num(kRsi(kl.close)[kl.close.length - 1], 1)}</span></div>
        <div class="kv"><span class="k">MACD 柱 / KDJ J</span><span class="v">${
          num(kMacd(kl.close).bar[kl.close.length - 1], 3)} / ${
          num(kKdj(kl.high, kl.low, kl.close).j[kl.close.length - 1], 1)}</span></div>
        <div class="kv"><span class="k">BOLL 上/中/下</span><span class="v">${
          [kBoll(kl.close).up, kBoll(kl.close).mid, kBoll(kl.close).dn]
            .map((a) => num(a[kl.close.length - 1])).join(" / ")}</span></div>
        ${trend.volume_ratio !== undefined ? `<div class="kv"><span class="k">量比（对5日均量）</span>
          <span class="v">${num(trend.volume_ratio, 2)}</span></div>` : ""}
      </div>
      <div><div class="note">筹码（估算 · 非官方）</div>
        <div class="kv"><span class="k">形态</span><span class="v">${esc(chip.shape || "—")}</span></div>
        <div class="kv"><span class="k">获利盘 / 套牢盘</span><span class="v">${num(chip.profit_ratio_pct)}% / ${num(chip.trapped_ratio_pct)}%</span></div>
        <div class="kv"><span class="k">平均筹码成本</span><span class="v">${num(chip.avg_cost)}</span></div>
        <div class="kv"><span class="k">集中度 HHI</span><span class="v">${chip.hhi === null || chip.hhi === undefined ? "—" : Number(chip.hhi).toFixed(4)}</span></div>
        <div class="kv"><span class="k">密集筹码带</span><span class="v">${chip.top10_band && chip.top10_band.low ? `${num(chip.top10_band.low)} ~ ${num(chip.top10_band.high)}` : "—"}</span></div>
      </div>
    </div>
    <div class="note" style="margin-top:12px">筹码分布（估算 · 非官方）</div>
    <div class="chip-legend">
      <span><i style="background:${KC.trapped}"></i>现价以上（套牢盘 ${num(chip.trapped_ratio_pct)}%）</span>
      <span><i style="background:${KC.up}"></i>现价以下（获利盘 ${num(chip.profit_ratio_pct)}%）</span>
      <span><i style="background:${KC.amber}"></i>黄线 = 现价</span>
      <span><i style="background:${KC.avg}"></i>紫线 = 平均筹码</span>
      <span class="muted">鼠标移动画白线，显示该价位筹码与距现价幅度</span>
    </div>
    <div class="grid2" style="margin-top:8px">
      <div class="box"><div class="k">平均筹码成本（按价格加权）</div>
        <div class="v" style="color:${KC.avg}">${num(avg.all)}</div></div>
      <div class="box"><div class="k">现价以上平均成本</div><div class="v">${num(avg.above)}</div></div>
      <div class="box"><div class="k">现价以下平均成本</div><div class="v">${num(avg.below)}</div></div>
      <div class="box"><div class="k">获利盘 / 套牢盘（估算）</div>
        <div class="v" style="font-size:15px">${num(chip.profit_ratio_pct)}% / ${num(chip.trapped_ratio_pct)}%</div></div>
    </div>
    <div class="chips-wrap">
      <div class="chip-tip"></div>
      <div class="chip-hline"></div>
      <div class="chip-line now"><span></span></div>
      <div class="chip-line avg"><span></span></div>
      ${bars || '<div class="state">无筹码数据</div>'}
    </div>
    <div class="note">${esc(chip.note || "")}</div>` : ""}
    <div class="grid2" style="margin-top:12px">
      <div><div class="note">利多因子</div>${pros || '<div class="state">无</div>'}</div>
      <div><div class="note">利空因子</div>${cons || '<div class="state">无</div>'}</div>
    </div>
    ${detail ? `
    <div class="grid2" style="margin-top:12px">
      <div><div class="note">机构研报（含看多/看空）</div>${(inst.reports || []).slice(0, 6).map((x) =>
        `<div class="kv"><span class="k">${esc(x.date || "")} ${esc(x.org || "")}</span>
         <span class="v">${stanceTag(x.stance)}</span></div>`).join("") || '<div class="state">近期无该股研报</div>'}</div>
      <div><div class="note">机构调研（关注度，非多空）</div>${(inst.survey || []).slice(0, 5).map((x) =>
        `<div class="kv"><span class="k">${esc(x.date || "")} ${esc((x.orgs || "").slice(0, 18))}</span>
         <span class="v">${x.org_num ?? "—"} 家</span></div>`).join("") || '<div class="state">近期无调研记录</div>'}</div>
    </div>` : `<div class="note" style="margin-top:10px">机构研报/调研：<b>数据缺失</b>
      （存档快照里没有这只股票；实时抓取不含机构数据）</div>`}
    ${row.has_detail && !detail ? `<div class="state">详情文件读取失败（data/stock/${esc(code)}.json）</div>` : ""}
    <div class="note" style="margin-top:10px">${esc(adv.note || uni.note || "")}</div>`;

  if (kl) {
    mountKline(document.getElementById("kOne"), kl, { info: ".kinfo", bars: 60, ind: "MACD" });
    const tabs = box.querySelectorAll("[data-k]");
    tabs.forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation();
      klineSet("kOne", b.dataset.k, b.dataset.v);
    }));
  }
  if (chipRows.length) {
    wireChipHover(box);
    // 布局完成后定位现价黄线 / 平均筹码紫线（变量在本函数内算好，不再是未定义名）
    requestAnimationFrame(() => positionChipLines(box, chipRows, cur, avg.all));
  }
}

/* 说明：分析页的指标按钮已经内联在 fillResearchOne 的模板里（与个股详情页同一套，
   都走 klineSet），所以不再需要单独的 addKlineTabs 注入函数——留着一个没人调用的函数
   只会在下次改动时误导人。 */

async function fillStock(box) {
  if (!state.stock) {
    box.innerHTML = `<div class="state">先在「选股评分」里点一行，或从下面的 Top 列表进入
      <div id="topList" style="margin-top:10px"></div></div>`;
    try {
      const s = await api("screen");
      const list = (s.top || []).slice(0, 15).map((c) =>
        `<button class="btn btn-mini" data-code="${esc(c)}" style="margin:3px">${esc(c)}</button>`).join("");
      box.querySelector("#topList").innerHTML = list;
      box.querySelectorAll("[data-code]").forEach((b) =>
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          state.stock = b.dataset.code;
          fillStock(box);
        }));
    } catch (e) { /* 忽略：只影响快捷入口 */ }
    return;
  }
  const code = state.stock;
  // 个股详情（点"选股评分"里一行进来的路径）：去掉时间戳与 no-store，加内存缓存 ——
  // 反复点开同一只股票只联网一次；数据没变时浏览器直接给 304/缓存。
  const ck = "stock:" + code;
  let d = CACHE[ck] || null;
  if (!d) {
    const res = await fetch(DATA + "stock/" + code + ".json", { cache: "default" });
    if (!res.ok) throw new Error(`没有 ${code} 的详情数据（data/stock/${code}.json 不存在，HTTP ${res.status}）`);
    d = await res.json();
    CACHE[ck] = d;
  }
  const chip = d.chip || {}, tr = d.trend || {}, inst = d.inst || {};
  const rating = inst.rating || {};
  state.stockPrice = Number(d.price) || 0;    // 筹码峰悬停判定"套牢/获利"要用
  const rows = (chip.rows || []);
  const cur = Number(d.price) || 0;
  const bars = chipRowsHTML(rows, cur);
  const avg = avgChipCost(rows, cur);          // 平均筹码（价格加权平均成本）
  const rep = (inst.reports || []).slice(0, 6).map((x) => `<div class="kv">
      <span class="k">${esc(x.date || "")} ${esc(x.org || "")} ${esc((x.title || "").slice(0, 18))}</span>
      <span class="v">${stanceTag(x.stance)} ${x.target_high ? num(x.target_high) : ""}</span></div>`).join("");
  const sur = (inst.survey || []).slice(0, 5).map((x) => `<div class="kv">
      <span class="k">${esc(x.date || "")} ${esc((x.orgs || "").slice(0, 20))}</span>
      <span class="v">${esc(x.way || "")} · ${x.org_num ?? "—"} 家</span></div>`).join("");

  box.innerHTML = `
    <div class="grid2">
      <div class="box"><div class="k">${esc(d.code)} ${esc(d.name)}</div>
        <div class="v">${num(d.price)} <span class="${cls(d.change_pct)}" style="font-size:13px">${pctTxt(d.change_pct)}</span></div></div>
      <div class="box"><div class="k">所属行业</div><div class="v" style="font-size:14px">${esc(d.industry || "—")}</div></div>
      <div class="box"><div class="k">评分</div><div class="v">${num((d.score || {}).score, 1)}</div></div>
      <div class="box"><div class="k">机构态度</div><div class="v" style="font-size:14px">${rating.stance ? stanceTag(rating.stance) : "—"}</div></div>
    </div>
    <div class="kinfo" style="margin-top:10px"></div>
    <div class="tabs">
      <button class="btn btn-mini on" data-k="ind" data-v="MACD" id="stMACD">MACD</button>
      <button class="btn btn-mini" data-k="ind" data-v="KDJ" id="stKDJ">KDJ</button>
      <button class="btn btn-mini" data-k="ind" data-v="RSI" id="stRSI">RSI</button>
      <button class="btn btn-mini" data-k="ind" data-v="NONE" id="stNONE">只看K线</button>
      <button class="btn btn-mini on" data-k="bars" data-v="60" id="stB60">60根</button>
      <button class="btn btn-mini" data-k="bars" data-v="120" id="stB120">120根</button>
    </div>
    <div class="chart-wrap"><div class="ktip"></div><canvas class="kc" id="kStock"></canvas>
      <div class="kempty" style="display:none">没有该股 K 线数据</div></div>
    <div class="legend">
      <span><i style="background:${KC.ma5}"></i>MA5</span>
      <span><i style="background:${KC.ma10}"></i>MA10</span>
      <span><i style="background:${KC.ma20}"></i>MA20</span>
      <span><i style="background:${KC.ma60}"></i>MA60</span>
      <span><i style="background:${KC.boll}"></i>BOLL(20,2)</span></div>
    ${stockBasicsHTML(d, null)}
    <div class="grid2" style="margin-top:12px">
      <div>
        <div class="note">筹码分布（估算 · 非官方）</div>
        <div class="kv"><span class="k">形态</span><span class="v">${esc(chip.shape || "—")}</span></div>
        <div class="kv"><span class="k">获利盘（现价以下）</span><span class="v up">${num(chip.profit_ratio_pct)}%</span></div>
        <div class="kv"><span class="k">套牢盘（现价以上）</span><span class="v down">${num(chip.trapped_ratio_pct)}%</span></div>
        <div class="kv"><span class="k">平均成本</span><span class="v">${num(chip.avg_cost)}</span></div>
        <div class="kv"><span class="k">集中度 HHI</span><span class="v">${chip.hhi === null || chip.hhi === undefined ? "—" : Number(chip.hhi).toFixed(4)}</span></div>
        <div class="kv"><span class="k">密集筹码带</span><span class="v">${chip.top10_band && chip.top10_band.low ? `${num(chip.top10_band.low)} ~ ${num(chip.top10_band.high)}` : "—"}</span></div>
      </div>
      <div>
        <div class="note">技术指标（前复权日线）</div>
        <div class="kv"><span class="k">MA5 / MA10 / MA20 / MA60</span><span class="v">${num(tr.ma5)} / ${num(tr.ma10)} / ${num(tr.ma20)} / ${num(tr.ma60)}</span></div>
        <div class="kv"><span class="k">RSI14</span><span class="v">${num(tr.rsi14, 1)}</span></div>
        <div class="kv"><span class="k">BOLL 上/中/下</span><span class="v">${num(tr.boll_up)} / ${num(tr.boll_mid)} / ${num(tr.boll_dn)}</span></div>
        <div class="kv"><span class="k">量比（对5日均量）</span><span class="v">${num(tr.volume_ratio, 2)}</span></div>
        <div class="kv"><span class="k">距 MA20</span><span class="v ${cls(tr.dev_ma20_pct)}">${pctTxt(tr.dev_ma20_pct)}</span></div>
        <div class="kv"><span class="k">主力净流入</span><span class="v ${cls((d.flow || {})["主力净流入(万元)"])}">${money((d.flow || {})["主力净流入(万元)"])}万</span></div>
      </div>
    </div>
    <div class="note" style="margin-top:12px">筹码分布（估算 · 非官方）</div>
    <div class="chip-legend">
      <span><i style="background:${KC.trapped}"></i>现价以上（套牢盘 ${num(chip.trapped_ratio_pct)}%）</span>
      <span><i style="background:${KC.up}"></i>现价以下（获利盘 ${num(chip.profit_ratio_pct)}%）</span>
      <span><i style="background:${KC.amber}"></i>黄线 = 现价</span>
      <span><i style="background:${KC.avg}"></i>紫线 = 平均筹码</span>
      <span class="muted">鼠标移动画白线，显示该价位筹码与距现价幅度</span>
    </div>
    <div class="grid2" style="margin-top:8px">
      <div class="box"><div class="k">平均筹码成本（按价格加权）</div>
        <div class="v" style="color:${KC.avg}">${num(avg.all)}</div></div>
      <div class="box"><div class="k">现价以上平均成本</div>
        <div class="v">${num(avg.above)}</div></div>
      <div class="box"><div class="k">现价以下平均成本</div>
        <div class="v">${num(avg.below)}</div></div>
      <div class="box"><div class="k">获利盘 / 套牢盘（估算）</div>
        <div class="v" style="font-size:15px">${num(chip.profit_ratio_pct)}% / ${num(chip.trapped_ratio_pct)}%</div></div>
    </div>
    <div class="chips-wrap">
      <div class="chip-tip"></div>
      <div class="chip-hline"></div>
      <div class="chip-line now"><span></span></div>
      <div class="chip-line avg"><span></span></div>
      ${bars || '<div class="state">无筹码数据</div>'}
    </div>
    <div class="grid2" style="margin-top:12px">
      <div><div class="note">机构研报（含看多/看空）</div>${rep || '<div class="state">近期无该股研报</div>'}</div>
      <div><div class="note">机构调研（关注度，非多空）</div>${sur || '<div class="state">近期无调研记录</div>'}</div>
    </div>
    <div class="note">${esc(chip.note || "")}</div>`;

  const wire = (id, key, val) => {
    const el = box.querySelector(id);
    if (el) el.addEventListener("click", (e) => { e.stopPropagation(); klineSet("kStock", key, val); });
  };
  wire("#stMACD", "ind", "MACD"); wire("#stKDJ", "ind", "KDJ");
  wire("#stRSI", "ind", "RSI"); wire("#stNONE", "ind", "NONE");
  wire("#stB60", "bars", 60); wire("#stB120", "bars", 120);
  mountKline(document.getElementById("kStock"), d.kline || {}, { info: ".kinfo", bars: 60, ind: "MACD" });
  wireChipHover(box);
  // 筹码峰的黄线（现价）与紫线（平均筹码）要在布局完成后再定位
  requestAnimationFrame(() => positionChipLines(box, rows, cur, avg.all));
}

/**
 * 系统自检的**元信息**（横幅 / 口径提示 / 数据来源 / 免责声明）。
 *
 * 用户要求（原话）："把数据来源去掉，数据来源不用显示在主第一界面；
 * 自检的蓝框提示放在系统自检里；口径提示也跟数据来源放在一块儿，不要放在主界面。
 * 主界面只有模块搜索、交易日档位、数据生成时间、刷新数据。"
 *
 * 所以这些内容不再挂在页面顶部/底部，而是**统一收进「系统自检」模块**：
 * 打开自检模块就能看到"结论 + 依据 + 口径 + 数据来源"，主界面保持干净。
 * ⚠️ 这里只**收集**数据、不写 DOM —— 因为三个界面里不一定挂着自检模块，
 *    挂载时才由 fillSelfcheck 渲染（否则就是在往不存在的元素里写东西）。
 */
const sysInfo = {
  banners: [],          // 自检横幅（策略衰减/失效、空仓预警）
  notice: "",           // 口径提示（原文照搬，一字未改）
  sourcesHTML: "",      // 数据来源
  disclaimer: "",       // 免责声明
  snapshotTip: "",      // 时点提示（收盘快照 / 行情时间 / 评分口径）
  intraday: false,      // 本轮是不是"盘中快照"（是的话主界面仍显示警告）
  loaded: false,
};

/** 口径提示的原文（从主界面搬进自检模块）。 */
const NOTICE_TEXT = "<b>口径提示</b>：筹码分布的<b>获利盘/套牢盘比例是模型估算</b>"
  + "（官方与免费渠道都没有真实筹码数据），平均筹码=按价格加权平均成本；"
  + "评分是<b>本工具自定义的合成指标</b>，看多/看跌是本工具的量化倾向，<b>不是投资建议</b>。";

async function loadSysWarn() {
  sysInfo.notice = NOTICE_TEXT;
  try {
    const d = await api("selfcheck");
    sysInfo.banners = (d && d.banners) || [];
    sysInfo.loaded = true;
  } catch (e) {
    // 自检数据缺失**不是错误**（第一轮跑之前本来就没有）
    sysInfo.banners = [];
    sysInfo.loaded = false;
  }
  refreshSelfcheckPanels();       // 自检模块可能已经挂上了 → 立刻把横幅刷进去
  refreshModbar();                // 模块条上「自检」标签的警示色也要跟着变
  return sysInfo.banners.length ? { banners: sysInfo.banners } : null;
}

/**
 * 有「失效 / 空仓预警」时，给自检模块的标签加警示色。
 *
 * 为什么不把横幅放回主界面：用户明确要求主界面只留"搜索/交易日/档位/生成时间/刷新"。
 * 但"策略失效"完全不提示也不合适 —— 所以用**模块标签变色**做最小提示：
 * 不新增任何元素，一眼能看出「自检」那块不对劲，点进去就是完整说明。
 */
function selfcheckLevel() {
  const bs = sysInfo.banners || [];
  if (bs.some((b) => b.level === "danger")) return "danger";
  if (bs.some((b) => b.level === "warn")) return "warn";
  return "";
}

/** 需要时刷新模块条（横幅/警示色变化时用；renderModbar 未就绪就跳过）。 */
function refreshModbar() {
  try { if (typeof renderModbar === "function") renderModbar(); } catch (e) { /* 忽略 */ }
}

/** 已挂在界面里的自检面板重新渲染一次（横幅/口径/来源变化时用）。 */
function refreshSelfcheckPanels() {
  if (typeof document === "undefined" || !document.querySelectorAll) return;
  Array.from(document.querySelectorAll("#stage [data-mod='selfcheck']")).forEach((card) => {
    const body = card.querySelector("[id^='body-']");
    if (body && body.querySelector("[data-selfcheck-root]")) fillSelfcheck(body);
  });
}

/* ---------------- 顶部状态栏 / 刷新 ---------------- */
async function loadVersion(force) {
  try {
    const v = await api("version", force);
    $("#badgeDate").textContent = "交易日 " + (v.trade_date || "—");
    $("#badgeSlot").textContent = "档位 " + (v.slot || "—");
    $("#stamp").textContent = `数据生成于 ${v.generated_at || "—"} · 精算 ${v.scored ?? 0} 只`
      + (v.elapsed_s ? ` · 抓取耗时 ${v.elapsed_s}s` : "");
    // 数据来源 / 免责声明：**两个地方都写** ——
    //   · 底部一行细条（用户建议把数据来源放这儿，顺便填住下方留白）
    //   · 「系统自检」模块里的完整版（含口径提示与缺失项）
    if (v.sources) {
      sysInfo.sourcesHTML = "<b>数据来源</b>：" + v.sources
        .map((x) => `${esc(x.item)} → ${esc(x.source)}`).join("；");
    }
    if (v.disclaimer) sysInfo.disclaimer = v.disclaimer;
    const srcEl = $("#sources");
    const disEl = $("#disclaimer");
    if (srcEl && sysInfo.sourcesHTML) {
      srcEl.innerHTML = sysInfo.sourcesHTML.replace(/^<b>数据来源<\/b>：/, "");
    }
    if (disEl && v.disclaimer) disEl.textContent = v.disclaimer;
    refreshSelfcheckPanels();
    // 时点提示：这份快照到底是不是收盘价、行情时间、评分口径。
    // 用户要求主界面只留"搜索/交易日/档位/生成时间/刷新"，所以这些**收进自检模块**；
    // 但有一条例外必须留在主界面：**post_close_snapshot=false（盘中价）**——
    // 把盘中价当收盘价去复盘是会让人真亏钱的事，这种警告不能藏在点开才看得到的地方。
    const all = [];
    if (v.post_close_snapshot === true) all.push("收盘快照");
    if (v.snapshot_quote_time) all.push(`行情时间 ${esc(v.snapshot_quote_time)}`);
    if (v.date_from_quotes) all.push("归档日按行情时间取（不是运行当天）");
    if (v.scoring_version) all.push(`评分口径 ${esc(v.scoring_version)}`);
    sysInfo.snapshotTip = all.join(" · ");
    sysInfo.intraday = v.post_close_snapshot === false;
    const tip = $("#snapTip");
    if (tip) {
      if (v.post_close_snapshot === false) {
        tip.innerHTML = '<span class="err">⚠️ 本轮是盘中快照，不是收盘价（别当收盘数据用）</span>';
        tip.style.display = "";
      } else {
        tip.innerHTML = "";
        tip.style.display = "none";
      }
    }
    refreshSelfcheckPanels();
    refreshModbar();
    return v;
  } catch (e) {
    $("#badgeDate").textContent = "交易日 —";
    $("#badgeSlot").textContent = "档位 —";
    $("#stamp").innerHTML = `<span class="err">数据未生成：${esc(e.message)}</span>`;
    return null;
  }
}

async function refreshAll() {
  const btn = $("#refreshBtn");
  btn.classList.add("spin");
  btn.textContent = "刷新中…";
  Object.keys(CACHE).forEach((k) => delete CACHE[k]);
  FORCE = true;                 // 关键：让**所有**模块都绕过缓存重新拉，
  try {                         // 否则只有顶部状态栏更新，卡片里还是旧数据
    await loadVersion(true);
    await renderShell();
  } finally {
    FORCE = false;
    btn.classList.remove("spin");
    btn.textContent = "刷新数据";
  }
}

/* ---------------- 启动 ---------------- */
(async function boot() {
  $("#refreshBtn").addEventListener("click", refreshAll);
  setupSearch();                       // 顶部搜索框（搜索→评分/基本面/建议）
  ensureColTip();                      // 拖动列宽时的比例提示
  loadSlots();                         // 恢复上次的"三个界面分别显示什么"
  loadCols();                          // 恢复上次拖好的列宽
  applyDeepLink();                     // 网址参数可直达指定画面（?slots= / ?sector= / ?code=）
  renderShell();                       // 先画三个界面（占位），再等数据
  renderModbar();                      // 顶部模块条（点击/拖拽换界面内容）
  renderVSwitch();                     // 竖屏竖排切换按钮（横屏自动隐藏）
  wireScrollSpy();                     // 竖屏滚动时自动高亮当前界面
  wireColumnDropOnce();                // 拖动顶部模块 → 三列投放条
  loadSysWarn();                       // 顶部自检横幅（策略衰减/失效、空仓预警）
  const v = await loadVersion(false);
  if (!v) {
    $("#stage").innerHTML = `<div class="state err"><div class="big">⚠️</div>
      还没有数据。请在 GitHub 仓库的 Actions 里手动跑一次
      <b>update-data</b>（或用 <code>python scripts/fetch_data.py</code> 本地跑一次），
      数据会写入 data/ 目录。</div>`;
    $("#shell").classList.remove("grid-mode");
    return;
  }
  if (v.placeholder) {
    $("#stage").innerHTML = `<div class="state"><div class="big">⏳</div>
      数据尚未生成。到仓库 Actions 页面运行一次 <b>update-data</b>（Run workflow），
      约 3~5 分钟后刷新本页即可看到完整面板。</div>`;
    $("#shell").classList.remove("grid-mode");
    return;
  }
  await renderShell();
  const DEBUG = /[?&]debug=1/.test(location.search || "");
  if (DEBUG) {
    dumpDebugMetrics();                                          // 立刻量一次
    [400, 1500, 3000].forEach((ms) => setTimeout(dumpDebugMetrics, ms));
    window.addEventListener("resize", () => setTimeout(dumpDebugMetrics, 300));
  }
})();
