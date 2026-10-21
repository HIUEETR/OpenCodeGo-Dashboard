import { describe, expect, it } from 'vitest';
import { csvEscape, formatMsPair, formatPercent, formatTps, formatTpsPair, formatUsd } from '../src/format';

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

  it('formats average/slowest pairs with one compact unit', () => {
    expect(formatMsPair(800, 950)).toBe('800/950 ms');
    expect(formatMsPair(950, 1250)).toBe('0.95/1.25 s');
    expect(formatMsPair(9590, 75600)).toBe('9.59/75.6 s');
    expect(formatTpsPair(281.7, 40.5, 'Token/s')).toBe('281.7/40.5 Token/s');
  });

  it('keeps missing metric pairs unavailable', () => {
    expect(formatMsPair(null, 1000)).toBe('N/A');
    expect(formatTpsPair(42, undefined, 'Token/s')).toBe('N/A');
  });
});
