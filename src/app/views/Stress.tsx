import { useState } from 'react';
import { useStore } from '../store';
import { Callout, Empty, Icon, Progress, Seg, Stat, dirOf } from '../ui';
import { DistributionPlot } from '../charts';
import { kg, pct, pts, rupeesCompact, rupeesDelta } from '../../engine/fmt';

export function Stress() {
  const st = useStore();
  const s = st.scenario;
  const [futures, setFutures] = useState('200');
  const [seed, setSeed] = useState(2024);
  const [robust, setRobust] = useState(true);
  const [metric, setMetric] = useState<'net' | 'spoilageRate'>('net');

  if (!st.plan.data || st.plan.data.result.status === 'infeasible')
    return (
      <div className="card">
        <Empty icon="stress" title="Stress testing needs a plan">
          <p>Generate the dispatch plan first.</p>
          <button className="btn primary" onClick={st.runPlan}>
            <Icon name="play" size={14} /> Generate dispatch plan
          </button>
        </Empty>
      </div>
    );

  const job = st.stress;
  const d = job.data;
  const cvs = s.commodities.map((c) => `${c.name} ±${Math.round(c.shelfLifeCv * 100)}%`).join(', ');
  const fr = d?.stress.find((x) => x.label === 'FreshRoute');
  const clear = d?.stress.find((x) => x.label.includes('clearance'));
  const rob = d?.robust;
  const rows = d ? [...d.stress, ...(rob && rob.chosen.kappa > 0 ? [{ ...rob.chosenPlanTest, label: `Risk-buffered (κ = ${rob.chosen.kappa})` }] : [])] : [];
  const fragile = fr
    ? [...fr.fragility.entries()]
        .map(([k, v]) => ({ key: k, ...v }))
        .filter((x) => x.lostShare > 0.05 || x.downgradedShare > 0.2)
        .sort((a, b) => b.meanLostKg - a.meanLostKg)
        .slice(0, 10)
    : [];
  const destShort = (id: string) => s.destinations.find((x) => x.id === id)?.short ?? id;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="upper">Step 4 · Robustness</div>
          <h1>Stress test</h1>
          <p>
            Shelf-life estimates, transit times, demand and prices are uncertain. Each plan is executed unchanged in the same seeded sample of futures, so the
            comparison is paired, reproducible and free of hindsight.
          </p>
        </div>
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 16, alignItems: 'flex-end' }}>
          <label className="field">
            Futures
            <select value={futures} onChange={(e) => setFutures(e.target.value)}>
              <option value="100">100</option>
              <option value="200">200</option>
              <option value="400">400</option>
            </select>
          </label>
          <label className="field">
            Seed
            <input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value) || 0)} style={{ width: 100 }} />
          </label>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={robust} onChange={(e) => setRobust(e.target.checked)} /> Also calibrate a risk-buffered plan
          </label>
          <button className="btn primary" onClick={() => st.runStress(Number(futures), seed, robust)} disabled={job.status === 'running'}>
            <Icon name="stress" size={14} /> Run stress test
          </button>
        </div>
        <p className="small muted" style={{ margin: '10px 0 0' }}>
          Perturbations: shelf life per batch ({cvs}); transit per lane-night lognormal (±{Math.round(s.destinations[0]?.transitCv * 100)}–
          {Math.round(Math.max(...s.destinations.map((x) => x.transitCv)) * 100)}%); demand per row ±{Math.round(s.uncertainty.demandCv * 100)}%; price ±
          {Math.round(s.uncertainty.priceCv * 100)}%. A late truck can miss its market session; a short-lived lot can arrive below its freshness threshold.
        </p>
        {job.status === 'running' && job.progress && (
          <div style={{ marginTop: 12 }}>
            <Progress done={job.progress.done} total={job.progress.total} label={job.progress.label} />
          </div>
        )}
      </div>

      {job.status === 'error' && <Callout kind="crit">Stress test failed: {job.error}</Callout>}
      {job.status === 'idle' && (
        <div className="card">
          <Empty icon="stress" title="Not run yet">
            <p>Run it to see how each plan holds up when the estimates are wrong.</p>
          </Empty>
        </div>
      )}

      {d && fr && clear && (
        <div className="stack">
          <div className="grid g4">
            <Stat hero label="FreshRoute · mean net across futures" value={rupeesCompact(fr.net.mean)} delta={{ text: rupeesDelta(fr.net.mean - clear.net.mean), dir: dirOf(fr.net.mean - clear.net.mean, 1), good: fr.net.mean >= clear.net.mean, vs: 'vs FEFO + clearance' }} />
            <Stat label="Bad-day outcome (5th percentile)" value={rupeesCompact(fr.net.p05)} delta={{ text: rupeesDelta(fr.net.p05 - clear.net.p05), dir: dirOf(fr.net.p05 - clear.net.p05, 1), good: fr.net.p05 >= clear.net.p05, vs: 'vs baseline' }} />
            <Stat label="Mean spoilage under stress" value={pct(fr.spoilageRate.mean, 1)} delta={{ text: pts(fr.spoilageRate.mean - clear.spoilageRate.mean), dir: dirOf(fr.spoilageRate.mean - clear.spoilageRate.mean, 0.0005), good: fr.spoilageRate.mean <= clear.spoilageRate.mean, vs: 'vs baseline' }} />
            <Stat label="Under published estimates" value={rupeesCompact(st.plan.data.result.outcome.totals.net)} delta={{ text: `${rupeesCompact(st.plan.data.result.outcome.totals.net - fr.net.mean)} lower`, good: null, vs: 'once estimates are uncertain' }} />
          </div>

          <div className="card">
            <div className="card-head">
              <h2>{metric === 'net' ? 'Net outcome' : 'Spoilage rate'} across {d.futures} futures</h2>
              <span className="sub">seed {d.seed} · plans executed open-loop</span>
              <div className="right">
                <Seg label="Metric" value={metric} onChange={setMetric} options={[{ value: 'net', label: 'Net' }, { value: 'spoilageRate', label: 'Spoilage' }]} />
              </div>
            </div>
            <div className="card-body">
              <DistributionPlot rows={rows} metric={metric} />
            </div>
          </div>

          {fr.net.mean < clear.net.mean && (
            <Callout kind="warn">
              In this scenario the nominal FreshRoute plan does <b>worse on average</b> than the clearance baseline once the estimates are uncertain. It was
              optimised to the published estimates and uses every hour of slack — use the risk-buffered plan below.
            </Callout>
          )}

          <div className="grid g2">
            {rob && (
              <div className="card">
                <div className="card-head">
                  <h2>Risk-buffered planning</h2>
                  <span className="sub">κ chosen on {rob.trainSize} training futures, reported on {rob.testSize} different ones</span>
                </div>
                <div className="card-body">
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Buffer κ</th>
                        <th className="r">Under estimates</th>
                        <th className="r">Training mean</th>
                        <th className="r">Test mean</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rob.candidates.map((c) => (
                        <tr key={c.kappa} className={c.kappa === rob.chosen.kappa ? 'sel' : undefined}>
                          <td>
                            {c.kappa}
                            {c.kappa === 0 ? ' (nominal)' : ''}
                            {c.kappa === rob.chosen.kappa ? ' · chosen' : ''}
                          </td>
                          <td className="r num">{rupeesCompact(c.nominalNet)}</td>
                          <td className="r num">{rupeesCompact(c.trainMean)}</td>
                          <td className="r num">{c.testMean !== undefined ? rupeesCompact(c.testMean) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="small ink2" style={{ marginTop: 10 }}>
                    The buffered plan assumes shelf life shorter by κ·σ, trips longer by κ·σ and demand lower by ½κ·σ, so loads keep a safety margin. On the held-out
                    futures it scores <b>{rupeesCompact(rob.chosenPlanTest.net.mean)}</b> (5th percentile {rupeesCompact(rob.chosenPlanTest.net.p05)}) against{' '}
                    {rupeesCompact(rob.nominalPlanTest.net.mean)} ({rupeesCompact(rob.nominalPlanTest.net.p05)}) for the nominal optimum. It is a calibrated
                    heuristic, not a stochastic optimum.
                  </p>
                </div>
              </div>
            )}
            <div className="card">
              <div className="card-head">
                <h2>Fragile shipments</h2>
                <span className="sub">FreshRoute loads most often lost or downgraded</span>
              </div>
              <div className="card-body">
                {fragile.length === 0 ? (
                  <p className="small muted">No load is lost in more than 5% of futures.</p>
                ) : (
                  <table className="t">
                    <thead>
                      <tr>
                        <th>Load</th>
                        <th className="r">Some kg lost</th>
                        <th className="r">Drops below list grade</th>
                        <th className="r">Mean loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fragile.map((f) => {
                        const [b, dst, day] = f.key.split('|');
                        return (
                          <tr key={f.key} className="click" onClick={() => st.openBatch(b)}>
                            <td>
                              {b} → {destShort(dst)} D{day}
                            </td>
                            <td className="r num">{pct(f.lostShare)}</td>
                            <td className="r num">{pct(f.downgradedShare)}</td>
                            <td className="r num">{kg(f.meanLostKg)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                <p className="small muted" style={{ marginTop: 8 }}>
                  These are the decisions that depend on fragile assumptions: tight arrival windows or lots close to a freshness threshold.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
