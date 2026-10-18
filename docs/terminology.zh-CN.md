# 术语规范

本文是 OpenCode Performance Lens 中用户可见文案的术语来源。界面和文档优先采用 OpenCode Console 的英文术语及其现有中文译法；OpenCode 未提供中文译法时，参考 DeepSeek API 中文文档；项目自造能力使用含义明确、可稳定复用的表达。

官方资料核对日期：2026-10-19。

## 官方来源

- OpenCode Console：<https://opencode.ai/v2/docs/console/>
- Workspace：<https://opencode.ai/v2/docs/console/workspaces/>
- Go 与用量限制：<https://opencode.ai/v2/docs/console/go/>
- Models：<https://opencode.ai/v2/docs/console/models/>
- Providers：<https://opencode.ai/v2/docs/console/providers/>
- OpenCode 中文文档：<https://opencode.ai/docs/zh-cn/>
- DeepSeek 模型与价格：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
- DeepSeek Token 用量：<https://api-docs.deepseek.com/zh-cn/quick_start/token_usage>
- DeepSeek 上下文硬盘缓存：<https://api-docs.deepseek.com/zh-cn/guides/kv_cache>

## 核心术语

| 英文来源 | 中文界面 | 英文界面 | 说明 |
| --- | --- | --- | --- |
| OpenCode Console | OpenCode Console | OpenCode Console | 产品名保持原样；不写成“官方控制台”。 |
| Console | Console | Console | 指 OpenCode Console 的页面与操作。 |
| Workspace | 工作区 | Workspace | 官方音视频和文档中的稳定概念。 |
| Member | 成员 | Member | 工作区中的人类成员。 |
| Service account | 服务账号 | Service account | 非人类工作区成员，拥有独立 API Key、用量和预算。 |
| Provider | 提供商 | Provider | 不使用“供应商”。 |
| Model | 模型 | Model | 使用模型显示名；模型 ID 保持官方值。 |
| Go / Go Plus | Go / Go Plus | Go / Go Plus | 产品名不翻译。 |
| Usage | 用量 | Usage | 指实际发生的 Token、费用或额度消耗。 |
| Usage limits | 用量限制 | Usage limits | 指官方按模型设置的限额体系。 |
| Monthly limit | 每月上限 | Monthly limit | 官方价格表中的 `Monthly limit`。 |
| 5-hour / weekly / monthly | 5 小时 / 每周 / 每月 | 5-hour / weekly / monthly | 不使用 `5h`、`24h` 作为界面窗口名。 |
| Request logs | 请求日志 | Request logs | 不使用“请求明细”。 |
| Inference | 推理 | Inference | 与 Console 的 inference 分类一致。 |
| Token | Token | tokens | 中文统一大写 Token；英文遵循官方小写 tokens。 |
| Cache hit | 缓存命中 | Cache hit | 指输入前缀命中缓存。 |
| Cache read | 缓存读取 | Cached read | 指从缓存读取的 Token。 |
| Cache write | 缓存写入 | Cached write | 指写入缓存的 Token，不等同于“缓存未命中”。 |
| Peak / Off-Peak | 高峰时段 / 空闲时段 | Peak / Off-Peak | 来自 DeepSeek 中文计费说明。 |
| Context tier | 上下文档位 | Context tier | 指按输入上下文长度划分的计价档位。 |
| Cost | 费用 | Cost | 保持简短。 |
| TTFT | TTFT | TTFT | 首 Token 延迟，Time to First Token。 |
| TPS | TPS | TPS | 输出 Token 速度，tokens per second。 |
| Forecast | 预测 | Forecast | 项目自造能力名。 |
| Usage forecast | 用量预测 | Usage forecast | 当前功能名，覆盖 5 小时、每周、每月限额和未来 24 小时用量。 |
| Highest-risk model | 风险最高模型 | Highest-risk model | 5 小时、每周、每月窗口中最高 p90 预计利用率最大的模型。 |
| p10 / p50 / p90 | p10 / p50 / p90 | p10 / p50 / p90 | 分位数缩写不翻译。 |

## 使用规则

- 界面不使用“额度预测”“最紧模型”“触顶”“供应商”“缓存读”“缓存写”等旧表达。
- “额度”只可出现在内部类型、存储键或兼容旧数据的说明中；用户界面使用“用量”“用量限制”或“限额”。
- “用户”不作为筛选器或表格实体名。筛选器同时覆盖成员和服务账号时使用“成员 / 服务账号”。
- “官方”后面的内容尽量写出具体产品名，例如“OpenCode Go 用量限制状态”和“OpenCode Console 日志保留期”。
- 未来 24 小时是预测跨度，不是官方限额窗口；不要写成“24 小时额度”。
- p10 与 p90 在本项目中是固定倍率形成的预测区间，不是历史分位数；文案统一称“预测区间”，不称“置信区间”。
- 英文避免 `model(s)`、`page(s)`、`request(s)` 等开发式复数占位，改用 `models: {n}`、`pages processed: {pages}` 等句式。
- 用户数据导出 CSV 的字段名保持稳定英文，以便脚本和表格工具持续读取。
