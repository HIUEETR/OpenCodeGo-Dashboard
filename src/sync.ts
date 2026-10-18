import { listRequestLogs, ApiError } from './api';
import {
  DEFAULT_PAGE_SIZE,
  FALLBACK_PAGE_SIZES,
  MAX_SYNC_PAGES,
  PAGE_DELAY_MS,
  RETENTION_DAYS,
} from './constants';
import { incrementalSince } from './migration';
import { normalizeRawRequest } from './records';
import { getLatestStartedAt, getRecordKeys, getSyncState, putRecords, updateSyncState } from './storage';
import type { RequestLogPage, RequestRecord, SyncProgress, SyncResult, SyncState } from './types';

export function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal?.reason ?? abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(signal?.reason ?? abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && ['rate-limit', 'server', 'network'].includes(error.kind);
}

async function retrying<T>(operation: () => Promise<T>, signal?: AbortSignal, maxRetries = 4): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? abortError();
    try {
      return await operation();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      lastError = error;
      if (!isRetryable(error) || attempt >= maxRetries) throw error;
      const retryAfter = error instanceof ApiError ? error.retryAfterMs : undefined;
      const delay = retryAfter ?? Math.round(1000 * 2 ** attempt * (1 + Math.random() * 0.3));
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

interface PageRunResult {
  complete: boolean;
  cacheHit: boolean;
  pages: number;
  fetched: number;
  added: number;
  records: RequestRecord[];
  lastStartedAt?: number;
  retentionDays: number;
}

async function runPages(
  workspaceID: string,
  since: number,
  pageSize: number,
  knownKeys: Set<string>,
  stopWhenCached: boolean,
  signal: AbortSignal | undefined,
  onProgress?: (progress: SyncProgress) => void,
): Promise<PageRunResult> {
  let cursor: string | undefined;
  let until: number | undefined;
  let pages = 0;
  let fetched = 0;
  let added = 0;
  let retentionDays = RETENTION_DAYS;
  let lastStartedAt: number | undefined;
  const collected: RequestRecord[] = [];
  const usedCursors = new Set<string>();

  for (; pages < MAX_SYNC_PAGES; pages += 1) {
    if (signal?.aborted) throw signal.reason ?? abortError();
    if (pages > 0) await sleep(PAGE_DELAY_MS, signal);
    const page: RequestLogPage = await retrying(
      () => listRequestLogs(workspaceID, { since, until, cursor, limit: pageSize }, signal),
      signal,
    );
    retentionDays = page.retentionDays || retentionDays;
    if (page.until !== undefined) until = page.until;
    const records = page.items
      .map((item) => normalizeRawRequest(item, workspaceID))
      .filter((item): item is RequestRecord => item !== null);
    if (records.length !== page.items.length) {
      throw new ApiError('contract', 'Request log page contained records without a valid id or startedAt field.');
    }
    if (records.some((record) => record.category !== 'inference')) {
      throw new ApiError('contract', 'Request log page returned non-inference records despite the inference filter.');
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
      phase: 'paging',
      page: pages + 1,
      fetched,
      saved: newKeys.size,
      message: nextCursor ? undefined : 'complete',
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
        retentionDays,
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
        retentionDays,
      };
    }
    if (usedCursors.has(nextCursor)) {
      throw new ApiError('contract', 'The request-log pagination cursor repeated; sync stopped to prevent an infinite loop.');
    }
    usedCursors.add(nextCursor);
    cursor = nextCursor;
  }
  throw new ApiError('server', `Sync stopped after ${MAX_SYNC_PAGES} pages. Narrow the range or retry.`);
}

