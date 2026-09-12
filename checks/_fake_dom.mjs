// _fake_dom.mjs — 极简假 DOM：把 docs/app.js 真正加载起来跑，验证"行为"而不只是查字符串。
//
// 为什么需要：像"竖屏点切换是滚动定位而不是聚焦""搜索框空输入要列出评分榜"这类要求，
// 用正则查源码只能证明"代码里写了"，写反了照样匹配。这里用最小可用的假 DOM 让代码真跑一遍，
// 直接断言状态与渲染结果。
//
// 设计取舍：
//   · 不做通用 DOM 实现，只覆盖 app.js 实际用到的那几个 API（querySelector / classList / innerHTML …）
//   · innerHTML 写入时顺手解析 class + data-id 生成"子元素"，
//     这样 querySelectorAll(".vc") 既能拿到 dataset 也能拿到 class（.on 高亮才验得了）
//   · setTimeout 同步执行：app.js 里用它做"取消高亮""输入防抖"，同步执行能让测试不用等
import vm from "node:vm";

// ⚠️ 这份清单只给假 DOM 建卡片用，必须跟着 docs/app.js 的 MODULES 一起长：
//    少一项 → 那个模块的卡片根本不存在，相关断言会变成"假通过"。
//    （真要验"清单完整"，请对 MODULES 本身断言，别对这份副本断言。）
export const MODULE_IDS = ["board", "limitup", "heat", "screen", "sectors",
                           "dragon", "research", "index", "stock", "review", "funds",
                           "selfcheck"];

/** 假 2D 上下文：所有绘制方法都是空操作，只保证 drawKline 不会因为 ctx 为 null 而炸。
    这样"K 线挂载"这条路径也能在 Node 里真跑一遍（能抓到 ReferenceError 之类的错）。 */
export function fakeCtx() {
  const noop = () => {};
  return {
    font: "", textAlign: "", textBaseline: "", fillStyle: "", strokeStyle: "", lineWidth: 1,
    globalAlpha: 1, setTransform: noop, clearRect: noop, save: noop, restore: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, stroke: noop, fill: noop,
    rect: noop, fillRect: noop, strokeRect: noop, fillText: noop, strokeText: noop,
    arc: noop, clip: noop, translate: noop, scale: noop, rotate: noop,
    setLineDash: noop, createLinearGradient: () => ({ addColorStop: noop }),
    measureText: (t) => ({ width: String(t || "").length * 6 }),
  };
}

/**
 * 极简选择器匹配。支持：
 *   · ".cls" / "tag" / "tag.cls"
 *   · 逗号分隔的多个选择器
 *   · 属性选择器 "[data-slot]" / "[data-slot=\"0\"]"（**必须有**：
 *     页面用 `article.mod[data-slot]` 精确定位"界面卡片本体"，
 *     假 DOM 不认属性选择器的话，这条最关键的修复就永远测不到）
 *   · 一层子选择器 "父 > 子"（如 "#stage > article.mod[data-slot]"）
 * 不追求完整实现，够测这个项目就行。
 */
function matchesSimple(el, sel) {
  const one = (raw) => {
    let s = String(raw || "").trim();
    if (!s) return false;
    // ---- 一层子选择器 ----
    const gt = s.indexOf(">");
    if (gt >= 0) {
      const parent = s.slice(0, gt).trim();
      s = s.slice(gt + 1).trim();
      const p = el.parentNode;
      if (!p) return false;
      if (parent.startsWith("#")) {
        const want = parent.slice(1);
        const have = String(p.id || "").replace(/^#/, "");
        if (have !== want) return false;
      }
    }
    // ---- 属性选择器（只判存在与相等；data-* 走 dataset，和真实 DOM 一致）----
    for (const m of s.matchAll(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g)) {
      const name = m[1];
      const want = m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4]);
      let have;
      if (name.startsWith("data-")) {
        const camel = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
        have = (el.dataset || {})[camel];
      } else {
        have = el[name];
      }
      if (have === undefined || have === null) return false;
      if (want !== undefined && String(have) !== String(want)) return false;
    }
    s = s.replace(/\[[^\]]*\]/g, "").trim();
    const m = /^([a-zA-Z]+)?(?:\.([\w-]+))?$/.exec(s);
    if (!m) return false;
    const tagOk = !m[1] || String(el.tagName || "").toLowerCase() === m[1].toLowerCase();
    const clsOk = !m[2] || el.classList.contains(m[2]);
    return tagOk && clsOk;
  };
  return String(sel).split(",").some(one);
}

