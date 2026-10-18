import type {
  ForecastChartPoint,
  ForecastWindowForecast,
  ForecastWindowKey,
  ModelQuotaForecast,
  QuotaForecastResult,
} from '../forecast';
import { formatDateTime, formatPercent, formatRelative, formatUsd } from '../format';
import { hideChartTooltip, showDataTooltip } from './charts';
import { t } from '../i18n';
import type { Language } from '../types';

const WINDOW_KEYS: ForecastWindowKey[] = ['fiveHour', 'next24h', 'week', 'month'];
const FORECAST_CHART_WIDTH = 760;
const FORECAST_CHART_HEIGHT = 260;
const FORECAST_CHART_MARGIN = { left: 44, right: 16, top: 16, bottom: 28 };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function windowLabel(language: Language, key: ForecastWindowKey): string {
  return t(language, `forecast.window${key === 'fiveHour' ? 'FiveHour' : key === 'next24h' ? '24h' : key === 'week' ? 'Week' : 'Month'}`);
}

function confidenceLabel(language: Language, model: ModelQuotaForecast): string {
  const key = model.confidence === 'high' ? 'forecast.confidenceHigh' : model.confidence === 'medium' ? 'forecast.confidenceMedium' : 'forecast.confidenceLow';
  return t(language, key);
}

function percentOrUnknown(value: number | null): string {
  return value === null ? '—' : formatPercent(value);
}

function absoluteWindow(window: ForecastWindowForecast): string {
  if (window.limitUsd === null) return formatUsd(window.p50Usd);
  return `${formatUsd(window.p50Usd)} / ${formatUsd(window.limitUsd)}`;
}

function quantileTitle(window: ForecastWindowForecast, language: Language): string {
  return t(language, 'forecast.p10p50p90', {
    p10: formatUsd(window.p10Usd),
    p50: formatUsd(window.p50Usd),
    p90: formatUsd(window.p90Usd),
  });
}

function resetText(language: Language, window: ForecastWindowForecast, model: ModelQuotaForecast): string {
  if (window.key === 'next24h') {
    const now = Date.now();
    const boundaries = [
      model.windows.fiveHour.resetsAt,
      model.windows.week.resetsAt,
      model.windows.month.resetsAt,
    ].filter((value): value is number => value !== undefined && value > now && value <= now + 24 * 60 * 60 * 1000);
    return `${t(language, 'forecast.percentOfMonth', { value: formatPercent(window.p50Ratio) })} · ${boundaries.length ? t(language, 'forecast.crosses', { n: boundaries.length }) : t(language, 'forecast.noCross')}`;
  }
  if (!window.windowStarted) return t(language, 'forecast.windowNotStarted');
  if (window.hitAt !== undefined) return t(language, 'forecast.hitAt', { time: formatRelative(window.hitAt, Date.now(), language) });
  if (window.resetsAt !== undefined && window.remainingRatio !== null) {
    return `${t(language, 'forecast.remaining', { value: formatPercent(window.remainingRatio) })} · ${t(language, 'forecast.resetAt', { time: formatDateTime(window.resetsAt) })}`;
  }
  return t(language, 'forecast.noHit');
}

function chartValue(point: ForecastChartPoint, window: ForecastWindowForecast, key: 'actual' | 'p10' | 'p50' | 'p90'): number | null {
  const value = key === 'actual' ? point.actualUsd : key === 'p10' ? point.p10Usd : key === 'p50' ? point.p50Usd : point.p90Usd;
  if (value === null) return null;
  if (window.limitUsd === null || window.limitUsd <= 0) return value;
  return value / window.limitUsd;
}

function svgPath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ');
}

