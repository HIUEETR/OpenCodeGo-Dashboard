import type {
  CapturePage,
  RequestLogPage,
  RequestLogQuery,
  UsagePrincipal,
  Workspace,
} from './types';

export type ApiErrorKind =
  | 'session'
  | 'permission'
  | 'cursor'
  | 'rate-limit'
  | 'bad-request'
  | 'server'
  | 'network'
  | 'contract';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryAfterMs?: number;

  constructor(kind: ApiErrorKind, message: string, status?: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

interface ApiRequestOptions {
  query?: Record<string, string | number | undefined | null>;
  workspaceID?: string;
  signal?: AbortSignal;
}

function buildURL(path: string, query?: ApiRequestOptions['query']): string {
  const url = new URL(`/console${path}`, location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== '') {
        url.searchParams.set(key, String(value));
      }
    }
  }
  return url.toString();
}

async function readError(response: Response): Promise<{ message: string; code?: string }> {
  const raw = await response.text().catch(() => '');
  if (!raw) return { message: response.statusText || `HTTP ${response.status}` };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const message =
      (typeof parsed.message === 'string' && parsed.message) ||
      (typeof parsed._tag === 'string' && parsed._tag) ||
      response.statusText ||
      `HTTP ${response.status}`;
    const code = typeof parsed.code === 'string' ? parsed.code : undefined;
    return { message, code };
  } catch {
    return { message: raw.slice(0, 500) || response.statusText || `HTTP ${response.status}` };
  }
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function classifyError(status: number, response: Response, body: { message: string; code?: string }): ApiError {
  if (status === 401) return new ApiError('session', body.message, status, body.code);
  if (status === 403) return new ApiError('permission', body.message, status, body.code);
  if (status === 409) return new ApiError('cursor', body.message, status, body.code);
  if (status === 429) return new ApiError('rate-limit', body.message, status, body.code, retryAfterMs(response));
  if (status === 400 || status === 422) return new ApiError('bad-request', body.message, status, body.code);
  return new ApiError('server', body.message, status, body.code);
}

export async function requestJson<T>(path: string, options: ApiRequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.workspaceID) headers['x-org-id'] = options.workspaceID;

  let response: Response;
  try {
    response = await fetch(buildURL(path, options.query), {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    // Some browsers use a plain Error named AbortError.
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new ApiError('network', error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    const body = await readError(response);
    throw classifyError(response.status, response, body);
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiError('contract', 'The API returned a non-JSON response.', response.status);
  }
  return parsed as T;
}

export async function listWorkspaces(signal?: AbortSignal): Promise<Workspace[]> {
  const data = await requestJson<unknown>('/api/user/workspaces', { signal });
  if (!Array.isArray(data)) {
    throw new ApiError('contract', 'Workspace response was not an array.');
  }
  return data
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id : '',
      name: typeof item.name === 'string' ? item.name : '',
      role: typeof item.role === 'string' ? item.role : undefined,
      memberCount: typeof item.memberCount === 'number' ? item.memberCount : undefined,
      avatarUrl: typeof item.avatarUrl === 'string' ? item.avatarUrl : null,
    }))
    .filter((item) => item.id.startsWith('wrk_'));
}

export function validateRequestLogPage(data: unknown): RequestLogPage {
  if (!data || typeof data !== 'object') {
    throw new ApiError('contract', 'Request log response was not an object.');
  }
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.items)) {
    throw new ApiError('contract', 'Request log response did not contain an items array.');
  }
  const items = record.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object');
  if (items.length !== record.items.length) {
    throw new ApiError('contract', 'Request log response contained a malformed item.');
  }
  if (!Object.prototype.hasOwnProperty.call(record, 'nextCursor') || !(record.nextCursor === null || typeof record.nextCursor === 'string')) {
    throw new ApiError('contract', 'Request log response contained an invalid nextCursor.');
  }
  if (typeof record.until !== 'number' || !Number.isFinite(record.until)) {
    throw new ApiError('contract', 'Request log response contained an invalid until timestamp.');
  }
  if (record.retentionDays !== undefined && (typeof record.retentionDays !== 'number' || !Number.isFinite(record.retentionDays) || record.retentionDays <= 0)) {
    throw new ApiError('contract', 'Request log response contained an invalid retentionDays value.');
  }
  return {
    items,
    nextCursor: record.nextCursor,
    until: record.until,
    retentionDays: typeof record.retentionDays === 'number' ? record.retentionDays : 30,
  };
}