function failedState(current: SyncState | undefined, workspaceID: string, now: number, message: string): SyncState {
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
    lastError: message,
  };
}
function mergeState(
  previous: SyncState | undefined,
  workspaceID: string,
  since: number,
  now: number,
  result: PageRunResult,
  full: boolean,
): SyncState {
  const previousSuccess = previous?.lastSuccessfulSyncAt;
  const missedWindow = previousSuccess !== undefined && now - previousSuccess > RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return {
    workspaceID,
    retentionDays: result.retentionDays || RETENTION_DAYS,
    coverageStart: previous?.coverageStart === undefined ? since : Math.min(previous.coverageStart, since),
    coverageEnd: now,
    latestStartedAt: Math.max(previous?.latestStartedAt ?? 0, result.lastStartedAt ?? 0) || undefined,
    lastSyncAttemptAt: now,
    lastSuccessfulSyncAt: now,
    backfillComplete: Boolean(previous?.backfillComplete || full),
    gapDetected: Boolean(previous?.gapDetected || missedWindow),
    legacyImportedAt: previous?.legacyImportedAt,
    lastError: undefined,
  };
}

export async function syncWorkspace(options: {
  workspaceID: string;
  forceFull?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: SyncProgress) => void;
}): Promise<SyncResult> {
  const { workspaceID, forceFull = false, signal, onProgress } = options;
  const now = Date.now();
  const previous = await getSyncState(workspaceID);
  const latestInDb = await getLatestStartedAt(workspaceID);
  const latest = Math.max(previous?.latestStartedAt ?? 0, latestInDb ?? 0);
  const full = forceFull || !previous?.backfillComplete || latest === 0;
  const retentionStart = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const since = full ? retentionStart : incrementalSince(previous, now, latest || undefined);
  const knownKeys = new Set(await getRecordKeys(workspaceID, since));
  onProgress?.({ phase: 'starting', page: 0, fetched: 0, saved: 0 });

  try {
    let result: PageRunResult | undefined;
    let lastError: unknown;
    let cursorRestarted = false;
    const sizes: readonly number[] = full ? FALLBACK_PAGE_SIZES : [DEFAULT_PAGE_SIZE, ...FALLBACK_PAGE_SIZES.filter((size) => size !== DEFAULT_PAGE_SIZE)];
    for (const size of sizes) {
      try {
        try {
          result = await runPages(workspaceID, since, size, knownKeys, !full, signal, onProgress);
        } catch (error) {
          if (error instanceof ApiError && error.kind === 'cursor' && !cursorRestarted) {
            cursorRestarted = true;
            onProgress?.({ phase: 'starting', page: 0, fetched: 0, saved: 0, message: 'cursor restart' });
            result = await runPages(workspaceID, since, size, knownKeys, !full, signal, onProgress);
          } else {
            throw error;
          }
        }
        break;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        if (error instanceof Error && error.name === 'AbortError') throw error;
        if (error instanceof ApiError && error.kind === 'bad-request') {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    if (!result) throw lastError ?? new ApiError('bad-request', 'The request log API rejected all supported page sizes.');

    await updateSyncState(workspaceID, (current) => mergeState(current, workspaceID, since, now, result, full));
    onProgress?.({ phase: 'complete', page: result.pages, fetched: result.fetched, saved: result.added });
    return {
      complete: result.complete,
      stopped: false,
      cacheHit: result.cacheHit,
      pages: result.pages,
      fetched: result.fetched,
      added: result.added,
      lastStartedAt: result.lastStartedAt,
      retentionDays: result.retentionDays,
    };
  } catch (error) {
    if (isAbort(error)) {
      await updateSyncState(workspaceID, (current) => failedState(current, workspaceID, now, 'Sync stopped by user.'));
      onProgress?.({ phase: 'stopped', page: 0, fetched: 0, saved: 0 });
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    await updateSyncState(workspaceID, (current) => failedState(current, workspaceID, now, message));
    onProgress?.({ phase: 'error', page: 0, fetched: 0, saved: 0, message });
    throw error;
  }
}

export async function persistCapturedPage(workspaceID: string, items: Record<string, unknown>[]): Promise<number> {
  const records = items
    .map((item) => normalizeRawRequest(item, workspaceID))
    .filter((item): item is RequestRecord => item !== null && item.category === 'inference');
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
      lastError: previous?.lastError,
    };
  });
  return records.length;
}