export function makeEl(tag = "div", id = "") {
  const el = {
    tagName: tag.toUpperCase(), id, dataset: {}, style: {}, children: [],
    textContent: "", value: "", offsetTop: 0, offsetHeight: 10,
    clientWidth: 640, clientHeight: 320, scrolled: 0, listeners: {},
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      contains(c) { return this._s.has(c); },
      toggle(c, v) {
        const on = v === undefined ? !this._s.has(c) : !!v;
        if (on) this._s.add(c); else this._s.delete(c);
        return on;
      },
      toString() { return [...this._s].join(" "); },
    },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    removeEventListener() {},
    // 真实 DOM 的 appendChild 是"移动"：已在 children 里的节点不会重复出现。
    // 假 DOM 如果无条件 push，界面数会翻倍（页面用 appendChild 做按块重排）。
    appendChild(c) {
      const p = c.parentNode;
      if (p && p.children) {
        const i = p.children.indexOf(c);
        if (i >= 0) p.children.splice(i, 1);
      }
      c.parentNode = this;
      this.children.push(c);
      return c;
    },
    insertBefore(c) { c.parentNode = this; this.children.unshift(c); return c; },
    // 真实 DOM 里 replaceChild / remove 是标准 API，页面已经用它们做"按块复用"，
    // 假 DOM 缺了这两个就会让旧节点留在 children 里 → 界面数翻倍（测试会假失败）。
    replaceChild(newEl, oldEl) {
      const i = this.children.indexOf(oldEl);
      newEl.parentNode = this;
      if (i >= 0) this.children[i] = newEl; else this.children.push(newEl);
      return oldEl;
    },
    remove() {
      const p = this.parentNode;
      if (p && p.children) {
        const i = p.children.indexOf(this);
        if (i >= 0) p.children.splice(i, 1);
      }
      this.parentNode = null;
    },
    // className 必须与 classList 联动：真实 DOM 里它们是同一个东西，
    // 代码里 `el.className = "colslots"` 之后再用 classList 查，假 DOM 不联动就会查不到。
    get className() { return this.classList.toString(); },
    set className(v) {
      this.classList._s = new Set(String(v || "").split(/\s+/).filter(Boolean));
    },
    set innerHTML(v) {
      this._html = v;
      this.children = [];            // 真实 DOM 写 innerHTML 会**清空**原有子节点
      // 解析出"子元素"：data-id（模块标签）、data-col（投放条）、data-slot（界面/竖排按钮），
      // 以及手机版用到的 data-tab / data-stock / data-smode / data-fsort / data-mode / data-group，
      // 否则 querySelectorAll(".vc"/".tab"/".row[data-stock]") 永远是空数组，
      // 行为测试就成了摆设（手机版就是这么一直没被测到的）。
      // ⚠️ 标签名要从 HTML 里**读出来**，不能一律当成 span：
      //    querySelectorAll("table") 会把所有 span 也当成 table 返回，
      //    于是 enhanceTables() 去拿 `tb.parentNode` 就炸了（这个坑真的踩到过）。
      this._kids = [...String(v).matchAll(
        /<(\w+)([^>]*?)class="([^"]*)"([^>]*?)data-(id|col|slot|tab|stock|smode|fsort|mode|group|pickto|pan)="([^"]+)"/g)]
        .map((m) => {
          const k = makeEl(m[1]);
          k.dataset[m[5]] = m[6];
          m[3].split(/\s+/).filter(Boolean).forEach((c) => k.classList.add(c));
          k.parentNode = this;       // 后面可能被当作父节点用（insertBefore/appendChild）
          return k;
        });
      // 另外把常见**标签**也建成子元素：页面里 enhanceTables() 会先
      // querySelectorAll("table") 再把每张表包进 .hpan；不解析标签就永远测不到包裹结果
      // （会让"每张表都被包住"这条断言变成假失败）。
      const tagKids = [...String(v).matchAll(/<(table|canvas|select)\b[^>]*/g)]
        .map((m) => {
          const k = makeEl(m[1]);
          k.parentNode = this;
          this.children.push(k);
          return k;
        });
      if (tagKids.length) this._kids = this._kids.concat(tagKids);
    },
    get innerHTML() { return this._html || ""; },
    querySelector() { return makeEl("div"); },
    // 真实 DOM 的 querySelectorAll 会找到**运行时创建并 append 的子元素**。
    // 早期版本只返回"从 innerHTML 解析出来的"子元素，于是
    // `querySelectorAll(".gutter, .collapsed")` 永远为空 → 旧的拖拽条清不掉、越攒越多。
    querySelectorAll(sel) {
      const s = String(sel || "");
      // ⚠️ 解析出来的子元素也**必须过一遍选择器**。
      //    早期这里把 _kids 原样全返回（不筛），于是 `querySelectorAll("table")`
      //    会把表格里的龙头股标签一起返回，enhanceTables() 拿它的 parentNode 就炸了。
      const out = [];
      (this._kids || []).forEach((k) => { if (matchesSimple(k, s)) out.push(k); });
      this.children.forEach((c) => {
        if (out.includes(c)) return;
        if (matchesSimple(c, s)) out.push(c);
      });
      return out;
    },
    getBoundingClientRect() { return { left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }; },
    scrollIntoView(opts) { this.scrolled++; this.lastScrollOpts = opts; },
    closest() { return null; },
    animate() { return { cancel() {} }; },
    getContext() { return fakeCtx(); },
    focus() {}, blur() {}, click() {},
  };
  return el;
}

