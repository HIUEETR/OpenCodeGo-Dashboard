export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString();
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value >= 1) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (value >= 0.01) return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 6 })}`;
}

export function formatMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} s`;
}

export function formatTps(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'N/A';
  return `${value.toFixed(1)} tok/s`;
}

export function formatBytes(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)} GB`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} MB`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)} KB`;
  return `${value} B`;
}

const dateTime = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

const shortDateTime = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });

export function formatDateTime(timestamp: number | undefined): string {
  return timestamp === undefined ? '—' : dateTime.format(new Date(timestamp));
}

export function formatAxisTime(timestamp: number, bucketMs: number): string {
  const day = 86_400_000;
  return bucketMs >= day ? shortDate.format(new Date(timestamp)) : shortDateTime.format(new Date(timestamp));
}

export function formatRelative(timestamp: number | undefined, now = Date.now(), language = 'en'): string {
  if (!timestamp) return '—';
  const delta = now - timestamp;
  const formatter = new Intl.RelativeTimeFormat(language === 'zh' ? 'zh-CN' : 'en', { numeric: 'auto' });
  if (delta < 60_000) return formatter.format(-Math.max(0, Math.round(delta / 1000)), 'second');
  if (delta < 3_600_000) return formatter.format(-Math.floor(delta / 60_000), 'minute');
  if (delta < 86_400_000) return formatter.format(-Math.floor(delta / 3_600_000), 'hour');
  return formatter.format(-Math.floor(delta / 86_400_000), 'day');
}

export function csvEscape(value: unknown): string {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadText(filename: string, text: string, type = 'text/plain;charset=utf-8'): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.documentElement.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

