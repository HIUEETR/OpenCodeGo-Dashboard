import { describe, expect, it } from 'vitest';
import { buildQuotaForecast } from '../src/forecast';
import type { GoPricingCache, GoQuotaStatus, RequestRecord } from '../src/types';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  return {
    key: 'wrk_test:req_1',
    workspaceID: 'wrk_test',
    id: 'req_1',
    requestID: 'req_1',
    startedAt: NOW - HOUR,
    finishedAt: NOW - HOUR + 4000,
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
    requestedModel: 'deepseek-v4.1-flash',
    model: 'deepseek-v4.1-flash',
    provider: 'opencode',
    errorCode: '',
    errorMessage: '',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    reasoningTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    costUsd: 1.5,
    providerCostUsd: 0,
    legacy: false,
    ...overrides,
  };
}

const pricing: GoPricingCache = {
  fetchedAt: NOW - HOUR,
  source: 'https://opencode.ai/v2/docs/console/go/',
  schemaVersion: 2,
  tiers: [
    {
      modelID: 'deepseek-v4.1-flash',
      displayName: 'DeepSeek V4.1 Flash',
      input: 0.3,
      output: 1.2,
      cacheRead: 0.006,
      cacheWrite: null,
    },
    {
      modelID: 'gpt-5.6-luna',
      displayName: 'GPT 5.6 Luna',
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    },
  ],
  quotaLimits: {
    go: { 'deepseek-v4.1-flash': 80, 'gpt-5.6-luna': 15 },
    'go-plus': { 'deepseek-v4.1-flash': 160, 'gpt-5.6-luna': 60 },
  },
};

const status: GoQuotaStatus = {
  active: true,
  product: 'go',
  accessStartsAt: NOW - 10 * DAY,
  accessEndsAt: NOW + 20 * DAY,
  cancelAtPeriodEnd: false,
  fiveHour: { startsAt: NOW - 2 * HOUR, resetsAt: NOW + 3 * HOUR, limitMicroCents: 1_200_000_000, usedMicroCents: 400_000_000 },
  week: { startsAt: NOW - 2 * DAY, resetsAt: NOW + 5 * DAY, limitMicroCents: 3_000_000_000, usedMicroCents: 1_000_000_000 },
  month: { resetsAt: NOW + 20 * DAY, limitMicroCents: 6_000_000_000, usedMicroCents: 2_000_000_000 },
  fetchedAt: NOW,
};

describe('quota forecast', () => {
  it('derives model limits from monthly quota and keeps independent model rows', () => {
    const result = buildQuotaForecast({
      records: [
        record({ startedAt: NOW - 30 * 60 * 1000 }),
        record({ key: 'wrk_test:req_2', id: 'req_2', startedAt: NOW - 10 * 60 * 1000 }),
        record({ key: 'wrk_test:req_3', id: 'req_3', model: 'gpt-5.6-luna', requestedModel: 'gpt-5.6-luna', startedAt: NOW - 20 * 60 * 1000, inputTokens: 500_000 }),
      ],
      pricing,
      filters: { model: '', provider: '', userKey: '' },
      status,
      now: NOW,
    });

    const deepseek = result.models.find((model) => model.model === 'deepseek-v4.1-flash');
    const gpt = result.models.find((model) => model.model === 'gpt-5.6-luna');
    expect(deepseek?.monthlyLimitUsd).toBe(80);
    expect(deepseek?.windowLimits).toEqual({ fiveHour: 16, week: 40, month: 80 });
    expect(gpt?.monthlyLimitUsd).toBe(15);
    expect(gpt?.windowLimits).toEqual({ fiveHour: 3, week: 7.5, month: 15 });
    expect(result.officialStatus).toBe(true);
    expect(deepseek?.windows.next24h.limitUsd).toBe(80);
    expect(deepseek?.windows.fiveHour.p10Usd ?? 0).toBeLessThanOrEqual(deepseek?.windows.fiveHour.p50Usd ?? 0);
    expect(deepseek?.windows.fiveHour.p50Usd ?? 0).toBeLessThanOrEqual(deepseek?.windows.fiveHour.p90Usd ?? 0);
    expect(result.riskiest?.model).toBe('gpt-5.6-luna');
  });

  it('marks a missing official status as an estimate and does not treat unknown pricing as unlimited', () => {
    const result = buildQuotaForecast({
      records: [record({ startedAt: NOW - 30 * HOUR })],
      pricing: { ...pricing, quotaLimits: { go: {}, 'go-plus': {} } },
      filters: { model: '', provider: '', userKey: '' },
      now: NOW,
    });
    const model = result.models[0];
    expect(result.officialStatus).toBe(false);
    expect(model.limitKnown).toBe(false);
    expect(model.monthlyLimitUsd).toBeNull();
    expect(model.windows.fiveHour.limitUsd).toBeNull();
    expect(model.confidenceReasons).toContain('forecast.reasonNoStatus');
    expect(model.confidence).not.toBe('high');
  });

  it('supports free and unlimited quotas without inventing a percentage', () => {
    const result = buildQuotaForecast({
      records: [record({ startedAt: NOW - 30 * 60 * 1000 })],
      pricing: { ...pricing, quotaLimits: { go: { 'deepseek-v4.1-flash': null }, 'go-plus': {} } },
      filters: { model: '', provider: '', userKey: '' },
      status,
      now: NOW,
    });
    const model = result.models[0];
    expect(model.limitKnown).toBe(true);
    expect(model.monthlyLimitUsd).toBeNull();
    expect(model.windows.fiveHour.p50Ratio).toBeNull();
    expect(model.windows.next24h.p50Usd).toBeGreaterThan(0);
  });
});
