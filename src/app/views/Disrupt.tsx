import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { Callout, Empty, Icon, Stat, dirOf } from '../ui';
import { ShelfLifeChart, ShelfLegend } from '../charts';
import { presetEvents, type Disruption } from '../../engine/disruptions';
import { kg, pct, rupeesCompact, rupeesDelta } from '../../engine/fmt';

type Kind = Disruption['kind'];
const KINDS: { value: Exclude<Kind, 'new_batch'>; label: string }[] = [
  { value: 'lane_delay', label: 'Transit delay on a lane' },
  { value: 'lane_closure', label: 'Lane closure' },
  { value: 'fleet_change', label: 'Fleet size change' },
  { value: 'demand_change', label: 'Demand change at an outlet' },
  { value: 'price_change', label: 'Price change at an outlet' },
  { value: 'shelf_life_change', label: 'Shelf-life re-estimate' },
  { value: 'new_order', label: 'New order' },
];

export function Disrupt() {
  const st = useStore();
  const s = st.scenario;
  const presets = useMemo(() => presetEvents(s), [s]);
  const [sel, setSel] = useState<string>(presets[0]?.id ?? 'custom');
  const [custom, setCustom] = useState({
    kind: 'lane_delay' as Exclude<Kind, 'new_batch'>,
    destId: s.destinations[0]?.id ?? '',
    commodityId: s.commodities[0]?.id ?? '',
    day: 1,
    hours: 12,
    trucks: 2,
    factor: 0.6,
    qty: 2000,
    price: 30,
    asOfDay: 1,
  });

  if (!st.plan.data || st.plan.data.result.status === 'infeasible')
    return (
      <div className="card">
        <Empty icon="disrupt" title="Replanning needs a plan to disrupt">
          <p>Generate the dispatch plan first; disruptions are applied to it as the night unfolds.</p>
          <button className="btn primary" onClick={() => { st.runPlan(); }}>
            <Icon name="play" size={14} /> Generate dispatch plan
          </button>
        </Empty>
      </div>
    );

  const buildCustom = (): { changes: Disruption[]; asOfDay: number; title: string } => {
    const c = custom;
    const days = Array.from({ length: s.horizonDays - c.day }, (_, i) => c.day + i);
    const destShort = s.destinations.find((d) => d.id === c.destId)?.short;
    switch (c.kind) {
      case 'lane_delay':
        return { changes: [{ kind: 'lane_delay', destId: c.destId, days, extraHours: c.hours }], asOfDay: c.asOfDay, title: `${destShort} lane +${c.hours} h from D${c.day}` };
      case 'lane_closure':
        return { changes: [{ kind: 'lane_closure', destId: c.destId, days }], asOfDay: c.asOfDay, title: `${destShort} lane closed from D${c.day}` };
      case 'fleet_change':
        return { changes: [{ kind: 'fleet_change', days, trucks: c.trucks }], asOfDay: c.asOfDay, title: `${c.trucks} trucks/night from D${c.day}` };
      case 'demand_change':
        return { changes: [{ kind: 'demand_change', destId: c.destId, fromSession: c.day + 1, factor: c.factor }], asOfDay: c.asOfDay, title: `${destShort} demand ×${c.factor}` };
      case 'price_change':
        return { changes: [{ kind: 'price_change', destId: c.destId, fromSession: c.day + 1, factor: c.factor }], asOfDay: c.asOfDay, title: `${destShort} prices ×${c.factor}` };
      case 'shelf_life_change':
        return { changes: [{ kind: 'shelf_life_change', commodityId: c.commodityId, factor: c.factor }], asOfDay: c.asOfDay, title: `${c.commodityId} shelf life ×${c.factor}` };
      case 'new_order':
        return {
          changes: [{ kind: 'new_order', destId: c.destId, commodityId: c.commodityId, session: c.day + 1, quantityKg: c.qty, pricePerKg: c.price }],
          asOfDay: c.asOfDay,
          title: `New order ${kg(c.qty)} ${c.commodityId} → ${destShort}`,
        };
    }
  };

  const active = sel === 'custom' ? null : presets.find((p) => p.id === sel);
  const run = () => {
    if (active) st.runReplan({ changes: active.changes, asOfDay: active.asOfDay, eventId: active.id });
    else {
      const c = buildCustom();
      st.runReplan({ changes: c.changes, asOfDay: c.asOfDay, eventId: 'custom' });
    }
  };
  const rp = st.replan;
  const original = st.plan.data.result.outcome.totals;
  const num = (v: string) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="upper">Step 3 · Live operations</div>
          <h1>Disrupt & replan</h1>
          <p>
            Something changes after the plan is made. Trucks that have already left are frozen; FreshRoute re-optimises everything that has not, and shows what
            executing the old plan unchanged would have cost.
          </p>
        </div>
      </div>

      <div className="grid g3" style={{ marginBottom: 12 }}>
        {presets.map((p) => (
          <button key={p.id} className="event" aria-pressed={sel === p.id} onClick={() => setSel(p.id)}>
            <span className="row" style={{ gap: 6 }}>
              <span className="chip">{p.asOfDay === 0 ? 'Before D0 dispatch' : `Known on D${p.asOfDay}`}</span>
            </span>
            <h4>{p.title}</h4>
            <p>{p.detail}</p>
          </button>
        ))}
        <button className="event" aria-pressed={sel === 'custom'} onClick={() => setSel('custom')}>
          <span className="row"><span className="chip">Your own</span></span>
          <h4>Custom disruption</h4>
          <p>Build any delay, closure, fleet, demand, price, shelf-life or order change.</p>
        </button>
      </div>

      {sel === 'custom' && (
        <div className="card card-pad" style={{ marginBottom: 12 }}>
          <div className="row" style={{ alignItems: 'flex-end', gap: 12 }}>
            <label className="field">
              Change
              <select value={custom.kind} onChange={(e) => setCustom({ ...custom, kind: e.target.value as typeof custom.kind })}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>{k.label}</option>
                ))}
              </select>
            </label>
            {['lane_delay', 'lane_closure', 'demand_change', 'price_change', 'new_order'].includes(custom.kind) && (
              <label className="field">
                Outlet
                <select value={custom.destId} onChange={(e) => setCustom({ ...custom, destId: e.target.value })}>
                  {s.destinations.map((d) => (
                    <option key={d.id} value={d.id}>{d.short}</option>
                  ))}
                </select>
              </label>
            )}
            {['shelf_life_change', 'new_order'].includes(custom.kind) && (
              <label className="field">
                Commodity
                <select value={custom.commodityId} onChange={(e) => setCustom({ ...custom, commodityId: e.target.value })}>
                  {s.commodities.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </label>
            )}
            {custom.kind !== 'shelf_life_change' && (
              <label className="field">
                {custom.kind === 'new_order' ? 'Dispatch day it must leave' : custom.kind === 'demand_change' || custom.kind === 'price_change' ? 'From loads leaving on' : 'From dispatch night'}
                <select value={custom.day} onChange={(e) => setCustom({ ...custom, day: num(e.target.value) })}>
                  {Array.from({ length: s.horizonDays }, (_, d) => d)
                    .filter((d) => d >= custom.asOfDay)
                    .map((d) => (
                      <option key={d} value={d}>D{d}</option>
                    ))}
                </select>
              </label>
            )}
            {custom.kind === 'lane_delay' && (
              <label className="field">
                Extra hours
                <input type="number" min={1} max={72} value={custom.hours} onChange={(e) => setCustom({ ...custom, hours: num(e.target.value) })} style={{ width: 80 }} />
              </label>
            )}
            {custom.kind === 'fleet_change' && (
              <label className="field">
                Trucks per night
                <input type="number" min={0} max={30} value={custom.trucks} onChange={(e) => setCustom({ ...custom, trucks: num(e.target.value) })} style={{ width: 80 }} />
              </label>
            )}
            {['demand_change', 'price_change', 'shelf_life_change'].includes(custom.kind) && (
              <label className="field">
                Multiply by
                <input type="number" step={0.05} min={0} max={3} value={custom.factor} onChange={(e) => setCustom({ ...custom, factor: num(e.target.value) })} style={{ width: 80 }} />
              </label>
            )}
            {custom.kind === 'new_order' && (
              <>
                <label className="field">
                  Quantity (kg)
                  <input type="number" min={100} step={100} value={custom.qty} onChange={(e) => setCustom({ ...custom, qty: num(e.target.value) })} style={{ width: 100 }} />
                </label>
                <label className="field">
                  Price (₹/kg)
                  <input type="number" min={1} value={custom.price} onChange={(e) => setCustom({ ...custom, price: num(e.target.value) })} style={{ width: 80 }} />
                </label>
              </>
            )}
            <label className="field">
              Known on
              <select value={custom.asOfDay} onChange={(e) => setCustom({ ...custom, asOfDay: num(e.target.value), day: Math.max(custom.day, num(e.target.value)) })}>
                {Array.from({ length: s.horizonDays }, (_, d) => (
                  <option key={d} value={d}>D{d}{d === 0 ? ' (before any dispatch)' : ` (D0–D${d - 1} trucks already left)`}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="small muted" style={{ margin: '8px 0 0' }}>{buildCustom().title}</p>
        </div>
      )}

      <div className="row" style={{ marginBottom: 16 }}>
        <button className="btn primary" onClick={run} disabled={rp.status === 'running'}>
          {rp.status === 'running' ? <span className="spinner" style={{ width: 13, height: 13 }} /> : <Icon name="disrupt" size={14} />} Apply disruption and replan
        </button>
        {active && <span className="small ink2">Trucks dispatched before D{active.asOfDay} are frozen.</span>}
      </div>

      {rp.status === 'error' && <Callout kind="crit">Replanning failed: {rp.error}</Callout>}
      {rp.status === 'done' && rp.data && (
        <ReplanResultView original={original} />
      )}
    </>
  );
}

