import { useStore } from '../store';
import { Callout, Empty, Icon, Progress } from '../ui';
import { FrontierChart } from '../charts';
import { kg, pct, perKg, rupeesCompact, rupeesDelta } from '../../engine/fmt';

export function Tradeoffs() {
  const st = useStore();
  const s = st.scenario;
  const bundle = st.plan.data;
  if (!bundle || bundle.result.status === 'infeasible')
    return (
      <div className="card">
        <Empty icon="tradeoffs" title="Trade-offs need a plan">
          <p>Generate the dispatch plan first.</p>
          <button className="btn primary" onClick={st.runPlan}>
            <Icon name="play" size={14} /> Generate dispatch plan
          </button>
        </Empty>
      </div>
    );
  const { result } = bundle;
  const duals = result.duals;
  const destShort = (id: string) => s.destinations.find((d) => d.id === id)?.short ?? id;
  const cname = (id: string) => s.commodities.find((c) => c.id === id)?.name ?? id;

  // Only rows whose list-price demand is fully used: elsewhere a dual is degenerate, not scarcity.
  const fullRows = new Set(
    result.outcome.demand.filter((d) => d.demandKg > 0 && d.fullPriceSoldKg >= d.demandKg - 0.5).map((d) => `${d.destId}|${d.commodityId}|${d.session}|0`),
  );
  const scarce = duals
    ? [...duals.demand.entries()]
        .filter(([k, v]) => fullRows.has(k) && v > 0.5)
        .map(([k, v]) => {
          const [destId, commodityId, session] = k.split('|');
          return { destId, commodityId, session: Number(session), v };
        })
        .sort((a, b) => b.v - a.v)
        .slice(0, 8)
    : [];
  const valuable = duals
    ? [...duals.stock.entries()].map(([id, v]) => ({ id, v })).sort((a, b) => b.v - a.v).slice(0, 8)
    : [];
  const lanes = duals
    ? [...duals.laneCapacity.entries()]
        // Lanes with no truck have a degenerate capacity dual; only dispatched trucks can be "full".
        .filter(([k, v]) => v > 0.05 && (result.trucks.get(k) ?? 0) > 0)
        .map(([k, v]) => ({ k, v }))
        .sort((a, b) => b.v - a.v)
        .slice(0, 6)
    : [];

  return (
    <>
      <div className="page-head">
        <div>
          <div className="upper">Step 5 · Levers</div>
          <h1>Trade-offs</h1>
          <p>
            What limits this plan, what more capacity would be worth, and how much net you give up to serve more customers. Every value is computed by re-solving or
            from the LP sensitivity of the solved plan.
          </p>
        </div>
      </div>

      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="card-head">
            <h2>Profit vs. service</h2>
            <span className="sub">Re-solved at seven service weights</span>
            <div className="right">
              <button className="btn sm" onClick={st.runFrontier} disabled={st.frontier.status === 'running'}>
                <Icon name="play" size={12} /> {st.frontier.data ? 'Recompute' : 'Compute curve'}
              </button>
            </div>
          </div>
          <div className="card-body">
            {st.frontier.status === 'running' && st.frontier.progress && <Progress done={st.frontier.progress.done} total={st.frontier.progress.total} label="Solving" />}
            {st.frontier.status === 'idle' && (
              <p className="small ink2">
                The default objective is the dataset's net outcome. A service weight adds ₹w for every kg of customer demand served at list price — a way to
                value goodwill the cost model does not price. The curve shows what each extra point of fulfilment costs.
              </p>
            )}
            {st.frontier.status === 'error' && <Callout kind="crit">{st.frontier.error}</Callout>}
            {st.frontier.data && (
              <FrontierChart
                points={st.frontier.data}
                current={st.serviceWeight}
                baselines={[
                  { label: 'Baseline · FEFO', net: bundle.fefo.outcome.totals.net, fulfilment: bundle.fefo.outcome.totals.fulfilment },
                  { label: 'Baseline · FEFO + clearance', net: bundle.clearance.outcome.totals.net, fulfilment: bundle.clearance.outcome.totals.fulfilment },
                ]}
              />
            )}
            <div className="row" style={{ marginTop: 12 }}>
              <label htmlFor="sw" className="small ink2">Plan with service weight</label>
              <select id="sw" value={st.serviceWeight} onChange={(e) => st.setServiceWeight(Number(e.target.value))}>
                {[0, 2, 5, 10, 20, 40, 80].map((w) => (
                  <option key={w} value={w}>₹{w}/kg{w === 0 ? ' (pure net — default)' : ''}</option>
                ))}
              </select>
              <span className="small muted">Re-plans immediately; reported net never includes the weight.</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>What one more truck is worth</h2>
            <span className="sub">Exact: re-solved with ±1 truck per night</span>
            <div className="right">
              <button className="btn sm" onClick={st.runTruckValues} disabled={st.truckValues.status === 'running'}>
                {st.truckValues.status === 'running' ? <span className="spinner" style={{ width: 12, height: 12 }} /> : <Icon name="truck" size={12} />} Price the fleet
              </button>
            </div>
          </div>
          <div className="card-body">
            {st.truckValues.status === 'idle' && <p className="small ink2">Answers "should I hire another truck tonight, and what can I pay for it?"</p>}
            {st.truckValues.status === 'error' && <Callout kind="crit">{st.truckValues.error}</Callout>}
            {st.truckValues.data && (
              <table className="t">
                <thead>
                  <tr>
                    <th>Night</th>
                    <th className="r">Trucks used</th>
                    <th className="r">+1 truck</th>
                    <th className="r">Fulfilment</th>
                    <th className="r">−1 truck</th>
                  </tr>
                </thead>
                <tbody>
                  {st.truckValues.data.map((t) => (
                    <tr key={t.day}>
                      <td>D{t.day}</td>
                      <td className="r num">{t.used}/{t.available}</td>
                      <td className={`r num ${t.plusOne > 1 ? 'good' : 'muted'}`}>{rupeesDelta(t.plusOne)}</td>
                      <td className="r num">{t.plusOneFulfilment > 0.0005 ? `+${(t.plusOneFulfilment * 100).toFixed(1)} pts` : '—'}</td>
                      <td className={`r num ${t.minusOne < -1 ? 'bad' : 'muted'}`}>{t.used < t.available ? 'spare' : Number.isFinite(t.minusOne) ? rupeesDelta(t.minusOne) : 'infeasible'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {st.truckValues.data && (
              <p className="small muted" style={{ marginTop: 8 }}>
                A hired truck is worth taking if it costs less than the "+1 truck" value (the value already nets out that lane's freight).
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="grid g3">
        <div className="card">
          <div className="card-head">
            <h2>Scarcest markets</h2>
            <span className="sub">Shadow price of 1 more kg of list-price demand</span>
          </div>
          <div className="card-body">
            {scarce.length === 0 ? (
              <p className="small muted">No list-price demand is binding: stock or trucks, not buyers, limit the plan.</p>
            ) : (
              <table className="t">
                <tbody>
                  {scarce.map((x) => (
                    <tr key={`${x.destId}${x.commodityId}${x.session}`}>
                      <td>{cname(x.commodityId)} · {destShort(x.destId)} · D{x.session}</td>
                      <td className="r num good">{perKg(x.v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="small muted" style={{ marginTop: 8 }}>
              Where an extra order would be worth most — it can exceed the price when the kg it absorbs would otherwise be written off.
            </p>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Most valuable stock</h2>
            <span className="sub">Shadow price of 1 more kg of the batch</span>
          </div>
          <div className="card-body">
            <table className="t">
              <tbody>
                {valuable.map((x) => (
                  <tr key={x.id} className="click" onClick={() => st.openBatch(x.id)}>
                    <td>{x.id}</td>
                    <td className="r num">{perKg(x.v)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="small muted" style={{ marginTop: 8 }}>What the plan would pay for more of each lot — useful when buying from farmers tomorrow.</p>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2>Full trucks</h2>
            <span className="sub">Value of 1 more kg of space on a dispatched truck</span>
          </div>
          <div className="card-body">
            {lanes.length === 0 ? (
              <p className="small muted">No dispatched truck is the bottleneck.</p>
            ) : (
              <table className="t">
                <tbody>
                  {lanes.map(({ k, v }) => {
                    const [d, day] = k.split('|');
                    return (
                      <tr key={k}>
                        <td>{destShort(d)} · D{day}</td>
                        <td className="r num">{perKg(v)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="small muted" style={{ marginTop: 8 }}>
              Plan totals: {kg(result.outcome.totals.shippedKg)} shipped on {result.outcome.totals.trucksUsed} trucks, fulfilment {pct(result.outcome.totals.fulfilment, 1)}, net{' '}
              {rupeesCompact(result.outcome.totals.net)}.
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
