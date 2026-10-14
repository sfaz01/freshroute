import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Issue, Pin, Plan, Scenario } from '../engine/types';
import { CATALOG, buildScenario } from '../engine/scenarios/catalog';
import type { TruckValue } from '../engine/counterfactual';
import type { Disruption } from '../engine/disruptions';
import type { PlanStress, RobustReport } from '../engine/uncertainty';
import type { BenchmarkResult, FrontierPoint, OpResult, PlanBundle } from './protocol';
import { engine } from './engineClient';

export type View = 'situation' | 'plan' | 'disrupt' | 'stress' | 'tradeoffs' | 'benchmark' | 'data';
export type BaselineKind = 'fefo' | 'clearance';

export interface Job<T> {
  status: 'idle' | 'running' | 'done' | 'error';
  data: T | null;
  error?: string;
  progress?: { done: number; total: number; label?: string };
}
const idle = <T,>(): Job<T> => ({ status: 'idle', data: null });

export interface StressData {
  stress: PlanStress[];
  robust: RobustReport | null;
  futures: number;
  seed: number;
}

interface Store {
  view: View;
  setView: (v: View) => void;
  scenarioId: string;
  scenario: Scenario;
  importIssues: Issue[];
  loadScenario: (id: string) => void;
  importScenario: (s: Scenario, issues: Issue[]) => void;
  resetScenario: () => void;
  pins: Pin[];
  addPin: (p: Pin) => void;
  removePin: (i: number) => void;
  serviceWeight: number;
  setServiceWeight: (w: number) => void;
  baselineKind: BaselineKind;
  setBaselineKind: (b: BaselineKind) => void;
  plan: Job<PlanBundle>;
  runPlan: () => void;
  selectedBatch: string | null;
  openBatch: (id: string | null) => void;
  truckValues: Job<TruckValue[]>;
  runTruckValues: () => void;
  frontier: Job<FrontierPoint[]>;
  runFrontier: () => void;
  replan: Job<OpResult['replan']> & { eventId?: string };
  runReplan: (args: { changes: Disruption[]; asOfDay: number; eventId?: string }) => void;
  stress: Job<StressData>;
  runStress: (futures: number, seed: number, withRobust: boolean) => void;
  benchmark: Job<BenchmarkResult>;
  runBenchmark: (seeds: number) => void;
  solverName: string;
  theme: 'auto' | 'light' | 'dark';
  setTheme: (t: 'auto' | 'light' | 'dark') => void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('Store missing');
  return s;
}

const readTheme = (): 'auto' | 'light' | 'dark' => {
  try {
    const t = localStorage.getItem('fr-theme');
    return t === 'light' || t === 'dark' ? t : 'auto';
  } catch {
    return 'auto';
  }
};