export async function listRequestLogs(
  workspaceID: string,
  query: RequestLogQuery,
  signal?: AbortSignal,
): Promise<RequestLogPage> {
  const params: Record<string, string | number | undefined> = {
    category: 'inference',
    since: Math.max(0, Math.floor(query.since)),
    until: query.until === undefined ? undefined : Math.floor(query.until),
    cursor: query.cursor,
    limit: query.limit,
    outcome: query.outcome,
    model: query.model,
    provider: query.provider,
    userID: query.userID,
    serviceAccountID: query.serviceAccountID,
    product: query.product,
    protocol: query.protocol,
  };
  const data = await requestJson<unknown>('/api/request-logs', {
    query: params,
    workspaceID,
    signal,
  });
  return validateRequestLogPage(data);
}

export function installRequestLogCapture(onPage: (page: CapturePage) => void): void {
  const win = window as typeof window & { __ocgoLensCaptureInstalled?: boolean };
  if (win.__ocgoLensCaptureInstalled || typeof window.fetch !== 'function') return;
  win.__ocgoLensCaptureInstalled = true;
  const original = window.fetch.bind(window);

  window.fetch = function capturedFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const responsePromise = original(input, init);
    try {
      const url = new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url,
        location.origin,
      );
      if (url.origin !== location.origin || url.pathname !== '/console/api/request-logs' || url.searchParams.get('category') !== 'inference') {
        return responsePromise;
      }
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const workspaceID = headers.get('x-org-id') ?? '';
      if (!workspaceID.startsWith('wrk_')) return responsePromise;
      void responsePromise
        .then(async (response) => {
          if (!response.ok) return;
          const data = await response.clone().json();
          const page = validateRequestLogPage(data);
          onPage({ workspaceID, page });
        })
        .catch(() => undefined);
    } catch {
      // Capture is opportunistic and must never interfere with console requests.
    }
    return responsePromise;
  };
}


export async function listUsagePrincipals(workspaceID: string, signal?: AbortSignal): Promise<UsagePrincipal[]> {
  const principals: UsagePrincipal[] = [];
  let page = 1;
  let pageCount = 1;
  while (page <= pageCount && page <= 20) {
    const data = await requestJson<unknown>('/api/usage/users', {
      query: { range: '30d', page, pageSize: 100, costOrder: 'desc' },
      workspaceID,
      signal,
    });
    if (!data || typeof data !== 'object') {
      throw new ApiError('contract', 'Usage principals response was not an object.');
    }
    const record = data as Record<string, unknown>;
    if (!Array.isArray(record.items)) {
      throw new ApiError('contract', 'Usage principals response did not contain an items array.');
    }
    if (record.items.some((item) => !item || typeof item !== 'object')) {
      throw new ApiError('contract', 'Usage principals response contained a malformed item.');
    }
    principals.push(...record.items.map((item) => {
      const value = item as Record<string, unknown>;
      return {
        userId: typeof value.userId === 'string' ? value.userId : '',
        serviceUserId: typeof value.serviceUserId === 'string' ? value.serviceUserId : '',
        principalType: typeof value.principalType === 'string' ? value.principalType : '',
        email: typeof value.email === 'string' ? value.email : '',
        name: typeof value.name === 'string' ? value.name : '',
        avatarUrl: typeof value.avatarUrl === 'string' ? value.avatarUrl : null,
      };
    }));
    pageCount = typeof record.pageCount === 'number' && Number.isFinite(record.pageCount) && record.pageCount > 0
      ? Math.floor(record.pageCount)
      : page;
    page += 1;
  }
  return principals;
}


