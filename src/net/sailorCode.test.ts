import { describe, expect, it } from 'vitest';
import { formatSailorCode, newSailorCode, normalizeSailorCode } from './sailorCode';

describe('sailor codes', () => {
  it('generates codes that normalize to themselves', () => {
    for (let i = 0; i < 200; i++) {
      const code = newSailorCode();
      expect(normalizeSailorCode(code)).toBe(code);
    }
  });

  it('accepts typed codes with spaces, dashes and lower case', () => {
    expect(normalizeSailorCode('abcde-fghij klmno-pqrst')).toBe('ABCDEFGHIJKLMNOPQRST');
  });

  it('rejects letters outside base32 and wrong lengths', () => {
    expect(normalizeSailorCode('0OIL8ABCDEFGHIJKLMNO')).toBeNull();
    expect(normalizeSailorCode('ABCDEFGHIJKLMNOPQRS')).toBeNull();
    expect(normalizeSailorCode('ABCDEFGHIJKLMNOPQRSTU')).toBeNull();
    expect(normalizeSailorCode('abc')).toBeNull();
  });

  it('formats in groups of five that restore to the same code', () => {
    const code = newSailorCode();
    const formatted = formatSailorCode(code);
    expect(formatted).toMatch(/^[A-Z2-7]{5}(-[A-Z2-7]{5}){3}$/);
    expect(normalizeSailorCode(formatted)).toBe(code);
  });
});
