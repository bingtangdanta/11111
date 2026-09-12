# 自检工具（可选但强烈建议保留）

这些脚本是开发时用来**抓 bug** 的，不是在页面上跑的。它们各自抓到过真实的错误，
保留在仓库里是为了以后改代码时能一键回归。

```bash
# Python 侧
python checks/lint_names.py                    # 作用域检查：未定义名 / 使用早于赋值 / 未用导入
python checks/check_encoding.py                 # 编码自检：合法 UTF-8 / 未被编码往返搞坏 / 中文短语完好
python checks/check_repo.py                    # 仓库结构 + workflow + 前端硬性约束
python checks/static_serve_test.py             # 把 docs/ 当 GitHub Pages 访问，逐条验证
python checks/verify_output.py docs/data       # 抓取产物契约（跑完 Actions 或本地抓取后校验）
python checks/verify_new_data.py               # 新增数据（可搜索库 / 评分 / 基本面 / 建议）核对
python checks/chip_parity_test.py              # 前端 chipFromKline vs 后端 chips.py 逐档对账
python checks/board_test.py                    # 板块 K 线(secid=90.BKxxxx) / 5 龙头股 / 板块筹码

# 前端侧（Node，无第三方依赖）
node   checks/frontend_test.mjs                # 指标数学 vs 独立实现 + canvas 绘图 + 悬停明细
node   checks/chip_render_test.mjs             # 筹码峰：配色 / 不拆开 / 黄线紫线定位 / 紧凑行距
node   checks/ui_features_test.mjs             # UI 需求逐条验收（过渡 / 竖屏横屏 / 搜索评分）
node   checks/portrait_test.mjs                # **真跑**：三个界面并排/竖排 + 拖到左中右 + 放大
node   checks/search_test.mjs                  # **真跑** 搜索框：评分榜 / 搜索命中 / 评分可见
node   checks/analysis_test.mjs                # **真跑** 个股分析页：K 线 / 指标 / 筹码 / 实时兜底
node   checks/sector_test.mjs                  # **真跑** 板块行情 + 板块分析页（龙头股/K线/筹码）
node   checks/review_panel_test.mjs            # **真跑** 历史股评 + 单独滚动 + 可拖边界 + 收起
node   checks/live_kline_probe.mjs             # 真实网络：腾讯日线可取（字段顺序 + CORS）
```

`checks/_fake_dom.mjs` 是五个"真跑"测试共用的极简假 DOM（约 200 行，非通用实现，
只覆盖 app.js 用到的 API；含假 canvas 2D 上下文，所以 `drawKline` 也能真跑）。
行为级测试比查字符串重要：字符串匹配挡不住"写反了也照样匹配"。

**假 DOM 只能验证逻辑**：CSS 有没有真的生效、拖拽条有没有真插进页面，只有真浏览器说了算。
所以另外用 headless Edge 的 `--dump-dom` 核对真实渲染结果：

```powershell
& "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --disable-gpu `
  --window-size=1700,1250 --virtual-time-budget=9000 --dump-dom "http://127.0.0.1:8899/" > _shots/dom-check.html