function ReplanResultView({ original }: { original: { net: number; spoiledKg: number; fulfilment: number } }) {
  const st = useStore();
  const rp = st.replan.data!;
  const s = rp.disrupted;
  const stale = rp.stale.totals;
  const next = rp.replanned.outcome.totals;
  const v = rp.valueOfReplanning;
  const byBatch = new Map<string, typeof rp.diff>();
  for (const d of rp.diff) {
    if (!byBatch.has(d.batchId)) byBatch.set(d.batchId, []);
    byBatch.get(d.batchId)!.push(d);
  }
  const destShort = (id: string) => s.destinations.find((d) => d.id === id)?.short ?? id;
  return (
    <div className="stack">
      {rp.replanned.status === 'infeasible' && <Callout kind="crit">{rp.replanned.message}</Callout>}
      <div className="grid g4">
        <Stat label="Before the disruption" value={rupeesCompact(original.net)} delta={{ text: `spoilage ${kg(original.spoiledKg)}`, good: null, vs: 'the plan as made' }} />
        <Stat label="Old plan, executed unchanged" value={rupeesCompact(stale.net)} delta={{ text: `${rp.stale.violations.length} breakdowns`, good: rp.stale.violations.length === 0, vs: `spoilage ${kg(stale.spoiledKg)}` }} />
        <Stat hero label="Replanned" value={rupeesCompact(next.net)} delta={{ text: rupeesDelta(v.net), dir: dirOf(v.net, 1), good: v.net >= -1, vs: 'vs executing the old plan' }} />
        <Stat
          label="Spoilage avoided by replanning"
          value={kg(Math.max(0, stale.spoiledKg - next.spoiledKg))}
          delta={{ text: `fulfilment ${pct(next.fulfilment, 1)}`, good: next.fulfilment >= stale.fulfilment - 0.0005, vs: `vs ${pct(stale.fulfilment, 1)}` }}
        />
      </div>
      {rp.summary.map((line, i) => (
        <Callout key={i} kind={i === 0 && rp.stale.violations.length ? 'warn' : 'info'}>{line}</Callout>
      ))}
      <div className="grid g2">
        <div className="card">
          <div className="card-head">
            <h2>What changes from D{rp.asOfDay}</h2>
            <span className="sub">{rp.diff.length} dispatch lines differ</span>
          </div>
          <div className="card-body">
            {rp.diff.length === 0 ? (
              <p className="small muted">The remaining plan is already the best response.</p>
            ) : (
              <div className="table-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                <table className="t">
                  <thead>
                    <tr><th>Batch</th><th>Was</th><th>Now</th></tr>
                  </thead>
                  <tbody>
                    {[...byBatch.entries()].map(([b, rows]) => (
                      <tr key={b}>
                        <td style={{ fontWeight: 600 }}>{b}</td>
                        <td className="small ink2">
                          {rows.filter((r) => r.beforeKg > 0).map((r) => `${kg(r.beforeKg)} → ${destShort(r.destId)} D${r.day}`).join(', ') || '—'}
                        </td>
                        <td className="small">
                          {rows.filter((r) => r.afterKg > 0).map((r) => `${kg(r.afterKg)} → ${destShort(r.destId)} D${r.day}`).join(', ') || <span className="bad">held / not shipped</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>How the old plan breaks</h2>
            <span className="sub">Executed unchanged in the new conditions</span>
          </div>
          <div className="card-body">
            {rp.stale.violations.length === 0 ? (
              <p className="small muted">Nothing breaks outright — the old plan just leaves money on the table ({rupeesDelta(v.net)}).</p>
            ) : (
              <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4, maxHeight: 380, overflowY: 'auto' }}>
                {rp.stale.violations.slice(0, 30).map((x, i) => (
                  <li key={i} className="ink2">{x.message}</li>
                ))}
                {rp.stale.violations.length > 30 && <li className="muted">…and {rp.stale.violations.length - 30} more</li>}
              </ul>
            )}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h2>Replanned shelf-life use</h2>
          <span className="sub">In the disrupted world. Frozen D0{rp.asOfDay > 1 ? `–D${rp.asOfDay - 1}` : ''} loads included.</span>
        </div>
        <div className="card-body">
          <ShelfLifeChart scenario={s} outcome={rp.replanned.outcome} explanation={rp.explanation} />
          <div style={{ marginTop: 8 }}>
            <ShelfLegend planned />
          </div>
        </div>
      </div>
    </div>
  );
}
