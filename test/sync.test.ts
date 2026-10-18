import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, listRequestLogs } from '../src/api';
import { getLatestStartedAt, getRecordKeys, getSyncState, putRecords } from '../src/storage';
import { syncWorkspace } from '../src/sync';

vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return { ...actual, listRequestLogs: vi.fn() };
});

const stateBox = vi.hoisted(() => ({ current: undefined as any }));

vi.mock('../src/storage', () => ({
  getSyncState: vi.fn(),
  getLatestStartedAt: vi.fn(),
  getRecordKeys: vi.fn(),
  putRecords: vi.fn(async () => undefined),
  updateSyncState: vi.fn(async (_workspaceID: string, updater: (current: any) => any) => {
    stateBox.current = updater(stateBox.current);
    return stateBox.current;
  }),
}));

const mockedList = vi.mocked(listRequestLogs);
const mockedGetState = vi.mocked(getSyncState);
const mockedLatest = vi.mocked(getLatestStartedAt);
const mockedGetKeys = vi.mocked(getRecordKeys);
const mockedPutRecords = vi.mocked(putRecords);

function rawRecord(id: string, startedAt = Date.UTC(2026, 9, 18, 9, 0, 0)) {
  return {
    id,
    requestID: id,
    startedAt,
    outcome: 'succeeded',
    category: 'inference',
    stream: true,
    model: 'model-a',
    provider: 'opencode',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 30,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0,
    cost: 0.001,
  };
}

