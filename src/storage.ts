import { DB_NAME, LEGACY_DB_NAME } from './constants';
import type { RequestRecord, SyncState, Workspace } from './types';

const STORE_REQUESTS = 'requests';
const STORE_SYNC = 'syncState';
const STORE_META = 'meta';

interface KVRecord {
  key: string;
  value: unknown;
}

let dbPromise: Promise<IDBDatabase> | null = null;
let syncStateMutationChain: Promise<unknown> = Promise.resolve();

function requestPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    transaction.onabort = () => reject(transaction.error ?? new DOMException('Transaction aborted', 'AbortError'));
  });
}

export function openDatabase(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_REQUESTS)) {
        const store = db.createObjectStore(STORE_REQUESTS, { keyPath: 'key' });
        store.createIndex('workspaceStartedAt', ['workspaceID', 'startedAt']);
        store.createIndex('workspaceModel', ['workspaceID', 'model']);
        store.createIndex('workspaceProvider', ['workspaceID', 'provider']);
      }
      if (!db.objectStoreNames.contains(STORE_SYNC)) {
        db.createObjectStore(STORE_SYNC, { keyPath: 'workspaceID' });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
  return dbPromise;
}

export async function putRecords(records: RequestRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openDatabase();
  const transaction = db.transaction(STORE_REQUESTS, 'readwrite');
  const store = transaction.objectStore(STORE_REQUESTS);
  for (const record of records) store.put(record);
  await transactionDone(transaction);
}

export async function getRecords(workspaceID: string, from = 0, to = Number.MAX_SAFE_INTEGER): Promise<RequestRecord[]> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_REQUESTS, 'readonly');
  const index = transaction.objectStore(STORE_REQUESTS).index('workspaceStartedAt');
  const range = IDBKeyRange.bound([workspaceID, from], [workspaceID, to]);
  const records = await requestPromise(index.getAll(range));
  await transactionDone(transaction);
  return records as RequestRecord[];
}

export async function getAllRecords(workspaceID: string): Promise<RequestRecord[]> {
  return getRecords(workspaceID);
}

export async function getRecordKeys(
  workspaceID: string,
  from = 0,
  to = Number.MAX_SAFE_INTEGER,
): Promise<string[]> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_REQUESTS, 'readonly');
  const index = transaction.objectStore(STORE_REQUESTS).index('workspaceStartedAt');
  const range = IDBKeyRange.bound([workspaceID, from], [workspaceID, to]);
  const keys = await requestPromise(index.getAllKeys(range));
  await transactionDone(transaction);
  return keys as string[];
}

export async function countRecords(workspaceID: string): Promise<number> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_REQUESTS, 'readonly');
  const index = transaction.objectStore(STORE_REQUESTS).index('workspaceStartedAt');
  const range = IDBKeyRange.bound([workspaceID, 0], [workspaceID, Number.MAX_SAFE_INTEGER]);
  const count = await requestPromise(index.count(range));
  await transactionDone(transaction);
  return count;
}

export async function getLatestStartedAt(workspaceID: string): Promise<number | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_REQUESTS, 'readonly');
  const index = transaction.objectStore(STORE_REQUESTS).index('workspaceStartedAt');
  const range = IDBKeyRange.bound([workspaceID, 0], [workspaceID, Number.MAX_SAFE_INTEGER]);
  const cursor = await requestPromise(index.openCursor(range, 'prev'));
  await transactionDone(transaction);
  const record = cursor?.value as RequestRecord | undefined;
  return record?.startedAt;
}

export async function getSyncState(workspaceID: string): Promise<SyncState | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_SYNC, 'readonly');
  const result = await requestPromise(transaction.objectStore(STORE_SYNC).get(workspaceID));
  await transactionDone(transaction);
  return result as SyncState | undefined;
}

export async function putSyncState(state: SyncState): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_SYNC, 'readwrite');
  transaction.objectStore(STORE_SYNC).put(state);
  await transactionDone(transaction);
}

