import type { BucketPoint, Language } from '../types';
import {
  formatAxisTime,
  formatCompact,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
  formatTps,
} from '../format';
import { t } from '../i18n';

const SVG_NS = 'http://www.w3.org/2000/svg';
const WIDTH = 620;
const HEIGHT = 210;
const PAD = { left: 48, right: 14, top: 18, bottom: 28 };

type ChartTooltipKind = 'tokens' | 'cache' | 'ttft' | 'tps';

function svgElement<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

export function hideChartTooltip(tooltip: HTMLElement | undefined): void {
  if (!tooltip) return;
  tooltip.classList.add('ocgo-hidden');
  tooltip.replaceChildren();
}

function tooltipRows(kind: ChartTooltipKind, bucket: BucketPoint, language: Language): Array<[string, string]> {
  if (kind === 'tokens') {
    return [
      [t(language, 'table.totalTokens'), formatNumber(bucket.totalTokens)],
      [t(language, 'table.input'), formatNumber(bucket.inputTokens)],
      [t(language, 'table.cacheRead'), formatNumber(bucket.cacheReadTokens)],
      [t(language, 'table.cacheWrite'), formatNumber(bucket.cacheWriteTokens)],
      [t(language, 'table.output'), formatNumber(bucket.outputTokens)],
    ];
  }
  if (kind === 'cache') {
    return [
      [t(language, 'table.hitRate'), formatPercent(bucket.cacheHitRate, 2)],
      [t(language, 'table.cacheRead'), formatNumber(bucket.cacheReadTokens)],
      [t(language, 'table.cacheWrite'), formatNumber(bucket.cacheWriteTokens)],
    ];
  }
  if (kind === 'ttft') {
    return [
      [t(language, 'table.ttftAvg'), formatMs(bucket.ttftAvg)],
      [t(language, 'table.ttftSlowest'), formatMs(bucket.ttftSlowest)],
      [t(language, 'tooltip.ttftSamples'), t(language, 'metric.samples', { n: bucket.ttftSamples })],
    ];
  }
  return [
    [t(language, 'table.tpsAvg'), formatTps(bucket.tpsAvg)],
    [t(language, 'table.tpsSlowest'), formatTps(bucket.tpsSlowest)],
    [t(language, 'tooltip.tpsSamples'), t(language, 'metric.samples', { n: bucket.tpsSamples })],
  ];
}

export function showDataTooltip(
  tooltip: HTMLElement,
  headText: string,
  values: Array<[string, string]>,
  container: HTMLElement,
  x: number,
  y: number,
  footer?: string,
): void {
  tooltip.replaceChildren();
  const head = document.createElement('div');
  head.className = 'ocgo-tooltip-head';
  head.textContent = headText;
  const rows = document.createElement('dl');
  rows.className = 'ocgo-tooltip-grid';
  for (const [label, value] of values) {
    const term = document.createElement('dt');
    term.textContent = label;
    const detail = document.createElement('dd');
    detail.textContent = value;
    rows.append(term, detail);
  }
  tooltip.append(head, rows);
  if (footer) {
    const note = document.createElement('div');
    note.className = 'ocgo-tooltip-note';
    note.textContent = footer;
    tooltip.appendChild(note);
  }
  tooltip.classList.remove('ocgo-hidden');
  positionChartTooltip(tooltip, container, x, y);
}

function showChartTooltip(
  tooltip: HTMLElement,
  bucket: BucketPoint,
  language: Language,
  kind: ChartTooltipKind,
  container: HTMLElement,
  x: number,
  y: number,
): void {
  showDataTooltip(
    tooltip,
    `${formatDateTime(bucket.start)} – ${formatDateTime(bucket.end)}`,
    tooltipRows(kind, bucket, language),
    container,
    x,
    y,
  );
}

function tooltipAriaLabel(kind: ChartTooltipKind, bucket: BucketPoint, language: Language): string {
  const values = tooltipRows(kind, bucket, language)
    .map(([label, value]) => `${label} ${value}`)
    .join(' · ');
  return `${formatAxisTime(bucket.start, bucket.end - bucket.start)} · ${values}`;
}

