# 系统自检 + 对标 AI 量化工具的优化报告

> 时间：2026-09-12 ｜ 对象：`ashare_pages`（量化猎人）
> 这份报告只写**查证过的东西**：每条结论后面都跟着"证据在哪"（文件/函数），
> 以及"怎么改"和"改完用什么验收"。没有证据的猜测单独标出来。

---

## 零、先看我这一轮实际查出了什么

不是"泛泛地列一堆最佳实践"，而是这轮真的动过手的地方：

| # | 问题（真实存在过的） | 影响 | 状态 |
|---|---|---|---|
| 1 | **天天基金排行接口返回 200 + `无访问权限`**：不带 `Referer: fund.eastmoney.com` 时服务端拒绝，但 HTTP 状态码是 200 | 场外 ETF 板块会静默变成"数据缺失"，谁都不知道真正原因 | ✅ 已修，并给 `get_text` 加了 `validate=` 内容校验 |
| 2 | **归档日期取的是墙上时钟**：2026-09-12（周六）跑，`trade_date` 被写成周六，日志还报"现在是盘中" | `trade_date` 是回评与历史的**键**。写错一天 → 胜率/平均涨幅算在一组不存在的日期上，**而且看起来完全正常** | ✅ 已修：改用行情自带时间戳 `f124` 定归档日；回归见 `pit_test.py` ①c |
| 3 | **`post_close_snapshot` / `as_of` 只打日志、没写进产物** | 页面无法判断"这份快照是不是收盘价"（盘中手动跑过一轮就会污染复盘） | ✅ 已修：写进 `version.json`，页面顶部明示 |
| 4 | **搜索框打字打到一半会失去焦点**：改条件时面板整块 `innerHTML` 重建，输入框被销毁 | "打几个字 → 停一下 → 再打"就打不进去了，用户只会觉得搜索框坏了 | ✅ 已修（`keepFocus`），并有行为断言 |
| 5 | 幽灵卡依赖 `animation.finished` 结算后才移除 | 后台标签页/虚拟时间下不结算 → 幽灵卡永久浮在页面上挡内容 | ✅ 已修：加定时兜底 + 真机验证 `ghosts` 归零 |
| 6 | 放大/还原时另外两块**瞬间消失** | 视觉上"闪一下"，用户明确要求优化这段过渡 | ✅ 已重写（幽灵卡收进切换条 / 从切换条长回格子） |
| 7 | `--r` 这个 CSS 变量根本不存在（只有 `--r-card`/`--r-el`） | 圆角静默失效 | ✅ 已修（`.zoomghost` 用 `--r-card`） |
| 8 | **`[data-slot]` 被当成"界面卡片"，但它一次命中 5 个元素**（竖排按钮、面板、模块下拉、‹、›） | FLIP 的 Map 键是 `data-slot`，**同键互相覆盖**，最后留下 `›` 按钮的 26×26 → 面板被按 26px 的"旧位置"缩放（scale≈0.05），两个箭头拿到别人的 rect、缩放比高达 21 倍。**用户报的"顶部两个箭头大小异常"就是这个** | ✅ 已修：新增唯一入口 `PANEL_SEL / panelEl / panelOf`，界面内部控件改用 `data-panel`；回归见 `checks/panel_selector_test.mjs` |
| 9 | 放大模式的头部与左侧列表**都带 `data-pick="${i}"`** | 同一个键两个元素，FLIP 又互相覆盖 → "上方下拉 ↔ 左侧列表"过渡时两个元素都从同一个位置飞过来 | ✅ 已修：头部不再带 `data-pick`（真正的选择器只有左侧列表） |
| 10 | FLIP 在动画**进行中**量位置 | 动画中途 `getBoundingClientRect()` 返回的是缩放中的尺寸，拿它当"旧位置"会让缩放比**层层累积** → 连续快速换模块时面板越变越大 | ✅ 已修：量之前先 `getAnimations().cancel()` |
| 11 | `playFlip` / `playPickFlip` 不看 `prefers-reduced-motion` | 开了"减少动画"的用户照样吃位移/缩放动画（无障碍问题）；顺带导致"最终布局"没法测量 | ✅ 已修：两个函数都尊重该设置（直接落终态） |
| 12 | **手机版长期没有一条自动化断言** | 于是它悄悄落后电脑版好几轮：没场外 ETF、没历史股评、选股页把 5900 只全市场说成"共精算 5900 只"、评级汇总只显示股票代码 | ✅ 已补齐 `checks/mobile_test.mjs`（43 条）并把缺的板块补上 |
| 13 | **手机版"过期渲染"**：`show()` 每次都"写加载中 → await 取数 → 写内容" | 手机上数据有快有慢，点得快时**先点的那一页后返回，把后点的那页盖掉**（点了板块却显示选股） | ✅ 已修：递增序号 + 只有最后一次切换能写 DOM |
| 14 | **测试假 DOM 的 `querySelectorAll` 把解析出的子元素原样返回（不筛选择器）** | `querySelectorAll("table")` 会把表格里的龙头股标签也返回，`enhanceTables()` 拿它的 `parentNode` 直接抛错 —— 手机版测试一加就暴露了 | ✅ 已修：解析出的子元素也要过选择器，标签名从 HTML 里读（不再一律当 span） |