python _debug/verify_live_dom.py
```

一条命令全跑（Windows PowerShell）：

```powershell
python checks/lint_names.py; python checks/check_repo.py; python checks/verify_new_data.py;
python checks/chip_parity_test.py; python checks/board_test.py; python checks/review_test.py;
python checks/static_serve_test.py;
node checks/frontend_test.mjs; node checks/chip_render_test.mjs; node checks/ui_features_test.mjs;
node checks/portrait_test.mjs; node checks/search_test.mjs; node checks/analysis_test.mjs;
node checks/sector_test.mjs; node checks/review_panel_test.mjs; node checks/live_kline_probe.mjs
```

## 它们分别抓到过什么（都是真事）

| 工具 | 抓到的问题 |
|---|---|
| `lint_names.py` | `mobile_server.py` 用了 `os` 没导入（启动即崩）；`sources.py` 用了 `log` 没定义 logger；`fetch_data.py` 的 `has_detail` 在赋值前被使用（跑到写 JSON 才崩，整轮数据全没产出）；`fetch_data.py` 用了 `json` 没导入；Windows 控制台 GBK 打印 ✅ 直接把检查器自己崩掉 |
| `verify_output.py` | `version.json` 的 `scored` 一直是 0；页面表格里的股票没有详情文件（点进去 404） |
| `static_serve_test.py` | 前端用了绝对路径 `/api/...`（在 Pages 子路径下会 404）；缺失的 `data/*.json`；**直接拿 docs/ 测数据断言会永远假失败**（仓库里只有占位 version.json），所以改成：有演示数据就叠加后全量测，没有就只做占位校验并明确 SKIP |
| `frontend_test.mjs` | 测试桩抽取 `num()` 时截断了多行函数，导致信息行渲染成 `开 false` |
| `check_repo.py` | workflow 缺 `contents: write`（推不上数据）；`transition` 过渡缺失；占位 version.json 被真实数据覆盖；12 列 Bento / 0.3s 这类**过时断言**在需求变更后仍报错（改成断言 `--dur:.46s` + 固定三列 + 竖屏竖排） |
| `chip_render_test.mjs` | 早期版本"插分隔线拆开筹码峰"被写进断言，需求改成"不拆开、只叠加黄线/紫线"后必须同步改，否则测试变成需求的绊脚石 |
| `portrait_test.mjs` | **抓到真 bug**：`assignSlot` 做"两块互换"时只写了 `slots[other] = cur`、忘了写 `slots[i] = id`，结果同一个模块同时出现在两个界面里；还发现测试桩喂了**占位数据**时 `boot()` 会把 `#stage` 整块换成"数据尚未生成"，异步检查时看起来像"界面凭空消失" |
| `search_test.mjs` | 榜单只列**有技术面**的股票（断言写成"全部 5 只"会假失败）；代码前缀 `6034` 匹配不到 `603936`（写错前缀就变成了假需求） |
| `analysis_test.mjs` | **抓到真 bug**：分析页末尾 `positionChipLines(box, rows, cur, avg.all)` 里的 `rows/cur/avg` 是从 `fillStock` 复制过来的、在 `fillResearchOne` 里根本不存在 → 包在 `requestAnimationFrame` 里静默 ReferenceError，筹码峰永远画不出来、控制台也不显眼。另外发现"没有存档就没有 K 线"这条路径缺口 → 改成缺存档时由浏览器实时抓腾讯日线 |
| `sector_test.mjs` | 板块页在"没取到 K 线"时必须写清原因、并且**不画假图**；龙头股在 K 线缺失时仍要展示（本轮确实取到的数据不能一起藏起来） |
| `board_test.py` | `mark_source` 的签名是 `(name, ok)`（源名 + 布尔），不是"名字 + 文字描述"→ 我最初写成 `mark_source("板块K线", "东方财富(未取到)", ok=False)` 直接 TypeError；板块 K 线主机被限流时，只有靠桩函数才能验证解析与筹码拼装没写错 |
| `chip_parity_test.py` | node 打印 UTF-8 中文、Python 默认按 GBK 解码 → 子线程里 `UnicodeDecodeError`，看起来像"node 执行失败"；常量写成 `const A = 1, B = 2` 时按 `const B = ` 抽取会找不到 |
| `live_kline_probe.mjs` | 抽取函数时必须把前面的 `async ` 一起带上，否则抽出来的是含 `await` 的普通函数（SyntaxError）；腾讯字段顺序是「日期,开,**收,高,低**,量」，按 OHLCV 解析会把最高价当收盘价——所以用"低 ≤ 开/收 ≤ 高"逐根自检 |
| `_fake_dom.mjs` | 假 DOM 写 `innerHTML` 必须同时**清空 children**、`className` 必须与 `classList` 联动，否则子元素会跨渲染累加、`createElement` 出来的投放条永远查不到；`appendChild` 必须是"移动"语义（重复 append 会翻倍）；`querySelectorAll` 必须能找到**运行时 append 的子元素**（否则旧的拖拽条清不掉、越攒越多）；`data-slot` 与 `table/canvas/select` 标签也要解析 |
| `review_panel_test.mjs` | **抓到真 bug**：`filter: blur(7px)` 给大面板做"虚化"，浏览器要对整块重新栅格化（含表格与 canvas）→ 用户反馈"反而更卡了"；改成只动 opacity，并且**数据已在缓存时直接切换、不放骨架** |
| `ui_features_test.mjs` | 用 `indexOf` 切片取 `@media` 块会切到空串（文件前面还有别的同款媒体查询）→ 改成按大括号配对提取；断言里 `.shell.zoom-mode .stage` 在"去掉空白"后变成 `.shell.zoom-mode.stage`，不跟着改就是假失败；**加注释提到 "CDN" 会让"不引用 CDN"误报** → 改成查真实外链（`src=`/`href=`/`@import` 里的 http） |

## 关于 `lint_names.py`

本机装不上 pyflakes（沙箱限制），所以用标准库 `ast` 自己写了一个够用的作用域检查器：
按 module → function → nested 递归解析，import 会注册进作用域，
同一作用域内"使用行号 < 最早绑定行号"才报（推导式变量不参与顺序检查，避免误报）。

它自己也被自检过：故意写一个含"未定义名 / 早于赋值 / 未导入模块"的文件，必须全部被抓到，
否则这个检查器就是"永远通过"的摆设。
