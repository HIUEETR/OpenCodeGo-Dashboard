import { MICROCENTS_PER_DOLLAR } from './constants';
import type { Outcome, RawRequestLog, RequestRecord } from './types';

const OUTCOMES = new Set<Outcome>(['succeeded', 'failed', 'rejected', 'cancelled']);

export function finiteNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function optionalNonNegative(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = finiteNumber(value, NaN);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function toEpoch(value: unknown): number | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && String(numeric) === value.trim()) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeOutcome(value: unknown): Outcome {
  return typeof value === 'string' && OUTCOMES.has(value as Outcome) ? (value as Outcome) : 'failed';
}

function fallbackID(raw: RawRequestLog, startedAt: number): string {
  return [
    startedAt,
    text(raw.model ?? raw.requestedModel),
    finiteNumber(raw.inputTokens),
    finiteNumber(raw.outputTokens),
    finiteNumber(raw.cacheReadTokens),
    finiteNumber(raw.cost),
  ].join('|');
}

export function normalizeRawRequest(raw: RawRequestLog, workspaceID: string): RequestRecord | null {
  const startedAt = toEpoch(raw.startedAt);
  if (startedAt === undefined) return null;
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
    category: text(raw.category, 'inference'),
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
    model: text(raw.model) || text(raw.requestedModel) || 'unknown',
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
    legacy: false,
  };
}

export function normalizeLegacyUsage(raw: RawRequestLog, workspaceID: string): RequestRecord | null {
  const startedAt = toEpoch(raw.timeCreated ?? raw.startedAt);
  if (startedAt === undefined) return null;
  const idPart = text(raw.id) || fallbackID(raw, startedAt);
  const id = `legacy:${idPart}`;
  return {
    key: `${workspaceID}:${id}`,
    workspaceID,
    id,
    requestID: id,
    startedAt,
    durationMs: 0,
    outcome: 'succeeded',
    category: 'inference',
    protocol: '',
    product: '',
    service: '',
    path: '',
    method: '',
    stream: false,
    sessionID: '',
    userID: '',
    serviceAccountID: '',
    serviceAPIKeyID: '',
    requestedModel: text(raw.model),
    model: text(raw.model) || 'unknown',
    provider: text(raw.provider),
    errorCode: '',
    errorMessage: '',
    inputTokens: Math.max(0, finiteNumber(raw.inputTokens)),
    outputTokens: Math.max(0, finiteNumber(raw.outputTokens)),
    reasoningTokens: Math.max(0, finiteNumber(raw.reasoningTokens)),
    cacheReadTokens: Math.max(0, finiteNumber(raw.cacheReadTokens)),
    cacheWriteTokens: Math.max(0, finiteNumber(raw.cacheWrite5mTokens ?? raw.cacheWriteTokens)),
    cacheWrite1hTokens: Math.max(0, finiteNumber(raw.cacheWrite1hTokens)),
    costUsd: Math.max(0, finiteNumber(raw.cost)) / MICROCENTS_PER_DOLLAR,
    providerCostUsd: 0,
    legacy: true,
  };
}

export function getWorkspaceID(pathname = location.pathname): string | null {
  const match = pathname.match(/^\/console\/(wrk_[^/?#]+)/);
  return match?.[1] ?? null;
}