---

## 一、还**没修**的弱点（按优先级，逐条给改法）

### P0-0 属性命名与"整块动画"仍在同一个命名空间里混用（已修，但值得记一笔方法）

第 8/9/10 条那三个 bug 有个共同点：**它们都不是"某个函数写错了"，
而是"同一个标识符被赋予了两种含义"**（`data-slot` 既是"界面卡片"又是"界面内部控件"，
`data-pick` 既是"顶部下拉"又是"左侧列表"）。
这类 bug 静态读代码很难发现，因为每一处单独看都"说得通"。
有效的做法是：**给每个"要被整体操作的东西"一个专属选择器**，
并且让测试直接断言"这个选择器只命中一种元素"（`checks/panel_selector_test.mjs` 就是这么做的：
把同名元素塞进 DOM，跑一遍 renderShell，检查被动画的元素里没有按钮）。

> 结论：以后再加"带 data-* 的控件"时，先问一句"它会不会被某个 `querySelectorAll` 顺带捞走"。

### P0-1 没有"假设卡 + 闸门"——发现问题的方式目前主要靠我盯着看

- **证据**：`checks/` 下 20 套测试全是"实现是否按我写的做"（`frontend_test`、`portrait_test`…），
  **没有一条是"这个策略假设如果不成立，会看到什么"**。
- **为什么这是 P0**：本轮 7 个 bug 里有 4 个（#1/#2/#3/#4）都属于"代码没报错、数据也没报错，
  但结论是错的"。这类 bug 只能靠**假设卡**抓：每条假设写清"预期看到什么 / 什么情况算证伪"，
  再变成一条断言。
- **改法**（具体到函数）：
  1. 新增 `checks/hypotheses.md` + `checks/hypothesis_test.py`：每条假设一个 dict
     `{id, 假设, 预期, 证伪条件, 检查方式}`，`checks/verify_output.py` 里对产物跑一遍。
  2. 先落 3 条最值钱的：
     - `H1 动量有效`：`score` 分 5 档，次日收益应单调（证伪：单调性 < 3 档或最高档跑输最低档）
     - `H2 资金有效`：`main_net_ratio` 的 RankIC 应为正且 |IC| > 0.02
     - `H3 风险项有效`：带风险标记的样本次日收益应显著低于全样本
- **验收**：`python checks/hypothesis_test.py <产物目录>`，输出每条的"成立 / 证伪 / 样本不足"。
  样本不足时**必须输出"样本不足"而不是"通过"**（这点最容易自欺）。

### P0-2 因子是否有效从来没被检验过：没有 IC / RankIC / 分组回测

- **证据**：`scripts/scoring.py:WEIGHTS_V2 = {trend:26, fund:22, chip:16, inst:16, sector:12, base:8}`
  —— 这组权重是**手拍的**，没有任何数据支撑；`WEIGHTS_V2` 注释里也只写了"为什么这么设计"，
  没有写"验过没有"。全仓搜索 `rank_ic|spearman|IC` 只命中 `sources.py` 里一句注释。