export function StoreProvider({ children }: { children: ReactNode }) {
  const [view, setView] = useState<View>('situation');
  const [scenarioId, setScenarioId] = useState(CATALOG[0].id);
  const [scenario, setScenario] = useState<Scenario>(() => buildScenario(CATALOG[0].id));
  const [importIssues, setImportIssues] = useState<Issue[]>([]);
  const [pins, setPins] = useState<Pin[]>([]);
  const [serviceWeight, setServiceWeight] = useState(0);
  const [baselineKind, setBaselineKind] = useState<BaselineKind>('clearance');
  const [plan, setPlan] = useState<Job<PlanBundle>>(idle());
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [truckValues, setTruckValues] = useState<Job<TruckValue[]>>(idle());
  const [frontier, setFrontier] = useState<Job<FrontierPoint[]>>(idle());
  const [replan, setReplan] = useState<Store['replan']>(idle());
  const [stress, setStress] = useState<Job<StressData>>(idle());
  const [benchmark, setBenchmark] = useState<Job<BenchmarkResult>>(idle());
  const [solverName, setSolverName] = useState('HiGHS (loading…)');
  const [theme, setThemeState] = useState<'auto' | 'light' | 'dark'>(readTheme);
  const planSeq = useRef(0);

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('fr-theme', theme);
    } catch {
      /* storage unavailable: theme still applies for this session */
    }
  }, [theme]);

  useEffect(() => {
    engine.call('ping', {}).then((r) => setSolverName(r.solver)).catch(() => setSolverName('HiGHS (failed to load)'));
  }, []);

  /** Anything derived from the current plan is invalidated when inputs change. */
  const invalidateDerived = useCallback(() => {
    setTruckValues(idle());
    setFrontier(idle());
    setReplan(idle());
    setStress(idle());
  }, []);

  const runPlanWith = useCallback(
    (s: Scenario, p: Pin[], w: number) => {
      const seq = ++planSeq.current;
      setPlan((prev) => ({ status: 'running', data: prev.data }));
      invalidateDerived();
      engine
        .call('plan', { scenario: s, pins: p, serviceWeight: w })
        .then((data) => {
          if (seq !== planSeq.current) return;
          setPlan({ status: 'done', data });
        })
        .catch((err: Error) => {
          if (seq !== planSeq.current) return;
          setPlan({ status: 'error', data: null, error: err.message });
        });
    },
    [invalidateDerived],
  );

  const runPlan = useCallback(() => runPlanWith(scenario, pins, serviceWeight), [runPlanWith, scenario, pins, serviceWeight]);

  const resetAll = (s: Scenario) => {
    planSeq.current++;
    setScenario(s);
    setPins([]);
    setServiceWeight(0);
    setPlan(idle());
    setSelectedBatch(null);
    invalidateDerived();
  };

  const loadScenario = (id: string) => {
    setScenarioId(id);
    setImportIssues([]);
    resetAll(buildScenario(id));
  };
  const importScenario = (s: Scenario, issues: Issue[]) => {
    setScenarioId('imported');
    setImportIssues(issues);
    resetAll(s);
  };
  const resetScenario = () => {
    if (scenarioId === 'imported') resetAll(structuredClone(scenario));
    else loadScenario(scenarioId);
  };

  const addPin = (p: Pin) => {
    const next = [...pins, p];
    setPins(next);
    runPlanWith(scenario, next, serviceWeight);
  };
  const removePin = (i: number) => {
    const next = pins.filter((_, j) => j !== i);
    setPins(next);
    runPlanWith(scenario, next, serviceWeight);
  };
  const setWeight = (w: number) => {
    setServiceWeight(w);
    if (plan.status !== 'idle') runPlanWith(scenario, pins, w);
  };

  const current = plan.data;
  const runTruckValues = () => {
    if (!current) return;
    setTruckValues({ status: 'running', data: null });
    engine
      .call('truckValues', { scenario, base: current.result })
      .then((data) => setTruckValues({ status: 'done', data }))
      .catch((e: Error) => setTruckValues({ status: 'error', data: null, error: e.message }));
  };
  const runFrontier = () => {
    setFrontier({ status: 'running', data: null });
    engine
      .call('frontier', { scenario, weights: [0, 2, 5, 10, 20, 40, 80], pins }, (done, total) =>
        setFrontier((f) => ({ ...f, progress: { done, total } })),
      )
      .then((data) => setFrontier({ status: 'done', data }))
      .catch((e: Error) => setFrontier({ status: 'error', data: null, error: e.message }));
  };
  const runReplan: Store['runReplan'] = ({ changes, asOfDay, eventId }) => {
    if (!current) return;
    setReplan({ status: 'running', data: null, eventId });
    engine
      .call('replan', { scenario, plan: current.result.plan, changes, asOfDay })
      .then((data) => setReplan({ status: 'done', data, eventId }))
      .catch((e: Error) => setReplan({ status: 'error', data: null, error: e.message, eventId }));
  };
  const runStress = (futures: number, seed: number, withRobust: boolean) => {
    if (!current) return;
    setStress({ status: 'running', data: null, progress: { done: 0, total: 1, label: 'Sampling futures' } });
    const plans: Plan[] = [
      { ...current.fefo.plan, label: 'Baseline · FEFO' },
      { ...current.clearance.plan, label: 'Baseline · FEFO + clearance' },
      { ...current.result.plan, label: 'FreshRoute' },
    ];
    (async () => {
      const stressRes = await engine.call('stress', { scenario, plans, futures, seed });
      let robust: RobustReport | null = null;
      if (withRobust) {
        robust = await engine.call(
          'robust',
          { scenario, trainSize: Math.round(futures * 0.6), testSize: futures, seed: seed + 1, baseline: current.clearance.plan },
          (done, total) => setStress((s) => ({ ...s, progress: { done, total, label: 'Calibrating risk buffer' } })),
        );
      }
      setStress({ status: 'done', data: { stress: stressRes, robust, futures, seed } });
    })().catch((e: Error) => setStress({ status: 'error', data: null, error: e.message }));
  };
  const runBenchmark = (seeds: number) => {
    setBenchmark({ status: 'running', data: null, progress: { done: 0, total: 1 } });
    engine
      .call('benchmark', { seeds: Array.from({ length: seeds }, (_, i) => i + 1), futures: 40 }, (done, total, label) =>
        setBenchmark((b) => ({ ...b, progress: { done, total, label } })),
      )
      .then((data) => setBenchmark({ status: 'done', data }))
      .catch((e: Error) => setBenchmark({ status: 'error', data: null, error: e.message }));
  };

  const value = useMemo<Store>(
    () => ({
      view,
      setView,
      scenarioId,
      scenario,
      importIssues,
      loadScenario,
      importScenario,
      resetScenario,
      pins,
      addPin,
      removePin,
      serviceWeight,
      setServiceWeight: setWeight,
      baselineKind,
      setBaselineKind,
      plan,
      runPlan,
      selectedBatch,
      openBatch: setSelectedBatch,
      truckValues,
      runTruckValues,
      frontier,
      runFrontier,
      replan,
      runReplan,
      stress,
      runStress,
      benchmark,
      runBenchmark,
      solverName,
      theme,
      setTheme: setThemeState,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, scenarioId, scenario, importIssues, pins, serviceWeight, baselineKind, plan, selectedBatch, truckValues, frontier, replan, stress, benchmark, solverName, theme],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
