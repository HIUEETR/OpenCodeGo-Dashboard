import { describe, expect, it } from 'vitest';
import { detectLanguage } from '../src/i18n';
import { formatLogEntry } from '../src/logger';

describe('language selection and logs', () => {
  it('uses Chinese for any zh locale and English for every other locale', () => {
    expect(detectLanguage('zh-CN')).toBe('zh');
    expect(detectLanguage('zh-TW')).toBe('zh');
    expect(detectLanguage('en-US')).toBe('en');
    expect(detectLanguage('ja-JP')).toBe('en');
    expect(detectLanguage('')).toBe('en');
  });

  it('renders structured log entries in the active language', () => {
    const entry = { time: 1, level: 'info' as const, key: 'log.migrated', params: { n: 3 } };
    expect(formatLogEntry(entry, 'zh')).toBe('已迁移 3 条旧版用量记录');
    expect(formatLogEntry(entry, 'en')).toBe('Migrated 3 legacy usage records');
  });

  it('keeps legacy plain-text log entries readable', () => {
    expect(formatLogEntry({ time: 1, level: 'warn', message: 'legacy message' }, 'zh')).toBe('legacy message');
  });
});
