<p align="center">
  <img src="OpenCodeGo-Dashboard-banner.svg" width="100%" alt="OpenCodeGo-Dashboard 用量助手 Banner" />
</p>

# OpenCodeGo 用量助手（油猴脚本）v0.10.0

中文 | **[English](README.md)**

在 `https://opencode.ai` 仪表盘上**全量抓取并保存用量历史**，提供**用量分析**（当天/1d/7d/30d/全部/自定义，输入输出/缓存命中率/费用）与**使用历史**。

- 页面一致：`POST /_server`，参数走 seroval JSON body（`X-Server-Id` / `X-Server-Instance` 头）。
- 内容指纹去重：`请求时间 + 输入/输出/推理/缓存读(+缓存写/模型/费用)` 相同 => 同一条记录。
- 持久历史（IndexedDB）；历史完整时全量拉取**命中历史即停止翻页**，历史不完整时翻到底并标记完整。
- 全量拉取可停止、互斥、防重复页；日志持久化；面板可拖拽调整大小并记忆；**中/英文界面**。
- 全量拉取带退级重试：页间小间隔预防连接池/限流错误；失败自动退避重试并放慢节奏，连续成功后恢复。

<p align="center">
  <img src="image/README/1786522202431.png" width="49%" alt="界面截图 1" />
  <img src="image/README/1786522229164.png" width="49%" alt="界面截图 2" />
</p>


## 文件

| 文件                             | 说明                |
| -------------------------------- | ------------------- |
| `opencodego-dashboard.user.js` | 主脚本              |
| `seroval-core.cjs`             | seroval 编解码核心  |
| `test-seroval-core.cjs`        | Node 单元测试       |
| `test-userscript.py`           | Playwright 冒烟测试 |

## 安装

1. **安装 Tampermonkey**（如果尚未安装）：
   - [Chrome 应用商店](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)
   - [Firefox 附加组件](https://addons.mozilla.org/zh-CN/firefox/addon/tampermonkey/)
   - [Edge 加载项](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)

2. **安装脚本**：
   - 点击：[**安装 OpenCodeGo 仪表盘助手**](https://raw.githubusercontent.com/HIUEETR/OpenCodeGo-Dashboard/main/opencodego-dashboard.user.js)
   - Tampermonkey 会提示你安装 → 点击**安装**

3. **登录** `https://opencode.ai`，脚本将自动激活。

脚本会在发布新版本时**自动更新**。

## 使用（数据 / 使用历史 / 日志）

- **数据页（含分析）**：
  - 刷新工作区 / **拉取全量用量**（历史完整时命中历史提前停止）/ 清空历史（需二次确认）；
  - 时间范围（当天/1d/7d/30d/全部/自定义）→ **开始分析** 或 **拉取最新并分析**；
  - 指标卡片（请求/输入/输出/推理/缓存读/缓存写/费用/缓存命中率）、按模型（含每模型缓存命中率）、按天明细、导出分析报告。
- **使用历史页**：表格化展示**近期 API 使用情况和成本**——列顺序：请求时间、模型、**输入、推理、缓存读、输出、成本($)**；
  时间格式 24 小时制 `yyyy/MM/dd HH:mm:ss`；支持时间范围（当天/1d/7d/30d/全部/自定义）、最多显示前 300 条、**导出 CSV**。
- **日志页**：复制/导出/清空。
- 面板：可拖动**四边/四角**调整大小；“清空历史”按钮清空持久数据。

## 其他

- **指纹去重**：`timeCreated | inputTokens | outputTokens | reasoningTokens | cacheReadTokens | cacheWrite5mTokens | cacheWrite1hTokens | model | cost` 相同 => 同一条。
- **持久化**：无 TTL、无过期，只有“清空历史”才删除；`complete` 标记是否完整全量。
- **命中历史即停止**：仅当历史已完整时启用——再次拉取时当前页出现与历史指纹重合的记录即停止翻页，本次新数据与历史数据按指纹合并；**历史不完整时不会提前停止**，会一直翻到底并标记完整（避免误报“历史不完整”）。
- **停止按钮**：任务进行中数据页显示 ⏹ 停止，点击立即中断并保留已拉部分。

## 测试

```powershell
node test-seroval-core.cjs
python test-userscript.py
```

## 许可证

[MIT License](LICENSE) © 2026 HIU