describe('request log synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateBox.current = undefined;
    mockedGetState.mockResolvedValue(undefined);
    mockedLatest.mockResolvedValue(undefined);
    mockedGetKeys.mockResolvedValue([]);
    vi.useRealTimers();
  });

  it('persists every page and carries the stable until cursor', async () => {
    mockedList
      .mockResolvedValueOnce({ items: [rawRecord('a')], nextCursor: 'next', until: 999, retentionDays: 30 })
      .mockResolvedValueOnce({ items: [rawRecord('b')], nextCursor: null, until: 999, retentionDays: 30 });

    const result = await syncWorkspace({ workspaceID: 'wrk_test' });

    expect(result.pages).toBe(2);
    expect(result.fetched).toBe(2);
    expect(result.added).toBe(2);
    expect(result.cacheHit).toBe(false);
    expect(mockedList).toHaveBeenCalledTimes(2);
    expect(mockedList.mock.calls[0]?.[1]).toMatchObject({ limit: 50 });
    expect(mockedList.mock.calls[1]?.[1]).toMatchObject({ cursor: 'next', until: 999, limit: 50 });
    expect(mockedPutRecords).toHaveBeenCalledTimes(2);
    expect(stateBox.current).toEqual(expect.objectContaining({ backfillComplete: true }));
  });

  it('fails closed on malformed records and non-inference categories', async () => {
    mockedList.mockResolvedValueOnce({
      items: [{ ...rawRecord('a'), startedAt: undefined }],
      nextCursor: null,
      until: 999,
      retentionDays: 30,
    } as any);
    await expect(syncWorkspace({ workspaceID: 'wrk_test' })).rejects.toMatchObject({ kind: 'contract' });

    mockedList.mockResolvedValueOnce({
      items: [{ ...rawRecord('b'), category: 'api' }],
      nextCursor: null,
      until: 999,
      retentionDays: 30,
    });
    await expect(syncWorkspace({ workspaceID: 'wrk_test' })).rejects.toMatchObject({ kind: 'contract' });
  });
  it('stops when the server repeats a pagination cursor', async () => {
    mockedList.mockResolvedValue({ items: [rawRecord('a')], nextCursor: 'same', until: 999, retentionDays: 30 });
    await expect(syncWorkspace({ workspaceID: 'wrk_test' })).rejects.toMatchObject({ kind: 'contract' });
    expect(mockedList).toHaveBeenCalledTimes(2);
  });
  it('falls back from 50 to 25 when the server rejects the page size', async () => {
    mockedList
      .mockRejectedValueOnce(new ApiError('bad-request', 'bad limit', 400))
      .mockResolvedValueOnce({ items: [rawRecord('a')], nextCursor: null, until: 999, retentionDays: 30 });

    const result = await syncWorkspace({ workspaceID: 'wrk_test' });

    expect(result.fetched).toBe(1);
    expect(mockedList.mock.calls[0]?.[1]).toMatchObject({ limit: 50 });
    expect(mockedList.mock.calls[1]?.[1]).toMatchObject({ limit: 25 });
  });

  it('retries transient rate-limit failures without losing the page', async () => {
    mockedList
      .mockRejectedValueOnce(new ApiError('rate-limit', 'slow down', 429, undefined, 0))
      .mockResolvedValueOnce({ items: [rawRecord('a')], nextCursor: null, until: 999, retentionDays: 30 });

    const result = await syncWorkspace({ workspaceID: 'wrk_test' });

    expect(result.fetched).toBe(1);
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('restarts from page one when the cursor expires', async () => {
    mockedList
      .mockResolvedValueOnce({ items: [rawRecord('a')], nextCursor: 'expired', until: 999, retentionDays: 30 })
      .mockRejectedValueOnce(new ApiError('cursor', 'cursor expired', 409, 'request_log_cursor_restart_required'))
      .mockResolvedValueOnce({ items: [rawRecord('a')], nextCursor: 'next', until: 999, retentionDays: 30 })
      .mockResolvedValueOnce({ items: [rawRecord('b')], nextCursor: null, until: 999, retentionDays: 30 });

    const result = await syncWorkspace({ workspaceID: 'wrk_test' });

    expect(result.complete).toBe(true);
    expect(mockedList).toHaveBeenCalledTimes(4);
    expect(mockedList.mock.calls[2]?.[1].cursor).toBeUndefined();
  });
  it('stops after the first page when every incremental record is already cached', async () => {
    const latest = Date.UTC(2026, 9, 18, 10, 0, 0);
    mockedGetState.mockResolvedValue({
      workspaceID: 'wrk_test',
      retentionDays: 30,
      latestStartedAt: latest,
      lastSuccessfulSyncAt: latest,
      backfillComplete: true,
      gapDetected: false,
    });
    mockedLatest.mockResolvedValue(latest);
    mockedGetKeys.mockResolvedValue(['wrk_test:a']);
    mockedList.mockResolvedValueOnce({ items: [rawRecord('a')], nextCursor: 'older', until: latest, retentionDays: 30 });

    const result = await syncWorkspace({ workspaceID: 'wrk_test' });

    expect(result.pages).toBe(1);
    expect(result.fetched).toBe(1);
    expect(result.added).toBe(0);
    expect(result.cacheHit).toBe(true);
    expect(mockedList).toHaveBeenCalledTimes(1);
  });

  it('continues past new records until an all-cached page', async () => {
    const latest = Date.UTC(2026, 9, 18, 10, 0, 0);
    mockedGetState.mockResolvedValue({
      workspaceID: 'wrk_test',
      retentionDays: 30,
      latestStartedAt: latest,
      lastSuccessfulSyncAt: latest,
      backfillComplete: true,
      gapDetected: false,
    });
    mockedLatest.mockResolvedValue(latest);
    mockedGetKeys.mockResolvedValue(['wrk_test:b']);
    mockedList
      .mockResolvedValueOnce({ items: [rawRecord('a')], nextCursor: 'older', until: latest, retentionDays: 30 })
      .mockResolvedValueOnce({ items: [rawRecord('b')], nextCursor: 'much-older', until: latest, retentionDays: 30 });

    const result = await syncWorkspace({ workspaceID: 'wrk_test' });

    expect(result.pages).toBe(2);
    expect(result.fetched).toBe(2);
    expect(result.added).toBe(1);
    expect(result.cacheHit).toBe(true);
    expect(mockedList).toHaveBeenCalledTimes(2);
  });

  it('restarts incremental sync from the latest local record minus overlap', async () => {
    const latest = Date.UTC(2026, 9, 18, 10, 0, 0);
    mockedGetState.mockResolvedValue({
      workspaceID: 'wrk_test',
      retentionDays: 30,
      latestStartedAt: latest,
      lastSuccessfulSyncAt: latest,
      backfillComplete: true,
      gapDetected: false,
    });
    mockedLatest.mockResolvedValue(latest);
    mockedList.mockResolvedValueOnce({ items: [], nextCursor: null, until: latest, retentionDays: 30 });

    await syncWorkspace({ workspaceID: 'wrk_test' });

    const since = mockedList.mock.calls[0]?.[1].since;
    expect(since).toBe(latest - 60 * 60 * 1000);
  });
});





