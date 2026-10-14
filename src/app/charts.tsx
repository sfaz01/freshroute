import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Outcome, Scenario, SettlementLine } from '../engine/types';
import type { Explanation } from '../engine/explain';
import type { PlanStress } from '../engine/uncertainty';
import { clock, evaluateOption, indexScenario } from '../engine/time';
import { kg, pct, rupeesCompact, hours } from '../engine/fmt';
import { commodityColor, gradeMeta, useTipHandlers } from './ui';
import type { FrontierPoint } from './protocol';

export function useWidth<T extends HTMLElement>(initial = 800): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && Math.abs(cw - w) > 1) setW(cw);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [w]);
  return [ref, w];
}

/* ─────────────────────────── shelf-life timeline ─────────────────────────── */

export function ShelfLifeChart({
  scenario,
  outcome,
  explanation,
  onSelect,
  selected,
}: {
  scenario: Scenario;
  outcome?: Outcome | null;
  explanation?: Explanation | null;
  onSelect?: (batchId: string) => void;
  selected?: string | null;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTipHandlers();
  const ix = indexScenario(scenario);
  const narrow = width < 640;
  const labelW = narrow ? 92 : 168;
  const statusW = narrow ? 0 : 128;
  const rowH = 26;
  const top = 34;
  const xMax = 24 * (scenario.horizonDays + 1) + 12;
  const plotW = Math.max(120, width - labelW - statusW - 12);
  const x = (h: number) => labelW + (Math.max(0, Math.min(xMax, h)) / xMax) * plotW;

  const order = explanation
    ? explanation.priorityOrder
    : [...scenario.batches].sort((a, b) => a.remainingShelfLifeHours - b.remainingShelfLifeHours || a.id.localeCompare(b.id)).map((b) => b.id);
  const linesBy = new Map<string, SettlementLine[]>();
  for (const l of outcome?.lines ?? []) {
    if (!linesBy.has(l.batchId)) linesBy.set(l.batchId, []);
    linesBy.get(l.batchId)!.push(l);
  }
  const height = top + order.length * rowH + 8;
  const days = Array.from({ length: Math.floor(xMax / 24) + 1 }, (_, d) => d);

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg className="chart" width={width} height={height} role="img" aria-label="Shelf-life timeline: each batch's remaining life, dispatch and point of sale">
        <g className="grid">
          {days.map((d) => (
            <g key={d}>
              <line x1={x(d * 24)} x2={x(d * 24)} y1={top - 6} y2={height - 4} />
              <text x={x(d * 24) + 4} y={12}>
                D{d}
              </text>
            </g>
          ))}
        </g>
        {Array.from({ length: scenario.horizonDays }, (_, t) => (
          <g key={`w${t}`} {...tip(<div>Dispatch wave D{t} leaves the hub at {clock(24 * t + scenario.dispatchHour)}</div>)}>
            <path d={`M${x(24 * t + scenario.dispatchHour)} ${top - 14} l4 6 h-8 z`} fill="var(--ink-2)" />
            <rect x={x(24 * t + scenario.dispatchHour) - 8} y={top - 18} width={16} height={14} fill="transparent" />
          </g>
        ))}
        <text x={6} y={26} className="ink2">
          ▾ = trucks leave
        </text>
        {order.map((id, i) => {
          const b = ix.batch.get(id)!;
          const c = ix.commodity.get(b.commodityId)!;
          const y = top + i * rowH + rowH / 2;
          const lines = linesBy.get(id) ?? [];
          const br = outcome?.batches.find((x) => x.batchId === id);
          const brief = explanation?.briefs.get(id);
          const isSel = selected === id;
          const status = !outcome
            ? null
            : brief?.urgency === 'stranded'
              ? { t: 'unreachable', c: 'var(--crit-text)' }
              : br?.leftoverClass === 'spoiled'
                ? { t: `${kg(br.leftoverKg)} spoils`, c: 'var(--crit-text)' }
                : br && br.wastedAtDestKg > 0.5
                  ? { t: `${kg(br.wastedAtDestKg)} lost`, c: 'var(--crit-text)' }
                  : br?.leftoverClass === 'carried'
                    ? { t: `${kg(br.leftoverKg)} carried`, c: 'var(--carry)' }
                    : { t: 'all sold', c: 'var(--good-text)' };
          return (
            <g
              key={id}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={() => onSelect?.(id)}
              tabIndex={onSelect ? 0 : -1}
              role={onSelect ? 'button' : undefined}
              aria-label={`${id} ${c.name}`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect?.(id);
              }}
            >
              <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill={isSel ? 'var(--accent-soft)' : 'transparent'} />
              <rect x={6} y={y - 4} width={8} height={8} rx={2} fill={commodityColor(scenario, b.commodityId)} />
              <text x={20} y={y + 4} className="ink">
                {id}
              </text>
              {!narrow && (
                <text x={92} y={y + 4}>
                  {kg(b.quantityKg)}
                </text>
              )}
              {/* inbound (not yet at hub) */}
              {b.availableFromDay > 0 && (
                <line x1={x(0)} x2={x(24 * b.availableFromDay)} y1={y} y2={y} stroke="var(--line-strong)" strokeDasharray="2 3" strokeWidth={1.5} />
              )}
              {/* remaining life track */}
              <rect
                x={x(24 * b.availableFromDay)}
                y={y - 3}
                width={Math.max(0, x(b.remainingShelfLifeHours) - x(24 * b.availableFromDay))}
                height={6}
                rx={3}
                fill="var(--line-strong)"
                fillOpacity={0.55}
                {...tip(
                  <div>
                    <div className="tv">{id} · {c.name}</div>
                    <div>{kg(b.quantityKg)} · {b.source ?? ''}</div>
                    <div>Shelf life left: {hours(b.remainingShelfLifeHours)} (expires {clock(b.remainingShelfLifeHours)})</div>
                    <div className="muted">Buyers need ≥ {c.fullPriceLifeHours} h for list price, ≥ {c.minSaleLifeHours} h to accept it.</div>
                  </div>,
                )}
              />
              {b.remainingShelfLifeHours > xMax && <path d={`M${x(xMax) - 2} ${y - 5} l6 5 -6 5z`} fill="var(--line-strong)" />}
              {b.remainingShelfLifeHours <= xMax && (
                <line x1={x(b.remainingShelfLifeHours)} x2={x(b.remainingShelfLifeHours)} y1={y - 8} y2={y + 8} stroke="var(--crit)" strokeWidth={2} />
              )}
              {/* planned movements */}
              {[...lines]
                .sort((a, b2) => b2.saleHour - a.saleHour)
                .map((l, k) => {
                  const g = l.grade === 'rejected' ? gradeMeta.rejected : gradeMeta[l.grade];
                  const dest = ix.dest.get(l.destId)!;
                  return (
                    <g
                      key={k}
                      {...tip(
                        <div>
                          <div className="tv">{kg(l.shippedKg)} → {dest.short}</div>
                          <div>Leaves {clock(l.departHour)} · sold {clock(l.saleHour)}</div>
                          <div>{Math.round(l.lifeAtSaleHours)} h of life left at sale · <span style={{ color: g.text }}>{g.label}</span></div>
                          {l.sales.map((s) => (
                            <div key={s.tier}>
                              {kg(s.quantityKg)} at {s.tier === 0 ? 'list' : `−${Math.round(s.discount * 100)}%`} (₹{s.pricePerKg.toFixed(1)}/kg)
                            </div>
                          ))}
                          {l.wastedKg > 0.5 && <div className="bad">{kg(l.wastedKg)} unsold</div>}
                        </div>,
                      )}
                    >
                      <line x1={x(l.departHour)} x2={x(l.saleHour)} y1={y} y2={y} stroke={g.color} strokeWidth={2} strokeLinecap="round" />
                      <circle cx={x(l.departHour)} cy={y} r={2.5} fill="var(--ink-2)" />
                      <circle cx={x(l.saleHour)} cy={y} r={4.5} fill={g.color} stroke="var(--surface)" strokeWidth={2} />
                      <rect x={x(l.departHour)} y={y - 9} width={Math.max(10, x(l.saleHour) - x(l.departHour))} height={18} fill="transparent" />
                    </g>
                  );
                })}
              {status && statusW > 0 && (
                <text x={width - statusW + 8} y={y + 4} style={{ fill: status.c }}>
                  {status.t}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function ShelfLegend({ planned }: { planned: boolean }) {
  return (
    <div className="legend">
      <span className="key"><span className="sw" style={{ background: 'var(--surface-3)', border: '1px solid var(--line-strong)' }} />Remaining shelf life</span>
      <span className="key"><span className="ln" style={{ background: 'var(--crit)', width: 2, height: 12 }} />Expiry</span>
      <span className="key"><span className="ln" style={{ background: 'var(--line-strong)' }} />Inbound, not yet at hub</span>
      {planned && (
        <>
          <span className="key"><span className="ln" style={{ background: gradeMeta.A.color }} />Shipment sold at list price</span>
          <span className="key"><span className="ln" style={{ background: gradeMeta.B.color }} />Arrives too ripe for list price (markdown)</span>
          <span className="key"><span className="ln" style={{ background: gradeMeta.rejected.color }} />Rejected on arrival</span>
        </>
      )}
    </div>
  );
}

/* ─────────────────────────── flow map ─────────────────────────── */

export function FlowMap({ scenario, outcome, height = 360 }: { scenario: Scenario; outcome?: Outcome | null; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>(600);
  const tip = useTipHandlers();
  // Schematic projection: true compass bearing from the hub, distance ∝ √(road hours),
  // so the nearby cluster stays legible next to a 30-hour lane.
  const hub = { x: width * 0.42, y: height * 0.56 };
  const maxSqrt = Math.sqrt(Math.max(1, ...scenario.destinations.map((d) => d.transitHours)));
  const radius = Math.min(width * 0.52, height * 0.54) - 24;
  const raw = scenario.destinations.map((d) => {
    const dy = d.lat - scenario.hub.lat;
    const dx = (d.lon - scenario.hub.lon) * Math.cos((scenario.hub.lat * Math.PI) / 180);
    const ang = Math.atan2(dy, dx);
    const r = 26 + (Math.sqrt(Math.max(0, d.transitHours)) / maxSqrt) * (radius - 26);
    return { id: d.id, x: hub.x + r * Math.cos(ang), y: hub.y - r * Math.sin(ang) };
  });
  // Push apart points closer than 30 px (a few passes are plenty for <20 outlets).
  for (let pass = 0; pass < 30; pass++)
    for (let i = 0; i < raw.length; i++)
      for (let j = i + 1; j < raw.length; j++) {
        const dx = raw[j].x - raw[i].x;
        const dy = raw[j].y - raw[i].y;
        const dist = Math.hypot(dx, dy) || 0.01;
        if (dist < 30) {
          const push = (30 - dist) / 2;
          raw[i].x -= (dx / dist) * push;
          raw[i].y -= (dy / dist) * push;
          raw[j].x += (dx / dist) * push;
          raw[j].y += (dy / dist) * push;
        }
      }
  const pos = new Map(raw.map((p) => [p.id, { x: Math.max(10, Math.min(width - 90, p.x)), y: Math.max(14, Math.min(height - 14, p.y)) }]));
  const P = (id: string) => pos.get(id)!;

  const flows = new Map<string, { kg: number; trucks: number; days: Set<number> }>();
  for (const t of outcome?.trucks ?? []) {
    const f = flows.get(t.destId) ?? { kg: 0, trucks: 0, days: new Set<number>() };
    f.kg += t.loadKg;
    f.trucks += t.trucks;
    f.days.add(t.day);
    flows.set(t.destId, f);
  }
  const maxKg = Math.max(1, ...[...flows.values()].map((f) => f.kg));

  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg className="chart" width={width} height={height} role="img" aria-label="Schematic map: direction from the hub is real, distance shows road time; line width shows planned tonnes">
        <defs>
          <pattern id="dots" width="14" height="14" patternUnits="userSpaceOnUse">
            <circle cx="1" cy="1" r="0.9" fill="var(--line)" />
          </pattern>
        </defs>
        <rect width={width} height={height} fill="url(#dots)" rx={8} />
        {[6, 12, 24].filter((h) => h <= maxSqrt * maxSqrt).map((h) => {
          const r = 26 + (Math.sqrt(h) / maxSqrt) * (radius - 26);
          return (
            <g key={h}>
              <circle cx={hub.x} cy={hub.y} r={r} fill="none" stroke="var(--line)" strokeDasharray="2 4" />
              <text x={hub.x + r * 0.71 + 3} y={hub.y - r * 0.71 - 3}>{h} h</text>
            </g>
          );
        })}
        {scenario.destinations.map((d) => {
          const p = P(d.id);
          const f = flows.get(d.id);
          const dx = p.x - hub.x;
          const dy = p.y - hub.y;
          const cx = (hub.x + p.x) / 2 - dy * 0.18;
          const cy = (hub.y + p.y) / 2 + dx * 0.18;
          const w = f ? 1.5 + (f.kg / maxKg) * 9 : 1;
          const closed = (d.closedDays?.length ?? 0) >= scenario.horizonDays;
          return (
            <g key={d.id}>
              <path
                d={`M${hub.x} ${hub.y} Q${cx} ${cy} ${p.x} ${p.y}`}
                fill="none"
                stroke={f ? 'var(--accent)' : 'var(--line-strong)'}
                strokeWidth={w}
                strokeOpacity={f ? 0.85 : 1}
                strokeDasharray={f ? undefined : closed ? '1 5' : '4 4'}
                strokeLinecap="round"
              />
              <path
                d={`M${hub.x} ${hub.y} Q${cx} ${cy} ${p.x} ${p.y}`}
                fill="none"
                stroke="transparent"
                strokeWidth={16}
                {...tip(
                  <div>
                    <div className="tv">{d.name}</div>
                    <div>{d.transitHours} h road · {d.dockHours} h dock · ₹{d.costPerTruck.toLocaleString('en-IN')}/truck</div>
                    {f ? (
                      <div>
                        Planned: {kg(f.kg)} on {f.trucks} truck{f.trucks === 1 ? '' : 's'} ({[...f.days].sort().map((x) => `D${x}`).join(', ')})
                      </div>
                    ) : (
                      <div className="muted">{closed ? 'Lane closed' : 'No dispatch planned'}</div>
                    )}
                  </div>,
                )}
              />
              <circle cx={p.x} cy={p.y} r={d.salvageOutlet ? 4 : 5} fill={d.salvageOutlet ? 'var(--surface)' : 'var(--ink)'} stroke={d.salvageOutlet ? 'var(--ink-2)' : 'var(--surface)'} strokeWidth={2} />
              <text x={p.x + 8} y={p.y - 4} className="ink" style={{ fontWeight: 600 }}>
                {d.short}
              </text>
              <text x={p.x + 8} y={p.y + 9}>
                {f ? `${kg(f.kg)} · ${f.trucks} truck${f.trucks === 1 ? '' : 's'}` : d.type === 'retail_dc' ? 'retail DC' : d.salvageOutlet ? 'salvage' : `${d.transitHours} h`}
              </text>
            </g>
          );
        })}
        <rect x={hub.x - 7} y={hub.y - 7} width={14} height={14} rx={3} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
        <text x={hub.x - 10} y={hub.y + 22} className="ink" textAnchor="end" style={{ fontWeight: 650 }}>
          {scenario.hub.name.split(' ')[0]} hub
        </text>
      </svg>
    </div>
  );
}

/* ─────────────────────────── demand fill ─────────────────────────── */

export function DemandFill({ scenario, plan, baseline, baselineLabel }: { scenario: Scenario; plan: Outcome; baseline: Outcome; baselineLabel: string }) {
  const tip = useTipHandlers();
  const agg = (o: Outcome) => {
    const m = new Map<string, { demand: number; served: number; markdown: number; salvage: number }>();
    for (const d of o.demand) {
      const e = m.get(d.destId) ?? { demand: 0, served: 0, markdown: 0, salvage: 0 };
      e.demand += d.demandKg;
      e.served += d.fullPriceSoldKg;
      e.markdown += d.markdownSoldKg;
      m.set(d.destId, e);
    }
    return m;
  };
  const p = agg(plan);
  const b = agg(baseline);
  const max = Math.max(1, ...[...p.values()].map((e) => Math.max(e.demand, e.served + e.markdown)));
  return (
    <div className="stack" style={{ gap: 10 }}>
      {scenario.destinations.map((d) => {
        const e = p.get(d.id) ?? { demand: 0, served: 0, markdown: 0, salvage: 0 };
        const be = b.get(d.id) ?? { demand: 0, served: 0, markdown: 0, salvage: 0 };
        const w = (v: number) => `${(v / max) * 100}%`;
        return (
          <div
            key={d.id}
            {...tip(
              <div>
                <div className="tv">{d.name}</div>
                <div>{d.salvageOutlet ? 'Salvage capacity' : 'List-price demand'}: {kg(e.demand)}</div>
                <div>FreshRoute: {kg(e.served)} at list{e.markdown > 0.5 ? ` + ${kg(e.markdown)} marked down` : ''}</div>
                <div className="muted">{baselineLabel}: {kg(be.served)} at list{be.markdown > 0.5 ? ` + ${kg(be.markdown)} marked down` : ''}</div>
              </div>,
            )}
            tabIndex={0}
          >
            <div className="row small" style={{ justifyContent: 'space-between' }}>
              <span>
                <b style={{ fontWeight: 600 }}>{d.short}</b> <span className="muted">{d.salvageOutlet ? 'salvage outlet' : d.type === 'retail_dc' ? `contract · ₹${d.shortfallPenaltyPerKg}/kg shortfall penalty` : ''}</span>
              </span>
              <span className="num ink2">
                {d.salvageOutlet ? kg(e.served + e.markdown) : `${pct(e.demand ? e.served / e.demand : 0)} of ${kg(e.demand)}`}
              </span>
            </div>
            <div style={{ position: 'relative', height: 10, marginTop: 4, background: 'var(--surface-3)', borderRadius: 3, width: w(e.demand) }}>
              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${e.demand ? (e.served / e.demand) * 100 : 0}%`, background: 'var(--accent)', borderRadius: 3 }} />
              <div title="Baseline served" style={{ position: 'absolute', top: -3, bottom: -3, left: `calc(${e.demand ? (be.served / e.demand) * 100 : 0}% - 1px)`, width: 2, background: 'var(--ink-2)' }} />
            </div>
            {e.markdown > 0.5 && (
              <div style={{ height: 4, marginTop: 2, width: w(e.markdown), background: 'var(--warn)', borderRadius: 2 }} />
            )}
          </div>
        );
      })}
      <div className="legend">
        <span className="key"><span className="sw" style={{ background: 'var(--accent)' }} />Served at list price</span>
        <span className="key"><span className="sw" style={{ background: 'var(--surface-3)', border: '1px solid var(--line-strong)' }} />Unserved demand</span>
        <span className="key"><span className="sw" style={{ background: 'var(--warn)', height: 4 }} />Extra sold at a markdown</span>
        <span className="key"><span className="ln" style={{ background: 'var(--ink-2)', width: 2, height: 12 }} />{baselineLabel}</span>
      </div>
    </div>
  );
}

/* ─────────────────────────── stress distribution ─────────────────────────── */

export const planColor = (label: string) =>
  label.startsWith('Baseline · FEFO +') ? 'var(--base-2)' : label.startsWith('Baseline') ? 'var(--base-1)' : label.startsWith('Risk') ? 'var(--alt)' : 'var(--accent)';

export function DistributionPlot({ rows, metric = 'net' }: { rows: PlanStress[]; metric?: 'net' | 'spoilageRate' }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTipHandlers();
  const labelW = width < 640 ? 110 : 190;
  const rowH = 56;
  const top = 8;
  const all = rows.flatMap((r) => r[metric].values);
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (lo === hi) {
    lo -= 1;
    hi += 1;
  }
  const padR = 90;
  const x = (v: number) => labelW + ((v - lo) / (hi - lo)) * (width - labelW - padR);
  const fmt = metric === 'net' ? rupeesCompact : (v: number) => pct(v, 1);
  const height = top + rows.length * rowH + 24;
  const ticks = niceTicks(lo, hi, 5);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg className="chart" width={width} height={height} role="img" aria-label={`Distribution of ${metric} across sampled futures for each plan`}>
        <g className="grid">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={x(t)} x2={x(t)} y1={top} y2={height - 20} />
              <text x={x(t)} y={height - 6} textAnchor="middle">
                {fmt(t)}
              </text>
            </g>
          ))}
        </g>
        {rows.map((r, i) => {
          const d = r[metric];
          const y = top + i * rowH + rowH / 2;
          const color = planColor(r.label);
          // Deterministic jitter so the cloud is stable between renders.
          return (
            <g
              key={r.label}
              tabIndex={0}
              {...tip(
                <div>
                  <div className="tv">{r.label}</div>
                  <div>Mean {fmt(d.mean)} · median {fmt(d.p50)}</div>
                  <div>5th–95th percentile: {fmt(d.p05)} to {fmt(d.p95)}</div>
                  <div className="muted">{d.values.length} futures</div>
                </div>,
              )}
            >
              <rect x={0} y={y - rowH / 2} width={width} height={rowH} fill="transparent" />
              <text x={0} y={y - 4} className="ink" style={{ fontWeight: 600 }}>
                {r.label.replace('Baseline · ', '')}
              </text>
              <text x={0} y={y + 11}>
                {r.label.startsWith('Baseline') ? 'baseline' : ''}
              </text>
              {d.values.map((v, k) => (
                <circle key={k} cx={x(v)} cy={y + (((k * 7919) % 17) - 8) * 1.1} r={2.2} fill={color} fillOpacity={0.35} />
              ))}
              <line x1={x(d.p05)} x2={x(d.p95)} y1={y + 16} y2={y + 16} stroke={color} strokeWidth={2} strokeLinecap="round" />
              <line x1={x(d.mean)} x2={x(d.mean)} y1={y - 14} y2={y + 20} stroke="var(--ink)" strokeWidth={2} />
              <text x={width - padR + 8} y={y + 4} className="ink" style={{ fontWeight: 600 }}>
                {fmt(d.mean)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span className="key"><span className="ln" style={{ background: 'var(--ink)', width: 2, height: 12 }} />Mean</span>
        <span className="key"><span className="ln" style={{ background: 'var(--ink-2)' }} />5th–95th percentile</span>
        <span className="key"><span className="sw" style={{ background: 'var(--ink-2)', opacity: 0.4, borderRadius: '50%', width: 6, height: 6 }} />One sampled future</span>
        {rows.map((r) => (
          <span key={r.label} className="key"><span className="sw" style={{ background: planColor(r.label) }} />{r.label}</span>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────── service / net frontier ─────────────────────────── */

export function FrontierChart({ points, baselines, current }: { points: FrontierPoint[]; baselines: { label: string; net: number; fulfilment: number }[]; current: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const tip = useTipHandlers();
  const height = 300;
  const m = { l: 70, r: 24, t: 16, b: 40 };
  const xs = [...points.map((p) => p.fulfilment), ...baselines.map((b) => b.fulfilment)];
  const ys = [...points.map((p) => p.net), ...baselines.map((b) => b.net)];
  const x0 = Math.min(...xs) - 0.02;
  const x1 = Math.max(...xs) + 0.02;
  const y0 = Math.min(...ys) - Math.abs(Math.max(...ys)) * 0.05;
  const y1 = Math.max(...ys) * 1.03;
  const X = (v: number) => m.l + ((v - x0) / (x1 - x0)) * (width - m.l - m.r);
  const Y = (v: number) => m.t + (1 - (v - y0) / (y1 - y0)) * (height - m.t - m.b);
  const yt = niceTicks(y0, y1, 5);
  const xt = niceTicks(x0, x1, 6);
  const sorted = [...points].sort((a, b) => a.fulfilment - b.fulfilment);
  return (
    <div ref={ref} style={{ width: '100%' }}>
      <svg className="chart" width={width} height={height} role="img" aria-label="Net outcome against demand fulfilment for different service weights">
        <g className="grid">
          {yt.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={width - m.r} y1={Y(t)} y2={Y(t)} />
              <text x={m.l - 8} y={Y(t) + 4} textAnchor="end">{rupeesCompact(t)}</text>
            </g>
          ))}
          {xt.map((t) => (
            <text key={t} x={X(t)} y={height - 18} textAnchor="middle">{pct(t)}</text>
          ))}
        </g>
        <text x={(m.l + width - m.r) / 2} y={height - 2} textAnchor="middle">Customer demand served at list price →</text>
        <path d={sorted.map((p, i) => `${i ? 'L' : 'M'}${X(p.fulfilment)} ${Y(p.net)}`).join(' ')} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" />
        {baselines.map((b) => (
          <g key={b.label} {...tip(<div><div className="tv">{rupeesCompact(b.net)}</div><div>{b.label} · fulfilment {pct(b.fulfilment, 1)}</div></div>)}>
            <circle cx={X(b.fulfilment)} cy={Y(b.net)} r={5} fill={planColor(b.label)} stroke="var(--surface)" strokeWidth={2} />
            <circle cx={X(b.fulfilment)} cy={Y(b.net)} r={12} fill="transparent" />
            <text x={X(b.fulfilment) + 9} y={Y(b.net) + 4}>{b.label.replace('Baseline · ', '')}</text>
          </g>
        ))}
        {points.map((p) => (
          <g key={p.weight} {...tip(<div><div className="tv">{rupeesCompact(p.net)}</div><div>Service weight ₹{p.weight}/kg · fulfilment {pct(p.fulfilment, 1)} · spoilage {pct(p.spoilageRate, 1)}</div></div>)}>
            <circle cx={X(p.fulfilment)} cy={Y(p.net)} r={p.weight === current ? 6 : 4.5} fill={p.weight === current ? 'var(--ink)' : 'var(--accent)'} stroke="var(--surface)" strokeWidth={2} />
            <circle cx={X(p.fulfilment)} cy={Y(p.net)} r={12} fill="transparent" />
            <text x={X(p.fulfilment)} y={Y(p.net) - 10} textAnchor="middle" className="ink2">₹{p.weight}</text>
          </g>
        ))}
      </svg>
      <div className="legend">
        <span className="key"><span className="ln" style={{ background: 'var(--accent)' }} />FreshRoute at each service weight (₹ per kg served, label)</span>
        <span className="key"><span className="sw" style={{ background: 'var(--base-1)', borderRadius: '50%' }} />Baseline · FEFO</span>
        <span className="key"><span className="sw" style={{ background: 'var(--base-2)', borderRadius: '50%' }} />Baseline · FEFO + clearance</span>
      </div>
    </div>
  );
}

export function niceTicks(lo: number, hi: number, n: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= step0) ?? 10 * mag;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/* ─────────────────────────── reachability (situation view) ─────────────────────────── */

export interface Reach {
  batchId: string;
  lastListPriceDay: number | null;
  lastSaleDay: number | null;
  listDests: number;
}

export function reachability(s: Scenario): Map<string, Reach> {
  const ix = indexScenario(s);
  const out = new Map<string, Reach>();
  for (const b of s.batches) {
    let lastList: number | null = null;
    let lastSale: number | null = null;
    const listDests = new Set<string>();
    for (const d of s.destinations)
      for (let t = 0; t < s.horizonDays; t++) {
        const o = evaluateOption(ix, b, d, t);
        if (!o.feasible) continue;
        lastSale = Math.max(lastSale ?? -1, t);
        if (o.grade === 'A' && !d.salvageOutlet) {
          lastList = Math.max(lastList ?? -1, t);
          listDests.add(d.id);
        }
      }
    out.set(b.id, { batchId: b.id, lastListPriceDay: lastList, lastSaleDay: lastSale, listDests: listDests.size });
  }
  return out;
}

export function Mini({ children }: { children: ReactNode }) {
  return <span className="small muted">{children}</span>;
}
