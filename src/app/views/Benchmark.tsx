import { useState } from 'react';
import { useStore } from '../store';
import { Callout, Empty, Icon, Progress, Stat, dirOf } from '../ui';
import { pct, pts, rupeesCompact, rupeesDelta } from '../../engine/fmt';
import type { SuiteRow } from '../../engine/evaluate';

export function Benchmark() {
  const st = useStore();
  const [seeds, setSeeds] = useState(10);
  const job = st.benchmark;
  const d = job.data;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="upper">Step 6 · Evidence</div>
          <h1>Benchmark</h1>
          <p>
            Both baselines and FreshRoute on every named scenario plus seeded random ones, each scored by the same ledger and stress-tested on 40 common futures.
            Run <code className="mono">npm run evaluate</code> for the full report (30 seeds, 100 futures) written to <code className="mono">docs/EVALUATION.md</code>.
          </p>
        </div>
        <div className="actions">
          <label className="small ink2 row" style={{ gap: 6 }}>
            Random seeds
            <select value={seeds} onChange={(e) => setSeeds(Number(e.target.value))}>
              {[0, 5, 10, 20, 30].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </label>
          <button className="btn primary" onClick={() => st.runBenchmark(seeds)} disabled={job.status === 'running'}>
            <Icon name="benchmark" size={14} /> Run benchmark
          </button>
        </div>
      </div>
      {job.status === 'running' && job.progress && (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <Progress done={job.progress.done} total={job.progress.total} label={job.progress.label ? `Evaluating ${job.progress.label}` : 'Evaluating'} />
        </div>
      )}
      {job.status === 'error' && <Callout kind="crit">{job.error}</Callout>}
      {job.status === 'idle' && (
        <div className="card">
          <Empty icon="benchmark" title="Not run yet">
            <p>Takes a few seconds per scenario. Results are deterministic: the same seeds give the same numbers.</p>
          </Empty>
        </div>
      )}
      {d && (
        <div className="stack">
          <div className="grid g4">
            <Stat hero label="Net gain vs FEFO + clearance" value={rupeesDelta(d.named.netGainVsClearance)} delta={{ text: `${d.named.optimizerWinsNet}/${d.named.rows} scenarios higher`, good: null, vs: `${d.named.ties} tied, ${d.named.optimizerLosesNet} lower` }} />
            <Stat label="Spoilage (kg-weighted)" value={pct(d.named.spoilageOptimizer, 1)} delta={{ text: pts(d.named.spoilageOptimizer - d.named.spoilageClearance), dir: dirOf(d.named.spoilageOptimizer - d.named.spoilageClearance, 0.0005), good: d.named.spoilageOptimizer <= d.named.spoilageClearance, vs: `vs ${pct(d.named.spoilageClearance, 1)} clearance · ${pct(d.named.spoilageFefo, 1)} FEFO` }} />
            <Stat label="Fulfilment (demand-weighted)" value={pct(d.named.fulfilmentOptimizer, 1)} delta={{ text: pts(d.named.fulfilmentOptimizer - d.named.fulfilmentClearance), dir: dirOf(d.named.fulfilmentOptimizer - d.named.fulfilmentClearance, 0.0005), good: d.named.fulfilmentOptimizer >= d.named.fulfilmentClearance, vs: `vs ${pct(d.named.fulfilmentClearance, 1)}` }} />
            <Stat label="Constraint violations" value={d.named.infeasiblePlans + d.random.infeasiblePlans} delta={{ text: 'across all plans', good: d.named.infeasiblePlans + d.random.infeasiblePlans === 0, vs: d.solver }} />
          </div>
          <div className="card">
            <div className="card-head">
              <h2>Named scenarios</h2>
              <span className="sub">Bold = best of the three</span>
            </div>
            <div className="card-body">
              <SuiteTable rows={d.rows.slice(0, d.named.rows)} />
            </div>
          </div>
          {d.random.rows > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>{d.random.rows} random scenarios</h2>
                <span className="sub">
                  FreshRoute higher in {d.random.optimizerWinsNet}, tied {d.random.ties}, lower {d.random.optimizerLosesNet} · total gain {rupeesDelta(d.random.netGainVsClearance)} vs clearance · spoilage{' '}
                  {pct(d.random.spoilageClearance, 1)} → {pct(d.random.spoilageOptimizer, 1)}
                </span>
              </div>
              <div className="card-body">
                <SuiteTable rows={d.rows.slice(d.named.rows)} />
              </div>
            </div>
          )}
          <Callout kind="neutral">
            Higher-or-equal net under the published estimates is guaranteed by construction — both baselines are feasible plans of the model FreshRoute solves to
            optimality — so the informative columns are spoilage, fulfilment and the stressed mean, where FreshRoute can and sometimes does lose.
          </Callout>
        </div>
      )}
    </>
  );
}

function SuiteTable({ rows }: { rows: SuiteRow[] }) {
  const b = (vals: number[], i: number, hi: boolean) => {
    const t = hi ? Math.max(...vals) : Math.min(...vals);
    return Math.abs(vals[i] - t) < 1e-9 ? 600 : 400;
  };
  return (
    <div className="table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Scenario</th>
            <th>Tests</th>
            <th className="r">Net FEFO</th>
            <th className="r">Net clear.</th>
            <th className="r">Net FR</th>
            <th className="r">Spoilage F / C / FR</th>
            <th className="r">Fulfilment F / C / FR</th>
            <th className="r">Stressed mean C / FR</th>
            <th className="r">Solve</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const nets = [r.fefo.net, r.clearance.net, r.optimizer.net];
            const sp = [r.fefo.spoilageRate, r.clearance.spoilageRate, r.optimizer.spoilageRate];
            const fu = [r.fefo.fulfilment, r.clearance.fulfilment, r.optimizer.fulfilment];
            const stressLoss = r.stress && r.stress.optimizer < r.stress.clearance;
            return (
              <tr key={r.id}>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{r.name}</td>
                <td className="small ink2">{r.tests}</td>
                {nets.map((v, i) => (
                  <td key={i} className="r num" style={{ fontWeight: b(nets, i, true) }}>{rupeesCompact(v)}</td>
                ))}
                <td className="r num">
                  {sp.map((v, i) => (
                    <span key={i} style={{ fontWeight: b(sp, i, false) }}>{i ? ' / ' : ''}{pct(v, 1)}</span>
                  ))}
                </td>
                <td className="r num">
                  {fu.map((v, i) => (
                    <span key={i} style={{ fontWeight: b(fu, i, true) }}>{i ? ' / ' : ''}{pct(v, 1)}</span>
                  ))}
                </td>
                <td className={`r num ${stressLoss ? 'bad' : ''}`}>
                  {r.stress ? `${rupeesCompact(r.stress.clearance)} / ${rupeesCompact(r.stress.optimizer)}` : '—'}
                </td>
                <td className="r num muted">{r.solveMs.toFixed(0)} ms</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
