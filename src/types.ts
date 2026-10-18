export type Language = 'zh' | 'en';
export type Outcome = 'succeeded' | 'failed' | 'rejected' | 'cancelled';
export type RangePreset = '1h' | '24h' | '7d' | '30d' | 'all' | 'custom';
export type TabKey = 'overview' | 'charts' | 'requests' | 'data';

export interface Workspace {
  id: string;
  name: string;
  role?: string;
  memberCount?: number;
  avatarUrl?: string | null;
}

export interface RawRequestLog {
  id?: unknown;
  requestID?: unknown;
  workspaceID?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  durationMs?: unknown;
  outcome?: unknown;
  category?: unknown;
  protocol?: unknown;
  product?: unknown;
  service?: unknown;
  path?: unknown;
  method?: unknown;
  stream?: unknown;
  sessionID?: unknown;
  userID?: unknown;
  serviceAccountID?: unknown;
  serviceAPIKeyID?: unknown;
  requestedModel?: unknown;
  model?: unknown;
  provider?: unknown;
  connectionID?: unknown;
  statusCode?: unknown;
  errorCode?: unknown;
  errorMessage?: unknown;
  timeToFirstTokenMs?: unknown;
  inputTokens?: unknown;
  outputTokens?: unknown;
  reasoningTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  cacheWrite1hTokens?: unknown;
  firstTokenAt?: unknown;
  lastTokenAt?: unknown;
  cost?: unknown;
  providerCost?: unknown;
  metadata?: unknown;
  [key: string]: unknown;
}

export interface RequestRecord {
  key: string;
  workspaceID: string;
  id: string;
  requestID: string;
  startedAt: number;
  finishedAt?: number;
  durationMs: number;
  outcome: Outcome;
  category: string;
  protocol: string;
  product: string;
  service: string;
  path: string;
  method: string;
  stream: boolean;
  sessionID: string;
  userID: string;
  serviceAccountID: string;
  serviceAPIKeyID: string;
  requestedModel: string;
  model: string;
  provider: string;
  statusCode?: number;
  errorCode: string;
  errorMessage: string;
  timeToFirstTokenMs?: number;
  firstTokenAt?: number;
  lastTokenAt?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheWrite1hTokens: number;
  costUsd: number;
  providerCostUsd: number;
  legacy: boolean;
}

export interface UsagePrincipal {
  userId: string;
  serviceUserId: string;
  principalType: string;
  email: string;
  name: string;
  avatarUrl?: string | null;
}

export interface RequestLogPage {
  items: RawRequestLog[];
  nextCursor: string | null;
  until?: number;
  retentionDays: number;
}

export interface RequestLogQuery {
  since: number;
  until?: number;
  cursor?: string;
  limit?: number;
  outcome?: Outcome;
  model?: string;
  provider?: string;
  userID?: string;
  serviceAccountID?: string;
  product?: string;
  protocol?: string;
}

export interface SyncState {
  workspaceID: string;
  retentionDays: number;
  coverageStart?: number;
  coverageEnd?: number;
  latestStartedAt?: number;
  lastSyncAttemptAt?: number;
  lastSuccessfulSyncAt?: number;
  backfillComplete: boolean;
  gapDetected: boolean;
  legacyImportedAt?: number;
  lastError?: string;
}

export interface AnalyticsFilters {
  model: string;
  provider: string;
  userKey: string;
}

export interface TimeRange {
  preset: RangePreset;
  from: number;
  to: number;
  label: string;
  bucketMs: number;
}

export interface SummaryMetrics {
  requests: number;
  succeeded: number;
  failed: number;
  successRate: number | null;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cacheHitRate: number | null;
  costUsd: number;
  ttftAvg: number | null;
  ttftSlowest: number | null;
  ttftSamples: number;
  tpsAvg: number | null;
  tpsSlowest: number | null;
  tpsSamples: number;
}

export interface ModelSummary extends SummaryMetrics {
  model: string;
  provider: string;
}

export interface BucketPoint {
  start: number;
  end: number;
  requests: number;
  succeeded: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
  cacheHitRate: number | null;
  ttftAvg: number | null;
  ttftSlowest: number | null;
  ttftSamples: number;
  tpsAvg: number | null;
  tpsSlowest: number | null;
  tpsSamples: number;
}

export interface AnalyticsResult {
  records: RequestRecord[];
  summary: SummaryMetrics;
  models: ModelSummary[];
  buckets: BucketPoint[];
}

export interface SyncProgress {
  phase: 'starting' | 'paging' | 'saving' | 'complete' | 'stopped' | 'error';
  page: number;
  fetched: number;
  saved: number;
  message?: string;
}

export interface SyncResult {
  complete: boolean;
  stopped: boolean;
  cacheHit: boolean;
  pages: number;
  fetched: number;
  added: number;
  lastStartedAt?: number;
  retentionDays: number;
}

export interface GoPricingTier {
  modelID: string;
  displayName: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  maxContextTokens?: number;
  minContextTokens?: number;
  period?: 'peak' | 'off-peak';
}

export interface GoPricingCache {
  fetchedAt: number;
  source: string;
  schemaVersion: number;
  tiers: GoPricingTier[];
}

export interface CostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  estimated: boolean;
}

export interface CapturePage {
  workspaceID: string;
  page: RequestLogPage;
}

