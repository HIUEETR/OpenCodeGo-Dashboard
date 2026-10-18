<p align="center">
  <img src="image/README/OpenCodeGo-Dashboard-banner.svg" width="100%" alt="OpenCode 性能观测 Banner" />
</p>

# OpenCode 性能观测（油猴脚本）v1.1.0

中文 | **[English](README.md)**

在 [OpenCode Console](https://opencode.ai/console/) 上增加一块专注于模型性能的悬浮仪表盘：缓存命中率、TTFT、输出 TPS、Token 构成、费用和请求明细。官方控制台继续负责账户、账单、工作区和基础用量页面，本脚本只补充官方没有提供的分析视角。

## 功能

- 统计整个工作区的推理请求，支持按模型、供应商、成员或服务账号筛选。
- 缓存命中率：`cacheRead / (input + cacheRead + cacheWrite + cacheWrite1h)`；缺失缓存写入字段按 0 处理。
- TTFT：读取官方请求日志中的 `timeToFirstTokenMs`，展示平均值和最慢值（最大 TTFT）。
- 输出 TPS：使用第一个输出 Token 到最后一个输出 Token 的时间窗口计算，优先使用 `firstTokenAt` / `lastTokenAt`，缺失时回退到 TTFT 与请求结束时间。
- 图表：Token 构成、缓存命中率趋势、TTFT 平均/最慢、输出 TPS 平均/最慢和模型性能对比；模型表展示平均 TTFT、平均 TPS 和当前范围的总 tokens。
- 趋势图支持 50%–200% 统一缩放，性能图标题旁展示平均值与最慢值，悬浮框只显示当前图表对应的字段。图表卡片会随内容自动增高，不显示内部滚动条。
- 请求明细：状态、模型、供应商、TTFT、TPS、输入、缓存读、缓存写、输出、费用和用户；打开官方请求详情时自动关闭本面板。
- 本地归档：IndexedDB 长期保存精简后的请求指标，不受官方 30 天日志保留期限制。
- 概览卡片展示 TPS 单位；缓存写不为 0 时单独显示在缓存读之前。
- 模型表中的总 tokens 和费用支持悬浮查看组成；费用按 OpenCode Go 文档单价估算并校准到实际总费用，价格缓存 3 天。
- “同步与数据”页展示缓存的模型价格、计费时段和上下文档位；模型性能对比隐藏总 tokens 为 0 的模型。
- CSV / JSON 导出、本地化诊断日志、面板与图标位置、面板尺寸和图表缩放记忆。
- 首次打开自动识别浏览器语言：中文浏览器使用中文，其他语言统一使用英文；手动语言选择会保留。
- 界面配色、卡片层级、浮层和细滚动条与官方 OpenCode 控制台保持一致。
- 图表按钮可点击开关面板并自由拖动；点击面板外区域或按 `Escape` 关闭；面板支持八方向缩放。

## 数据来源与兼容性

脚本读取当前 OpenCode Console 的直接 HTTP API：

- `GET /console/api/user/workspaces`
- `GET /console/api/request-logs?category=inference&since=...&limit=50...`

请求日志接口需要当前工作区的 `x-org-id` 请求头，并依赖 `opencode.ai` 的同源登录 Cookie。脚本默认使用官方日志页面相同的 `limit=50`；如果服务端调整参数约束，会依次尝试 25 和 10。遇到游标失效时会自动从第一页重试一次；登录失效、权限不足、持续限流或响应结构变化时会停止同步并显示具体原因。

脚本调用的字段包括：

`startedAt`、`finishedAt`、`durationMs`、`timeToFirstTokenMs`、`firstTokenAt`、`lastTokenAt`、`inputTokens`、`outputTokens`、`reasoningTokens`、`cacheReadTokens`、`cacheWriteTokens`、`cacheWrite1hTokens`、`cost`、`model`、`provider`、`outcome`、`stream` 等。

官方控制台更新后，若接口路径或字段发生变化，请在 [Issues](https://github.com/HIUEETR/OpenCodeGo-Dashboard/issues) 中反馈诊断日志。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或兼容的 userscript 管理器。
2. 打开 [安装脚本](https://raw.githubusercontent.com/HIUEETR/OpenCodeGo-Dashboard/main/opencodego-dashboard.user.js)。
3. 在 Tampermonkey 中确认安装。
4. 登录 `https://opencode.ai/console/`，点击图表按钮打开面板。再次点击按钮或点击面板外区域即可关闭；按钮和面板边缘都可拖动。

TypeScript 只用于开发；发布产物仍是单一 `.user.js` 文件，不需要浏览器扩展开发环境，也不需要云端服务。

## 同步策略

- 第一次打开面板时拉取最近 30 天日志。
- 面板打开时立即检查增量更新；增量同步在遇到整页本地已有记录时立即停止。
- 面板可见时，每次同步完成后在顶部居中显示紧凑提示，内容为新增数量或“已是最新”。
- 控制台标签页可见期间每 10 分钟增量同步一次；页面隐藏时暂停。
- 增量同步至少回看最近 1 小时，并额外前移 5 分钟覆盖本地最新记录，通过请求 `id` 去重，降低长请求延迟落库造成的漏记风险。
- 可随时点击“立即同步”或“补齐近 30 天”。

如果超过 30 天没有打开过控制台，缺失期间的数据无法再从官方接口补回，面板会显示历史缺口提示。

## 本地数据

数据只保存在当前浏览器配置文件的 IndexedDB 中，不发送到第三方。脚本不保存请求头、响应头、IP、地区等无关字段。旧版 `ocgo-cache` 中的历史记录会以只读方式迁移一次；旧记录没有 TTFT/TPS，只参与 Token、缓存和费用统计。

可在“同步与数据”页导出筛选明细 CSV、导出完整归档 JSON，或手动清空本地历史。

## 开发

```powershell
npm install
python -m pip install -r requirements-test.txt
python -m playwright install chromium
npm run build
npm test
npm run test:e2e
npm run typecheck
```

- `npm run build`：将 `src/main.ts` 打包为根目录的 `opencodego-dashboard.user.js`。
- `npm run watch`：监听源码并持续重建 userscript。
- `npm test`：Vitest 单元测试。
- `npm run test:e2e`：构建后用 Playwright 加载本地模拟的 OpenCode Console。
- `npm run check`：类型检查加单元测试。

开发时每次重新构建后，需要在 Tampermonkey 中重新导入本地 `opencodego-dashboard.user.js`，或使用文件导入刷新脚本。

## 许可证

[MIT License](LICENSE) © 2026 HIU