- **对标**：Qlib 把「因子 → IC 分析 → 模型 → 组合 → 回测」做成标准流水线
  （[hands-on-qlib](https://github.com/Daryl9441/hands-on-qlib)、
  [Qlib 框架：因子定义层/IC 分析/回测](http://www.chinadongda.com/j/?weixin_51589123/article/details/160479796)）。
  我们只有"因子 → 打分"，中间缺了检验环节。
- **改法**：
  1. `scripts/fetch_data.py` 每轮存一份**因子快照**（`factors/<date>.json`）：
     对当日精算池输出每只的原始因子值（`main_net_ratio/super_ratio/ret_20d/profit_ratio/hhi/
     rating_score/survey_orgs/industry_chg_rank/fund_score`）+ 次日收益占位。
  2. `_update_stock_review()` 回填次日收益后，新增 `scripts/factor_ic.py`：
     算每个因子的 **RankIC（Spearman，纯 stdlib 实现）**、IC 均值/标准差/**ICIR**、
     以及**分 5 档的次日平均收益**。
  3. 产物 `factor_ic.json`（按日期累积，只留最近 60 期）。
- **验收**：页面「复盘看板」加一张 IC 表（因子 / 近 20 期 IC 均值 / ICIR / 单调性），
  并在某个因子 ICIR < 0.2 时标注"该因子近期无效"。
- **注意**：单日 IC 噪音极大，**少于 20 期不要下结论**（这条要写在页面上）。

### P0-3 全市场评分（已完成）

这一条是上一轮做的（`_universe_payload`/`_screen_payload` 全量 + `score_light`），
留在这里是为了说明"路线图里 P0 已经完成了 1/4"。

### P0-4 回评假设不严谨：缺可交易性过滤、缺成本、缺基准

- **证据**：`scripts/fetch_data.py:_update_stock_review()` ——
  回评直接取**次日快照的 `change_pct`**（即 T+1 收盘 / T 收盘 − 1），
  并且**没有剔除**"次日一字涨停买不进"的样本；`review.json` 的 note 只写了"不含手续费"，
  没有把成本做成参数，也没有相对沪深 300 的超额。
- **为什么严重**：这是 A 股量化最经典的坑——
  涨停/一字板在回测里会贡献"买不到的收益"
  （[一字板无法撮合缺陷](https://licai.cofool.com/user/guide_view_3398565.html)、
  [A股可交易性约束审计](https://github.com/quantskills/skill-a-share-tradability-auditor)、
  [涨跌停与停牌陷阱](https://blog.will.sc.cn/Quant/%E5%9B%9E%E6%B5%8B%E9%99%B7%E9%98%B1/21-%E6%B6%A8%E8%B7%8C%E5%81%9C%E4%B8%8E%E5%81%9C%E7%89%8C/)）。
  另外"T 日收盘选股、按 T 日收盘价买入"本身不可执行（收盘那一刻你已经在排队了）。
- **改法**：
  1. `_update_stock_review()` 增加**可执行口径**：默认改成
     **T+1 开盘买入 → T+2 开盘卖出**（用快照无法拿到 T+1 开盘价，那就退一步：
     明确写清"这是收盘对收盘的口径，实盘还要再扣掉隔夜跳空"），
     并在 `review.json` 里加字段：`assumed_entry`、`assumed_exit`。
  2. 剔除/单列**不可成交样本**：次日 `change_pct` 达到涨停幅度（主板 10%、创业/科创 20%、
     北交所 30%、ST 5%）且当日 `amount` 极低 → 标记 `untradable: true`，
     **从胜率里剔除并单独显示"不可成交 N 只"**（不许悄悄算进胜率）。
  3. 加**成本参数**：`ASHARE_COST_BP`（默认双边 20bp：佣金+印花税+滑点），
     页面同时给"毛收益 / 净收益"。
  4. 加**基准**：同期沪深 300 涨跌幅（`index_kline.json` 已有），给出**超额收益**。
- **验收**：`checks/review_test.py` 加断言：`untradable` 样本不进胜率分母；
  `net_change = gross - cost_bp/10000*100`；基准缺失时写"基准数据缺失"而不是留空。

### P1-1 没有任何"文本 → 结构化"的能力（研报正文、公告、新闻情绪）

- **证据**：`sources.reports()` / `org_survey()` 只取结构化字段（评级、目标价、机构家数），
  研报**正文与摘要完全没用**。全仓没有 NLP/关键词/情绪相关代码。
- **对标**：FinGPT / TradingAgents 这类项目的核心卖点就是"把新闻/研报变成可交易信号"
  （[TradingAgents 多智能体](https://toolbrain.net/blog/tauric-tradingagents-review-2026/)、
  [AI炒股项目调研](http://zevenfang.github.io/2026/04/16/AI%E7%82%92%E8%82%A1%E9%A1%B9%E7%9B%AE%E5%A4%A7%E8%B0%83%E7%A0%94-8%E4%B8%AA%E4%BB%A3%E8%A1%A8%E6%80%A7%E4%BA%A7%E5%93%81%E4%B8%8E%E5%BC%80%E6%BA%90%E9%A1%B9%E7%9B%AE,%E8%B0%81%E6%9B%B4%E9%80%82%E5%90%88%E4%BD%A0/#%E4%B9%9D%E3%80%81%E6%88%91%E7%9A%84%E6%9C%80%E7%BB%88%E5%88%A4%E6%96%AD)）。
- **为什么我们不该直接上 LLM**：免费额度有限、调用有延迟、结果不可复现，
  而且**一旦把不可复现的东西混进评分，回测就没意义了**。
- **改法（分两步，先规则后可插拔）**：
  1. 规则版（零依赖、可复现）：`scripts/textsignals.py`
     —— 研报标题 + 机构调研问答里的**关键词表**（业绩预增/中标/回购/减持/立案/商誉…），
     输出 `{code, date, signals:[{tag, dir, hit}], score}`，只作为**独立的一栏**展示，
     **先不进 `score`**（进了就必须先过 P0-2 的 IC 检验）。
  2. 可插拔 LLM：环境变量 `ASHARE_LLM_ENDPOINT/KEY` 存在时才启用，
     产物里记录 `extractor: "rule-v1" | "llm:<model>"`，**两种来源不许混在一列里**。
- **验收**：`checks/text_test.py`：关键词命中正确、无关键词返回空、LLM 未配置时自动走规则版。

### P1-2 前端缺少"检验面板"（IC / 分组收益 / 累计胜率曲线）

- **证据**：`docs/app.js` 的 `review`（历史股评）只显示胜率、平均涨幅、最好最差四组数
  （`fillReview`），**没有曲线、没有分布、没有对照组**。
- **改法**：`fillReview` 增加：近 20 期胜率折线（canvas，复用 `mountKline` 的绘图工具）、
  "Top 12 平均涨幅 vs 全市场平均涨幅"两条对照柱子。数据全部来自 P0-2 的产物。
- **验收**：`review_panel_test.mjs` 加断言：有 canvas、两组数字都渲染、数据缺失时显示"样本不足"。

### P1-3 没有做行业/市值中性化

- **证据**：`scoring.score_stock_v2` 的 6 个维度里，只有 `industry_chg_rank`
  是"行业内分位"（局部中性化），资金/筹码仍用**全市场**百分位。
- **后果**：某个行业普涨的日子，该行业股票会**集体**高分 —— 你以为在选个股，其实在押行业；
  小市值股票在资金维度上也系统性地占优。
- **改法**：`build_distributions()` 增加按 `industry` 分组的分布
  （`build_distributions(rows, key, group_by="industry")`），资金/筹码维度优先用**行业内百分位**，
  行业内样本 < 20 只时退回全市场并在 `detail` 里注明。
- **验收**：`checks/scoring_test.py` 新增：构造"某行业整体 +20%"的假数据，
  断言该行业内部排序仍然有区分度（不是所有股票都拿满分）。

### P2-1 只输出"排名"，没有组合构建

- **证据**：`_screen_payload` 的 `top` 就是"评分最高的 12 只"，**没有权重**，
  也没有相关性/行业集中度约束。用户拿到的是一个等权列表。
- **对标**：Qlib 有独立的 `portfolio strategy` 层（风险预算、持仓约束、换手控制）。
- **改法**：`scripts/portfolio.py`：先算 top 候选两两 60 日收益相关性
  （K 线已在 `stock/*.json` 里，无需新请求），输出
  ①行业集中度（前 3 行业占比）②候选间平均相关性 ③一个可选的"相关性 < 0.7 + 行业上限 30%"
  的稀疏等权组合。**只做提示，不自动下单。**
- **验收**：`checks/portfolio_test.py`：高相关输入会被降到 <=2 只、行业上限生效。

### P2-2 权重重整应当**由数据决定**，而不是我改数字

- **改法**：等 P0-2 有了 ≥ 20 期因子快照后，用 **IC 加权**（或简单的 IC 符号一致性）
  生成一版候选权重，与现权重**并排回测**，把对比表写进报告，由人决定是否切换。
  在样本不足之前**不许改权重**。

### P2-3 性能与体积（用户明确要求"系统流畅"）

- **现状（实测）**：`screen.json` 2.1 MB + `universe.json` 3.8 MB ≈ 6 MB，
  首屏一次性下载；筛选表分页 80 行（`SCREEN_PAGE`），暂无卡顿；
  搜索是 `rows.filter(includes)` 全表线性扫描（5900 行，可接受）。
- **可优化项**：
  1. 搜索框只在输入 >= 2 字符时才全表扫描，否则只扫前 500 行 + 前缀索引；
  2. `universe.json` 瘦身：只保留 `code/name/industry/score/score_light/advice` 六个字段
     （现在每行带十几个字段），预计能省一半；
  3. 分页已够用，**不要上虚拟滚动**（收益小、复杂度高、容易引入新的滚动 bug）。
- **验收**：`node checks/frontend_test.mjs` + 真机 `?debug=1` 的 `pageScrolls=false` 保持不回归。

### P2-4 数据质量没有"分数"，源故障没有跨日趋势

- **证据**：`common._health` 只在**进程内**记账，跨轮不保留；
  `version.json.sources` 只有"这一轮用了什么源"，没有"这轮哪个源挂了"。
- **改法**：`_write_version` 里补 `quality: {items: {涨停池: ok, 龙虎榜: ok, 场外基金: ok…}, score: 0~100}`，
  低于阈值时页面顶部挂横幅。历史累积到 `history.json`，就能看出"某个源最近三天都不稳定"。
- **验收**：`verify_output.py` 断言 `quality.score` 存在且 0~100，缺失项列表非空时有说明。

### P2-5 模块级可变状态要防"顺序写反"

- **证据**：这一轮我加了 `sources._LAST_QUOTE_TS`（行情时间戳），
  它**只有先调 `market_snapshot()` 再调 `last_snapshot_quote_time()` 才有值**。
  顺序写反会静默退回墙上时钟 —— 又回到 bug #2。
- **改法**：`market_snapshot()` 已经在入口把 `_LAST_QUOTE_TS` 清零；
  再加一条 lint：`checks/lint_names.py` 里检查"`last_snapshot_quote_time()` 的调用点必须在
  `market_snapshot()` 之后"。同时 `pit_test.py` 断言"未取数时返回 None"（已加）。

---

## 二、对标：主流 AI 量化工具在做而我们没做的

| 能力 | 他们怎么做 | 我们现在 | 结论 |
|---|---|---|---|
| 因子库 | Qlib `Alpha158/Alpha360`，一行配置几百个因子 | 手写 ~12 个原始因子 | 不需要 158 个，但**每个因子都该有 IC 记录** → P0-2 |
| 因子检验 | IC / RankIC / ICIR / 分组收益，Qlib 内置 | **完全没有** | 最该补的一块 → P0-2 |
| 自动化研发 | 微软 RD-Agent：假说 → 实现 → 回测 → 反馈闭环 | 靠我人工发现（这轮 7 个 bug 就是人工发现的） | 落"假设卡 + 闸门" → P0-1 |
| 模型层 | LightGBM/LSTM 等机器学习打分 | 线性加权（可解释） | **暂不引入**：几百个样本训练模型必然过拟合，且不可解释 → 明确不做 |
| 组合层 | 风险预算、相关性约束、换手控制 | 只输出排名 | 做轻量版 → P2-1 |
| 回测层 | 事件驱动撮合、成本、滑点、涨跌停撮合限制 | 只有"次日收盘涨跌幅"回评 | 补可交易性/成本/基准 → P0-4 |
| 文本/情绪 | FinGPT、TradingAgents 用 LLM 读新闻研报 | 只用结构化字段 | 先上规则版，再留 LLM 插口 → P1-1 |
| 多智能体辩论 | TradingAgents：多头/空头/风控角色互相反驳 | 单一加权分 | **降级借鉴**：给每只票生成一段"反方观点"（列出它得分低/有风险的维度），零 LLM 成本 |
| 可复现性 | 学术界反复批评多智能体方案不可复现 | 规则化、纯 stdlib、产物可溯源 | **这是我们的优势，别丢** |

**一句话总结我们的位置**：
在"数据采集 + 可解释打分 + 零依赖部署"这三件事上，我们比大多数开源 AI 炒股项目做得更扎实
（它们多数跑在本地、要 GPU、要 API Key、结果不可复现）；
但在**"因子有效性检验"和"可交易性回测"**这两件事上，我们是明显缺课的 ——
而这两件事恰好决定了"评分到底有没有用"。

---

## 三、路线图（建议按这个顺序做）

| 优先级 | 事项 | 主要改动 | 验收 |
|---|---|---|---|
| P0-4 | 可交易性过滤 + 成本 + 基准（**先做这个**，因为它直接影响"胜率是不是真的"） | `fetch_data._update_stock_review`、`review_test.py` | 不可成交样本单列；净收益 = 毛收益 − 成本；基准缺失要显式说明 |
| P0-2 | 因子快照 + RankIC / 分组收益 | 新增 `scripts/factor_ic.py`、`factors/*.json` | `factor_ic.json` 有 IC/ICIR/分组收益；样本 < 20 期时显示"样本不足" |
| P0-1 | 假设卡 + 闸门 | 新增 `checks/hypotheses.md`、`hypothesis_test.py` | 每条假设输出"成立/证伪/样本不足"三态 |
| P1-2 | 检验面板（IC 表 + 胜率折线 + 对照组） | `docs/app.js:fillReview` | `review_panel_test.mjs` 断言 |
| P1-1 | 规则版文本信号（预留 LLM 插口） | 新增 `scripts/textsignals.py` | `text_test.py`；未配置 LLM 时走规则版 |
| P1-3 | 行业内中性化（资金/筹码） | `scoring.build_distributions` / `score_stock_v2` | `scoring_test.py` 行业普涨场景 |
| P2-1 | 组合构建（相关性 + 行业上限） | 新增 `scripts/portfolio.py` | `portfolio_test.py` |
| P2-4 | 数据质量分 + 源健康度跨轮 | `fetch_data._write_version` | `verify_output.py` |
| P2-2 | 权重重整（**等 IC 样本足够再做**） | `scoring.WEIGHTS_V2` | 并排对比表，不自动切换 |
| P2-3 | 数据瘦身 / 搜索优化 | `_universe_payload`、`screenFilteredRows` | 真机 `?debug=1` 不回归 |

---

## 四、明确**不做**的（以及为什么）

1. **不上机器学习模型打分**：目前每天只有 12 个样本、几十期历史。
   在这个样本量上训练模型，等于把噪音拟合进权重（
   [为什么 90% 的回测都是幻觉](https://m.pinggu.org/bbs/thread-16327885-1-1.html)、
   [回测很赚钱实盘为什么亏：7 个陷阱](https://cloud.tencent.com.cn/developer/article/2698583)）。
2. **不做盘中刷新**（用户明确要求，且静态站点没有后端）。
3. **不把 LLM 输出直接混进评分列**：不可复现的信号一旦进分数，回测结论就失去意义。
   它会先作为**独立一栏**存在，等 IC 检验通过再说。
4. **不做"AI 预测明天涨跌"这类话术**：我们的定位是"把盘后数据整理清楚 + 给出可解释的倾向"，
   不是预测。页面上的每一句结论都要能指回一个字段。
5. **不为了让页面好看而合成数据**：拿不到就写"数据缺失"（例如板块 K 线被限流时页面直接写"本轮没取到"）。

---

## 五、这轮回归证据（跑过的测试）

```
node checks/*.mjs            9 套全过（含新增 zoom_tx_test.mjs）
python checks/*.py           9 套全过（含 pit_test 新增 ①c 段）
python checks/verify_output.py _demo4/data     失败项 0
真机 headless Edge：
  ?expseq=1,1  → 放大瞬间 ghosts=2、动画结束后 ghosts=0、还原后 gutters=2 collapsed=0
  ?slots=funds,screen,sectors → 三块都能自己滚（canScrollY=true）、页面不整页滚
```
