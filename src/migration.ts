import { RETENTION_DAYS, OVERLAP_MS, INCREMENTAL_LOOKBACK_MS } from './constants';
import { normalizeLegacyUsage } from './records';
import { putRecords, readLegacyUsage, getSyncState, updateSyncState } from './storage';
import type { RequestRecord, SyncState } from './types';

export async function migrateLegacyUsage(workspaceID: string, now = Date.now()): Promise<number> {
  const state = await getSyncState(workspaceID);
  if (state?.legacyImportedAt) return 0;
  const raw = await readLegacyUsage(workspaceID);
  const cutoff = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const records = raw
    .map((item) => normalizeLegacyUsage(item, workspaceID))
    .filter((item): item is RequestRecord => item !== null && item.startedAt < cutoff);
  await putRecords(records);
  await updateSyncState(workspaceID, (current) => {
    const previous = current ?? state;
    return {
      workspaceID,
      retentionDays: previous?.retentionDays ?? RETENTION_DAYS,
      coverageStart: records.length ? Math.min(previous?.coverageStart ?? now, ...records.map((record) => record.startedAt)) : previous?.coverageStart,
      coverageEnd: previous?.coverageEnd,
      latestStartedAt: records.length ? Math.max(previous?.latestStartedAt ?? 0, ...records.map((record) => record.startedAt)) : previous?.latestStartedAt,
      lastSyncAttemptAt: previous?.lastSyncAttemptAt,
      lastSuccessfulSyncAt: previous?.lastSuccessfulSyncAt,
      backfillComplete: previous?.backfillComplete ?? false,
      gapDetected: previous?.gapDetected ?? false,
      legacyImportedAt: now,
      lastError: previous?.lastError,
    };
  });
  return records.length;
}

export function incrementalSince(
  state: SyncState | undefined,
  now = Date.now(),
  latestOverride?: number,
): number {
  const retentionStart = now - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const latest = latestOverride ?? state?.latestStartedAt;
  if (latest === undefined) return retentionStart;
  const syncStart = (state?.lastSuccessfulSyncAt ?? now) - INCREMENTAL_LOOKBACK_MS;
  return Math.max(retentionStart, Math.min(latest - OVERLAP_MS, syncStart));
}



