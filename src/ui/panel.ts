import {
  EXPERIMENTAL_FORECAST_KEY,
  FILTERS_STORAGE_KEY,
  LANGUAGE_STORAGE_KEY,
  PANEL_STATE_KEY,
  RANGE_STORAGE_KEY,
  RETENTION_DAYS,
  STORAGE_PREFIX,
  TAB_STORAGE_KEY,
} from '../constants';
import {
  aggregateRecords,
  averageBucketMetric,
  computeTps,
  computeTtft,
  filterOptions,
  makeTimeRange,
  tokenRateForRange,
} from '../analytics';
import { ApiError, getGoQuotaStatus, listUsagePrincipals, listWorkspaces } from '../api';
import {
  csvEscape,
  clamp,
  downloadText,
  formatBytes,
  formatCompact,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
  formatRelative,
  formatTps,
  formatUsd,
} from '../format';
import { detectLanguage, t } from '../i18n';
import { formatLogEntry, type Logger } from '../logger';
import { migrateLegacyUsage } from '../migration';
import { getWorkspaceID } from '../records';
import {
  clearLegacyUsage,
  clearWorkspace,
  countRecords,
  getAllRecords,
  getRecords,
  getSyncState,
  updateSyncState,
  storageEstimate,
} from '../storage';
import { estimateModelCostBreakdown, loadGoPricing } from '../pricing';
import { buildQuotaForecast, type QuotaForecastResult } from '../forecast';
import { syncWorkspace } from '../sync';
import { APP_VERSION } from '../version';
import type {
  AnalyticsFilters,
  AnalyticsResult,
  GoPricingCache,
  GoQuotaStatus,
  Language,
  ModelSummary,
  RangePreset,
  RequestRecord,
  SyncProgress,
  SyncState,
  TabKey,
  TimeRange,
  UsagePrincipal,
  Workspace,
} from '../types';
import { hideChartTooltip, renderCacheChart, renderLatencyChart, renderTokenMix, renderTpsChart, showDataTooltip } from './charts';
import { ForecastPanel } from './forecastPanel';
import { panelCss } from './styles';

type ElementTag = keyof HTMLElementTagNameMap;

interface PersistedPanelState {
  open?: boolean;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  fabX?: number;
  fabY?: number;
  chartScale?: number;
  customFrom?: string;
  customTo?: string;
}

function node<K extends ElementTag>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function button(text: string, className = 'ocgo-btn'): HTMLButtonElement {
  const element = node('button', className, text);
  element.type = 'button';
  return element;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${key}`);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJSON(key: string, value: unknown): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${key}`, JSON.stringify(value));
  } catch {
    // Preferences are non-critical.
  }
}

function localInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function shortID(value: string): string {
  if (!value) return '—';
  return value.length <= 22 ? value : `${value.slice(0, 10)}…${value.slice(-6)}`;
}

const RANGE_PRESETS: RangePreset[] = ['1h', '24h', '7d', '30d', 'all', 'custom'];
const MIN_PANEL_WIDTH = 680;
const MIN_PANEL_HEIGHT = 480;
const MIN_CHART_SCALE = 0.5;
const MAX_CHART_SCALE = 2;
const CHART_SCALE_STEP = 0.25;

export class Panel {
  private readonly logger: Logger;
  private host?: HTMLDivElement;
  private shadow?: ShadowRoot;
  private panel?: HTMLElement;
  private fab?: HTMLButtonElement;
  private errorBox?: HTMLElement;
  private statusDot?: HTMLElement;
  private statusText?: HTMLElement;
  private workspaceLabel?: HTMLElement;
  private rangeSelect?: HTMLSelectElement;
  private rangeControl?: HTMLElement;
  private modelSelect?: HTMLSelectElement;
  private providerSelect?: HTMLSelectElement;
  private userSelect?: HTMLSelectElement;
  private customRange?: HTMLElement;
  private customFrom?: HTMLInputElement;
  private customTo?: HTMLInputElement;
  private syncButton?: HTMLButtonElement;
  private langSelect?: HTMLSelectElement;
  private cards?: HTMLElement;
  private overviewModels?: HTMLElement;
  private overviewLegacyNote?: HTMLElement;
  private charts: HTMLElement[] = [];
  private chartModels?: HTMLElement;
  private chartGrid?: HTMLElement;
  private chartZoomValue?: HTMLButtonElement;
  private chartZoomOut?: HTMLButtonElement;
  private chartZoomIn?: HTMLButtonElement;
  private chartTooltip?: HTMLElement;
  private toast?: HTMLElement;
  private toastTimer?: number;
  private chartAverages = new Map<string, HTMLElement>();
  private requestsTable?: HTMLElement;
  private requestPager?: HTMLElement;
  private dataInfo?: HTMLElement;
  private dataActions?: HTMLElement;
  private experimentalCheckbox?: HTMLInputElement;
  private forecastTab?: HTMLButtonElement;
  private forecastHost?: HTMLElement;
  private forecastPanel?: ForecastPanel;
  private pricingPanel?: HTMLElement;
  private storageNote?: HTMLElement;
  private logList?: HTMLElement;
  private tabButtons = new Map<TabKey, HTMLButtonElement>();
  private views = new Map<TabKey, HTMLElement>();
  private i18nNodes = new Map<string, HTMLElement[]>();
  private language: Language;
  private rangePreset: RangePreset;
  private filters: AnalyticsFilters;
  private activeTab: TabKey;
  private persisted: PersistedPanelState;
  private open = false;
  private workspaceID: string | null = null;
  private workspaces: Workspace[] = [];
  private principals: UsagePrincipal[] = [];
  private records: RequestRecord[] = [];
  private totalRecordCount = 0;
  private rangeLoadSeq = 0;
  private syncState?: SyncState;
  private analysis?: AnalyticsResult;
  private range?: TimeRange;
  private busy = false;
  private syncPromise?: Promise<void>;
  private controller?: AbortController;
  private principalsController?: AbortController;
  private progress?: SyncProgress;
  private errorMessage = '';
  private rangeError = '';
  private requestPage = 1;
  private clearArmed = false;
  private clearTimer?: number;
  private refreshTimer?: number;
  private autoInterval?: number;
  private hasOpened = false;
  private mounted = false;
  private suppressFabClick = false;
  private chartScale = 1;
  private pricing?: GoPricingCache;
  private pricingLoading = false;
  private pricingError = '';
  private pricingPromise?: Promise<GoPricingCache | undefined>;
  private experimentalForecast = false;
  private forecastRecords?: RequestRecord[];
  private forecastResult?: QuotaForecastResult;
  private forecastStatus?: GoQuotaStatus;
  private forecastStatusFetchedAt = 0;
  private forecastStatusError = '';
  private forecastLoading = false;
  private forecastError = '';
  private forecastLoadSeq = 0;
  private forecastStale = true;
  private forecastController?: AbortController;
  private forecastViewReady = false;

  constructor(logger: Logger) {
    this.logger = logger;
    this.language = loadJSON<Language>(LANGUAGE_STORAGE_KEY, detectLanguage());
    this.rangePreset = loadJSON<RangePreset>(RANGE_STORAGE_KEY, '7d');
    this.activeTab = loadJSON<TabKey>(TAB_STORAGE_KEY, 'overview');
    this.filters = loadJSON<AnalyticsFilters>(FILTERS_STORAGE_KEY, { model: '', provider: '', userKey: '' });
    this.persisted = loadJSON<PersistedPanelState>(PANEL_STATE_KEY, {});
    if (typeof this.persisted.chartScale === 'number' && Number.isFinite(this.persisted.chartScale)) {
      this.chartScale = clamp(this.persisted.chartScale, MIN_CHART_SCALE, MAX_CHART_SCALE);
    }
    this.open = Boolean(this.persisted.open);
  }

  mount(): void {
    if (this.mounted || document.getElementById('ocgo-lens-host')) return;
    this.mounted = true;
    this.host = node('div');
    this.host.id = 'ocgo-lens-host';
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = node('style');
    style.textContent = panelCss;
    this.shadow.appendChild(style);
    this.buildShell(this.shadow);
    document.documentElement.appendChild(this.host);
    this.applyGeometry();
    this.setOpen(this.open, false);
    this.renderChrome();
    this.render();
    this.applyFabGeometry();
    this.applyChartScale();
    this.startAutoSync();
    window.addEventListener('resize', () => {
      this.applyGeometry();
      this.applyFabGeometry();
    });
    this.logger.info('log.mounted');
    this.logger.subscribe(() => {
      if (this.activeTab === 'data') this.renderLogs();
    });
  }

  private rememberI18n(key: string, element: HTMLElement): HTMLElement {
    const nodes = this.i18nNodes.get(key) ?? [];
    nodes.push(element);
    this.i18nNodes.set(key, nodes);
    return element;
  }

  private textFor(key: string): HTMLSpanElement {
    const element = node('span');
    this.rememberI18n(key, element);
    return element;
  }

  private buildShell(root: ShadowRoot): void {
    const wrapper = node('div');
    wrapper.id = 'ocgo-lens';
    this.fab = button('', 'ocgo-fab');
    this.fab.setAttribute('aria-label', 'Open performance lens');
    this.fab.setAttribute('aria-expanded', 'false');
    this.fab.setAttribute('aria-controls', 'ocgo-lens-panel');
    this.fab.innerHTML = '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M6 23V9m6 14V13m6 10V7m6 16V11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><path d="M4 27h24" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.4"/></svg>';
    this.fab.addEventListener('click', () => {
      if (this.suppressFabClick) {
        this.suppressFabClick = false;
        return;
      }
      this.setOpen(!this.open);
    });
    this.bindFabDrag();

    const panel = node('section', 'ocgo-panel ocgo-hidden');
    panel.id = 'ocgo-lens-panel';
    this.panel = panel;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'false');
    panel.setAttribute('aria-labelledby', 'ocgo-lens-title');

