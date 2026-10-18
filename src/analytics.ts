import type {
  AnalyticsFilters,
  AnalyticsResult,
  BucketPoint,
  ModelSummary,
  RangePreset,
  RequestRecord,
  SummaryMetrics,
  TimeRange,
} from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function cacheHitRate(record: { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; cacheWrite1hTokens?: number }): number | null {
  const denominator =
    record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + (record.cacheWrite1hTokens ?? 0);
  return denominator > 0 ? record.cacheReadTokens / denominator : null;
}

export function totalTokenCount(metrics: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  return metrics.inputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens + metrics.outputTokens;
}

export function computeTtft(record: RequestRecord): number | null {
  if (record.outcome !== 'succeeded' || !record.stream) return null;
  const value = record.timeToFirstTokenMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function computeTps(record: RequestRecord): number | null {
  if (record.outcome !== 'succeeded' || !record.stream || record.outputTokens <= 0) return null;
  const start =
    typeof record.firstTokenAt === 'number' && Number.isFinite(record.firstTokenAt)
      ? record.firstTokenAt
      : typeof record.timeToFirstTokenMs === 'number' && Number.isFinite(record.timeToFirstTokenMs)
        ? record.startedAt + record.timeToFirstTokenMs
        : undefined;
  const fallbackEnd =
    record.finishedAt ??
    (record.durationMs > 0 ? record.startedAt + record.durationMs : undefined);
  const end =
    typeof record.lastTokenAt === 'number' && Number.isFinite(record.lastTokenAt)
      ? record.lastTokenAt
      : fallbackEnd;
  if (start === undefined || end === undefined || end <= start) return null;
  const seconds = (end - start) / 1000;
  return seconds > 0 ? record.outputTokens / seconds : null;
}

function emptySummary(): SummaryMetrics {
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
    tpsSamples: 0,
  };
}

interface Accumulator {
  metrics: SummaryMetrics;
  ttftSum: number;
  ttftSlowest: number | null;
  tpsSum: number;
  tpsSlowest: number | null;
}

function newAccumulator(): Accumulator {
  return { metrics: emptySummary(), ttftSum: 0, ttftSlowest: null, tpsSum: 0, tpsSlowest: null };
}

function addRecord(accumulator: Accumulator, record: RequestRecord): void {
  const metrics = accumulator.metrics;
  metrics.requests += 1;
  if (record.outcome === 'succeeded') metrics.succeeded += 1;
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
    accumulator.ttftSlowest = accumulator.ttftSlowest === null
      ? ttft
      : Math.max(accumulator.ttftSlowest, ttft);
  }
  const tps = computeTps(record);
  if (tps !== null) {
    metrics.tpsSamples += 1;
    accumulator.tpsSum += tps;
    accumulator.tpsSlowest = accumulator.tpsSlowest === null
      ? tps
      : Math.min(accumulator.tpsSlowest, tps);
  }
}

function finishSummary(accumulator: Accumulator): SummaryMetrics {
  const metrics = accumulator.metrics;
  metrics.successRate = metrics.requests > 0 ? metrics.succeeded / metrics.requests : null;
  metrics.cacheHitRate = cacheHitRate(metrics);
  metrics.ttftAvg = metrics.ttftSamples > 0 ? accumulator.ttftSum / metrics.ttftSamples : null;
  metrics.ttftSlowest = accumulator.ttftSlowest;
  metrics.tpsAvg = metrics.tpsSamples > 0 ? accumulator.tpsSum / metrics.tpsSamples : null;
  metrics.tpsSlowest = accumulator.tpsSlowest;
  return metrics;
}

export function matchesFilters(record: RequestRecord, filters: AnalyticsFilters): boolean {
  if (filters.model && record.model !== filters.model) return false;
  if (filters.provider && record.provider !== filters.provider) return false;
  if (filters.userKey) {
    if (filters.userKey.startsWith('account:')) {
      if (record.serviceAccountID !== filters.userKey.slice('account:'.length)) return false;
    } else if (filters.userKey.startsWith('user:')) {
      if (record.userID !== filters.userKey.slice('user:'.length)) return false;
    }
  }
  return true;
}

