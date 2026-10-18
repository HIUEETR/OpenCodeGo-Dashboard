<p align="center">
  <img src="image/README/OpenCodeGo-Dashboard-banner.svg" width="100%" alt="OpenCode Performance Lens Banner" />
</p>

# OpenCode Performance Lens (Userscript) v1.1.0

**[中文](README.zh-CN.md)** | English

Adds a performance-focused floating dashboard to the [OpenCode Console](https://opencode.ai/console/): cache hit rate, TTFT, output TPS, token mix, cost, and request-level details. The official console remains responsible for account, billing, workspace, and baseline usage views.

## Features

- Workspace-wide inference analytics with model, provider, member, and service-account filters.
- Cache hit rate: `cacheRead / (input + cacheRead + cacheWrite + cacheWrite1h)`; missing write buckets count as zero.
- TTFT from the official `timeToFirstTokenMs` field, shown as the average and the slowest sample.
- Output TPS measured from the first output token to the last output token. Uses `firstTokenAt` / `lastTokenAt` when available and falls back to TTFT plus request completion time.
- Charts for token mix, cache hit rate, TTFT average/slowest, output TPS average/slowest, and model performance. Model rows show average TTFT and TPS plus total tokens for the selected range.
- Unified 50%–200% chart zoom, average/slowest summaries beside performance chart titles, and chart-specific hover details. Chart cards grow with their content instead of showing nested scrollbars.
- Request table with status, model, provider, TTFT, TPS, input, cache read/write, output, cost, and user, plus deep links to official request details. The panel closes automatically when a detail link is opened.
- Local IndexedDB archive that keeps compact request metrics beyond the official 30-day log retention window.
- Overview cards show the TPS unit directly, and cache write gets its own card before cache read when nonzero.
- Model table total tokens and cost expose hover breakdowns. Cost categories use OpenCode Go documentation prices, normalized to the actual total and cached for three days.
- The Sync & Data tab shows the cached model pricing, billing periods, and context tiers; model performance tables omit models with zero total tokens.
- CSV/JSON export, localized diagnostics, remembered panel, launcher, and chart-zoom state.
- Browser language is detected on first use: Chinese locales use Chinese and all others use English. Manual language choices are remembered.
- Colors, card layers, overlays, and thin scrollbars match the official OpenCode Console theme.
- The chart launcher toggles the panel and can be dragged. Clicking outside the panel or pressing `Escape` closes it, and the panel supports eight-direction resizing.

## Data source and compatibility

The script uses the current direct HTTP API of OpenCode Console:

- `GET /console/api/user/workspaces`
- `GET /console/api/request-logs?category=inference&since=...&limit=50...`

The request-log endpoint requires the current workspace in `x-org-id` and relies on the same-origin `opencode.ai` session cookie. The script defaults to `limit=50`, matching the official logs page, then falls back to 25 and 10 if the server changes parameter constraints. If the cursor expires, it restarts once from page one. Session expiry, missing permission, persistent rate limiting, or contract changes stop sync with a visible reason.

The API fields used by the script include:

`startedAt`, `finishedAt`, `durationMs`, `timeToFirstTokenMs`, `firstTokenAt`, `lastTokenAt`, `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheWrite1hTokens`, `cost`, `model`, `provider`, `outcome`, and `stream`.

If the console changes these routes or fields, include the diagnostics log in a [GitHub issue](https://github.com/HIUEETR/OpenCodeGo-Dashboard/issues).

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) or another compatible userscript manager.
2. Open the [userscript](https://raw.githubusercontent.com/HIUEETR/OpenCodeGo-Dashboard/main/opencodego-dashboard.user.js).
3. Confirm installation in Tampermonkey.
4. Sign in to `https://opencode.ai/console/` and click the chart launcher. Click it again or click outside the panel to close it; both the launcher and every panel edge can be dragged.

TypeScript is build-time only. The release artifact remains a single `.user.js` file and needs no browser-extension development setup or cloud service.

## Sync behavior

- The first panel open fetches the last 30 days.
- Opening the panel immediately checks for incremental updates; incremental sync stops as soon as a page contains only locally cached records.
- While the panel is visible, each completed sync shows a compact top-center toast with the added record count or an up-to-date message.
- While the console tab is visible, incremental sync runs every 10 minutes; it pauses when the page is hidden.
- Incremental sync re-scans at least the last hour, plus five minutes before the latest local record, and deduplicates by request `id` to reduce gaps from long-running or delayed log writes.
- “Sync now” and “Backfill 30 days” can be triggered manually.

If the console is not opened for more than 30 days, the missed period cannot be recovered from the official API. The panel reports a history gap.

## Local data

Data stays in the current browser profile’s IndexedDB and is not uploaded to third parties. Request and response headers, IP, and location data are not stored. Legacy `ocgo-cache` records are imported once in read-only mode; they have no TTFT/TPS and only contribute to token, cache, and cost analytics.

Use the Sync & Data tab to export filtered CSV, export the full archive as JSON, or clear local history.

## Development

```powershell
npm install
python -m pip install -r requirements-test.txt
python -m playwright install chromium
npm run build
npm test
npm run test:e2e
npm run typecheck
```

- `npm run build`: bundles `src/main.ts` into the root `opencodego-dashboard.user.js`.
- `npm run watch`: rebuilds the userscript on source changes.
- `npm test`: Vitest unit tests.
- `npm run test:e2e`: builds and runs Playwright against a local mock of OpenCode Console.
- `npm run check`: typecheck plus unit tests.

After a local rebuild, re-import the generated userscript in Tampermonkey or refresh it through the file import flow.

## License

[MIT License](LICENSE) © 2026 HIU