    const header = node('header', 'ocgo-header');
    const brand = node('div', 'ocgo-brand');
    const title = this.rememberI18n('app.title', node('div', 'ocgo-title'));
    title.id = 'ocgo-lens-title';
    brand.append(title, this.rememberI18n('app.subtitle', node('div', 'ocgo-subtitle')));
    this.workspaceLabel = node('span', 'ocgo-workspace');
    const langSelect = node('select');
    this.langSelect = langSelect;
    langSelect.setAttribute('aria-label', 'Language');
    for (const [value, label] of [['zh', '中文'], ['en', 'English']]) {
      const option = node('option', '', label);
      option.value = value;
      langSelect.appendChild(option);
    }
    langSelect.addEventListener('change', () => this.setLanguage(langSelect.value as Language));
    const close = button('×', 'ocgo-icon-btn');
    close.setAttribute('aria-label', 'Close');
    close.addEventListener('click', () => this.setOpen(false));
    header.append(brand, this.workspaceLabel, langSelect, close);
    this.bindDrag(header);

    const toolbar = node('div', 'ocgo-toolbar');
    const rangeWrap = node('label');
    this.rangeControl = rangeWrap;
    rangeWrap.append(this.textFor('range.label'));
    const rangeSelect = node('select');
    this.rangeSelect = rangeSelect;
    for (const preset of RANGE_PRESETS) {
      const option = node('option');
      option.value = preset;
      this.rememberI18n(`range.${preset}`, option);
      rangeSelect.appendChild(option);
    }
    rangeWrap.append(rangeSelect);
    const custom = node('div', 'ocgo-custom-range');
    this.customRange = custom;
    const fromInput = node('input');
    fromInput.type = 'datetime-local';
    const toInput = node('input');
    toInput.type = 'datetime-local';
    fromInput.value = this.persisted.customFrom ?? '';
    toInput.value = this.persisted.customTo ?? '';
    this.customFrom = fromInput;
    this.customTo = toInput;
    custom.append(this.textFor('range.from'), fromInput, this.textFor('range.to'), toInput);
    const modelLabel = node('label');
    modelLabel.append(this.textFor('filter.model'));
    const modelSelect = node('select');
    this.modelSelect = modelSelect;
    modelLabel.append(modelSelect);
    const providerLabel = node('label');
    providerLabel.append(this.textFor('filter.provider'));
    const providerSelect = node('select');
    this.providerSelect = providerSelect;
    providerLabel.append(providerSelect);
    const userLabel = node('label');
    userLabel.append(this.textFor('filter.user'));
    const userSelect = node('select');
    this.userSelect = userSelect;
    userLabel.append(userSelect);
    const clearFilters = button('', 'ocgo-btn');
    this.rememberI18n('filter.clear', clearFilters);
    clearFilters.addEventListener('click', () => {
      this.filters = { model: '', provider: '', userKey: '' };
      this.requestPage = 1;
      this.persistPreferences();
      this.renderFilters();
      this.render();
    });
    const sync = button('', 'ocgo-sync-btn');
    this.syncButton = sync;
    sync.addEventListener('click', () => {
      if (this.busy) this.stopSync();
      else void this.sync(false);
    });
    toolbar.append(rangeWrap, custom, modelLabel, providerLabel, userLabel, clearFilters, sync);
    rangeSelect.addEventListener('change', () => {
      this.rangePreset = rangeSelect.value as RangePreset;
      if (this.rangePreset === 'custom') this.ensureCustomRange();
      this.requestPage = 1;
      this.persistPreferences();
      void this.reloadRecords();
    });
    fromInput.addEventListener('change', () => {
      this.persisted.customFrom = fromInput.value;
      saveJSON(PANEL_STATE_KEY, this.persisted);
      this.requestPage = 1;
      void this.reloadRecords();
    });
    toInput.addEventListener('change', () => {
      this.persisted.customTo = toInput.value;
      saveJSON(PANEL_STATE_KEY, this.persisted);
      this.requestPage = 1;
      void this.reloadRecords();
    });
    modelSelect.addEventListener('change', () => {
      this.filters.model = modelSelect.value;
      this.requestPage = 1;
      this.persistPreferences();
      this.render();
    });
    providerSelect.addEventListener('change', () => {
      this.filters.provider = providerSelect.value;
      this.requestPage = 1;
      this.persistPreferences();
      this.render();
    });
    userSelect.addEventListener('change', () => {
      this.filters.userKey = userSelect.value;
      this.requestPage = 1;
      this.persistPreferences();
      this.render();
    });

    const tabs = node('nav', 'ocgo-tabs');
    const tabKeys: TabKey[] = ['overview', 'charts', 'requests', 'forecast', 'data'];
    for (const key of tabKeys) {
      const tab = button('', 'ocgo-tab');
      tab.appendChild(this.textFor(`tabs.${key}`));
      if (key === 'forecast') {
        tab.appendChild(node('span', 'ocgo-tab-badge', t(this.language, 'badge.beta')));
        this.forecastTab = tab;
      }
      tab.dataset.tab = key;
      tab.addEventListener('click', () => this.setTab(key));
      this.tabButtons.set(key, tab);
      tabs.appendChild(tab);
    }

    const status = node('div', 'ocgo-statusbar');
    this.statusDot = node('span', 'ocgo-status-dot');
    this.statusText = node('span');
    status.append(this.statusDot, this.statusText);

    this.errorBox = node('div', 'ocgo-error ocgo-hidden');

    const body = node('div', 'ocgo-body');
    const overview = this.buildOverviewView();
    const charts = this.buildChartsView();
    const requests = this.buildRequestsView();
    const forecast = this.buildForecastView();
    const data = this.buildDataView();
    this.views.set('overview', overview);
    this.views.set('charts', charts);
    this.views.set('requests', requests);
    this.views.set('forecast', forecast);
    this.views.set('data', data);
    body.append(overview, charts, requests, forecast, data);