export function localBucketStart(timestamp: number, bucketMs: number, anchor = 0): number {
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

export function averageBucketMetric(
  buckets: BucketPoint[],
  select: (bucket: BucketPoint) => number | null,
): number | null {
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

export function tokenRateForRange(
  buckets: BucketPoint[],
  from: number,
  to: number,
): { value: number; unit: 'h' | 'd' } | null {
  if (!buckets.length) return null;
  if (!buckets.some((bucket) => bucket.requests > 0)) return null;
  const first = buckets[0]?.start;
  const last = buckets[buckets.length - 1]?.end;
  const start = from > 0 ? from : first;
  const end = from > 0 && to > from ? to : last;
  if (start === undefined || end === undefined || end <= start) return null;
  const span = end - start;
  const unit = span <= DAY ? 'h' : 'd';
  const unitMs = unit === 'h' ? HOUR : DAY;
  const total = buckets.reduce((sum, bucket) => sum + bucket.totalTokens, 0);
  return { value: total / (span / unitMs), unit };
}

export function chooseBucketMs(from: number, to: number): number {
  const span = Math.max(0, to - from);
  if (span <= HOUR) return 5 * MINUTE;
  if (span <= DAY) return HOUR;
  if (span <= 30 * DAY) return DAY;
  if (span <= 180 * DAY) return 7 * DAY;
  return 30 * DAY;
}

export function makeTimeRange(
  preset: RangePreset,
  customFrom?: number,
  customTo?: number,
  now = Date.now(),
): TimeRange {
  let from = now - 7 * DAY;
  let to = now;
  if (preset === '1h') from = now - HOUR;
  else if (preset === '24h') from = now - DAY;
  else if (preset === '7d') from = now - 7 * DAY;
  else if (preset === '30d') from = now - 30 * DAY;
  else if (preset === 'all') from = 0;
  else if (preset === 'custom') {
    from = typeof customFrom === 'number' && Number.isFinite(customFrom) ? customFrom : now - 7 * DAY;
    to = typeof customTo === 'number' && Number.isFinite(customTo) ? customTo : now;
    if (to < from) [from, to] = [to, from];
  }
  return { preset, from, to, label: preset, bucketMs: chooseBucketMs(from, to) };
}

export function aggregateRecords(
  records: RequestRecord[],
  filters: AnalyticsFilters,
  from: number,
  to: number,
  requestedBucketMs?: number,
): AnalyticsResult {
  const bucketMs = requestedBucketMs ?? chooseBucketMs(from, to);
  const filtered = records.filter(
    (record) =>
      record.category === 'inference' &&
      record.startedAt >= from &&
      record.startedAt <= to &&
      matchesFilters(record, filters),
  );
  const bucketAnchor = filtered.length
    ? localBucketStart(from === 0 ? Math.min(...filtered.map((item) => item.startedAt)) : from, DAY)
    : localBucketStart(from, DAY);
  const total = newAccumulator();
  const modelAccumulators = new Map<string, Accumulator & { model: string; provider: string }>();
  const bucketAccumulators = new Map<number, Accumulator>();

  for (const record of filtered) {
    addRecord(total, record);
    const modelKey = `${record.provider}\u0000${record.model}`;
    let modelAccumulator = modelAccumulators.get(modelKey);
    if (!modelAccumulator) {
      modelAccumulator = { ...newAccumulator(), model: record.model, provider: record.provider };
      modelAccumulators.set(modelKey, modelAccumulator);
    }
    addRecord(modelAccumulator, record);

    const bucketStart = localBucketStart(record.startedAt, bucketMs, bucketAnchor);
    let bucketAccumulator = bucketAccumulators.get(bucketStart);
    if (!bucketAccumulator) {
      bucketAccumulator = newAccumulator();
      bucketAccumulators.set(bucketStart, bucketAccumulator);
    }
    addRecord(bucketAccumulator, record);
  }

  const models: ModelSummary[] = [...modelAccumulators.values()]
    .map((accumulator) => ({
      ...finishSummary(accumulator),
      model: accumulator.model,
      provider: accumulator.provider,
    }))
    .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);

  const buckets: BucketPoint[] = [];
  if (from !== 0 || filtered.length > 0) {
    const firstTimestamp = from === 0 ? Math.min(...filtered.map((record) => record.startedAt)) : from;
    const first = localBucketStart(firstTimestamp, bucketMs, bucketAnchor);
    for (let start = first; start < to && buckets.length < 5000; start += bucketMs) {
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
        tpsSamples: summary.tpsSamples,
      });
    }
  }

  return {
    records: filtered.sort((a, b) => b.startedAt - a.startedAt),
    summary: finishSummary(total),
    models,
    buckets,
  };
}

export function filterOptions(records: RequestRecord[]): {
  models: string[];
  providers: string[];
  users: Array<{ key: string; label: string }>;
} {
  const models = new Set<string>();
  const providers = new Set<string>();
  const users = new Map<string, string>();
  for (const record of records) {
    if (record.model) models.add(record.model);
    if (record.provider) providers.add(record.provider);
    if (record.serviceAccountID) users.set(`account:${record.serviceAccountID}`, `Account · ${record.serviceAccountID}`);
    else if (record.userID) users.set(`user:${record.userID}`, `User · ${record.userID}`);
  }
  return {
    models: [...models].sort(),
    providers: [...providers].sort(),
    users: [...users.entries()].map(([key, label]) => ({ key, label })).sort((a, b) => a.label.localeCompare(b.label)),
  };
}




