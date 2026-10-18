import type {
  ForecastChartPoint,
  ForecastWindowForecast,
  ForecastWindowKey,
  ModelQuotaForecast,
  QuotaForecastResult,
} from '../forecast';
import { formatDateTime, formatPercent, formatRelative, formatUsd } from '../format';
import { t } from '../i18n';
import type { Language } from '../types';

const WINDOW_KEYS: ForecastWindowKey[] = ['fiveHour', 'next24h', 'week', 'month'];

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
  svg.setAttribute('viewBox', '0 0 760 260');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t(language, 'forecast.chartAria', { window: windowLabel(language, windowKey) }));
  const points = window.chart;
  if (!points.length) return svg;
  const margin = { left: 44, right: 16, top: 16, bottom: 28 };
  const width = 760 - margin.left - margin.right;
  const height = 260 - margin.top - margin.bottom;
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
  axisStart.setAttribute('y', String(260 - 8));
  axisStart.setAttribute('text-anchor', 'start');
  axisStart.classList.add('ocgo-forecast-axis-label');
  axisStart.textContent = formatDateTime(xMin);
  svg.appendChild(axisStart);
  const axisEnd = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  axisEnd.setAttribute('x', String(margin.left + width));
  axisEnd.setAttribute('y', String(260 - 8));
  axisEnd.setAttribute('text-anchor', 'end');
  axisEnd.classList.add('ocgo-forecast-axis-label');
  axisEnd.textContent = formatDateTime(xMax);
  svg.appendChild(axisEnd);
  return svg;
}

export class ForecastPanel {
  private readonly root: HTMLElement;
  private windowKey: ForecastWindowKey = 'fiveHour';
  private result?: QuotaForecastResult;
  private selectedModel = '';
  private language: Language = 'en';
  private onSelectModel?: (model: string) => void;
  private onRetry?: () => void;

  constructor(root: HTMLElement) {
    this.root = root;
  }

  renderLoading(language: Language): void {
    this.root.replaceChildren(this.state(t(language, 'forecast.loading'), 'ocgo-note'));
  }

  renderError(language: Language, message: string, onRetry: () => void): void {
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
      text.appendChild(node('span', 'ocgo-forecast-source', t(this.language, 'forecast.riskiest')));
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
    head.appendChild(node('span', '', t(this.language, 'forecast.chartTitle')));
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
    section.append(head, buildChart(this.language, model.windows[this.windowKey], model, this.windowKey));
    return section;
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
      row.appendChild(node('td', '', model.windows.week.remainingRatio === null ? '—' : formatPercent(model.windows.week.remainingRatio)));
      row.appendChild(node('td', '', model.windows.month.remainingRatio === null ? '—' : formatPercent(model.windows.month.remainingRatio)));
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
    return cell;
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