    const directions = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
    const handles = directions.map((direction) => {
      const handle = node('div', `ocgo-resize-handle ocgo-resize-${direction}`);
      handle.dataset.resize = direction;
      handle.setAttribute('aria-hidden', 'true');
      this.bindResize(handle, direction);
      return handle;
    });
    panel.append(header, toolbar, tabs, status, this.errorBox, body, ...handles);
    this.chartTooltip = node('div', 'ocgo-chart-tooltip ocgo-hidden');
    this.chartTooltip.setAttribute('role', 'tooltip');
    this.toast = node('div', 'ocgo-toast ocgo-hidden');
    this.toast.setAttribute('role', 'status');
    this.toast.setAttribute('aria-live', 'polite');
    panel.appendChild(this.toast);
    wrapper.append(this.fab, panel, this.chartTooltip);
    root.appendChild(wrapper);

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.open) this.setOpen(false);
    });
    document.addEventListener('pointerdown', (event) => {
      if (!this.open) return;
      const path = event.composedPath();
      if (this.panel && path.includes(this.panel)) return;
      if (this.fab && path.includes(this.fab)) return;
      if (this.chartTooltip && path.includes(this.chartTooltip)) return;
      this.setOpen(false);
    }, true);
    document.addEventListener('visibilitychange', () => this.handleVisibility());
  }
  private buildOverviewView(): HTMLElement {
    const view = node('section', 'ocgo-view');
    view.dataset.view = 'overview';
    this.cards = node('div', 'ocgo-cards');
    const section = node('section', 'ocgo-section');
    const head = node('div', 'ocgo-section-head');
    const legacyNote = this.textFor('legacy.note');
    this.overviewLegacyNote = legacyNote;
    head.append(this.textFor('chart.models'), legacyNote);
    this.overviewModels = node('div', 'ocgo-table-wrap');
    section.append(head, this.overviewModels);
    view.append(this.cards, section);
    return view;
  }

  private buildChartsView(): HTMLElement {
    const view = node('section', 'ocgo-view');
    view.dataset.view = 'charts';
    const controls = node('div', 'ocgo-chart-controls');
    const zoomLabel = this.textFor('chart.zoom');
    zoomLabel.className = 'ocgo-chart-zoom-label';
    const zoomGroup = node('div', 'ocgo-chart-zoom');
    const zoomOut = button('−', 'ocgo-zoom-btn');
    this.chartZoomOut = zoomOut;
    zoomOut.setAttribute('aria-label', t(this.language, 'chart.zoomOut'));
    zoomOut.addEventListener('click', () => this.setChartScale(this.chartScale - CHART_SCALE_STEP));
    const zoomValue = button('100%', 'ocgo-zoom-value');
    zoomValue.setAttribute('aria-label', t(this.language, 'chart.zoomReset'));
    zoomValue.addEventListener('click', () => this.setChartScale(1));
    this.chartZoomValue = zoomValue;
    const zoomIn = button('+', 'ocgo-zoom-btn');
    this.chartZoomIn = zoomIn;
    zoomIn.setAttribute('aria-label', t(this.language, 'chart.zoomIn'));
    zoomIn.addEventListener('click', () => this.setChartScale(this.chartScale + CHART_SCALE_STEP));
    zoomGroup.append(zoomOut, zoomValue, zoomIn);
    controls.append(zoomLabel, zoomGroup);
    const grid = node('div', 'ocgo-chart-grid');
    this.chartGrid = grid;
    const keys = ['chart.tokens', 'chart.cache', 'chart.ttft', 'chart.tps'] as const;
    for (const key of keys) {
      const section = node('section', 'ocgo-section ocgo-chart-box');
      const head = node('div', 'ocgo-section-head');
      const titleGroup = node('div', 'ocgo-chart-title-group');
      const title = this.textFor(key);
      title.className = 'ocgo-section-title';
      const average = node('span', 'ocgo-section-average');
      this.chartAverages.set(key, average);
      titleGroup.append(title, average);
      head.append(titleGroup);
      const host = node('div', 'ocgo-chart-host');
      this.charts.push(host);
      section.append(head, host);
      grid.appendChild(section);
    }
    const modelSection = node('section', 'ocgo-section');
    const head = node('div', 'ocgo-section-head');
    head.append(this.textFor('chart.models'));
    this.chartModels = node('div', 'ocgo-table-wrap');
    modelSection.append(head, this.chartModels);
    view.append(controls, grid, modelSection);
    return view;
  }

  private buildRequestsView(): HTMLElement {
    const view = node('section', 'ocgo-view');
    view.dataset.view = 'requests';
    const section = node('section', 'ocgo-section');
    this.requestsTable = node('div', 'ocgo-table-wrap');
    this.requestPager = node('div', 'ocgo-pager');
    section.append(this.requestsTable, this.requestPager);
    view.append(section);
    return view;
  }

  private buildForecastView(): HTMLElement {
    const view = node('section', 'ocgo-view');
    view.dataset.view = 'forecast';
    const host = node('div', 'ocgo-forecast-view');
    this.forecastHost = host;
    this.forecastPanel = new ForecastPanel(host);
    view.appendChild(host);
    return view;
  }

  private buildDataView(): HTMLElement {
    const view = node('section', 'ocgo-view');
    view.dataset.view = 'data';
    const grid = node('div', 'ocgo-data-grid');
    const infoSection = node('section', 'ocgo-section');
    const infoHead = node('div', 'ocgo-section-head');
    infoHead.append(this.textFor('tabs.data'));
    this.dataInfo = node('div');
    infoSection.append(infoHead, this.dataInfo);
    const actionSection = node('section', 'ocgo-section');
    const actionHead = node('div', 'ocgo-section-head');
    actionHead.append(this.textFor('data.actions'));
    this.dataActions = node('div', 'ocgo-actions');
    actionSection.append(actionHead, this.dataActions);
    grid.append(infoSection, actionSection);
    const experimentalSection = node('section', 'ocgo-section');
    const experimentalHead = node('div', 'ocgo-section-head');
    experimentalHead.append(this.textFor('data.experimentalTitle'));
    const experimental = node('div', 'ocgo-experimental');
    const experimentalRow = node('label', 'ocgo-experimental-row');
    const experimentalCheckbox = node('input');
    experimentalCheckbox.type = 'checkbox';
    experimentalCheckbox.checked = this.experimentalForecast;
    this.experimentalCheckbox = experimentalCheckbox;
    experimentalCheckbox.addEventListener('change', () => this.setExperimentalForecast(experimentalCheckbox.checked));
    experimentalRow.append(experimentalCheckbox, this.textFor('data.experimentalForecast'));
    experimental.append(
      experimentalRow,
      this.rememberI18n('data.experimentalForecastHint', node('div', 'ocgo-note')),
      this.rememberI18n('data.experimentalForecastNote', node('div', 'ocgo-note')),
    );
    experimentalSection.append(experimentalHead, experimental);
    const pricingSection = node('section', 'ocgo-section ocgo-pricing-section');
    const pricingHead = node('div', 'ocgo-section-head');
    pricingHead.append(
      this.textFor('data.pricingTitle'),
      this.rememberI18n('data.pricingHint', node('span', 'ocgo-section-note')),
    );
    this.pricingPanel = node('div', 'ocgo-pricing-panel');
    pricingSection.append(pricingHead, this.pricingPanel);
    const diagnostics = node('section', 'ocgo-section');
    const logHead = node('div', 'ocgo-section-head');
    logHead.append(this.textFor('data.diagnostics'));
    this.logList = node('div', 'ocgo-log-list');
    diagnostics.append(logHead, this.logList);
    view.append(grid, experimentalSection, pricingSection, diagnostics);
    return view;
  }

  private bindDrag(header: HTMLElement): void {
    header.addEventListener('mousedown', (event) => {
      const target = event.target as HTMLElement;
      if (target.closest('button, select, input, a')) return;
      if (!this.panel) return;
      event.preventDefault();
      const rect = this.panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeft = rect.left;
      const startTop = rect.top;
      const move = (moveEvent: MouseEvent) => {
        if (!this.panel) return;
        const left = Math.max(0, Math.min(window.innerWidth - 120, startLeft + moveEvent.clientX - startX));
        const top = Math.max(0, Math.min(window.innerHeight - 80, startTop + moveEvent.clientY - startY));
        this.panel.style.left = `${left}px`;
        this.panel.style.top = `${top}px`;
        this.panel.style.right = 'auto';
        this.panel.style.bottom = 'auto';
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        if (this.panel) {
          const next = this.panel.getBoundingClientRect();
          this.persisted.x = Math.round(next.left);
          this.persisted.y = Math.round(next.top);
          saveJSON(PANEL_STATE_KEY, this.persisted);
        }
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  private bindFabDrag(): void {
    if (!this.fab) return;
    this.fab.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !this.fab) return;
      const fab = this.fab;
      const rect = fab.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;
      let moved = false;
      let finished = false;
      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!moved && Math.hypot(dx, dy) < 4) return;
        moved = true;
        moveEvent.preventDefault();
        fab.classList.add('ocgo-dragging');
        const size = fab.offsetWidth || 48;
        const left = clamp(rect.left + dx, 8, window.innerWidth - size - 8);
        const top = clamp(rect.top + dy, 8, window.innerHeight - size - 8);
        fab.style.left = `${left}px`;
        fab.style.top = `${top}px`;
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        fab.removeEventListener('lostpointercapture', finish);
        if (fab.hasPointerCapture(pointerId)) fab.releasePointerCapture(pointerId);
        fab.classList.remove('ocgo-dragging');
        if (!moved) return;
        const next = fab.getBoundingClientRect();
        this.persisted.fabX = Math.round(next.left);
        this.persisted.fabY = Math.round(next.top);
        saveJSON(PANEL_STATE_KEY, this.persisted);
        this.suppressFabClick = true;
        window.setTimeout(() => {
          this.suppressFabClick = false;
        }, 350);
      };
      try {
        fab.setPointerCapture(pointerId);
      } catch {
        // Window listeners still handle the drag when pointer capture is unavailable.
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      fab.addEventListener('lostpointercapture', finish);
    });
  }

  private bindResize(handle: HTMLElement, direction: 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'): void {
    handle.addEventListener('pointerdown', (event) => {
      if (!this.panel || event.button !== 0 || window.innerWidth <= 820) return;
      event.preventDefault();
      const panel = this.panel;
      const rect = panel.getBoundingClientRect();
      panel.style.left = `${rect.left}px`;
      panel.style.top = `${rect.top}px`;
      panel.style.width = `${rect.width}px`;
      panel.style.height = `${rect.height}px`;
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
      const startX = event.clientX;
      const startY = event.clientY;
      const pointerId = event.pointerId;
      const startLeft = rect.left;
      const startTop = rect.top;
      const startRight = rect.right;
      const startBottom = rect.bottom;
      const minWidth = Math.min(MIN_PANEL_WIDTH, window.innerWidth - 16);
      const minHeight = Math.min(MIN_PANEL_HEIGHT, window.innerHeight - 16);
      const rightBound = window.innerWidth - 8;
      const bottomBound = window.innerHeight - 8;
      let finished = false;
      const move = (moveEvent: PointerEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        let left = startLeft;
        let top = startTop;
        let width = rect.width;
        let height = rect.height;
        if (direction.includes('e')) {
          width = clamp(startRight + dx - startLeft, minWidth, Math.max(minWidth, rightBound - startLeft));
        }
        if (direction.includes('w')) {
          left = clamp(startLeft + dx, 8, Math.max(8, startRight - minWidth));
          width = startRight - left;
        }
        if (direction.includes('s')) {
          height = clamp(startBottom + dy - startTop, minHeight, Math.max(minHeight, bottomBound - startTop));
        }
        if (direction.includes('n')) {
          top = clamp(startTop + dy, 8, Math.max(8, startBottom - minHeight));
          height = startBottom - top;
        }
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.width = `${width}px`;
        panel.style.height = `${height}px`;
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
        if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        const next = panel.getBoundingClientRect();
        this.persisted.x = Math.round(next.left);
        this.persisted.y = Math.round(next.top);
        this.persisted.width = Math.round(next.width);
        this.persisted.height = Math.round(next.height);
        saveJSON(PANEL_STATE_KEY, this.persisted);
      };
      try {
        handle.setPointerCapture(pointerId);
      } catch {
        // Window listeners still handle resizing when pointer capture is unavailable.
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
    });
  }

  private applyGeometry(): void {
    if (!this.panel) return;
    const maxWidth = Math.max(320, window.innerWidth - 16);
    const maxHeight = Math.max(320, window.innerHeight - 16);
    const width = this.persisted.width
      ? clamp(this.persisted.width, Math.min(MIN_PANEL_WIDTH, maxWidth), maxWidth)
      : undefined;
    const height = this.persisted.height
      ? clamp(this.persisted.height, Math.min(MIN_PANEL_HEIGHT, maxHeight), maxHeight)
      : undefined;
    if (width) this.panel.style.width = `${width}px`;
    if (height) this.panel.style.height = `${height}px`;
    if (this.persisted.x !== undefined || this.persisted.y !== undefined) {
      const rect = this.panel.getBoundingClientRect();
      const left = clamp(this.persisted.x ?? rect.left, 8, Math.max(8, window.innerWidth - (width ?? rect.width) - 8));
      const top = clamp(this.persisted.y ?? rect.top, 8, Math.max(8, window.innerHeight - (height ?? rect.height) - 8));
      this.panel.style.left = `${left}px`;
      this.panel.style.top = `${top}px`;
      this.panel.style.right = 'auto';
      this.panel.style.bottom = 'auto';
    }
  }

  private applyFabGeometry(): void {
    if (!this.fab || (this.persisted.fabX === undefined && this.persisted.fabY === undefined)) return;
    const size = this.fab.offsetWidth || 48;
    const defaultLeft = window.innerWidth - 20 - size;
    const defaultTop = window.innerHeight - 20 - size;
    const left = clamp(this.persisted.fabX ?? defaultLeft, 8, Math.max(8, window.innerWidth - size - 8));
    const top = clamp(this.persisted.fabY ?? defaultTop, 8, Math.max(8, window.innerHeight - size - 8));
    this.fab.style.left = `${left}px`;
    this.fab.style.top = `${top}px`;
    this.fab.style.right = 'auto';
    this.fab.style.bottom = 'auto';
  }

  private setChartScale(value: number): void {
    this.chartScale = clamp(Math.round(value / CHART_SCALE_STEP) * CHART_SCALE_STEP, MIN_CHART_SCALE, MAX_CHART_SCALE);
    this.persisted.chartScale = this.chartScale;
    saveJSON(PANEL_STATE_KEY, this.persisted);
    this.applyChartScale();
    hideChartTooltip(this.chartTooltip);
  }

  private applyChartScale(): void {
    if (!this.chartGrid) return;
    this.chartGrid.style.setProperty('--ocgo-chart-width', this.chartScale <= 1 ? `${this.chartScale * 100}%` : '100%');
    this.chartGrid.style.setProperty('--ocgo-chart-height', `${195 * this.chartScale}px`);
    this.chartGrid.style.setProperty('--ocgo-chart-box-height', `${250 * this.chartScale}px`);
    this.chartGrid.classList.toggle('ocgo-chart-zoomed', this.chartScale > 1);
    if (this.chartZoomValue) this.chartZoomValue.textContent = `${Math.round(this.chartScale * 100)}%`;
    if (this.chartZoomOut) this.chartZoomOut.disabled = this.chartScale <= MIN_CHART_SCALE;
    if (this.chartZoomIn) this.chartZoomIn.disabled = this.chartScale >= MAX_CHART_SCALE;
  }

  private setOpen(open: boolean, persist = true): void {
    this.open = open;
    this.panel?.classList.toggle('ocgo-hidden', !open);
    this.fab?.classList.toggle('ocgo-open', open);
    this.fab?.setAttribute('aria-expanded', String(open));
    if (this.fab) {
      const label = t(this.language, open ? 'app.close' : 'app.open');
      this.fab.title = label;
      this.fab.setAttribute('aria-label', label);
    }
    if (persist) {
      this.persisted.open = open;
      saveJSON(PANEL_STATE_KEY, this.persisted);
    }
    if (!open) {
      hideChartTooltip(this.chartTooltip);
      this.hideToast();
    }
    if (open) {
      this.hasOpened = true;
      this.render();
      if (this.open && this.activeTab === 'forecast') void this.loadForecast(false);
      window.setTimeout(() => this.autoSyncIfStale(), 150);
    }
  }

  private showToast(key: string, values?: Record<string, string | number>): void {
    if (!this.toast || !this.open) return;
    if (this.toastTimer) window.clearTimeout(this.toastTimer);
    this.toast.textContent = t(this.language, key, values);
    this.toast.classList.remove('ocgo-hidden', 'ocgo-toast-in');
    void this.toast.offsetWidth;
    this.toast.classList.add('ocgo-toast-in');
    this.toastTimer = window.setTimeout(() => this.hideToast(), 4000);
  }

  private hideToast(): void {
    if (this.toastTimer) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = undefined;
    }
    this.toast?.classList.add('ocgo-hidden');
  }

  private ensurePricing(): Promise<GoPricingCache | undefined> {
    if (this.pricingPromise) return this.pricingPromise;
    const task = this.loadPricing();
    this.pricingPromise = task;
    void task.finally(() => {
      if (this.pricingPromise === task) this.pricingPromise = undefined;
    });
    return task;
  }

  private async loadPricing(): Promise<GoPricingCache | undefined> {
    if (this.pricingLoading) return this.pricing;
    this.pricingLoading = true;
    this.renderPricing();
    const result = await loadGoPricing();
    this.pricingLoading = false;
    this.pricingError = result.error ?? '';
    if (result.pricing) {
      this.pricing = result.pricing;
      if (result.refreshed) this.logger.info('log.pricingUpdated', { n: result.pricing.tiers.length });
      this.renderModelTable(this.overviewModels, this.analysis?.models ?? []);
      this.renderModelTable(this.chartModels, this.analysis?.models ?? []);
    }
    this.renderPricing();
    if (result.error) this.logger.warn('log.pricingRefreshFailed', { error: result.error });
    return this.pricing;
  }

  private setExperimentalForecast(enabled: boolean): void {
    this.experimentalForecast = enabled;
    saveJSON(EXPERIMENTAL_FORECAST_KEY, enabled);
    if (!enabled) {
      this.resetForecast();
      if (this.activeTab === 'forecast') this.activeTab = 'data';
      saveJSON(TAB_STORAGE_KEY, this.activeTab);
    } else {
      this.forecastStale = true;
    }
    this.renderChrome();
    this.render();
    if (enabled && this.activeTab === 'forecast') void this.loadForecast(false);
  }

  private resetForecast(): void {
    this.forecastController?.abort();
    this.forecastController = undefined;
    this.forecastLoadSeq += 1;
    this.forecastRecords = undefined;
    this.forecastResult = undefined;
    this.forecastStatus = undefined;
    this.forecastStatusFetchedAt = 0;
    this.forecastStatusError = '';
    this.forecastLoading = false;
    this.forecastError = '';
    this.forecastStale = true;
  }

  private async loadForecastStatus(force: boolean): Promise<GoQuotaStatus | undefined> {
    if (!force && this.forecastStatus && Date.now() - this.forecastStatusFetchedAt < 60_000) {
      return this.forecastStatus;
    }
    const workspaceID = this.workspaceID;
    if (!workspaceID) return undefined;
    this.forecastController?.abort();
    const controller = new AbortController();
    this.forecastController = controller;
    try {
      const status = await getGoQuotaStatus(workspaceID, controller.signal);
      if (this.workspaceID !== workspaceID || controller.signal.aborted) return undefined;
      this.forecastStatus = status;
      this.forecastStatusFetchedAt = Date.now();
      this.forecastStatusError = '';
      return status;
    } catch (error) {
      if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return undefined;
      this.forecastStatus = undefined;
      this.forecastStatusFetchedAt = Date.now();
      this.forecastStatusError = error instanceof Error ? error.message : String(error);
      this.logger.warn('log.goStatusFailed', { error: this.forecastStatusError });
      return undefined;
    } finally {
      if (this.forecastController === controller) this.forecastController = undefined;
    }
  }

  private async loadForecast(force: boolean): Promise<void> {
    if (!this.open || !this.experimentalForecast || !this.workspaceID) return;
    if (this.forecastLoading) return;
    if (!force && !this.forecastStale && this.forecastResult) {
      this.renderForecast();
      return;
    }
    const workspaceID = this.workspaceID;
    const loadSeq = ++this.forecastLoadSeq;
    this.forecastLoading = true;
    this.forecastError = '';
    this.renderForecast();
    try {
      const [pricing, records, status] = await Promise.all([
        this.ensurePricing(),
        getAllRecords(workspaceID),
        this.loadForecastStatus(force),
      ]);
      if (loadSeq !== this.forecastLoadSeq || this.workspaceID !== workspaceID) return;
      if (!pricing) {
        throw new Error(this.pricingError || t(this.language, 'data.pricingEmpty'));
      }
      this.forecastRecords = records;
      this.forecastResult = buildQuotaForecast({
        records,
        pricing,
        filters: this.filters,
        status,
        syncState: this.syncState,
        statusError: this.forecastStatusError,
        now: Date.now(),
      });
      this.forecastStale = false;
      this.logger.info('log.forecastUpdated', { n: this.forecastResult.models.length });
    } catch (error) {
      if (loadSeq === this.forecastLoadSeq) {
        this.forecastError = error instanceof Error ? error.message : String(error);
        this.logger.warn('log.forecastFailed', { error: this.forecastError });
      }
    } finally {
      if (loadSeq === this.forecastLoadSeq) {
        this.forecastLoading = false;
        this.renderForecast();
      }
    }
  }

  private renderForecast(): void {
    if (!this.open || !this.experimentalForecast || !this.forecastPanel) return;
    if (!this.workspaceID) {
      this.forecastPanel.renderEmpty(this.language, t(this.language, 'error.workspace'), t(this.language, 'forecast.emptyHint'));
      return;
    }
    if (this.forecastLoading) {
      this.forecastPanel.renderLoading(this.language);
      return;
    }
    if (this.forecastError) {
      this.forecastPanel.renderError(this.language, this.forecastError, () => void this.loadForecast(true));
      return;
    }
    if (!this.forecastRecords || !this.pricing) {
      this.forecastPanel.renderEmpty(this.language);
      return;
    }
    this.forecastResult = buildQuotaForecast({
      records: this.forecastRecords,
      pricing: this.pricing,
      filters: this.filters,
      status: this.forecastStatus,
      syncState: this.syncState,
      statusError: this.forecastStatusError,
      now: Date.now(),
    });
    if (!this.forecastRecords.length) {
      this.forecastPanel.renderEmpty(this.language);
      return;
    }
    if (!this.forecastResult.models.length) {
      this.forecastPanel.renderEmpty(this.language, t(this.language, 'forecast.noModels'), t(this.language, 'forecast.emptyHint'));
      return;
    }
    this.forecastPanel.render(
      this.forecastResult,
      this.filters.model,
      this.language,
      (model) => {
        this.filters.model = model;
        this.requestPage = 1;
        this.persistPreferences();
        this.renderFilters();
        this.render();
      },
      () => void this.loadForecast(true),
    );
  }

  private setTab(tab: TabKey): void {
    if (tab === 'forecast' && !this.experimentalForecast) tab = 'data';
    this.activeTab = tab;
    hideChartTooltip(this.chartTooltip);
    saveJSON(TAB_STORAGE_KEY, tab);
    for (const [key, tabButton] of this.tabButtons) {
      tabButton.classList.toggle('ocgo-active', key === tab);
      if (key === 'forecast') tabButton.hidden = !this.experimentalForecast;
    }
    for (const [key, view] of this.views) view.classList.toggle('ocgo-active', key === tab);
    if (this.rangeControl) this.rangeControl.hidden = tab === 'forecast';
    this.customRange?.classList.toggle('ocgo-show', tab !== 'forecast' && this.rangePreset === 'custom');
    if (tab === 'data') this.renderData();
    if (tab === 'requests') this.renderRequests();
    if (tab === 'forecast' && this.open) {
      if (this.forecastStale || !this.forecastResult) void this.loadForecast(false);
      else this.renderForecast();
    }
  }

  private setLanguage(language: Language): void {
    this.language = language;
    saveJSON(LANGUAGE_STORAGE_KEY, language);
    const badge = this.forecastTab?.querySelector('.ocgo-tab-badge');
    if (badge) badge.textContent = t(language, 'badge.beta');
    hideChartTooltip(this.chartTooltip);
    this.renderChrome();
    this.render();
  }

  private persistPreferences(): void {
    saveJSON(RANGE_STORAGE_KEY, this.rangePreset);
    saveJSON(FILTERS_STORAGE_KEY, this.filters);
    saveJSON(TAB_STORAGE_KEY, this.activeTab);
    saveJSON(LANGUAGE_STORAGE_KEY, this.language);
  }

  private ensureCustomRange(): void {
    if (!this.customFrom || !this.customTo) return;
    if (!this.customFrom.value) this.customFrom.value = localInputValue(Date.now() - RETENTION_DAYS * 86_400_000);
    if (!this.customTo.value) this.customTo.value = localInputValue(Date.now());
    this.persisted.customFrom = this.customFrom.value;
    this.persisted.customTo = this.customTo.value;
    saveJSON(PANEL_STATE_KEY, this.persisted);
  }

  private customRangeError(): string {
    if (this.rangePreset !== 'custom') return '';
    const fromValue = this.customFrom?.value?.trim() ?? '';
    const toValue = this.customTo?.value?.trim() ?? '';
    if (!fromValue || !toValue) return t(this.language, 'data.customInvalid');
    const from = new Date(fromValue).getTime();
    const to = new Date(toValue).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      return t(this.language, 'data.customInvalid');
    }
    return '';
  }
  private currentRange(): TimeRange {
    if (this.rangePreset === 'custom' && this.customFrom && this.customTo) {
      return makeTimeRange(
        'custom',
        this.customFrom.value ? new Date(this.customFrom.value).getTime() : undefined,
        this.customTo.value ? new Date(this.customTo.value).getTime() : undefined,
      );
    }
    return makeTimeRange(this.rangePreset);
  }

  private renderChrome(): void {
    if (!this.panel) return;
    for (const [key, nodes] of this.i18nNodes) {
      for (const element of nodes) element.textContent = t(this.language, key);
    }
    if (this.fab) {
      const label = t(this.language, this.open ? 'app.close' : 'app.open');
      this.fab.title = label;
      this.fab.setAttribute('aria-label', label);
      this.fab.setAttribute('aria-expanded', String(this.open));
    }
    this.chartZoomOut?.setAttribute('aria-label', t(this.language, 'chart.zoomOut'));
    this.chartZoomIn?.setAttribute('aria-label', t(this.language, 'chart.zoomIn'));
    this.chartZoomValue?.setAttribute('aria-label', t(this.language, 'chart.zoomReset'));
    if (this.langSelect) this.langSelect.value = this.language;
    if (this.rangeSelect) this.rangeSelect.value = this.rangePreset;
    if (this.syncButton) {
      this.syncButton.textContent = this.busy ? t(this.language, 'status.stop') : t(this.language, 'status.syncNow');
      this.syncButton.classList.toggle('ocgo-stop', this.busy);
      this.syncButton.disabled = !this.workspaceID;
    }
    this.customRange?.classList.toggle('ocgo-show', this.rangePreset === 'custom' && this.activeTab !== 'forecast');
    if (this.experimentalCheckbox) this.experimentalCheckbox.checked = this.experimentalForecast;
    if (this.forecastTab) this.forecastTab.hidden = !this.experimentalForecast;
    const workspace = this.workspaces.find((item) => item.id === this.workspaceID);
    if (this.workspaceLabel) {
      this.workspaceLabel.textContent = workspace?.name || this.workspaceID || t(this.language, 'error.workspace');
      this.workspaceLabel.title = this.workspaceID || '';
    }
    this.setTab(this.activeTab);
  }

  private renderFilters(): void {
    const options = filterOptions(this.records);
    this.fillSelect(this.modelSelect, options.models, this.filters.model, (value) => {
      this.filters.model = value;
    });
    this.fillSelect(this.providerSelect, options.providers, this.filters.provider, (value) => {
      this.filters.provider = value;
    });
    if (this.userSelect) {
      this.userSelect.replaceChildren();
      const all = node('option', '', t(this.language, 'filter.all'));
      all.value = '';
      this.userSelect.appendChild(all);
      for (const user of options.users) {
        const rawID = user.key.replace(/^(account:|user:)/, '');
        const principal = this.principals.find((item) => item.userId === rawID || item.serviceUserId === rawID);
        const label = principal?.name || principal?.email || user.label;
        const option = node('option', '', label);
        option.value = user.key;
        this.userSelect.appendChild(option);
      }
      this.userSelect.value = options.users.some((user) => user.key === this.filters.userKey) ? this.filters.userKey : '';
      if (!this.userSelect.value) this.filters.userKey = '';
    }
  }

  private fillSelect(select: HTMLSelectElement | undefined, values: string[], selected: string, setter: (value: string) => void): void {
    if (!select) return;
    select.replaceChildren();
    const all = node('option', '', t(this.language, 'filter.all'));
    all.value = '';
    select.appendChild(all);
    for (const value of values) {
      const option = node('option', '', value || '—');
      option.value = value;
      select.appendChild(option);
    }
    select.value = values.includes(selected) ? selected : '';
    if (!select.value) setter('');
  }
  private render(): void {
    if (!this.panel) return;
    this.rangeError = this.customRangeError();
    this.renderChrome();
    this.renderFilters();
    this.range = this.currentRange();
    this.analysis = aggregateRecords(this.records, this.filters, this.range.from, this.range.to, this.range.bucketMs);
    this.renderStatus();
    this.renderError();
    this.renderOverview();
    this.renderCharts();
    this.renderRequests();
    if (this.activeTab === 'data') this.renderData();
    if (this.activeTab === 'forecast') this.renderForecast();
  }

  private renderStatus(): void {
    if (!this.statusDot || !this.statusText) return;
    this.statusDot.className = 'ocgo-status-dot';
    if (this.rangeError) {
      this.statusDot.classList.add('err');
      this.statusText.textContent = this.rangeError;
      return;
    }
    if (this.busy) {
      this.statusDot.classList.add('busy');
      this.statusText.textContent = this.progress
        ? t(this.language, 'status.syncing', { page: this.progress.page, n: this.progress.fetched })
        : t(this.language, 'error.loading');
      return;
    }
    if (this.errorMessage) {
      this.statusDot.classList.add('err');
      this.statusText.textContent = this.errorMessage;
      return;
    }
    if (!this.workspaceID) {
      this.statusText.textContent = t(this.language, 'error.workspace');
      return;
    }
    if (this.syncState?.lastSuccessfulSyncAt) this.statusDot.classList.add('ok');
    const syncText = this.syncState?.lastSuccessfulSyncAt
      ? t(this.language, 'status.lastSync', { time: formatRelative(this.syncState.lastSuccessfulSyncAt, Date.now(), this.language) })
      : t(this.language, 'status.never');
    this.statusText.textContent = `${t(this.language, 'status.records', { n: formatNumber(this.totalRecordCount) })} · ${syncText}`;
  }

  private renderError(): void {
    if (!this.errorBox) return;
    const message = this.rangeError || this.errorMessage;
    this.errorBox.classList.toggle('ocgo-hidden', !message);
    this.errorBox.textContent = message;
  }

  private renderOverview(): void {
    if (!this.cards || !this.analysis) return;
    const summary = this.analysis.summary;
    this.cards.replaceChildren();
    const card = (label: string, value: string, sub?: string, tone = '') => {
      const element = node('div', `ocgo-card ${tone}`.trim());
      element.append(node('div', 'ocgo-card-label', label), node('div', 'ocgo-card-value', value));
      if (sub) element.appendChild(node('div', 'ocgo-card-sub', sub));
      return element;
    };
    const success = formatPercent(summary.successRate);
    const failures = t(this.language, 'metric.failures', { n: summary.failed });
    const tpsValue = summary.tpsAvg === null || summary.tpsSlowest === null
      ? 'N/A'
      : `${summary.tpsAvg.toFixed(1)} / ${summary.tpsSlowest.toFixed(1)} tok/s`;
    const cards = [
      card(t(this.language, 'metric.requests'), formatNumber(summary.requests), `${t(this.language, 'metric.successRate')} ${success} · ${failures}`),
      card(t(this.language, 'metric.cost'), formatUsd(summary.costUsd), summary.requests ? `≈ ${formatUsd(summary.costUsd / summary.requests)} / request` : '—'),
      card(t(this.language, 'metric.input'), formatCompact(summary.inputTokens), undefined, 'blue'),
      card(t(this.language, 'metric.output'), formatCompact(summary.outputTokens)),
      card(t(this.language, 'metric.ttft'), `${formatMs(summary.ttftAvg)} / ${formatMs(summary.ttftSlowest)}`, t(this.language, 'metric.samples', { n: summary.ttftSamples }), 'blue'),
      card(t(this.language, 'metric.tps'), tpsValue, t(this.language, 'metric.samples', { n: summary.tpsSamples }), 'violet'),
    ];
    if (summary.cacheWriteTokens > 0) {
      cards.push(card(t(this.language, 'metric.cacheWrite'), formatCompact(summary.cacheWriteTokens)));
    }
    cards.push(
      card(t(this.language, 'metric.cacheRead'), formatCompact(summary.cacheReadTokens)),
      card(t(this.language, 'metric.cacheHitRate'), formatPercent(summary.cacheHitRate, 2), undefined, 'accent'),
    );
    this.cards.append(...cards);
    if (this.overviewLegacyNote) {
      this.overviewLegacyNote.style.display = this.records.some((record) => record.legacy) ? '' : 'none';
    }
    this.renderModelTable(this.overviewModels, this.analysis.models);
  }

  private renderCharts(): void {
    if (!this.analysis) return;
    const buckets = this.analysis.buckets;
    if (this.charts[0]) renderTokenMix(this.charts[0], buckets, this.language, this.chartTooltip);
    if (this.charts[1]) renderCacheChart(this.charts[1], buckets, this.language, this.chartTooltip);
    if (this.charts[2]) renderLatencyChart(this.charts[2], buckets, this.language, this.chartTooltip);
    if (this.charts[3]) renderTpsChart(this.charts[3], buckets, this.language, this.chartTooltip);
    this.renderChartAverages();
    this.renderModelTable(this.chartModels, this.analysis.models);
  }

  private renderChartAverages(): void {
    if (!this.analysis || !this.range) return;
    const buckets = this.analysis.buckets;
    const rate = tokenRateForRange(buckets, this.range.from, this.range.to);
    const tokenAverage = rate
      ? t(this.language, 'chart.avgTokens', {
        value: formatCompact(rate.value),
        unit: t(this.language, rate.unit === 'h' ? 'chart.unitHour' : 'chart.unitDay'),
      })
      : t(this.language, 'chart.avgCache', { value: 'N/A' });
    const summary = this.analysis.summary;
    const cacheAverage = averageBucketMetric(buckets, (bucket) => bucket.cacheHitRate);
    const text = new Map<string, string>([
      ['chart.tokens', tokenAverage],
      ['chart.cache', t(this.language, 'chart.avgCache', { value: formatPercent(cacheAverage, 2) })],
      ['chart.ttft', t(this.language, 'chart.avgTtft', { avg: formatMs(summary.ttftAvg), slowest: formatMs(summary.ttftSlowest) })],
      ['chart.tps', t(this.language, 'chart.avgTps', { avg: formatTps(summary.tpsAvg), slowest: formatTps(summary.tpsSlowest) })],
    ]);
    for (const [key, value] of text) {
      const target = this.chartAverages.get(key);
      if (target) target.textContent = value;
    }
  }

  private renderModelTable(container: HTMLElement | undefined, models: ModelSummary[]): void {
    if (!container) return;
    container.replaceChildren();
    const visibleModels = models.filter((model) => model.totalTokens > 0);
    if (!visibleModels.length) {
      container.appendChild(this.empty(t(this.language, 'table.emptyHint'), 'table.empty'));
      return;
    }
    const table = node('table', 'ocgo-table');
    const head = node('thead');
    const headRow = node('tr');
    const columns = [
      ['table.model', 'left'],
      ['table.provider', 'left'],
      ['table.requests', ''],
      ['table.totalTokens', ''],
      ['table.success', ''],
      ['table.hitRate', ''],
      ['table.ttftAvg', ''],
      ['table.tpsAvg', ''],
      ['table.cost', ''],
    ] as const;
    for (const [key, align] of columns) headRow.appendChild(node('th', align, t(this.language, key)));
    head.appendChild(headRow);
    const body = node('tbody');
    for (const model of visibleModels) {
      const row = node('tr');
      const totalTokens = node('td', 'ocgo-metric-hover', formatCompact(model.totalTokens));
      const cost = node('td', 'ocgo-metric-hover', formatUsd(model.costUsd));
      this.bindModelMetricTooltip(totalTokens, model, 'tokens');
      this.bindModelMetricTooltip(cost, model, 'cost');
      row.append(
        node('td', 'left', model.model),
        node('td', 'left', model.provider || '—'),
        node('td', '', formatNumber(model.requests)),
        totalTokens,
        node('td', '', formatPercent(model.successRate, 1)),
        node('td', '', formatPercent(model.cacheHitRate, 2)),
        node('td', '', formatMs(model.ttftAvg)),
        node('td', '', formatTps(model.tpsAvg)),
        cost,
      );
      body.appendChild(row);
    }
    table.append(head, body);
    container.appendChild(table);
  }

  private bindModelMetricTooltip(
    cell: HTMLElement,
    model: ModelSummary,
    kind: 'tokens' | 'cost',
  ): void {
    cell.tabIndex = 0;
    const data = this.modelMetricTooltip(model, kind);
    cell.setAttribute('aria-label', [data.head, ...data.rows.map(([label, value]) => `${label} ${value}`), data.footer]
      .filter(Boolean)
      .join(' · '));
    const show = (x: number, y: number) => {
      if (!this.chartTooltip || !this.panel) return;
      showDataTooltip(this.chartTooltip, data.head, data.rows, this.panel, x, y, data.footer);
    };
    cell.addEventListener('pointerenter', (event) => show(event.clientX, event.clientY));
    cell.addEventListener('pointermove', (event) => show(event.clientX, event.clientY));
    cell.addEventListener('pointerleave', () => hideChartTooltip(this.chartTooltip));
    cell.addEventListener('focus', () => {
      const rect = cell.getBoundingClientRect();
      show(rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    cell.addEventListener('blur', () => hideChartTooltip(this.chartTooltip));
  }

  private modelMetricTooltip(
    model: ModelSummary,
    kind: 'tokens' | 'cost',
  ): { head: string; rows: Array<[string, string]>; footer?: string } {
    const head = t(this.language, kind === 'tokens' ? 'tooltip.tokensTitle' : 'tooltip.costTitle', {
      model: model.model,
    });
    if (kind === 'tokens') {
      return {
        head,
        rows: [
          [t(this.language, 'table.totalTokens'), formatNumber(model.totalTokens)],
          [t(this.language, 'table.input'), formatNumber(model.inputTokens)],
          [t(this.language, 'table.cacheRead'), formatNumber(model.cacheReadTokens)],
          [t(this.language, 'table.cacheWrite'), formatNumber(model.cacheWriteTokens)],
          [t(this.language, 'table.output'), formatNumber(model.outputTokens)],
        ],
      };
    }
    const breakdown = estimateModelCostBreakdown(this.analysis?.records ?? [], model, this.pricing?.tiers);
    if (!breakdown) {
      return {
        head,
        rows: [[t(this.language, 'table.cost'), formatUsd(model.costUsd)]],
        footer: t(this.language, 'tooltip.costUnavailable'),
      };
    }
    return {
      head,
      rows: [
        [t(this.language, 'tooltip.inputCost'), formatUsd(breakdown.input)],
        [t(this.language, 'tooltip.outputCost'), formatUsd(breakdown.output)],
        [t(this.language, 'tooltip.cacheReadCost'), formatUsd(breakdown.cacheRead)],
        [t(this.language, 'tooltip.cacheWriteCost'), formatUsd(breakdown.cacheWrite)],
        [t(this.language, 'table.cost'), formatUsd(breakdown.total)],
      ],
      footer: `${t(this.language, 'tooltip.estimated')} · ${t(this.language, 'tooltip.estimatedHint')}`,
    };
  }

  private renderRequests(): void {
    if (!this.requestsTable || !this.requestPager || !this.analysis) return;
    const records = this.analysis.records;
    const pageSize = 100;
    const pages = Math.max(1, Math.ceil(records.length / pageSize));
    this.requestPage = Math.max(1, Math.min(pages, this.requestPage));
    const start = (this.requestPage - 1) * pageSize;
    const pageRecords = records.slice(start, start + pageSize);
    this.requestsTable.replaceChildren();
    if (!pageRecords.length) {
      this.requestsTable.appendChild(this.empty(t(this.language, 'table.emptyHint'), 'table.empty'));
    } else {
      const table = node('table', 'ocgo-table');
      const head = node('thead');
      const headRow = node('tr');
      const columns = [
        ['table.time', 'left'],
        ['table.status', 'left'],
        ['table.model', 'left'],
        ['table.provider', 'left'],
        ['table.ttft', ''],
        ['table.tps', ''],
        ['table.input', ''],
        ['table.cacheRead', ''],
        ['table.cacheWrite', ''],
        ['table.output', ''],
        ['table.cost', ''],
        ['table.user', 'left'],
        ['table.open', ''],
      ] as const;
      for (const [key, align] of columns) headRow.appendChild(node('th', align, t(this.language, key)));
      head.appendChild(headRow);
      const body = node('tbody');
      for (const record of pageRecords) {
        const row = node('tr');
        const status = node('td', 'left');
        status.appendChild(node('span', `ocgo-pill ${record.outcome}`, record.outcome));
        if (record.legacy) {
          const legacy = node('span', 'ocgo-pill legacy', t(this.language, 'badge.legacy'));
          legacy.style.marginLeft = '4px';
          status.appendChild(legacy);
        }
        const user = this.principalLabel(record);
        const detail = node('td');
        if (!record.legacy && record.startedAt >= Date.now() - RETENTION_DAYS * 86_400_000) {
          const link = node('a', '', '↗');
          link.href = `${location.origin}/console/${record.workspaceID}/logs?range=30d&category=inference&log=${encodeURIComponent(record.id)}`;
          link.target = '_blank';
          link.rel = 'noreferrer';
          link.title = t(this.language, 'table.open');
          link.addEventListener('click', () => this.setOpen(false));
          detail.appendChild(link);
        } else {
          detail.textContent = '—';
        }
        row.append(
          node('td', 'left', formatDateTime(record.startedAt)),
          status,
          node('td', 'left', record.model || record.requestedModel || '—'),
          node('td', 'left', record.provider || '—'),
          node('td', '', formatMs(computeTtft(record))),
          node('td', '', formatTps(computeTps(record))),
          node('td', '', formatCompact(record.inputTokens)),
          node('td', '', formatCompact(record.cacheReadTokens)),
          node('td', '', formatCompact(record.cacheWriteTokens + record.cacheWrite1hTokens)),
          node('td', '', formatCompact(record.outputTokens)),
          node('td', '', formatUsd(record.costUsd)),
          node('td', 'left', user),
          detail,
        );
        body.appendChild(row);
      }
      table.append(head, body);
      this.requestsTable.appendChild(table);
    }
    this.requestPager.replaceChildren();
    const info = node('span', '', t(this.language, 'table.page', { page: this.requestPage, pages }));
    const previous = button(t(this.language, 'table.prev'));
    previous.disabled = this.requestPage <= 1;
    previous.addEventListener('click', () => {
      this.requestPage -= 1;
      this.renderRequests();
    });
    const next = button(t(this.language, 'table.next'));
    next.disabled = this.requestPage >= pages;
    next.addEventListener('click', () => {
      this.requestPage += 1;
      this.renderRequests();
    });
    this.requestPager.append(previous, info, next);
  }
  private renderData(): void {
    if (!this.dataInfo || !this.dataActions) return;
    if (this.experimentalCheckbox) this.experimentalCheckbox.checked = this.experimentalForecast;
    this.dataInfo.replaceChildren();
    const state = this.syncState;
    const info = node('dl', 'ocgo-kv');
    const add = (label: string, value: string) => {
      info.append(node('dt', '', label), node('dd', '', value));
    };
    const workspace = this.workspaces.find((item) => item.id === this.workspaceID);
    add(t(this.language, 'data.workspace'), workspace ? `${workspace.name} (${workspace.id})` : this.workspaceID || '—');
    add(t(this.language, 'data.recordCount'), formatNumber(this.totalRecordCount));
    add(t(this.language, 'status.official', { n: state?.retentionDays ?? RETENTION_DAYS }), t(this.language, 'data.retentionNote'));
    add(t(this.language, 'status.lastSync', { time: state?.lastSuccessfulSyncAt ? formatRelative(state.lastSuccessfulSyncAt, Date.now(), this.language) : t(this.language, 'status.never') }), '');
    if (state?.coverageStart !== undefined || state?.coverageEnd !== undefined) {
      add(
        t(this.language, 'status.coverage', {
          from: state?.coverageStart !== undefined ? formatDateTime(state.coverageStart) : '—',
          to: state?.coverageEnd !== undefined ? formatDateTime(state.coverageEnd) : '—',
        }),
        '',
      );
    }
    this.dataInfo.appendChild(info);
    if (!state?.backfillComplete && this.workspaceID) {
      this.dataInfo.appendChild(node('div', 'ocgo-warning', t(this.language, 'status.partial')));
    }
    if (state?.gapDetected) {
      this.dataInfo.appendChild(node('div', 'ocgo-warning', t(this.language, 'status.gap', { n: state.retentionDays || RETENTION_DAYS })));
    }
    if (this.records.some((record) => record.legacy)) {
      this.dataInfo.appendChild(node('p', 'ocgo-note', t(this.language, 'legacy.note')));
    }
    this.dataInfo.appendChild(node('p', 'ocgo-note', t(this.language, 'data.privacy')));
    const storageNote = node('p', 'ocgo-note');
    this.storageNote = storageNote;
    this.dataInfo.appendChild(storageNote);

    this.dataActions.replaceChildren();
    const syncNow = button(t(this.language, 'status.syncNow'));
    syncNow.disabled = this.busy || !this.workspaceID;
    syncNow.addEventListener('click', () => void this.sync(false));
    const syncFull = button(t(this.language, 'status.syncFull'));
    syncFull.disabled = this.busy || !this.workspaceID;
    syncFull.addEventListener('click', () => void this.sync(true));
    const exportCsv = button(t(this.language, 'data.exportCsv'));
    exportCsv.disabled = !this.analysis?.records.length;
    exportCsv.addEventListener('click', () => this.exportCsv());
    const exportJson = button(t(this.language, 'data.exportJson'));
    exportJson.disabled = !this.totalRecordCount;
    exportJson.addEventListener('click', () => void this.exportJson());
    const clear = button(this.clearArmed ? t(this.language, 'data.clearConfirm') : t(this.language, 'data.clear'), 'ocgo-danger-btn');
    clear.classList.toggle('ocgo-confirm', this.clearArmed);
    clear.disabled = this.busy || Boolean(this.syncPromise) || !this.workspaceID;
    clear.addEventListener('click', () => void this.clearHistory());
    const copy = button(t(this.language, 'data.copyLogs'));
    copy.addEventListener('click', () => void this.copyLogs());
    this.dataActions.append(syncNow, syncFull, exportCsv, exportJson, clear, copy);
    void storageEstimate().then(({ usage }) => {
      if (this.storageNote === storageNote) {
        storageNote.textContent = t(this.language, 'data.storage', { size: formatBytes(usage) });
      }
    });
    this.renderLogs();
    this.renderPricing();
  }

  private renderPricing(): void {
    if (!this.pricingPanel) return;
    this.pricingPanel.replaceChildren();
    if (!this.pricing) {
      this.pricingPanel.appendChild(node(
        'p',
        'ocgo-note',
        t(this.language, this.pricingLoading ? 'data.pricingLoading' : 'data.pricingEmpty'),
      ));
      if (this.pricingError && !this.pricingLoading) {
        this.pricingPanel.appendChild(node('p', 'ocgo-warning', t(this.language, 'data.pricingError', { error: this.pricingError })));
      }
      return;
    }

    const tiers = [...this.pricing.tiers].sort((a, b) => {
      const modelOrder = a.displayName.localeCompare(b.displayName);
      if (modelOrder !== 0) return modelOrder;
      const periodOrder = (a.period ?? '').localeCompare(b.period ?? '');
      if (periodOrder !== 0) return periodOrder;
      return (a.minContextTokens ?? 0) - (b.minContextTokens ?? 0);
    });
    const modelCount = new Set(tiers.map((tier) => tier.modelID)).size;
    const meta = node('div', 'ocgo-pricing-meta');
    meta.appendChild(node('span', '', t(this.language, 'data.pricingMeta', {
      time: formatDateTime(this.pricing.fetchedAt),
      n: modelCount,
    })));
    const source = node('a', '', t(this.language, 'data.pricingSource'));
    source.href = this.pricing.source;
    source.target = '_blank';
    source.rel = 'noreferrer';
    meta.appendChild(source);
    this.pricingPanel.appendChild(meta);
    if (this.pricingError) {
      this.pricingPanel.appendChild(node('p', 'ocgo-warning', t(this.language, 'data.pricingError', { error: this.pricingError })));
    }

    const wrap = node('div', 'ocgo-table-wrap ocgo-pricing-table-wrap');
    const table = node('table', 'ocgo-table ocgo-pricing-table');
    const head = node('thead');
    const headRow = node('tr');
    const columns = [
      ['data.pricingModel', 'left'],
      ['data.pricingPeriod', 'left'],
      ['data.pricingContext', 'left'],
      ['data.pricingInput', ''],
      ['data.pricingOutput', ''],
      ['data.pricingCacheRead', ''],
      ['data.pricingCacheWrite', ''],
    ] as const;
    for (const [key, align] of columns) headRow.appendChild(node('th', align, t(this.language, key)));
    head.appendChild(headRow);
    const body = node('tbody');
    for (const tier of tiers) {
      const period = tier.period
        ? t(this.language, tier.period === 'peak' ? 'data.pricingPeak' : 'data.pricingOffPeak')
        : t(this.language, 'data.pricingAllDay');
      const context = tier.maxContextTokens !== undefined
        ? `≤ ${formatCompact(tier.maxContextTokens)}`
        : tier.minContextTokens !== undefined
          ? `> ${formatCompact(Math.max(0, tier.minContextTokens - 1))}`
          : t(this.language, 'data.pricingAllContext');
      const periodCell = node('td', 'left');
      periodCell.appendChild(node('span', `ocgo-price-period ${tier.period ?? 'all'}`, period));
      const row = node('tr');
      row.append(
        node('td', 'left', tier.displayName),
        periodCell,
        node('td', 'left', context),
        node('td', '', formatUsd(tier.input)),
        node('td', '', formatUsd(tier.output)),
        node('td', '', formatUsd(tier.cacheRead)),
        node('td', '', formatUsd(tier.cacheWrite)),
      );
      body.appendChild(row);
    }
    table.append(head, body);
    wrap.appendChild(table);
    this.pricingPanel.appendChild(wrap);
  }

  private renderLogs(): void {
    if (!this.logList) return;
    const entries = this.logger.all().slice(-80);
    this.logList.replaceChildren();
    if (!entries.length) {
      this.logList.textContent = t(this.language, 'data.noLogs');
      return;
    }
    const formatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    for (const entry of entries) {
      const row = node('div', 'ocgo-log-row');
      row.append(
        node('span', 'ocgo-log-time', formatter.format(new Date(entry.time))),
        node('span', `ocgo-log-level ${entry.level}`, t(this.language, `log.level.${entry.level}`)),
        node('span', 'ocgo-log-msg', formatLogEntry(entry, this.language)),
      );
      this.logList.appendChild(row);
    }
    this.logList.scrollTop = this.logList.scrollHeight;
  }

  private empty(message: string, titleKey = 'empty.title'): HTMLElement {
    const empty = node('div', 'ocgo-empty');
    const strong = node('strong', '', t(this.language, titleKey));
    const description = node('span', '', message);
    empty.append(strong, description);
    return empty;
  }

  async refreshRoute(): Promise<void> {
    const workspaceID = getWorkspaceID();
    const changed = workspaceID !== this.workspaceID;
    if (!changed) {
      this.render();
      return;
    }
    this.workspaceID = workspaceID;
    this.resetForecast();
    this.principals = [];
    this.errorMessage = workspaceID ? '' : t(this.language, 'error.workspace');
    this.requestPage = 1;
    this.busy = false;
    this.progress = undefined;
    const previousSync = this.syncPromise;
    this.controller?.abort();
    this.controller = undefined;
    if (previousSync) await previousSync.catch(() => undefined);
    if (!workspaceID) {
      this.records = [];
      this.totalRecordCount = 0;
      this.syncState = undefined;
      this.render();
      return;
    }
    try {
      try {
        const migrated = await migrateLegacyUsage(workspaceID);
        if (migrated) this.logger.info('log.migrated', { n: migrated });
      } catch (error) {
        this.logger.warn('log.migrationSkipped', { error: error instanceof Error ? error.message : String(error) });
      }
      await this.reloadRecords();
      if (this.open && this.activeTab === 'forecast') void this.loadForecast(false);
      void this.refreshWorkspaces();
      void this.refreshPrincipals();
      if (this.open) window.setTimeout(() => this.autoSyncIfStale(), 200);
    } catch (error) {
      this.setError(error);
    }
  }

  private principalLabel(record: RequestRecord): string {
    if (record.serviceAccountID) {
      const principal = this.principals.find((item) => item.serviceUserId === record.serviceAccountID);
      return principal?.name || principal?.email || shortID(record.serviceAccountID);
    }
    if (record.userID) {
      const principal = this.principals.find((item) => item.userId === record.userID);
      return principal?.name || principal?.email || shortID(record.userID);
    }
    return '—';
  }

  async refreshPrincipals(): Promise<void> {
    const currentWorkspaceID = this.workspaceID;
    if (!currentWorkspaceID) return;
    this.principalsController?.abort();
    const controller = new AbortController();
    this.principalsController = controller;
    try {
      const principals = await listUsagePrincipals(currentWorkspaceID, controller.signal);
      if (this.workspaceID !== currentWorkspaceID || controller.signal.aborted) return;
      this.principals = principals;
      this.renderFilters();
      this.renderRequests();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.logger.warn('log.principalSkipped', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  async refreshWorkspaces(): Promise<void> {
    try {
      this.workspaces = await listWorkspaces();
      const workspace = this.workspaces.find((item) => item.id === this.workspaceID);
      if (workspace) this.logger.info('log.workspace', { name: workspace.name });
      this.renderChrome();
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        this.logger.warn('log.workspaceListFailed', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private async reloadRecords(): Promise<void> {
    const loadSeq = ++this.rangeLoadSeq;
    const workspaceID = this.workspaceID;
    if (!workspaceID) {
      this.records = [];
      this.totalRecordCount = 0;
      this.syncState = undefined;
      this.render();
      return;
    }
    const range = this.currentRange();
    const [records, totalRecordCount, syncState] = await Promise.all([
      getRecords(workspaceID, range.from, range.to),
      countRecords(workspaceID),
      getSyncState(workspaceID),
    ]);
    if (loadSeq !== this.rangeLoadSeq || this.workspaceID !== workspaceID) return;
    this.records = records;
    this.totalRecordCount = totalRecordCount;
    this.syncState = syncState;
    this.render();
    void this.ensurePricing();
  }

  sync(full: boolean): Promise<void> {
    if (this.syncPromise) return this.syncPromise;
    let tracked: Promise<void>;
    tracked = this.runSync(full).finally(() => {
      if (this.syncPromise === tracked) this.syncPromise = undefined;
    });
    this.syncPromise = tracked;
    return tracked;
  }

  private async runSync(full: boolean): Promise<void> {
    if (!this.workspaceID) {
      this.errorMessage = t(this.language, 'error.workspace');
      this.render();
      return;
    }
    if (this.busy) return;
    this.busy = true;
    this.errorMessage = '';
    this.progress = { phase: 'starting', page: 0, fetched: 0, saved: 0 };
    this.controller = new AbortController();
    this.renderChrome();
    this.renderStatus();
    this.logger.info(full ? 'log.syncBackfillStart' : 'log.syncIncrementalStart');
    try {
      const result = await syncWorkspace({
        workspaceID: this.workspaceID,
        forceFull: full,
        signal: this.controller.signal,
        onProgress: (progress) => {
          this.progress = progress;
          this.renderStatus();
        },
      });
      await this.reloadRecords();
      this.forecastStale = true;
      if (this.open && this.activeTab === 'forecast') void this.loadForecast(false);
      this.logger.info(result.cacheHit ? 'log.syncCached' : 'log.syncComplete', {
        fetched: result.fetched,
        added: result.added,
        pages: result.pages,
      });
      if (this.open) this.showToast(result.added > 0 ? 'sync.toast.updated' : 'sync.toast.latest', { n: result.added });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        this.logger.warn('log.syncStopped');
      } else {
        this.setError(error);
        this.logger.error('log.error', { error: error instanceof Error ? error.message : String(error) });
      }
      await this.reloadRecords();
      this.forecastStale = true;
      if (this.open && this.activeTab === 'forecast') void this.loadForecast(false);
    } finally {
      this.busy = false;
      this.progress = undefined;
      this.controller = undefined;
      this.renderChrome();
      this.renderStatus();
      if (this.activeTab === 'data') this.renderData();
    }
  }

  stopSync(): void {
    this.controller?.abort();
  }

  private autoSyncIfStale(): void {
    if (!this.hasOpened || !this.workspaceID || this.busy || this.syncPromise) return;
    if (document.visibilityState !== 'visible') return;
    const last = this.syncState?.lastSuccessfulSyncAt ?? 0;
    if (Date.now() - last < 9 * 60 * 1000) return;
    void this.sync(false);
  }

  private startAutoSync(): void {
    if (this.autoInterval) window.clearInterval(this.autoInterval);
    this.autoInterval = window.setInterval(() => this.autoSyncIfStale(), 10 * 60 * 1000);
  }

  private handleVisibility(): void {
    if (document.visibilityState === 'visible') this.autoSyncIfStale();
  }

  handleCaptured(workspaceID: string, count: number): void {
    this.logger.info('status.captured', { n: count });
    if (workspaceID !== this.workspaceID) return;
    this.forecastStale = true;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => {
      void this.reloadRecords();
      if (this.open && this.activeTab === 'forecast') void this.loadForecast(false);
    }, 300);
  }

  private setError(error: unknown): void {
    if (error instanceof ApiError) {
      const key = {
        session: 'error.session',
        permission: 'error.permission',
        cursor: 'error.cursor',
        'rate-limit': 'error.rate',
        'bad-request': 'error.badRequest',
        contract: 'error.contract',
        network: 'error.network',
        server: 'error.unknown',
      }[error.kind];
      this.errorMessage = t(this.language, key, { message: error.message });
    } else {
      this.errorMessage = t(this.language, 'error.unknown', { message: error instanceof Error ? error.message : String(error) });
    }
    this.renderStatus();
    this.renderError();
  }

  private exportCsv(): void {
    if (!this.analysis) return;
    const header = [
      'time', 'status', 'model', 'provider', 'ttft_ms', 'tps', 'input', 'cache_read', 'cache_write', 'cache_write_1h',
      'output', 'reasoning', 'cost_usd', 'user_id', 'service_account_id', 'request_id', 'legacy',
    ];
    const rows = this.analysis.records.map((record) => [
      new Date(record.startedAt).toISOString(),
      record.outcome,
      record.model,
      record.provider,
      computeTtft(record) ?? '',
      computeTps(record) ?? '',
      record.inputTokens,
      record.cacheReadTokens,
      record.cacheWriteTokens,
      record.cacheWrite1hTokens,
      record.outputTokens,
      record.reasoningTokens,
      record.costUsd,
      record.userID,
      record.serviceAccountID,
      record.requestID,
      record.legacy ? 'true' : 'false',
    ]);
    const csv = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
    downloadText(`opencode-lens-${this.workspaceID ?? 'workspace'}-${Date.now()}.csv`, `\uFEFF${csv}`, 'text/csv;charset=utf-8');
    this.logger.info('log.exportCsv', { n: rows.length });
  }

  private async exportJson(): Promise<void> {
    if (!this.workspaceID) return;
    const records = await getAllRecords(this.workspaceID);
    const payload = {
      exportedAt: new Date().toISOString(),
      version: APP_VERSION,
      workspaceID: this.workspaceID,
      syncState: this.syncState,
      records,
    };
    downloadText(
      `opencode-lens-${this.workspaceID}-${Date.now()}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8',
    );
    this.logger.info('log.exportJson', { n: records.length });
  }

  private async clearHistory(): Promise<void> {
    if (!this.workspaceID) return;
    if (!this.clearArmed) {
      this.clearArmed = true;
      this.renderData();
      this.clearTimer = window.setTimeout(() => {
        this.clearArmed = false;
        this.renderData();
      }, 4000);
      return;
    }
    if (this.clearTimer) window.clearTimeout(this.clearTimer);
    this.clearArmed = false;
    if (this.syncPromise) {
      this.stopSync();
      await this.syncPromise.catch(() => undefined);
    }
    await clearWorkspace(this.workspaceID);
    try {
      await clearLegacyUsage(this.workspaceID);
    } catch (error) {
      this.logger.warn('log.legacyCleanupSkipped', { error: error instanceof Error ? error.message : String(error) });
    }
    const workspaceID = this.workspaceID;
    await updateSyncState(workspaceID, () => ({
      workspaceID,
      retentionDays: RETENTION_DAYS,
      backfillComplete: false,
      gapDetected: false,
      legacyImportedAt: Date.now(),
    }));
    this.records = [];
    this.totalRecordCount = 0;
    this.resetForecast();
    this.syncState = await getSyncState(this.workspaceID);
    this.requestPage = 1;
    this.logger.warn('log.historyCleared');
    this.render();
  }

  private async copyLogs(): Promise<void> {
    const text = this.logger.all().map((entry) => `${new Date(entry.time).toISOString()} [${t(this.language, `log.level.${entry.level}`)}] ${formatLogEntry(entry, this.language)}`).join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.logger.info('log.diagnosticsCopied');
    } catch {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
      this.logger.info('log.diagnosticsCopied');
    }
  }
}
























