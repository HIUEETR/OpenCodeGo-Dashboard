import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, listRequestLogs, listUsagePrincipals, listWorkspaces, requestJson } from '../src/api';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('OpenCode Console API client', () => {
  it('sends workspace scope and request log query parameters', async () => {
    vi.stubGlobal('location', { origin: 'https://opencode.ai' });
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], nextCursor: null, until: 10, retentionDays: 30 }));
    vi.stubGlobal('fetch', fetchMock);

    const page = await listRequestLogs('wrk_test', { since: 100, until: 200, cursor: 'abc', limit: 50 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/console/api/request-logs');
    expect(parsed.searchParams.get('category')).toBe('inference');
    expect(parsed.searchParams.get('since')).toBe('100');
    expect(parsed.searchParams.get('until')).toBe('200');
    expect(parsed.searchParams.get('cursor')).toBe('abc');
    expect(parsed.searchParams.get('limit')).toBe('50');
    expect((init.headers as Record<string, string>)['x-org-id']).toBe('wrk_test');
    expect(init.credentials).toBe('same-origin');
    expect(page.retentionDays).toBe(30);
  });

  it('loads workspaces without a workspace header', async () => {
    vi.stubGlobal('location', { origin: 'https://opencode.ai' });
    const fetchMock = vi.fn(async () => jsonResponse([
      { id: 'wrk_test', name: 'Default', role: 'owner', memberCount: 1, avatarUrl: null },
      { id: 'ignored', name: 'Bad' },
    ]));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listWorkspaces()).resolves.toEqual([
      { id: 'wrk_test', name: 'Default', role: 'owner', memberCount: 1, avatarUrl: null },
    ]);
  });

  it('loads principal display names across paginated filter options', async () => {
    vi.stubGlobal('location', { origin: 'https://opencode.ai' });
    const fetchMock = vi.fn(async (url: string) => {
      const page = new URL(url).searchParams.get('page');
      return jsonResponse({
        items: [{
          userId: page === '1' ? 'user_1' : 'user_2',
          principalType: 'member',
          name: page === '1' ? 'Alice' : 'Bob',
          email: page === '1' ? 'alice@example.com' : 'bob@example.com',
        }],
        page: Number(page),
        pageSize: 100,
        total: 2,
        pageCount: 2,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const principals = await listUsagePrincipals('wrk_test');
    expect(principals.map((item) => item.name)).toEqual(['Alice', 'Bob']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/console/api/usage/users');
    expect((init.headers as Record<string, string>)['x-org-id']).toBe('wrk_test');
  });
  it('classifies cursor, auth, and rate limit errors', async () => {
    vi.stubGlobal('location', { origin: 'https://opencode.ai' });
    let response = jsonResponse({ _tag: 'RequestLogCursorRestartRequired', message: 'restart', code: 'cursor_restart' }, { status: 409 });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await requestJson('/api/request-logs', { workspaceID: 'wrk_test' }).catch((error) => {
      expect(error).toBeInstanceOf(ApiError);
      expect(error.kind).toBe('cursor');
    });

    response = jsonResponse({ message: 'unauthorized' }, { status: 401 });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await requestJson('/api/request-logs', { workspaceID: 'wrk_test' }).catch((error) => {
      expect(error.kind).toBe('session');
    });

    response = new Response(JSON.stringify({ message: 'slow down' }), {
      status: 429,
      headers: { 'content-type': 'application/json', 'retry-after': '2' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => response));
    await requestJson('/api/request-logs', { workspaceID: 'wrk_test' }).catch((error) => {
      expect(error.kind).toBe('rate-limit');
      expect(error.retryAfterMs).toBe(2000);
    });
  });

  it('fails closed when pagination metadata is missing', async () => {
    vi.stubGlobal('location', { origin: 'https://opencode.ai' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [], until: 1, retentionDays: 30 })));
    await expect(listRequestLogs('wrk_test', { since: 0 })).rejects.toMatchObject({ kind: 'contract' });
  });
  it('rejects malformed successful responses', async () => {
    vi.stubGlobal('location', { origin: 'https://opencode.ai' });
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: 'bad' })));
    await expect(listRequestLogs('wrk_test', { since: 0 })).rejects.toMatchObject({ kind: 'contract' });
  });
});



