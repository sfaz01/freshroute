import { useState } from 'react';
import { useStore } from '../store';
import { Callout, Empty, GradeBadge, Icon, Seg, Stat, commodityColor, dirOf, useTipHandlers } from '../ui';
import { DemandFill, FlowMap, ShelfLifeChart, ShelfLegend } from '../charts';
import { audit } from '../../engine/ledger';
import { clock } from '../../engine/time';
import { kg, pct, perKg, pts, rupees, rupeesCompact, rupeesDelta } from '../../engine/fmt';
import type { Outcome, Totals } from '../../engine/types';
import type { PlanBundle } from '../protocol';

export function download(name: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function PlanView() {
  const st = useStore();
  const { plan } = st;
  if (plan.status === 'idle')
    return (
      <div className="card">
        <Empty icon="plan" title="No plan yet">
          <p>Run the engine to allocate every batch, schedule the trucks and price the markdowns.</p>
          <button className="btn primary" onClick={st.runPlan}>
            <Icon name="play" size={14} /> Generate dispatch plan
          </button>
        </Empty>
      </div>
    );
  if (plan.status === 'error')
    return (
      <Callout kind="crit">
        The engine failed: {plan.error}. <button className="btn sm" onClick={st.runPlan}>Try again</button>
      </Callout>
    );
  if (!plan.data)
    return (
      <div className="card">
        <Empty icon="plan" title="Solving…">
          <p className="row" style={{ justifyContent: 'center' }}>
            <span className="spinner" /> Building the model, solving it with HiGHS and scoring both baselines on the same ledger.
          </p>
        </Empty>
      </div>
    );
  return <PlanBody bundle={plan.data} running={plan.status === 'running'} />;
}

function PlanBody({ bundle, running }: { bundle: PlanBundle; running: boolean }) {
  const st = useStore();
  const s = st.scenario;
  const { result, explanation } = bundle;
  const base = st.baselineKind === 'fefo' ? bundle.fefo : bundle.clearance;
  const baseLabel = st.baselineKind === 'fefo' ? 'Baseline · FEFO' : 'Baseline · FEFO + clearance';
  const t = result.outcome.totals;
  const b = base.outcome.totals;
  const checks = audit(result.outcome);
  const passed = checks.filter((c) => c.passed).length;

  if (result.status === 'infeasible' || result.status === 'error') {
    return (
      <div className="stack">
        <Callout kind="crit">
          <b>{result.status === 'infeasible' ? 'These overrides cannot all be met.' : 'Solver error.'}</b> {result.message} Remove an override to restore a plan.
        </Callout>
        <Overrides />
      </div>
    );
  }

  return (
    <div className={running ? 'stale' : undefined}>
      <div className="page-head">
        <div>
          <div className="upper">Step 2 · Recommended plan</div>
          <h1>Dispatch plan</h1>
          <p>Every allocation, truck and markdown below comes from the optimiser; every number is booked by the same ledger that scores the baseline.</p>
        </div>
        <div className="actions">
          <Seg
            label="Baseline to compare against"
            value={st.baselineKind}
            onChange={st.setBaselineKind}
            options={[
              { value: 'clearance', label: 'vs FEFO + clearance' },
              { value: 'fefo', label: 'vs FEFO' },
            ]}
          />
          <button className="btn" onClick={() => download(`freshroute-plan-${s.id}.json`, { scenario: s.id, plan: result.plan, totals: t, baseline: { label: baseLabel, totals: b } })}>
            <Icon name="download" size={14} /> Export
          </button>
        </div>
      </div>

      <Overrides />

      <div className="grid g4" style={{ marginBottom: 12 }}>
        <Stat hero label="Net outcome" value={rupeesCompact(t.net)} delta={{ text: rupeesDelta(t.net - b.net), dir: dirOf(t.net - b.net, 1), good: t.net >= b.net - 1, vs: `vs ${rupeesCompact(b.net)} (${baseLabel.replace('Baseline · ', '')})` }} />
        <Stat
          hero
          label="Spoilage"
          value={kg(t.spoiledKg)}
          delta={{ text: `${pct(t.spoilageRate, 1)} of stock`, dir: dirOf(t.spoiledKg - b.spoiledKg, 0.5), good: t.spoiledKg <= b.spoiledKg + 0.5, vs: `vs ${kg(b.spoiledKg)} (${pct(b.spoilageRate, 1)})` }}
        />
        <Stat
          hero
          label="Demand served at list price"
          value={pct(t.fulfilment, 1)}
          delta={{ text: pts(t.fulfilment - b.fulfilment), dir: dirOf(t.fulfilment - b.fulfilment, 0.0005), good: Math.abs(t.fulfilment - b.fulfilment) < 0.0005 ? null : t.fulfilment > b.fulfilment, vs: `vs ${pct(b.fulfilment, 1)} · lowest outlet ${pct(t.minDestinationFill)}` }}
        />
        <Stat hero label="Trucks dispatched" value={t.trucksUsed} delta={{ text: `${t.trucksUsed - b.trucksUsed >= 0 ? '+' : ''}${t.trucksUsed - b.trucksUsed}`, good: null, vs: `vs ${b.trucksUsed} · ${rupeesCompact(t.transportCost)} freight` }} />
      </div>

      <div className="proof" style={{ marginBottom: 16 }}>
        <span className={result.stats.provenOptimal ? 'ok' : 'warnt'}>
          <Icon name={result.stats.provenOptimal ? 'check' : 'alert'} size={13} /> {result.stats.provenOptimal ? 'Proven optimal (gap ≤ 0.01%)' : 'Best feasible, not proven optimal'}
        </span>
        <span>
          <b>{result.stats.solver}</b> · {result.stats.solveMs.toFixed(0)} ms · {result.stats.variables} variables · {result.stats.integers} integer truck counts · {result.stats.constraints} constraints
        </span>
        <span className={passed === checks.length ? 'ok' : 'bad'} title={checks.map((c) => `${c.passed ? '✓' : '✗'} ${c.label}: ${c.detail}`).join('\n')}>
          <Icon name={passed === checks.length ? 'check' : 'alert'} size={13} /> {passed}/{checks.length} hard-constraint audits passed
        </span>
        <span title="Model objective vs. the independent ledger's net">Books balance to {rupees(result.consistencyGap)}</span>
        <span>Same ledger, prices and costs for both plans</span>
      </div>

      <div style={{ marginBottom: 16 }}>
        <DispatchBoard bundle={bundle} />
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <LedgerCard plan={t} base={b} baseLabel={baseLabel} />
        <div className="card">
          <div className="card-head">
            <h2>Demand served by outlet</h2>
            <span className="sub">List-price demand across the horizon</span>
          </div>
          <div className="card-body">
            <DemandFill scenario={s} plan={result.outcome} baseline={base.outcome} baselineLabel={baseLabel} />
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <h2>Shelf life spent, batch by batch</h2>
          <span className="sub">Each line runs from departure to the market session it sells in. Click a batch for its receipt.</span>
        </div>
        <div className="card-body">
          <ShelfLifeChart scenario={s} outcome={result.outcome} explanation={explanation} onSelect={(id) => st.openBatch(id)} selected={st.selectedBatch} />
          <div style={{ marginTop: 8 }}>
            <ShelfLegend planned />
          </div>
        </div>
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h2>Planned flows</h2>
            <span className="sub">Schematic · distance = road time · width = tonnes over the horizon</span>
          </div>
          <div className="card-body">
            <FlowMap scenario={s} outcome={result.outcome} height={340} />
          </div>
        </div>
        <PriorityList bundle={bundle} />
      </div>

      <MarkdownDesk bundle={bundle} />
    </div>
  );
}

function Overrides() {
  const st = useStore();
  if (st.pins.length === 0) return null;
  return (
    <div className="card card-pad" style={{ marginBottom: 12 }}>
      <div className="row">
        <span className="upper">Operator overrides in force</span>
        {st.pins.map((p, i) => (
          <span key={i} className="chip warn">
            <Icon name="pin" size={12} />
            {p.kind === 'force'
              ? `${p.batchId} → ${st.scenario.destinations.find((d) => d.id === p.destId)?.short ?? p.destId} ≥ ${kg(p.minKg)}`
              : `No ${p.batchId ?? 'stock'} → ${st.scenario.destinations.find((d) => d.id === p.destId)?.short ?? p.destId}`}
            {p.note ? ` · ${p.note}` : ''}
            <button aria-label="Remove override" onClick={() => st.removePin(i)}>
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function DispatchBoard({ bundle }: { bundle: PlanBundle }) {
  const st = useStore();
  const s = st.scenario;
  const { outcome } = bundle.result;
  const prio = new Map(bundle.explanation.priorityOrder.map((id, i) => [id, i]));
  const days = Array.from({ length: s.horizonDays }, (_, d) => d);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Dispatch board</h2>
        <span className="sub">Truck manifests per night, loads in priority order</span>
      </div>
      <div className="card-body">
        <div className="board">
          {days.map((day) => {
            const trucks = outcome.trucks.filter((t) => t.day === day && t.day >= 0);
            const used = trucks.reduce((a, t) => a + t.trucks, 0);
            const avail = s.fleet.trucksPerDay[day] ?? 0;
            return (
              <div key={day} className="day-col">
                <h3>
                  D{day} · {clock(24 * day + s.dispatchHour).slice(3)}
                  <span className="chip" style={{ marginLeft: 'auto' }}>
                    <Icon name="truck" size={12} /> {used}/{avail}
                  </span>
                </h3>
                <div className="meter" title={`${used} of ${avail} trucks`}>
                  <span style={{ width: `${avail ? (used / avail) * 100 : 0}%` }} />
                </div>
                {trucks.length === 0 && <div className="small muted">No trucks needed.</div>}
                {trucks
                  .sort((a, b) => b.loadKg - a.loadKg)
                  .map((t) => {
                    const dest = s.destinations.find((d) => d.id === t.destId)!;
                    const lines = outcome.lines
                      .filter((l) => l.destId === t.destId && l.day === day)
                      .sort((a, b) => (prio.get(a.batchId) ?? 99) - (prio.get(b.batchId) ?? 99));
                    return (
                      <div key={t.destId} className="truck">
                        <div className="tk-head">
                          {dest.short}
                          <span className="small muted" style={{ marginLeft: 'auto', fontWeight: 500 }}>
                            {t.trucks > 1 ? `${t.trucks} trucks · ` : ''}
                            {pct(t.loadKg / t.capacityKg)} full
                          </span>
                        </div>
                        <div className="tk-meta">
                          {kg(t.loadKg)} · {rupees(t.cost)} · sells {clock(lines[0]?.saleHour ?? 0)}
                        </div>
                        <LoadList lines={lines} bundle={bundle} />
                      </div>
                    );
                  })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function LoadList({ lines, bundle }: { lines: Outcome['lines']; bundle: PlanBundle }) {
  const st = useStore();
  const s = st.scenario;
  const tip = useTipHandlers();
  const [open, setOpen] = useState(false);
  const shown = open ? lines : lines.slice(0, 5);
  const rest = lines.slice(5);
  return (
    <>
                        {shown.map((l) => (
                          <button
                            key={l.batchId}
                            className="load"
                            onClick={() => st.openBatch(l.batchId)}
                            {...tip(
                              <div>
                                <div className="tv">{l.batchId} · {kg(l.shippedKg)}</div>
                                <div>{Math.round(l.lifeAtSaleHours)} h of shelf life left at sale</div>
                                <div className="muted">{bundle.explanation.briefs.get(l.batchId)?.headline}</div>
                              </div>,
                            )}
                          >
                            <span className="cdot" style={{ background: commodityColor(s, l.commodityId) }} />
                            <span>
                              {l.batchId}{' '}
                              {l.grade !== 'A' && (
                                <span className="tiny" style={{ color: l.grade === 'B' ? 'var(--warn-text)' : 'var(--crit-text)' }}>
                                  {l.grade === 'B' ? 'markdown' : 'rejected'}
                                </span>
                              )}
                            </span>
                            <span className="num ink2">{kg(l.shippedKg)}</span>
                          </button>
                        ))}
      {rest.length > 0 && (
        <button className="btn ghost sm" style={{ width: '100%', marginTop: 2 }} onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `+ ${rest.length} more load${rest.length > 1 ? 's' : ''} (${kg(rest.reduce((a, l) => a + l.shippedKg, 0))})`}
        </button>
      )}
    </>
  );
}

function LedgerCard({ plan, base, baseLabel }: { plan: Totals; base: Totals; baseLabel: string }) {
  const rows: { label: string; key: keyof Totals; sign: 1 | -1; note?: string }[] = [
    { label: 'Sales revenue', key: 'revenue', sign: 1, note: 'kg actually sold × price realised' },
    { label: 'Transport', key: 'transportCost', sign: -1, note: 'trucks × lane rate (+ per-kg freight)' },
    { label: 'Handling', key: 'handlingCost', sign: -1, note: 'every kg dispatched' },
    { label: 'Spoilage cost', key: 'spoilageCost', sign: -1, note: 'spoiled kg × write-off + disposal' },
    { label: 'Contract shortfall', key: 'shortfallPenalty', sign: -1, note: 'unserved contract demand × penalty' },
    { label: 'Carry-over stock', key: 'carryValue', sign: 1, note: 'still-viable stock at horizon end' },
  ];
  const max = Math.max(...rows.map((r) => Math.max(Math.abs(plan[r.key] as number), Math.abs(base[r.key] as number))), 1);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Ledger</h2>
        <span className="sub">Identical accounting for both plans</span>
      </div>
      <div className="card-body">
        <div className="table-wrap">
          <table className="t">
            <thead>
              <tr>
                <th></th>
                <th className="r">{baseLabel.replace('Baseline · ', '')}</th>
                <th className="r">FreshRoute</th>
                <th className="r">Δ net</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const pv = plan[r.key] as number;
                const bv = base[r.key] as number;
                const d = r.sign * (pv - bv);
                return (
                  <tr key={r.key} title={r.note}>
                    <td style={{ minWidth: 150 }}>
                      {r.sign < 0 ? '− ' : '+ '}
                      {r.label}
                      <div style={{ display: 'grid', gap: 2, marginTop: 4 }}>
                        <div style={{ height: 4, width: `${(Math.abs(bv) / max) * 100}%`, background: 'var(--base-2)', borderRadius: 2 }} />
                        <div style={{ height: 4, width: `${(Math.abs(pv) / max) * 100}%`, background: 'var(--accent)', borderRadius: 2 }} />
                      </div>
                    </td>
                    <td className="r num">{rupeesCompact(bv)}</td>
                    <td className="r num">{rupeesCompact(pv)}</td>
                    <td className={`r num ${Math.abs(d) < 1 ? 'muted' : d > 0 ? 'good' : 'bad'}`} style={{ whiteSpace: 'nowrap' }}>{rupeesDelta(d)}</td>
                  </tr>
                );
              })}
              <tr>
                <td style={{ fontWeight: 650 }}>= Net outcome</td>
                <td className="r num" style={{ fontWeight: 650 }}>{rupeesCompact(base.net)}</td>
                <td className="r num" style={{ fontWeight: 650 }}>{rupeesCompact(plan.net)}</td>
                <td className={`r num ${plan.net >= base.net ? 'good' : 'bad'}`} style={{ fontWeight: 650 }}>{rupeesDelta(plan.net - base.net)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="legend" style={{ marginTop: 10 }}>
          <span className="key"><span className="sw" style={{ background: 'var(--base-2)' }} />{baseLabel}</span>
          <span className="key"><span className="sw" style={{ background: 'var(--accent)' }} />FreshRoute</span>
        </div>
        <dl className="kv" style={{ marginTop: 12 }}>
          <dt>Discount given</dt>
          <dd className="num">{rupeesCompact(plan.discountGiven)} on {kg(plan.markdownSoldKg)} <span className="muted">(baseline {rupeesCompact(base.discountGiven)})</span></dd>
          <dt>Spoiled at hub / at market</dt>
          <dd className="num">{kg(plan.spoiledAtHubKg)} / {kg(plan.spoiledAtDestKg)} <span className="muted">(baseline {kg(base.spoiledAtHubKg)} / {kg(base.spoiledAtDestKg)})</span></dd>
          <dt>Sold to processor</dt>
          <dd className="num">{kg(plan.salvageSoldKg)} <span className="muted">(baseline {kg(base.salvageSoldKg)})</span></dd>
        </dl>
      </div>
    </div>
  );
}

function PriorityList({ bundle }: { bundle: PlanBundle }) {
  const st = useStore();
  const s = st.scenario;
  const { explanation } = bundle;
  const order = explanation.priorityOrder.map((id) => explanation.briefs.get(id)!).slice(0, 12);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Dispatch priority</h2>
        <span className="sub">By how soon each batch loses list price, then its last sale day</span>
      </div>
      <div className="card-body">
        <table className="t">
          <thead>
            <tr>
              <th>#</th>
              <th>Batch</th>
              <th>Window</th>
              <th>Outcome</th>
            </tr>
          </thead>
          <tbody>
            {order.map((b) => (
              <tr key={b.batch.id} className="click" onClick={() => st.openBatch(b.batch.id)}>
                <td className="num muted">{b.priority}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <span className="badge">
                    <span className="dot" style={{ background: commodityColor(s, b.batch.commodityId) }} />
                    {b.batch.id}
                  </span>
                </td>
                <td className="small" style={{ whiteSpace: 'nowrap' }}>
                  <span className={b.urgency === 'now' || b.urgency === 'stranded' ? 'bad' : b.urgency === 'soon' ? 'warnt' : 'ink2'}>
                    {b.urgency === 'stranded'
                      ? 'unreachable'
                      : b.lastListPriceDay !== null
                        ? `list price until D${b.lastListPriceDay}`
                        : `markdown only, until D${b.lastSaleDay}`}
                  </span>
                </td>
                <td className="small ink2">{b.headline}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="small muted" style={{ marginTop: 8 }}>Showing the 12 most urgent of {explanation.priorityOrder.length}. Click any row for its receipt.</p>
      </div>
    </div>
  );
}

function MarkdownDesk({ bundle }: { bundle: PlanBundle }) {
  const st = useStore();
  const s = st.scenario;
  const ds = bundle.explanation.discounts;
  const total = ds.reduce((a, d) => a + d.quantityKg, 0);
  return (
    <div className="card">
      <div className="card-head">
        <h2>Markdown desk</h2>
        <span className="sub">
          {ds.length ? `${ds.length} markdowns on ${kg(total)} — each one beats letting the stock spoil` : 'No markdowns recommended'}
        </span>
      </div>
      <div className="card-body">
        {ds.length === 0 ? (
          <p className="small muted">Every kg in this plan sells at list price or goes to the processor.</p>
        ) : (
          <div className="table-wrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Batch</th>
                  <th>Where · when</th>
                  <th className="r">Qty</th>
                  <th className="r">Price</th>
                  <th>Trigger</th>
                  <th className="r">Net vs spoil</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {ds.slice(0, 40).map((d, i) => (
                  <tr key={i} className="click" onClick={() => st.openBatch(d.batchId)}>
                    <td>
                      <span className="badge">
                        <span className="dot" style={{ background: commodityColor(s, s.batches.find((b) => b.id === d.batchId)?.commodityId ?? '') }} />
                        {d.batchId}
                      </span>
                    </td>
                    <td className="nowrap">
                      {s.destinations.find((x) => x.id === d.destId)?.short} · D{d.session} session
                    </td>
                    <td className="r num">{kg(d.quantityKg)}</td>
                    <td className="r num">
                      −{Math.round(d.discount * 100)}% · {perKg(d.pricePerKg)}
                    </td>
                    <td>{d.trigger === 'near_expiry' ? <GradeBadge grade="B" /> : <span className="badge ink2">Oversupply</span>}</td>
                    <td className="r num good">+{perKg(d.advantagePerKg).replace('/kg', '')}/kg</td>
                    <td className="small ink2" style={{ maxWidth: 420 }}>{d.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {ds.length > 40 && <p className="small muted">Showing 40 of {ds.length}. Open a batch for the rest.</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export function OutcomeMini({ o }: { o: Outcome }) {
  return (
    <span className="small ink2 num">
      {rupeesCompact(o.totals.net)} · spoil {pct(o.totals.spoilageRate, 1)} · fill {pct(o.totals.fulfilment, 1)}
    </span>
  );
}
