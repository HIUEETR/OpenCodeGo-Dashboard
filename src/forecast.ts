import { matchesFilters } from './analytics';
import {
  isGoPricingCacheFresh,
  quotaLimitsForModel,
  quotaUsdForRecord,
  selectPricingTier,
} from './pricing';
import type {
  AnalyticsFilters,
  GoPlan,
  GoPricingCache,
  GoQuotaStatus,
  RequestRecord,
  SyncState,
} from './types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const FIVE_MINUTES = 5 * MINUTE;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * DAY;
const TWENTY_EIGHT_DAYS = 28 * DAY;

export type ForecastWindowKey = 'fiveHour' | 'next24h' | 'week' | 'month';
export type ForecastConfidence = 'high' | 'medium' | 'low';

export interface ForecastChartPoint {
  at: number;
  actualUsd: number | null;
  p10Usd: number | null;
  p50Usd: number | null;
  p90Usd: number | null;
}

export interface ForecastWindowForecast {
  key: ForecastWindowKey;
  usedUsd: number;
  p10Usd: number;
  p50Usd: number;
  p90Usd: number;
  limitUsd: number | null;
  usedRatio: number | null;
  p10Ratio: number | null;
  p50Ratio: number | null;
  p90Ratio: number | null;
  remainingRatio: number | null;
  startsAt?: number;
  resetsAt?: number;
  hitAt?: number;
  windowStarted: boolean;
  chart: ForecastChartPoint[];
}

export interface ModelQuotaForecast {
  model: string;
  provider: string;
  displayName: string;
  monthlyLimitUsd: number | null;
  limitKnown: boolean;
  windowLimits: {
    fiveHour: number | null;
    week: number | null;
    month: number | null;
  };
  windows: Record<ForecastWindowKey, ForecastWindowForecast>;
  riskScore: number;
  riskWindow: ForecastWindowKey | null;
  pricedRequests: number;
  unpricedRequests: number;
  totalRequests: number;
  confidence: ForecastConfidence;
  confidenceReasons: string[];
}

export interface QuotaForecastResult {
  generatedAt: number;
  plan: GoPlan;
  officialStatus: boolean;
  models: ModelQuotaForecast[];
  riskiest?: ModelQuotaForecast;
  warnings: string[];
}

export interface BuildQuotaForecastOptions {
  records: RequestRecord[];
  pricing: GoPricingCache;
  filters: AnalyticsFilters;
  status?: GoQuotaStatus;
  syncState?: SyncState;
  statusError?: string;
  now?: number;
}

interface SpendEvent {
  at: number;
  usd: number;
}

interface WindowBounds {
  startsAt?: number;
  resetsAt?: number;
  official: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function bucketStart(timestamp: number, bucketMs: number): number {
  return Math.floor(timestamp / bucketMs) * bucketMs;
}

function sumEvents(events: SpendEvent[], from: number, to: number): number {
  let total = 0;
  for (const event of events) {
    if (event.at >= from && event.at < to) total += event.usd;
  }
  return total;
}

function utcWeekStart(timestamp: number): number {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const offset = (day + 6) % 7;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - offset);
}

