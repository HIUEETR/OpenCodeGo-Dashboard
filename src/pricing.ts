import { getMeta, putMeta } from './storage';
import type {
  CostBreakdown,
  GoPlan,
  GoPricingCache,
  GoPricingTier,
  GoQuotaLimits,
  ModelSummary,
  RequestRecord,
} from './types';

export const GO_PRICING_URL = 'https://opencode.ai/v2/docs/console/go/';
export const GO_PRICING_CACHE_KEY = 'pricing:opencode-go';
export const GO_PRICING_SCHEMA_VERSION = 2;
export const GO_PRICING_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const TOKENS_PER_PRICE_UNIT = 1_000_000;

export interface PricingLoadResult {
  pricing?: GoPricingCache;
  refreshed: boolean;
  error?: string;
}

export interface GoPricingParseResult {
  tiers: GoPricingTier[];
  quotaLimits: GoQuotaLimits;
}

function normalized(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function tableHeaders(table: HTMLTableElement): string[] {
  return [...table.querySelectorAll('thead th')].map((cell) => normalized(cell.textContent ?? ''));
}

function isPricingTable(table: HTMLTableElement): boolean {
  const headers = tableHeaders(table);
  return headers.includes('model')
    && headers.includes('input')
    && headers.includes('output')
    && headers.includes('cached read')
    && headers.includes('cached write')
    && headers.includes('monthly limit');
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

function parseMonthlyLimit(cell: HTMLTableCellElement): number | null {
  const strong = [...cell.querySelectorAll('strong')].at(-1)?.textContent ?? cell.textContent ?? '';
  if (/unlimited|free/i.test(strong)) return null;
  return parsePrice(strong);
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

function emptyQuotaLimits(): GoQuotaLimits {
  return { go: {}, 'go-plus': {} };
}

export function parseGoPricingHtml(html: string): GoPricingParseResult {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const tables = [...document.querySelectorAll('table')] as HTMLTableElement[];
  const pricingTables = tables.filter(isPricingTable);
  const endpointTable = tables.find((table) => {
    const headers = tableHeaders(table);
    return headers.includes('model') && headers.includes('model id');
  });
  if (!pricingTables.length || !endpointTable) {
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

  const planTables = new Map<GoPlan, HTMLTableElement>();
  for (const panel of [...document.querySelectorAll<HTMLElement>('[data-plan-panel]')]) {
    const plan = panel.dataset.planPanel;
    if (plan !== 'go' && plan !== 'go-plus') continue;
    const table = [...panel.querySelectorAll('table')].find((candidate) => isPricingTable(candidate as HTMLTableElement));
    if (table) planTables.set(plan, table as HTMLTableElement);
  }
  const remaining = pricingTables.filter((table) => ![...planTables.values()].includes(table));
  if (!planTables.has('go') && remaining.length) planTables.set('go', remaining.shift()!);
  if (!planTables.has('go-plus') && remaining.length) planTables.set('go-plus', remaining.shift()!);

  const quotaLimits = emptyQuotaLimits();
  const tiers: GoPricingTier[] = [];
  const seenTiers = new Set<string>();
  for (const [plan, pricingTable] of planTables) {
    for (const row of [...pricingTable.querySelectorAll('tbody tr')]) {
      const cells = [...row.querySelectorAll('td')] as HTMLTableCellElement[];
      if (cells.length < 6) continue;
      const rawName = (cells[0].textContent ?? '').replace(/\s+/g, ' ').trim();
      const marker = parseContextMarker(rawName);
      const modelID = modelIDs.get(normalized(marker.displayName));
      if (!modelID) continue;
      quotaLimits[plan][modelID] = parseMonthlyLimit(cells[5]);

      if (plan !== 'go') continue;
      const input = parsePrice(cells[1].textContent ?? '');
      const output = parsePrice(cells[2].textContent ?? '');
      if (input === null || output === null) continue;
      const tier: GoPricingTier = {
        modelID,
        displayName: marker.displayName,
        input,
        output,
        cacheRead: parsePrice(cells[3].textContent ?? ''),
        cacheWrite: parsePrice(cells[4].textContent ?? ''),
        ...(marker.maxContextTokens === undefined ? {} : { maxContextTokens: marker.maxContextTokens }),
        ...(marker.minContextTokens === undefined ? {} : { minContextTokens: marker.minContextTokens }),
        ...(marker.period === undefined ? {} : { period: marker.period }),
      };
      const key = [
        tier.modelID,
        tier.period ?? '',
        tier.minContextTokens ?? '',
        tier.maxContextTokens ?? '',
        tier.input,
        tier.output,
      ].join('|');
      if (!seenTiers.has(key)) {
        seenTiers.add(key);
        tiers.push(tier);
      }
    }
  }

  if (!tiers.length) throw new Error('No valid Go pricing rows were parsed.');
  return { tiers, quotaLimits };
}

export function isGoPricingCacheFresh(cache: GoPricingCache | undefined, now = Date.now()): boolean {
  return Boolean(
    cache
    && cache.schemaVersion === GO_PRICING_SCHEMA_VERSION
    && cache.tiers.length > 0
    && cache.quotaLimits
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
    const parsed = parseGoPricingHtml(await response.text());
    const pricing: GoPricingCache = {
      fetchedAt: now,
      source: GO_PRICING_URL,
      schemaVersion: GO_PRICING_SCHEMA_VERSION,
      tiers: parsed.tiers,
      quotaLimits: parsed.quotaLimits,
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

export function quotaLimitsForModel(
  pricing: GoPricingCache | undefined,
  plan: GoPlan,
  modelID: string,
): number | null | undefined {
  if (!pricing) return undefined;
  const id = normalizeGoModelID(modelID);
  const limits = pricing.quotaLimits?.[plan];
  if (!limits || !Object.prototype.hasOwnProperty.call(limits, id)) return undefined;
  return limits[id];
}

export function quotaUsdForRecord(record: RequestRecord, tier: GoPricingTier | undefined): number | null {
  if (!tier) return null;
  const cacheWriteTokens = record.cacheWriteTokens + record.cacheWrite1hTokens;
  return (
    record.inputTokens * tier.input / TOKENS_PER_PRICE_UNIT
    + record.outputTokens * tier.output / TOKENS_PER_PRICE_UNIT
    + record.cacheReadTokens * (tier.cacheRead ?? 0) / TOKENS_PER_PRICE_UNIT
    + cacheWriteTokens * (tier.cacheWrite ?? 0) / TOKENS_PER_PRICE_UNIT
  );
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
