// ==UserScript==
// @name         OpenCode 性能观测
// @namespace    opencodego-dashboard
// @version      1.1.0
// @description  缓存命中率、TTFT、TPS 与 OpenCode 控制台用量可视化；本地长期归档。
// @author       hiu
// @match        https://opencode.ai/console/*
// @run-at       document-start
// @grant        none
// @noframes
// @homepageURL  https://github.com/HIUEETR/OpenCodeGo-Dashboard
// @supportURL   https://github.com/HIUEETR/OpenCodeGo-Dashboard/issues
// @updateURL    https://raw.githubusercontent.com/HIUEETR/OpenCodeGo-Dashboard/main/opencodego-dashboard.user.js
// @downloadURL  https://raw.githubusercontent.com/HIUEETR/OpenCodeGo-Dashboard/main/opencodego-dashboard.user.js
// ==/UserScript==
"use strict";
(() => {
  // src/analytics.ts
  var MINUTE = 6e4;
  var HOUR = 60 * MINUTE;
  var DAY = 24 * HOUR;
  function cacheHitRate(record) {
    const denominator = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + (record.cacheWrite1hTokens ?? 0);
    return denominator > 0 ? record.cacheReadTokens / denominator : null;
  }
  function totalTokenCount(metrics) {
    return metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens + metrics.outputTokens;
  }
  function computeTtft(record) {
    if (record.outcome !== "succeeded" || !record.stream) return null;
    const value = record.timeToFirstTokenMs;
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function computeTps(record) {
    if (record.outcome !== "succeeded" || !record.stream || record.outputTokens <= 0) return null;
    const start = typeof record.firstTokenAt === "number" && Number.isFinite(record.firstTokenAt) ? record.firstTokenAt : typeof record.timeToFirstTokenMs === "number" && Number.isFinite(record.timeToFirstTokenMs) ? record.startedAt + record.timeToFirstTokenMs : void 0;
    const fallbackEnd = record.finishedAt ?? (record.durationMs > 0 ? record.startedAt + record.durationMs : void 0);
    const end = typeof record.lastTokenAt === "number" && Number.isFinite(record.lastTokenAt) ? record.lastTokenAt : fallbackEnd;
    if (start === void 0 || end === void 0 || end <= start) return null;
    const seconds = (end - start) / 1e3;
    return seconds > 0 ? record.outputTokens / seconds : null;
  }
  function emptySummary() {
    return {
      requests: 0,
      succeeded: 0,
      failed: 0,
      successRate: null,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      cacheHitRate: null,
      costUsd: 0,
      ttftAvg: null,
      ttftSlowest: null,
      ttftSamples: 0,
      tpsAvg: null,
      tpsSlowest: null,
      tpsSamples: 0
    };
  }
  function newAccumulator() {
    return { metrics: emptySummary(), ttftSum: 0, ttftSlowest: null, tpsSum: 0, tpsSlowest: null };
  }
  function addRecord(accumulator, record) {
    const metrics = accumulator.metrics;
    metrics.requests += 1;
    if (record.outcome === "succeeded") metrics.succeeded += 1;
    else metrics.failed += 1;
    metrics.inputTokens += record.inputTokens;
    metrics.outputTokens += record.outputTokens;
    metrics.reasoningTokens += record.reasoningTokens;
    metrics.cacheReadTokens += record.cacheReadTokens;
    metrics.cacheWriteTokens += record.cacheWriteTokens + record.cacheWrite1hTokens;
    metrics.totalTokens = totalTokenCount(metrics);
    metrics.costUsd += record.costUsd;
    const ttft = computeTtft(record);
    if (ttft !== null) {
      metrics.ttftSamples += 1;
      accumulator.ttftSum += ttft;
      accumulator.ttftSlowest = accumulator.ttftSlowest === null ? ttft : Math.max(accumulator.ttftSlowest, ttft);
    }
    const tps = computeTps(record);
    if (tps !== null) {
      metrics.tpsSamples += 1;
      accumulator.tpsSum += tps;
      accumulator.tpsSlowest = accumulator.tpsSlowest === null ? tps : Math.min(accumulator.tpsSlowest, tps);
    }
  }
  function finishSummary(accumulator) {
    const metrics = accumulator.metrics;
    metrics.successRate = metrics.requests > 0 ? metrics.succeeded / metrics.requests : null;
    metrics.cacheHitRate = cacheHitRate(metrics);
    metrics.ttftAvg = metrics.ttftSamples > 0 ? accumulator.ttftSum / metrics.ttftSamples : null;
    metrics.ttftSlowest = accumulator.ttftSlowest;
    metrics.tpsAvg = metrics.tpsSamples > 0 ? accumulator.tpsSum / metrics.tpsSamples : null;
    metrics.tpsSlowest = accumulator.tpsSlowest;
    return metrics;
  }
  function matchesFilters(record, filters) {
    if (filters.model && record.model !== filters.model) return false;
    if (filters.provider && record.provider !== filters.provider) return false;
    if (filters.userKey) {
      if (filters.userKey.startsWith("account:")) {
        if (record.serviceAccountID !== filters.userKey.slice("account:".length)) return false;
      } else if (filters.userKey.startsWith("user:")) {
        if (record.userID !== filters.userKey.slice("user:".length)) return false;
      }
    }
    return true;
  }
  function localBucketStart(timestamp, bucketMs, anchor = 0) {
    const date = new Date(timestamp);
    if (bucketMs >= DAY) {
      date.setHours(0, 0, 0, 0);
      const days = Math.max(1, Math.round(bucketMs / DAY));
      const anchorDate = new Date(anchor);
      anchorDate.setHours(0, 0, 0, 0);
      const offsetDays = Math.floor((date.getTime() - anchorDate.getTime()) / DAY);
      return anchorDate.getTime() + Math.floor(offsetDays / days) * days * DAY;
    }
    if (bucketMs >= HOUR) {
      date.setMinutes(0, 0, 0);
      return date.getTime();
    }
    date.setSeconds(0, 0);
    const remainder = date.getMinutes() % Math.max(1, Math.round(bucketMs / MINUTE));
    date.setMinutes(date.getMinutes() - remainder);
    return date.getTime();
  }
  function averageBucketMetric(buckets, select) {
    let sum = 0;
    let count = 0;
    for (const bucket of buckets) {
      const value = select(bucket);
      if (value === null || !Number.isFinite(value)) continue;
      sum += value;
      count += 1;
    }
    return count > 0 ? sum / count : null;
  }
  function tokenRateForRange(buckets, from, to) {
    if (!buckets.length) return null;
    if (!buckets.some((bucket) => bucket.requests > 0)) return null;
    const first = buckets[0]?.start;
    const last = buckets[buckets.length - 1]?.end;
    const start = from > 0 ? from : first;
    const end = from > 0 && to > from ? to : last;
    if (start === void 0 || end === void 0 || end <= start) return null;
    const span = end - start;
    const unit = span <= DAY ? "h" : "d";
    const unitMs = unit === "h" ? HOUR : DAY;
    const total = buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
    return { value: total / (span / unitMs), unit };
  }
  function chooseBucketMs(from, to) {
    const span = Math.max(0, to - from);
    if (span <= HOUR) return 5 * MINUTE;
    if (span <= DAY) return HOUR;
    if (span <= 30 * DAY) return DAY;
    if (span <= 180 * DAY) return 7 * DAY;
    return 30 * DAY;
  }
  function makeTimeRange(preset, customFrom, customTo, now = Date.now()) {
    let from = now - 7 * DAY;
    let to = now;
    if (preset === "1h") from = now - HOUR;
    else if (preset === "24h") from = now - DAY;
    else if (preset === "7d") from = now - 7 * DAY;
    else if (preset === "30d") from = now - 30 * DAY;
    else if (preset === "all") from = 0;
    else if (preset === "custom") {
      from = typeof customFrom === "number" && Number.isFinite(customFrom) ? customFrom : now - 7 * DAY;
      to = typeof customTo === "number" && Number.isFinite(customTo) ? customTo : now;
      if (to < from) [from, to] = [to, from];
    }
    return { preset, from, to, label: preset, bucketMs: chooseBucketMs(from, to) };
  }
  function aggregateRecords(records, filters, from, to, requestedBucketMs) {
    const bucketMs = requestedBucketMs ?? chooseBucketMs(from, to);
    const filtered = records.filter(
      (record) => record.category === "inference" && record.startedAt >= from && record.startedAt <= to && matchesFilters(record, filters)
    );
    const bucketAnchor = filtered.length ? localBucketStart(from === 0 ? Math.min(...filtered.map((item) => item.startedAt)) : from, DAY) : localBucketStart(from, DAY);
    const total = newAccumulator();
    const modelAccumulators = /* @__PURE__ */ new Map();
    const bucketAccumulators = /* @__PURE__ */ new Map();
    for (const record of filtered) {
      addRecord(total, record);
      const modelKey = `${record.provider}\0${record.model}`;
      let modelAccumulator = modelAccumulators.get(modelKey);
      if (!modelAccumulator) {
        modelAccumulator = { ...newAccumulator(), model: record.model, provider: record.provider };
        modelAccumulators.set(modelKey, modelAccumulator);
      }
      addRecord(modelAccumulator, record);
      const bucketStart2 = localBucketStart(record.startedAt, bucketMs, bucketAnchor);
      let bucketAccumulator = bucketAccumulators.get(bucketStart2);
      if (!bucketAccumulator) {
        bucketAccumulator = newAccumulator();
        bucketAccumulators.set(bucketStart2, bucketAccumulator);
      }
      addRecord(bucketAccumulator, record);
    }
    const models = [...modelAccumulators.values()].map((accumulator) => ({
      ...finishSummary(accumulator),
      model: accumulator.model,
      provider: accumulator.provider
    })).sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
    const buckets = [];
    if (from !== 0 || filtered.length > 0) {
      const firstTimestamp = from === 0 ? Math.min(...filtered.map((record) => record.startedAt)) : from;
      const first = localBucketStart(firstTimestamp, bucketMs, bucketAnchor);
      for (let start = first; start < to && buckets.length < 5e3; start += bucketMs) {
        const accumulator = bucketAccumulators.get(start) ?? newAccumulator();
        const summary = finishSummary(accumulator);
        buckets.push({
          start,
          end: Math.min(to, start + bucketMs),
          requests: summary.requests,
          succeeded: summary.succeeded,
          failed: summary.failed,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          reasoningTokens: summary.reasoningTokens,
          cacheReadTokens: summary.cacheReadTokens,
          cacheWriteTokens: summary.cacheWriteTokens,
          totalTokens: summary.totalTokens,
          costUsd: summary.costUsd,
          cacheHitRate: summary.cacheHitRate,
          ttftAvg: summary.ttftAvg,
          ttftSlowest: summary.ttftSlowest,
          ttftSamples: summary.ttftSamples,
          tpsAvg: summary.tpsAvg,
          tpsSlowest: summary.tpsSlowest,
          tpsSamples: summary.tpsSamples
        });
      }
    }
    return {
      records: filtered.sort((a, b) => b.startedAt - a.startedAt),
      summary: finishSummary(total),
      models,
      buckets
    };
  }
  function filterOptions(records) {
    const models = /* @__PURE__ */ new Set();
    const providers = /* @__PURE__ */ new Set();
    const users = /* @__PURE__ */ new Map();
    for (const record of records) {
      if (record.model) models.add(record.model);
      if (record.provider) providers.add(record.provider);
      if (record.serviceAccountID) users.set(`account:${record.serviceAccountID}`, `Account · ${record.serviceAccountID}`);
      else if (record.userID) users.set(`user:${record.userID}`, `User · ${record.userID}`);
    }
    return {
      models: [...models].sort(),
      providers: [...providers].sort(),
      users: [...users.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label))
    };
  }

  // src/api.ts
  var ApiError = class extends Error {
    kind;
    status;
    code;
    retryAfterMs;
    constructor(kind, message, status, code, retryAfterMs2) {
      super(message);
      this.name = "ApiError";
      this.kind = kind;
      this.status = status;
      this.code = code;
      this.retryAfterMs = retryAfterMs2;
    }
  };
  function buildURL(path, query) {
    const url = new URL(`/console${path}`, location.origin);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== void 0 && value !== null && value !== "") {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
  async function readError(response) {
    const raw = await response.text().catch(() => "");
    if (!raw) return { message: response.statusText || `HTTP ${response.status}` };
    try {
      const parsed = JSON.parse(raw);
      const message = typeof parsed.message === "string" && parsed.message || typeof parsed._tag === "string" && parsed._tag || response.statusText || `HTTP ${response.status}`;
      const code = typeof parsed.code === "string" ? parsed.code : void 0;
      return { message, code };
    } catch {
      return { message: raw.slice(0, 500) || response.statusText || `HTTP ${response.status}` };
    }
  }
  function retryAfterMs(response) {
    const raw = response.headers.get("retry-after");
    if (!raw) return void 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1e3);
    const date = Date.parse(raw);
    return Number.isFinite(date) ? Math.max(0, date - Date.now()) : void 0;
  }
  function classifyError(status, response, body) {
    if (status === 401) return new ApiError("session", body.message, status, body.code);
    if (status === 403) return new ApiError("permission", body.message, status, body.code);
    if (status === 409) return new ApiError("cursor", body.message, status, body.code);
    if (status === 429) return new ApiError("rate-limit", body.message, status, body.code, retryAfterMs(response));
    if (status === 400 || status === 422) return new ApiError("bad-request", body.message, status, body.code);
    return new ApiError("server", body.message, status, body.code);
  }
  async function requestJson(path, options = {}) {
    const headers = {
      Accept: "application/json"
    };
    if (options.workspaceID) headers["x-org-id"] = options.workspaceID;
    let response;
    try {
      response = await fetch(buildURL(path, options.query), {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers,
        signal: options.signal
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ApiError("network", error instanceof Error ? error.message : String(error));
    }
    if (!response.ok) {
      const body = await readError(response);
      throw classifyError(response.status, response, body);
    }
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      throw new ApiError("contract", "The API returned a non-JSON response.", response.status);
    }
    return parsed;
  }
  async function listWorkspaces(signal) {
    const data = await requestJson("/api/user/workspaces", { signal });
    if (!Array.isArray(data)) {
      throw new ApiError("contract", "Workspace response was not an array.");
    }
    return data.filter((item) => Boolean(item) && typeof item === "object").map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      name: typeof item.name === "string" ? item.name : "",
      role: typeof item.role === "string" ? item.role : void 0,
      memberCount: typeof item.memberCount === "number" ? item.memberCount : void 0,
      avatarUrl: typeof item.avatarUrl === "string" ? item.avatarUrl : null
    })).filter((item) => item.id.startsWith("wrk_"));
  }
  function optionalEpoch(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return void 0;
  }
  function optionalAmount(value) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    }
    return void 0;
  }
  function meterWindow(value) {
    if (!value || typeof value !== "object") return {};
    const meter = value;
    return {
      ...optionalEpoch(meter.startsAt) === void 0 ? {} : { startsAt: optionalEpoch(meter.startsAt) },
      ...optionalEpoch(meter.resetsAt) === void 0 ? {} : { resetsAt: optionalEpoch(meter.resetsAt) },
      ...optionalAmount(meter.limitMicroCents) === void 0 ? {} : { limitMicroCents: optionalAmount(meter.limitMicroCents) },
      ...optionalAmount(meter.usedMicroCents) === void 0 ? {} : { usedMicroCents: optionalAmount(meter.usedMicroCents) }
    };
  }
  async function getGoQuotaStatus(workspaceID, signal) {
    const data = await requestJson("/api/go/status", { workspaceID, signal });
    if (!data || typeof data !== "object") {
      throw new ApiError("contract", "Go status response was not an object.");
    }
    const record = data;
    const product = record.product === "go" || record.product === "go-plus" ? record.product : null;
    const access = record.access && typeof record.access === "object" ? record.access : null;
    const meters = access?.meters && typeof access.meters === "object" ? access.meters : null;
    return {
      active: Boolean(access && product),
      product,
      ...optionalEpoch(access?.startsAt) === void 0 ? {} : { accessStartsAt: optionalEpoch(access?.startsAt) },
      ...optionalEpoch(access?.endsAt) === void 0 ? {} : { accessEndsAt: optionalEpoch(access?.endsAt) },
      cancelAtPeriodEnd: record.cancelAtPeriodEnd === true,
      fiveHour: meterWindow(meters?.fiveHour),
      week: meterWindow(meters?.week),
      month: meterWindow(meters?.month),
      fetchedAt: Date.now()
    };
  }
  function validateRequestLogPage(data) {
    if (!data || typeof data !== "object") {
      throw new ApiError("contract", "Request log response was not an object.");
    }
    const record = data;
    if (!Array.isArray(record.items)) {
      throw new ApiError("contract", "Request log response did not contain an items array.");
    }
    const items = record.items.filter((item) => Boolean(item) && typeof item === "object");
    if (items.length !== record.items.length) {
      throw new ApiError("contract", "Request log response contained a malformed item.");
    }
    if (!Object.prototype.hasOwnProperty.call(record, "nextCursor") || !(record.nextCursor === null || typeof record.nextCursor === "string")) {
      throw new ApiError("contract", "Request log response contained an invalid nextCursor.");
    }
    if (typeof record.until !== "number" || !Number.isFinite(record.until)) {
      throw new ApiError("contract", "Request log response contained an invalid until timestamp.");
    }
    if (record.retentionDays !== void 0 && (typeof record.retentionDays !== "number" || !Number.isFinite(record.retentionDays) || record.retentionDays <= 0)) {
      throw new ApiError("contract", "Request log response contained an invalid retentionDays value.");
    }
    return {
      items,
      nextCursor: record.nextCursor,
      until: record.until,
      retentionDays: typeof record.retentionDays === "number" ? record.retentionDays : 30
    };
  }
  async function listRequestLogs(workspaceID, query, signal) {
    const params = {
      category: "inference",
      since: Math.max(0, Math.floor(query.since)),
      until: query.until === void 0 ? void 0 : Math.floor(query.until),
      cursor: query.cursor,
      limit: query.limit,
      outcome: query.outcome,
      model: query.model,
      provider: query.provider,
      userID: query.userID,
      serviceAccountID: query.serviceAccountID,
      product: query.product,
      protocol: query.protocol
    };
    const data = await requestJson("/api/request-logs", {
      query: params,
      workspaceID,
      signal
    });
    return validateRequestLogPage(data);
  }
  function installRequestLogCapture(onPage) {
    const win2 = window;
    if (win2.__ocgoLensCaptureInstalled || typeof window.fetch !== "function") return;
    win2.__ocgoLensCaptureInstalled = true;
    const original = window.fetch.bind(window);
    window.fetch = function capturedFetch(input, init) {
      const responsePromise = original(input, init);
      try {
        const url = new URL(
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
          location.origin
        );
        if (url.origin !== location.origin || url.pathname !== "/console/api/request-logs" || url.searchParams.get("category") !== "inference") {
          return responsePromise;
        }
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : void 0));
        const workspaceID = headers.get("x-org-id") ?? "";
        if (!workspaceID.startsWith("wrk_")) return responsePromise;
        void responsePromise.then(async (response) => {
          if (!response.ok) return;
          const data = await response.clone().json();
          const page = validateRequestLogPage(data);
          onPage({ workspaceID, page });
        }).catch(() => void 0);
      } catch {
      }
      return responsePromise;
    };
  }
  async function listUsagePrincipals(workspaceID, signal) {
    const principals = [];
    let page = 1;
    let pageCount = 1;
    while (page <= pageCount && page <= 20) {
      const data = await requestJson("/api/usage/users", {
        query: { range: "30d", page, pageSize: 100, costOrder: "desc" },
        workspaceID,
        signal
      });
      if (!data || typeof data !== "object") {
        throw new ApiError("contract", "Usage principals response was not an object.");
      }
      const record = data;
      if (!Array.isArray(record.items)) {
        throw new ApiError("contract", "Usage principals response did not contain an items array.");
      }
      if (record.items.some((item) => !item || typeof item !== "object")) {
        throw new ApiError("contract", "Usage principals response contained a malformed item.");
      }
      principals.push(...record.items.map((item) => {
        const value = item;
        return {
          userId: typeof value.userId === "string" ? value.userId : "",
          serviceUserId: typeof value.serviceUserId === "string" ? value.serviceUserId : "",
          principalType: typeof value.principalType === "string" ? value.principalType : "",
          email: typeof value.email === "string" ? value.email : "",
          name: typeof value.name === "string" ? value.name : "",
          avatarUrl: typeof value.avatarUrl === "string" ? value.avatarUrl : null
        };
      }));
      pageCount = typeof record.pageCount === "number" && Number.isFinite(record.pageCount) && record.pageCount > 0 ? Math.floor(record.pageCount) : page;
      page += 1;
    }
    return principals;
  }

  // src/i18n.ts
  var zh = {
    "app.title": "OpenCode 性能观测",
    "app.subtitle": "缓存命中率 · TTFT · TPS",
    "app.open": "打开性能观测",
    "app.close": "关闭",
    "app.language": "语言",
    "tabs.overview": "概览",
    "tabs.charts": "趋势图",
    "tabs.requests": "请求明细",
    "tabs.data": "同步与数据",
    "tabs.forecast": "额度预测",
    "badge.beta": "Beta",
    "data.experimentalTitle": "实验性功能",
    "data.experimentalForecast": "启用额度预测（Beta）",
    "data.experimentalForecastHint": "根据本地请求记录和 Go 价格表预测 5h、24h、周和月额度。预测结果仅供估算，不改变官方额度。",
    "data.experimentalForecastNote": "开启后才会读取全部本地历史并请求 Go 状态。",
    "forecast.loading": "正在计算额度预测…",
    "forecast.error": "无法加载额度预测：{error}",
    "forecast.retry": "重试",
    "forecast.empty": "暂无可预测的请求记录",
    "forecast.emptyHint": "先同步本地请求记录，或调整模型、供应商和用户筛选。",
    "forecast.noGo": "未检测到有效的 Go 订阅，当前使用本地窗口估算。",
    "forecast.rangeIgnored": "预测按额度窗口计算，不使用上方时间范围。",
    "forecast.noAggregate": "模型额度互相独立，不合计不同模型的已用百分比。",
    "forecast.riskiest": "最紧模型",
    "forecast.selectedModel": "当前模型",
    "forecast.summary": "{model} 的四个额度口径",
    "forecast.windowFiveHour": "5 小时",
    "forecast.window24h": "未来 24h",
    "forecast.windowWeek": "本周",
    "forecast.windowMonth": "本月",
    "forecast.used": "已用 {value}",
    "forecast.projected": "预计 {value}",
    "forecast.p90Short": "p90 {value}",
    "forecast.remaining": "重置剩余 {value}",
    "forecast.hitAt": "预计 {time} 触顶",
    "forecast.noHit": "预计不会提前触顶",
    "forecast.windowNotStarted": "首次使用后开始",
    "forecast.unlimited": "Unlimited",
    "forecast.unknown": "未知",
    "forecast.unpriced": "有 {n} 条请求未匹配价格",
    "forecast.noQuotaData": "该模型没有可用的月额度数据",
    "forecast.confidence": "置信度：{value}",
    "forecast.confidenceHigh": "高",
    "forecast.confidenceMedium": "中",
    "forecast.confidenceLow": "低",
    "forecast.sourceOfficial": "窗口时间来自官方 Go 状态",
    "forecast.sourceEstimated": "窗口时间为本地估算",
    "forecast.chartTitle": "按百分比预测",
    "forecast.chartAria": "{window}额度预测曲线",
    "forecast.chartHistory": "历史累计",
    "forecast.chartP50": "预测中位数（p50）",
    "forecast.chartP10": "预测下界（p10）",
    "forecast.chartP90": "预测上界（p90）",
    "forecast.tableTitle": "模型额度明细",
    "forecast.table.model": "模型",
    "forecast.table.monthlyLimit": "月额度",
    "forecast.table.fiveHour": "5h 已用/上限",
    "forecast.table.week": "周已用/上限",
    "forecast.table.month": "本月已用/月额度",
    "forecast.table.next24h": "24h 预测",
    "forecast.table.weekRemaining": "周重置剩余",
    "forecast.table.monthRemaining": "月重置剩余",
    "forecast.table.actions": "选择模型",
    "forecast.absolute": "绝对额度",
    "forecast.p10p50p90": "p10 {p10} · p50 {p50} · p90 {p90}",
    "forecast.resetAt": "重置：{time}",
    "forecast.asOf": "计算于 {time}",
    "forecast.statusFailed": "Go 状态请求失败，已使用本地窗口估算。",
    "forecast.reasonNoStatus": "未获取官方窗口时间",
    "forecast.reasonShortHistory": "本地历史不足 24 小时",
    "forecast.reasonGap": "本地历史存在同步缺口",
    "forecast.reasonStalePricing": "价格缓存已过期",
    "forecast.reasonUnpriced": "部分请求未能匹配价格",
    "forecast.tooltipAbsolute": "{window}：{value}",
    "forecast.percentOfMonth": "占月额度 {value}",
    "forecast.crosses": "跨越 {n} 个额度边界",
    "forecast.noCross": "不跨额度边界",
    "forecast.percentOfWindow": "占窗口额度 {value}",
    "forecast.modelSelect": "选择预测模型",
    "forecast.noModels": "没有可用于预测的 Go 模型",
    "forecast.noConsumedModels": "当前没有产生额度消耗的模型",
    "forecast.usedLabel": "已用",
    "forecast.projectedLabel": "预计（p50）",
    "forecast.p90Label": "风险上界（p90）",
    "forecast.absoluteLabel": "绝对额度",
    "forecast.resetLabel": "重置时间",
    "forecast.forecastEndLabel": "预测终点",
    "forecast.hitLabel": "预计触顶时间",
    "forecast.tooltipPercentMeaning": "百分比表示当前窗口的已用或预计消耗占该窗口额度的比例。",
    "forecast.explainFiveHour": "到 5 小时重置时预计累计消耗 {value}",
    "forecast.explainWeek": "到周重置时预计累计消耗 {value}",
    "forecast.explainMonth": "到月重置时预计累计消耗 {value}",
    "forecast.explain24h": "从现在的未来 24 小时内，预计新增消耗占月额度的 {value}；届时本月累计约 {arrival}",
    "forecast.explainHistory": "该时间点已累计消耗 {value}",
    "forecast.explainPoint": "该时间点预计累计消耗 {value}",
    "forecast.explain24hToPoint": "从预测起点到该时间点，预计新增消耗占月额度的 {value}；届时本月累计约 {arrival}",
    "forecast.tooltip24hMeaning": "百分比表示未来 24 小时预测消耗占月额度的比例。",
    "forecast.info": "预测说明",
    "forecast.infoHead": "如何阅读额度预测",
    "forecast.infoHistory": "历史实线",
    "forecast.infoHistoryDesc": "窗口内已经发生的累计额度消耗",
    "forecast.infoForecast": "预测虚线",
    "forecast.infoForecastDesc": "p50 中位预测，即最常见的预计消耗",
    "forecast.infoBand": "置信区间",
    "forecast.infoBandDesc": "p10–p90 阴影表示预测的不确定范围",
    "forecast.infoMethod": "预测方法",
    "forecast.infoMethodDesc": "短期使用 15/60 分钟 EWMA，并叠加同星期时段周期和受限趋势",
    "forecast.infoFooter": "24h 使用月额度作为分母；预测仅供估算，不改变官方额度。",
    "log.forecastUpdated": "额度预测已更新：{n} 个模型",
    "log.forecastFailed": "额度预测失败：{error}",
    "log.goStatusFailed": "Go 状态读取失败：{error}",
    "range.1h": "近 1 小时",
    "range.24h": "近 24 小时",
    "range.7d": "近 7 天",
    "range.30d": "近 30 天",
    "range.all": "全部本地",
    "range.custom": "自定义",
    "range.label": "范围",
    "range.from": "开始",
    "range.to": "结束",
    "filter.model": "模型",
    "filter.provider": "供应商",
    "filter.user": "用户",
    "filter.all": "全部",
    "filter.clear": "清除筛选",
    "metric.requests": "请求",
    "metric.successRate": "成功率",
    "metric.cost": "费用",
    "metric.input": "输入 tokens",
    "metric.output": "输出 tokens",
    "metric.cacheRead": "缓存读",
    "metric.cacheWrite": "缓存写",
    "metric.cacheHitRate": "缓存命中率",
    "metric.ttft": "TTFT（平均 / 最慢）",
    "metric.tps": "输出 TPS（平均 / 最慢）",
    "metric.samples": "{n} 个有效样本",
    "metric.failures": "{n} 个失败/取消",
    "chart.tokens": "Token 构成",
    "chart.cache": "缓存命中率",
    "chart.ttft": "TTFT 趋势",
    "chart.tps": "输出 TPS 趋势",
    "chart.models": "模型性能对比",
    "chart.empty": "当前范围内没有可绘制的数据",
    "chart.zoom": "图表缩放",
    "chart.zoomIn": "放大图表",
    "chart.zoomOut": "缩小图表",
    "chart.zoomReset": "重置图表缩放",
    "chart.avgTokens": "平均 {value} tokens/{unit}",
    "chart.avgCache": "平均 {value}",
    "chart.avgTtft": "平均 {avg} · 最慢 {slowest}",
    "chart.avgTps": "平均 {avg} · 最慢 {slowest}",
    "chart.unitHour": "h",
    "chart.unitDay": "d",
    "chart.input": "输入",
    "chart.cacheRead": "缓存读",
    "chart.cacheWrite": "缓存写",
    "chart.output": "输出",
    "chart.average": "平均",
    "chart.slowest": "最慢",
    "table.model": "模型",
    "table.provider": "供应商",
    "table.requests": "请求",
    "table.totalTokens": "总 tokens",
    "table.success": "成功",
    "table.hitRate": "命中率",
    "table.ttft": "TTFT",
    "table.tps": "TPS",
    "table.ttftAvg": "TTFT 平均",
    "table.ttftSlowest": "TTFT 最慢",
    "table.tpsAvg": "TPS 平均",
    "table.tpsSlowest": "TPS 最慢",
    "table.input": "输入",
    "table.cacheRead": "缓存读",
    "table.cacheWrite": "缓存写",
    "table.output": "输出",
    "table.reasoning": "推理",
    "table.cost": "费用",
    "table.time": "时间",
    "table.status": "状态",
    "table.user": "用户",
    "table.open": "官方详情",
    "tooltip.successFailed": "成功 / 失败",
    "tooltip.ttftSamples": "TTFT 样本",
    "tooltip.tpsSamples": "TPS 样本",
    "table.page": "第 {page} / {pages} 页",
    "table.prev": "上一页",
    "table.next": "下一页",
    "table.empty": "当前筛选条件下没有请求记录",
    "table.emptyHint": "调整时间范围或筛选条件后重试。",
    "status.never": "尚未同步",
    "status.syncing": "同步中：第 {page} 页，已保存 {n} 条",
    "status.synced": "同步完成：{n} 条",
    "status.stopped": "同步已停止",
    "status.syncNow": "立即同步",
    "status.syncFull": "补齐近 30 天",
    "status.stop": "停止",
    "status.legacy": "旧版历史",
    "status.records": "{n} 条本地记录",
    "status.coverage": "本地覆盖：{from} — {to}",
    "status.official": "官方日志保留期：{n} 天",
    "status.lastSync": "最近同步：{time}",
    "status.gap": "检测到历史缺口：上次同步距现在超过 {n} 天，缺口期间的数据已无法从官方补回。",
    "status.partial": "同步尚未完整完成；可点击“补齐近 30 天”重试。",
    "status.captured": "已从官方日志页面捕获 {n} 条记录",
    "data.exportCsv": "导出筛选明细 CSV",
    "data.exportJson": "导出归档 JSON",
    "data.clear": "清空本地历史",
    "data.clearConfirm": "再次点击确认清空",
    "data.storage": "浏览器存储占用：{size}",
    "data.privacy": "数据仅保存在当前浏览器 IndexedDB，不会上传到第三方。",
    "data.diagnostics": "诊断日志",
    "data.copyLogs": "复制日志",
    "data.noLogs": "暂无日志",
    "data.workspace": "当前工作区",
    "data.actions": "操作",
    "data.recordCount": "本地记录",
    "data.retentionNote": "官方只保留 30 天；更早数据来自本地归档。",
    "data.pricingTitle": "缓存模型价格",
    "data.pricingHint": "OpenCode Go 官方单价",
    "data.pricingLoading": "正在读取价格缓存…",
    "data.pricingEmpty": "暂无可用价格缓存。",
    "data.pricingError": "价格刷新失败，继续使用现有缓存：{error}",
    "data.pricingMeta": "缓存于 {time} · {n} 个模型",
    "data.pricingSource": "查看官方价格 ↗",
    "data.pricingModel": "模型",
    "data.pricingPeriod": "计费时段",
    "data.pricingContext": "上下文档位",
    "data.pricingInput": "输入 / 1M",
    "data.pricingOutput": "输出 / 1M",
    "data.pricingCacheRead": "缓存读 / 1M",
    "data.pricingCacheWrite": "缓存写 / 1M",
    "data.pricingPeak": "高峰",
    "data.pricingOffPeak": "非高峰",
    "data.pricingAllDay": "全天",
    "data.pricingAllContext": "全部",
    "data.customInvalid": "自定义时间范围无效",
    "error.title": "无法加载数据",
    "error.session": "登录已失效，请刷新页面并重新登录 OpenCode 控制台。",
    "error.permission": "当前账号没有访问工作区请求日志的权限。",
    "error.cursor": "分页游标已失效，已停止本次同步；再次同步会从第一页重新开始。",
    "error.rate": "请求过于频繁，已暂停同步；稍后重试。",
    "error.badRequest": "服务端拒绝了当前查询参数，已尝试兼容页大小。",
    "error.contract": "接口结构已变化，已停止同步以避免写入错误数据。",
    "error.network": "网络请求失败，请检查连接后重试。",
    "error.unknown": "发生未知错误：{message}",
    "error.workspace": "请先打开一个 OpenCode 工作区。",
    "error.loading": "正在加载本地数据…",
    "empty.title": "还没有本地记录",
    "empty.description": "点击“立即同步”从官方控制台拉取最近 30 天请求日志。",
    "legacy.note": "旧版记录没有 TTFT/TPS，只参与 token、缓存和费用统计。",
    "badge.legacy": "旧版",
    "badge.success": "成功",
    "badge.failed": "失败",
    "badge.rejected": "拒绝",
    "badge.cancelled": "取消",
    "log.level.info": "信息",
    "log.level.warn": "警告",
    "log.level.error": "错误",
    "log.mounted": "性能观测面板已加载",
    "log.migrated": "已迁移 {n} 条旧版用量记录",
    "log.migrationSkipped": "旧版数据迁移跳过：{error}",
    "log.principalSkipped": "用户信息加载跳过：{error}",
    "log.workspace": "工作区：{name}",
    "log.workspaceListFailed": "工作区列表加载失败：{error}",
    "log.syncBackfillStart": "开始补齐近 30 天日志",
    "log.syncIncrementalStart": "开始增量同步",
    "log.syncComplete": "同步完成：抓取 {fetched} 条，新增 {added} 条，共 {pages} 页",
    "log.syncCached": "增量同步命中本地缓存：新增 {added} 条，共 {pages} 页",
    "log.syncStopped": "同步已被用户停止",
    "log.error": "错误：{error}",
    "log.exportCsv": "已导出 {n} 条筛选记录为 CSV",
    "log.exportJson": "已导出 {n} 条归档记录为 JSON",
    "log.legacyCleanupSkipped": "旧版缓存清理跳过：{error}",
    "log.historyCleared": "本地历史已清空",
    "log.diagnosticsCopied": "诊断日志已复制",
    "log.ready": "性能观测 v{version} 已就绪",
    "log.bootFailed": "启动失败：{error}",
    "log.captureFailed": "日志捕获失败：{error}",
    "log.pricingUpdated": "已缓存 {n} 个模型的 Go 价格",
    "log.pricingRefreshFailed": "Go 价格刷新失败：{error}",
    "sync.toast.updated": "已更新 {n} 条数据",
    "sync.toast.latest": "已是最新，没有新数据",
    "tooltip.inputCost": "输入费用",
    "tooltip.outputCost": "输出费用",
    "tooltip.cacheReadCost": "缓存读费用",
    "tooltip.cacheWriteCost": "缓存写费用",
    "tooltip.tokensTitle": "{model} · 总 tokens",
    "tooltip.costTitle": "{model} · 费用",
    "tooltip.estimated": "估算",
    "tooltip.estimatedHint": "按官方 Go 单价计算，并校准到实际总费用。",
    "tooltip.costUnavailable": "该模型暂无官方 Go 分类价格。"
  };
  var en = {
    "app.title": "OpenCode Performance Lens",
    "app.subtitle": "Cache hit · TTFT · TPS",
    "app.open": "Open performance lens",
    "app.close": "Close",
    "app.language": "Language",
    "tabs.overview": "Overview",
    "tabs.charts": "Charts",
    "tabs.requests": "Requests",
    "tabs.data": "Sync & Data",
    "tabs.forecast": "Forecast",
    "badge.beta": "Beta",
    "data.experimentalTitle": "Experimental",
    "data.experimentalForecast": "Enable quota forecast (Beta)",
    "data.experimentalForecastHint": "Forecast 5h, 24h, weekly, and monthly quota usage from local request records and Go pricing. This does not change official quota.",
    "data.experimentalForecastNote": "Only loading the forecast loads the full local history and requests Go status.",
    "forecast.loading": "Calculating quota forecast…",
    "forecast.error": "Could not load quota forecast: {error}",
    "forecast.retry": "Retry",
    "forecast.empty": "No forecastable request records yet",
    "forecast.emptyHint": "Sync local records first, or adjust the model, provider, and user filters.",
    "forecast.noGo": "No active Go subscription was detected. Local window estimates are being used.",
    "forecast.rangeIgnored": "Forecasts follow quota windows and ignore the range selector above.",
    "forecast.noAggregate": "Model quotas are independent. Usage is never summed across models.",
    "forecast.riskiest": "Tightest model",
    "forecast.selectedModel": "Selected model",
    "forecast.summary": "Four quota horizons for {model}",
    "forecast.windowFiveHour": "5 hours",
    "forecast.window24h": "Next 24h",
    "forecast.windowWeek": "This week",
    "forecast.windowMonth": "This month",
    "forecast.used": "Used {value}",
    "forecast.projected": "Projected {value}",
    "forecast.p90Short": "p90 {value}",
    "forecast.remaining": "Remaining at reset {value}",
    "forecast.hitAt": "Projected to hit the limit at {time}",
    "forecast.noHit": "Not projected to hit the limit early",
    "forecast.windowNotStarted": "Starts after first use",
    "forecast.unlimited": "Unlimited",
    "forecast.unknown": "Unknown",
    "forecast.unpriced": "{n} request(s) could not be priced",
    "forecast.noQuotaData": "No monthly quota data is available for this model",
    "forecast.confidence": "Confidence: {value}",
    "forecast.confidenceHigh": "High",
    "forecast.confidenceMedium": "Medium",
    "forecast.confidenceLow": "Low",
    "forecast.sourceOfficial": "Window times from official Go status",
    "forecast.sourceEstimated": "Window times are local estimates",
    "forecast.chartTitle": "Percentage forecast",
    "forecast.chartAria": "{window} quota forecast chart",
    "forecast.chartHistory": "Historical cumulative",
    "forecast.chartP50": "Forecast median (p50)",
    "forecast.chartP10": "Forecast lower bound (p10)",
    "forecast.chartP90": "Forecast upper bound (p90)",
    "forecast.tableTitle": "Model quota detail",
    "forecast.table.model": "Model",
    "forecast.table.monthlyLimit": "Monthly limit",
    "forecast.table.fiveHour": "5h used / limit",
    "forecast.table.week": "Weekly used / limit",
    "forecast.table.month": "Monthly used / limit",
    "forecast.table.next24h": "24h forecast",
    "forecast.table.weekRemaining": "Remaining at week reset",
    "forecast.table.monthRemaining": "Remaining at month reset",
    "forecast.table.actions": "Select model",
    "forecast.absolute": "Absolute quota",
    "forecast.p10p50p90": "p10 {p10} · p50 {p50} · p90 {p90}",
    "forecast.resetAt": "Resets: {time}",
    "forecast.asOf": "Calculated {time}",
    "forecast.statusFailed": "The Go status request failed. Local window estimates are being used.",
    "forecast.reasonNoStatus": "Official window times are unavailable",
    "forecast.reasonShortHistory": "Local history is shorter than 24 hours",
    "forecast.reasonGap": "Local history has a sync gap",
    "forecast.reasonStalePricing": "The pricing cache is stale",
    "forecast.reasonUnpriced": "Some requests could not be priced",
    "forecast.tooltipAbsolute": "{window}: {value}",
    "forecast.percentOfMonth": "{value} of monthly quota",
    "forecast.crosses": "crosses {n} quota boundary(ies)",
    "forecast.noCross": "no quota boundary crossed",
    "forecast.percentOfWindow": "{value} of window quota",
    "forecast.modelSelect": "Select forecast model",
    "forecast.noModels": "No Go models are available for forecasting",
    "forecast.noConsumedModels": "No models have consumed quota yet",
    "forecast.usedLabel": "Used",
    "forecast.projectedLabel": "Projected (p50)",
    "forecast.p90Label": "Risk upper bound (p90)",
    "forecast.absoluteLabel": "Absolute quota",
    "forecast.resetLabel": "Reset time",
    "forecast.forecastEndLabel": "Forecast end",
    "forecast.hitLabel": "Projected hit time",
    "forecast.tooltipPercentMeaning": "The percentage is current or projected usage divided by this window's quota.",
    "forecast.explainFiveHour": "Projected cumulative usage by the 5-hour reset: {value}",
    "forecast.explainWeek": "Projected cumulative usage by the weekly reset: {value}",
    "forecast.explainMonth": "Projected cumulative usage by the monthly reset: {value}",
    "forecast.explain24h": "Over the next 24 hours, projected new usage is {value} of the monthly quota; monthly usage would reach about {arrival}",
    "forecast.explainHistory": "Cumulative usage at this time: {value}",
    "forecast.explainPoint": "Projected cumulative usage at this time: {value}",
    "forecast.explain24hToPoint": "From the forecast start to this time, projected new usage is {value} of the monthly quota; monthly usage would reach about {arrival}",
    "forecast.tooltip24hMeaning": "The percentage is projected spend over the next 24 hours divided by the monthly quota.",
    "forecast.info": "Forecast help",
    "forecast.infoHead": "How to read the quota forecast",
    "forecast.infoHistory": "Historical line",
    "forecast.infoHistoryDesc": "Cumulative quota usage that has already occurred in this window",
    "forecast.infoForecast": "Forecast line",
    "forecast.infoForecastDesc": "Median p50 projection for the rest of the window",
    "forecast.infoBand": "Confidence band",
    "forecast.infoBandDesc": "The p10–p90 shaded range shows forecast uncertainty",
    "forecast.infoMethod": "Method",
    "forecast.infoMethodDesc": "Short-term 15/60 minute EWMA with weekday-hour seasonality and a capped trend",
    "forecast.infoFooter": "The 24h view uses the monthly quota as its denominator. Forecasts are estimates and never change official quota.",
    "log.forecastUpdated": "Quota forecast updated for {n} model(s)",
    "log.forecastFailed": "Quota forecast failed: {error}",
    "log.goStatusFailed": "Go status lookup failed: {error}",
    "range.1h": "Last hour",
    "range.24h": "Last 24 hours",
    "range.7d": "Last 7 days",
    "range.30d": "Last 30 days",
    "range.all": "All local",
    "range.custom": "Custom",
    "range.label": "Range",
    "range.from": "From",
    "range.to": "To",
    "filter.model": "Model",
    "filter.provider": "Provider",
    "filter.user": "User",
    "filter.all": "All",
    "filter.clear": "Clear filters",
    "metric.requests": "Requests",
    "metric.successRate": "Success rate",
    "metric.cost": "Cost",
    "metric.input": "Input tokens",
    "metric.output": "Output tokens",
    "metric.cacheRead": "Cache read",
    "metric.cacheWrite": "Cache write",
    "metric.cacheHitRate": "Cache hit rate",
    "metric.ttft": "TTFT (average / slowest)",
    "metric.tps": "Output TPS (average / slowest)",
    "metric.samples": "{n} valid samples",
    "metric.failures": "{n} failed/cancelled",
    "chart.tokens": "Token mix",
    "chart.cache": "Cache hit rate",
    "chart.ttft": "TTFT trend",
    "chart.tps": "Output TPS trend",
    "chart.models": "Model performance",
    "chart.empty": "No chartable data in this range",
    "chart.zoom": "Chart zoom",
    "chart.zoomIn": "Zoom in charts",
    "chart.zoomOut": "Zoom out charts",
    "chart.zoomReset": "Reset chart zoom",
    "chart.avgTokens": "Avg {value} tokens/{unit}",
    "chart.avgCache": "Avg {value}",
    "chart.avgTtft": "Avg {avg} · slowest {slowest}",
    "chart.avgTps": "Avg {avg} · slowest {slowest}",
    "chart.unitHour": "h",
    "chart.unitDay": "d",
    "chart.input": "Input",
    "chart.cacheRead": "Cache read",
    "chart.cacheWrite": "Cache write",
    "chart.output": "Output",
    "chart.average": "Average",
    "chart.slowest": "Slowest",
    "table.model": "Model",
    "table.provider": "Provider",
    "table.requests": "Requests",
    "table.totalTokens": "Total tokens",
    "table.success": "Success",
    "table.hitRate": "Hit rate",
    "table.ttft": "TTFT",
    "table.tps": "TPS",
    "table.ttftAvg": "TTFT average",
    "table.ttftSlowest": "TTFT slowest",
    "table.tpsAvg": "TPS average",
    "table.tpsSlowest": "TPS slowest",
    "table.input": "Input",
    "table.cacheRead": "Cache read",
    "table.cacheWrite": "Cache write",
    "table.output": "Output",
    "table.reasoning": "Reasoning",
    "table.cost": "Cost",
    "table.time": "Time",
    "table.status": "Status",
    "table.user": "User",
    "table.open": "Official detail",
    "tooltip.successFailed": "Success / failed",
    "tooltip.ttftSamples": "TTFT samples",
    "tooltip.tpsSamples": "TPS samples",
    "table.page": "Page {page} / {pages}",
    "table.prev": "Previous",
    "table.next": "Next",
    "table.empty": "No requests match the current filters",
    "table.emptyHint": "Adjust the time range or filters and try again.",
    "status.never": "Not synced yet",
    "status.syncing": "Syncing page {page}, {n} saved",
    "status.synced": "Sync complete: {n} records",
    "status.stopped": "Sync stopped",
    "status.syncNow": "Sync now",
    "status.syncFull": "Backfill 30 days",
    "status.stop": "Stop",
    "status.legacy": "Legacy history",
    "status.records": "{n} local records",
    "status.coverage": "Local coverage: {from} — {to}",
    "status.official": "Official log retention: {n} days",
    "status.lastSync": "Last sync: {time}",
    "status.gap": "History gap detected: last sync was more than {n} days ago, so the missing period cannot be recovered.",
    "status.partial": "The backfill is incomplete. Use “Backfill 30 days” to retry.",
    "status.captured": "Captured {n} records from the official logs page",
    "data.exportCsv": "Export filtered CSV",
    "data.exportJson": "Export archive JSON",
    "data.clear": "Clear local history",
    "data.clearConfirm": "Click again to confirm",
    "data.storage": "Browser storage: {size}",
    "data.privacy": "Data stays in this browser’s IndexedDB and is never uploaded to a third party.",
    "data.diagnostics": "Diagnostics",
    "data.copyLogs": "Copy logs",
    "data.noLogs": "No logs yet",
    "data.workspace": "Current workspace",
    "data.actions": "Actions",
    "data.recordCount": "Local records",
    "data.retentionNote": "The console keeps 30 days; older data comes from the local archive.",
    "data.pricingTitle": "Cached model pricing",
    "data.pricingHint": "OpenCode Go list prices",
    "data.pricingLoading": "Loading the cached pricing…",
    "data.pricingEmpty": "No cached pricing is available yet.",
    "data.pricingError": "Pricing refresh failed. Continuing with the existing cache: {error}",
    "data.pricingMeta": "Cached {time} · {n} model(s)",
    "data.pricingSource": "View official pricing ↗",
    "data.pricingModel": "Model",
    "data.pricingPeriod": "Billing period",
    "data.pricingContext": "Context tier",
    "data.pricingInput": "Input / 1M",
    "data.pricingOutput": "Output / 1M",
    "data.pricingCacheRead": "Cache read / 1M",
    "data.pricingCacheWrite": "Cache write / 1M",
    "data.pricingPeak": "Peak",
    "data.pricingOffPeak": "Off-peak",
    "data.pricingAllDay": "All day",
    "data.pricingAllContext": "All",
    "data.customInvalid": "The custom range is invalid",
    "error.title": "Could not load data",
    "error.session": "Your session expired. Refresh the page and sign in to OpenCode Console again.",
    "error.permission": "This account cannot access workspace request logs.",
    "error.cursor": "The pagination cursor expired. Run sync again to restart from page one.",
    "error.rate": "The API is rate limiting requests. Sync paused; try again later.",
    "error.badRequest": "The server rejected the current query. Compatible page sizes were attempted.",
    "error.contract": "The API contract changed. Sync stopped to avoid writing incorrect data.",
    "error.network": "Network request failed. Check the connection and retry.",
    "error.unknown": "Unknown error: {message}",
    "error.workspace": "Open an OpenCode workspace first.",
    "error.loading": "Loading local data…",
    "empty.title": "No local records yet",
    "empty.description": "Use “Sync now” to fetch the last 30 days of request logs from the console.",
    "legacy.note": "Legacy records have no TTFT/TPS and only contribute to tokens, cache, and cost.",
    "badge.legacy": "legacy",
    "badge.success": "succeeded",
    "badge.failed": "failed",
    "badge.rejected": "rejected",
    "badge.cancelled": "cancelled",
    "log.level.info": "Info",
    "log.level.warn": "Warning",
    "log.level.error": "Error",
    "log.mounted": "Performance lens mounted",
    "log.migrated": "Migrated {n} legacy usage records",
    "log.migrationSkipped": "Legacy migration skipped: {error}",
    "log.principalSkipped": "Principal lookup skipped: {error}",
    "log.workspace": "Workspace: {name}",
    "log.workspaceListFailed": "Workspace list failed: {error}",
    "log.syncBackfillStart": "Starting 30-day backfill",
    "log.syncIncrementalStart": "Starting incremental sync",
    "log.syncComplete": "Sync complete: fetched {fetched}, added {added} across {pages} page(s)",
    "log.syncCached": "Incremental sync hit the local cache: added {added} across {pages} page(s)",
    "log.syncStopped": "Sync stopped by user",
    "log.error": "Error: {error}",
    "log.exportCsv": "Exported {n} filtered records as CSV",
    "log.exportJson": "Exported {n} archived records as JSON",
    "log.legacyCleanupSkipped": "Legacy cache cleanup skipped: {error}",
    "log.historyCleared": "Local history cleared",
    "log.diagnosticsCopied": "Diagnostics copied",
    "log.ready": "Performance lens v{version} ready",
    "log.bootFailed": "Boot failed: {error}",
    "log.captureFailed": "Capture failed: {error}",
    "log.pricingUpdated": "Cached Go pricing for {n} models",
    "log.pricingRefreshFailed": "Go pricing refresh failed: {error}",
    "sync.toast.updated": "Updated {n} record(s)",
    "sync.toast.latest": "Already up to date — no new records",
    "tooltip.inputCost": "Input cost",
    "tooltip.outputCost": "Output cost",
    "tooltip.cacheReadCost": "Cache read cost",
    "tooltip.cacheWriteCost": "Cache write cost",
    "tooltip.tokensTitle": "{model} · Total tokens",
    "tooltip.costTitle": "{model} · Cost",
    "tooltip.estimated": "Estimate",
    "tooltip.estimatedHint": "Calculated from official Go prices and normalized to the actual total cost.",
    "tooltip.costUnavailable": "Official Go category pricing is unavailable for this model."
  };
  var dictionaries = { zh, en };
  function detectLanguage(locale) {
    const value = (locale ?? (typeof navigator !== "undefined" ? navigator.languages?.[0] ?? navigator.language : "")).toLowerCase();
    return value.startsWith("zh") ? "zh" : "en";
  }
  function t(language, key, values) {
    const template = dictionaries[language][key] ?? dictionaries.en[key] ?? key;
    if (!values) return template;
    return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
  }

  // src/logger.ts
  var LOG_KEY = "ocgo-lens:logs";
  var MAX_LOGS = 300;
  function formatLogEntry(entry, language) {
    return entry.key ? t(language, entry.key, entry.params) : entry.message ?? "";
  }
  var Logger = class {
    entries = [];
    listeners = /* @__PURE__ */ new Set();
    constructor() {
      try {
        const raw = localStorage.getItem(LOG_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) this.entries = parsed.slice(-MAX_LOGS);
        }
      } catch {
        this.entries = [];
      }
    }
    add(level, key, params) {
      this.entries.push({ time: Date.now(), level, key, params });
      if (this.entries.length > MAX_LOGS) this.entries = this.entries.slice(-MAX_LOGS);
      try {
        localStorage.setItem(LOG_KEY, JSON.stringify(this.entries));
      } catch {
      }
      for (const listener of this.listeners) listener();
    }
    info(key, params) {
      this.add("info", key, params);
    }
    warn(key, params) {
      this.add("warn", key, params);
    }
    error(key, params) {
      this.add("error", key, params);
    }
    all() {
      return [...this.entries];
    }
    clear() {
      this.entries = [];
      try {
        localStorage.removeItem(LOG_KEY);
      } catch {
      }
      for (const listener of this.listeners) listener();
    }
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
  };

  // src/constants.ts
  var DB_NAME = "ocgo-lens-v2";
  var LEGACY_DB_NAME = "ocgo-cache";
  var DEFAULT_PAGE_SIZE = 50;
  var FALLBACK_PAGE_SIZES = [50, 25, 10];
  var RETENTION_DAYS = 30;
  var OVERLAP_MS = 5 * 60 * 1e3;
  var INCREMENTAL_LOOKBACK_MS = 60 * 60 * 1e3;
  var SYNC_INTERVAL_MS = 10 * 60 * 1e3;
  var PAGE_DELAY_MS = 250;
  var MAX_SYNC_PAGES = 1e5;
  var MICROCENTS_PER_DOLLAR = 1e8;
  var STORAGE_PREFIX = "ocgo-lens:";
  var TAB_STORAGE_KEY = "activeTab";
  var FILTERS_STORAGE_KEY = "filters";
  var RANGE_STORAGE_KEY = "range";
  var LANGUAGE_STORAGE_KEY = "language";
  var PANEL_STATE_KEY = "panelState";
  var EXPERIMENTAL_FORECAST_KEY = "experimentalForecast";

  // src/records.ts
  var OUTCOMES = /* @__PURE__ */ new Set(["succeeded", "failed", "rejected", "cancelled"]);
  function finiteNumber(value, fallback = 0) {
    if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      return Number.isFinite(n) ? n : fallback;
    }
    return fallback;
  }
  function optionalNonNegative(value) {
    if (value === null || value === void 0 || value === "") return void 0;
    const n = finiteNumber(value, NaN);
    return Number.isFinite(n) && n >= 0 ? n : void 0;
  }
  function toEpoch(value) {
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : void 0;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && String(numeric) === value.trim()) return numeric;
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return void 0;
  }
  function text(value, fallback = "") {
    return typeof value === "string" ? value : fallback;
  }
  function normalizeOutcome(value) {
    return typeof value === "string" && OUTCOMES.has(value) ? value : "failed";
  }
  function fallbackID(raw, startedAt) {
    return [
      startedAt,
      text(raw.model ?? raw.requestedModel),
      finiteNumber(raw.inputTokens),
      finiteNumber(raw.outputTokens),
      finiteNumber(raw.cacheReadTokens),
      finiteNumber(raw.cost)
    ].join("|");
  }
  function normalizeRawRequest(raw, workspaceID) {
    const startedAt = toEpoch(raw.startedAt);
    if (startedAt === void 0) return null;
    const id = text(raw.id) || text(raw.requestID) || fallbackID(raw, startedAt);
    if (!id) return null;
    const requestID = text(raw.requestID, id);
    return {
      key: `${workspaceID}:${id}`,
      workspaceID,
      id,
      requestID,
      startedAt,
      finishedAt: toEpoch(raw.finishedAt),
      durationMs: Math.max(0, finiteNumber(raw.durationMs)),
      outcome: normalizeOutcome(raw.outcome),
      category: text(raw.category, "inference"),
      protocol: text(raw.protocol),
      product: text(raw.product),
      service: text(raw.service),
      path: text(raw.path),
      method: text(raw.method),
      stream: raw.stream === true,
      sessionID: text(raw.sessionID),
      userID: text(raw.userID),
      serviceAccountID: text(raw.serviceAccountID),
      serviceAPIKeyID: text(raw.serviceAPIKeyID),
      requestedModel: text(raw.requestedModel),
      model: text(raw.model) || text(raw.requestedModel) || "unknown",
      provider: text(raw.provider),
      statusCode: optionalNonNegative(raw.statusCode),
      errorCode: text(raw.errorCode),
      errorMessage: text(raw.errorMessage),
      timeToFirstTokenMs: optionalNonNegative(raw.timeToFirstTokenMs),
      firstTokenAt: toEpoch(raw.firstTokenAt),
      lastTokenAt: toEpoch(raw.lastTokenAt),
      inputTokens: Math.max(0, finiteNumber(raw.inputTokens)),
      outputTokens: Math.max(0, finiteNumber(raw.outputTokens)),
      reasoningTokens: Math.max(0, finiteNumber(raw.reasoningTokens)),
      cacheReadTokens: Math.max(0, finiteNumber(raw.cacheReadTokens)),
      cacheWriteTokens: Math.max(0, finiteNumber(raw.cacheWriteTokens)),
      cacheWrite1hTokens: Math.max(0, finiteNumber(raw.cacheWrite1hTokens)),
      costUsd: Math.max(0, finiteNumber(raw.cost)),
      providerCostUsd: Math.max(0, finiteNumber(raw.providerCost)),
      legacy: false
    };
  }
  function normalizeLegacyUsage(raw, workspaceID) {
    const startedAt = toEpoch(raw.timeCreated ?? raw.startedAt);
    if (startedAt === void 0) return null;
    const idPart = text(raw.id) || fallbackID(raw, startedAt);
    const id = `legacy:${idPart}`;
    return {
      key: `${workspaceID}:${id}`,
      workspaceID,
      id,
      requestID: id,
      startedAt,
      durationMs: 0,
      outcome: "succeeded",
      category: "inference",
      protocol: "",
      product: "",
      service: "",
      path: "",
      method: "",
      stream: false,
      sessionID: "",
      userID: "",
      serviceAccountID: "",
      serviceAPIKeyID: "",
      requestedModel: text(raw.model),
      model: text(raw.model) || "unknown",
      provider: text(raw.provider),
      errorCode: "",
      errorMessage: "",
      inputTokens: Math.max(0, finiteNumber(raw.inputTokens)),
      outputTokens: Math.max(0, finiteNumber(raw.outputTokens)),
      reasoningTokens: Math.max(0, finiteNumber(raw.reasoningTokens)),
      cacheReadTokens: Math.max(0, finiteNumber(raw.cacheReadTokens)),
      cacheWriteTokens: Math.max(0, finiteNumber(raw.cacheWrite5mTokens ?? raw.cacheWriteTokens)),
      cacheWrite1hTokens: Math.max(0, finiteNumber(raw.cacheWrite1hTokens)),
      costUsd: Math.max(0, finiteNumber(raw.cost)) / MICROCENTS_PER_DOLLAR,
      providerCostUsd: 0,
      legacy: true
    };
  }
  function getWorkspaceID(pathname = location.pathname) {
    const match = pathname.match(/^\/console\/(wrk_[^/?#]+)/);
    return match?.[1] ?? null;
  }

  // src/storage.ts
  var STORE_REQUESTS = "requests";
  var STORE_SYNC = "syncState";
  var STORE_META = "meta";
  var dbPromise = null;
  var syncStateMutationChain = Promise.resolve();
  function requestPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
    });
  }
  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
      transaction.onabort = () => reject(transaction.error ?? new DOMException("Transaction aborted", "AbortError"));
    });
  }
  function openDatabase() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
          const store = db.createObjectStore(STORE_REQUESTS, { keyPath: "key" });
          store.createIndex("workspaceStartedAt", ["workspaceID", "startedAt"]);
          store.createIndex("workspaceModel", ["workspaceID", "model"]);
          store.createIndex("workspaceProvider", ["workspaceID", "provider"]);
        }
        if (!db.objectStoreNames.contains(STORE_SYNC)) {
          db.createObjectStore(STORE_SYNC, { keyPath: "workspaceID" });
        }
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Failed to open IndexedDB"));
    });
    return dbPromise;
  }
  async function putRecords(records) {
    if (records.length === 0) return;
    const db = await openDatabase();
    const transaction = db.transaction(STORE_REQUESTS, "readwrite");
    const store = transaction.objectStore(STORE_REQUESTS);
    for (const record of records) store.put(record);
    await transactionDone(transaction);
  }
  async function getRecords(workspaceID, from = 0, to = Number.MAX_SAFE_INTEGER) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_REQUESTS, "readonly");
    const index = transaction.objectStore(STORE_REQUESTS).index("workspaceStartedAt");
    const range = IDBKeyRange.bound([workspaceID, from], [workspaceID, to]);
    const records = await requestPromise(index.getAll(range));
    await transactionDone(transaction);
    return records;
  }
  async function getAllRecords(workspaceID) {
    return getRecords(workspaceID);
  }
  async function getRecordKeys(workspaceID, from = 0, to = Number.MAX_SAFE_INTEGER) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_REQUESTS, "readonly");
    const index = transaction.objectStore(STORE_REQUESTS).index("workspaceStartedAt");
    const range = IDBKeyRange.bound([workspaceID, from], [workspaceID, to]);
    const keys = await requestPromise(index.getAllKeys(range));
    await transactionDone(transaction);
    return keys;
  }
  async function countRecords(workspaceID) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_REQUESTS, "readonly");
    const index = transaction.objectStore(STORE_REQUESTS).index("workspaceStartedAt");
    const range = IDBKeyRange.bound([workspaceID, 0], [workspaceID, Number.MAX_SAFE_INTEGER]);
    const count = await requestPromise(index.count(range));
    await transactionDone(transaction);
    return count;
  }
  async function getLatestStartedAt(workspaceID) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_REQUESTS, "readonly");
    const index = transaction.objectStore(STORE_REQUESTS).index("workspaceStartedAt");
    const range = IDBKeyRange.bound([workspaceID, 0], [workspaceID, Number.MAX_SAFE_INTEGER]);
    const cursor = await requestPromise(index.openCursor(range, "prev"));
    await transactionDone(transaction);
    const record = cursor?.value;
    return record?.startedAt;
  }
  async function getSyncState(workspaceID) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_SYNC, "readonly");
    const result = await requestPromise(transaction.objectStore(STORE_SYNC).get(workspaceID));
    await transactionDone(transaction);
    return result;
  }
  function updateSyncState(workspaceID, updater) {
    const run = async () => {
      const db = await openDatabase();
      const transaction = db.transaction(STORE_SYNC, "readwrite");
      const store = transaction.objectStore(STORE_SYNC);
      const current = await requestPromise(store.get(workspaceID));
      const next = updater(current);
      store.put(next);
      await transactionDone(transaction);
      return next;
    };
    const task = syncStateMutationChain.then(run, run);
    syncStateMutationChain = task.then(() => void 0, () => void 0);
    return task;
  }
  async function getMeta(key) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_META, "readonly");
    const result = await requestPromise(transaction.objectStore(STORE_META).get(key));
    await transactionDone(transaction);
    return result?.value;
  }
  async function putMeta(key, value) {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_META, "readwrite");
    transaction.objectStore(STORE_META).put({ key, value });
    await transactionDone(transaction);
  }
  async function clearWorkspace(workspaceID) {
    const db = await openDatabase();
    const transaction = db.transaction([STORE_REQUESTS, STORE_SYNC], "readwrite");
    const index = transaction.objectStore(STORE_REQUESTS).index("workspaceStartedAt");
    const range = IDBKeyRange.bound([workspaceID, 0], [workspaceID, Number.MAX_SAFE_INTEGER]);
    const cursorRequest = index.openCursor(range);
    await new Promise((resolve, reject) => {
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve();
        }
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    });
    transaction.objectStore(STORE_SYNC).delete(workspaceID);
    await transactionDone(transaction);
  }
  async function storageEstimate() {
    if (!navigator.storage?.estimate) return {};
    const estimate = await navigator.storage.estimate();
    return { usage: estimate.usage, quota: estimate.quota };
  }
  async function legacyDatabaseExists() {
    if (typeof indexedDB.databases === "function") {
      const databases = await indexedDB.databases();
      return databases.some((db) => db.name === LEGACY_DB_NAME);
    }
    return true;
  }
  async function readLegacyUsage(workspaceID) {
    if (!await legacyDatabaseExists()) return [];
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Legacy database is blocked"));
    });
    try {
      if (!db.objectStoreNames.contains("kv")) return [];
      const transaction = db.transaction("kv", "readonly");
      const value = await requestPromise(transaction.objectStore("kv").get(`usage:${workspaceID}`));
      await transactionDone(transaction);
      return Array.isArray(value) ? value.filter((item) => Boolean(item) && typeof item === "object") : [];
    } finally {
      db.close();
    }
  }
  async function clearLegacyUsage(workspaceID) {
    if (!await legacyDatabaseExists()) return;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("kv")) return;
      const transaction = db.transaction("kv", "readwrite");
      transaction.objectStore("kv").delete(`usage:${workspaceID}`);
      await transactionDone(transaction);
    } finally {
      db.close();
    }
  }

  // src/migration.ts
  async function migrateLegacyUsage(workspaceID, now = Date.now()) {
    const state = await getSyncState(workspaceID);
    if (state?.legacyImportedAt) return 0;
    const raw = await readLegacyUsage(workspaceID);
    const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    const records = raw.map((item) => normalizeLegacyUsage(item, workspaceID)).filter((item) => item !== null && item.startedAt < cutoff);
    await putRecords(records);
    await updateSyncState(workspaceID, (current) => {
      const previous = current ?? state;
      return {
        workspaceID,
        retentionDays: previous?.retentionDays ?? RETENTION_DAYS,
        coverageStart: records.length ? Math.min(previous?.coverageStart ?? now, ...records.map((record) => record.startedAt)) : previous?.coverageStart,
        coverageEnd: previous?.coverageEnd,
        latestStartedAt: records.length ? Math.max(previous?.latestStartedAt ?? 0, ...records.map((record) => record.startedAt)) : previous?.latestStartedAt,
        lastSyncAttemptAt: previous?.lastSyncAttemptAt,
        lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt,
        backfillComplete: previous?.backfillComplete ?? false,
        gapDetected: previous?.gapDetected ?? false,
        legacyImportedAt: now,
        lastError: previous?.lastError
      };
    });
    return records.length;
  }
  function incrementalSince(state, now = Date.now(), latestOverride) {
    const retentionStart = now - RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    const latest = latestOverride ?? state?.latestStartedAt;
    if (latest === void 0) return retentionStart;
    const syncStart = (state?.lastSuccessfulSyncAt ?? now) - INCREMENTAL_LOOKBACK_MS;
    return Math.max(retentionStart, Math.min(latest - OVERLAP_MS, syncStart));
  }

  // src/sync.ts
  function abortError() {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal?.reason ?? abortError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(signal?.reason ?? abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  function isRetryable(error) {
    return error instanceof ApiError && ["rate-limit", "server", "network"].includes(error.kind);
  }
  async function retrying(operation, signal, maxRetries = 4) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      try {
        return await operation();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") throw error;
        lastError = error;
        if (!isRetryable(error) || attempt >= maxRetries) throw error;
        const retryAfter = error instanceof ApiError ? error.retryAfterMs : void 0;
        const delay = retryAfter ?? Math.round(1e3 * 2 ** attempt * (1 + Math.random() * 0.3));
        await sleep(delay, signal);
      }
    }
    throw lastError;
  }
  function isAbort(error) {
    return error instanceof Error && error.name === "AbortError";
  }
  async function runPages(workspaceID, since, pageSize, knownKeys, stopWhenCached, signal, onProgress) {
    let cursor;
    let until;
    let pages = 0;
    let fetched = 0;
    let added = 0;
    let retentionDays = RETENTION_DAYS;
    let lastStartedAt;
    const collected = [];
    const usedCursors = /* @__PURE__ */ new Set();
    for (; pages < MAX_SYNC_PAGES; pages += 1) {
      if (signal?.aborted) throw signal.reason ?? abortError();
      if (pages > 0) await sleep(PAGE_DELAY_MS, signal);
      const page = await retrying(
        () => listRequestLogs(workspaceID, { since, until, cursor, limit: pageSize }, signal),
        signal
      );
      retentionDays = page.retentionDays || retentionDays;
      if (page.until !== void 0) until = page.until;
      const records = page.items.map((item) => normalizeRawRequest(item, workspaceID)).filter((item) => item !== null);
      if (records.length !== page.items.length) {
        throw new ApiError("contract", "Request log page contained records without a valid id or startedAt field.");
      }
      if (records.some((record) => record.category !== "inference")) {
        throw new ApiError("contract", "Request log page returned non-inference records despite the inference filter.");
      }
      const pageWasCached = records.length > 0 && records.every((record) => knownKeys.has(record.key));
      const newKeys = new Set(records.filter((record) => !knownKeys.has(record.key)).map((record) => record.key));
      if (records.length) {
        await putRecords(records);
        collected.push(...records);
        fetched += records.length;
        added += newKeys.size;
        for (const key of newKeys) knownKeys.add(key);
        for (const record of records) {
          lastStartedAt = Math.max(lastStartedAt ?? 0, record.startedAt);
        }
      }
      const nextCursor = page.nextCursor;
      onProgress?.({
        phase: "paging",
        page: pages + 1,
        fetched,
        saved: newKeys.size,
        message: nextCursor ? void 0 : "complete"
      });
      if (stopWhenCached && pageWasCached) {
        return {
          complete: true,
          cacheHit: true,
          pages: pages + 1,
          fetched,
          added,
          records: collected,
          lastStartedAt,
          retentionDays
        };
      }
      if (!nextCursor) {
        return {
          complete: true,
          cacheHit: false,
          pages: pages + 1,
          fetched,
          added,
          records: collected,
          lastStartedAt,
          retentionDays
        };
      }
      if (usedCursors.has(nextCursor)) {
        throw new ApiError("contract", "The request-log pagination cursor repeated; sync stopped to prevent an infinite loop.");
      }
      usedCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new ApiError("server", `Sync stopped after ${MAX_SYNC_PAGES} pages. Narrow the range or retry.`);
  }
  function failedState(current, workspaceID, now, message) {
    return {
      workspaceID,
      retentionDays: current?.retentionDays ?? RETENTION_DAYS,
      coverageStart: current?.coverageStart,
      coverageEnd: current?.coverageEnd,
      latestStartedAt: current?.latestStartedAt,
      lastSyncAttemptAt: now,
      lastSuccessfulSyncAt: current?.lastSuccessfulSyncAt,
      backfillComplete: current?.backfillComplete ?? false,
      gapDetected: current?.gapDetected ?? false,
      legacyImportedAt: current?.legacyImportedAt,
      lastError: message
    };
  }
  function mergeState(previous, workspaceID, since, now, result, full) {
    const previousSuccess = previous?.lastSuccessfulSyncAt;
    const missedWindow = previousSuccess !== void 0 && now - previousSuccess > RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    return {
      workspaceID,
      retentionDays: result.retentionDays || RETENTION_DAYS,
      coverageStart: previous?.coverageStart === void 0 ? since : Math.min(previous.coverageStart, since),
      coverageEnd: now,
      latestStartedAt: Math.max(previous?.latestStartedAt ?? 0, result.lastStartedAt ?? 0) || void 0,
      lastSyncAttemptAt: now,
      lastSuccessfulSyncAt: now,
      backfillComplete: Boolean(previous?.backfillComplete || full),
      gapDetected: Boolean(previous?.gapDetected || missedWindow),
      legacyImportedAt: previous?.legacyImportedAt,
      lastError: void 0
    };
  }
  async function syncWorkspace(options) {
    const { workspaceID, forceFull = false, signal, onProgress } = options;
    const now = Date.now();
    const previous = await getSyncState(workspaceID);
    const latestInDb = await getLatestStartedAt(workspaceID);
    const latest = Math.max(previous?.latestStartedAt ?? 0, latestInDb ?? 0);
    const full = forceFull || !previous?.backfillComplete || latest === 0;
    const retentionStart = now - RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    const since = full ? retentionStart : incrementalSince(previous, now, latest || void 0);
    const knownKeys = new Set(await getRecordKeys(workspaceID, since));
    onProgress?.({ phase: "starting", page: 0, fetched: 0, saved: 0 });
    try {
      let result;
      let lastError;
      let cursorRestarted = false;
      const sizes = full ? FALLBACK_PAGE_SIZES : [DEFAULT_PAGE_SIZE, ...FALLBACK_PAGE_SIZES.filter((size) => size !== DEFAULT_PAGE_SIZE)];
      for (const size of sizes) {
        try {
          try {
            result = await runPages(workspaceID, since, size, knownKeys, !full, signal, onProgress);
          } catch (error) {
            if (error instanceof ApiError && error.kind === "cursor" && !cursorRestarted) {
              cursorRestarted = true;
              onProgress?.({ phase: "starting", page: 0, fetched: 0, saved: 0, message: "cursor restart" });
              result = await runPages(workspaceID, since, size, knownKeys, !full, signal, onProgress);
            } else {
              throw error;
            }
          }
          break;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") throw error;
          if (error instanceof Error && error.name === "AbortError") throw error;
          if (error instanceof ApiError && error.kind === "bad-request") {
            lastError = error;
            continue;
          }
          throw error;
        }
      }
      if (!result) throw lastError ?? new ApiError("bad-request", "The request log API rejected all supported page sizes.");
      await updateSyncState(workspaceID, (current) => mergeState(current, workspaceID, since, now, result, full));
      onProgress?.({ phase: "complete", page: result.pages, fetched: result.fetched, saved: result.added });
      return {
        complete: result.complete,
        stopped: false,
        cacheHit: result.cacheHit,
        pages: result.pages,
        fetched: result.fetched,
        added: result.added,
        lastStartedAt: result.lastStartedAt,
        retentionDays: result.retentionDays
      };
    } catch (error) {
      if (isAbort(error)) {
        await updateSyncState(workspaceID, (current) => failedState(current, workspaceID, now, "Sync stopped by user."));
        onProgress?.({ phase: "stopped", page: 0, fetched: 0, saved: 0 });
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      await updateSyncState(workspaceID, (current) => failedState(current, workspaceID, now, message));
      onProgress?.({ phase: "error", page: 0, fetched: 0, saved: 0, message });
      throw error;
    }
  }
  async function persistCapturedPage(workspaceID, items) {
    const records = items.map((item) => normalizeRawRequest(item, workspaceID)).filter((item) => item !== null && item.category === "inference");
    if (!records.length) return 0;
    await putRecords(records);
    await updateSyncState(workspaceID, (previous) => {
      const latest = Math.max(previous?.latestStartedAt ?? 0, ...records.map((record) => record.startedAt));
      return {
        workspaceID,
        retentionDays: previous?.retentionDays ?? RETENTION_DAYS,
        coverageStart: previous?.coverageStart,
        coverageEnd: previous?.coverageEnd,
        latestStartedAt: latest,
        lastSyncAttemptAt: previous?.lastSyncAttemptAt,
        lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt,
        backfillComplete: previous?.backfillComplete ?? false,
        gapDetected: previous?.gapDetected ?? false,
        legacyImportedAt: previous?.legacyImportedAt,
        lastError: previous?.lastError
      };
    });
    return records.length;
  }

  // src/format.ts
  function formatNumber(value) {
    if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
    return Math.round(value).toLocaleString();
  }
  function formatCompact(value) {
    if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
    return Math.round(value).toLocaleString();
  }
  function formatPercent(value, digits = 1) {
    if (value === null || value === void 0 || !Number.isFinite(value)) return "N/A";
    return `${(value * 100).toFixed(digits)}%`;
  }
  function formatUsd(value) {
    if (value === null || value === void 0 || !Number.isFinite(value)) return "—";
    if (value === 0) return "$0.00";
    if (value >= 1) return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    if (value >= 0.01) return `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
    return `$${value.toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
  }
  function formatMs(value) {
    if (value === null || value === void 0 || !Number.isFinite(value)) return "N/A";
    if (value < 1e3) return `${Math.round(value)} ms`;
    return `${(value / 1e3).toFixed(value < 1e4 ? 2 : 1)} s`;
  }
  function formatTps(value) {
    if (value === null || value === void 0 || !Number.isFinite(value)) return "N/A";
    return `${value.toFixed(1)} tok/s`;
  }
  function formatBytes(value) {
    if (value === void 0 || !Number.isFinite(value)) return "—";
    if (value >= 1e9) return `${(value / 1e9).toFixed(2)} GB`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
    return `${value} B`;
  }
  var dateTime = new Intl.DateTimeFormat(void 0, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  var shortDateTime = new Intl.DateTimeFormat(void 0, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  var shortDate = new Intl.DateTimeFormat(void 0, { month: "short", day: "numeric" });
  function formatDateTime(timestamp) {
    return timestamp === void 0 ? "—" : dateTime.format(new Date(timestamp));
  }
  function formatAxisTime(timestamp, bucketMs) {
    const day = 864e5;
    return bucketMs >= day ? shortDate.format(new Date(timestamp)) : shortDateTime.format(new Date(timestamp));
  }
  function formatRelative(timestamp, now = Date.now(), language = "en") {
    if (!timestamp) return "—";
    const delta = now - timestamp;
    const formatter = new Intl.RelativeTimeFormat(language === "zh" ? "zh-CN" : "en", { numeric: "auto" });
    if (delta < 6e4) return formatter.format(-Math.max(0, Math.round(delta / 1e3)), "second");
    if (delta < 36e5) return formatter.format(-Math.floor(delta / 6e4), "minute");
    if (delta < 864e5) return formatter.format(-Math.floor(delta / 36e5), "hour");
    return formatter.format(-Math.floor(delta / 864e5), "day");
  }
  function csvEscape(value) {
    let text2 = String(value ?? "");
    if (/^[=+\-@\t\r]/.test(text2)) text2 = `'${text2}`;
    return /[",\r\n]/.test(text2) ? `"${text2.replace(/"/g, '""')}"` : text2;
  }
  function downloadText(filename, text2, type = "text/plain;charset=utf-8") {
    const blob = new Blob([text2], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = "none";
    document.documentElement.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5e3);
  }
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // src/pricing.ts
  var GO_PRICING_URL = "https://opencode.ai/v2/docs/console/go/";
  var GO_PRICING_CACHE_KEY = "pricing:opencode-go";
  var GO_PRICING_SCHEMA_VERSION = 2;
  var GO_PRICING_TTL_MS = 3 * 24 * 60 * 60 * 1e3;
  var TOKENS_PER_PRICE_UNIT = 1e6;
  function normalized(value) {
    return value.replace(/\s+/g, " ").trim().toLowerCase();
  }
  function tableHeaders(table) {
    return [...table.querySelectorAll("thead th")].map((cell) => normalized(cell.textContent ?? ""));
  }
  function isPricingTable(table) {
    const headers = tableHeaders(table);
    return headers.includes("model") && headers.includes("input") && headers.includes("output") && headers.includes("cached read") && headers.includes("cached write") && headers.includes("monthly limit");
  }
  function parsePrice(value) {
    const text2 = value.replace(/,/g, "").trim();
    if (!text2 || text2 === "-") return null;
    if (/^free$/i.test(text2)) return 0;
    const match = text2.match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const amount = Number(match[0]);
    return Number.isFinite(amount) && amount >= 0 ? amount : null;
  }
  function parseMonthlyLimit(cell) {
    const strong = [...cell.querySelectorAll("strong")].at(-1)?.textContent ?? cell.textContent ?? "";
    if (/unlimited|free/i.test(strong)) return null;
    return parsePrice(strong);
  }
  function parseContextMarker(label) {
    let displayName = label;
    let maxContextTokens;
    let minContextTokens;
    let period;
    const upper = displayName.match(/\(\s*(?:≤|<=|<)\s*([\d.]+)K tokens\s*\)\s*$/i);
    if (upper) {
      maxContextTokens = Math.round(Number(upper[1]) * 1e3);
      displayName = displayName.slice(0, upper.index).trim();
    } else {
      const lower = displayName.match(/\(\s*>\s*([\d.]+)K tokens\s*\)\s*$/i);
      if (lower) {
        minContextTokens = Math.round(Number(lower[1]) * 1e3) + 1;
        displayName = displayName.slice(0, lower.index).trim();
      }
    }
    const periodMatch = displayName.match(/\((Off-Peak|Peak)\)\s*$/i);
    if (periodMatch) {
      period = periodMatch[1].toLowerCase() === "peak" ? "peak" : "off-peak";
      displayName = displayName.slice(0, periodMatch.index).trim();
    }
    return { displayName, maxContextTokens, minContextTokens, period };
  }
  function emptyQuotaLimits() {
    return { go: {}, "go-plus": {} };
  }
  function parseGoPricingHtml(html) {
    const document2 = new DOMParser().parseFromString(html, "text/html");
    const tables = [...document2.querySelectorAll("table")];
    const pricingTables = tables.filter(isPricingTable);
    const endpointTable = tables.find((table) => {
      const headers = tableHeaders(table);
      return headers.includes("model") && headers.includes("model id");
    });
    if (!pricingTables.length || !endpointTable) {
      throw new Error("Go pricing tables were not found.");
    }
    const modelIDs = /* @__PURE__ */ new Map();
    for (const row of [...endpointTable.querySelectorAll("tbody tr")]) {
      const cells = [...row.querySelectorAll("td")];
      if (cells.length < 2) continue;
      const name = normalized(cells[0].textContent ?? "");
      const modelID = (cells[1].textContent ?? "").trim();
      if (name && modelID) modelIDs.set(name, modelID);
    }
    const planTables = /* @__PURE__ */ new Map();
    for (const panel2 of [...document2.querySelectorAll("[data-plan-panel]")]) {
      const plan = panel2.dataset.planPanel;
      if (plan !== "go" && plan !== "go-plus") continue;
      const table = [...panel2.querySelectorAll("table")].find((candidate) => isPricingTable(candidate));
      if (table) planTables.set(plan, table);
    }
    const remaining = pricingTables.filter((table) => ![...planTables.values()].includes(table));
    if (!planTables.has("go") && remaining.length) planTables.set("go", remaining.shift());
    if (!planTables.has("go-plus") && remaining.length) planTables.set("go-plus", remaining.shift());
    const quotaLimits = emptyQuotaLimits();
    const tiers = [];
    const seenTiers = /* @__PURE__ */ new Set();
    for (const [plan, pricingTable] of planTables) {
      for (const row of [...pricingTable.querySelectorAll("tbody tr")]) {
        const cells = [...row.querySelectorAll("td")];
        if (cells.length < 6) continue;
        const rawName = (cells[0].textContent ?? "").replace(/\s+/g, " ").trim();
        const marker = parseContextMarker(rawName);
        const modelID = modelIDs.get(normalized(marker.displayName));
        if (!modelID) continue;
        quotaLimits[plan][modelID] = parseMonthlyLimit(cells[5]);
        if (plan !== "go") continue;
        const input = parsePrice(cells[1].textContent ?? "");
        const output = parsePrice(cells[2].textContent ?? "");
        if (input === null || output === null) continue;
        const tier = {
          modelID,
          displayName: marker.displayName,
          input,
          output,
          cacheRead: parsePrice(cells[3].textContent ?? ""),
          cacheWrite: parsePrice(cells[4].textContent ?? ""),
          ...marker.maxContextTokens === void 0 ? {} : { maxContextTokens: marker.maxContextTokens },
          ...marker.minContextTokens === void 0 ? {} : { minContextTokens: marker.minContextTokens },
          ...marker.period === void 0 ? {} : { period: marker.period }
        };
        const key = [
          tier.modelID,
          tier.period ?? "",
          tier.minContextTokens ?? "",
          tier.maxContextTokens ?? "",
          tier.input,
          tier.output
        ].join("|");
        if (!seenTiers.has(key)) {
          seenTiers.add(key);
          tiers.push(tier);
        }
      }
    }
    if (!tiers.length) throw new Error("No valid Go pricing rows were parsed.");
    return { tiers, quotaLimits };
  }
  function isGoPricingCacheFresh(cache, now = Date.now()) {
    return Boolean(
      cache && cache.schemaVersion === GO_PRICING_SCHEMA_VERSION && cache.tiers.length > 0 && cache.quotaLimits && now - cache.fetchedAt >= 0 && now - cache.fetchedAt < GO_PRICING_TTL_MS
    );
  }
  async function loadGoPricing(now = Date.now()) {
    const cached = await getMeta(GO_PRICING_CACHE_KEY);
    if (isGoPricingCacheFresh(cached, now)) {
      return { pricing: cached, refreshed: false };
    }
    try {
      const response = await fetch(GO_PRICING_URL, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        headers: { Accept: "text/html" }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = parseGoPricingHtml(await response.text());
      const pricing = {
        fetchedAt: now,
        source: GO_PRICING_URL,
        schemaVersion: GO_PRICING_SCHEMA_VERSION,
        tiers: parsed.tiers,
        quotaLimits: parsed.quotaLimits
      };
      await putMeta(GO_PRICING_CACHE_KEY, pricing);
      return { pricing, refreshed: true };
    } catch (error) {
      return {
        pricing: cached,
        refreshed: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }
  function pricingPeriodForTimestamp(timestamp) {
    const date = new Date(timestamp);
    const day = date.getUTCDay();
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
    const weekday = day >= 1 && day <= 5;
    const peak = weekday && (minutes >= 60 && minutes < 240 || minutes >= 360 && minutes < 600);
    return peak ? "peak" : "off-peak";
  }
  function normalizeGoModelID(value) {
    return value.trim().toLowerCase().replace(/^opencode-go\//, "");
  }
  function selectPricingTier(tiers, record) {
    if (record.provider && !["opencode", "opencode-go"].includes(record.provider.toLowerCase())) {
      return void 0;
    }
    const modelID = normalizeGoModelID(record.model || record.requestedModel);
    let candidates = tiers.filter((tier) => normalizeGoModelID(tier.modelID) === modelID);
    if (!candidates.length) return void 0;
    const period = pricingPeriodForTimestamp(record.startedAt);
    const periodCandidates = candidates.filter((tier) => tier.period !== void 0);
    if (periodCandidates.length) {
      candidates = periodCandidates.filter((tier) => tier.period === period);
    }
    if (!candidates.length) return void 0;
    const contextTokens = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.cacheWrite1hTokens;
    const matching = candidates.filter((tier) => tier.minContextTokens === void 0 || contextTokens >= tier.minContextTokens).filter((tier) => tier.maxContextTokens === void 0 || contextTokens <= tier.maxContextTokens);
    if (!matching.length) return void 0;
    return matching.sort((a, b) => (a.maxContextTokens ?? Number.MAX_SAFE_INTEGER) - (b.maxContextTokens ?? Number.MAX_SAFE_INTEGER))[0];
  }
  function quotaLimitsForModel(pricing, plan, modelID) {
    if (!pricing) return void 0;
    const id = normalizeGoModelID(modelID);
    const limits = pricing.quotaLimits?.[plan];
    if (!limits || !Object.prototype.hasOwnProperty.call(limits, id)) return void 0;
    return limits[id];
  }
  function quotaUsdForRecord(record, tier) {
    if (!tier) return null;
    const cacheWriteTokens = record.cacheWriteTokens + record.cacheWrite1hTokens;
    return record.inputTokens * tier.input / TOKENS_PER_PRICE_UNIT + record.outputTokens * tier.output / TOKENS_PER_PRICE_UNIT + record.cacheReadTokens * (tier.cacheRead ?? 0) / TOKENS_PER_PRICE_UNIT + cacheWriteTokens * (tier.cacheWrite ?? 0) / TOKENS_PER_PRICE_UNIT;
  }
  function estimateModelCostBreakdown(records, model, tiers) {
    if (!tiers?.length) return null;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    for (const record of records) {
      if (record.model !== model.model || record.provider !== model.provider) continue;
      const tier = selectPricingTier(tiers, record);
      if (!tier) return null;
      input += record.inputTokens * tier.input / TOKENS_PER_PRICE_UNIT;
      output += record.outputTokens * tier.output / TOKENS_PER_PRICE_UNIT;
      cacheRead += record.cacheReadTokens * (tier.cacheRead ?? 0) / TOKENS_PER_PRICE_UNIT;
      cacheWrite += (record.cacheWriteTokens + record.cacheWrite1hTokens) * (tier.cacheWrite ?? 0) / TOKENS_PER_PRICE_UNIT;
    }
    const estimatedTotal = input + output + cacheRead + cacheWrite;
    if (estimatedTotal <= 0) {
      if (model.costUsd <= 0) {
        return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, estimated: true };
      }
      return null;
    }
    const scale = model.costUsd / estimatedTotal;
    return {
      input: input * scale,
      output: output * scale,
      cacheRead: cacheRead * scale,
      cacheWrite: cacheWrite * scale,
      total: model.costUsd,
      estimated: true
    };
  }

  // src/forecast.ts
  var MINUTE2 = 6e4;
  var HOUR2 = 60 * MINUTE2;
  var DAY2 = 24 * HOUR2;
  var FIVE_MINUTES = 5 * MINUTE2;
  var FIVE_HOURS = 5 * HOUR2;
  var WEEK = 7 * DAY2;
  var TWENTY_EIGHT_DAYS = 28 * DAY2;
  function clamp2(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function bucketStart(timestamp, bucketMs) {
    return Math.floor(timestamp / bucketMs) * bucketMs;
  }
  function sumEvents(events, from, to) {
    let total = 0;
    for (const event of events) {
      if (event.at >= from && event.at < to) total += event.usd;
    }
    return total;
  }
  function utcWeekStart(timestamp) {
    const date = new Date(timestamp);
    const day = date.getUTCDay();
    const offset = (day + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset);
  }
  function utcMonthStart(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  function nextUtcMonth(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  function resolveWindows(now, status) {
    const weekStart = status?.week.resetsAt !== void 0 ? status.week.resetsAt - WEEK : utcWeekStart(now);
    const weekEnd = status?.week.resetsAt ?? weekStart + WEEK;
    const monthStart = status?.accessStartsAt ?? (status?.month.resetsAt !== void 0 && status.month.resetsAt - 30 * DAY2 <= now ? status.month.resetsAt - 30 * DAY2 : utcMonthStart(now));
    const monthEnd = status?.month.resetsAt ?? status?.accessEndsAt ?? nextUtcMonth(now);
    return {
      fiveHour: {
        startsAt: status?.fiveHour.startsAt ?? (status?.active ? void 0 : now - FIVE_HOURS),
        resetsAt: status?.fiveHour.resetsAt ?? (status?.active ? void 0 : now),
        official: Boolean(status?.active && status.fiveHour.startsAt !== void 0 && status.fiveHour.resetsAt !== void 0)
      },
      week: {
        startsAt: weekStart,
        resetsAt: weekEnd,
        official: Boolean(status?.active && status.week.resetsAt !== void 0)
      },
      month: {
        startsAt: monthStart,
        resetsAt: monthEnd,
        official: Boolean(status?.active && (status.month.resetsAt !== void 0 || status.accessEndsAt !== void 0))
      }
    };
  }
  function slotKey(timestamp, bucketMs) {
    const date = new Date(timestamp);
    if (bucketMs >= DAY2) return String(date.getUTCDay());
    if (bucketMs >= HOUR2) return `${date.getUTCDay()}:${date.getUTCHours()}`;
    return `${date.getUTCDay()}:${date.getUTCHours()}:${Math.floor(date.getUTCMinutes() / 5)}`;
  }
  function createSeasonalStats(events, bucketMs, now) {
    const from = now - TWENTY_EIGHT_DAYS;
    const totals = /* @__PURE__ */ new Map();
    const counts = /* @__PURE__ */ new Map();
    let globalTotal = 0;
    let bucketCount = 0;
    for (let cursor = bucketStart(from, bucketMs); cursor <= now; cursor += bucketMs) {
      const key = slotKey(cursor, bucketMs);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      bucketCount += 1;
    }
    for (const event of events) {
      if (event.at < from || event.at > now) continue;
      const key = slotKey(event.at, bucketMs);
      totals.set(key, (totals.get(key) ?? 0) + event.usd);
      globalTotal += event.usd;
    }
    return { totals, counts, globalMean: bucketCount > 0 ? globalTotal / bucketCount : 0 };
  }
  function seasonalFactor(stats, at, bucketMs) {
    if (stats.globalMean <= 0) return 1;
    const key = slotKey(at, bucketMs);
    const count = stats.counts.get(key) ?? 1;
    const slotMean = (stats.totals.get(key) ?? 0) / count;
    return clamp2((slotMean + 4 * stats.globalMean) / (5 * stats.globalMean), 0.25, 4);
  }
  function dailySpend(events, now) {
    const today = bucketStart(now, DAY2);
    const values = [];
    for (let offset = 13; offset >= 0; offset -= 1) {
      const start = today - offset * DAY2;
      values.push(sumEvents(events, start, start + DAY2));
    }
    return values;
  }
  function trendFactor(events, at, now) {
    const values = dailySpend(events, now);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    if (mean <= 0) return 1;
    const meanX = (values.length - 1) / 2;
    let numerator = 0;
    let denominator = 0;
    for (let index = 0; index < values.length; index += 1) {
      const dx = index - meanX;
      numerator += dx * (values[index] - mean);
      denominator += dx * dx;
    }
    if (denominator === 0) return 1;
    const slope = numerator / denominator / mean;
    const dayOffset = Math.max(0, (at - now) / DAY2);
    return clamp2(1 + slope * dayOffset, 0.75, 1.25);
  }
  function shortRatePerMs(events, now) {
    const last15 = sumEvents(events, now - 15 * MINUTE2, now) / (15 * MINUTE2);
    const last60 = sumEvents(events, now - HOUR2, now) / HOUR2;
    const last24h = sumEvents(events, now - DAY2, now) / DAY2;
    const latest = events.length ? events[events.length - 1].at : 0;
    const activeSession = latest >= now - 15 * MINUTE2;
    if (last60 > 0) return activeSession ? last15 * 0.7 + last60 * 0.3 : last15 * 0.35 + last60 * 0.65;
    return last24h;
  }
  function dayRatePerMs(events, now) {
    return sumEvents(events, now - 14 * DAY2, now) / (14 * DAY2);
  }
  function quantilesFor(key, confidence) {
    const base = {
      fiveHour: { q10: 0.75, q90: 1.35 },
      next24h: { q10: 0.65, q90: 1.55 },
      week: { q10: 0.5, q90: 1.7 },
      month: { q10: 0.4, q90: 1.85 }
    };
    const widen = confidence === "high" ? 1 : confidence === "medium" ? 1.1 : 1.25;
    const selected = base[key];
    return {
      q10: clamp2(1 - (1 - selected.q10) * widen, 0, 1),
      q90: clamp2(1 + (selected.q90 - 1) * widen, 0, 2.5)
    };
  }
  function assessConfidence(records, status, pricing, now, syncState, unpricedRequests) {
    const reasons = [];
    const historyStart = records.length ? Math.min(...records.map((record) => record.startedAt)) : now;
    const historyHours = (now - historyStart) / HOUR2;
    if (!status?.active) reasons.push("forecast.reasonNoStatus");
    if (historyHours < 24) reasons.push("forecast.reasonShortHistory");
    if (syncState?.gapDetected || syncState?.backfillComplete === false) reasons.push("forecast.reasonGap");
    if (!isGoPricingCacheFresh(pricing, now)) reasons.push("forecast.reasonStalePricing");
    if (records.length > 0 && unpricedRequests / records.length > 0.05) reasons.push("forecast.reasonUnpriced");
    if (!reasons.length) return { confidence: "high", reasons };
    if (historyHours < 6 || !status?.active && historyHours < 24) return { confidence: "low", reasons };
    return { confidence: "medium", reasons };
  }
  function collectForecastBuckets(key, events, now, forecastStart, forecastEnd) {
    if (forecastEnd <= forecastStart) return [];
    const bucketMs = key === "fiveHour" ? FIVE_MINUTES : key === "next24h" ? HOUR2 : DAY2;
    const shortRate = shortRatePerMs(events, now);
    const dailyRate = dayRatePerMs(events, now);
    const seasonal = createSeasonalStats(events, bucketMs, now);
    const buckets = [];
    let cursor = forecastStart;
    while (cursor < forecastEnd) {
      const next = Math.min(forecastEnd, bucketStart(cursor, bucketMs) + bucketMs);
      const duration = Math.max(0, next - cursor);
      const midpoint = cursor + duration / 2;
      const season = seasonalFactor(seasonal, midpoint, bucketMs);
      let base;
      if (key === "week" || key === "month") {
        base = dailyRate * duration * season * trendFactor(events, midpoint, now);
      } else if (key === "next24h") {
        const last6h = sumEvents(events, now - 6 * HOUR2, now) / (6 * HOUR2);
        const last24h = sumEvents(events, now - DAY2, now) / DAY2;
        base = (last6h * 0.5 + last24h * 0.5) * duration * season;
      } else {
        base = shortRate * duration * season;
      }
      buckets.push({ from: cursor, to: next, usd: Math.max(0, base) });
      cursor = next;
    }
    return buckets;
  }
  function buildChart(key, events, chartStart, now, forecastEnd, usedUsd, future, q10, q90) {
    const bucketMs = key === "fiveHour" ? FIVE_MINUTES : key === "next24h" ? HOUR2 : DAY2;
    const points = [];
    let actual = 0;
    points.push({ at: chartStart, actualUsd: 0, p10Usd: null, p50Usd: null, p90Usd: null });
    for (let cursor = bucketStart(chartStart, bucketMs); cursor < now; cursor += bucketMs) {
      const end = Math.min(now, cursor + bucketMs);
      if (end < chartStart) continue;
      actual += sumEvents(events, Math.max(cursor, chartStart), end);
      points.push({ at: end, actualUsd: actual, p10Usd: null, p50Usd: null, p90Usd: null });
    }
    if (!points.length || points[points.length - 1].at < now) {
      points.push({ at: now, actualUsd: actual, p10Usd: null, p50Usd: null, p90Usd: null });
    }
    points.push({ at: now, actualUsd: null, p10Usd: usedUsd, p50Usd: usedUsd, p90Usd: usedUsd });
    let cumulative = usedUsd;
    for (const bucket of future) {
      cumulative += bucket.usd;
      points.push({ at: bucket.to, actualUsd: null, p10Usd: usedUsd + (cumulative - usedUsd) * q10, p50Usd: cumulative, p90Usd: usedUsd + (cumulative - usedUsd) * q90 });
    }
    if (points[points.length - 1].at < forecastEnd) {
      points.push({ at: forecastEnd, actualUsd: null, p10Usd: points[points.length - 1].p10Usd, p50Usd: points[points.length - 1].p50Usd, p90Usd: points[points.length - 1].p90Usd });
    }
    return points;
  }
  function buildWindowForecast(key, events, now, bounds, limitUsd, confidence) {
    const isNext24h = key === "next24h";
    const windowStart = isNext24h ? now : bounds.startsAt;
    const windowEnd = isNext24h ? now + DAY2 : bounds.resetsAt ?? (windowStart === void 0 ? void 0 : windowStart + (key === "fiveHour" ? FIVE_HOURS : key === "week" ? WEEK : 30 * DAY2));
    const usedFrom = isNext24h ? now : windowStart ?? now;
    const usedUsd = isNext24h ? 0 : sumEvents(events, usedFrom, now);
    const forecastStart = isNext24h ? now : Math.max(now, windowStart ?? now);
    const forecastEnd = windowEnd ?? now;
    const future = collectForecastBuckets(key, events, now, forecastStart, forecastEnd);
    const futureUsd = future.reduce((sum, bucket) => sum + bucket.usd, 0);
    const { q10, q90 } = quantilesFor(key, confidence);
    const p10Usd = usedUsd + futureUsd * q10;
    const p50Usd = usedUsd + futureUsd;
    const p90Usd = usedUsd + futureUsd * q90;
    const ratio = (value) => limitUsd === null || limitUsd <= 0 ? null : value / limitUsd;
    let hitAt;
    if (limitUsd !== null && limitUsd > 0 && !isNext24h && p50Usd >= limitUsd) {
      if (usedUsd >= limitUsd) hitAt = now;
      else {
        let cumulative = usedUsd;
        for (const bucket of future) {
          if (cumulative + bucket.usd >= limitUsd) {
            const fraction = bucket.usd > 0 ? (limitUsd - cumulative) / bucket.usd : 0;
            hitAt = bucket.from + Math.max(0, Math.min(1, fraction)) * (bucket.to - bucket.from);
            break;
          }
          cumulative += bucket.usd;
        }
      }
    }
    const chartStart = isNext24h ? now - DAY2 : windowStart ?? now;
    const chartEnd = isNext24h ? now + DAY2 : Math.max(now, forecastEnd);
    return {
      key,
      usedUsd,
      p10Usd,
      p50Usd,
      p90Usd,
      limitUsd,
      usedRatio: ratio(usedUsd),
      p10Ratio: ratio(p10Usd),
      p50Ratio: ratio(p50Usd),
      p90Ratio: ratio(p90Usd),
      remainingRatio: isNext24h || limitUsd === null || limitUsd <= 0 ? null : Math.max(0, 1 - p50Usd / limitUsd),
      ...windowStart === void 0 ? {} : { startsAt: windowStart },
      ...windowEnd === void 0 ? {} : { resetsAt: windowEnd },
      ...hitAt === void 0 ? {} : { hitAt },
      windowStarted: isNext24h || windowStart !== void 0 && windowStart <= now,
      chart: buildChart(key, events, chartStart, now, chartEnd, usedUsd, future, q10, q90)
    };
  }
  function buildQuotaForecast(options) {
    const now = options.now ?? Date.now();
    const plan = options.status?.product ?? "go";
    const bounds = resolveWindows(now, options.status);
    const filtered = options.records.filter((record) => matchesFilters(record, options.filters));
    const groups = /* @__PURE__ */ new Map();
    for (const record of filtered) {
      if (record.provider && !["opencode", "opencode-go"].includes(record.provider.toLowerCase())) continue;
      const model = record.model || record.requestedModel || "unknown";
      const provider = record.provider || "";
      const key = `${model}\0${provider}`;
      let group = groups.get(key);
      if (!group) {
        group = { model, provider, displayName: model, records: [], events: [], unpricedRequests: 0 };
        groups.set(key, group);
      }
      group.records.push(record);
      const tier = selectPricingTier(options.pricing.tiers, record);
      const usd = quotaUsdForRecord(record, tier);
      if (usd === null) group.unpricedRequests += 1;
      else {
        group.events.push({ at: record.startedAt, usd });
        group.displayName = tier?.displayName || group.displayName;
      }
    }
    const models = [];
    for (const group of groups.values()) {
      group.events.sort((a, b) => a.at - b.at);
      const consumedUsd = group.events.reduce((sum, event) => sum + event.usd, 0);
      if (consumedUsd <= 0) continue;
      const confidence = assessConfidence(
        group.records,
        options.status,
        options.pricing,
        now,
        options.syncState,
        group.unpricedRequests
      );
      const monthlyLimitUsd = quotaLimitsForModel(options.pricing, plan, group.model);
      const limitKnown = monthlyLimitUsd !== void 0;
      const finiteMonthly = monthlyLimitUsd === void 0 ? null : monthlyLimitUsd;
      const fiveHourLimit = finiteMonthly === null ? null : finiteMonthly / 5;
      const weekLimit = finiteMonthly === null ? null : finiteMonthly / 2;
      const windows = {
        fiveHour: buildWindowForecast("fiveHour", group.events, now, bounds.fiveHour, fiveHourLimit, confidence.confidence),
        next24h: buildWindowForecast("next24h", group.events, now, { official: false }, finiteMonthly, confidence.confidence),
        week: buildWindowForecast("week", group.events, now, bounds.week, weekLimit, confidence.confidence),
        month: buildWindowForecast("month", group.events, now, bounds.month, finiteMonthly, confidence.confidence)
      };
      const riskCandidates = [
        { key: "fiveHour", score: windows.fiveHour.p90Ratio ?? 0 },
        { key: "week", score: windows.week.p90Ratio ?? 0 },
        { key: "month", score: windows.month.p90Ratio ?? 0 }
      ];
      riskCandidates.sort((a, b) => b.score - a.score);
      models.push({
        model: group.model,
        provider: group.provider,
        displayName: group.displayName,
        monthlyLimitUsd: finiteMonthly,
        limitKnown,
        windowLimits: { fiveHour: fiveHourLimit, week: weekLimit, month: finiteMonthly },
        windows,
        riskScore: riskCandidates[0].score,
        riskWindow: riskCandidates[0].score > 0 ? riskCandidates[0].key : null,
        pricedRequests: group.events.length,
        unpricedRequests: group.unpricedRequests,
        totalRequests: group.records.length,
        confidence: confidence.confidence,
        confidenceReasons: confidence.reasons
      });
    }
    models.sort((a, b) => b.riskScore - a.riskScore || b.windows.month.p90Usd - a.windows.month.p90Usd || a.displayName.localeCompare(b.displayName));
    const warnings = [];
    if (!options.status?.active) warnings.push("forecast.reasonNoStatus");
    if (options.statusError) warnings.push("forecast.statusFailed");
    if (!isGoPricingCacheFresh(options.pricing, now)) warnings.push("forecast.reasonStalePricing");
    return {
      generatedAt: now,
      plan,
      officialStatus: Boolean(options.status?.active),
      models,
      riskiest: models.find((model) => model.monthlyLimitUsd !== null && model.windows.month.p90Usd > 0) ?? models[0],
      warnings
    };
  }

  // src/version.ts
  var APP_VERSION = "1.1.0";

  // src/ui/charts.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
  var WIDTH = 620;
  var HEIGHT = 210;
  var PAD = { left: 48, right: 14, top: 18, bottom: 28 };
  function svgElement(tag, attrs = {}) {
    const node3 = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node3.setAttribute(key, String(value));
    return node3;
  }
  function hideChartTooltip(tooltip) {
    if (!tooltip) return;
    tooltip.classList.add("ocgo-hidden");
    tooltip.replaceChildren();
  }
  function tooltipRows(kind, bucket, language) {
    if (kind === "tokens") {
      return [
        [t(language, "table.totalTokens"), formatNumber(bucket.totalTokens)],
        [t(language, "table.input"), formatNumber(bucket.inputTokens)],
        [t(language, "table.cacheRead"), formatNumber(bucket.cacheReadTokens)],
        [t(language, "table.cacheWrite"), formatNumber(bucket.cacheWriteTokens)],
        [t(language, "table.output"), formatNumber(bucket.outputTokens)]
      ];
    }
    if (kind === "cache") {
      return [
        [t(language, "table.hitRate"), formatPercent(bucket.cacheHitRate, 2)],
        [t(language, "table.cacheRead"), formatNumber(bucket.cacheReadTokens)],
        [t(language, "table.cacheWrite"), formatNumber(bucket.cacheWriteTokens)]
      ];
    }
    if (kind === "ttft") {
      return [
        [t(language, "table.ttftAvg"), formatMs(bucket.ttftAvg)],
        [t(language, "table.ttftSlowest"), formatMs(bucket.ttftSlowest)],
        [t(language, "tooltip.ttftSamples"), t(language, "metric.samples", { n: bucket.ttftSamples })]
      ];
    }
    return [
      [t(language, "table.tpsAvg"), formatTps(bucket.tpsAvg)],
      [t(language, "table.tpsSlowest"), formatTps(bucket.tpsSlowest)],
      [t(language, "tooltip.tpsSamples"), t(language, "metric.samples", { n: bucket.tpsSamples })]
    ];
  }
  function showDataTooltip(tooltip, headText, values, container, x, y, footer) {
    tooltip.replaceChildren();
    const head = document.createElement("div");
    head.className = "ocgo-tooltip-head";
    head.textContent = headText;
    const rows = document.createElement("dl");
    rows.className = "ocgo-tooltip-grid";
    for (const [label, value] of values) {
      const term = document.createElement("dt");
      term.textContent = label;
      const detail = document.createElement("dd");
      detail.textContent = value;
      rows.append(term, detail);
    }
    tooltip.append(head, rows);
    if (footer) {
      const note = document.createElement("div");
      note.className = "ocgo-tooltip-note";
      note.textContent = footer;
      tooltip.appendChild(note);
    }
    tooltip.classList.remove("ocgo-hidden");
    positionChartTooltip(tooltip, container, x, y);
  }
  function showChartTooltip(tooltip, bucket, language, kind, container, x, y) {
    showDataTooltip(
      tooltip,
      `${formatDateTime(bucket.start)} – ${formatDateTime(bucket.end)}`,
      tooltipRows(kind, bucket, language),
      container,
      x,
      y
    );
  }
  function tooltipAriaLabel(kind, bucket, language) {
    const values = tooltipRows(kind, bucket, language).map(([label, value]) => `${label} ${value}`).join(" · ");
    return `${formatAxisTime(bucket.start, bucket.end - bucket.start)} · ${values}`;
  }
  function positionChartTooltip(tooltip, container, x, y) {
    const panel2 = container.closest(".ocgo-panel");
    const bounds = panel2?.getBoundingClientRect();
    const leftBound = (bounds?.left ?? 0) + 8;
    const topBound = (bounds?.top ?? 0) + 8;
    const rightBound = (bounds?.right ?? window.innerWidth) - 8;
    const bottomBound = (bounds?.bottom ?? window.innerHeight) - 8;
    const gap = 12;
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    let left = x + gap;
    let top = y + gap;
    if (left + width > rightBound) left = x - width - gap;
    if (top + height > bottomBound) top = y - height - gap;
    left = Math.max(leftBound, Math.min(left, rightBound - width));
    top = Math.max(topBound, Math.min(top, bottomBound - height));
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }
  function addHoverTargets(svg, buckets, plotWidth, plotHeight, container, tooltip, language, kind) {
    if (!tooltip || !buckets.length) return;
    const denominator = Math.max(1, buckets.length - 1);
    const active = svgElement("rect", {
      x: PAD.left,
      y: PAD.top,
      width: 0,
      height: plotHeight,
      class: "ocgo-hover-band"
    });
    active.style.display = "none";
    svg.appendChild(active);
    buckets.forEach((bucket, index) => {
      const leftRatio = buckets.length === 1 ? 0 : Math.max(0, (index - 0.5) / denominator);
      const rightRatio = buckets.length === 1 ? 1 : Math.min(1, (index + 0.5) / denominator);
      const x = PAD.left + plotWidth * leftRatio;
      const width = Math.max(1, plotWidth * (rightRatio - leftRatio));
      const hit = svgElement("rect", {
        x,
        y: PAD.top,
        width,
        height: plotHeight,
        class: "ocgo-hover-target",
        tabindex: 0,
        role: "img",
        "aria-label": tooltipAriaLabel(kind, bucket, language)
      });
      const showAt = (x2, clientX, clientY) => {
        active.setAttribute("x", String(x2));
        active.setAttribute("width", String(width));
        active.style.display = "";
        showChartTooltip(tooltip, bucket, language, kind, container, clientX, clientY);
      };
      const show = (event) => {
        showAt(x, event.clientX, event.clientY);
      };
      hit.addEventListener("pointerenter", show);
      hit.addEventListener("pointermove", (event) => positionChartTooltip(tooltip, container, event.clientX, event.clientY));
      hit.addEventListener("focus", () => {
        const rect = hit.getBoundingClientRect();
        showAt(x, rect.left + rect.width / 2, rect.top + rect.height / 2);
      });
      hit.addEventListener("blur", () => {
        active.style.display = "none";
        hideChartTooltip(tooltip);
      });
      svg.appendChild(hit);
    });
    svg.addEventListener("pointerleave", () => {
      active.style.display = "none";
      hideChartTooltip(tooltip);
    });
  }
  function emptyState(container, language, tooltip) {
    hideChartTooltip(tooltip);
    container.replaceChildren();
    const empty = document.createElement("div");
    empty.className = "ocgo-chart-empty";
    empty.textContent = t(language, "chart.empty");
    container.appendChild(empty);
  }
  function addLegend(container, items) {
    const legend = document.createElement("div");
    legend.className = "ocgo-legend";
    for (const item of items) {
      const entry = document.createElement("span");
      const swatch = document.createElement("i");
      swatch.style.background = item.color;
      entry.append(swatch, document.createTextNode(item.label));
      legend.appendChild(entry);
    }
    container.appendChild(legend);
  }
  function frame(svg, bucketCount) {
    const plotWidth = WIDTH - PAD.left - PAD.right;
    const plotHeight = HEIGHT - PAD.top - PAD.bottom;
    for (let i = 0; i <= 3; i += 1) {
      const y = PAD.top + plotHeight * i / 3;
      svg.appendChild(svgElement("line", {
        x1: PAD.left,
        x2: WIDTH - PAD.right,
        y1: y,
        y2: y,
        class: "ocgo-grid-line"
      }));
    }
    if (bucketCount > 0) {
      const labels = Math.min(5, bucketCount);
      for (let i = 0; i < labels; i += 1) {
        const ratio = labels === 1 ? 0 : i / (labels - 1);
        const x = PAD.left + plotWidth * ratio;
        const bucketIndex = Math.round((bucketCount - 1) * ratio);
        svg.appendChild(svgElement("line", {
          x1: x,
          x2: x,
          y1: PAD.top,
          y2: HEIGHT - PAD.bottom,
          class: "ocgo-grid-line ocgo-grid-line-v"
        }));
        const label = svgElement("text", {
          x,
          y: HEIGHT - 8,
          "text-anchor": i === 0 ? "start" : i === labels - 1 ? "end" : "middle",
          class: "ocgo-axis-label"
        });
        label.dataset.index = String(bucketIndex);
        svg.appendChild(label);
      }
    }
    return { plotWidth, plotHeight };
  }
  function setXAxisLabels(svg, buckets) {
    const bucketMs = buckets.length > 1 ? Math.max(1, buckets[1].start - buckets[0].start) : 24 * 60 * 60 * 1e3;
    const labels = [...svg.querySelectorAll(".ocgo-axis-label[data-index]")];
    for (const label of labels) {
      const index = Number(label.dataset.index ?? 0);
      const bucket = buckets[index];
      if (bucket) label.textContent = formatAxisTime(bucket.start, bucketMs);
    }
  }
  function renderLineSeries(svg, values, color, yMax, plotWidth, plotHeight) {
    const denominator = Math.max(1, values.length - 1);
    const xAt = (index) => PAD.left + plotWidth * index / denominator;
    const yAt = (value) => PAD.top + plotHeight - value / yMax * plotHeight;
    let segment = "";
    const points = [];
    values.forEach((value, index) => {
      if (value === null || !Number.isFinite(value)) {
        if (segment) {
          svg.appendChild(svgElement("path", { d: segment, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
          segment = "";
        }
        return;
      }
      const x = xAt(index);
      const y = yAt(value);
      segment += `${segment ? " L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`;
      points.push([x, y]);
    });
    if (segment) {
      svg.appendChild(svgElement("path", { d: segment, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
    for (const [x, y] of points) {
      svg.appendChild(svgElement("circle", { cx: x, cy: y, r: 4, fill: color, class: "ocgo-point" }));
    }
  }
  function yLabel(svg, value, y) {
    const text2 = svgElement("text", { x: PAD.left - 8, y: y + 4, "text-anchor": "end", class: "ocgo-axis-label" });
    text2.textContent = value;
    svg.appendChild(text2);
  }
  function chartSvg(label) {
    return svgElement("svg", {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      role: "img",
      "aria-label": label,
      class: "ocgo-chart-svg",
      preserveAspectRatio: "xMidYMid meet"
    });
  }
  function renderTokenMix(container, buckets, language, tooltip) {
    hideChartTooltip(tooltip);
    if (!buckets.some((bucket) => bucket.requests > 0)) {
      emptyState(container, language, tooltip);
      return;
    }
    container.replaceChildren();
    const svg = chartSvg(t(language, "chart.tokens"));
    const { plotWidth, plotHeight } = frame(svg, buckets.length);
    const totals = buckets.map((bucket) => bucket.totalTokens);
    const max = Math.max(1, ...totals);
    const gap = 2;
    const barWidth = Math.max(1, Math.min(36, plotWidth / Math.max(1, buckets.length) - gap));
    const series = [
      { key: "inputTokens", color: "#7698fd", label: t(language, "chart.input") },
      { key: "cacheReadTokens", color: "#6bd586", label: t(language, "chart.cacheRead") },
      { key: "cacheWriteTokens", color: "#f2cf76", label: t(language, "chart.cacheWrite") },
      { key: "outputTokens", color: "#9e99f7", label: t(language, "chart.output") }
    ];
    buckets.forEach((bucket, index) => {
      const x = PAD.left + plotWidth * index / Math.max(1, buckets.length - 1) - barWidth / 2;
      let base = PAD.top + plotHeight;
      for (const item of series) {
        const value = bucket[item.key];
        const height = value / max * plotHeight;
        if (height > 0) {
          svg.appendChild(svgElement("rect", {
            x,
            y: base - height,
            width: barWidth,
            height,
            fill: item.color,
            rx: 1,
            class: "ocgo-bar"
          }));
        }
        base -= height;
      }
    });
    yLabel(svg, formatCompact(max), PAD.top);
    yLabel(svg, "0", PAD.top + plotHeight);
    setXAxisLabels(svg, buckets);
    addHoverTargets(svg, buckets, plotWidth, plotHeight, container, tooltip, language, "tokens");
    container.appendChild(svg);
    addLegend(container, series);
  }
  function renderCacheChart(container, buckets, language, tooltip) {
    hideChartTooltip(tooltip);
    const values = buckets.map((bucket) => bucket.cacheHitRate);
    if (!values.some((value) => value !== null)) {
      emptyState(container, language, tooltip);
      return;
    }
    container.replaceChildren();
    const svg = chartSvg(t(language, "chart.cache"));
    const { plotWidth, plotHeight } = frame(svg, buckets.length);
    yLabel(svg, "100%", PAD.top);
    yLabel(svg, "50%", PAD.top + plotHeight / 2);
    yLabel(svg, "0%", PAD.top + plotHeight);
    renderLineSeries(svg, values, "#6bd586", 1, plotWidth, plotHeight);
    setXAxisLabels(svg, buckets);
    addHoverTargets(svg, buckets, plotWidth, plotHeight, container, tooltip, language, "cache");
    container.appendChild(svg);
  }
  function renderPerformanceChart(container, buckets, language, tooltip, kind) {
    hideChartTooltip(tooltip);
    const averageValues = buckets.map((bucket) => bucket[`${kind}Avg`]);
    const slowestValues = buckets.map((bucket) => bucket[`${kind}Slowest`]);
    const values = [...averageValues, ...slowestValues].filter((value) => value !== null);
    if (!values.length) {
      emptyState(container, language, tooltip);
      return;
    }
    container.replaceChildren();
    const max = Math.max(1, ...values) * 1.1;
    const svg = chartSvg(t(language, kind === "ttft" ? "chart.ttft" : "chart.tps"));
    const { plotWidth, plotHeight } = frame(svg, buckets.length);
    const formatter = kind === "ttft" ? formatMs : formatTps;
    yLabel(svg, formatter(max), PAD.top);
    yLabel(svg, formatter(max / 2), PAD.top + plotHeight / 2);
    yLabel(svg, "0", PAD.top + plotHeight);
    const averageColor = kind === "ttft" ? "#7698fd" : "#9e99f7";
    renderLineSeries(svg, averageValues, averageColor, max, plotWidth, plotHeight);
    renderLineSeries(svg, slowestValues, "#f2cf76", max, plotWidth, plotHeight);
    setXAxisLabels(svg, buckets);
    addHoverTargets(svg, buckets, plotWidth, plotHeight, container, tooltip, language, kind);
    container.appendChild(svg);
    addLegend(container, [
      { label: t(language, "chart.average"), color: averageColor },
      { label: t(language, "chart.slowest"), color: "#f2cf76" }
    ]);
  }
  function renderLatencyChart(container, buckets, language, tooltip) {
    renderPerformanceChart(container, buckets, language, tooltip, "ttft");
  }
  function renderTpsChart(container, buckets, language, tooltip) {
    renderPerformanceChart(container, buckets, language, tooltip, "tps");
  }

  // src/ui/forecastPanel.ts
  var WINDOW_KEYS = ["fiveHour", "next24h", "week", "month"];
  var FORECAST_CHART_WIDTH = 760;
  var FORECAST_CHART_HEIGHT = 260;
  var FORECAST_CHART_MARGIN = { left: 44, right: 16, top: 16, bottom: 28 };
  function node(tag, className = "", text2 = "") {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text2) element.textContent = text2;
    return element;
  }
  function windowLabel(language, key) {
    return t(language, `forecast.window${key === "fiveHour" ? "FiveHour" : key === "next24h" ? "24h" : key === "week" ? "Week" : "Month"}`);
  }
  function confidenceLabel(language, model) {
    const key = model.confidence === "high" ? "forecast.confidenceHigh" : model.confidence === "medium" ? "forecast.confidenceMedium" : "forecast.confidenceLow";
    return t(language, key);
  }
  function percentOrUnknown(value) {
    return value === null ? "—" : formatPercent(value);
  }
  function absoluteWindow(window2) {
    if (window2.limitUsd === null) return formatUsd(window2.p50Usd);
    return `${formatUsd(window2.p50Usd)} / ${formatUsd(window2.limitUsd)}`;
  }
  function quantileTitle(window2, language) {
    return t(language, "forecast.p10p50p90", {
      p10: formatUsd(window2.p10Usd),
      p50: formatUsd(window2.p50Usd),
      p90: formatUsd(window2.p90Usd)
    });
  }
  function resetText(language, window2, model) {
    if (window2.key === "next24h") {
      const now = Date.now();
      const boundaries = [
        model.windows.fiveHour.resetsAt,
        model.windows.week.resetsAt,
        model.windows.month.resetsAt
      ].filter((value) => value !== void 0 && value > now && value <= now + 24 * 60 * 60 * 1e3);
      return `${t(language, "forecast.percentOfMonth", { value: formatPercent(window2.p50Ratio) })} · ${boundaries.length ? t(language, "forecast.crosses", { n: boundaries.length }) : t(language, "forecast.noCross")}`;
    }
    if (!window2.windowStarted) return t(language, "forecast.windowNotStarted");
    if (window2.hitAt !== void 0) return t(language, "forecast.hitAt", { time: formatRelative(window2.hitAt, Date.now(), language) });
    if (window2.resetsAt !== void 0 && window2.remainingRatio !== null) {
      return `${t(language, "forecast.remaining", { value: formatPercent(window2.remainingRatio) })} · ${t(language, "forecast.resetAt", { time: formatDateTime(window2.resetsAt) })}`;
    }
    return t(language, "forecast.noHit");
  }
  function chartValue(point, window2, key) {
    const value = key === "actual" ? point.actualUsd : key === "p10" ? point.p10Usd : key === "p50" ? point.p50Usd : point.p90Usd;
    if (value === null) return null;
    if (window2.limitUsd === null || window2.limitUsd <= 0) return value;
    return value / window2.limitUsd;
  }
  function svgPath(points) {
    return points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" ");
  }
  function buildChart2(language, window2, model, windowKey) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("ocgo-forecast-chart");
    svg.setAttribute("viewBox", `0 0 ${FORECAST_CHART_WIDTH} ${FORECAST_CHART_HEIGHT}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", t(language, "forecast.chartAria", { window: windowLabel(language, windowKey) }));
    const points = window2.chart;
    if (!points.length) return svg;
    const margin = FORECAST_CHART_MARGIN;
    const width = FORECAST_CHART_WIDTH - margin.left - margin.right;
    const height = FORECAST_CHART_HEIGHT - margin.top - margin.bottom;
    const xMin = points[0].at;
    const xMax = points[points.length - 1].at;
    const allValues = points.flatMap((point) => [chartValue(point, window2, "actual"), chartValue(point, window2, "p10"), chartValue(point, window2, "p50"), chartValue(point, window2, "p90")]).filter((value) => value !== null && Number.isFinite(value));
    const valuesMax = Math.max(0, ...allValues);
    const rawMax = Math.max(valuesMax * 1.1, window2.limitUsd === null ? 0.01 : 1);
    const yMax = window2.limitUsd === null ? rawMax : valuesMax <= 1 ? 1 : Math.ceil(rawMax * 4) / 4;
    const x = (value) => margin.left + (xMax === xMin ? 0 : (value - xMin) / (xMax - xMin) * width);
    const y = (value) => margin.top + height - Math.max(0, Math.min(yMax, value)) / yMax * height;
    for (let index = 0; index <= 4; index += 1) {
      const value = yMax * index / 4;
      const lineY = y(value);
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(margin.left));
      line.setAttribute("x2", String(margin.left + width));
      line.setAttribute("y1", String(lineY));
      line.setAttribute("y2", String(lineY));
      line.classList.add("ocgo-forecast-gridline");
      svg.appendChild(line);
      const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
      label.setAttribute("x", String(margin.left - 6));
      label.setAttribute("y", String(lineY + 3));
      label.setAttribute("text-anchor", "end");
      label.classList.add("ocgo-forecast-axis-label");
      label.textContent = window2.limitUsd === null ? formatUsd(value) : formatPercent(value, 0);
      svg.appendChild(label);
    }
    const actual = points.map((point) => ({ value: chartValue(point, window2, "actual"), x: x(point.at) })).filter((point) => point.value !== null).map((point) => ({ x: point.x, y: y(point.value) }));
    if (actual.length > 1) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", svgPath(actual));
      path.classList.add("ocgo-forecast-actual");
      svg.appendChild(path);
    }
    const futurePoints = points.filter((point) => point.p50Usd !== null);
    const p50 = futurePoints.map((point) => ({ x: x(point.at), y: y(chartValue(point, window2, "p50") ?? 0) }));
    if (p50.length > 1) {
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", svgPath(p50));
      path.classList.add("ocgo-forecast-p50");
      svg.appendChild(path);
    }
    const band = futurePoints.map((point) => ({ x: x(point.at), top: y(chartValue(point, window2, "p90") ?? 0), bottom: y(chartValue(point, window2, "p10") ?? 0) })).filter((point) => Number.isFinite(point.top) && Number.isFinite(point.bottom));
    if (band.length > 1) {
      const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
      polygon.setAttribute("points", [...band.map((point) => `${point.x.toFixed(2)},${point.top.toFixed(2)}`), ...band.slice().reverse().map((point) => `${point.x.toFixed(2)},${point.bottom.toFixed(2)}`)].join(" "));
      polygon.classList.add("ocgo-forecast-band");
      svg.appendChild(polygon);
    }
    const now = Date.now();
    if (now >= xMin && now <= xMax) {
      const nowLine = document.createElementNS("http://www.w3.org/2000/svg", "line");
      nowLine.setAttribute("x1", String(x(now)));
      nowLine.setAttribute("x2", String(x(now)));
      nowLine.setAttribute("y1", String(margin.top));
      nowLine.setAttribute("y2", String(margin.top + height));
      nowLine.classList.add("ocgo-forecast-now");
      svg.appendChild(nowLine);
    }
    const boundaries = [
      model.windows.fiveHour.resetsAt,
      model.windows.week.resetsAt,
      model.windows.month.resetsAt
    ].filter((value) => value !== void 0 && value >= xMin && value <= xMax);
    for (const boundary of boundaries) {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x(boundary)));
      line.setAttribute("x2", String(x(boundary)));
      line.setAttribute("y1", String(margin.top));
      line.setAttribute("y2", String(margin.top + height));
      line.classList.add("ocgo-forecast-boundary");
      svg.appendChild(line);
    }
    const axisStart = document.createElementNS("http://www.w3.org/2000/svg", "text");
    axisStart.setAttribute("x", String(margin.left));
    axisStart.setAttribute("y", String(FORECAST_CHART_HEIGHT - 8));
    axisStart.setAttribute("text-anchor", "start");
    axisStart.classList.add("ocgo-forecast-axis-label");
    axisStart.textContent = formatDateTime(xMin);
    svg.appendChild(axisStart);
    const axisEnd = document.createElementNS("http://www.w3.org/2000/svg", "text");
    axisEnd.setAttribute("x", String(margin.left + width));
    axisEnd.setAttribute("y", String(FORECAST_CHART_HEIGHT - 8));
    axisEnd.setAttribute("text-anchor", "end");
    axisEnd.classList.add("ocgo-forecast-axis-label");
    axisEnd.textContent = formatDateTime(xMax);
    svg.appendChild(axisEnd);
    return svg;
  }
  var ForecastPanel = class {
    root;
    panel;
    tooltip;
    windowKey = "fiveHour";
    result;
    selectedModel = "";
    language = "en";
    onSelectModel;
    onRetry;
    constructor(root, panel2) {
      this.root = root;
      this.panel = panel2;
    }
    setTooltip(tooltip) {
      this.tooltip = tooltip;
    }
    renderLoading(language) {
      hideChartTooltip(this.tooltip);
      this.root.replaceChildren(this.state(t(language, "forecast.loading"), "ocgo-note"));
    }
    renderError(language, message, onRetry) {
      hideChartTooltip(this.tooltip);
      this.root.replaceChildren();
      const box = node("div", "ocgo-forecast-state");
      box.append(node("div", "ocgo-section-title", t(language, "forecast.error", { error: message })));
      const retry = node("button", "ocgo-btn", t(language, "forecast.retry"));
      retry.type = "button";
      retry.addEventListener("click", onRetry);
      box.appendChild(retry);
      this.root.appendChild(box);
    }
    renderEmpty(language, title = t(language, "forecast.empty"), hint = t(language, "forecast.emptyHint")) {
      hideChartTooltip(this.tooltip);
      this.root.replaceChildren();
      const box = node("div", "ocgo-forecast-state");
      box.append(node("div", "ocgo-section-title", title), node("div", "ocgo-note", hint));
      this.root.appendChild(box);
    }
    render(result, selectedModel, language, onSelectModel, onRetry) {
      this.result = result;
      this.selectedModel = selectedModel;
      this.language = language;
      this.onSelectModel = onSelectModel;
      this.onRetry = onRetry;
      hideChartTooltip(this.tooltip);
      this.root.replaceChildren();
      if (!result.models.length) {
        this.renderEmpty(language);
        return;
      }
      const model = result.models.find((item) => item.model === selectedModel) ?? result.riskiest ?? result.models[0];
      if (!model) {
        this.renderEmpty(language);
        return;
      }
      this.root.appendChild(this.renderHeader(result, model));
      this.root.appendChild(this.renderCards(model));
      this.root.appendChild(this.renderChartSection(result, model));
      this.root.appendChild(this.renderTable(result, model));
      this.root.appendChild(this.renderFooter(result, model));
    }
    state(message, className) {
      const box = node("div", "ocgo-forecast-state");
      box.appendChild(node("div", className, message));
      return box;
    }
    renderHeader(result, model) {
      const header = node("div", "ocgo-forecast-header");
      const text2 = node("div");
      text2.append(
        node("div", "ocgo-section-title", t(this.language, "forecast.summary", { model: model.displayName }))
      );
      if (!this.selectedModel && result.riskiest?.model === model.model) {
        text2.appendChild(node("span", "ocgo-forecast-source", t(this.language, "forecast.riskiest")));
      }
      text2.appendChild(node("div", "ocgo-note", t(this.language, "forecast.noAggregate")));
      const meta = node("div", "ocgo-forecast-meta");
      meta.append(
        node("span", "ocgo-forecast-source", t(this.language, result.officialStatus ? "forecast.sourceOfficial" : "forecast.sourceEstimated")),
        node("span", "ocgo-forecast-confidence", t(this.language, "forecast.confidence", { value: confidenceLabel(this.language, model) }))
      );
      header.append(text2, meta);
      if (!result.officialStatus || result.warnings.includes("forecast.statusFailed")) {
        const warning = node("div", "ocgo-warning", t(this.language, result.warnings.includes("forecast.statusFailed") ? "forecast.statusFailed" : "forecast.noGo"));
        header.appendChild(warning);
      }
      return header;
    }
    renderCards(model) {
      const grid = node("div", "ocgo-forecast-cards");
      for (const key of WINDOW_KEYS) {
        const window2 = model.windows[key];
        const card = node("div", "ocgo-card ocgo-forecast-card");
        const ratio = key === "next24h" ? window2.p50Ratio : window2.p50Ratio;
        const main = !model.limitKnown ? t(this.language, "forecast.unknown") : model.monthlyLimitUsd === null ? t(this.language, "forecast.unlimited") : percentOrUnknown(ratio);
        const value = node("div", "ocgo-card-value", main);
        this.bindValueTooltip(value, model, window2);
        if (window2.p90Ratio !== null && window2.p90Ratio >= 1) value.classList.add("ocgo-danger-text");
        const sub = node("div", "ocgo-card-sub");
        if (!model.limitKnown) {
          sub.textContent = t(this.language, "forecast.noQuotaData");
        } else if (model.monthlyLimitUsd === null) {
          sub.textContent = key === "next24h" ? `${formatUsd(window2.p50Usd)} · ${t(this.language, "forecast.unlimited")}` : formatUsd(window2.p50Usd);
        } else {
          const p90 = window2.p90Ratio === null ? "—" : formatPercent(window2.p90Ratio);
          sub.textContent = `${absoluteWindow(window2)} · ${t(this.language, "forecast.p90Short", { value: p90 })}`;
        }
        card.append(node("div", "ocgo-card-label", windowLabel(this.language, key)), value, sub);
        const detail = node("div", "ocgo-card-detail", resetText(this.language, window2, model));
        detail.title = quantileTitle(window2, this.language);
        card.appendChild(detail);
        grid.appendChild(card);
      }
      return grid;
    }
    renderChartSection(result, model) {
      const section = node("section", "ocgo-section ocgo-forecast-chart-section");
      const head = node("div", "ocgo-section-head");
      const titleGroup = node("div", "ocgo-forecast-chart-title");
      titleGroup.appendChild(node("span", "", t(this.language, "forecast.chartTitle")));
      const info = node("button", "ocgo-info-btn", "i");
      info.type = "button";
      info.title = t(this.language, "forecast.info");
      info.setAttribute("aria-label", t(this.language, "forecast.info"));
      this.bindInfoTooltip(info);
      titleGroup.appendChild(info);
      head.appendChild(titleGroup);
      const controls = node("div", "ocgo-forecast-window-controls");
      for (const key of WINDOW_KEYS) {
        const button2 = node("button", `ocgo-btn ocgo-forecast-window-btn${key === this.windowKey ? " ocgo-active" : ""}`, windowLabel(this.language, key));
        button2.type = "button";
        button2.addEventListener("click", () => {
          this.windowKey = key;
          this.render(result, this.selectedModel, this.language, this.onSelectModel ?? (() => void 0), this.onRetry ?? (() => void 0));
        });
        controls.appendChild(button2);
      }
      head.appendChild(controls);
      const chart = buildChart2(this.language, model.windows[this.windowKey], model, this.windowKey);
      this.bindChartHover(chart, model, model.windows[this.windowKey]);
      section.append(head, chart);
      return section;
    }
    chartValue(value, window2) {
      return window2.limitUsd === null || window2.limitUsd <= 0 ? formatUsd(value) : formatPercent(value / window2.limitUsd);
    }
    bindChartHover(svg, model, window2) {
      const points = window2.chart;
      if (points.length < 2) return;
      const margin = FORECAST_CHART_MARGIN;
      const width = FORECAST_CHART_WIDTH - margin.left - margin.right;
      const height = FORECAST_CHART_HEIGHT - margin.top - margin.bottom;
      const xMin = points[0].at;
      const xMax = points[points.length - 1].at;
      if (xMax <= xMin) return;
      const x = (value) => margin.left + (value - xMin) / (xMax - xMin) * width;
      const band = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      band.classList.add("ocgo-forecast-hover-band");
      band.setAttribute("y", String(margin.top));
      band.setAttribute("height", String(height));
      band.style.display = "none";
      svg.appendChild(band);
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const point = points[index];
        if (point.at <= previous.at) continue;
        const left = x(previous.at);
        const right = x(point.at);
        const hit = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        hit.classList.add("ocgo-forecast-hover-target");
        hit.setAttribute("x", String(left));
        hit.setAttribute("y", String(margin.top));
        hit.setAttribute("width", String(Math.max(1, right - left)));
        hit.setAttribute("height", String(height));
        hit.setAttribute("tabindex", "0");
        hit.setAttribute("role", "img");
        hit.setAttribute("aria-label", `${model.displayName} · ${windowLabel(this.language, window2.key)} · ${formatDateTime(point.at)}`);
        const show = (clientX, clientY) => {
          if (!this.tooltip) return;
          band.setAttribute("x", String(left));
          band.setAttribute("width", String(Math.max(1, right - left)));
          band.style.display = "";
          const rows = [];
          if (point.actualUsd !== null) {
            rows.push([t(this.language, "forecast.chartHistory"), this.chartValue(point.actualUsd, window2)]);
            rows.push([t(this.language, "forecast.absoluteLabel"), formatUsd(point.actualUsd)]);
          }
          if (point.p50Usd !== null) {
            rows.push([t(this.language, "forecast.chartP50"), this.chartValue(point.p50Usd, window2)]);
            if (point.p10Usd !== null) rows.push([t(this.language, "forecast.chartP10"), this.chartValue(point.p10Usd, window2)]);
            if (point.p90Usd !== null) rows.push([t(this.language, "forecast.chartP90"), this.chartValue(point.p90Usd, window2)]);
            rows.push([t(this.language, "forecast.absoluteLabel"), formatUsd(point.p50Usd)]);
          }
          const footer = this.chartExplanation(model, window2, point);
          showDataTooltip(
            this.tooltip,
            `${model.displayName} · ${windowLabel(this.language, window2.key)} · ${formatDateTime(point.at)}`,
            rows,
            this.panel,
            clientX,
            clientY,
            footer
          );
        };
        const showAtTarget = () => {
          const rect = hit.getBoundingClientRect();
          show(rect.right, rect.bottom);
        };
        hit.addEventListener("pointerenter", (event) => show(event.clientX, event.clientY));
        hit.addEventListener("pointermove", (event) => show(event.clientX, event.clientY));
        hit.addEventListener("pointerleave", () => {
          band.style.display = "none";
          hideChartTooltip(this.tooltip);
        });
        hit.addEventListener("focus", showAtTarget);
        hit.addEventListener("blur", () => {
          band.style.display = "none";
          hideChartTooltip(this.tooltip);
        });
        svg.appendChild(hit);
      }
    }
    renderTable(result, selected) {
      const section = node("section", "ocgo-section ocgo-forecast-table-section");
      const head = node("div", "ocgo-section-head");
      head.appendChild(node("span", "", t(this.language, "forecast.tableTitle")));
      section.appendChild(head);
      const wrap = node("div", "ocgo-table-wrap");
      const table = node("table", "ocgo-table ocgo-forecast-table");
      const thead = node("thead");
      const headerRow = node("tr");
      const columns = [
        ["forecast.table.model", "left"],
        ["forecast.table.monthlyLimit", ""],
        ["forecast.table.fiveHour", ""],
        ["forecast.table.week", ""],
        ["forecast.table.month", ""],
        ["forecast.table.next24h", ""],
        ["forecast.table.weekRemaining", ""],
        ["forecast.table.monthRemaining", ""]
      ];
      for (const [key, align] of columns) headerRow.appendChild(node("th", align, t(this.language, key)));
      thead.appendChild(headerRow);
      const body = node("tbody");
      for (const model of result.models) {
        const row = node("tr", `ocgo-forecast-row${model.model === selected.model ? " ocgo-active" : ""}`);
        row.dataset.model = model.model;
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.title = t(this.language, "forecast.selectedModel");
        const choose = () => this.onSelectModel?.(model.model);
        row.addEventListener("click", choose);
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            choose();
          }
        });
        const nameCell = node("td", "left");
        nameCell.append(node("div", "ocgo-forecast-model", model.displayName), node("div", "ocgo-note", model.model));
        if (model.unpricedRequests > 0) nameCell.appendChild(node("div", "ocgo-warning", t(this.language, "forecast.unpriced", { n: model.unpricedRequests })));
        row.appendChild(nameCell);
        row.appendChild(node("td", "", !model.limitKnown ? t(this.language, "forecast.unknown") : model.monthlyLimitUsd === null ? t(this.language, "forecast.unlimited") : formatUsd(model.monthlyLimitUsd)));
        row.appendChild(this.windowTableCell(model, "fiveHour", true));
        row.appendChild(this.windowTableCell(model, "week", true));
        row.appendChild(this.windowTableCell(model, "month", true));
        row.appendChild(this.windowTableCell(model, "next24h", false));
        const weekRemaining = node("td", "", model.windows.week.remainingRatio === null ? "—" : formatPercent(model.windows.week.remainingRatio));
        this.bindValueTooltip(weekRemaining, model, model.windows.week);
        const monthRemaining = node("td", "", model.windows.month.remainingRatio === null ? "—" : formatPercent(model.windows.month.remainingRatio));
        this.bindValueTooltip(monthRemaining, model, model.windows.month);
        row.append(weekRemaining, monthRemaining);
        body.appendChild(row);
      }
      table.append(thead, body);
      wrap.appendChild(table);
      section.appendChild(wrap);
      return section;
    }
    windowTableCell(model, key, used) {
      const window2 = model.windows[key];
      const cell = node("td");
      if (!model.limitKnown) {
        cell.textContent = t(this.language, "forecast.unknown");
      } else if (model.monthlyLimitUsd === null) {
        cell.textContent = key === "next24h" ? formatUsd(window2.p50Usd) : t(this.language, "forecast.unlimited");
      } else {
        cell.textContent = percentOrUnknown(used ? window2.usedRatio : window2.p50Ratio);
      }
      cell.title = `${quantileTitle(window2, this.language)} · ${absoluteWindow(window2)}`;
      this.bindValueTooltip(cell, model, window2);
      return cell;
    }
    bindValueTooltip(element, model, window2) {
      element.classList.add("ocgo-forecast-percent");
      element.tabIndex = 0;
      const show = (clientX, clientY) => {
        if (!this.tooltip) return;
        const rows = [];
        if (!model.limitKnown) {
          rows.push([t(this.language, "forecast.absolute"), t(this.language, "forecast.noQuotaData")]);
        } else if (model.monthlyLimitUsd === null) {
          rows.push([t(this.language, "forecast.absolute"), t(this.language, "forecast.unlimited")]);
          rows.push([t(this.language, "forecast.projected"), formatUsd(window2.p50Usd)]);
        } else {
          if (window2.key !== "next24h") rows.push([t(this.language, "forecast.usedLabel"), percentOrUnknown(window2.usedRatio)]);
          rows.push([t(this.language, "forecast.projectedLabel"), percentOrUnknown(window2.p50Ratio)]);
          rows.push([t(this.language, "forecast.p90Label"), percentOrUnknown(window2.p90Ratio)]);
          rows.push([t(this.language, "forecast.absoluteLabel"), `${formatUsd(window2.p50Usd)} / ${formatUsd(window2.limitUsd)}`]);
        }
        if (window2.resetsAt !== void 0) {
          rows.push([
            t(this.language, window2.key === "next24h" ? "forecast.forecastEndLabel" : "forecast.resetLabel"),
            formatDateTime(window2.resetsAt)
          ]);
        }
        if (window2.hitAt !== void 0) rows.push([t(this.language, "forecast.hitLabel"), formatDateTime(window2.hitAt)]);
        const footer = this.cardExplanation(model, window2);
        showDataTooltip(
          this.tooltip,
          `${model.displayName} · ${windowLabel(this.language, window2.key)}`,
          rows,
          this.panel,
          clientX,
          clientY,
          footer
        );
      };
      const showAtElement = () => {
        const rect = element.getBoundingClientRect();
        show(rect.right, rect.bottom);
      };
      element.addEventListener("pointerenter", (event) => show(event.clientX, event.clientY));
      element.addEventListener("pointermove", (event) => show(event.clientX, event.clientY));
      element.addEventListener("pointerleave", () => hideChartTooltip(this.tooltip));
      element.addEventListener("focus", showAtElement);
      element.addEventListener("blur", () => hideChartTooltip(this.tooltip));
    }
    bindInfoTooltip(button2) {
      const show = (clientX, clientY) => {
        if (!this.tooltip) return;
        showDataTooltip(
          this.tooltip,
          t(this.language, "forecast.infoHead"),
          [
            [t(this.language, "forecast.infoHistory"), t(this.language, "forecast.infoHistoryDesc")],
            [t(this.language, "forecast.infoForecast"), t(this.language, "forecast.infoForecastDesc")],
            [t(this.language, "forecast.infoBand"), t(this.language, "forecast.infoBandDesc")],
            [t(this.language, "forecast.infoMethod"), t(this.language, "forecast.infoMethodDesc")]
          ],
          this.panel,
          clientX,
          clientY,
          t(this.language, "forecast.infoFooter")
        );
      };
      const showAtButton = () => {
        const rect = button2.getBoundingClientRect();
        show(rect.right, rect.bottom);
      };
      button2.addEventListener("pointerenter", (event) => show(event.clientX, event.clientY));
      button2.addEventListener("pointerleave", () => hideChartTooltip(this.tooltip));
      button2.addEventListener("focus", showAtButton);
      button2.addEventListener("blur", () => hideChartTooltip(this.tooltip));
    }
    cardExplanation(model, window2) {
      if (!model.limitKnown) return t(this.language, "forecast.noQuotaData");
      if (model.monthlyLimitUsd === null || window2.p50Ratio === null) return t(this.language, "forecast.unlimited");
      if (window2.key === "fiveHour") return t(this.language, "forecast.explainFiveHour", { value: formatPercent(window2.p50Ratio) });
      if (window2.key === "week") return t(this.language, "forecast.explainWeek", { value: formatPercent(window2.p50Ratio) });
      if (window2.key === "month") return t(this.language, "forecast.explainMonth", { value: formatPercent(window2.p50Ratio) });
      const monthUsed = model.windows.month.usedRatio ?? 0;
      return t(this.language, "forecast.explain24h", {
        value: formatPercent(window2.p50Ratio),
        arrival: formatPercent(monthUsed + window2.p50Ratio)
      });
    }
    chartExplanation(model, window2, point) {
      if (!model.limitKnown || window2.limitUsd === null || window2.limitUsd <= 0) {
        return !model.limitKnown ? t(this.language, "forecast.noQuotaData") : t(this.language, "forecast.unlimited");
      }
      if (point.actualUsd !== null) {
        return t(this.language, "forecast.explainHistory", { value: formatPercent(point.actualUsd / window2.limitUsd) });
      }
      if (point.p50Usd === null) return t(this.language, "forecast.noQuotaData");
      const ratio = point.p50Usd / window2.limitUsd;
      if (window2.key === "next24h") {
        const monthUsed = model.windows.month.usedRatio ?? 0;
        return t(this.language, "forecast.explain24hToPoint", {
          value: formatPercent(ratio),
          arrival: formatPercent(monthUsed + ratio)
        });
      }
      return t(this.language, "forecast.explainPoint", { value: formatPercent(ratio) });
    }
    renderFooter(result, model) {
      const footer = node("div", "ocgo-forecast-footer");
      footer.append(
        node("span", "ocgo-note", t(this.language, "forecast.rangeIgnored")),
        node("span", "ocgo-note", t(this.language, "forecast.asOf", { time: formatDateTime(result.generatedAt) }))
      );
      if (model.confidenceReasons.length) {
        const reasons = model.confidenceReasons.map((key) => t(this.language, key)).join(" · ");
        footer.appendChild(node("span", "ocgo-warning", `${t(this.language, "forecast.confidence", { value: confidenceLabel(this.language, model) })} — ${reasons}`));
      }
      return footer;
    }
  };

  // src/ui/styles.ts
  var panelCss = `
:host {
  all: initial;
  color-scheme: dark;
  --bg: #080808;
  --bg2: #161616;
  --panel: #161616;
  --surface: #242424;
  --surface-2: #2e2e2e;
  --line: rgba(255,255,255,.10);
  --line-soft: rgba(255,255,255,.078);
  --line-strong: rgba(255,255,255,.20);
  --fg: #fafafa;
  --muted: #aeaeae;
  --faint: #808080;
  --accent: #a2bcff;
  --blue: #7698fd;
  --green: #6bd586;
  --yellow: #f2cf76;
  --violet: #9e99f7;
  --danger: #f17471;
  --radius: 8px;
  --shadow-raised: 0 2px 4px rgba(0,0,0,.3), 0 1px 2px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.16), 0 -.5px 0 rgba(255,255,255,.06);
  --shadow-floating: 0 16px 32px rgba(0,0,0,.3), 0 8px 16px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.16), 0 -.5px 0 rgba(255,255,255,.06);
  font: 12px/1.48 Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
* { box-sizing: border-box; }
button, select, input { font: inherit; }
.ocgo-fab {
  position: fixed; right: 20px; bottom: 20px; width: 48px; height: 48px; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.20); background: #080808; color: #fafafa; cursor: grab;
  z-index: 2147483647; display: grid; place-items: center; box-shadow: 0 8px 16px rgba(0,0,0,.3), 0 0 0 .5px rgba(255,255,255,.16);
  touch-action: none; user-select: none;
  transition: transform .12s ease, box-shadow .12s ease, border-color .12s ease;
}
.ocgo-fab:hover { transform: scale(1.04); border-color: rgba(255,255,255,.33); box-shadow: 0 8px 16px rgba(0,0,0,.4), 0 0 0 .5px rgba(255,255,255,.20); }
.ocgo-fab.ocgo-open { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(118,152,253,.18), 0 8px 16px rgba(0,0,0,.4); }
.ocgo-fab.ocgo-dragging { cursor: grabbing; transform: none; }
.ocgo-fab svg { width: 32px; height: 32px; display: block; }
.ocgo-panel {
  position: fixed; right: 20px; bottom: 80px; z-index: 2147483646;
  width: min(980px, calc(100vw - 32px)); height: min(760px, calc(100vh - 104px));
  min-width: 680px; min-height: 480px; display: flex; flex-direction: column;
  color: var(--fg); background: var(--panel);
  border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden;
  box-shadow: var(--shadow-floating);
}
.ocgo-panel.ocgo-hidden, .ocgo-error.ocgo-hidden, .ocgo-chart-tooltip.ocgo-hidden { display: none; }
.ocgo-header { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-bottom: 1px solid var(--line); cursor: grab; background: #161616; user-select: none; }
.ocgo-header:active { cursor: grabbing; }
.ocgo-brand { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.ocgo-title { font-size: 13px; font-weight: 720; letter-spacing: .15px; }
.ocgo-subtitle { color: var(--faint); font-size: 10px; letter-spacing: .35px; text-transform: uppercase; }
.ocgo-workspace { color: var(--muted); max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 3px 8px; border: 1px solid var(--line-soft); border-radius: 999px; background: rgba(255,255,255,.025); }
.ocgo-icon-btn, .ocgo-btn, .ocgo-tab, .ocgo-sync-btn, .ocgo-danger-btn {
  border: 1px solid var(--line); background: rgba(255,255,255,.045); color: var(--fg); border-radius: 7px; cursor: pointer;
}
.ocgo-icon-btn { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; color: var(--muted); }
.ocgo-icon-btn:hover, .ocgo-btn:hover, .ocgo-tab:hover { background: rgba(255,255,255,.09); color: #fff; }
.ocgo-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line-soft); background: #161616; }
.ocgo-toolbar label { display: flex; align-items: center; gap: 4px; color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: .35px; }
.ocgo-toolbar label[hidden] { display: none !important; }
select, input[type="datetime-local"] {
  background: #080808; border: 1px solid var(--line); color: var(--fg); border-radius: 6px; padding: 4px 7px; outline: none; max-width: 190px;
}
select:focus, input:focus { border-color: rgba(118,152,253,.75); }
.ocgo-sync-btn { padding: 5px 10px; background: #fafafa; color: #161616; border-color: #fafafa; font-weight: 650; }
.ocgo-sync-btn:hover { background: #ffffff; }
.ocgo-sync-btn:disabled { opacity: .55; cursor: wait; }
.ocgo-sync-btn.ocgo-stop { background: var(--yellow); border-color: var(--yellow); }
.ocgo-btn { padding: 5px 9px; }
.ocgo-danger-btn { padding: 5px 9px; border-color: rgba(241,116,113,.45); color: #f29b96; background: rgba(241,116,113,.08); }
.ocgo-danger-btn.ocgo-confirm { background: #f17471; color: #161616; font-weight: 700; }
.ocgo-custom-range { display: none; align-items: center; gap: 6px; }
.ocgo-custom-range.ocgo-show { display: flex; }
.ocgo-tabs { display: flex; padding: 0 12px; border-bottom: 1px solid var(--line); background: #161616; }
.ocgo-tab { flex: 1; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 8px 4px; color: var(--muted); }
.ocgo-tab.ocgo-active { color: #fafafa; border-bottom-color: #fafafa; }
.ocgo-statusbar { min-height: 29px; display: flex; align-items: center; gap: 8px; padding: 5px 12px; border-bottom: 1px solid var(--line-soft); color: var(--muted); font-size: 11px; }
.ocgo-status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); flex: 0 0 auto; }
.ocgo-status-dot.ok { background: var(--green); box-shadow: 0 0 8px rgba(107,213,134,.55); }
.ocgo-status-dot.busy { background: var(--yellow); animation: ocgoPulse 1s ease-in-out infinite; }
.ocgo-status-dot.err { background: var(--danger); }
@keyframes ocgoPulse { 50% { opacity: .35; } }
.ocgo-body { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.ocgo-view { display: none; flex-direction: column; gap: 12px; }
.ocgo-view.ocgo-active { display: flex; }
.ocgo-error { margin: 8px 12px 0; border: 1px solid rgba(241,116,113,.35); background: rgba(241,116,113,.08); color: #f29b96; border-radius: 8px; padding: 7px 9px; }
.ocgo-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ocgo-card { border: 1px solid var(--line-soft); background: var(--surface); border-radius: 8px; padding: 10px 11px; min-width: 0; box-shadow: 0 0 0 .5px rgba(255,255,255,.08) inset; }
.ocgo-card-label { color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: .45px; }
.ocgo-card-value { margin-top: 3px; font: 600 17px/1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; letter-spacing: -.2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ocgo-card-sub { margin-top: 3px; color: var(--faint); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ocgo-card.accent .ocgo-card-value { color: var(--green); }
.ocgo-card.blue .ocgo-card-value { color: var(--blue); }
.ocgo-card.violet .ocgo-card-value { color: var(--violet); }
.ocgo-section { border: 1px solid var(--line-soft); border-radius: 8px; background: var(--surface); padding: 10px; box-shadow: var(--shadow-raised); }
.ocgo-section-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
.ocgo-section-title { font-size: 12px; font-weight: 680; color: var(--fg); }
.ocgo-section-note { color: var(--faint); font-size: 10px; }
.ocgo-chart-controls { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
.ocgo-chart-zoom-label { color: var(--faint); font-size: 10px; text-transform: uppercase; letter-spacing: .35px; }
.ocgo-chart-zoom { display: inline-flex; align-items: stretch; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; background: #161616; }
.ocgo-zoom-btn, .ocgo-zoom-value { border: 0; background: transparent; color: var(--muted); cursor: pointer; padding: 3px 8px; min-width: 28px; }
.ocgo-zoom-btn:hover, .ocgo-zoom-value:hover { background: rgba(255,255,255,.08); color: var(--fg); }
.ocgo-zoom-btn:disabled { opacity: .35; cursor: default; }
.ocgo-zoom-value { min-width: 52px; border-left: 1px solid var(--line); border-right: 1px solid var(--line); color: var(--fg); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.ocgo-chart-grid.ocgo-chart-zoomed { grid-template-columns: 1fr; }
.ocgo-chart-box { min-height: var(--ocgo-chart-box-height, 250px); display: flex; flex-direction: column; }
.ocgo-chart-host { flex: 0 0 auto; display: flex; flex-direction: column; overflow: visible; }
.ocgo-chart-svg { width: var(--ocgo-chart-width, 100%); height: var(--ocgo-chart-height, 195px); overflow: visible; flex: 0 0 auto; }
.ocgo-chart-title-group { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 9px; min-width: 0; }
.ocgo-section-average { color: var(--faint); font-size: 10px; font-weight: 400; }
.ocgo-grid-line { stroke: rgba(255,255,255,.07); stroke-width: 1; }
.ocgo-grid-line-v { stroke-dasharray: 3 5; }
.ocgo-axis-label { fill: var(--faint); font-size: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-point { cursor: default; }
.ocgo-bar { opacity: .92; }
.ocgo-hover-band { fill: rgba(255,255,255,.055); pointer-events: none; }
.ocgo-hover-target { fill: transparent; pointer-events: all; }
.ocgo-hover-target:focus { outline: none; }
.ocgo-legend { display: flex; gap: 10px; flex-wrap: wrap; color: var(--muted); font-size: 9px; padding: 0 6px; }
.ocgo-legend span { display: inline-flex; align-items: center; gap: 4px; }
.ocgo-legend i { width: 7px; height: 7px; border-radius: 2px; display: inline-block; }
.ocgo-chart-empty { flex: 1; display: grid; place-items: center; color: var(--faint); min-height: 170px; text-align: center; }
.ocgo-table-wrap { overflow: auto; border: 1px solid var(--line-soft); border-radius: 9px; max-height: 420px; }
.ocgo-table { width: 100%; border-collapse: collapse; font-size: 10.5px; }
.ocgo-table th, .ocgo-table td { padding: 6px 7px; border-bottom: 1px solid var(--line-soft); text-align: right; white-space: nowrap; }
.ocgo-table th { position: sticky; top: 0; z-index: 1; background: var(--surface-2); color: var(--muted); font-size: 9px; text-transform: uppercase; letter-spacing: .35px; }
.ocgo-table td { color: #dbdbdb; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-table th:first-child, .ocgo-table td:first-child, .ocgo-table th.left, .ocgo-table td.left { text-align: left; font-family: inherit; }
.ocgo-table tr:last-child td { border-bottom: 0; }
.ocgo-table tbody tr:hover td { background: rgba(255,255,255,.025); }
.ocgo-table a { color: var(--accent); text-decoration: none; }
.ocgo-table a:hover { text-decoration: underline; }
.ocgo-muted { color: var(--muted); }
.ocgo-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 999px; font: 600 9px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; border: 1px solid var(--line); }
.ocgo-pill.succeeded { color: #b8e9c1; border-color: rgba(107,213,134,.28); background: rgba(107,213,134,.07); }
.ocgo-pill.failed, .ocgo-pill.rejected { color: #f29b96; border-color: rgba(241,116,113,.28); background: rgba(241,116,113,.07); }
.ocgo-pill.cancelled { color: #f2cf76; border-color: rgba(242,207,118,.28); background: rgba(242,207,118,.07); }
.ocgo-pill.legacy { color: var(--muted); border-color: var(--line); background: rgba(255,255,255,.04); }
.ocgo-empty { border: 1px dashed var(--line); border-radius: 10px; padding: 34px 16px; text-align: center; color: var(--muted); }
.ocgo-empty strong { display: block; color: var(--fg); margin-bottom: 4px; }
.ocgo-toolbar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.ocgo-pager { display: flex; align-items: center; justify-content: flex-end; gap: 6px; color: var(--muted); font-size: 10px; }
.ocgo-data-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.ocgo-kv { display: grid; grid-template-columns: 120px minmax(0, 1fr); gap: 6px 10px; font-size: 11px; }
.ocgo-kv dt { color: var(--faint); }
.ocgo-kv dd { margin: 0; color: var(--fg); overflow-wrap: anywhere; }
.ocgo-note { color: var(--muted); font-size: 10.5px; line-height: 1.5; }
.ocgo-warning { border: 1px solid rgba(242,207,118,.35); background: rgba(242,207,118,.07); color: #f2cf76; border-radius: 8px; padding: 7px 9px; font-size: 10.5px; }
.ocgo-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.ocgo-pricing-meta { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 8px; color: var(--faint); font-size: 10px; }
.ocgo-pricing-meta a { color: var(--accent); text-decoration: none; }
.ocgo-pricing-meta a:hover { text-decoration: underline; }
.ocgo-pricing-table-wrap { max-height: 260px; }
.ocgo-price-period { display: inline-flex; align-items: center; padding: 1px 6px; border: 1px solid var(--line); border-radius: 999px; font: 600 9px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-price-period.peak { color: #f2cf76; border-color: rgba(242,207,118,.28); background: rgba(242,207,118,.07); }
.ocgo-price-period.off-peak { color: #b8e9c1; border-color: rgba(107,213,134,.28); background: rgba(107,213,134,.07); }
.ocgo-price-period.all { color: var(--muted); background: rgba(255,255,255,.04); }
.ocgo-log-list { max-height: 190px; overflow: auto; border: 1px solid var(--line-soft); border-radius: 8px; padding: 6px; background: #080808; font: 10px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-log-row { display: grid; grid-template-columns: 54px 44px minmax(0, 1fr); gap: 6px; padding: 1px 0; border-bottom: 1px solid rgba(255,255,255,.04); }
.ocgo-log-row:last-child { border-bottom: 0; }
.ocgo-log-time { color: var(--faint); }
.ocgo-log-level { color: var(--muted); text-transform: uppercase; }
.ocgo-log-level.error { color: var(--danger); }
.ocgo-log-level.warn { color: var(--yellow); }
.ocgo-log-msg { color: #dbdbdb; overflow-wrap: anywhere; }
.ocgo-resize-handle { position: absolute; z-index: 5; touch-action: none; }
.ocgo-resize-n, .ocgo-resize-s { left: 10px; right: 10px; height: 8px; }
.ocgo-resize-e, .ocgo-resize-w { top: 10px; bottom: 10px; width: 8px; }
.ocgo-resize-n { top: 0; cursor: n-resize; }
.ocgo-resize-s { bottom: 0; cursor: s-resize; }
.ocgo-resize-e { right: 0; cursor: e-resize; }
.ocgo-resize-w { left: 0; cursor: w-resize; }
.ocgo-resize-ne, .ocgo-resize-nw, .ocgo-resize-se, .ocgo-resize-sw { width: 14px; height: 14px; }
.ocgo-resize-ne { top: 0; right: 0; cursor: ne-resize; }
.ocgo-resize-nw { top: 0; left: 0; cursor: nw-resize; }
.ocgo-resize-se { right: 0; bottom: 0; cursor: nwse-resize; }
.ocgo-resize-se::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 7px; height: 7px; border-right: 1px solid var(--muted); border-bottom: 1px solid var(--muted); }
.ocgo-resize-sw { left: 0; bottom: 0; cursor: nesw-resize; }
.ocgo-chart-tooltip {
  position: fixed; z-index: 2147483647; width: 296px; max-width: calc(100vw - 32px);
  pointer-events: none; border: 1px solid var(--line-strong); border-radius: 8px;
  background: var(--surface); color: var(--fg); padding: 9px 10px;
  box-shadow: var(--shadow-floating);
  font-size: 10px; line-height: 1.45;
}
.ocgo-tooltip-head { color: #fafafa; font-weight: 650; padding-bottom: 5px; margin-bottom: 5px; border-bottom: 1px solid var(--line-soft); }
.ocgo-tooltip-grid { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 2px 8px; margin: 0; }
.ocgo-tooltip-grid dt { color: var(--faint); }
.ocgo-tooltip-grid dd { margin: 0; color: #dbdbdb; text-align: right; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-tooltip-note { margin-top: 6px; padding-top: 5px; border-top: 1px solid var(--line-soft); color: var(--faint); line-height: 1.4; }
.ocgo-toast {
  position: absolute; left: 50%; top: 10px; z-index: 8; width: max-content; max-width: min(280px, calc(100% - 36px));
  padding: 6px 10px; border: 1px solid var(--line-strong); border-radius: 10px;
  background: var(--surface); color: var(--fg); box-shadow: var(--shadow-floating);
  font-size: 10.5px; line-height: 1.4; text-align: center; pointer-events: none;
  transform: translateX(-50%);
}
.ocgo-toast.ocgo-hidden { display: none; }
.ocgo-toast.ocgo-toast-in { animation: ocgoToastDrop .22s cubic-bezier(.2,.8,.2,1); }
@keyframes ocgoToastDrop {
  from { opacity: 0; transform: translate(-50%, -10px) scale(.98); }
  to { opacity: 1; transform: translate(-50%, 0) scale(1); }
}
.ocgo-metric-hover { cursor: help; text-decoration: underline; text-decoration-style: dotted; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.ocgo-metric-hover:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }
.ocgo-body, .ocgo-table-wrap, .ocgo-log-list, .ocgo-chart-host {
  scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent;
}
.ocgo-body::-webkit-scrollbar, .ocgo-table-wrap::-webkit-scrollbar, .ocgo-log-list::-webkit-scrollbar, .ocgo-chart-host::-webkit-scrollbar {
  width: 8px; height: 8px;
}
.ocgo-body::-webkit-scrollbar-track, .ocgo-table-wrap::-webkit-scrollbar-track, .ocgo-log-list::-webkit-scrollbar-track, .ocgo-chart-host::-webkit-scrollbar-track {
  background: transparent;
}
.ocgo-body::-webkit-scrollbar-thumb, .ocgo-table-wrap::-webkit-scrollbar-thumb, .ocgo-log-list::-webkit-scrollbar-thumb, .ocgo-chart-host::-webkit-scrollbar-thumb {
  background: #5c5c5c; border: 2px solid transparent; border-radius: 999px; background-clip: padding-box;
}
.ocgo-body::-webkit-scrollbar-thumb:hover, .ocgo-table-wrap::-webkit-scrollbar-thumb:hover, .ocgo-log-list::-webkit-scrollbar-thumb:hover, .ocgo-chart-host::-webkit-scrollbar-thumb:hover {
  background: #808080; border: 2px solid transparent; border-radius: 999px; background-clip: padding-box;
}
.ocgo-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 820px) {
  .ocgo-panel { left: 8px !important; right: 8px !important; top: 8px !important; bottom: 8px !important; width: auto !important; height: auto !important; min-width: 0; min-height: 0; }
  .ocgo-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .ocgo-chart-grid, .ocgo-data-grid { grid-template-columns: 1fr; }
  .ocgo-resize-handle { display: none; }
  .ocgo-workspace { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .ocgo-status-dot.busy { animation: none; }
  .ocgo-fab { transition: none; }
}
.ocgo-tab-badge { margin-left: 4px; padding: 0 4px; border: 1px solid rgba(118,152,253,.38); border-radius: 999px; color: var(--accent); font-size: 8px; line-height: 1.5; vertical-align: 1px; }
.ocgo-experimental { display: flex; flex-direction: column; gap: 6px; }
.ocgo-experimental-row { display: flex; align-items: center; gap: 8px; color: var(--fg); font-size: 11px; }
.ocgo-experimental-row input { accent-color: var(--accent); }
.ocgo-forecast-view { display: flex; flex-direction: column; gap: 10px; }
.ocgo-forecast-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
.ocgo-forecast-meta { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.ocgo-forecast-source, .ocgo-forecast-confidence { padding: 3px 7px; border: 1px solid var(--line); border-radius: 999px; color: var(--muted); background: rgba(255,255,255,.025); font-size: 9px; }
.ocgo-forecast-cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.ocgo-forecast-card { min-height: 116px; }
.ocgo-forecast-card .ocgo-card-value { font-size: 18px; }
.ocgo-card-detail { margin-top: 5px; color: var(--faint); font-size: 9.5px; line-height: 1.4; }
.ocgo-danger-text { color: var(--danger) !important; }
.ocgo-forecast-chart-section .ocgo-section-head { align-items: center; }
.ocgo-forecast-window-controls { display: flex; gap: 4px; flex-wrap: wrap; }
.ocgo-forecast-window-btn.ocgo-active { border-color: rgba(118,152,253,.72); color: var(--accent); background: rgba(118,152,253,.10); }
.ocgo-forecast-chart { width: 100%; height: 250px; display: block; }
.ocgo-forecast-gridline { stroke: rgba(255,255,255,.07); stroke-width: 1; }
.ocgo-forecast-axis-label { fill: var(--faint); font: 9px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.ocgo-forecast-actual { fill: none; stroke: var(--accent); stroke-width: 2; }
.ocgo-forecast-p50 { fill: none; stroke: var(--violet); stroke-width: 2; stroke-dasharray: 5 4; }
.ocgo-forecast-band { fill: rgba(158,153,247,.13); stroke: none; }
.ocgo-forecast-now { stroke: rgba(250,250,250,.45); stroke-width: 1; stroke-dasharray: 3 4; }
.ocgo-forecast-boundary { stroke: rgba(242,207,118,.28); stroke-width: 1; stroke-dasharray: 2 5; }
.ocgo-forecast-table-wrap { max-height: 300px; }
.ocgo-forecast-row { cursor: pointer; }
.ocgo-forecast-row.ocgo-active td { background: rgba(118,152,253,.075); }
.ocgo-forecast-row:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }
.ocgo-forecast-model { color: var(--fg); font-weight: 600; }
.ocgo-forecast-table td:nth-child(2), .ocgo-forecast-table td:nth-child(3), .ocgo-forecast-table td:nth-child(4), .ocgo-forecast-table td:nth-child(5), .ocgo-forecast-table td:nth-child(6) { font-variant-numeric: tabular-nums; }
.ocgo-forecast-state { border: 1px dashed var(--line); border-radius: 10px; padding: 26px 16px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--muted); }
.ocgo-forecast-footer { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.ocgo-forecast-footer .ocgo-warning { flex-basis: 100%; }
@media (max-width: 980px) { .ocgo-forecast-cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 560px) { .ocgo-forecast-cards { grid-template-columns: 1fr; } .ocgo-forecast-chart { height: 210px; } }

.ocgo-forecast-chart-title { display: flex; align-items: center; gap: 6px; }
.ocgo-info-btn { width: 18px; height: 18px; display: inline-grid; place-items: center; padding: 0; border-radius: 50%; border: 1px solid var(--line-strong); background: rgba(255,255,255,.04); color: var(--muted); font: italic 700 11px/1 Georgia, serif; cursor: help; }
.ocgo-info-btn:hover, .ocgo-info-btn:focus-visible { color: var(--accent); border-color: rgba(118,152,253,.6); outline: none; }
.ocgo-forecast-percent { cursor: help; text-decoration: underline dotted; text-decoration-color: var(--line-strong); text-underline-offset: 3px; }
.ocgo-forecast-percent:focus-visible { outline: 1px solid var(--accent); outline-offset: 2px; }

.ocgo-forecast-hover-target { fill: transparent; pointer-events: all; }
.ocgo-forecast-hover-band { fill: rgba(255,255,255,.055); pointer-events: none; }
.ocgo-forecast-hover-target:focus { outline: none; }

`;

  // src/ui/panel.ts
  function node2(tag, className = "", text2 = "") {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text2) element.textContent = text2;
    return element;
  }
  function button(text2, className = "ocgo-btn") {
    const element = node2("button", className, text2);
    element.type = "button";
    return element;
  }
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }
  function saveJSON(key, value) {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
    } catch {
    }
  }
  function localInputValue(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function shortID(value) {
    if (!value) return "—";
    return value.length <= 22 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
  }
  var RANGE_PRESETS = ["1h", "24h", "7d", "30d", "all", "custom"];
  var MIN_PANEL_WIDTH = 680;
  var MIN_PANEL_HEIGHT = 480;
  var MIN_CHART_SCALE = 0.5;
  var MAX_CHART_SCALE = 2;
  var CHART_SCALE_STEP = 0.25;
  var Panel = class {
    logger;
    host;
    shadow;
    panel;
    fab;
    errorBox;
    statusDot;
    statusText;
    workspaceLabel;
    rangeSelect;
    rangeControl;
    modelSelect;
    providerSelect;
    userSelect;
    customRange;
    customFrom;
    customTo;
    syncButton;
    langSelect;
    cards;
    overviewModels;
    overviewLegacyNote;
    charts = [];
    chartModels;
    chartGrid;
    chartZoomValue;
    chartZoomOut;
    chartZoomIn;
    chartTooltip;
    toast;
    toastTimer;
    chartAverages = /* @__PURE__ */ new Map();
    requestsTable;
    requestPager;
    dataInfo;
    dataActions;
    experimentalCheckbox;
    forecastTab;
    forecastHost;
    forecastPanel;
    pricingPanel;
    storageNote;
    logList;
    tabButtons = /* @__PURE__ */ new Map();
    views = /* @__PURE__ */ new Map();
    i18nNodes = /* @__PURE__ */ new Map();
    language;
    rangePreset;
    filters;
    activeTab;
    persisted;
    open = false;
    workspaceID = null;
    workspaces = [];
    principals = [];
    records = [];
    totalRecordCount = 0;
    rangeLoadSeq = 0;
    syncState;
    analysis;
    range;
    busy = false;
    syncPromise;
    controller;
    principalsController;
    progress;
    errorMessage = "";
    rangeError = "";
    requestPage = 1;
    clearArmed = false;
    clearTimer;
    refreshTimer;
    autoInterval;
    hasOpened = false;
    mounted = false;
    suppressFabClick = false;
    chartScale = 1;
    pricing;
    pricingLoading = false;
    pricingError = "";
    pricingPromise;
    experimentalForecast = false;
    forecastRecords;
    forecastResult;
    forecastStatus;
    forecastStatusFetchedAt = 0;
    forecastStatusError = "";
    forecastLoading = false;
    forecastError = "";
    forecastLoadSeq = 0;
    forecastStale = true;
    forecastController;
    forecastViewReady = false;
    constructor(logger2) {
      this.logger = logger2;
      this.language = loadJSON(LANGUAGE_STORAGE_KEY, detectLanguage());
      this.rangePreset = loadJSON(RANGE_STORAGE_KEY, "7d");
      this.activeTab = loadJSON(TAB_STORAGE_KEY, "overview");
      this.experimentalForecast = loadJSON(EXPERIMENTAL_FORECAST_KEY, false);
      if (!this.experimentalForecast && this.activeTab === "forecast") this.activeTab = "data";
      this.filters = loadJSON(FILTERS_STORAGE_KEY, { model: "", provider: "", userKey: "" });
      this.persisted = loadJSON(PANEL_STATE_KEY, {});
      if (typeof this.persisted.chartScale === "number" && Number.isFinite(this.persisted.chartScale)) {
        this.chartScale = clamp(this.persisted.chartScale, MIN_CHART_SCALE, MAX_CHART_SCALE);
      }
      this.open = Boolean(this.persisted.open);
    }
    mount() {
      if (this.mounted || document.getElementById("ocgo-lens-host")) return;
      this.mounted = true;
      this.host = node2("div");
      this.host.id = "ocgo-lens-host";
      this.shadow = this.host.attachShadow({ mode: "open" });
      const style = node2("style");
      style.textContent = panelCss;
      this.shadow.appendChild(style);
      this.buildShell(this.shadow);
      document.documentElement.appendChild(this.host);
      this.applyGeometry();
      this.setOpen(this.open, false);
      this.renderChrome();
      this.render();
      this.applyFabGeometry();
      this.applyChartScale();
      this.startAutoSync();
      window.addEventListener("resize", () => {
        this.applyGeometry();
        this.applyFabGeometry();
      });
      this.logger.info("log.mounted");
      this.logger.subscribe(() => {
        if (this.activeTab === "data") this.renderLogs();
      });
    }
    rememberI18n(key, element) {
      const nodes = this.i18nNodes.get(key) ?? [];
      nodes.push(element);
      this.i18nNodes.set(key, nodes);
      return element;
    }
    textFor(key) {
      const element = node2("span");
      this.rememberI18n(key, element);
      return element;
    }
    buildShell(root) {
      const wrapper = node2("div");
      wrapper.id = "ocgo-lens";
      this.fab = button("", "ocgo-fab");
      this.fab.setAttribute("aria-label", "Open performance lens");
      this.fab.setAttribute("aria-expanded", "false");
      this.fab.setAttribute("aria-controls", "ocgo-lens-panel");
      this.fab.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 23V9m6 14V13m6 10V7m6 16V11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 27h24" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.4"/></svg>';
      this.fab.addEventListener("click", () => {
        if (this.suppressFabClick) {
          this.suppressFabClick = false;
          return;
        }
        this.setOpen(!this.open);
      });
      this.bindFabDrag();
      const panel2 = node2("section", "ocgo-panel ocgo-hidden");
      panel2.id = "ocgo-lens-panel";
      this.panel = panel2;
      panel2.setAttribute("role", "dialog");
      panel2.setAttribute("aria-modal", "false");
      panel2.setAttribute("aria-labelledby", "ocgo-lens-title");
      const header = node2("header", "ocgo-header");
      const brand = node2("div", "ocgo-brand");
      const title = this.rememberI18n("app.title", node2("div", "ocgo-title"));
      title.id = "ocgo-lens-title";
      brand.append(title, this.rememberI18n("app.subtitle", node2("div", "ocgo-subtitle")));
      this.workspaceLabel = node2("span", "ocgo-workspace");
      const langSelect = node2("select");
      this.langSelect = langSelect;
      langSelect.setAttribute("aria-label", "Language");
      for (const [value, label] of [["zh", "中文"], ["en", "English"]]) {
        const option = node2("option", "", label);
        option.value = value;
        langSelect.appendChild(option);
      }
      langSelect.addEventListener("change", () => this.setLanguage(langSelect.value));
      const close = button("×", "ocgo-icon-btn");
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", () => this.setOpen(false));
      header.append(brand, this.workspaceLabel, langSelect, close);
      this.bindDrag(header);
      const toolbar = node2("div", "ocgo-toolbar");
      const rangeWrap = node2("label");
      this.rangeControl = rangeWrap;
      rangeWrap.append(this.textFor("range.label"));
      const rangeSelect = node2("select");
      this.rangeSelect = rangeSelect;
      for (const preset of RANGE_PRESETS) {
        const option = node2("option");
        option.value = preset;
        this.rememberI18n(`range.${preset}`, option);
        rangeSelect.appendChild(option);
      }
      rangeWrap.append(rangeSelect);
      const custom = node2("div", "ocgo-custom-range");
      this.customRange = custom;
      const fromInput = node2("input");
      fromInput.type = "datetime-local";
      const toInput = node2("input");
      toInput.type = "datetime-local";
      fromInput.value = this.persisted.customFrom ?? "";
      toInput.value = this.persisted.customTo ?? "";
      this.customFrom = fromInput;
      this.customTo = toInput;
      custom.append(this.textFor("range.from"), fromInput, this.textFor("range.to"), toInput);
      const modelLabel = node2("label");
      modelLabel.append(this.textFor("filter.model"));
      const modelSelect = node2("select");
      this.modelSelect = modelSelect;
      modelLabel.append(modelSelect);
      const providerLabel = node2("label");
      providerLabel.append(this.textFor("filter.provider"));
      const providerSelect = node2("select");
      this.providerSelect = providerSelect;
      providerLabel.append(providerSelect);
      const userLabel = node2("label");
      userLabel.append(this.textFor("filter.user"));
      const userSelect = node2("select");
      this.userSelect = userSelect;
      userLabel.append(userSelect);
      const clearFilters = button("", "ocgo-btn");
      this.rememberI18n("filter.clear", clearFilters);
      clearFilters.addEventListener("click", () => {
        this.filters = { model: "", provider: "", userKey: "" };
        this.requestPage = 1;
        this.persistPreferences();
        this.renderFilters();
        this.render();
      });
      const sync = button("", "ocgo-sync-btn");
      this.syncButton = sync;
      sync.addEventListener("click", () => {
        if (this.busy) this.stopSync();
        else void this.sync(false);
      });
      toolbar.append(rangeWrap, custom, modelLabel, providerLabel, userLabel, clearFilters, sync);
      rangeSelect.addEventListener("change", () => {
        this.rangePreset = rangeSelect.value;
        if (this.rangePreset === "custom") this.ensureCustomRange();
        this.requestPage = 1;
        this.persistPreferences();
        void this.reloadRecords();
      });
      fromInput.addEventListener("change", () => {
        this.persisted.customFrom = fromInput.value;
        saveJSON(PANEL_STATE_KEY, this.persisted);
        this.requestPage = 1;
        void this.reloadRecords();
      });
      toInput.addEventListener("change", () => {
        this.persisted.customTo = toInput.value;
        saveJSON(PANEL_STATE_KEY, this.persisted);
        this.requestPage = 1;
        void this.reloadRecords();
      });
      modelSelect.addEventListener("change", () => {
        this.filters.model = modelSelect.value;
        this.requestPage = 1;
        this.persistPreferences();
        this.render();
      });
      providerSelect.addEventListener("change", () => {
        this.filters.provider = providerSelect.value;
        this.requestPage = 1;
        this.persistPreferences();
        this.render();
      });
      userSelect.addEventListener("change", () => {
        this.filters.userKey = userSelect.value;
        this.requestPage = 1;
        this.persistPreferences();
        this.render();
      });
      const tabs = node2("nav", "ocgo-tabs");
      const tabKeys = ["overview", "charts", "requests", "forecast", "data"];
      for (const key of tabKeys) {
        const tab = button("", "ocgo-tab");
        tab.appendChild(this.textFor(`tabs.${key}`));
        if (key === "forecast") {
          tab.appendChild(node2("span", "ocgo-tab-badge", t(this.language, "badge.beta")));
          this.forecastTab = tab;
        }
        tab.dataset.tab = key;
        tab.addEventListener("click", () => this.setTab(key));
        this.tabButtons.set(key, tab);
        tabs.appendChild(tab);
      }
      const status = node2("div", "ocgo-statusbar");
      this.statusDot = node2("span", "ocgo-status-dot");
      this.statusText = node2("span");
      status.append(this.statusDot, this.statusText);
      this.errorBox = node2("div", "ocgo-error ocgo-hidden");
      const body = node2("div", "ocgo-body");
      const overview = this.buildOverviewView();
      const charts = this.buildChartsView();
      const requests = this.buildRequestsView();
      const forecast = this.buildForecastView();
      const data = this.buildDataView();
      this.views.set("overview", overview);
      this.views.set("charts", charts);
      this.views.set("requests", requests);
      this.views.set("forecast", forecast);
      this.views.set("data", data);
      body.append(overview, charts, requests, forecast, data);
      const directions = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
      const handles = directions.map((direction) => {
        const handle = node2("div", `ocgo-resize-handle ocgo-resize-${direction}`);
        handle.dataset.resize = direction;
        handle.setAttribute("aria-hidden", "true");
        this.bindResize(handle, direction);
        return handle;
      });
      panel2.append(header, toolbar, tabs, status, this.errorBox, body, ...handles);
      this.chartTooltip = node2("div", "ocgo-chart-tooltip ocgo-hidden");
      this.chartTooltip.setAttribute("role", "tooltip");
      this.forecastPanel?.setTooltip(this.chartTooltip);
      this.toast = node2("div", "ocgo-toast ocgo-hidden");
      this.toast.setAttribute("role", "status");
      this.toast.setAttribute("aria-live", "polite");
      panel2.appendChild(this.toast);
      wrapper.append(this.fab, panel2, this.chartTooltip);
      root.appendChild(wrapper);
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.open) this.setOpen(false);
      });
      document.addEventListener("pointerdown", (event) => {
        if (!this.open) return;
        const path = event.composedPath();
        if (this.panel && path.includes(this.panel)) return;
        if (this.fab && path.includes(this.fab)) return;
        if (this.chartTooltip && path.includes(this.chartTooltip)) return;
        this.setOpen(false);
      }, true);
      document.addEventListener("visibilitychange", () => this.handleVisibility());
    }
    buildOverviewView() {
      const view = node2("section", "ocgo-view");
      view.dataset.view = "overview";
      this.cards = node2("div", "ocgo-cards");
      const section = node2("section", "ocgo-section");
      const head = node2("div", "ocgo-section-head");
      const legacyNote = this.textFor("legacy.note");
      this.overviewLegacyNote = legacyNote;
      head.append(this.textFor("chart.models"), legacyNote);
      this.overviewModels = node2("div", "ocgo-table-wrap");
      section.append(head, this.overviewModels);
      view.append(this.cards, section);
      return view;
    }
    buildChartsView() {
      const view = node2("section", "ocgo-view");
      view.dataset.view = "charts";
      const controls = node2("div", "ocgo-chart-controls");
      const zoomLabel = this.textFor("chart.zoom");
      zoomLabel.className = "ocgo-chart-zoom-label";
      const zoomGroup = node2("div", "ocgo-chart-zoom");
      const zoomOut = button("−", "ocgo-zoom-btn");
      this.chartZoomOut = zoomOut;
      zoomOut.setAttribute("aria-label", t(this.language, "chart.zoomOut"));
      zoomOut.addEventListener("click", () => this.setChartScale(this.chartScale - CHART_SCALE_STEP));
      const zoomValue = button("100%", "ocgo-zoom-value");
      zoomValue.setAttribute("aria-label", t(this.language, "chart.zoomReset"));
      zoomValue.addEventListener("click", () => this.setChartScale(1));
      this.chartZoomValue = zoomValue;
      const zoomIn = button("+", "ocgo-zoom-btn");
      this.chartZoomIn = zoomIn;
      zoomIn.setAttribute("aria-label", t(this.language, "chart.zoomIn"));
      zoomIn.addEventListener("click", () => this.setChartScale(this.chartScale + CHART_SCALE_STEP));
      zoomGroup.append(zoomOut, zoomValue, zoomIn);
      controls.append(zoomLabel, zoomGroup);
      const grid = node2("div", "ocgo-chart-grid");
      this.chartGrid = grid;
      const keys = ["chart.tokens", "chart.cache", "chart.ttft", "chart.tps"];
      for (const key of keys) {
        const section = node2("section", "ocgo-section ocgo-chart-box");
        const head2 = node2("div", "ocgo-section-head");
        const titleGroup = node2("div", "ocgo-chart-title-group");
        const title = this.textFor(key);
        title.className = "ocgo-section-title";
        const average = node2("span", "ocgo-section-average");
        this.chartAverages.set(key, average);
        titleGroup.append(title, average);
        head2.append(titleGroup);
        const host = node2("div", "ocgo-chart-host");
        this.charts.push(host);
        section.append(head2, host);
        grid.appendChild(section);
      }
      const modelSection = node2("section", "ocgo-section");
      const head = node2("div", "ocgo-section-head");
      head.append(this.textFor("chart.models"));
      this.chartModels = node2("div", "ocgo-table-wrap");
      modelSection.append(head, this.chartModels);
      view.append(controls, grid, modelSection);
      return view;
    }
    buildRequestsView() {
      const view = node2("section", "ocgo-view");
      view.dataset.view = "requests";
      const section = node2("section", "ocgo-section");
      this.requestsTable = node2("div", "ocgo-table-wrap");
      this.requestPager = node2("div", "ocgo-pager");
      section.append(this.requestsTable, this.requestPager);
      view.append(section);
      return view;
    }
    buildForecastView() {
      const view = node2("section", "ocgo-view");
      view.dataset.view = "forecast";
      const host = node2("div", "ocgo-forecast-view");
      this.forecastHost = host;
      this.forecastPanel = new ForecastPanel(host, this.panel ?? host);
      view.appendChild(host);
      return view;
    }
    buildDataView() {
      const view = node2("section", "ocgo-view");
      view.dataset.view = "data";
      const grid = node2("div", "ocgo-data-grid");
      const infoSection = node2("section", "ocgo-section");
      const infoHead = node2("div", "ocgo-section-head");
      infoHead.append(this.textFor("tabs.data"));
      this.dataInfo = node2("div");
      infoSection.append(infoHead, this.dataInfo);
      const actionSection = node2("section", "ocgo-section");
      const actionHead = node2("div", "ocgo-section-head");
      actionHead.append(this.textFor("data.actions"));
      this.dataActions = node2("div", "ocgo-actions");
      actionSection.append(actionHead, this.dataActions);
      grid.append(infoSection, actionSection);
      const experimentalSection = node2("section", "ocgo-section");
      const experimentalHead = node2("div", "ocgo-section-head");
      experimentalHead.append(this.textFor("data.experimentalTitle"));
      const experimental = node2("div", "ocgo-experimental");
      const experimentalRow = node2("label", "ocgo-experimental-row");
      const experimentalCheckbox = node2("input");
      experimentalCheckbox.type = "checkbox";
      experimentalCheckbox.checked = this.experimentalForecast;
      this.experimentalCheckbox = experimentalCheckbox;
      experimentalCheckbox.addEventListener("change", () => this.setExperimentalForecast(experimentalCheckbox.checked));
      experimentalRow.append(experimentalCheckbox, this.textFor("data.experimentalForecast"));
      experimental.append(
        experimentalRow,
        this.rememberI18n("data.experimentalForecastHint", node2("div", "ocgo-note")),
        this.rememberI18n("data.experimentalForecastNote", node2("div", "ocgo-note"))
      );
      experimentalSection.append(experimentalHead, experimental);
      const pricingSection = node2("section", "ocgo-section ocgo-pricing-section");
      const pricingHead = node2("div", "ocgo-section-head");
      pricingHead.append(
        this.textFor("data.pricingTitle"),
        this.rememberI18n("data.pricingHint", node2("span", "ocgo-section-note"))
      );
      this.pricingPanel = node2("div", "ocgo-pricing-panel");
      pricingSection.append(pricingHead, this.pricingPanel);
      const diagnostics = node2("section", "ocgo-section");
      const logHead = node2("div", "ocgo-section-head");
      logHead.append(this.textFor("data.diagnostics"));
      this.logList = node2("div", "ocgo-log-list");
      diagnostics.append(logHead, this.logList);
      view.append(grid, experimentalSection, pricingSection, diagnostics);
      return view;
    }
    bindDrag(header) {
      header.addEventListener("mousedown", (event) => {
        const target = event.target;
        if (target.closest("button, select, input, a")) return;
        if (!this.panel) return;
        event.preventDefault();
        const rect = this.panel.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const startLeft = rect.left;
        const startTop = rect.top;
        const move = (moveEvent) => {
          if (!this.panel) return;
          const left = Math.max(0, Math.min(window.innerWidth - 120, startLeft + moveEvent.clientX - startX));
          const top = Math.max(0, Math.min(window.innerHeight - 80, startTop + moveEvent.clientY - startY));
          this.panel.style.left = `${left}px`;
          this.panel.style.top = `${top}px`;
          this.panel.style.right = "auto";
          this.panel.style.bottom = "auto";
        };
        const up = () => {
          window.removeEventListener("mousemove", move);
          window.removeEventListener("mouseup", up);
          if (this.panel) {
            const next = this.panel.getBoundingClientRect();
            this.persisted.x = Math.round(next.left);
            this.persisted.y = Math.round(next.top);
            saveJSON(PANEL_STATE_KEY, this.persisted);
          }
        };
        window.addEventListener("mousemove", move);
        window.addEventListener("mouseup", up);
      });
    }
    bindFabDrag() {
      if (!this.fab) return;
      this.fab.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !this.fab) return;
        const fab = this.fab;
        const rect = fab.getBoundingClientRect();
        const startX = event.clientX;
        const startY = event.clientY;
        const pointerId = event.pointerId;
        let moved = false;
        let finished = false;
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          moveEvent.preventDefault();
          fab.classList.add("ocgo-dragging");
          const size = fab.offsetWidth || 48;
          const left = clamp(rect.left + dx, 8, window.innerWidth - size - 8);
          const top = clamp(rect.top + dy, 8, window.innerHeight - size - 8);
          fab.style.left = `${left}px`;
          fab.style.top = `${top}px`;
          fab.style.right = "auto";
          fab.style.bottom = "auto";
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          fab.removeEventListener("lostpointercapture", finish);
          if (fab.hasPointerCapture(pointerId)) fab.releasePointerCapture(pointerId);
          fab.classList.remove("ocgo-dragging");
          if (!moved) return;
          const next = fab.getBoundingClientRect();
          this.persisted.fabX = Math.round(next.left);
          this.persisted.fabY = Math.round(next.top);
          saveJSON(PANEL_STATE_KEY, this.persisted);
          this.suppressFabClick = true;
          window.setTimeout(() => {
            this.suppressFabClick = false;
          }, 350);
        };
        try {
          fab.setPointerCapture(pointerId);
        } catch {
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
        fab.addEventListener("lostpointercapture", finish);
      });
    }
    bindResize(handle, direction) {
      handle.addEventListener("pointerdown", (event) => {
        if (!this.panel || event.button !== 0 || window.innerWidth <= 820) return;
        event.preventDefault();
        const panel2 = this.panel;
        const rect = panel2.getBoundingClientRect();
        panel2.style.left = `${rect.left}px`;
        panel2.style.top = `${rect.top}px`;
        panel2.style.width = `${rect.width}px`;
        panel2.style.height = `${rect.height}px`;
        panel2.style.right = "auto";
        panel2.style.bottom = "auto";
        const startX = event.clientX;
        const startY = event.clientY;
        const pointerId = event.pointerId;
        const startLeft = rect.left;
        const startTop = rect.top;
        const startRight = rect.right;
        const startBottom = rect.bottom;
        const minWidth = Math.min(MIN_PANEL_WIDTH, window.innerWidth - 16);
        const minHeight = Math.min(MIN_PANEL_HEIGHT, window.innerHeight - 16);
        const rightBound = window.innerWidth - 8;
        const bottomBound = window.innerHeight - 8;
        let finished = false;
        const move = (moveEvent) => {
          const dx = moveEvent.clientX - startX;
          const dy = moveEvent.clientY - startY;
          let left = startLeft;
          let top = startTop;
          let width = rect.width;
          let height = rect.height;
          if (direction.includes("e")) {
            width = clamp(startRight + dx - startLeft, minWidth, Math.max(minWidth, rightBound - startLeft));
          }
          if (direction.includes("w")) {
            left = clamp(startLeft + dx, 8, Math.max(8, startRight - minWidth));
            width = startRight - left;
          }
          if (direction.includes("s")) {
            height = clamp(startBottom + dy - startTop, minHeight, Math.max(minHeight, bottomBound - startTop));
          }
          if (direction.includes("n")) {
            top = clamp(startTop + dy, 8, Math.max(8, startBottom - minHeight));
            height = startBottom - top;
          }
          panel2.style.left = `${left}px`;
          panel2.style.top = `${top}px`;
          panel2.style.width = `${width}px`;
          panel2.style.height = `${height}px`;
        };
        const finish = () => {
          if (finished) return;
          finished = true;
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          handle.removeEventListener("lostpointercapture", finish);
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          const next = panel2.getBoundingClientRect();
          this.persisted.x = Math.round(next.left);
          this.persisted.y = Math.round(next.top);
          this.persisted.width = Math.round(next.width);
          this.persisted.height = Math.round(next.height);
          saveJSON(PANEL_STATE_KEY, this.persisted);
        };
        try {
          handle.setPointerCapture(pointerId);
        } catch {
        }
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
        handle.addEventListener("lostpointercapture", finish);
      });
    }
    applyGeometry() {
      if (!this.panel) return;
      const maxWidth = Math.max(320, window.innerWidth - 16);
      const maxHeight = Math.max(320, window.innerHeight - 16);
      const width = this.persisted.width ? clamp(this.persisted.width, Math.min(MIN_PANEL_WIDTH, maxWidth), maxWidth) : void 0;
      const height = this.persisted.height ? clamp(this.persisted.height, Math.min(MIN_PANEL_HEIGHT, maxHeight), maxHeight) : void 0;
      if (width) this.panel.style.width = `${width}px`;
      if (height) this.panel.style.height = `${height}px`;
      if (this.persisted.x !== void 0 || this.persisted.y !== void 0) {
        const rect = this.panel.getBoundingClientRect();
        const left = clamp(this.persisted.x ?? rect.left, 8, Math.max(8, window.innerWidth - (width ?? rect.width) - 8));
        const top = clamp(this.persisted.y ?? rect.top, 8, Math.max(8, window.innerHeight - (height ?? rect.height) - 8));
        this.panel.style.left = `${left}px`;
        this.panel.style.top = `${top}px`;
        this.panel.style.right = "auto";
        this.panel.style.bottom = "auto";
      }
    }
    applyFabGeometry() {
      if (!this.fab || this.persisted.fabX === void 0 && this.persisted.fabY === void 0) return;
      const size = this.fab.offsetWidth || 48;
      const defaultLeft = window.innerWidth - 20 - size;
      const defaultTop = window.innerHeight - 20 - size;
      const left = clamp(this.persisted.fabX ?? defaultLeft, 8, Math.max(8, window.innerWidth - size - 8));
      const top = clamp(this.persisted.fabY ?? defaultTop, 8, Math.max(8, window.innerHeight - size - 8));
      this.fab.style.left = `${left}px`;
      this.fab.style.top = `${top}px`;
      this.fab.style.right = "auto";
      this.fab.style.bottom = "auto";
    }
    setChartScale(value) {
      this.chartScale = clamp(Math.round(value / CHART_SCALE_STEP) * CHART_SCALE_STEP, MIN_CHART_SCALE, MAX_CHART_SCALE);
      this.persisted.chartScale = this.chartScale;
      saveJSON(PANEL_STATE_KEY, this.persisted);
      this.applyChartScale();
      hideChartTooltip(this.chartTooltip);
    }
    applyChartScale() {
      if (!this.chartGrid) return;
      this.chartGrid.style.setProperty("--ocgo-chart-width", this.chartScale <= 1 ? `${this.chartScale * 100}%` : "100%");
      this.chartGrid.style.setProperty("--ocgo-chart-height", `${195 * this.chartScale}px`);
      this.chartGrid.style.setProperty("--ocgo-chart-box-height", `${250 * this.chartScale}px`);
      this.chartGrid.classList.toggle("ocgo-chart-zoomed", this.chartScale > 1);
      if (this.chartZoomValue) this.chartZoomValue.textContent = `${Math.round(this.chartScale * 100)}%`;
      if (this.chartZoomOut) this.chartZoomOut.disabled = this.chartScale <= MIN_CHART_SCALE;
      if (this.chartZoomIn) this.chartZoomIn.disabled = this.chartScale >= MAX_CHART_SCALE;
    }
    setOpen(open, persist = true) {
      this.open = open;
      this.panel?.classList.toggle("ocgo-hidden", !open);
      this.fab?.classList.toggle("ocgo-open", open);
      this.fab?.setAttribute("aria-expanded", String(open));
      if (this.fab) {
        const label = t(this.language, open ? "app.close" : "app.open");
        this.fab.title = label;
        this.fab.setAttribute("aria-label", label);
      }
      if (persist) {
        this.persisted.open = open;
        saveJSON(PANEL_STATE_KEY, this.persisted);
      }
      if (!open) {
        hideChartTooltip(this.chartTooltip);
        this.hideToast();
      }
      if (open) {
        this.hasOpened = true;
        this.render();
        if (this.open && this.activeTab === "forecast") void this.loadForecast(false);
        window.setTimeout(() => this.autoSyncIfStale(), 150);
      }
    }
    showToast(key, values) {
      if (!this.toast || !this.open) return;
      if (this.toastTimer) window.clearTimeout(this.toastTimer);
      this.toast.textContent = t(this.language, key, values);
      this.toast.classList.remove("ocgo-hidden", "ocgo-toast-in");
      void this.toast.offsetWidth;
      this.toast.classList.add("ocgo-toast-in");
      this.toastTimer = window.setTimeout(() => this.hideToast(), 4e3);
    }
    hideToast() {
      if (this.toastTimer) {
        window.clearTimeout(this.toastTimer);
        this.toastTimer = void 0;
      }
      this.toast?.classList.add("ocgo-hidden");
    }
    ensurePricing() {
      if (this.pricingPromise) return this.pricingPromise;
      const task = this.loadPricing();
      this.pricingPromise = task;
      void task.finally(() => {
        if (this.pricingPromise === task) this.pricingPromise = void 0;
      });
      return task;
    }
    async loadPricing() {
      if (this.pricingLoading) return this.pricing;
      this.pricingLoading = true;
      this.renderPricing();
      const result = await loadGoPricing();
      this.pricingLoading = false;
      this.pricingError = result.error ?? "";
      if (result.pricing) {
        this.pricing = result.pricing;
        if (result.refreshed) this.logger.info("log.pricingUpdated", { n: result.pricing.tiers.length });
        this.renderModelTable(this.overviewModels, this.analysis?.models ?? []);
        this.renderModelTable(this.chartModels, this.analysis?.models ?? []);
      }
      this.renderPricing();
      if (result.error) this.logger.warn("log.pricingRefreshFailed", { error: result.error });
      return this.pricing;
    }
    setExperimentalForecast(enabled) {
      this.experimentalForecast = enabled;
      saveJSON(EXPERIMENTAL_FORECAST_KEY, enabled);
      if (!enabled) {
        this.resetForecast();
        if (this.activeTab === "forecast") this.activeTab = "data";
        saveJSON(TAB_STORAGE_KEY, this.activeTab);
      } else {
        this.forecastStale = true;
      }
      this.renderChrome();
      this.render();
      if (enabled && this.activeTab === "forecast") void this.loadForecast(false);
    }
    resetForecast() {
      this.forecastController?.abort();
      this.forecastController = void 0;
      this.forecastLoadSeq += 1;
      this.forecastRecords = void 0;
      this.forecastResult = void 0;
      this.forecastStatus = void 0;
      this.forecastStatusFetchedAt = 0;
      this.forecastStatusError = "";
      this.forecastLoading = false;
      this.forecastError = "";
      this.forecastStale = true;
    }
    async loadForecastStatus(force) {
      if (!force && this.forecastStatus && Date.now() - this.forecastStatusFetchedAt < 6e4) {
        return this.forecastStatus;
      }
      const workspaceID = this.workspaceID;
      if (!workspaceID) return void 0;
      this.forecastController?.abort();
      const controller = new AbortController();
      this.forecastController = controller;
      try {
        const status = await getGoQuotaStatus(workspaceID, controller.signal);
        if (this.workspaceID !== workspaceID || controller.signal.aborted) return void 0;
        this.forecastStatus = status;
        this.forecastStatusFetchedAt = Date.now();
        this.forecastStatusError = "";
        return status;
      } catch (error) {
        if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") return void 0;
        this.forecastStatus = void 0;
        this.forecastStatusFetchedAt = Date.now();
        this.forecastStatusError = error instanceof Error ? error.message : String(error);
        this.logger.warn("log.goStatusFailed", { error: this.forecastStatusError });
        return void 0;
      } finally {
        if (this.forecastController === controller) this.forecastController = void 0;
      }
    }
    async loadForecast(force) {
      if (!this.open || !this.experimentalForecast || !this.workspaceID) return;
      if (this.forecastLoading) return;
      if (!force && !this.forecastStale && this.forecastResult) {
        this.renderForecast();
        return;
      }
      const workspaceID = this.workspaceID;
      const loadSeq = ++this.forecastLoadSeq;
      this.forecastLoading = true;
      this.forecastError = "";
      this.renderForecast();
      try {
        const [pricing, records, status] = await Promise.all([
          this.ensurePricing(),
          getAllRecords(workspaceID),
          this.loadForecastStatus(force)
        ]);
        if (loadSeq !== this.forecastLoadSeq || this.workspaceID !== workspaceID) return;
        if (!pricing) {
          throw new Error(this.pricingError || t(this.language, "data.pricingEmpty"));
        }
        this.forecastRecords = records;
        this.forecastResult = buildQuotaForecast({
          records,
          pricing,
          filters: this.filters,
          status,
          syncState: this.syncState,
          statusError: this.forecastStatusError,
          now: Date.now()
        });
        this.forecastStale = false;
        this.logger.info("log.forecastUpdated", { n: this.forecastResult.models.length });
      } catch (error) {
        if (loadSeq === this.forecastLoadSeq) {
          this.forecastError = error instanceof Error ? error.message : String(error);
          this.logger.warn("log.forecastFailed", { error: this.forecastError });
        }
      } finally {
        if (loadSeq === this.forecastLoadSeq) {
          this.forecastLoading = false;
          this.renderForecast();
        }
      }
    }
    renderForecast() {
      if (!this.open || !this.experimentalForecast || !this.forecastPanel) return;
      if (!this.workspaceID) {
        this.forecastPanel.renderEmpty(this.language, t(this.language, "error.workspace"), t(this.language, "forecast.emptyHint"));
        return;
      }
      if (this.forecastLoading) {
        this.forecastPanel.renderLoading(this.language);
        return;
      }
      if (this.forecastError) {
        this.forecastPanel.renderError(this.language, this.forecastError, () => void this.loadForecast(true));
        return;
      }
      if (!this.forecastRecords || !this.pricing) {
        this.forecastPanel.renderEmpty(this.language);
        return;
      }
      this.forecastResult = buildQuotaForecast({
        records: this.forecastRecords,
        pricing: this.pricing,
        filters: this.filters,
        status: this.forecastStatus,
        syncState: this.syncState,
        statusError: this.forecastStatusError,
        now: Date.now()
      });
      if (!this.forecastRecords.length) {
        this.forecastPanel.renderEmpty(this.language);
        return;
      }
      if (!this.forecastResult.models.length) {
        this.forecastPanel.renderEmpty(this.language, t(this.language, "forecast.noConsumedModels"), t(this.language, "forecast.emptyHint"));
        return;
      }
      this.forecastPanel.render(
        this.forecastResult,
        this.filters.model,
        this.language,
        (model) => {
          this.filters.model = model;
          this.requestPage = 1;
          this.persistPreferences();
          this.renderFilters();
          this.render();
        },
        () => void this.loadForecast(true)
      );
    }
    setTab(tab) {
      if (tab === "forecast" && !this.experimentalForecast) tab = "data";
      this.activeTab = tab;
      hideChartTooltip(this.chartTooltip);
      saveJSON(TAB_STORAGE_KEY, tab);
      for (const [key, tabButton] of this.tabButtons) {
        tabButton.classList.toggle("ocgo-active", key === tab);
        if (key === "forecast") tabButton.hidden = !this.experimentalForecast;
      }
      for (const [key, view] of this.views) view.classList.toggle("ocgo-active", key === tab);
      if (this.rangeControl) this.rangeControl.hidden = tab === "forecast";
      this.customRange?.classList.toggle("ocgo-show", tab !== "forecast" && this.rangePreset === "custom");
      if (tab === "data") this.renderData();
      if (tab === "requests") this.renderRequests();
      if (tab === "forecast" && this.open) {
        if (this.forecastStale || !this.forecastResult) void this.loadForecast(false);
        else this.renderForecast();
      }
    }
    setLanguage(language) {
      this.language = language;
      saveJSON(LANGUAGE_STORAGE_KEY, language);
      const badge = this.forecastTab?.querySelector(".ocgo-tab-badge");
      if (badge) badge.textContent = t(language, "badge.beta");
      hideChartTooltip(this.chartTooltip);
      this.renderChrome();
      this.render();
    }
    persistPreferences() {
      saveJSON(RANGE_STORAGE_KEY, this.rangePreset);
      saveJSON(FILTERS_STORAGE_KEY, this.filters);
      saveJSON(TAB_STORAGE_KEY, this.activeTab);
      saveJSON(LANGUAGE_STORAGE_KEY, this.language);
    }
    ensureCustomRange() {
      if (!this.customFrom || !this.customTo) return;
      if (!this.customFrom.value) this.customFrom.value = localInputValue(Date.now() - RETENTION_DAYS * 864e5);
      if (!this.customTo.value) this.customTo.value = localInputValue(Date.now());
      this.persisted.customFrom = this.customFrom.value;
      this.persisted.customTo = this.customTo.value;
      saveJSON(PANEL_STATE_KEY, this.persisted);
    }
    customRangeError() {
      if (this.rangePreset !== "custom") return "";
      const fromValue = this.customFrom?.value?.trim() ?? "";
      const toValue = this.customTo?.value?.trim() ?? "";
      if (!fromValue || !toValue) return t(this.language, "data.customInvalid");
      const from = new Date(fromValue).getTime();
      const to = new Date(toValue).getTime();
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
        return t(this.language, "data.customInvalid");
      }
      return "";
    }
    currentRange() {
      if (this.rangePreset === "custom" && this.customFrom && this.customTo) {
        return makeTimeRange(
          "custom",
          this.customFrom.value ? new Date(this.customFrom.value).getTime() : void 0,
          this.customTo.value ? new Date(this.customTo.value).getTime() : void 0
        );
      }
      return makeTimeRange(this.rangePreset);
    }
    renderChrome() {
      if (!this.panel) return;
      for (const [key, nodes] of this.i18nNodes) {
        for (const element of nodes) element.textContent = t(this.language, key);
      }
      if (this.fab) {
        const label = t(this.language, this.open ? "app.close" : "app.open");
        this.fab.title = label;
        this.fab.setAttribute("aria-label", label);
        this.fab.setAttribute("aria-expanded", String(this.open));
      }
      this.chartZoomOut?.setAttribute("aria-label", t(this.language, "chart.zoomOut"));
      this.chartZoomIn?.setAttribute("aria-label", t(this.language, "chart.zoomIn"));
      this.chartZoomValue?.setAttribute("aria-label", t(this.language, "chart.zoomReset"));
      if (this.langSelect) this.langSelect.value = this.language;
      if (this.rangeSelect) this.rangeSelect.value = this.rangePreset;
      if (this.syncButton) {
        this.syncButton.textContent = this.busy ? t(this.language, "status.stop") : t(this.language, "status.syncNow");
        this.syncButton.classList.toggle("ocgo-stop", this.busy);
        this.syncButton.disabled = !this.workspaceID;
      }
      this.customRange?.classList.toggle("ocgo-show", this.rangePreset === "custom" && this.activeTab !== "forecast");
      if (this.experimentalCheckbox) this.experimentalCheckbox.checked = this.experimentalForecast;
      if (this.forecastTab) this.forecastTab.hidden = !this.experimentalForecast;
      const workspace = this.workspaces.find((item) => item.id === this.workspaceID);
      if (this.workspaceLabel) {
        this.workspaceLabel.textContent = workspace?.name || this.workspaceID || t(this.language, "error.workspace");
        this.workspaceLabel.title = this.workspaceID || "";
      }
      this.setTab(this.activeTab);
    }
    renderFilters() {
      const options = filterOptions(this.records);
      this.fillSelect(this.modelSelect, options.models, this.filters.model, (value) => {
        this.filters.model = value;
      });
      this.fillSelect(this.providerSelect, options.providers, this.filters.provider, (value) => {
        this.filters.provider = value;
      });
      if (this.userSelect) {
        this.userSelect.replaceChildren();
        const all = node2("option", "", t(this.language, "filter.all"));
        all.value = "";
        this.userSelect.appendChild(all);
        for (const user of options.users) {
          const rawID = user.key.replace(/^(account:|user:)/, "");
          const principal = this.principals.find((item) => item.userId === rawID || item.serviceUserId === rawID);
          const label = principal?.name || principal?.email || user.label;
          const option = node2("option", "", label);
          option.value = user.key;
          this.userSelect.appendChild(option);
        }
        this.userSelect.value = options.users.some((user) => user.key === this.filters.userKey) ? this.filters.userKey : "";
        if (!this.userSelect.value) this.filters.userKey = "";
      }
    }
    fillSelect(select, values, selected, setter) {
      if (!select) return;
      select.replaceChildren();
      const all = node2("option", "", t(this.language, "filter.all"));
      all.value = "";
      select.appendChild(all);
      for (const value of values) {
        const option = node2("option", "", value || "—");
        option.value = value;
        select.appendChild(option);
      }
      select.value = values.includes(selected) ? selected : "";
      if (!select.value) setter("");
    }
    render() {
      if (!this.panel) return;
      this.rangeError = this.customRangeError();
      this.renderChrome();
      this.renderFilters();
      this.range = this.currentRange();
      this.analysis = aggregateRecords(this.records, this.filters, this.range.from, this.range.to, this.range.bucketMs);
      this.renderStatus();
      this.renderError();
      this.renderOverview();
      this.renderCharts();
      this.renderRequests();
      if (this.activeTab === "data") this.renderData();
      if (this.activeTab === "forecast") this.renderForecast();
    }
    renderStatus() {
      if (!this.statusDot || !this.statusText) return;
      this.statusDot.className = "ocgo-status-dot";
      if (this.rangeError) {
        this.statusDot.classList.add("err");
        this.statusText.textContent = this.rangeError;
        return;
      }
      if (this.busy) {
        this.statusDot.classList.add("busy");
        this.statusText.textContent = this.progress ? t(this.language, "status.syncing", { page: this.progress.page, n: this.progress.fetched }) : t(this.language, "error.loading");
        return;
      }
      if (this.errorMessage) {
        this.statusDot.classList.add("err");
        this.statusText.textContent = this.errorMessage;
        return;
      }
      if (!this.workspaceID) {
        this.statusText.textContent = t(this.language, "error.workspace");
        return;
      }
      if (this.syncState?.lastSuccessfulSyncAt) this.statusDot.classList.add("ok");
      const syncText = this.syncState?.lastSuccessfulSyncAt ? t(this.language, "status.lastSync", { time: formatRelative(this.syncState.lastSuccessfulSyncAt, Date.now(), this.language) }) : t(this.language, "status.never");
      this.statusText.textContent = `${t(this.language, "status.records", { n: formatNumber(this.totalRecordCount) })} · ${syncText}`;
    }
    renderError() {
      if (!this.errorBox) return;
      const message = this.rangeError || this.errorMessage;
      this.errorBox.classList.toggle("ocgo-hidden", !message);
      this.errorBox.textContent = message;
    }
    renderOverview() {
      if (!this.cards || !this.analysis) return;
      const summary = this.analysis.summary;
      this.cards.replaceChildren();
      const card = (label, value, sub, tone = "") => {
        const element = node2("div", `ocgo-card ${tone}`.trim());
        element.append(node2("div", "ocgo-card-label", label), node2("div", "ocgo-card-value", value));
        if (sub) element.appendChild(node2("div", "ocgo-card-sub", sub));
        return element;
      };
      const success = formatPercent(summary.successRate);
      const failures = t(this.language, "metric.failures", { n: summary.failed });
      const tpsValue = summary.tpsAvg === null || summary.tpsSlowest === null ? "N/A" : `${summary.tpsAvg.toFixed(1)} / ${summary.tpsSlowest.toFixed(1)} tok/s`;
      const cards = [
        card(t(this.language, "metric.requests"), formatNumber(summary.requests), `${t(this.language, "metric.successRate")} ${success} · ${failures}`),
        card(t(this.language, "metric.cost"), formatUsd(summary.costUsd), summary.requests ? `≈ ${formatUsd(summary.costUsd / summary.requests)} / request` : "—"),
        card(t(this.language, "metric.input"), formatCompact(summary.inputTokens), void 0, "blue"),
        card(t(this.language, "metric.output"), formatCompact(summary.outputTokens)),
        card(t(this.language, "metric.ttft"), `${formatMs(summary.ttftAvg)} / ${formatMs(summary.ttftSlowest)}`, t(this.language, "metric.samples", { n: summary.ttftSamples }), "blue"),
        card(t(this.language, "metric.tps"), tpsValue, t(this.language, "metric.samples", { n: summary.tpsSamples }), "violet")
      ];
      if (summary.cacheWriteTokens > 0) {
        cards.push(card(t(this.language, "metric.cacheWrite"), formatCompact(summary.cacheWriteTokens)));
      }
      cards.push(
        card(t(this.language, "metric.cacheRead"), formatCompact(summary.cacheReadTokens)),
        card(t(this.language, "metric.cacheHitRate"), formatPercent(summary.cacheHitRate, 2), void 0, "accent")
      );
      this.cards.append(...cards);
      if (this.overviewLegacyNote) {
        this.overviewLegacyNote.style.display = this.records.some((record) => record.legacy) ? "" : "none";
      }
      this.renderModelTable(this.overviewModels, this.analysis.models);
    }
    renderCharts() {
      if (!this.analysis) return;
      const buckets = this.analysis.buckets;
      if (this.charts[0]) renderTokenMix(this.charts[0], buckets, this.language, this.chartTooltip);
      if (this.charts[1]) renderCacheChart(this.charts[1], buckets, this.language, this.chartTooltip);
      if (this.charts[2]) renderLatencyChart(this.charts[2], buckets, this.language, this.chartTooltip);
      if (this.charts[3]) renderTpsChart(this.charts[3], buckets, this.language, this.chartTooltip);
      this.renderChartAverages();
      this.renderModelTable(this.chartModels, this.analysis.models);
    }
    renderChartAverages() {
      if (!this.analysis || !this.range) return;
      const buckets = this.analysis.buckets;
      const rate = tokenRateForRange(buckets, this.range.from, this.range.to);
      const tokenAverage = rate ? t(this.language, "chart.avgTokens", {
        value: formatCompact(rate.value),
        unit: t(this.language, rate.unit === "h" ? "chart.unitHour" : "chart.unitDay")
      }) : t(this.language, "chart.avgCache", { value: "N/A" });
      const summary = this.analysis.summary;
      const cacheAverage = averageBucketMetric(buckets, (bucket) => bucket.cacheHitRate);
      const text2 = /* @__PURE__ */ new Map([
        ["chart.tokens", tokenAverage],
        ["chart.cache", t(this.language, "chart.avgCache", { value: formatPercent(cacheAverage, 2) })],
        ["chart.ttft", t(this.language, "chart.avgTtft", { avg: formatMs(summary.ttftAvg), slowest: formatMs(summary.ttftSlowest) })],
        ["chart.tps", t(this.language, "chart.avgTps", { avg: formatTps(summary.tpsAvg), slowest: formatTps(summary.tpsSlowest) })]
      ]);
      for (const [key, value] of text2) {
        const target = this.chartAverages.get(key);
        if (target) target.textContent = value;
      }
    }
    renderModelTable(container, models) {
      if (!container) return;
      container.replaceChildren();
      const visibleModels = models.filter((model) => model.totalTokens > 0);
      if (!visibleModels.length) {
        container.appendChild(this.empty(t(this.language, "table.emptyHint"), "table.empty"));
        return;
      }
      const table = node2("table", "ocgo-table");
      const head = node2("thead");
      const headRow = node2("tr");
      const columns = [
        ["table.model", "left"],
        ["table.provider", "left"],
        ["table.requests", ""],
        ["table.totalTokens", ""],
        ["table.success", ""],
        ["table.hitRate", ""],
        ["table.ttftAvg", ""],
        ["table.tpsAvg", ""],
        ["table.cost", ""]
      ];
      for (const [key, align] of columns) headRow.appendChild(node2("th", align, t(this.language, key)));
      head.appendChild(headRow);
      const body = node2("tbody");
      for (const model of visibleModels) {
        const row = node2("tr");
        const totalTokens = node2("td", "ocgo-metric-hover", formatCompact(model.totalTokens));
        const cost = node2("td", "ocgo-metric-hover", formatUsd(model.costUsd));
        this.bindModelMetricTooltip(totalTokens, model, "tokens");
        this.bindModelMetricTooltip(cost, model, "cost");
        row.append(
          node2("td", "left", model.model),
          node2("td", "left", model.provider || "—"),
          node2("td", "", formatNumber(model.requests)),
          totalTokens,
          node2("td", "", formatPercent(model.successRate, 1)),
          node2("td", "", formatPercent(model.cacheHitRate, 2)),
          node2("td", "", formatMs(model.ttftAvg)),
          node2("td", "", formatTps(model.tpsAvg)),
          cost
        );
        body.appendChild(row);
      }
      table.append(head, body);
      container.appendChild(table);
    }
    bindModelMetricTooltip(cell, model, kind) {
      cell.tabIndex = 0;
      const data = this.modelMetricTooltip(model, kind);
      cell.setAttribute("aria-label", [data.head, ...data.rows.map(([label, value]) => `${label} ${value}`), data.footer].filter(Boolean).join(" · "));
      const show = (x, y) => {
        if (!this.chartTooltip || !this.panel) return;
        showDataTooltip(this.chartTooltip, data.head, data.rows, this.panel, x, y, data.footer);
      };
      cell.addEventListener("pointerenter", (event) => show(event.clientX, event.clientY));
      cell.addEventListener("pointermove", (event) => show(event.clientX, event.clientY));
      cell.addEventListener("pointerleave", () => hideChartTooltip(this.chartTooltip));
      cell.addEventListener("focus", () => {
        const rect = cell.getBoundingClientRect();
        show(rect.left + rect.width / 2, rect.top + rect.height / 2);
      });
      cell.addEventListener("blur", () => hideChartTooltip(this.chartTooltip));
    }
    modelMetricTooltip(model, kind) {
      const head = t(this.language, kind === "tokens" ? "tooltip.tokensTitle" : "tooltip.costTitle", {
        model: model.model
      });
      if (kind === "tokens") {
        return {
          head,
          rows: [
            [t(this.language, "table.totalTokens"), formatNumber(model.totalTokens)],
            [t(this.language, "table.input"), formatNumber(model.inputTokens)],
            [t(this.language, "table.cacheRead"), formatNumber(model.cacheReadTokens)],
            [t(this.language, "table.cacheWrite"), formatNumber(model.cacheWriteTokens)],
            [t(this.language, "table.output"), formatNumber(model.outputTokens)]
          ]
        };
      }
      const breakdown = estimateModelCostBreakdown(this.analysis?.records ?? [], model, this.pricing?.tiers);
      if (!breakdown) {
        return {
          head,
          rows: [[t(this.language, "table.cost"), formatUsd(model.costUsd)]],
          footer: t(this.language, "tooltip.costUnavailable")
        };
      }
      return {
        head,
        rows: [
          [t(this.language, "tooltip.inputCost"), formatUsd(breakdown.input)],
          [t(this.language, "tooltip.outputCost"), formatUsd(breakdown.output)],
          [t(this.language, "tooltip.cacheReadCost"), formatUsd(breakdown.cacheRead)],
          [t(this.language, "tooltip.cacheWriteCost"), formatUsd(breakdown.cacheWrite)],
          [t(this.language, "table.cost"), formatUsd(breakdown.total)]
        ],
        footer: `${t(this.language, "tooltip.estimated")} · ${t(this.language, "tooltip.estimatedHint")}`
      };
    }
    renderRequests() {
      if (!this.requestsTable || !this.requestPager || !this.analysis) return;
      const records = this.analysis.records;
      const pageSize = 100;
      const pages = Math.max(1, Math.ceil(records.length / pageSize));
      this.requestPage = Math.max(1, Math.min(pages, this.requestPage));
      const start = (this.requestPage - 1) * pageSize;
      const pageRecords = records.slice(start, start + pageSize);
      this.requestsTable.replaceChildren();
      if (!pageRecords.length) {
        this.requestsTable.appendChild(this.empty(t(this.language, "table.emptyHint"), "table.empty"));
      } else {
        const table = node2("table", "ocgo-table");
        const head = node2("thead");
        const headRow = node2("tr");
        const columns = [
          ["table.time", "left"],
          ["table.status", "left"],
          ["table.model", "left"],
          ["table.provider", "left"],
          ["table.ttft", ""],
          ["table.tps", ""],
          ["table.input", ""],
          ["table.cacheRead", ""],
          ["table.cacheWrite", ""],
          ["table.output", ""],
          ["table.cost", ""],
          ["table.user", "left"],
          ["table.open", ""]
        ];
        for (const [key, align] of columns) headRow.appendChild(node2("th", align, t(this.language, key)));
        head.appendChild(headRow);
        const body = node2("tbody");
        for (const record of pageRecords) {
          const row = node2("tr");
          const status = node2("td", "left");
          status.appendChild(node2("span", `ocgo-pill ${record.outcome}`, record.outcome));
          if (record.legacy) {
            const legacy = node2("span", "ocgo-pill legacy", t(this.language, "badge.legacy"));
            legacy.style.marginLeft = "4px";
            status.appendChild(legacy);
          }
          const user = this.principalLabel(record);
          const detail = node2("td");
          if (!record.legacy && record.startedAt >= Date.now() - RETENTION_DAYS * 864e5) {
            const link = node2("a", "", "↗");
            link.href = `${location.origin}/console/${record.workspaceID}/logs?range=30d&category=inference&log=${encodeURIComponent(record.id)}`;
            link.target = "_blank";
            link.rel = "noreferrer";
            link.title = t(this.language, "table.open");
            link.addEventListener("click", () => this.setOpen(false));
            detail.appendChild(link);
          } else {
            detail.textContent = "—";
          }
          row.append(
            node2("td", "left", formatDateTime(record.startedAt)),
            status,
            node2("td", "left", record.model || record.requestedModel || "—"),
            node2("td", "left", record.provider || "—"),
            node2("td", "", formatMs(computeTtft(record))),
            node2("td", "", formatTps(computeTps(record))),
            node2("td", "", formatCompact(record.inputTokens)),
            node2("td", "", formatCompact(record.cacheReadTokens)),
            node2("td", "", formatCompact(record.cacheWriteTokens + record.cacheWrite1hTokens)),
            node2("td", "", formatCompact(record.outputTokens)),
            node2("td", "", formatUsd(record.costUsd)),
            node2("td", "left", user),
            detail
          );
          body.appendChild(row);
        }
        table.append(head, body);
        this.requestsTable.appendChild(table);
      }
      this.requestPager.replaceChildren();
      const info = node2("span", "", t(this.language, "table.page", { page: this.requestPage, pages }));
      const previous = button(t(this.language, "table.prev"));
      previous.disabled = this.requestPage <= 1;
      previous.addEventListener("click", () => {
        this.requestPage -= 1;
        this.renderRequests();
      });
      const next = button(t(this.language, "table.next"));
      next.disabled = this.requestPage >= pages;
      next.addEventListener("click", () => {
        this.requestPage += 1;
        this.renderRequests();
      });
      this.requestPager.append(previous, info, next);
    }
    renderData() {
      if (!this.dataInfo || !this.dataActions) return;
      if (this.experimentalCheckbox) this.experimentalCheckbox.checked = this.experimentalForecast;
      this.dataInfo.replaceChildren();
      const state = this.syncState;
      const info = node2("dl", "ocgo-kv");
      const add = (label, value) => {
        info.append(node2("dt", "", label), node2("dd", "", value));
      };
      const workspace = this.workspaces.find((item) => item.id === this.workspaceID);
      add(t(this.language, "data.workspace"), workspace ? `${workspace.name} (${workspace.id})` : this.workspaceID || "—");
      add(t(this.language, "data.recordCount"), formatNumber(this.totalRecordCount));
      add(t(this.language, "status.official", { n: state?.retentionDays ?? RETENTION_DAYS }), t(this.language, "data.retentionNote"));
      add(t(this.language, "status.lastSync", { time: state?.lastSuccessfulSyncAt ? formatRelative(state.lastSuccessfulSyncAt, Date.now(), this.language) : t(this.language, "status.never") }), "");
      if (state?.coverageStart !== void 0 || state?.coverageEnd !== void 0) {
        add(
          t(this.language, "status.coverage", {
            from: state?.coverageStart !== void 0 ? formatDateTime(state.coverageStart) : "—",
            to: state?.coverageEnd !== void 0 ? formatDateTime(state.coverageEnd) : "—"
          }),
          ""
        );
      }
      this.dataInfo.appendChild(info);
      if (!state?.backfillComplete && this.workspaceID) {
        this.dataInfo.appendChild(node2("div", "ocgo-warning", t(this.language, "status.partial")));
      }
      if (state?.gapDetected) {
        this.dataInfo.appendChild(node2("div", "ocgo-warning", t(this.language, "status.gap", { n: state.retentionDays || RETENTION_DAYS })));
      }
      if (this.records.some((record) => record.legacy)) {
        this.dataInfo.appendChild(node2("p", "ocgo-note", t(this.language, "legacy.note")));
      }
      this.dataInfo.appendChild(node2("p", "ocgo-note", t(this.language, "data.privacy")));
      const storageNote = node2("p", "ocgo-note");
      this.storageNote = storageNote;
      this.dataInfo.appendChild(storageNote);
      this.dataActions.replaceChildren();
      const syncNow = button(t(this.language, "status.syncNow"));
      syncNow.disabled = this.busy || !this.workspaceID;
      syncNow.addEventListener("click", () => void this.sync(false));
      const syncFull = button(t(this.language, "status.syncFull"));
      syncFull.disabled = this.busy || !this.workspaceID;
      syncFull.addEventListener("click", () => void this.sync(true));
      const exportCsv = button(t(this.language, "data.exportCsv"));
      exportCsv.disabled = !this.analysis?.records.length;
      exportCsv.addEventListener("click", () => this.exportCsv());
      const exportJson = button(t(this.language, "data.exportJson"));
      exportJson.disabled = !this.totalRecordCount;
      exportJson.addEventListener("click", () => void this.exportJson());
      const clear = button(this.clearArmed ? t(this.language, "data.clearConfirm") : t(this.language, "data.clear"), "ocgo-danger-btn");
      clear.classList.toggle("ocgo-confirm", this.clearArmed);
      clear.disabled = this.busy || Boolean(this.syncPromise) || !this.workspaceID;
      clear.addEventListener("click", () => void this.clearHistory());
      const copy = button(t(this.language, "data.copyLogs"));
      copy.addEventListener("click", () => void this.copyLogs());
      this.dataActions.append(syncNow, syncFull, exportCsv, exportJson, clear, copy);
      void storageEstimate().then(({ usage }) => {
        if (this.storageNote === storageNote) {
          storageNote.textContent = t(this.language, "data.storage", { size: formatBytes(usage) });
        }
      });
      this.renderLogs();
      this.renderPricing();
    }
    renderPricing() {
      if (!this.pricingPanel) return;
      this.pricingPanel.replaceChildren();
      if (!this.pricing) {
        this.pricingPanel.appendChild(node2(
          "p",
          "ocgo-note",
          t(this.language, this.pricingLoading ? "data.pricingLoading" : "data.pricingEmpty")
        ));
        if (this.pricingError && !this.pricingLoading) {
          this.pricingPanel.appendChild(node2("p", "ocgo-warning", t(this.language, "data.pricingError", { error: this.pricingError })));
        }
        return;
      }
      const tiers = [...this.pricing.tiers].sort((a, b) => {
        const modelOrder = a.displayName.localeCompare(b.displayName);
        if (modelOrder !== 0) return modelOrder;
        const periodOrder = (a.period ?? "").localeCompare(b.period ?? "");
        if (periodOrder !== 0) return periodOrder;
        return (a.minContextTokens ?? 0) - (b.minContextTokens ?? 0);
      });
      const modelCount = new Set(tiers.map((tier) => tier.modelID)).size;
      const meta = node2("div", "ocgo-pricing-meta");
      meta.appendChild(node2("span", "", t(this.language, "data.pricingMeta", {
        time: formatDateTime(this.pricing.fetchedAt),
        n: modelCount
      })));
      const source = node2("a", "", t(this.language, "data.pricingSource"));
      source.href = this.pricing.source;
      source.target = "_blank";
      source.rel = "noreferrer";
      meta.appendChild(source);
      this.pricingPanel.appendChild(meta);
      if (this.pricingError) {
        this.pricingPanel.appendChild(node2("p", "ocgo-warning", t(this.language, "data.pricingError", { error: this.pricingError })));
      }
      const wrap = node2("div", "ocgo-table-wrap ocgo-pricing-table-wrap");
      const table = node2("table", "ocgo-table ocgo-pricing-table");
      const head = node2("thead");
      const headRow = node2("tr");
      const columns = [
        ["data.pricingModel", "left"],
        ["data.pricingPeriod", "left"],
        ["data.pricingContext", "left"],
        ["data.pricingInput", ""],
        ["data.pricingOutput", ""],
        ["data.pricingCacheRead", ""],
        ["data.pricingCacheWrite", ""]
      ];
      for (const [key, align] of columns) headRow.appendChild(node2("th", align, t(this.language, key)));
      head.appendChild(headRow);
      const body = node2("tbody");
      for (const tier of tiers) {
        const period = tier.period ? t(this.language, tier.period === "peak" ? "data.pricingPeak" : "data.pricingOffPeak") : t(this.language, "data.pricingAllDay");
        const context = tier.maxContextTokens !== void 0 ? `≤ ${formatCompact(tier.maxContextTokens)}` : tier.minContextTokens !== void 0 ? `> ${formatCompact(Math.max(0, tier.minContextTokens - 1))}` : t(this.language, "data.pricingAllContext");
        const periodCell = node2("td", "left");
        periodCell.appendChild(node2("span", `ocgo-price-period ${tier.period ?? "all"}`, period));
        const row = node2("tr");
        row.append(
          node2("td", "left", tier.displayName),
          periodCell,
          node2("td", "left", context),
          node2("td", "", formatUsd(tier.input)),
          node2("td", "", formatUsd(tier.output)),
          node2("td", "", formatUsd(tier.cacheRead)),
          node2("td", "", formatUsd(tier.cacheWrite))
        );
        body.appendChild(row);
      }
      table.append(head, body);
      wrap.appendChild(table);
      this.pricingPanel.appendChild(wrap);
    }
    renderLogs() {
      if (!this.logList) return;
      const entries = this.logger.all().slice(-80);
      this.logList.replaceChildren();
      if (!entries.length) {
        this.logList.textContent = t(this.language, "data.noLogs");
        return;
      }
      const formatter = new Intl.DateTimeFormat(void 0, { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
      for (const entry of entries) {
        const row = node2("div", "ocgo-log-row");
        row.append(
          node2("span", "ocgo-log-time", formatter.format(new Date(entry.time))),
          node2("span", `ocgo-log-level ${entry.level}`, t(this.language, `log.level.${entry.level}`)),
          node2("span", "ocgo-log-msg", formatLogEntry(entry, this.language))
        );
        this.logList.appendChild(row);
      }
      this.logList.scrollTop = this.logList.scrollHeight;
    }
    empty(message, titleKey = "empty.title") {
      const empty = node2("div", "ocgo-empty");
      const strong = node2("strong", "", t(this.language, titleKey));
      const description = node2("span", "", message);
      empty.append(strong, description);
      return empty;
    }
    async refreshRoute() {
      const workspaceID = getWorkspaceID();
      const changed = workspaceID !== this.workspaceID;
      if (!changed) {
        this.render();
        return;
      }
      this.workspaceID = workspaceID;
      this.resetForecast();
      this.principals = [];
      this.errorMessage = workspaceID ? "" : t(this.language, "error.workspace");
      this.requestPage = 1;
      this.busy = false;
      this.progress = void 0;
      const previousSync = this.syncPromise;
      this.controller?.abort();
      this.controller = void 0;
      if (previousSync) await previousSync.catch(() => void 0);
      if (!workspaceID) {
        this.records = [];
        this.totalRecordCount = 0;
        this.syncState = void 0;
        this.render();
        return;
      }
      try {
        try {
          const migrated = await migrateLegacyUsage(workspaceID);
          if (migrated) this.logger.info("log.migrated", { n: migrated });
        } catch (error) {
          this.logger.warn("log.migrationSkipped", { error: error instanceof Error ? error.message : String(error) });
        }
        await this.reloadRecords();
        if (this.open && this.activeTab === "forecast") void this.loadForecast(false);
        void this.refreshWorkspaces();
        void this.refreshPrincipals();
        if (this.open) window.setTimeout(() => this.autoSyncIfStale(), 200);
      } catch (error) {
        this.setError(error);
      }
    }
    principalLabel(record) {
      if (record.serviceAccountID) {
        const principal = this.principals.find((item) => item.serviceUserId === record.serviceAccountID);
        return principal?.name || principal?.email || shortID(record.serviceAccountID);
      }
      if (record.userID) {
        const principal = this.principals.find((item) => item.userId === record.userID);
        return principal?.name || principal?.email || shortID(record.userID);
      }
      return "—";
    }
    async refreshPrincipals() {
      const currentWorkspaceID = this.workspaceID;
      if (!currentWorkspaceID) return;
      this.principalsController?.abort();
      const controller = new AbortController();
      this.principalsController = controller;
      try {
        const principals = await listUsagePrincipals(currentWorkspaceID, controller.signal);
        if (this.workspaceID !== currentWorkspaceID || controller.signal.aborted) return;
        this.principals = principals;
        this.renderFilters();
        this.renderRequests();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          this.logger.warn("log.principalSkipped", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    async refreshWorkspaces() {
      try {
        this.workspaces = await listWorkspaces();
        const workspace = this.workspaces.find((item) => item.id === this.workspaceID);
        if (workspace) this.logger.info("log.workspace", { name: workspace.name });
        this.renderChrome();
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          this.logger.warn("log.workspaceListFailed", { error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    async reloadRecords() {
      const loadSeq = ++this.rangeLoadSeq;
      const workspaceID = this.workspaceID;
      if (!workspaceID) {
        this.records = [];
        this.totalRecordCount = 0;
        this.syncState = void 0;
        this.render();
        return;
      }
      const range = this.currentRange();
      const [records, totalRecordCount, syncState] = await Promise.all([
        getRecords(workspaceID, range.from, range.to),
        countRecords(workspaceID),
        getSyncState(workspaceID)
      ]);
      if (loadSeq !== this.rangeLoadSeq || this.workspaceID !== workspaceID) return;
      this.records = records;
      this.totalRecordCount = totalRecordCount;
      this.syncState = syncState;
      this.render();
      void this.ensurePricing();
    }
    sync(full) {
      if (this.syncPromise) return this.syncPromise;
      let tracked;
      tracked = this.runSync(full).finally(() => {
        if (this.syncPromise === tracked) this.syncPromise = void 0;
      });
      this.syncPromise = tracked;
      return tracked;
    }
    async runSync(full) {
      if (!this.workspaceID) {
        this.errorMessage = t(this.language, "error.workspace");
        this.render();
        return;
      }
      if (this.busy) return;
      this.busy = true;
      this.errorMessage = "";
      this.progress = { phase: "starting", page: 0, fetched: 0, saved: 0 };
      this.controller = new AbortController();
      this.renderChrome();
      this.renderStatus();
      this.logger.info(full ? "log.syncBackfillStart" : "log.syncIncrementalStart");
      try {
        const result = await syncWorkspace({
          workspaceID: this.workspaceID,
          forceFull: full,
          signal: this.controller.signal,
          onProgress: (progress) => {
            this.progress = progress;
            this.renderStatus();
          }
        });
        await this.reloadRecords();
        this.forecastStale = true;
        if (this.open && this.activeTab === "forecast") void this.loadForecast(false);
        this.logger.info(result.cacheHit ? "log.syncCached" : "log.syncComplete", {
          fetched: result.fetched,
          added: result.added,
          pages: result.pages
        });
        if (this.open) this.showToast(result.added > 0 ? "sync.toast.updated" : "sync.toast.latest", { n: result.added });
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          this.logger.warn("log.syncStopped");
        } else {
          this.setError(error);
          this.logger.error("log.error", { error: error instanceof Error ? error.message : String(error) });
        }
        await this.reloadRecords();
        this.forecastStale = true;
        if (this.open && this.activeTab === "forecast") void this.loadForecast(false);
      } finally {
        this.busy = false;
        this.progress = void 0;
        this.controller = void 0;
        this.renderChrome();
        this.renderStatus();
        if (this.activeTab === "data") this.renderData();
      }
    }
    stopSync() {
      this.controller?.abort();
    }
    autoSyncIfStale() {
      if (!this.hasOpened || !this.workspaceID || this.busy || this.syncPromise) return;
      if (document.visibilityState !== "visible") return;
      const last = this.syncState?.lastSuccessfulSyncAt ?? 0;
      if (Date.now() - last < 9 * 60 * 1e3) return;
      void this.sync(false);
    }
    startAutoSync() {
      if (this.autoInterval) window.clearInterval(this.autoInterval);
      this.autoInterval = window.setInterval(() => this.autoSyncIfStale(), 10 * 60 * 1e3);
    }
    handleVisibility() {
      if (document.visibilityState === "visible") this.autoSyncIfStale();
    }
    handleCaptured(workspaceID, count) {
      this.logger.info("status.captured", { n: count });
      if (workspaceID !== this.workspaceID) return;
      this.forecastStale = true;
      if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
      this.refreshTimer = window.setTimeout(() => {
        void this.reloadRecords();
        if (this.open && this.activeTab === "forecast") void this.loadForecast(false);
      }, 300);
    }
    setError(error) {
      if (error instanceof ApiError) {
        const key = {
          session: "error.session",
          permission: "error.permission",
          cursor: "error.cursor",
          "rate-limit": "error.rate",
          "bad-request": "error.badRequest",
          contract: "error.contract",
          network: "error.network",
          server: "error.unknown"
        }[error.kind];
        this.errorMessage = t(this.language, key, { message: error.message });
      } else {
        this.errorMessage = t(this.language, "error.unknown", { message: error instanceof Error ? error.message : String(error) });
      }
      this.renderStatus();
      this.renderError();
    }
    exportCsv() {
      if (!this.analysis) return;
      const header = [
        "time",
        "status",
        "model",
        "provider",
        "ttft_ms",
        "tps",
        "input",
        "cache_read",
        "cache_write",
        "cache_write_1h",
        "output",
        "reasoning",
        "cost_usd",
        "user_id",
        "service_account_id",
        "request_id",
        "legacy"
      ];
      const rows = this.analysis.records.map((record) => [
        new Date(record.startedAt).toISOString(),
        record.outcome,
        record.model,
        record.provider,
        computeTtft(record) ?? "",
        computeTps(record) ?? "",
        record.inputTokens,
        record.cacheReadTokens,
        record.cacheWriteTokens,
        record.cacheWrite1hTokens,
        record.outputTokens,
        record.reasoningTokens,
        record.costUsd,
        record.userID,
        record.serviceAccountID,
        record.requestID,
        record.legacy ? "true" : "false"
      ]);
      const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
      downloadText(`opencode-lens-${this.workspaceID ?? "workspace"}-${Date.now()}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
      this.logger.info("log.exportCsv", { n: rows.length });
    }
    async exportJson() {
      if (!this.workspaceID) return;
      const records = await getAllRecords(this.workspaceID);
      const payload = {
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        version: APP_VERSION,
        workspaceID: this.workspaceID,
        syncState: this.syncState,
        records
      };
      downloadText(
        `opencode-lens-${this.workspaceID}-${Date.now()}.json`,
        JSON.stringify(payload, null, 2),
        "application/json;charset=utf-8"
      );
      this.logger.info("log.exportJson", { n: records.length });
    }
    async clearHistory() {
      if (!this.workspaceID) return;
      if (!this.clearArmed) {
        this.clearArmed = true;
        this.renderData();
        this.clearTimer = window.setTimeout(() => {
          this.clearArmed = false;
          this.renderData();
        }, 4e3);
        return;
      }
      if (this.clearTimer) window.clearTimeout(this.clearTimer);
      this.clearArmed = false;
      if (this.syncPromise) {
        this.stopSync();
        await this.syncPromise.catch(() => void 0);
      }
      await clearWorkspace(this.workspaceID);
      try {
        await clearLegacyUsage(this.workspaceID);
      } catch (error) {
        this.logger.warn("log.legacyCleanupSkipped", { error: error instanceof Error ? error.message : String(error) });
      }
      const workspaceID = this.workspaceID;
      await updateSyncState(workspaceID, () => ({
        workspaceID,
        retentionDays: RETENTION_DAYS,
        backfillComplete: false,
        gapDetected: false,
        legacyImportedAt: Date.now()
      }));
      this.records = [];
      this.totalRecordCount = 0;
      this.resetForecast();
      this.syncState = await getSyncState(this.workspaceID);
      this.requestPage = 1;
      this.logger.warn("log.historyCleared");
      this.render();
    }
    async copyLogs() {
      const text2 = this.logger.all().map((entry) => `${new Date(entry.time).toISOString()} [${t(this.language, `log.level.${entry.level}`)}] ${formatLogEntry(entry, this.language)}`).join("\n");
      try {
        await navigator.clipboard.writeText(text2);
        this.logger.info("log.diagnosticsCopied");
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text2;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        this.logger.info("log.diagnosticsCopied");
      }
    }
  };

  // src/main.ts
  var VERSION = APP_VERSION;
  var logger = new Logger();
  var panel;
  var routeTimer;
  function scheduleRouteRefresh() {
    if (routeTimer) window.clearTimeout(routeTimer);
    routeTimer = window.setTimeout(() => {
      void panel?.refreshRoute();
    }, 60);
  }
  function patchHistory() {
    const win2 = window;
    if (win2.__ocgoLensHistoryPatched) return;
    win2.__ocgoLensHistoryPatched = true;
    const push = history.pushState.bind(history);
    const replace = history.replaceState.bind(history);
    history.pushState = function patchedPushState(data, unused, url) {
      push(data, unused, url);
      scheduleRouteRefresh();
    };
    history.replaceState = function patchedReplaceState(data, unused, url) {
      replace(data, unused, url);
      scheduleRouteRefresh();
    };
    window.addEventListener("popstate", scheduleRouteRefresh);
    window.addEventListener("hashchange", scheduleRouteRefresh);
  }
  function boot() {
    if (location.hostname !== "opencode.ai" || !location.pathname.startsWith("/console")) return;
    if (document.getElementById("ocgo-lens-host")) return;
    try {
      patchHistory();
      installRequestLogCapture(({ workspaceID, page }) => {
        void persistCapturedPage(workspaceID, page.items).then((count) => {
          if (count > 0) panel?.handleCaptured(workspaceID, count);
        }).catch((error) => logger.warn("log.captureFailed", { error: error instanceof Error ? error.message : String(error) }));
      });
      panel = new Panel(logger);
      panel.mount();
      void panel.refreshRoute();
      logger.info("log.ready", { version: VERSION });
    } catch (error) {
      logger.error("log.bootFailed", { error: error instanceof Error ? error.message : String(error) });
      console.error("[OpenCode Performance Lens]", error);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
  var win = window;
  win.__ocgoLens = {
    version: VERSION,
    getWorkspaceID,
    aggregateRecords,
    computeTtft,
    computeTps,
    cacheHitRate
  };
})();
