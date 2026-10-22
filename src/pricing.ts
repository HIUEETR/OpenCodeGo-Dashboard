import { getMeta, putMeta } from './storage';
import type {
  CostBreakdown,
  GoPricingCache,
  GoPricingTier,
  ModelSummary,
  RequestRecord,
} from './types';

export const GO_PRICING_URL = 'https://opencode.ai/v2/docs/console/go/';
export const GO_PRICING_CACHE_KEY = 'pricing:opencode-go';
export const GO_PRICING_SCHEMA_VERSION = 1;
export const GO_PRICING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const TOKENS_PER_PRICE_UNIT = 1_000_000;

export interface PricingLoadResult {
  pricing?: GoPricingCache;
  refreshed: boolean;
  error?: string;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tableHeaders(table: HTMLTableElement): string[] {
  return [...table.querySelectorAll('thead th')].map((cell) => normalized(cell.textContent ?? ''));
}

function parsePrice(value: string): number | null {
  const text = value.replace(/,/g, '').trim();
  if (!text || text === '-') return null;
  if (/^free$/i.test(text)) return 0;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const amount = Number(match[0]);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

function parseContextMarker(label: string): {
  displayName: string;
  maxContextTokens?: number;
  minContextTokens?: number;
  period?: 'peak' | 'off-peak';
} {
  let displayName = label;
  let maxContextTokens: number | undefined;
  let minContextTokens: number | undefined;
  let period: 'peak' | 'off-peak' | undefined;

  const upper = displayName.match(/\(\s*(?:≤|<=|<)\s*([\d.]+)K tokens\s*\)\s*$/i);
  if (upper) {
    maxContextTokens = Math.round(Number(upper[1]) * 1000);
    displayName = displayName.slice(0, upper.index).trim();
  } else {
    const lower = displayName.match(/\(\s*>\s*([\d.]+)K tokens\s*\)\s*$/i);
    if (lower) {
      minContextTokens = Math.round(Number(lower[1]) * 1000) + 1;
      displayName = displayName.slice(0, lower.index).trim();
    }
  }

  const periodMatch = displayName.match(/\((Off-Peak|Peak)\)\s*$/i);
  if (periodMatch) {
    period = periodMatch[1].toLowerCase() === 'peak' ? 'peak' : 'off-peak';
    displayName = displayName.slice(0, periodMatch.index).trim();
  }

  return { displayName, maxContextTokens, minContextTokens, period };
}

export function parseGoPricingHtml(html: string): GoPricingTier[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const tables = [...document.querySelectorAll('table')] as HTMLTableElement[];
  const pricingTable = tables.find((table) => {
    const headers = tableHeaders(table);
    return headers.includes('model')
      && headers.includes('input')
      && headers.includes('output')
      && headers.includes('cached read')
      && headers.includes('cached write');
  });
  const endpointTable = tables.find((table) => {
    const headers = tableHeaders(table);
    return headers.includes('model') && headers.includes('model id');
  });
  if (!pricingTable || !endpointTable) {
    throw new Error('Go pricing tables were not found.');
  }

  const modelIDs = new Map<string, string>();
  for (const row of [...endpointTable.querySelectorAll('tbody tr')]) {
    const cells = [...row.querySelectorAll('td')];
    if (cells.length < 2) continue;
    const name = normalized(cells[0].textContent ?? '');
    const modelID = (cells[1].textContent ?? '').trim();
    if (name && modelID) modelIDs.set(name, modelID);
  }

  const tiers: GoPricingTier[] = [];
  for (const row of [...pricingTable.querySelectorAll('tbody tr')]) {
    const cells = [...row.querySelectorAll('td')];
    if (cells.length < 5) continue;
    const rawName = (cells[0].textContent ?? '').replace(/\s+/g, ' ').trim();
    const marker = parseContextMarker(rawName);
    const modelID = modelIDs.get(normalized(marker.displayName));
    if (!modelID) continue;
    const input = parsePrice(cells[1].textContent ?? '');
    const output = parsePrice(cells[2].textContent ?? '');
    if (input === null || output === null) continue;
    tiers.push({
      modelID,
      displayName: marker.displayName,
      input,
      output,
      cacheRead: parsePrice(cells[3].textContent ?? ''),
      cacheWrite: parsePrice(cells[4].textContent ?? ''),
      ...(marker.maxContextTokens === undefined ? {} : { maxContextTokens: marker.maxContextTokens }),
      ...(marker.minContextTokens === undefined ? {} : { minContextTokens: marker.minContextTokens }),
      ...(marker.period === undefined ? {} : { period: marker.period }),
    });
  }

  if (!tiers.length) throw new Error('No valid Go pricing rows were parsed.');
  return tiers;
}

export function isGoPricingCacheFresh(cache: GoPricingCache | undefined, now = Date.now()): boolean {
  return Boolean(
    cache
    && cache.schemaVersion === GO_PRICING_SCHEMA_VERSION
    && cache.tiers.length > 0
    && now - cache.fetchedAt >= 0
    && now - cache.fetchedAt < GO_PRICING_TTL_MS,
  );
}

export async function loadGoPricing(now = Date.now()): Promise<PricingLoadResult> {
  const cached = await getMeta<GoPricingCache>(GO_PRICING_CACHE_KEY);
  if (isGoPricingCacheFresh(cached, now)) {
    return { pricing: cached, refreshed: false };
  }
  try {
    const response = await fetch(GO_PRICING_URL, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'text/html' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const tiers = parseGoPricingHtml(await response.text());
    const pricing: GoPricingCache = {
      fetchedAt: now,
      source: GO_PRICING_URL,
      schemaVersion: GO_PRICING_SCHEMA_VERSION,
      tiers,
    };
    await putMeta(GO_PRICING_CACHE_KEY, pricing);
    return { pricing, refreshed: true };
  } catch (error) {
    return {
      pricing: cached,
      refreshed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function pricingPeriodForTimestamp(timestamp: number): 'peak' | 'off-peak' {
  const date = new Date(timestamp);
  const day = date.getUTCDay();
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  const weekday = day >= 1 && day <= 5;
  const peak = weekday && ((minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600));
  return peak ? 'peak' : 'off-peak';
}

export function normalizeGoModelID(value: string): string {
  return value.trim().toLowerCase().replace(/^opencode-go\//, '');
}

export function selectPricingTier(
  tiers: GoPricingTier[],
  record: RequestRecord,
): GoPricingTier | undefined {
  if (record.provider && !['opencode', 'opencode-go'].includes(record.provider.toLowerCase())) {
    return undefined;
  }
  const modelID = normalizeGoModelID(record.model || record.requestedModel);
  let candidates = tiers.filter((tier) => normalizeGoModelID(tier.modelID) === modelID);
  if (!candidates.length) return undefined;

  const period = pricingPeriodForTimestamp(record.startedAt);
  const periodCandidates = candidates.filter((tier) => tier.period !== undefined);
  if (periodCandidates.length) {
    candidates = periodCandidates.filter((tier) => tier.period === period);
  }
  if (!candidates.length) return undefined;

  const contextTokens = record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.cacheWrite1hTokens;
  const matching = candidates
    .filter((tier) => tier.minContextTokens === undefined || contextTokens >= tier.minContextTokens)
    .filter((tier) => tier.maxContextTokens === undefined || contextTokens <= tier.maxContextTokens);
  if (!matching.length) return undefined;
  return matching.sort((a, b) => (a.maxContextTokens ?? Number.MAX_SAFE_INTEGER) - (b.maxContextTokens ?? Number.MAX_SAFE_INTEGER))[0];
}

export function estimateModelCostBreakdown(
  records: RequestRecord[],
  model: ModelSummary,
  tiers: GoPricingTier[] | undefined,
): CostBreakdown | null {
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
    estimated: true,
  };
}
