/* sw.js — Service Worker：手机端"随时随地"都能打开，且不增加任何成本
 *
 * 它解决两件事：
 *   ① **弱网/无网也能打开**：第二次之后，页面外壳与上次的数据都在本地，
 *      地铁里、电梯里、飞行模式下打开都能看到上次的数据；
 *   ② **把零成本做到极致**：重复打开时页面外壳一个请求都不发，数据在后台悄悄更新。
 *
 * 缓存策略（刻意分开，别混）：
 *   · 页面外壳（html/css/js/manifest）：**cache-first** —— 秒开，后台顺手更新
 *   · version.json：**network-first** —— 必须拿到最新版本号，否则"版本闸门"会失灵
 *   · 其它 data/**.json：**stale-while-revalidate** —— 先给缓存（秒开），
 *     同时取新的放回缓存，所以 Actions 更新后**下一次**打开就是新数据
 *   · 非本站请求（腾讯日线那条）：**不拦**，交给浏览器 HTTP 缓存
 *
 * ⚠️ 数据请求失败时返回缓存（保证离线可用）；连缓存都没有才让请求失败，
 *    页面自己会显示"数据缺失"——不编。
 */

const VERSION = "v1";
const SHELL_CACHE = "ashare-shell-" + VERSION;
const DATA_CACHE = "ashare-data-" + VERSION;

//: 外壳文件（相对路径：站点可能部署在子目录，别用绝对路径）
const SHELL = ["./", "./index.html", "./m.html", "./style.css", "./app.js",
               "./m.css", "./m.js", "./manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL_CACHE);
    // 逐个 add：任何一个文件缺失也不该让整个安装失败
    await Promise.all(SHELL.map((u) =>
      c.add(new Request(u, { cache: "reload" })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function json504() {
  return new Response("{}", { status: 504,
    headers: { "Content-Type": "application/json; charset=utf-8" } });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch (_) { return; }
  if (url.origin !== self.location.origin) return;      // 外部请求一律不拦

  const isJson = /\/data\/.*\.json$/.test(url.pathname);

  // ---- version.json：network-first（版本号必须准，否则刷新按钮的闸门会失灵）----
  if (isJson && url.pathname.endsWith("/version.json")) {
    e.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch (_) {
        const hit = await cache.match(req);
        return hit || json504();
      }
    })());
    return;
  }

  // ---- 其它数据：stale-while-revalidate ----
  if (isJson) {
    e.respondWith((async () => {
      const cache = await caches.open(DATA_CACHE);
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }         // 有缓存先给（秒开/离线可用）
      const res = await net;
      return res || json504();
    })());
    return;
  }

  // ---- 页面外壳：cache-first + 后台更新 ----
  const shellLike = req.destination === "document" || /\.(css|js|json|html)$/.test(url.pathname)
                    || url.pathname.endsWith("/");
  if (shellLike) {
    e.respondWith((async () => {
      const cache = await caches.open(SHELL_CACHE);
      const hit = await cache.match(req, { ignoreSearch: true });
      const net = fetch(req).then((res) => {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const res = await net;
      return res || new Response("离线，且这份文件还没有缓存过。",
        { status: 504, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    })());
  }
});