/**
 * 加载 docs/app.js。
 * @param {{innerWidth?:number, fetchImpl?:Function, appSrc:string}} opts
 * @returns 句柄：get(选择器) / state / fn(名字) / cards / fireResize() / sandbox
 */
export function loadApp({ appSrc, innerWidth = 1400, fetchImpl, search = "",
                         deferTimers = false }) {
  const nodes = {};
  const get = (sel) => (nodes[sel] = nodes[sel] || makeEl("div", sel));
  const winListeners = {};
  // 默认 setTimeout 同步执行（省得每个测试都要 await）；但"动画结束后清理"这类逻辑
  // 在同步执行下等于**立刻清理**，测试就看不到中间态了 —— 需要看中间态的测试
  // 传 deferTimers: true，自己用 flushTimers() 决定什么时候推进时间。
  const timerQueue = [];
  let timerSeq = 1;
  const syncTimer = (fn) => { try { fn(); } catch (e) { /* 忽略回调里的异常 */ } return 0; };
  const queuedTimer = (fn) => { const id = timerSeq++; timerQueue.push({ id, fn }); return id; };
  const runTimers = () => {
    const batch = timerQueue.splice(0, timerQueue.length);
    batch.forEach((t) => { try { t.fn(); } catch (e) { /* 同上 */ } });
    return batch.length;
  };

  const sandbox = {
    console,
    URLSearchParams,                 // 深链解析要用（vm 里没有 Node 的全局）
    getComputedStyle: () => ({
      paddingBottom: "0px", paddingTop: "0px", height: "", width: "",
      display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "auto",
      flex: "0 0 auto", maxHeight: "none", padding: "0px",
    }),
    setTimeout: deferTimers ? queuedTimer : syncTimer,
    clearTimeout: (id) => {
      const i = timerQueue.findIndex((t) => t.id === id);
      if (i >= 0) timerQueue.splice(i, 1);
    },
    requestAnimationFrame: (fn) => { fn(0); return 0; },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ placeholder: true, slots: [] }) })),
    localStorage: {
      _m: {},
      getItem(k) { return this._m[k] ?? null; },
      setItem(k, v) { this._m[k] = String(v); },
      removeItem(k) { delete this._m[k]; },
    },
    document: {
      querySelector: (sel) => get(sel),
      querySelectorAll: () => [],
      getElementById: (id) => get("#" + id),
      createElement: (t) => makeEl(t),
      addEventListener(type, fn) { (this._l = this._l || {})[type] = fn; },
      body: makeEl("body"),
    },
  };
  sandbox.window = {
    innerWidth, innerHeight: 900, devicePixelRatio: 1, scrollY: 0,
    addEventListener(type, fn) { (winListeners[type] = winListeners[type] || []).push(fn); },
    removeEventListener() {},
    scrollTo() { sandbox.window._scrolled = true; },
    // 页面里 sizeStage() 会读一下计算样式（拿 .shell 的下内边距）；
    // 假 DOM 不给的话会直接抛错，把整条渲染链断掉（这里踩过）。
    getComputedStyle: () => ({
      paddingBottom: "0px", paddingTop: "0px", height: "", width: "",
      display: "flex", flexDirection: "column", overflowY: "auto", overflowX: "auto",
      flex: "0 0 auto", maxHeight: "none", padding: "0px",
    }),
  };
  sandbox.globalThis = sandbox;
  // 深链（?slots= / ?sector= / ?code=）要用 location.search，假 DOM 也得给一个
  sandbox.location = { search, href: "http://127.0.0.1/" + search, hash: "" };
  vm.createContext(sandbox);

  // 竖屏那一列：9 个模块卡片（setFocus 的竖屏分支要靠 #stage [data-mod="x"] 定位）
  const cards = MODULE_IDS.map((id) => { const c = makeEl("article"); c.dataset.mod = id; return c; });
  const cardOf = (id) => cards.find((c) => c.dataset.mod === id);
  sandbox.document.querySelector = (sel) => {
    const m = /^#stage \[data-mod="([^"]+)"\]$/.exec(sel);
    if (m) return cardOf(m[1]) || makeEl("article");
    return get(sel);
  };
  sandbox.document.querySelectorAll = (sel) => {
    const s = String(sel || "");
    if (s === "#stage [data-mod]" || s === "[data-mod]") return cards;
    // 界面卡片（PANEL_SEL = "#stage > article.mod[data-slot]"）：
    // 这是页面里"唯一用来定位面板本体"的选择器，FLIP / 点击绑定 / 滚动联动都靠它，
    // 所以假 DOM 必须真的按选择器筛一遍，不能一律返回空数组。
    if (s.includes("#stage") && s.includes("article")) {
      return get("#stage").children.filter((c) => matchesSimple(c, "article.mod[data-slot]"));
    }
    // 其余（"[data-slot]" 之类）在真实页面里会命中一堆子元素，测试里不关心
    return [];
  };

  vm.runInContext(appSrc, sandbox, { filename: "app.js" });

  return {
    sandbox, get, cards, cardOf, winListeners,
    state: vm.runInContext("state", sandbox),
    fn: (name) => vm.runInContext(name, sandbox),
    fireResize: () => (winListeners.resize || []).forEach((fn) => fn({})),
    /** 推进定时器（只有 deferTimers: true 时才有队列可推） */
    flushTimers: runTimers,
    /** 触发某个元素上注册过的某个事件（取第一个监听器） */
    fire: (sel, type, arg) => {
      const el = get(sel);
      const fns = el.listeners[type] || [];
      fns.forEach((fn) => fn(arg || {}));
      return fns.length;
    },
  };
}
