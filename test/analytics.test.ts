import { describe, expect, it } from 'vitest';
import {
  aggregateRecords,
  averageBucketMetric,
  averageExcludingOutliers,
  cacheHitRate,
  computeTps,
  computeTtft,
  filterOptions,
  makeTimeRange,
  tokenRateForRange,
} from '../src/analytics';
import { normalizeLegacyUsage, normalizeRawRequest } from '../src/records';
import type { RequestRecord } from '../src/types';

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  const startedAt = Date.UTC(2026, 9, 18, 9, 0, 0);
  return {
    key: 'wrk_test:req_1',
    workspaceID: 'wrk_test',
    id: 'req_1',
    requestID: 'req_1',
    startedAt,
    finishedAt: startedAt + 4000,
    durationMs: 4000,
    outcome: 'succeeded',
    category: 'inference',
    protocol: 'openai-responses',
    product: 'go',
    service: '',
    path: '/v1/responses',
    method: 'POST',
    stream: true,
    sessionID: 'session',
    userID: 'user_1',
    serviceAccountID: '',
    serviceAPIKeyID: 'key_1',
    requestedModel: 'model-a',
    model: 'model-a',
    provider: 'opencode',
    errorCode: '',
    errorMessage: '',
    timeToFirstTokenMs: 800,
    firstTokenAt: startedAt + 800,
    lastTokenAt: startedAt + 3800,
    inputTokens: 100,
    outputTokens: 300,
    reasoningTokens: 50,
    cacheReadTokens: 700,
    cacheWriteTokens: 100,
    cacheWrite1hTokens: 100,
    costUsd: 0.01,
    providerCostUsd: 0.008,
    legacy: false,
    ...overrides,
  };
}