function buildChart(
  language: Language,
  window: ForecastWindowForecast,
  model: ModelQuotaForecast,
  windowKey: ForecastWindowKey,
): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('ocgo-forecast-chart');
  svg.setAttribute('viewBox', `0 0 ${FORECAST_CHART_WIDTH} ${FORECAST_CHART_HEIGHT}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t(language, 'forecast.chartAria', { window: windowLabel(language, windowKey) }));
  const points = window.chart;
  if (!points.length) return svg;
  const margin = FORECAST_CHART_MARGIN;
  const width = FORECAST_CHART_WIDTH - margin.left - margin.right;
  const height = FORECAST_CHART_HEIGHT - margin.top - margin.bottom;
  const xMin = points[0].at;
  const xMax = points[points.length - 1].at;
  const allValues = points.flatMap((point) => [chartValue(point, window, 'actual'), chartValue(point, window, 'p10'), chartValue(point, window, 'p50'), chartValue(point, window, 'p90')])
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const valuesMax = Math.max(0, ...allValues);
  const rawMax = Math.max(valuesMax * 1.1, window.limitUsd === null ? 0.01 : 1);
  const yMax = window.limitUsd === null ? rawMax : valuesMax <= 1 ? 1 : Math.ceil(rawMax * 4) / 4;
  const x = (value: number) => margin.left + (xMax === xMin ? 0 : (value - xMin) / (xMax - xMin) * width);
  const y = (value: number) => margin.top + height - Math.max(0, Math.min(yMax, value)) / yMax * height;

  for (let index = 0; index <= 4; index += 1) {
    const value = yMax * index / 4;
    const lineY = y(value);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(margin.left));
    line.setAttribute('x2', String(margin.left + width));
    line.setAttribute('y1', String(lineY));
    line.setAttribute('y2', String(lineY));
    line.classList.add('ocgo-forecast-gridline');
    svg.appendChild(line);
    const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    label.setAttribute('x', String(margin.left - 6));
    label.setAttribute('y', String(lineY + 3));
    label.setAttribute('text-anchor', 'end');
    label.classList.add('ocgo-forecast-axis-label');
    label.textContent = window.limitUsd === null ? formatUsd(value) : formatPercent(value, 0);
    svg.appendChild(label);
  }

  const actual = points
    .map((point) => ({ value: chartValue(point, window, 'actual'), x: x(point.at) }))
    .filter((point): point is { value: number; x: number } => point.value !== null)
    .map((point) => ({ x: point.x, y: y(point.value) }));
  if (actual.length > 1) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', svgPath(actual));
    path.classList.add('ocgo-forecast-actual');
    svg.appendChild(path);
  }

  const futurePoints = points.filter((point) => point.p50Usd !== null);
  const p50 = futurePoints.map((point) => ({ x: x(point.at), y: y(chartValue(point, window, 'p50') ?? 0) }));
  if (p50.length > 1) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', svgPath(p50));
    path.classList.add('ocgo-forecast-p50');
    svg.appendChild(path);
  }

  const band = futurePoints
    .map((point) => ({ x: x(point.at), top: y(chartValue(point, window, 'p90') ?? 0), bottom: y(chartValue(point, window, 'p10') ?? 0) }))
    .filter((point) => Number.isFinite(point.top) && Number.isFinite(point.bottom));
  if (band.length > 1) {
    const polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    polygon.setAttribute('points', [...band.map((point) => `${point.x.toFixed(2)},${point.top.toFixed(2)}`), ...band.slice().reverse().map((point) => `${point.x.toFixed(2)},${point.bottom.toFixed(2)}`)].join(' '));
    polygon.classList.add('ocgo-forecast-band');
    svg.appendChild(polygon);
  }

  const now = Date.now();
  if (now >= xMin && now <= xMax) {
    const nowLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    nowLine.setAttribute('x1', String(x(now)));
    nowLine.setAttribute('x2', String(x(now)));
    nowLine.setAttribute('y1', String(margin.top));
    nowLine.setAttribute('y2', String(margin.top + height));
    nowLine.classList.add('ocgo-forecast-now');
    svg.appendChild(nowLine);
  }

  const boundaries = [
    model.windows.fiveHour.resetsAt,
    model.windows.week.resetsAt,
    model.windows.month.resetsAt,
  ].filter((value): value is number => value !== undefined && value >= xMin && value <= xMax);
  for (const boundary of boundaries) {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x(boundary)));
    line.setAttribute('x2', String(x(boundary)));
    line.setAttribute('y1', String(margin.top));
    line.setAttribute('y2', String(margin.top + height));
    line.classList.add('ocgo-forecast-boundary');
    svg.appendChild(line);
  }

  const axisStart = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  axisStart.setAttribute('x', String(margin.left));
  axisStart.setAttribute('y', String(FORECAST_CHART_HEIGHT - 8));
  axisStart.setAttribute('text-anchor', 'start');
  axisStart.classList.add('ocgo-forecast-axis-label');
  axisStart.textContent = formatDateTime(xMin);
  svg.appendChild(axisStart);
  const axisEnd = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  axisEnd.setAttribute('x', String(margin.left + width));
  axisEnd.setAttribute('y', String(FORECAST_CHART_HEIGHT - 8));
  axisEnd.setAttribute('text-anchor', 'end');
  axisEnd.classList.add('ocgo-forecast-axis-label');
  axisEnd.textContent = formatDateTime(xMax);
  svg.appendChild(axisEnd);
  return svg;
}

export class ForecastPanel {
  private readonly root: HTMLElement;
  private readonly panel: HTMLElement;
  private tooltip?: HTMLElement;
  private windowKey: ForecastWindowKey = 'fiveHour';
  private result?: QuotaForecastResult;
  private selectedModel = '';
  private language: Language = 'en';
  private onSelectModel?: (model: string) => void;
  private onRetry?: () => void;

  constructor(root: HTMLElement, panel: HTMLElement) {
    this.root = root;
    this.panel = panel;
  }

  setTooltip(tooltip: HTMLElement): void {
    this.tooltip = tooltip;
  }

  renderLoading(language: Language): void {
    hideChartTooltip(this.tooltip);
    this.root.replaceChildren(this.state(t(language, 'forecast.loading'), 'ocgo-note'));
  }

  renderError(language: Language, message: string, onRetry: () => void): void {
    hideChartTooltip(this.tooltip);
    this.root.replaceChildren();
    const box = node('div', 'ocgo-forecast-state');
    box.append(node('div', 'ocgo-section-title', t(language, 'forecast.error', { error: message })));
    const retry = node('button', 'ocgo-btn', t(language, 'forecast.retry'));
    retry.type = 'button';
    retry.addEventListener('click', onRetry);
    box.appendChild(retry);
    this.root.appendChild(box);
  }

  renderEmpty(language: Language, title = t(language, 'forecast.empty'), hint = t(language, 'forecast.emptyHint')): void {
    hideChartTooltip(this.tooltip);
    this.root.replaceChildren();
    const box = node('div', 'ocgo-forecast-state');
    box.append(node('div', 'ocgo-section-title', title), node('div', 'ocgo-note', hint));
    this.root.appendChild(box);
  }

  render(
    result: QuotaForecastResult,
    selectedModel: string,
    language: Language,
    onSelectModel: (model: string) => void,
    onRetry: () => void,
  ): void {
    this.result = result;
    this.selectedModel = selectedModel;
    this.language = language;
    this.onSelectModel = onSelectModel;
    this.onRetry = onRetry;
    hideChartTooltip(this.tooltip);
    this.root.replaceChildren();
    if (!result.models.length) {
      this.renderEmpty(language);
      return;
    }
    const model = result.models.find((item) => item.model === selectedModel) ?? result.riskiest ?? result.models[0];
    if (!model) {
      this.renderEmpty(language);
      return;
    }
    this.root.appendChild(this.renderHeader(result, model));
    this.root.appendChild(this.renderCards(model));
    this.root.appendChild(this.renderChartSection(result, model));
    this.root.appendChild(this.renderTable(result, model));
    this.root.appendChild(this.renderFooter(result, model));
  }

  private state(message: string, className: string): HTMLElement {
    const box = node('div', 'ocgo-forecast-state');
    box.appendChild(node('div', className, message));
    return box;
  }

  private renderHeader(result: QuotaForecastResult, model: ModelQuotaForecast): HTMLElement {
    const header = node('div', 'ocgo-forecast-header');
    const text = node('div');
    text.append(
      node('div', 'ocgo-section-title', t(this.language, 'forecast.summary', { model: model.displayName })),
    );
    if (!this.selectedModel && result.riskiest?.model === model.model) {
      const tightest = node('span', 'ocgo-forecast-source ocgo-forecast-help', t(this.language, 'forecast.riskiest'));
      tightest.tabIndex = 0;
      tightest.setAttribute('aria-label', t(this.language, 'forecast.riskiestHelpHead'));
      this.bindRiskiestTooltip(tightest, model);
      text.appendChild(tightest);
    }
    text.appendChild(node('div', 'ocgo-note', t(this.language, 'forecast.noAggregate')));
    const meta = node('div', 'ocgo-forecast-meta');
    meta.append(
      node('span', 'ocgo-forecast-source', t(this.language, result.officialStatus ? 'forecast.sourceOfficial' : 'forecast.sourceEstimated')),
      node('span', 'ocgo-forecast-confidence', t(this.language, 'forecast.confidence', { value: confidenceLabel(this.language, model) })),
    );
    header.append(text, meta);
    if (!result.officialStatus || result.warnings.includes('forecast.statusFailed')) {
      const warning = node('div', 'ocgo-warning', t(this.language, result.warnings.includes('forecast.statusFailed') ? 'forecast.statusFailed' : 'forecast.noGo'));
      header.appendChild(warning);
    }
    return header;
  }

  private renderCards(model: ModelQuotaForecast): HTMLElement {
    const grid = node('div', 'ocgo-forecast-cards');
    for (const key of WINDOW_KEYS) {
      const window = model.windows[key];
      const card = node('div', 'ocgo-card ocgo-forecast-card');
      const ratio = key === 'next24h' ? window.p50Ratio : window.p50Ratio;
      const main = !model.limitKnown
        ? t(this.language, 'forecast.unknown')
        : model.monthlyLimitUsd === null
          ? t(this.language, 'forecast.unlimited')
          : percentOrUnknown(ratio);
      const value = node('div', 'ocgo-card-value', main);
      this.bindValueTooltip(value, model, window);
      if (window.p90Ratio !== null && window.p90Ratio >= 1) value.classList.add('ocgo-danger-text');
      const sub = node('div', 'ocgo-card-sub');
      if (!model.limitKnown) {
        sub.textContent = t(this.language, 'forecast.noQuotaData');
      } else if (model.monthlyLimitUsd === null) {
        sub.textContent = key === 'next24h'
          ? `${formatUsd(window.p50Usd)} · ${t(this.language, 'forecast.unlimited')}`
          : formatUsd(window.p50Usd);
      } else {
        const p90 = window.p90Ratio === null ? '—' : formatPercent(window.p90Ratio);
        sub.textContent = `${absoluteWindow(window)} · ${t(this.language, 'forecast.p90Short', { value: p90 })}`;
      }
      card.append(node('div', 'ocgo-card-label', windowLabel(this.language, key)), value, sub);
      const detail = node('div', 'ocgo-card-detail', resetText(this.language, window, model));
      detail.title = quantileTitle(window, this.language);
      card.appendChild(detail);
      grid.appendChild(card);
    }
    return grid;
  }

  private renderChartSection(result: QuotaForecastResult, model: ModelQuotaForecast): HTMLElement {
    const section = node('section', 'ocgo-section ocgo-forecast-chart-section');
    const head = node('div', 'ocgo-section-head');
    const titleGroup = node('div', 'ocgo-forecast-chart-title');
    titleGroup.appendChild(node('span', '', t(this.language, 'forecast.chartTitle')));
    const info = node('button', 'ocgo-info-btn', 'i');
    info.type = 'button';
    info.title = t(this.language, 'forecast.info');
    info.setAttribute('aria-label', t(this.language, 'forecast.info'));
    this.bindInfoTooltip(info);
    titleGroup.appendChild(info);
    head.appendChild(titleGroup);
    const controls = node('div', 'ocgo-forecast-window-controls');
    for (const key of WINDOW_KEYS) {
      const button = node('button', `ocgo-btn ocgo-forecast-window-btn${key === this.windowKey ? ' ocgo-active' : ''}`, windowLabel(this.language, key));
      button.type = 'button';
      button.addEventListener('click', () => {
        this.windowKey = key;
        this.render(result, this.selectedModel, this.language, this.onSelectModel ?? (() => undefined), this.onRetry ?? (() => undefined));
      });
      controls.appendChild(button);
    }
    head.appendChild(controls);
    const chart = buildChart(this.language, model.windows[this.windowKey], model, this.windowKey);
    this.bindChartHover(chart, model, model.windows[this.windowKey]);
    section.append(head, chart);
    return section;
  }


  private chartValue(value: number, window: ForecastWindowForecast): string {
    return window.limitUsd === null || window.limitUsd <= 0
      ? formatUsd(value)
      : formatPercent(value / window.limitUsd);
  }

  private bindChartHover(svg: SVGSVGElement, model: ModelQuotaForecast, window: ForecastWindowForecast): void {
    const points = window.chart;
    if (points.length < 2) return;
    const margin = FORECAST_CHART_MARGIN;
    const width = FORECAST_CHART_WIDTH - margin.left - margin.right;
    const height = FORECAST_CHART_HEIGHT - margin.top - margin.bottom;
    const xMin = points[0].at;
    const xMax = points[points.length - 1].at;
    if (xMax <= xMin) return;
    const x = (value: number) => margin.left + (value - xMin) / (xMax - xMin) * width;
    const band = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    band.classList.add('ocgo-forecast-hover-band');
    band.setAttribute('y', String(margin.top));
    band.setAttribute('height', String(height));
    band.style.display = 'none';
    svg.appendChild(band);

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const point = points[index];
      if (point.at <= previous.at) continue;
      const left = x(previous.at);
      const right = x(point.at);
      const hit = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      hit.classList.add('ocgo-forecast-hover-target');
      hit.setAttribute('x', String(left));
      hit.setAttribute('y', String(margin.top));
      hit.setAttribute('width', String(Math.max(1, right - left)));
      hit.setAttribute('height', String(height));
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('role', 'img');
      hit.setAttribute('aria-label', `${model.displayName} · ${windowLabel(this.language, window.key)} · ${formatDateTime(point.at)}`);
      const show = (clientX: number, clientY: number) => {
        if (!this.tooltip) return;
        band.setAttribute('x', String(left));
        band.setAttribute('width', String(Math.max(1, right - left)));
        band.style.display = '';
        const rows: Array<[string, string]> = [];
        if (point.actualUsd !== null) {
          rows.push([t(this.language, 'forecast.chartHistory'), this.chartValue(point.actualUsd, window)]);
          rows.push([t(this.language, 'forecast.absoluteLabel'), formatUsd(point.actualUsd)]);
        }
        if (point.p50Usd !== null) {
          rows.push([t(this.language, 'forecast.chartP50'), this.chartValue(point.p50Usd, window)]);
          if (point.p10Usd !== null) rows.push([t(this.language, 'forecast.chartP10'), this.chartValue(point.p10Usd, window)]);
          if (point.p90Usd !== null) rows.push([t(this.language, 'forecast.chartP90'), this.chartValue(point.p90Usd, window)]);
          rows.push([t(this.language, 'forecast.absoluteLabel'), formatUsd(point.p50Usd)]);
        }
        const footer = this.chartExplanation(model, window, point);
        showDataTooltip(
          this.tooltip,
          `${model.displayName} · ${windowLabel(this.language, window.key)} · ${formatDateTime(point.at)}`,
          rows,
          this.panel,
          clientX,
          clientY,
          footer,
        );
      };
      const showAtTarget = () => {
        const rect = hit.getBoundingClientRect();
        show(rect.right, rect.bottom);
      };
      hit.addEventListener('pointerenter', (event) => show(event.clientX, event.clientY));
      hit.addEventListener('pointermove', (event) => show(event.clientX, event.clientY));
      hit.addEventListener('pointerleave', () => {
        band.style.display = 'none';
        hideChartTooltip(this.tooltip);
      });
      hit.addEventListener('focus', showAtTarget);
      hit.addEventListener('blur', () => {
        band.style.display = 'none';
        hideChartTooltip(this.tooltip);
      });
      svg.appendChild(hit);
    }
  }

  private renderTable(result: QuotaForecastResult, selected: ModelQuotaForecast): HTMLElement {
    const section = node('section', 'ocgo-section ocgo-forecast-table-section');
    const head = node('div', 'ocgo-section-head');
    head.appendChild(node('span', '', t(this.language, 'forecast.tableTitle')));
    section.appendChild(head);
    const wrap = node('div', 'ocgo-table-wrap');
    const table = node('table', 'ocgo-table ocgo-forecast-table');
    const thead = node('thead');
    const headerRow = node('tr');
    const columns = [
      ['forecast.table.model', 'left'],
      ['forecast.table.monthlyLimit', ''],
      ['forecast.table.fiveHour', ''],
      ['forecast.table.week', ''],
      ['forecast.table.month', ''],
      ['forecast.table.next24h', ''],
      ['forecast.table.weekRemaining', ''],
      ['forecast.table.monthRemaining', ''],
    ] as const;
    for (const [key, align] of columns) headerRow.appendChild(node('th', align, t(this.language, key)));
    thead.appendChild(headerRow);
    const body = node('tbody');
    for (const model of result.models) {
      const row = node('tr', `ocgo-forecast-row${model.model === selected.model ? ' ocgo-active' : ''}`);
      row.dataset.model = model.model;
      row.tabIndex = 0;
      row.setAttribute('role', 'button');
      row.title = t(this.language, 'forecast.selectedModel');
      const choose = () => this.onSelectModel?.(model.model);
      row.addEventListener('click', choose);
      row.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          choose();
        }
      });
      const nameCell = node('td', 'left');
      nameCell.append(node('div', 'ocgo-forecast-model', model.displayName), node('div', 'ocgo-note', model.model));
      if (model.unpricedRequests > 0) nameCell.appendChild(node('div', 'ocgo-warning', t(this.language, 'forecast.unpriced', { n: model.unpricedRequests })));
      row.appendChild(nameCell);
      row.appendChild(node('td', '', !model.limitKnown
        ? t(this.language, 'forecast.unknown')
        : model.monthlyLimitUsd === null
          ? t(this.language, 'forecast.unlimited')
          : formatUsd(model.monthlyLimitUsd)));
      row.appendChild(this.windowTableCell(model, 'fiveHour', true));
      row.appendChild(this.windowTableCell(model, 'week', true));
      row.appendChild(this.windowTableCell(model, 'month', true));
      row.appendChild(this.windowTableCell(model, 'next24h', false));
      const weekRemaining = node('td', '', model.windows.week.remainingRatio === null ? '—' : formatPercent(model.windows.week.remainingRatio));
      this.bindValueTooltip(weekRemaining, model, model.windows.week);
      const monthRemaining = node('td', '', model.windows.month.remainingRatio === null ? '—' : formatPercent(model.windows.month.remainingRatio));
      this.bindValueTooltip(monthRemaining, model, model.windows.month);
      row.append(weekRemaining, monthRemaining);
      body.appendChild(row);
    }
    table.append(thead, body);
    wrap.appendChild(table);
    section.appendChild(wrap);
    return section;
  }

  private windowTableCell(model: ModelQuotaForecast, key: ForecastWindowKey, used: boolean): HTMLTableCellElement {
    const window = model.windows[key];
    const cell = node('td');
    if (!model.limitKnown) {
      cell.textContent = t(this.language, 'forecast.unknown');
    } else if (model.monthlyLimitUsd === null) {
      cell.textContent = key === 'next24h' ? formatUsd(window.p50Usd) : t(this.language, 'forecast.unlimited');
    } else {
      cell.textContent = percentOrUnknown(used ? window.usedRatio : window.p50Ratio);
    }
    cell.title = `${quantileTitle(window, this.language)} · ${absoluteWindow(window)}`;
    this.bindValueTooltip(cell, model, window);
    return cell;
  }


  private bindValueTooltip(element: HTMLElement, model: ModelQuotaForecast, window: ForecastWindowForecast): void {
    element.classList.add('ocgo-forecast-percent');
    element.tabIndex = 0;
    const show = (clientX: number, clientY: number) => {
      if (!this.tooltip) return;
      const rows: Array<[string, string]> = [];
      if (!model.limitKnown) {
        rows.push([t(this.language, 'forecast.absolute'), t(this.language, 'forecast.noQuotaData')]);
      } else if (model.monthlyLimitUsd === null) {
        rows.push([t(this.language, 'forecast.absolute'), t(this.language, 'forecast.unlimited')]);
        rows.push([t(this.language, 'forecast.projected'), formatUsd(window.p50Usd)]);
      } else {
        if (window.key !== 'next24h') rows.push([t(this.language, 'forecast.usedLabel'), percentOrUnknown(window.usedRatio)]);
        rows.push([t(this.language, 'forecast.projectedLabel'), percentOrUnknown(window.p50Ratio)]);
        rows.push([t(this.language, 'forecast.p90Label'), percentOrUnknown(window.p90Ratio)]);
        rows.push([t(this.language, 'forecast.absoluteLabel'), `${formatUsd(window.p50Usd)} / ${formatUsd(window.limitUsd)}`]);
      }
      if (window.resetsAt !== undefined) {
        rows.push([
          t(this.language, window.key === 'next24h' ? 'forecast.forecastEndLabel' : 'forecast.resetLabel'),
          formatDateTime(window.resetsAt),
        ]);
      }
      if (window.hitAt !== undefined) rows.push([t(this.language, 'forecast.hitLabel'), formatDateTime(window.hitAt)]);
      const footer = this.cardExplanation(model, window);
      showDataTooltip(
        this.tooltip,
        `${model.displayName} · ${windowLabel(this.language, window.key)}`,
        rows,
        this.panel,
        clientX,
        clientY,
        footer,
      );
    };
    const showAtElement = () => {
      const rect = element.getBoundingClientRect();
      show(rect.right, rect.bottom);
    };
    element.addEventListener('pointerenter', (event) => show(event.clientX, event.clientY));
    element.addEventListener('pointermove', (event) => show(event.clientX, event.clientY));
    element.addEventListener('pointerleave', () => hideChartTooltip(this.tooltip));
    element.addEventListener('focus', showAtElement);
    element.addEventListener('blur', () => hideChartTooltip(this.tooltip));
  }

  private bindRiskiestTooltip(element: HTMLElement, model: ModelQuotaForecast): void {
    const show = (clientX: number, clientY: number) => {
      if (!this.tooltip) return;
      const rows: Array<[string, string]> = [];
      if (model.riskWindow) {
        rows.push([
          t(this.language, 'forecast.riskiestHelpWindow'),
          t(this.language, 'forecast.riskiestHelpWindowValue', {
            window: windowLabel(this.language, model.riskWindow),
            value: formatPercent(model.riskScore),
          }),
        ]);
      }
      rows.push([
        t(this.language, 'forecast.riskiestHelpBasis'),
        t(this.language, 'forecast.riskiestHelpBasisValue'),
      ]);
      showDataTooltip(
        this.tooltip,
        t(this.language, 'forecast.riskiestHelpHead'),
        rows,
        this.panel,
        clientX,
        clientY,
        t(this.language, 'forecast.riskiestHelpFooter'),
      );
    };
    const showAtElement = () => {
      const rect = element.getBoundingClientRect();
      show(rect.right, rect.bottom);
    };
    element.addEventListener('pointerenter', (event) => show(event.clientX, event.clientY));
    element.addEventListener('pointermove', (event) => show(event.clientX, event.clientY));
    element.addEventListener('pointerleave', () => hideChartTooltip(this.tooltip));
    element.addEventListener('focus', showAtElement);
    element.addEventListener('blur', () => hideChartTooltip(this.tooltip));
  }

  private bindInfoTooltip(button: HTMLButtonElement): void {
    const show = (clientX: number, clientY: number) => {
      if (!this.tooltip) return;
      showDataTooltip(
        this.tooltip,
        t(this.language, 'forecast.infoHead'),
        [
          [t(this.language, 'forecast.infoHistory'), t(this.language, 'forecast.infoHistoryDesc')],
          [t(this.language, 'forecast.infoForecast'), t(this.language, 'forecast.infoForecastDesc')],
          [t(this.language, 'forecast.infoBand'), t(this.language, 'forecast.infoBandDesc')],
          [t(this.language, 'forecast.infoMethod'), t(this.language, 'forecast.infoMethodDesc')],
        ],
        this.panel,
        clientX,
        clientY,
        t(this.language, 'forecast.infoFooter'),
      );
    };
    const showAtButton = () => {
      const rect = button.getBoundingClientRect();
      show(rect.right, rect.bottom);
    };
    button.addEventListener('pointerenter', (event) => show(event.clientX, event.clientY));
    button.addEventListener('pointerleave', () => hideChartTooltip(this.tooltip));
    button.addEventListener('focus', showAtButton);
    button.addEventListener('blur', () => hideChartTooltip(this.tooltip));
  }


  private cardExplanation(model: ModelQuotaForecast, window: ForecastWindowForecast): string {
    if (!model.limitKnown) return t(this.language, 'forecast.noQuotaData');
    if (model.monthlyLimitUsd === null || window.p50Ratio === null) return t(this.language, 'forecast.unlimited');
    if (window.key === 'fiveHour') return t(this.language, 'forecast.explainFiveHour', { value: formatPercent(window.p50Ratio) });
    if (window.key === 'week') return t(this.language, 'forecast.explainWeek', { value: formatPercent(window.p50Ratio) });
    if (window.key === 'month') return t(this.language, 'forecast.explainMonth', { value: formatPercent(window.p50Ratio) });
    const monthUsed = model.windows.month.usedRatio ?? 0;
    return t(this.language, 'forecast.explain24h', {
      value: formatPercent(window.p50Ratio),
      arrival: formatPercent(monthUsed + window.p50Ratio),
    });
  }

  private chartExplanation(model: ModelQuotaForecast, window: ForecastWindowForecast, point: ForecastChartPoint): string {
    if (!model.limitKnown || window.limitUsd === null || window.limitUsd <= 0) {
      return !model.limitKnown ? t(this.language, 'forecast.noQuotaData') : t(this.language, 'forecast.unlimited');
    }
    if (point.actualUsd !== null) {
      return t(this.language, 'forecast.explainHistory', { value: formatPercent(point.actualUsd / window.limitUsd) });
    }
    if (point.p50Usd === null) return t(this.language, 'forecast.noQuotaData');
    const ratio = point.p50Usd / window.limitUsd;
    if (window.key === 'next24h') {
      const monthUsed = model.windows.month.usedRatio ?? 0;
      return t(this.language, 'forecast.explain24hToPoint', {
        value: formatPercent(ratio),
        arrival: formatPercent(monthUsed + ratio),
      });
    }
    return t(this.language, 'forecast.explainPoint', { value: formatPercent(ratio) });
  }

  private renderFooter(result: QuotaForecastResult, model: ModelQuotaForecast): HTMLElement {
    const footer = node('div', 'ocgo-forecast-footer');
    footer.append(
      node('span', 'ocgo-note', t(this.language, 'forecast.rangeIgnored')),
      node('span', 'ocgo-note', t(this.language, 'forecast.asOf', { time: formatDateTime(result.generatedAt) })),
    );
    if (model.confidenceReasons.length) {
      const reasons = model.confidenceReasons.map((key) => t(this.language, key)).join(' · ');
      footer.appendChild(node('span', 'ocgo-warning', `${t(this.language, 'forecast.confidence', { value: confidenceLabel(this.language, model) })} — ${reasons}`));
    }
    return footer;
  }
}
