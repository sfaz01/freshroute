import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Callout, GradeBadge, Icon, commodityColor, urgencyMeta } from '../ui';
import { engine } from '../engineClient';
import { clock } from '../../engine/time';
import { hours, kg, perKg, rupees, rupeesCompact } from '../../engine/fmt';
import type { ChallengeResult } from '../../engine/counterfactual';
import type { Pin } from '../../engine/types';

type Check = { status: 'running' | 'done' | 'error'; pin: Pin; res?: ChallengeResult; error?: string };

export function Receipt() {
  const st = useStore();
  const id = st.selectedBatch;
  const bundle = st.plan.data;
  const [checks, setChecks] = useState<Record<string, Check>>({});

  useEffect(() => setChecks({}), [id, bundle]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && st.openBatch(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [st]);

  if (!id || !bundle) return null;
  const s = st.scenario;
  const brief = bundle.explanation.briefs.get(id);
  if (!brief) return null;
  const { batch, commodity: c } = brief;
  const lines = bundle.result.outcome.lines.filter((l) => l.batchId === id).sort((a, b) => a.day - b.day);
  const discounts = bundle.explanation.discounts.filter((d) => d.batchId === id);
  const destName = (d: string) => s.destinations.find((x) => x.id === d)?.short ?? d;
  const um = urgencyMeta[brief.urgency];

  const revenue = lines.reduce((a, l) => a + l.revenue, 0);
  const freight = lines.reduce((a, l) => a + l.transportCost, 0);
  const handling = lines.reduce((a, l) => a + l.handlingCost, 0);
  const wasted = lines.reduce((a, l) => a + l.wastedKg, 0);
  const spoilCost = (wasted + (brief.leftoverClass === 'spoiled' ? brief.leftoverKg : 0)) * c.spoilageCostPerKg;
  const carry = brief.leftoverClass === 'carried' ? brief.leftoverKg * c.carryValuePerKg : 0;
  const contribution = revenue - freight - handling - spoilCost + carry;

  const maxTo = (destId: string) => {
    const recs = bundle.result.options.filter((r) => !r.committed && r.option.batchId === id && r.option.destId === destId && r.option.feasible);
    const cap = recs.reduce((a, r) => a + r.option.tiers.reduce((x, t) => x + t.capacityKg, 0), 0);
    return Math.min(batch.quantityKg, cap);
  };

  const runCheck = (key: string, pin: Pin) => {
    setChecks((c0) => ({ ...c0, [key]: { status: 'running', pin } }));
    engine
      .call('challenge', { scenario: s, base: bundle.result, pin })
      .then((res) => setChecks((c0) => ({ ...c0, [key]: { status: 'done', pin, res } })))
      .catch((e: Error) => setChecks((c0) => ({ ...c0, [key]: { status: 'error', pin, error: e.message } })));
  };

  return (
    <>
      <div className="scrim" onClick={() => st.openBatch(null)} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={`Decision receipt for ${id}`}>
        <div className="drawer-head">
          <span style={{ width: 12, height: 12, borderRadius: 3, background: commodityColor(s, c.id), marginTop: 6 }} />
          <div style={{ flex: 1 }}>
            <div className="upper">Decision receipt · priority #{brief.priority}</div>
            <div style={{ fontSize: 18, fontWeight: 650 }}>
              {id} · {c.name} · {kg(batch.quantityKg)}
            </div>
            <div className="small ink2">
              {batch.source ?? 'No provenance note'} · shelf life {hours(batch.remainingShelfLifeHours)} (expires {clock(batch.remainingShelfLifeHours)}) · at hub from D{batch.availableFromDay}
            </div>
          </div>
          <span className={`chip ${um.kind}`}>{um.label}</span>
          <button className="btn ghost sm" onClick={() => st.openBatch(null)} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="drawer-body">
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{brief.headline}</div>
            <div className="ink2" style={{ marginTop: 4 }}>
              <Icon name="clock" size={13} /> {brief.timing}
            </div>
          </div>

          <div className="receipt" aria-label="Itemised economics">
            {lines.length === 0 && <div className="muted">No shipments.</div>}
            {lines.map((l, i) => (
              <div key={i} style={{ marginBottom: 6 }}>
                <div className="rl">
                  <span>
                    D{l.day} → {destName(l.destId)} · {kg(l.shippedKg)}
                  </span>
                  <span className="lead" />
                  <span>{rupees(l.revenue)}</span>
                </div>
                <div className="small muted" style={{ paddingLeft: 12 }}>
                  sells {clock(l.saleHour)} with {Math.round(l.lifeAtSaleHours)} h left ·{' '}
                  {l.sales.map((x) => `${kg(x.quantityKg)} @ ${x.tier === 0 ? 'list' : `−${Math.round(x.discount * 100)}%`} ₹${x.pricePerKg.toFixed(1)}`).join(' + ')}
                  {l.wastedKg > 0.5 ? ` · ${kg(l.wastedKg)} unsold` : ''}
                </div>
              </div>
            ))}
            <div className="rl"><span>− freight (share of trucks)</span><span className="lead" /><span>{rupees(-freight)}</span></div>
            <div className="rl"><span>− handling ({perKg(c.handlingCostPerKg)})</span><span className="lead" /><span>{rupees(-handling)}</span></div>
            {spoilCost > 0 && <div className="rl"><span>− spoilage ({perKg(c.spoilageCostPerKg)})</span><span className="lead" /><span>{rupees(-spoilCost)}</span></div>}
            {carry > 0 && <div className="rl"><span>+ carry-over value</span><span className="lead" /><span>{rupees(carry)}</span></div>}
            <div className="rl total"><span>Contribution of this batch</span><span className="lead" /><span>{rupees(contribution)}</span></div>
            {brief.marginalValue !== null && (
              <div className="small muted" style={{ marginTop: 6 }}>
                Shadow price: one more kg of {id} would add {perKg(brief.marginalValue)} to the plan (LP dual, trucks fixed).
              </div>
            )}
          </div>

          {discounts.length > 0 && (
            <div className="stack" style={{ gap: 8 }}>
              <div className="upper">Why the markdown</div>
              {discounts.map((d, i) => (
                <Callout key={i} kind="warn" icon="scale">
                  <b>
                    {kg(d.quantityKg)} at −{Math.round(d.discount * 100)}% in {destName(d.destId)}.
                  </b>{' '}
                  {d.reason}
                </Callout>
              ))}
            </div>
          )}

          <div>
            <div className="upper" style={{ marginBottom: 6 }}>Every outlet considered</div>
            <div className="table-wrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Outlet</th>
                    <th>Verdict</th>
                    <th>Evidence</th>
                    <th className="r">Test it</th>
                  </tr>
                </thead>
                <tbody>
                  {brief.alternatives.map((a) => {
                    const key = a.destId;
                    const chk = checks[key];
                    const cap = a.status === 'feasible' ? maxTo(a.destId) : 0;
                    const forceKg = Math.floor(Math.min(cap, Math.max(brief.shippedKg, 500), batch.quantityKg) / 10) * 10;
                    return (
                      <tr key={a.destId}>
                        <td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{destName(a.destId)}</td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {a.status === 'chosen' && <span className="badge good"><Icon name="check" size={13} /> Chosen</span>}
                          {a.status === 'feasible' && <span className="badge ink2">Possible, worse</span>}
                          {a.status === 'infeasible' && <span className="badge bad"><Icon name="x" size={13} /> Impossible</span>}
                          {a.status === 'banned' && <span className="badge warnt"><Icon name="pin" size={13} /> Blocked</span>}
                          {a.grade && a.status !== 'infeasible' && (
                            <div style={{ marginTop: 2 }}>
                              <GradeBadge grade={a.grade} />
                            </div>
                          )}
                        </td>
                        <td className="small ink2">
                          {a.reason}
                          {chk?.status === 'running' && (
                            <div className="row" style={{ marginTop: 4 }}>
                              <span className="spinner" style={{ width: 12, height: 12 }} /> Re-solving the whole plan…
                            </div>
                          )}
                          {chk?.status === 'error' && <div className="bad">{chk.error}</div>}
                          {chk?.status === 'done' && chk.res && (
                            <div style={{ marginTop: 6 }} className={chk.res.delta && chk.res.delta.net < -1 ? 'bad' : 'good'}>
                              <b>{chk.res.verdict}</b>
                              {chk.res.delta && (
                                <div style={{ marginTop: 4 }}>
                                  <button
                                    className="btn sm"
                                    onClick={() => {
                                      st.addPin({ ...chk.pin, note: 'from receipt' });
                                      st.openBatch(null);
                                    }}
                                  >
                                    <Icon name="pin" size={12} /> Apply as override ({rupeesCompact(chk.res.result.outcome.totals.net)} net)
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="r">
                          {a.status === 'feasible' && forceKg >= 10 && (
                            <button
                              className="btn sm"
                              disabled={chk?.status === 'running'}
                              onClick={() => runCheck(key, { kind: 'force', batchId: id, destId: a.destId, minKg: forceKg })}
                              title={`Force at least ${kg(forceKg)} of ${id} to ${destName(a.destId)} and re-optimise everything else`}
                            >
                              Send {kg(forceKg)} here?
                            </button>
                          )}
                          {a.status === 'chosen' && (
                            <button
                              className="btn sm"
                              disabled={chk?.status === 'running'}
                              onClick={() => runCheck(key, { kind: 'ban', batchId: id, destId: a.destId })}
                              title={`Forbid ${id} → ${destName(a.destId)} and re-optimise`}
                            >
                              What if not?
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              "Possible, worse" losses are LP reduced costs with tonight's trucks fixed. The buttons re-solve the full mixed-integer model with your condition added, so
              the price they quote includes every knock-on effect.
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
