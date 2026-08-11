# OpenCodeGo 仪表盘助手（油猴脚本）v0.4.3

在 `https://opencode.ai` 仪表盘上查询 **OpenCode Go 套餐（5h/周/月额度）、用量与 API 调用记录**。
- **RPC 与页面一致**：`POST /_server`，参数走 seroval JSON body（`X-Server-Id` / `X-Server-Instance` 头）。
- **内容指纹去重**：`请求时间 + 输入/输出/推理/缓存读(+缓存写/模型/费用)` 完全一致 => 视为同一条记录（不依赖 id）。
- **持久缓存**：IndexedDB，**永不过期**，只有手动“清空缓存”才消失；数据滚动刷新（记录会随新增请求移动页码）靠指纹合并。
- 全量分页可停止、互斥、防重复页；分析页（当天/1d/7d/30d/自定义，输入输出/缓存命中率/费用）；日志与开关。

## v0.4.1 修复（翻页无效根因）

`usage.list` 存在两个同名但不同的服务端函数：
- `bfd684bf...` —— usage 页面真正使用的**分页**函数，参数 `[ws, page]`（当前脚本采用）
- `6262ba54...` —— NewUserSection 的 `getUsageInfo`，调用只传 `[ws]`，服务端 `offset` 变为无效值导致**永远返回第一页**（旧版误用，翻页失效）

已同步修正 `opencodego-dashboard.user.js`、`../py-opencode-go/function_ids.json`、`../py-opencode-go/rpc_client.py`。
控制台可运行 `window.__ocgo.fnIds()` 查看当前函数 ID。

## 文件

| 文件 | 说明 |
| --- | --- |
| `opencodego-dashboard.user.js` | 油猴主脚本（自包含，直接安装） |
| `seroval-core.cjs` | seroval 编解码核心（Node 可测，与 user.js 内联一致） |
| `test-seroval-core.cjs` | Node 单元测试 |
| `test-userscript.py` | Playwright 端到端冒烟测试 |
| `README.md` | 本说明 |

## 安装

Tampermonkey/Violentmonkey → 新建脚本 → 粘贴 `opencodego-dashboard.user.js` 保存（或拖入安装）→ 登录 `https://opencode.ai`。

## 使用（数据 / 分析 / 日志）

- **数据页**：自检协议 / 刷新工作区 / 一键全部 / 拉取全量用量（可停止、互斥、防重复页）/ Go套餐 / 用量(第1页) / 账单 / Keys / 支付记录 / 查看捕获 / 清空缓存。
- **分析页**：时间范围（当天/1d/7d/30d/自定义）→ 开始分析（用持久缓存，不自动发全量请求）；拉取最新并分析（先全量刷新）；导出分析报告。
- **日志页**：复制/导出/清空；最近 300 条持久化。

## 缓存逻辑（v0.4.0）

**认定（去重）**：一条记录若 `timeCreated | inputTokens | outputTokens | reasoningTokens | cacheReadTokens | cacheWrite5mTokens | cacheWrite1hTokens | model | cost` 完全相同，即视为同一条（不依赖 id）。页面捕获、全量拉取、滚动刷新都按此指纹合并。

**持久化**：缓存存 IndexedDB `ocgo-cache`，**无 TTL、无过期**，只有“清空缓存”才删除。元数据 `usage:meta:<ws>` 记录：
- `lastFullFetchAt`：最近一次全量分页抓取时间
- `lastUpdatedAt`：最近一次任何写入（含页面捕获）时间
- `complete`：是否做过完整全量抓取（页面捕获不会提升）

**滚动刷新（v0.4.3：只要有历史重合就停止）**：记录会随新请求插入而移动页码，所以：
- 再次拉取时从第 0 页开始；**当前页出现与历史指纹重合的记录 => 立即停止翻页**，不再请求后续页面，直接拿历史数据相加（不要求历史完整）；
- 本次拉到的新记录与历史缓存按指纹合并（48 新 + 2 历史 = 50 条，只发 1 次请求）；
- 历史本身完整（`complete=true`）时停止后仍标记完整；历史不完整时停止会提示“可能缺更早记录，建议清空缓存后完整拉取一次”，此时 `complete=false`；
- 没有历史时仍翻到“返回 < 50 条”为止；
- **停止按钮**：任务进行中在数据页显示（已修复 CSS `display` 覆盖问题），点击立即中断并保留已拉部分。

## RPC / 翻页（v0.4.0）

- 与页面一致：`POST https://opencode.ai/_server`，body 为 seroval 编码的参数数组，头带 `X-Server-Id`（函数ID）、`X-Server-Instance`。
- 翻页：`usage.list(ws, page)` 每页 50 条（offset = page*50），循环至返回 < 50 条；页间内容完全相同则判定分页失效停止；同一时间只允许一个全量任务，可随时停止（已拉取部分保留，标记不完整）。

## 测试

```powershell
node test-seroval-core.cjs                                            # 编解码单测
..\py-opencode-go\.venv\Scripts\python.exe test-userscript.py         # 浏览器端到端（需联网）
```

最近一次端到端（2026-08-11，v0.4.3）：POST 自检通过；**拦截 /_server 离线验证**——完整历史与不完整历史两种场景都只发 1 次请求即“命中历史提前停止”，合并 50 条；不完整历史停止后 `complete=false` 并提示；**任务进行中停止按钮可见**、结束后隐藏；无 console 错误。

## 已知限制

- 只读查询；写操作未包含。
- 函数 ID 为 2026-08-10 快照；官方更新失效时用 `../py-opencode-go/rpc_client.py --refresh-ids` 重取并同步 `FN_IDS`。
- 全量拉取上限 500 页（2.5 万条），可配 `maxUsagePages`；需真实登录才能拿工作区数据。