function utcMonthStart(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

function nextUtcMonth(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

function resolveWindows(now: number, status: GoQuotaStatus | undefined): Record<Exclude<ForecastWindowKey, 'next24h'>, WindowBounds> {
  const weekStart = status?.week.resetsAt !== undefined
    ? status.week.resetsAt - WEEK
    : utcWeekStart(now);
  const weekEnd = status?.week.resetsAt ?? weekStart + WEEK;
  const monthStart = status?.accessStartsAt
    ?? (status?.month.resetsAt !== undefined && status.month.resetsAt - 30 * DAY <= now
      ? status.month.resetsAt - 30 * DAY
      : utcMonthStart(now));
  const monthEnd = status?.month.resetsAt ?? status?.accessEndsAt ?? nextUtcMonth(now);
  return {
    fiveHour: {
      startsAt: status?.fiveHour.startsAt ?? (status?.active ? undefined : now - FIVE_HOURS),
      resetsAt: status?.fiveHour.resetsAt ?? (status?.active ? undefined : now),
      official: Boolean(status?.active && status.fiveHour.startsAt !== undefined && status.fiveHour.resetsAt !== undefined),
    },
    week: {
      startsAt: weekStart,
      resetsAt: weekEnd,
      official: Boolean(status?.active && status.week.resetsAt !== undefined),
    },
    month: {
      startsAt: monthStart,
      resetsAt: monthEnd,
      official: Boolean(status?.active && (status.month.resetsAt !== undefined || status.accessEndsAt !== undefined)),
    },
  };
}

function slotKey(timestamp: number, bucketMs: number): string {
  const date = new Date(timestamp);
  if (bucketMs >= DAY) return String(date.getUTCDay());
  if (bucketMs >= HOUR) return `${date.getUTCDay()}:${date.getUTCHours()}`;
  return `${date.getUTCDay()}:${date.getUTCHours()}:${Math.floor(date.getUTCMinutes() / 5)}`;
}

interface SeasonalStats {
  totals: Map<string, number>;
  counts: Map<string, number>;
  globalMean: number;
}

function createSeasonalStats(events: SpendEvent[], bucketMs: number, now: number): SeasonalStats {
  const from = now - TWENTY_EIGHT_DAYS;
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
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

function seasonalFactor(stats: SeasonalStats, at: number, bucketMs: number): number {
  if (stats.globalMean <= 0) return 1;
  const key = slotKey(at, bucketMs);
  const count = stats.counts.get(key) ?? 1;
  const slotMean = (stats.totals.get(key) ?? 0) / count;
  return clamp((slotMean + 4 * stats.globalMean) / (5 * stats.globalMean), 0.25, 4);
}

function dailySpend(events: SpendEvent[], now: number): number[] {
  const today = bucketStart(now, DAY);
  const values: number[] = [];
  for (let offset = 13; offset >= 0; offset -= 1) {
    const start = today - offset * DAY;
    values.push(sumEvents(events, start, start + DAY));
  }
  return values;
}

function trendFactor(events: SpendEvent[], at: number, now: number): number {
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
  const dayOffset = Math.max(0, (at - now) / DAY);
  return clamp(1 + slope * dayOffset, 0.75, 1.25);
}

function shortRatePerMs(events: SpendEvent[], now: number): number {
  const last15 = sumEvents(events, now - 15 * MINUTE, now) / (15 * MINUTE);
  const last60 = sumEvents(events, now - HOUR, now) / HOUR;
  const last24h = sumEvents(events, now - DAY, now) / DAY;
  const latest = events.length ? events[events.length - 1].at : 0;
  const activeSession = latest >= now - 15 * MINUTE;
  if (last60 > 0) return activeSession ? last15 * 0.7 + last60 * 0.3 : last15 * 0.35 + last60 * 0.65;
  return last24h;
}

function dayRatePerMs(events: SpendEvent[], now: number): number {
  return sumEvents(events, now - 14 * DAY, now) / (14 * DAY);
}

function quantilesFor(key: ForecastWindowKey, confidence: ForecastConfidence): { q10: number; q90: number } {
  const base: Record<ForecastWindowKey, { q10: number; q90: number }> = {
    fiveHour: { q10: 0.75, q90: 1.35 },
    next24h: { q10: 0.65, q90: 1.55 },
    week: { q10: 0.5, q90: 1.7 },
    month: { q10: 0.4, q90: 1.85 },
  };
  const widen = confidence === 'high' ? 1 : confidence === 'medium' ? 1.1 : 1.25;
  const selected = base[key];
  return {
    q10: clamp(1 - (1 - selected.q10) * widen, 0, 1),
    q90: clamp(1 + (selected.q90 - 1) * widen, 0, 2.5),
  };
}

function assessConfidence(
  records: RequestRecord[],
  status: GoQuotaStatus | undefined,
  pricing: GoPricingCache,
  now: number,
  syncState: SyncState | undefined,
  unpricedRequests: number,
): { confidence: ForecastConfidence; reasons: string[] } {
  const reasons: string[] = [];
  const historyStart = records.length ? Math.min(...records.map((record) => record.startedAt)) : now;
  const historyHours = (now - historyStart) / HOUR;
  if (!status?.active) reasons.push('forecast.reasonNoStatus');
  if (historyHours < 24) reasons.push('forecast.reasonShortHistory');
  if (syncState?.gapDetected || syncState?.backfillComplete === false) reasons.push('forecast.reasonGap');
  if (!isGoPricingCacheFresh(pricing, now)) reasons.push('forecast.reasonStalePricing');
  if (records.length > 0 && unpricedRequests / records.length > 0.05) reasons.push('forecast.reasonUnpriced');
  if (!reasons.length) return { confidence: 'high', reasons };
  if (historyHours < 6 || (!status?.active && historyHours < 24)) return { confidence: 'low', reasons };
  return { confidence: 'medium', reasons };
}

function collectForecastBuckets(
  key: ForecastWindowKey,
  events: SpendEvent[],
  now: number,
  forecastStart: number,
  forecastEnd: number,
): Array<{ from: number; to: number; usd: number }> {
  if (forecastEnd <= forecastStart) return [];
  const bucketMs = key === 'fiveHour' ? FIVE_MINUTES : key === 'next24h' ? HOUR : DAY;
  const shortRate = shortRatePerMs(events, now);
  const dailyRate = dayRatePerMs(events, now);
  const seasonal = createSeasonalStats(events, bucketMs, now);
  const buckets: Array<{ from: number; to: number; usd: number }> = [];
  let cursor = forecastStart;
  while (cursor < forecastEnd) {
    const next = Math.min(forecastEnd, bucketStart(cursor, bucketMs) + bucketMs);
    const duration = Math.max(0, next - cursor);
    const midpoint = cursor + duration / 2;
    const season = seasonalFactor(seasonal, midpoint, bucketMs);
    let base: number;
    if (key === 'week' || key === 'month') {
      base = dailyRate * duration * season * trendFactor(events, midpoint, now);
    } else if (key === 'next24h') {
      const last6h = sumEvents(events, now - 6 * HOUR, now) / (6 * HOUR);
      const last24h = sumEvents(events, now - DAY, now) / DAY;
      base = (last6h * 0.5 + last24h * 0.5) * duration * season;
    } else {
      base = shortRate * duration * season;
    }
    buckets.push({ from: cursor, to: next, usd: Math.max(0, base) });
    cursor = next;
  }
  return buckets;
}

function buildChart(
  key: ForecastWindowKey,
  events: SpendEvent[],
  chartStart: number,
  now: number,
  forecastEnd: number,
  usedUsd: number,
  future: Array<{ from: number; to: number; usd: number }>,
  q10: number,
  q90: number,
): ForecastChartPoint[] {
  const bucketMs = key === 'fiveHour' ? FIVE_MINUTES : key === 'next24h' ? HOUR : DAY;
  const points: ForecastChartPoint[] = [];
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

function buildWindowForecast(
  key: ForecastWindowKey,
  events: SpendEvent[],
  now: number,
  bounds: WindowBounds,
  limitUsd: number | null,
  confidence: ForecastConfidence,
): ForecastWindowForecast {
  const isNext24h = key === 'next24h';
  const windowStart = isNext24h ? now : bounds.startsAt;
  const windowEnd = isNext24h ? now + DAY : bounds.resetsAt ?? (windowStart === undefined ? undefined : windowStart + (key === 'fiveHour' ? FIVE_HOURS : key === 'week' ? WEEK : 30 * DAY));
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
  const ratio = (value: number) => limitUsd === null || limitUsd <= 0 ? null : value / limitUsd;
  let hitAt: number | undefined;
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
  const chartStart = isNext24h ? now - DAY : windowStart ?? now;
  const chartEnd = isNext24h ? now + DAY : Math.max(now, forecastEnd);
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
    ...(windowStart === undefined ? {} : { startsAt: windowStart }),
    ...(windowEnd === undefined ? {} : { resetsAt: windowEnd }),
    ...(hitAt === undefined ? {} : { hitAt }),
    windowStarted: isNext24h || (windowStart !== undefined && windowStart <= now),
    chart: buildChart(key, events, chartStart, now, chartEnd, usedUsd, future, q10, q90),
  };
}

export function buildQuotaForecast(options: BuildQuotaForecastOptions): QuotaForecastResult {
  const now = options.now ?? Date.now();
  const plan = options.status?.product ?? 'go';
  const bounds = resolveWindows(now, options.status);
  const filtered = options.records.filter((record) => matchesFilters(record, options.filters));
  const groups = new Map<string, {
    model: string;
    provider: string;
    displayName: string;
    records: RequestRecord[];
    events: SpendEvent[];
    unpricedRequests: number;
  }>();
  for (const record of filtered) {
    if (record.provider && !['opencode', 'opencode-go'].includes(record.provider.toLowerCase())) continue;
    const model = record.model || record.requestedModel || 'unknown';
    const provider = record.provider || '';
    const key = `${model}\u0000${provider}`;
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

  const models: ModelQuotaForecast[] = [];
  for (const group of groups.values()) {
    group.events.sort((a, b) => a.at - b.at);
    const confidence = assessConfidence(
      group.records,
      options.status,
      options.pricing,
      now,
      options.syncState,
      group.unpricedRequests,
    );
    const monthlyLimitUsd = quotaLimitsForModel(options.pricing, plan, group.model);
    const limitKnown = monthlyLimitUsd !== undefined;
    const finiteMonthly = monthlyLimitUsd === undefined ? null : monthlyLimitUsd;
    const fiveHourLimit = finiteMonthly === null ? null : finiteMonthly / 5;
    const weekLimit = finiteMonthly === null ? null : finiteMonthly / 2;
    const windows: Record<ForecastWindowKey, ForecastWindowForecast> = {
      fiveHour: buildWindowForecast('fiveHour', group.events, now, bounds.fiveHour, fiveHourLimit, confidence.confidence),
      next24h: buildWindowForecast('next24h', group.events, now, { official: false }, finiteMonthly, confidence.confidence),
      week: buildWindowForecast('week', group.events, now, bounds.week, weekLimit, confidence.confidence),
      month: buildWindowForecast('month', group.events, now, bounds.month, finiteMonthly, confidence.confidence),
    };
    const riskCandidates: Array<{ key: ForecastWindowKey; score: number }> = [
      { key: 'fiveHour', score: windows.fiveHour.p90Ratio ?? 0 },
      { key: 'week', score: windows.week.p90Ratio ?? 0 },
      { key: 'month', score: windows.month.p90Ratio ?? 0 },
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
      confidenceReasons: confidence.reasons,
    });
  }
  models.sort((a, b) => b.riskScore - a.riskScore || b.windows.month.p90Usd - a.windows.month.p90Usd || a.displayName.localeCompare(b.displayName));
  const warnings: string[] = [];
  if (!options.status?.active) warnings.push('forecast.reasonNoStatus');
  if (options.statusError) warnings.push('forecast.statusFailed');
  if (!isGoPricingCacheFresh(options.pricing, now)) warnings.push('forecast.reasonStalePricing');
  return {
    generatedAt: now,
    plan,
    officialStatus: Boolean(options.status?.active),
    models,
    riskiest: models.find((model) => model.monthlyLimitUsd !== null && model.windows.month.p90Usd > 0) ?? models[0],
    warnings,
  };
}
