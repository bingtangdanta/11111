// _chip_parity.mjs — 筹码口径一致性测试的"JS 侧"：由 Python 驱动，文件进出、不靠管道。
//
// 为什么要有这个：前端新增了一份"由 K 线估算筹码"的实现（搜索任意个股时用），
// 如果它和后端 scripts/chips.py 算法不一致，同一只股票会出现**两个获利盘数字**
// （存档快照一个、实时抓取一个），用户看到就再也不信这个指标了。
// 所以这里让两边吃同一根 K 线，逐项对账。
import { readFileSync, writeFileSync } from "node:fs";
import vm from "node:vm";

const [fixturePath, outPath] = process.argv.slice(2);
if (!fixturePath || !outPath) {
  console.error("用法：node checks/_chip_parity.mjs <fixture.json> <out.json>");
  process.exit(2);
}

const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
const root = new URL("../docs/", import.meta.url);
const src = readFileSync(new URL("app.js", root), "utf8");

const sandbox = { console };
vm.createContext(sandbox);
// 只抽我们需要的那几个函数与常量（不加载整个 app.js：它需要 DOM）
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let i = src.indexOf("{", start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name} 解析失败`);
}
function grabConst(name) {
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
// 注意：CHIP_BINS/HALF_LIFE/SAMPLES/LOOKBACK 写在**同一条 const 声明**里
// （`const A = 1, B = 2, ...`），所以按 "const B = " 去找是找不到的——必须整条抓。
for (const n of ["CHIP_BINS", "CHIP_NOTE"]) {
  vm.runInContext(grabConst(n).replace(/^const /, "var "), sandbox);
}
if (sandbox.CHIP_HALF_LIFE === undefined) {
  console.error("❌ 常量抽取失败：CHIP_HALF_LIFE 未进入沙箱");
  process.exit(2);
}
for (const n of ["_triSamples", "_smooth", "_peaksValleys", "_topBand", "chipFromKline"]) {
  vm.runInContext(grab(n), sandbox);
}

const chip = sandbox.chipFromKline(fx.kline, fx.price);
writeFileSync(outPath, JSON.stringify(chip), "utf8");
console.log(`JS 侧算完：获利盘 ${chip.profit_ratio_pct}% / 平均成本 ${chip.avg_cost} / 形态 ${chip.shape}`);
