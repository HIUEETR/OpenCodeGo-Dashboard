import { aggregateRecords, cacheHitRate, computeTps, computeTtft } from './analytics';
import { installRequestLogCapture } from './api';
import { Logger } from './logger';
import { getWorkspaceID } from './records';
import { persistCapturedPage } from './sync';
import { Panel } from './ui/panel';
import { APP_VERSION } from './version';

const VERSION = APP_VERSION;
const logger = new Logger();
let panel: Panel | undefined;
let routeTimer: number | undefined;

function scheduleRouteRefresh(): void {
  if (routeTimer) window.clearTimeout(routeTimer);
  routeTimer = window.setTimeout(() => {
    void panel?.refreshRoute();
  }, 60);
}

function patchHistory(): void {
  const win = window as typeof window & { __ocgoLensHistoryPatched?: boolean };
  if (win.__ocgoLensHistoryPatched) return;
  win.__ocgoLensHistoryPatched = true;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  history.pushState = function patchedPushState(data: unknown, unused: string, url?: string | URL | null): void {
    push(data, unused, url);
    scheduleRouteRefresh();
  };
  history.replaceState = function patchedReplaceState(data: unknown, unused: string, url?: string | URL | null): void {
    replace(data, unused, url);
    scheduleRouteRefresh();
  };
  window.addEventListener('popstate', scheduleRouteRefresh);
  window.addEventListener('hashchange', scheduleRouteRefresh);
}

function boot(): void {
  if (location.hostname !== 'opencode.ai' || !location.pathname.startsWith('/console')) return;
  if (document.getElementById('ocgo-lens-host')) return;
  try {
    patchHistory();
    installRequestLogCapture(({ workspaceID, page }) => {
      void persistCapturedPage(workspaceID, page.items)
        .then((count) => {
          if (count > 0) panel?.handleCaptured(workspaceID, count);
        })
        .catch((error) => logger.warn('log.captureFailed', { error: error instanceof Error ? error.message : String(error) }));
    });
    panel = new Panel(logger);
    panel.mount();
    void panel.refreshRoute();
    logger.info('log.ready', { version: VERSION });
  } catch (error) {
    logger.error('log.bootFailed', { error: error instanceof Error ? error.message : String(error) });
    console.error('[OpenCodeGo Dashboard Assistant]', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

interface LensTestApi {
  version: string;
  getWorkspaceID: () => string | null;
  aggregateRecords: typeof aggregateRecords;
  computeTtft: typeof computeTtft;
  computeTps: typeof computeTps;
  cacheHitRate: typeof cacheHitRate;
}

const win = window as typeof window & { __ocgoLens?: LensTestApi };
win.__ocgoLens = {
  version: VERSION,
  getWorkspaceID,
  aggregateRecords,
  computeTtft,
  computeTps,
  cacheHitRate,
};

