# OpenCodeGo 用量助手（油猴脚本）v0.6.0

在 `https://opencode.ai` 仪表盘上**全量抓取并缓存用量记录**，提供**用量分析**（当天/1d/7d/30d/自定义，输入输出/缓存命中率/费用）。
- RPC 与页面一致：`POST /_server`，参数走 seroval JSON body（`X-Server-Id` / `X-Server-Instance` 头）。
- 内容指纹去重：`请求时间 + 输入/输出/推理/缓存读(+缓存写/模型/费用)` 相同 => 同一条记录。
- 持久缓存（IndexedDB，**无过期**，仅手动清空）；滚动刷新**命中历史即停止翻页**，直接拿历史数据相加。
- 全量拉取可停止、互斥、防重复页；日志与开关。

> v0.6.0 变更：移除 Keys；**“数据”与“分析”合并为一个页面**；新增**独立用量页面**（新标签页，URL `#ocgo=usage&ws=<工作区>`）格式化展示抓取到的使用量。
> v0.5.0 已移除：自检协议、一键全部、用量(第1页)、Go套餐、账单、支付记录、查看捕获。

## 文件

| 文件 | 说明 |
| --- | --- |
| `opencodego-dashboard.user.js` | 油猴主脚本（自包含） |
| `seroval-core.cjs` | seroval 编解码核心（Node 可测，与 user.js 内联一致） |
| `test-seroval-core.cjs` | Node 单元测试 |
| `test-userscript.py` | Playwright 端到端冒烟测试 |
| `README.md` | 本说明 |

## 安装

Tampermonkey/Violentmonkey → 新建脚本 → 粘贴 `opencodego-dashboard.user.js` 保存（或拖入安装）→ 登录 `https://opencode.ai`。

## 使用（数据 / 日志）

- **数据页（含分析）**：
  - 刷新工作区 / **拉取全量用量**（可停止、互斥、命中历史提前停止）/ **打开用量页面** / 清空缓存；
  - 时间范围（当天/1d/7d/30d/自定义）→ **开始分析**（用持久缓存）或 **拉取最新并分析**（先全量刷新）；
  - 指标卡片（请求/输入/输出/推理/缓存读/缓存写/费用/缓存命中率）、按模型、按天明细、导出分析报告。
- **独立用量页面**：点击“打开用量页面”在新标签页打开 `#ocgo=usage&ws=<工作区>`，全屏格式化展示用量（读 IndexedDB 缓存，无需重新抓取）；支持切换时间范围、刷新数据、导出报告、返回仪表盘。
- **日志页**：复制/导出/清空；最近 300 条持久化；成功日志只记摘要。

## 缓存与翻页（v0.4.3 起）

- **指纹去重**：`timeCreated | inputTokens | outputTokens | reasoningTokens | cacheReadTokens | cacheWrite5mTokens | cacheWrite1hTokens | model | cost` 相同 => 同一条。
- **持久化**：无 TTL、无过期，只有“清空缓存”才删除；`complete` 标记是否完整全量（页面捕获不会提升）。
- **命中历史即停止**：再次拉取时当前页出现与历史指纹重合的记录 => 立即停止翻页，不再请求后续页，本次新数据与历史缓存按指纹合并；历史不完整时会提示“可能缺更早记录”。
- **停止按钮**：任务进行中数据页显示 ⏹ 停止，点击立即中断并保留已拉部分。
- **翻页**：`usage.list(ws, page)` 每页 50 条，直到返回 < 50 条或命中历史；整页与上一页完全相同判定分页失效停止。

## 测试

```powershell
node test-seroval-core.cjs                                            # 编解码单测
..\py-opencode-go\.venv\Scripts\python.exe test-userscript.py         # 浏览器端到端（拦截 /_server 离线验证）
```

最近一次端到端（2026-08-11，v0.6.0）：tabs 合并为“数据/日志”、无 Keys 按钮；完整/不完整历史两种场景都只发 1 次请求即“命中历史提前停止”并合并 50 条；任务中停止按钮可见、结束后隐藏；独立用量页面（`#ocgo=usage&ws=`）从缓存正确渲染格式化指标；无 console 错误。

## 已知限制

- 只读查询（全量用量）；写操作未包含。
- 函数 ID 为 2026-08-10 快照（当前仅 `workspaces` / `usage.list`）；官方更新失效时需重新抓取 bundle 提取并同步 `FN_IDS`。
- 全量拉取上限 500 页（2.5 万条），可配 `maxUsagePages`；需真实登录。
