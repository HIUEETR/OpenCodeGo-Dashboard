import { describe, expect, it } from 'vitest';
import {
  GO_PRICING_TTL_MS,
  estimateModelCostBreakdown,
  isGoPricingCacheFresh,
  pricingPeriodForTimestamp,
  quotaLimitsForModel,
  quotaUsdForRecord,
  selectPricingTier,
} from '../src/pricing';
import type { GoPricingTier, ModelSummary, RequestRecord } from '../src/types';

function record(overrides: Partial<RequestRecord> = {}): RequestRecord {
  const startedAt = Date.UTC(2026, 9, 19, 2, 0, 0);
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
    requestedModel: 'deepseek-v4.1-flash',
    model: 'deepseek-v4.1-flash',
    provider: 'opencode',
    errorCode: '',
    errorMessage: '',
    inputTokens: 1000,
    outputTokens: 100,
    reasoningTokens: 10,
    cacheReadTokens: 2000,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    costUsd: 1,
    providerCostUsd: 0.9,
    legacy: false,
    ...overrides,
  };
}

const peakTier: GoPricingTier = {
  modelID: 'deepseek-v4.1-flash',
  displayName: 'DeepSeek V4.1 Flash',
  input: 0.3,
  output: 1.2,
  cacheRead: 0.006,
  cacheWrite: null,
  period: 'peak',
};

const offPeakTier: GoPricingTier = {
  ...peakTier,
  input: 0.15,
  output: 0.6,
  cacheRead: 0.003,
  period: 'off-peak',
};

function model(overrides: Partial<ModelSummary> = {}): ModelSummary {
  return {
    model: 'deepseek-v4.1-flash',
    provider: 'opencode',
    requests: 1,
    succeeded: 1,
    failed: 0,
    successRate: 1,
    inputTokens: 1000,
    outputTokens: 100,
    reasoningTokens: 10,
    cacheReadTokens: 2000,
    cacheWriteTokens: 0,
    totalTokens: 3100,
    cacheHitRate: 2 / 3,
    costUsd: 1,
    ttftAvg: 500,
    ttftSlowest: 500,
    ttftSamples: 1,
    tpsAvg: 50,
    tpsSlowest: 50,
    tpsSamples: 1,
    ...overrides,
  };
}

describe('Go pricing', () => {
  it('classifies DeepSeek peak and off-peak UTC windows', () => {
    expect(pricingPeriodForTimestamp(Date.UTC(2026, 9, 19, 2, 0, 0))).toBe('peak');
    expect(pricingPeriodForTimestamp(Date.UTC(2026, 9, 19, 5, 0, 0))).toBe('off-peak');
    expect(pricingPeriodForTimestamp(Date.UTC(2026, 9, 18, 2, 0, 0))).toBe('off-peak');
  });

  it('selects peak and context tiers from request usage', () => {
    const tier = selectPricingTier([offPeakTier, peakTier], record());
    expect(tier?.period).toBe('peak');

    const low: GoPricingTier = { ...peakTier, maxContextTokens: 256_000 };
    const high: GoPricingTier = { ...peakTier, minContextTokens: 256_001 };
    expect(selectPricingTier([low, high], record())).toBe(low);
    expect(selectPricingTier([low, high], record({ inputTokens: 260_000 }))).toBe(high);
  });

  it('normalizes estimated category costs to the actual total cost', () => {
    const breakdown = estimateModelCostBreakdown([record()], model(), [offPeakTier, peakTier]);
    expect(breakdown).not.toBeNull();
    expect((breakdown?.input ?? 0) + (breakdown?.output ?? 0) + (breakdown?.cacheRead ?? 0) + (breakdown?.cacheWrite ?? 0)).toBeCloseTo(1);
    expect(breakdown?.input).toBeGreaterThan(breakdown?.output ?? 0);
    expect(breakdown?.total).toBe(1);
  });

  it('reads monthly quotas per plan and computes quota usage without cost normalization', () => {
    const pricing = {
      fetchedAt: 1,
      source: 'https://opencode.ai/v2/docs/console/go/',
      schemaVersion: 2,
      tiers: [offPeakTier, peakTier],
      quotaLimits: {
        go: { 'deepseek-v4.1-flash': 80, 'gpt-5.6-luna': 15 },
        'go-plus': { 'deepseek-v4.1-flash': 160, 'gpt-5.6-luna': 60 },
      },
    };
    expect(quotaLimitsForModel(pricing, 'go', 'deepseek-v4.1-flash')).toBe(80);
    expect(quotaLimitsForModel(pricing, 'go-plus', 'opencode-go/deepseek-v4.1-flash')).toBe(160);
    expect(quotaLimitsForModel(pricing, 'go', 'missing')).toBeUndefined();
    expect(quotaUsdForRecord(record(), peakTier)).toBeCloseTo(0.0003 + 0.00012 + 0.000012);
    expect(quotaUsdForRecord(record(), undefined)).toBeNull();
  });

  it('matches model IDs with the opencode-go prefix', () => {
    expect(selectPricingTier([peakTier], record({ model: 'opencode-go/deepseek-v4.1-flash' }))?.modelID).toBe('deepseek-v4.1-flash');
  });

  it('uses a three-day pricing cache window', () => {
    const cache = {
      fetchedAt: 1_000,
      source: 'https://opencode.ai/v2/docs/console/go/',
      schemaVersion: 2,
      tiers: [peakTier],
      quotaLimits: { go: { 'deepseek-v4.1-flash': 80 }, 'go-plus': { 'deepseek-v4.1-flash': 160 } },
    };
    expect(isGoPricingCacheFresh(cache, 1_000 + GO_PRICING_TTL_MS - 1)).toBe(true);
    expect(isGoPricingCacheFresh(cache, 1_000 + GO_PRICING_TTL_MS)).toBe(false);
  });
});
