import { StoreProvider, useStore, type View } from './store';
import { Icon, Logo, TipProvider, type IconName } from './ui';
import { CATALOG } from '../engine/scenarios/catalog';
import { Situation } from './views/Situation';
import { PlanView } from './views/Plan';
import { Receipt } from './views/Receipt';
import { Disrupt } from './views/Disrupt';
import { Stress } from './views/Stress';
import { Tradeoffs } from './views/Tradeoffs';
import { Benchmark } from './views/Benchmark';
import { DataView } from './views/Data';
import { kg, rupeesCompact } from '../engine/fmt';

const NAV: { id: View; label: string; icon: IconName; step: string }[] = [
  { id: 'situation', label: 'Situation', icon: 'situation', step: '01' },
  { id: 'plan', label: 'Dispatch plan', icon: 'plan', step: '02' },
  { id: 'disrupt', label: 'Disrupt & replan', icon: 'disrupt', step: '03' },
  { id: 'stress', label: 'Stress test', icon: 'stress', step: '04' },
  { id: 'tradeoffs', label: 'Trade-offs', icon: 'tradeoffs', step: '05' },
  { id: 'benchmark', label: 'Benchmark', icon: 'benchmark', step: '06' },
  { id: 'data', label: 'Data & assumptions', icon: 'data', step: '07' },
];

export function App() {
  return (
    <StoreProvider>
      <TipProvider>
        <Shell />
      </TipProvider>
    </StoreProvider>
  );
}

function Shell() {
  const st = useStore();
  const { view, setView, scenario, pins, plan } = st;
  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="brand">
          <Logo />
          <div>
            <div className="brand-name">FreshRoute</div>
            <div className="brand-sub">Dispatch desk · PS 03</div>
          </div>
        </div>
        {NAV.map((n) => (
          <button key={n.id} className="nav-btn" aria-current={view === n.id ? 'page' : undefined} onClick={() => setView(n.id)} title={n.label}>
            <Icon name={n.icon} size={17} />
            <span className="nav-label">{n.label}</span>
            <span className="nav-num">{n.step}</span>
          </button>
        ))}
        <div className="rail-foot">
          <div>Engine: {st.solverName}</div>
          <div>Synthetic data · no live feeds</div>
          <div style={{ marginTop: 8 }}>
            <button onClick={() => st.setTheme(st.theme === 'auto' ? 'dark' : st.theme === 'dark' ? 'light' : 'auto')} aria-label="Switch colour theme">
              Theme: {st.theme}
            </button>
          </div>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <div className="scenario-pick">
            <label htmlFor="scenario" className="upper" style={{ margin: 0 }}>
              Scenario
            </label>
            <select id="scenario" value={st.scenarioId} onChange={(e) => st.loadScenario(e.target.value)}>
              {CATALOG.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} — {c.tests}
                </option>
              ))}
              {st.scenarioId === 'imported' && <option value="imported">{scenario.name} (imported)</option>}
            </select>
            <button className="btn sm" onClick={st.resetScenario} title="Discard overrides and results; reload the scenario">
              <Icon name="refresh" size={13} /> Reset
            </button>
          </div>
          <span className="chip">{scenario.batches.length} batches · {kg(scenario.batches.reduce((a, b) => a + b.quantityKg, 0))}</span>
          <span className="chip">{scenario.destinations.length} outlets · {scenario.horizonDays}-day horizon</span>
          {pins.length > 0 && (
            <span className="chip warn">
              <Icon name="pin" size={12} /> {pins.length} operator override{pins.length > 1 ? 's' : ''}
            </span>
          )}
          {st.serviceWeight > 0 && <span className="chip alt">Service weight ₹{st.serviceWeight}/kg</span>}
          <span className="spacer" />
          {plan.status === 'running' && (
            <span className="chip accent">
              <span className="spinner" style={{ width: 11, height: 11 }} /> Solving…
            </span>
          )}
          {plan.status === 'done' && plan.data && (
            <span className="chip accent" title="Net outcome of the current FreshRoute plan">
              <Icon name="check" size={12} /> Plan net {rupeesCompact(plan.data.result.outcome.totals.net)}
            </span>
          )}
        </header>
        <main className="page" id="main">
          {view === 'situation' && <Situation />}
          {view === 'plan' && <PlanView />}
          {view === 'disrupt' && <Disrupt />}
          {view === 'stress' && <Stress />}
          {view === 'tradeoffs' && <Tradeoffs />}
          {view === 'benchmark' && <Benchmark />}
          {view === 'data' && <DataView />}
        </main>
      </div>
      <Receipt />
    </div>
  );
}
