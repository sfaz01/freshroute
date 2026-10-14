import { describe, expect, it } from 'vitest';
import { kg, pts, rupeesCompact, rupeesDelta } from '../src/engine/fmt';

describe('formatting', () => {
  it('formats tonnes without eating integer zeros', () => {
    expect(kg(120400)).toBe('120 t');
    expect(kg(100000)).toBe('100 t');
    expect(kg(12000)).toBe('12 t');
    expect(kg(12500)).toBe('12.5 t');
    expect(kg(1500)).toBe('1.5 t');
    expect(kg(1000)).toBe('1 t');
    expect(kg(850)).toBe('850 kg');
  });
  it('formats money in lakh and crore, with signs', () => {
    expect(rupeesCompact(3098109)).toBe('₹30.98 L');
    expect(rupeesCompact(-91400)).toBe('−₹91,400');
    expect(rupeesDelta(741000)).toBe('+₹7.41 L');
    expect(rupeesDelta(0.2)).toBe('±₹0');
  });
  it('formats percentage-point changes with an explicit sign', () => {
    expect(pts(0.012)).toBe('+1.2 pts');
    expect(pts(-0.004)).toBe('−0.4 pts');
    expect(pts(0)).toBe('±0 pts');
  });
});