describe('performance metrics', () => {
  it('calculates cache hit rate with reads and both cache write buckets', () => {
    expect(cacheHitRate(record())).toBeCloseTo(700 / 1000);
    expect(cacheHitRate({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBeNull();
  });

  it('uses first and last token timestamps for output TPS', () => {
    expect(computeTps(record())).toBeCloseTo(300 / 3);
  });

  it('falls back to TTFT and finishedAt when token timestamps are absent', () => {
    expect(computeTps(record({ firstTokenAt: undefined, lastTokenAt: undefined }))).toBeCloseTo(300 / 3.2);
  });

  it('falls back to request duration when the token timestamp window is implausibly short', () => {
    const base = record();
    expect(computeTps(record({
      firstTokenAt: base.startedAt + 800,
      lastTokenAt: base.startedAt + 801,
      finishedAt: base.startedAt + 4000,
      durationMs: 4000,
      outputTokens: 300,
    }))).toBeCloseTo(75);
  });

  it('excludes samples whose complete request duration is still implausible', () => {
    const base = record();
    expect(computeTps(record({
      firstTokenAt: base.startedAt + 800,
      lastTokenAt: base.startedAt + 801,
      finishedAt: base.startedAt + 1000,
      durationMs: 1000,
      outputTokens: 5000,
    }))).toBeNull();
  });

  it('excludes failed, non-streaming, and invalid samples', () => {
    expect(computeTtft(record({ outcome: 'failed' }))).toBeNull();
    expect(computeTtft(record({ stream: false }))).toBeNull();
    expect(computeTps(record({ outputTokens: 0 }))).toBeNull();
    expect(computeTps(record({ firstTokenAt: undefined, lastTokenAt: undefined, finishedAt: undefined, durationMs: 500 }))).toBeNull();
  });

  it('uses a one-percent trimmed average', () => {
    expect(averageExcludingOutliers([1, 10, 10, 10, 100])).toBe(10);
    expect(averageExcludingOutliers([0.4, 100, 150, 250, 300, 350])).toBe(200);
    expect(averageExcludingOutliers([0, ...Array(99).fill(10), 1000])).toBe(10);
    expect(averageExcludingOutliers([1, 2, 3, 4])).toBeCloseTo(2.5);
    expect(averageExcludingOutliers([])).toBeNull();
  });
});

describe('aggregation', () => {
  it('uses a five hour range with hourly buckets', () => {
    const now = Date.UTC(2026, 9, 18, 12, 0, 0);
    const range = makeTimeRange('5h', undefined, undefined, now);
    expect(range.from).toBe(now - 5 * 60 * 60 * 1000);
    expect(range.to).toBe(now);
    expect(range.bucketMs).toBe(60 * 60 * 1000);
  });

  it('combines totals, model rows, and time buckets', () => {
    const first = record();
    const second = record({
      key: 'wrk_test:req_2',
      id: 'req_2',
      startedAt: first.startedAt + 60_000,
      finishedAt: first.startedAt + 60_000 + 4300,
      durationMs: 4300,
      timeToFirstTokenMs: 1200,
      firstTokenAt: first.startedAt + 60_000 + 1200,
      lastTokenAt: first.startedAt + 60_000 + 4200,
      model: 'model-b',
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
      costUsd: 0.02,
    });
    const result = aggregateRecords(
      [first, second],
      { model: '', provider: '', userKey: '' },
      first.startedAt - 1000,
      first.startedAt + 120_000,
      60_000,
    );
    expect(result.summary.requests).toBe(2);
    expect(result.summary.outputTokens).toBe(500);
    expect(result.summary.totalTokens).toBe(1600);
    expect(result.models.find((model) => model.model === 'model-a')?.totalTokens).toBe(1300);
    expect(result.models.find((model) => model.model === 'model-b')?.totalTokens).toBe(300);
    expect(result.summary.costUsd).toBeCloseTo(0.03);
    expect(result.summary.cacheHitRate).toBeCloseTo(700 / 1100);
    expect(result.summary.ttftSamples).toBe(2);
    expect(result.summary.ttftAvg).toBe(1000);
    expect(result.summary.ttftSlowest).toBe(1200);
    expect(result.summary.tpsAvg).toBeCloseTo((100 + 200 / 3) / 2);
    expect(result.summary.tpsSlowest).toBeCloseTo(200 / 3);
    const modelB = result.models.find((model) => model.model === 'model-b');
    expect(modelB?.ttftAvg).toBe(1200);
    expect(modelB?.ttftSlowest).toBe(1200);
    expect(modelB?.tpsAvg).toBeCloseTo(200 / 3);
    expect(modelB?.tpsSlowest).toBeCloseTo(200 / 3);
    expect(result.models.map((model) => model.model)).toEqual(['model-b', 'model-a']);
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(2);
    expect(result.buckets.some((bucket) => bucket.ttftSlowest === 1200)).toBe(true);
  });

  it('uses robust averages while retaining slowest observations', () => {
    const base = record();
    const records = Array.from({ length: 6 }, (_, index) => {
      const startedAt = base.startedAt + index * 1000;
      if (index < 5) {
        return record({
          key: `wrk_test:req_${index}`,
          id: `req_${index}`,
          requestID: `req_${index}`,
          startedAt,
          timeToFirstTokenMs: 1000,
          firstTokenAt: startedAt + 1000,
          lastTokenAt: startedAt + 2000,
          outputTokens: 100 + index * 50,
        });
      }
      return record({
        key: 'wrk_test:req_outlier',
        id: 'req_outlier',
        requestID: 'req_outlier',
        startedAt,
        timeToFirstTokenMs: 60_000,
        firstTokenAt: startedAt + 60_000,
        lastTokenAt: startedAt + 65_000,
        outputTokens: 2,
      });
    });
    const result = aggregateRecords(
      records,
      { model: '', provider: '', userKey: '' },
      base.startedAt,
      base.startedAt + 60_000,
      60_000,
    );
    expect(result.summary.ttftSamples).toBe(6);
    expect(result.summary.ttftAvg).toBe(1000);
    expect(result.summary.ttftSlowest).toBe(60_000);
    expect(result.summary.tpsSamples).toBe(6);
    expect(result.summary.tpsAvg).toBe(175);
    expect(result.summary.tpsSlowest).toBe(0.4);
    expect(result.models[0]?.ttftAvg).toBe(1000);
    expect(result.models[0]?.tpsAvg).toBe(175);
    expect(result.buckets[0]?.ttftAvg).toBe(1000);
    expect(result.buckets[0]?.tpsAvg).toBe(175);
  });

  it('keeps all-local records when grouping by multi-day buckets', () => {
    const old = record({ startedAt: Date.UTC(2026, 6, 1, 9, 0, 0) });
    const recent = record({ key: 'wrk_test:req_2', id: 'req_2', startedAt: Date.UTC(2026, 9, 18, 9, 0, 0) });
    const result = aggregateRecords(
      [old, recent],
      { model: '', provider: '', userKey: '' },
      0,
      Date.UTC(2026, 9, 19, 0, 0, 0),
      7 * 24 * 60 * 60 * 1000,
    );
    expect(result.buckets.reduce((sum, bucket) => sum + bucket.requests, 0)).toBe(2);
    expect(result.buckets[0]?.start).toBeLessThanOrEqual(old.startedAt);
  });

  it('computes chart averages from populated buckets and token rate from the selected span', () => {
    const first = record();
    const second = record({
      key: 'wrk_test:req_2',
      id: 'req_2',
      startedAt: first.startedAt + 60 * 60 * 1000,
      finishedAt: first.startedAt + 60 * 60 * 1000 + 4300,
      durationMs: 4300,
      timeToFirstTokenMs: 1200,
      firstTokenAt: first.startedAt + 60 * 60 * 1000 + 1200,
      lastTokenAt: first.startedAt + 60 * 60 * 1000 + 4200,
      model: 'model-b',
      outputTokens: 200,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cacheWrite1hTokens: 0,
    });
    const from = first.startedAt;
    const to = first.startedAt + 2 * 60 * 60 * 1000;
    const result = aggregateRecords([first, second], { model: '', provider: '', userKey: '' }, from, to, 60 * 60 * 1000);
    expect(result.buckets).toHaveLength(2);
    expect(result.buckets.every((bucket) => bucket.end > bucket.start)).toBe(true);
    expect(averageBucketMetric(result.buckets, (bucket) => bucket.cacheHitRate)).toBeCloseTo(0.35);
    expect(averageBucketMetric(result.buckets, (bucket) => bucket.ttftAvg)).toBe(1000);
    expect(averageBucketMetric(result.buckets, (bucket) => bucket.tpsAvg)).toBeCloseTo((100 + 200 / 3) / 2);
    expect(tokenRateForRange(result.buckets, from, to)).toEqual({ value: 800, unit: 'h' });
    expect(tokenRateForRange(result.buckets, from, from + 25 * 60 * 60 * 1000)?.unit).toBe('d');
    expect(tokenRateForRange([], from, to)).toBeNull();
  });

  it('excludes empty buckets from arithmetic averages', () => {
    const first = record();
    const result = aggregateRecords(
      [first],
      { model: '', provider: '', userKey: '' },
      first.startedAt,
      first.startedAt + 2 * 60 * 60 * 1000,
      60 * 60 * 1000,
    );
    expect(result.buckets.some((bucket) => bucket.cacheHitRate === null)).toBe(true);
    expect(averageBucketMetric(result.buckets, (bucket) => bucket.cacheHitRate)).toBeCloseTo(0.7);
    const empty = aggregateRecords([], { model: '', provider: '', userKey: '' }, first.startedAt, first.startedAt + 60 * 60 * 1000, 60 * 60 * 1000);
    expect(tokenRateForRange(empty.buckets, first.startedAt, first.startedAt + 60 * 60 * 1000)).toBeNull();
    expect(empty.summary.ttftAvg).toBeNull();
    expect(empty.summary.ttftSlowest).toBeNull();
    expect(empty.summary.tpsAvg).toBeNull();
    expect(empty.summary.tpsSlowest).toBeNull();
  });
  it('applies model, provider, and user filters', () => {
    const a = record();
    const b = record({ key: 'wrk_test:req_2', id: 'req_2', model: 'model-b', provider: 'other', userID: 'user_2' });
    const byModel = aggregateRecords([a, b], { model: 'model-b', provider: '', userKey: '' }, a.startedAt - 1, a.startedAt + 1);
    expect(byModel.records).toHaveLength(1);
    const byUser = aggregateRecords([a, b], { model: '', provider: '', userKey: 'user:user_1' }, a.startedAt - 1, a.startedAt + 1);
    expect(byUser.records[0]?.id).toBe('req_1');
    const options = filterOptions([a, b]);
    expect(options.models).toEqual(['model-a', 'model-b']);
    expect(options.providers).toEqual(['opencode', 'other']);
    expect(options.users).toHaveLength(2);
  });
});

describe('record normalization', () => {
  it('normalizes API request fields and missing counters', () => {
    const normalized = normalizeRawRequest({
      id: 'req_9',
      requestID: 'request-9',
      startedAt: 1_700_000_000_000,
      outcome: 'succeeded',
      stream: true,
      model: 'model-x',
      timeToFirstTokenMs: 500,
      inputTokens: 10,
      outputTokens: 20,
      cost: 0.001,
    }, 'wrk_test');
    expect(normalized?.cacheReadTokens).toBe(0);
    expect(normalized?.cacheWriteTokens).toBe(0);
    expect(normalized?.costUsd).toBe(0.001);
    expect(normalized?.key).toBe('wrk_test:req_9');
  });

  it('converts legacy microcent costs and cache write fields', () => {
    const normalized = normalizeLegacyUsage({
      id: 'old_1',
      timeCreated: '2026-07-01T00:00:00.000Z',
      model: 'legacy-model',
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 200,
      cacheWrite5mTokens: 30,
      cacheWrite1hTokens: 20,
      cost: 12_000_000,
    }, 'wrk_test');
    expect(normalized?.legacy).toBe(true);
    expect(normalized?.cacheWriteTokens).toBe(30);
    expect(normalized?.cacheWrite1hTokens).toBe(20);
    expect(normalized?.costUsd).toBeCloseTo(0.12);
  });
});



