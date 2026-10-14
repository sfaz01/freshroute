/** Formatting helpers shared by engine-generated explanations and the UI. */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** ₹12,34,567 (Indian digit grouping). */
export function rupees(v: number): string {
  const r = Math.round(v);
  return `${r < 0 ? '−' : ''}₹${inr.format(Math.abs(r))}`;
}

/** Compact money: ₹4.2 L, ₹1.3 Cr, ₹8,400. */
export function rupeesCompact(v: number): string {
  const a = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  if (a >= 1e7) return `${sign}₹${(a / 1e7).toFixed(2)} Cr`;
  if (a >= 1e5) return `${sign}₹${(a / 1e5).toFixed(2)} L`;
  return `${sign}₹${inr.format(Math.round(a))}`;
}

/** Signed money delta: +₹4.2 L / −₹8,400. */
export function rupeesDelta(v: number): string {
  if (Math.abs(v) < 0.5) return '±₹0';
  return (v > 0 ? '+' : '') + rupeesCompact(v);
}

export function perKg(v: number): string {
  return `${v < 0 ? '−' : ''}₹${Math.abs(v).toFixed(1)}/kg`;
}

/** 850 kg / 4.2 t */
export function kg(v: number): string {
  const a = Math.abs(v);
  if (a < 0.5) return '0 kg';
  if (a >= 1000) {
    const txt = (v / 1000).toFixed(a >= 100000 ? 0 : a >= 10000 ? 1 : 2);
    return `${txt.includes('.') ? txt.replace(/\.?0+$/, '') : txt} t`;
  }
  return `${Math.round(v)} kg`;
}

export function tonnes(v: number, digits = 1): string {
  return `${(v / 1000).toFixed(digits)} t`;
}

export function pct(v: number, digits = 0): string {
  return `${(v * 100).toFixed(digits)}%`;
}

export function hours(v: number): string {
  if (v >= 72) return `${(v / 24).toFixed(1).replace(/\.0$/, '')} d`;
  return `${Math.round(v)} h`;
}

/** Signed percentage-point change: +1.2 pts / −0.4 pts. */
export function pts(delta: number, digits = 1): string {
  const v = delta * 100;
  if (Math.abs(v) < 0.5 * Math.pow(10, -digits)) return '±0 pts';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(digits)} pts`;
}
