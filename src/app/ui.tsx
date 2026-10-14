import { createContext, useCallback, useContext, useState, type ReactNode, type MouseEvent as RME, type FocusEvent as RFE } from 'react';
import type { Grade, Scenario } from '../engine/types';

/* ── icons (24-unit stroke icons) ───────────────────────── */
const P = {
  situation: 'M3 12h4l3-8 4 16 3-8h4',
  plan: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM6 15V9a4 4 0 0 1 4-4h4M18 9v6a4 4 0 0 1-4 4h-4',
  disrupt: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z',
  stress: 'M3 20h18M6 16V9M10 16V5M14 16v-6M18 16v-3',
  tradeoffs: 'M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6',
  benchmark: 'M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11',
  data: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3ZM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  check: 'M20 6 9 17l-5-5',
  alert: 'M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z',
  info: 'M12 16v-4M12 8h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  x: 'M18 6 6 18M6 6l12 12',
  play: 'm6 3 14 9-14 9V3Z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5',
  download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
  upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
  truck: 'M1 4h13v12H1zM14 9h4l4 4v3h-8M5.5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM18.5 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  clock: 'M12 7v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  pin: 'M12 17v5M5 17h14l-2-5V4H7v8l-2 5Z',
  scale: 'M12 3v18M5 7h14M5 7l-3 7a3 3 0 0 0 6 0L5 7ZM19 7l-3 7a3 3 0 0 0 6 0l-3-7ZM8 21h8',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
} as const;
export type IconName = keyof typeof P;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      <path d={P[name]} />
    </svg>
  );
}

export function Logo({ size = 30 }: { size?: number }) {
  // A route that bends into a leaf: the hub dot, the lane, the fresh end.
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="brand-mark">
      <rect width="32" height="32" rx="8" fill="#167a48" />
      <path d="M8 23c3-8 8-12 16-14-1 8-6 13-14 15" fill="#bfe8cf" />
      <path d="M8 24c4-5 8-8 13-10" stroke="#0f3d24" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      <circle cx="8" cy="24" r="2.4" fill="#fffdf8" />
    </svg>
  );
}

/* ── tooltip ─────────────────────────────────────────────── */
interface TipState {
  x: number;
  y: number;
  content: ReactNode;
}
const TipCtx = createContext<{ show: (e: RME | RFE, c: ReactNode) => void; hide: () => void }>({ show: () => {}, hide: () => {} });

export function TipProvider({ children }: { children: ReactNode }) {
  const [tip, setTip] = useState<TipState | null>(null);
  const show = useCallback((e: RME | RFE, content: ReactNode) => {
    let x: number;
    let y: number;
    if ('clientX' in e) {
      x = e.clientX;
      y = e.clientY;
    } else {
      const r = (e.target as Element).getBoundingClientRect();
      x = r.left + r.width / 2;
      y = r.top;
    }
    setTip({ x, y, content });
  }, []);
  const hide = useCallback(() => setTip(null), []);
  const left = tip ? Math.min(tip.x + 14, window.innerWidth - 330) : 0;
  const top = tip ? (tip.y + 140 > window.innerHeight ? tip.y - 120 : tip.y + 14) : 0;
  return (
    <TipCtx.Provider value={{ show, hide }}>
      {children}
      {tip && (
        <div className="tip" style={{ left, top }} role="tooltip">
          {tip.content}
        </div>
      )}
    </TipCtx.Provider>
  );
}
export const useTip = () => useContext(TipCtx);

/** Spread onto any SVG/HTML element to give it a hover + keyboard-focus tooltip. */
export function useTipHandlers() {
  const { show, hide } = useTip();
  return (content: ReactNode) => ({
    onMouseMove: (e: RME) => show(e, content),
    onMouseLeave: hide,
    onFocus: (e: RFE) => show(e, content),
    onBlur: hide,
  });
}

/* ── small components ─────────────────────────────────────── */
export function Stat({
  label,
  value,
  delta,
  hint,
  hero,
}: {
  label: string;
  value: ReactNode;
  /** `dir` is the direction of change (arrow); `good` colours it. */
  delta?: { text: string; good: boolean | null; vs?: string; dir?: 'up' | 'down' | null };
  hint?: string;
  hero?: boolean;
}) {
  return (
    <div className={`card stat${hero ? ' hero' : ''}`} title={hint}>
      <div className="label">{label}</div>
      <div className="value num">{value}</div>
      {delta && (
        <div className="delta">
          <span className={delta.good === null ? 'ink2' : delta.good ? 'good' : 'bad'} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontWeight: 600 }}>
            {delta.dir && <Icon name={delta.dir} size={13} />}
            {delta.text}
          </span>
          {delta.vs && <span className="vs">{delta.vs}</span>}
        </div>
      )}
    </div>
  );
}

export const dirOf = (x: number, eps = 1e-9): 'up' | 'down' | null => (x > eps ? 'up' : x < -eps ? 'down' : null);

export function Empty({ icon = 'info', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Icon name={icon} size={28} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Callout({ kind = 'info', icon, children }: { kind?: 'info' | 'warn' | 'crit' | 'neutral'; icon?: IconName; children: ReactNode }) {
  const i = icon ?? (kind === 'info' ? 'info' : kind === 'neutral' ? 'info' : 'alert');
  return (
    <div className={`callout ${kind}`} role={kind === 'crit' ? 'alert' : undefined}>
      <Icon name={i} size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Progress({ done, total, label }: { done: number; total: number; label?: string }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} aria-live="polite">
      <div className="row small ink2">
        <span className="spinner" style={{ width: 12, height: 12 }} />
        <span>{label ?? 'Working'} · {done}/{total}</span>
      </div>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── semantic colours ─────────────────────────────────────── */

/** Commodity colour by its position in the scenario (fixed order; a 7th+ commodity folds to grey). */
export function commodityColor(s: Scenario, commodityId: string): string {
  const i = s.commodities.findIndex((c) => c.id === commodityId);
  return i >= 0 && i < 6 ? `var(--c${i + 1})` : 'var(--muted)';
}

export const gradeMeta: Record<Grade | 'rejected' | 'spoiled' | 'carried', { label: string; color: string; text: string }> = {
  A: { label: 'List price', color: 'var(--good)', text: 'var(--good-text)' },
  B: { label: 'Markdown only', color: 'var(--warn)', text: 'var(--warn-text)' },
  rejected: { label: 'Rejected', color: 'var(--crit)', text: 'var(--crit-text)' },
  spoiled: { label: 'Spoiled', color: 'var(--crit)', text: 'var(--crit-text)' },
  carried: { label: 'Carried over', color: 'var(--carry)', text: 'var(--carry)' },
};

export function GradeBadge({ grade }: { grade: keyof typeof gradeMeta }) {
  const m = gradeMeta[grade];
  return (
    <span className="badge" style={{ color: m.text }}>
      <Icon name={grade === 'A' ? 'check' : grade === 'carried' ? 'clock' : 'alert'} size={13} />
      {m.label}
    </span>
  );
}

export const urgencyMeta = {
  now: { label: 'Dispatch today', kind: 'crit' },
  soon: { label: 'Next 48 h', kind: 'warn' },
  flexible: { label: 'Can wait', kind: '' },
  stranded: { label: 'Unreachable', kind: 'crit' },
} as const;

export function dayLabel(day: number) {
  return `D${day}`;
}
