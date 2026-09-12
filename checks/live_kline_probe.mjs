// live_kline_probe.mjs — 用**真实网络**验证"浏览器实时补 K 线"这条路走得通。
//
// 为什么要有：分析页对没有存档的个股会直接向腾讯行情取日线。这条路有三个易错点，
// 而且都不会在本地假数据里暴露：
//   ① sh/sz/bj 前缀推断错 → 接口返回空，页面上永远"没图"
//   ② 腾讯的字段顺序是「日期, 开, 收, 高, 低, 量」，按 OHLCV 解析会把最高价当收盘价，
//      图还是能画出来但全是错的（这种错最难发现）
//   ③ 该接口必须带 `Access-Control-Allow-Origin: *`，否则浏览器直连会被 CORS 拦掉
// 离线或无网络时自动跳过（退出码 0），不会把 CI 卡死。
import { readFileSync } from "node:fs";
import vm from "node:vm";

const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");

let failed = 0;
const note = (ok, label, extra = "") => {
  console.log(`  [${ok ? "OK  " : "FAIL"}] ${label}${extra ? "    " + extra : ""}`);
  if (!ok) failed++;
};

// 抽取后端逻辑（不加载整个 app.js：它需要 DOM）
function grab(name) {
  let start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  // ⚠️ 必须把前面的 `async ` 一起带上，否则抽出来的是个含 await 的普通函数 → SyntaxError
  if (src.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 解析失败`);
}
const sandbox = { console, fetch };
vm.createContext(sandbox);
vm.runInContext(grab("codePrefix"), sandbox);
vm.runInContext(grab("liveKline"), sandbox);

console.log("=".repeat(78));
console.log("真实网络：腾讯行情日线（浏览器直连路径）");
console.log("=".repeat(78));

// ---------- ① 前缀推断（纯逻辑，不需要网络） ----------
const cases = [["600519", "sh"], ["688111", "sh"], ["601318", "sh"],
               ["000636", "sz"], ["002415", "sz"], ["300750", "sz"],
               ["430047", "bj"], ["830799", "bj"]];
let prefixOk = true;
for (const [code, want] of cases) {
  const got = sandbox.codePrefix(code);
  if (got !== want) { prefixOk = false; console.log(`     ${code} → ${got}（应为 ${want}）`); }
}
note(prefixOk, "sh/sz/bj 前缀推断正确", cases.map(([c]) => c).join(","));

// ---------- ② 真实请求 ----------
const probes = [["600519", "贵州茅台"], ["000636", "风华高科"]];
let netOK = true, checked = 0;
for (const [code, name] of probes) {
  let kl = null;
  try {
    kl = await sandbox.liveKline(code, 60);
  } catch (e) {
    netOK = false;
    console.log(`  [SKIP] ${code} ${name}：${e.message}`);
    continue;
  }
  checked++;
  const n = kl.dates.length;
  note(n >= 40, `${code} ${name}：取到 ${n} 根日线`, `${kl.dates[0]} → ${kl.dates[n - 1]}`);
  // 字段顺序自检：最低价 ≤ 开盘/收盘 ≤ 最高价，且必须成立（否则就是字段解析错了）
  let order = 0;
  for (let i = 0; i < n; i++) {
    if (kl.low[i] <= kl.high[i] && kl.low[i] <= kl.open[i] && kl.open[i] <= kl.high[i]
        && kl.low[i] <= kl.close[i] && kl.close[i] <= kl.high[i]) order++;
  }
  note(order === n, `${code}：低 ≤ 开/收 ≤ 高 全部成立（证明字段顺序解析正确）`,
       `${order}/${n}`);
  note(kl.volume.every((v) => v >= 0) && kl.volume.some((v) => v > 0), `${code}：成交量有值`);
  const closes = kl.close.filter((c) => c > 0);
  note(closes.length === n, `${code}：收盘价全为正数`);
}

// ---------- ③ 浏览器能不能直连（CORS） ----------
try {
  const r = await fetch("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,5,qfq",
                        { headers: { Origin: "https://example.github.io" } });
  const acao = r.headers.get("access-control-allow-origin");
  note(acao === "*" || !!acao, "接口返回 CORS 头，浏览器可直连",
       `Access-Control-Allow-Origin: ${acao}`);
} catch (e) {
  netOK = false;
  console.log(`  [SKIP] CORS 头检查：${e.message}`);
}

console.log();
console.log("=".repeat(78));
if (!netOK && checked === 0) {
  console.log("⚠ 本机当前连不上该接口，已跳过网络部分（逻辑部分仍已检查）");
} else {
  console.log(failed === 0 ? "全部通过" : `失败 ${failed} 项`);
}
process.exit(failed === 0 ? 0 : 1);
