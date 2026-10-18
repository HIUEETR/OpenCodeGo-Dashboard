import { describe, expect, it } from 'vitest';
import { csvEscape, formatPercent, formatTps, formatUsd } from '../src/format';

describe('formatting', () => {
  it('neutralizes spreadsheet formulas in exported text fields', () => {
    expect(csvEscape('=SUM(A1:A2)')).toBe("'=SUM(A1:A2)");
    expect(csvEscape('+cmd')).toBe("'+cmd");
    expect(csvEscape('-2')).toBe("'-2");
    expect(csvEscape('@user')).toBe("'@user");
  });

  it('still quotes commas, quotes, and line breaks', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape('a\nb')).toBe('"a\nb"');
  });

  it('formats missing and tiny metrics consistently', () => {
    expect(formatPercent(null)).toBe('N/A');
    expect(formatTps(42.25)).toBe('42.3 tok/s');
    expect(formatUsd(0.00069)).toBe('$0.00069');
  });
});