export function updateSyncState(
  workspaceID: string,
  updater: (current: SyncState | undefined) => SyncState,
): Promise<SyncState> {
  const run = async (): Promise<SyncState> => {
    const db = await openDatabase();
    const transaction = db.transaction(STORE_SYNC, 'readwrite');
    const store = transaction.objectStore(STORE_SYNC);
    const current = await requestPromise(store.get(workspaceID)) as SyncState | undefined;
    const next = updater(current);
    store.put(next);
    await transactionDone(transaction);
    return next;
  };
  const task = syncStateMutationChain.then(run, run);
  syncStateMutationChain = task.then(() => undefined, () => undefined);
  return task;
}

export async function getWorkspaceMeta(id: string): Promise<Workspace | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_META, 'readonly');
  const result = await requestPromise(transaction.objectStore(STORE_META).get(`workspace:${id}`));
  await transactionDone(transaction);
  const record = result as KVRecord | undefined;
  return record?.value as Workspace | undefined;
}

export async function putWorkspaceMeta(workspace: Workspace): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_META, 'readwrite');
  transaction.objectStore(STORE_META).put({ key: `workspace:${workspace.id}`, value: workspace });
  await transactionDone(transaction);
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_META, 'readonly');
  const result = await requestPromise(transaction.objectStore(STORE_META).get(key));
  await transactionDone(transaction);
  return (result as KVRecord | undefined)?.value as T | undefined;
}

export async function putMeta(key: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction(STORE_META, 'readwrite');
  transaction.objectStore(STORE_META).put({ key, value });
  await transactionDone(transaction);
}

export async function clearWorkspace(workspaceID: string): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([STORE_REQUESTS, STORE_SYNC], 'readwrite');
  const index = transaction.objectStore(STORE_REQUESTS).index('workspaceStartedAt');
  const range = IDBKeyRange.bound([workspaceID, 0], [workspaceID, Number.MAX_SAFE_INTEGER]);
  const cursorRequest = index.openCursor(range);
  await new Promise<void>((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    cursorRequest.onerror = () => reject(cursorRequest.error);
  });
  transaction.objectStore(STORE_SYNC).delete(workspaceID);
  await transactionDone(transaction);
}

export async function clearDatabase(): Promise<void> {
  const db = await openDatabase();
  const transaction = db.transaction([STORE_REQUESTS, STORE_SYNC, STORE_META], 'readwrite');
  transaction.objectStore(STORE_REQUESTS).clear();
  transaction.objectStore(STORE_SYNC).clear();
  transaction.objectStore(STORE_META).clear();
  await transactionDone(transaction);
}

export async function storageEstimate(): Promise<{ usage?: number; quota?: number }> {
  if (!navigator.storage?.estimate) return {};
  const estimate = await navigator.storage.estimate();
  return { usage: estimate.usage, quota: estimate.quota };
}

async function legacyDatabaseExists(): Promise<boolean> {
  if (typeof indexedDB.databases === 'function') {
    const databases = await indexedDB.databases();
    return databases.some((db) => db.name === LEGACY_DB_NAME);
  }
  return true;
}

export async function readLegacyUsage(workspaceID: string): Promise<Record<string, unknown>[]> {
  if (!(await legacyDatabaseExists())) return [];
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Legacy database is blocked'));
  });
  try {
    if (!db.objectStoreNames.contains('kv')) return [];
    const transaction = db.transaction('kv', 'readonly');
    const value = await requestPromise(transaction.objectStore('kv').get(`usage:${workspaceID}`));
    await transactionDone(transaction);
    return Array.isArray(value)
      ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      : [];
  } finally {
    db.close();
  }
}

export async function clearLegacyUsage(workspaceID: string): Promise<void> {
  if (!(await legacyDatabaseExists())) return;
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LEGACY_DB_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    if (!db.objectStoreNames.contains('kv')) return;
    const transaction = db.transaction('kv', 'readwrite');
    transaction.objectStore('kv').delete(`usage:${workspaceID}`);
    await transactionDone(transaction);
  } finally {
    db.close();
  }
}

