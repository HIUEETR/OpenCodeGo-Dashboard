export const APP_ID = 'ocgo-lens';
export const DB_NAME = 'ocgo-lens-v2';
export const LEGACY_DB_NAME = 'ocgo-cache';
export const DEFAULT_PAGE_SIZE = 50;
export const FALLBACK_PAGE_SIZES = [50, 25, 10] as const;
export const RETENTION_DAYS = 30;
export const OVERLAP_MS = 5 * 60 * 1000;
export const INCREMENTAL_LOOKBACK_MS = 60 * 60 * 1000;
export const SYNC_INTERVAL_MS = 10 * 60 * 1000;
export const PAGE_DELAY_MS = 250;
export const MAX_SYNC_PAGES = 100000;
export const MICROCENTS_PER_DOLLAR = 1e8;
export const MAX_CHART_BUCKETS = 120;
export const STORAGE_PREFIX = 'ocgo-lens:';

export const SYNC_STORAGE_KEY = 'syncEnabled';
export const TAB_STORAGE_KEY = 'activeTab';
export const FILTERS_STORAGE_KEY = 'filters';
export const RANGE_STORAGE_KEY = 'range';
export const LANGUAGE_STORAGE_KEY = 'language';
export const PANEL_STATE_KEY = 'panelState';