function positionChartTooltip(tooltip: HTMLElement, container: HTMLElement, x: number, y: number): void {
  const panel = container.closest('.ocgo-panel') as HTMLElement | null;
  const bounds = panel?.getBoundingClientRect();
  const leftBound = (bounds?.left ?? 0) + 8;
  const topBound = (bounds?.top ?? 0) + 8;
  const rightBound = (bounds?.right ?? window.innerWidth) - 8;
  const bottomBound = (bounds?.bottom ?? window.innerHeight) - 8;
  const gap = 12;
  const width = tooltip.offsetWidth;
  const height = tooltip.offsetHeight;
  let left = x + gap;
  let top = y + gap;
  if (left + width > rightBound) left = x - width - gap;
  if (top + height > bottomBound) top = y - height - gap;
  left = Math.max(leftBound, Math.min(left, rightBound - width));
  top = Math.max(topBound, Math.min(top, bottomBound - height));
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function addHoverTargets(
  svg: SVGSVGElement,
  buckets: BucketPoint[],
  plotWidth: number,
  plotHeight: number,
  container: HTMLElement,
  tooltip: HTMLElement | undefined,
  language: Language,
  kind: ChartTooltipKind,
): void {
  if (!tooltip || !buckets.length) return;
  const denominator = Math.max(1, buckets.length - 1);
  const active = svgElement('rect', {
    x: PAD.left,
    y: PAD.top,
    width: 0,
    height: plotHeight,
    class: 'ocgo-hover-band',
  });
  active.style.display = 'none';
  svg.appendChild(active);
  buckets.forEach((bucket, index) => {
    const leftRatio = buckets.length === 1 ? 0 : Math.max(0, (index - 0.5) / denominator);
    const rightRatio = buckets.length === 1 ? 1 : Math.min(1, (index + 0.5) / denominator);
    const x = PAD.left + plotWidth * leftRatio;
    const width = Math.max(1, plotWidth * (rightRatio - leftRatio));
    const hit = svgElement('rect', {
      x,
      y: PAD.top,
      width,
      height: plotHeight,
      class: 'ocgo-hover-target',
      tabindex: 0,
      role: 'img',
      'aria-label': tooltipAriaLabel(kind, bucket, language),
    });
    const showAt = (x: number, clientX: number, clientY: number) => {
      active.setAttribute('x', String(x));
      active.setAttribute('width', String(width));
      active.style.display = '';
      showChartTooltip(tooltip, bucket, language, kind, container, clientX, clientY);
    };
    const show = (event: PointerEvent) => {
      showAt(x, event.clientX, event.clientY);
    };
    hit.addEventListener('pointerenter', show);
    hit.addEventListener('pointermove', (event) => positionChartTooltip(tooltip, container, event.clientX, event.clientY));
    hit.addEventListener('focus', () => {
      const rect = hit.getBoundingClientRect();
      showAt(x, rect.left + rect.width / 2, rect.top + rect.height / 2);
    });
    hit.addEventListener('blur', () => {
      active.style.display = 'none';
      hideChartTooltip(tooltip);
    });
    svg.appendChild(hit);
  });
  svg.addEventListener('pointerleave', () => {
    active.style.display = 'none';
    hideChartTooltip(tooltip);
  });
}

function emptyState(container: HTMLElement, language: Language, tooltip?: HTMLElement): void {
  hideChartTooltip(tooltip);
  container.replaceChildren();
  const empty = document.createElement('div');
  empty.className = 'ocgo-chart-empty';
  empty.textContent = t(language, 'chart.empty');
  container.appendChild(empty);
}

function addLegend(container: HTMLElement, items: Array<{ label: string; color: string }>): void {
  const legend = document.createElement('div');
  legend.className = 'ocgo-legend';
  for (const item of items) {
    const entry = document.createElement('span');
    const swatch = document.createElement('i');
    swatch.style.background = item.color;
    entry.append(swatch, document.createTextNode(item.label));
    legend.appendChild(entry);
  }
  container.appendChild(legend);
}

function frame(svg: SVGSVGElement, bucketCount: number): { plotWidth: number; plotHeight: number } {
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  for (let i = 0; i <= 3; i += 1) {
    const y = PAD.top + (plotHeight * i) / 3;
    svg.appendChild(svgElement('line', {
      x1: PAD.left,
      x2: WIDTH - PAD.right,
      y1: y,
      y2: y,
      class: 'ocgo-grid-line',
    }));
  }
  if (bucketCount > 0) {
    const labels = Math.min(5, bucketCount);
    for (let i = 0; i < labels; i += 1) {
      const ratio = labels === 1 ? 0 : i / (labels - 1);
      const x = PAD.left + plotWidth * ratio;
      const bucketIndex = Math.round((bucketCount - 1) * ratio);
      svg.appendChild(svgElement('line', {
        x1: x,
        x2: x,
        y1: PAD.top,
        y2: HEIGHT - PAD.bottom,
        class: 'ocgo-grid-line ocgo-grid-line-v',
      }));
      const label = svgElement('text', {
        x,
        y: HEIGHT - 8,
        'text-anchor': i === 0 ? 'start' : i === labels - 1 ? 'end' : 'middle',
        class: 'ocgo-axis-label',
      });
      label.dataset.index = String(bucketIndex);
      svg.appendChild(label);
    }
  }
  return { plotWidth, plotHeight };
}

function setXAxisLabels(svg: SVGSVGElement, buckets: BucketPoint[]): void {
  const bucketMs = buckets.length > 1 ? Math.max(1, buckets[1].start - buckets[0].start) : 24 * 60 * 60 * 1000;
  const labels = [...svg.querySelectorAll<SVGTextElement>('.ocgo-axis-label[data-index]')];
  for (const label of labels) {
    const index = Number(label.dataset.index ?? 0);
    const bucket = buckets[index];
    if (bucket) label.textContent = formatAxisTime(bucket.start, bucketMs);
  }
}

function renderLineSeries(
  svg: SVGSVGElement,
  values: Array<number | null>,
  color: string,
  yMax: number,
  plotWidth: number,
  plotHeight: number,
): void {
  const denominator = Math.max(1, values.length - 1);
  const xAt = (index: number) => PAD.left + (plotWidth * index) / denominator;
  const yAt = (value: number) => PAD.top + plotHeight - (value / yMax) * plotHeight;
  let segment = '';
  const points: Array<[number, number]> = [];
  values.forEach((value, index) => {
    if (value === null || !Number.isFinite(value)) {
      if (segment) {
        svg.appendChild(svgElement('path', { d: segment, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        segment = '';
      }
      return;
    }
    const x = xAt(index);
    const y = yAt(value);
    segment += `${segment ? ' L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
    points.push([x, y]);
  });
  if (segment) {
    svg.appendChild(svgElement('path', { d: segment, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  }
  for (const [x, y] of points) {
    svg.appendChild(svgElement('circle', { cx: x, cy: y, r: 4, fill: color, class: 'ocgo-point' }));
  }
}

function yLabel(svg: SVGSVGElement, value: string, y: number): void {
  const text = svgElement('text', { x: PAD.left - 8, y: y + 4, 'text-anchor': 'end', class: 'ocgo-axis-label' });
  text.textContent = value;
  svg.appendChild(text);
}

function chartSvg(label: string): SVGSVGElement {
  return svgElement('svg', {
    viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
    role: 'img',
    'aria-label': label,
    class: 'ocgo-chart-svg',
    preserveAspectRatio: 'xMidYMid meet',
  });
}

export function renderTokenMix(
  container: HTMLElement,
  buckets: BucketPoint[],
  language: Language,
  tooltip?: HTMLElement,
): void {
  hideChartTooltip(tooltip);
  if (!buckets.some((bucket) => bucket.requests > 0)) {
    emptyState(container, language, tooltip);
    return;
  }
  container.replaceChildren();
  const svg = chartSvg(t(language, 'chart.tokens'));
  const { plotWidth, plotHeight } = frame(svg, buckets.length);
  const totals = buckets.map((bucket) => bucket.totalTokens);
  const max = Math.max(1, ...totals);
  const gap = 2;
  const barWidth = Math.max(1, Math.min(36, plotWidth / Math.max(1, buckets.length) - gap));
  const series = [
    { key: 'inputTokens' as const, color: '#7698fd', label: t(language, 'chart.input') },
    { key: 'cacheReadTokens' as const, color: '#6bd586', label: t(language, 'chart.cacheRead') },
    { key: 'cacheWriteTokens' as const, color: '#f2cf76', label: t(language, 'chart.cacheWrite') },
    { key: 'outputTokens' as const, color: '#9e99f7', label: t(language, 'chart.output') },
  ];
  buckets.forEach((bucket, index) => {
    const x = PAD.left + (plotWidth * index) / Math.max(1, buckets.length - 1) - barWidth / 2;
    let base = PAD.top + plotHeight;
    for (const item of series) {
      const value = bucket[item.key];
      const height = (value / max) * plotHeight;
      if (height > 0) {
        svg.appendChild(svgElement('rect', {
          x,
          y: base - height,
          width: barWidth,
          height,
          fill: item.color,
          rx: 1,
          class: 'ocgo-bar',
        }));
      }
      base -= height;
    }
  });
  yLabel(svg, formatCompact(max), PAD.top);
  yLabel(svg, '0', PAD.top + plotHeight);
  setXAxisLabels(svg, buckets);
  addHoverTargets(svg, buckets, plotWidth, plotHeight, container, tooltip, language, 'tokens');
  container.appendChild(svg);
  addLegend(container, series);
}

export function renderCacheChart(
  container: HTMLElement,
  buckets: BucketPoint[],
  language: Language,
  tooltip?: HTMLElement,
): void {
  hideChartTooltip(tooltip);
  const values = buckets.map((bucket) => bucket.cacheHitRate);
  if (!values.some((value) => value !== null)) {
    emptyState(container, language, tooltip);
    return;
  }
  container.replaceChildren();
  const svg = chartSvg(t(language, 'chart.cache'));
  const { plotWidth, plotHeight } = frame(svg, buckets.length);
  yLabel(svg, '100%', PAD.top);
  yLabel(svg, '50%', PAD.top + plotHeight / 2);
  yLabel(svg, '0%', PAD.top + plotHeight);
  renderLineSeries(svg, values, '#6bd586', 1, plotWidth, plotHeight);
  setXAxisLabels(svg, buckets);
  addHoverTargets(svg, buckets, plotWidth, plotHeight, container, tooltip, language, 'cache');
  container.appendChild(svg);
}

function renderPerformanceChart(
  container: HTMLElement,
  buckets: BucketPoint[],
  language: Language,
  tooltip: HTMLElement | undefined,
  kind: 'ttft' | 'tps',
): void {
  hideChartTooltip(tooltip);
  const averageValues = buckets.map((bucket) => bucket[`${kind}Avg`]);
  const slowestValues = buckets.map((bucket) => bucket[`${kind}Slowest`]);
  const values = [...averageValues, ...slowestValues]
    .filter((value): value is number => value !== null);
  if (!values.length) {
    emptyState(container, language, tooltip);
    return;
  }
  container.replaceChildren();
  const max = Math.max(1, ...values) * 1.1;
  const svg = chartSvg(t(language, kind === 'ttft' ? 'chart.ttft' : 'chart.tps'));
  const { plotWidth, plotHeight } = frame(svg, buckets.length);
  const formatter = kind === 'ttft' ? formatMs : formatTps;
  yLabel(svg, formatter(max), PAD.top);
  yLabel(svg, formatter(max / 2), PAD.top + plotHeight / 2);
  yLabel(svg, '0', PAD.top + plotHeight);
  const averageColor = kind === 'ttft' ? '#7698fd' : '#9e99f7';
  renderLineSeries(svg, averageValues, averageColor, max, plotWidth, plotHeight);
  renderLineSeries(svg, slowestValues, '#f2cf76', max, plotWidth, plotHeight);
  setXAxisLabels(svg, buckets);
  addHoverTargets(svg, buckets, plotWidth, plotHeight, container, tooltip, language, kind);
  container.appendChild(svg);
  addLegend(container, [
    { label: t(language, 'chart.average'), color: averageColor },
    { label: t(language, 'chart.slowest'), color: '#f2cf76' },
  ]);
}

export function renderLatencyChart(
  container: HTMLElement,
  buckets: BucketPoint[],
  language: Language,
  tooltip?: HTMLElement,
): void {
  renderPerformanceChart(container, buckets, language, tooltip, 'ttft');
}

export function renderTpsChart(
  container: HTMLElement,
  buckets: BucketPoint[],
  language: Language,
  tooltip?: HTMLElement,
): void {
  renderPerformanceChart(container, buckets, language, tooltip, 'tps');
}
