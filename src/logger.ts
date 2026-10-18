import { t } from './i18n';
import type { Language } from './types';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogParams = Record<string, string | number>;

export interface LogEntry {
  time: number;
  level: LogLevel;
  key?: string;
  params?: LogParams;
  message?: string;
}

const LOG_KEY = 'ocgo-lens:logs';
const MAX_LOGS = 300;

export function formatLogEntry(entry: LogEntry, language: Language): string {
  return entry.key ? t(language, entry.key, entry.params) : entry.message ?? '';
}

export class Logger {
  private entries: LogEntry[] = [];
  private listeners = new Set<() => void>();

  constructor() {
    try {
      const raw = localStorage.getItem(LOG_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as LogEntry[];
        if (Array.isArray(parsed)) this.entries = parsed.slice(-MAX_LOGS);
      }
    } catch {
      this.entries = [];
    }
  }

  add(level: LogLevel, key: string, params?: LogParams): void {
    this.entries.push({ time: Date.now(), level, key, params });
    if (this.entries.length > MAX_LOGS) this.entries = this.entries.slice(-MAX_LOGS);
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(this.entries));
    } catch {
      // Logging must never interrupt the app.
    }
    for (const listener of this.listeners) listener();
  }

  info(key: string, params?: LogParams): void { this.add('info', key, params); }
  warn(key: string, params?: LogParams): void { this.add('warn', key, params); }
  error(key: string, params?: LogParams): void { this.add('error', key, params); }

  all(): LogEntry[] {
    return [...this.entries];
  }

  clear(): void {
    this.entries = [];
    try { localStorage.removeItem(LOG_KEY); } catch { /* ignore */ }
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
