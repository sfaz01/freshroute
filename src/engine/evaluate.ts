import type { Scenario, Totals } from './types';
import { baselinePlan } from './baseline';
import { settle } from './ledger';
import { optimize } from './optimize';
import type { LpSolver } from './solver';
import { sampleFutures, stressPlans } from './uncertainty';

export interface MetricSet {
  net: number;
  spoiledKg: number;
  spoilageRate: number;
  fulfilment: number;
  minDestinationFill: number;
  markdownKg: number;
  trucks: number;
  feasible: boolean;
  violations: number;
}

export interface SuiteRow {
  id: string;
  name: string;
  tests: string;
  inventoryKg: number;
  demandKg: number;
  fefo: MetricSet;
  clearance: MetricSet;
  optimizer: MetricSet;
  status: string;
  solveMs: number;
  consistencyGap: number;
  stress?: { futures: number; fefo: number; clearance: number; optimizer: number; optimizerP05: number; clearanceP05: number };
}

const metrics = (t: Totals, violations: number): MetricSet => ({
  net: t.net,
  spoiledKg: t.spoiledKg,
  spoilageRate: t.spoilageRate,
  fulfilment: t.fulfilment,
  minDestinationFill: t.minDestinationFill,
  markdownKg: t.markdownSoldKg,
  trucks: t.trucksUsed,
  feasible: violations === 0,
  violations,
});

export function evaluateScenario(scenario: Scenario, solver: LpSolver, futures = 0, seed = 11): SuiteRow {
  const fefoPlan = baselinePlan(scenario);
  const clearPlan = baselinePlan(scenario, { clearance: true });
  const fefo = settle(scenario, fefoPlan);
  const clear = settle(scenario, clearPlan);
  const opt = optimize(scenario, solver, { withDuals: false });
  const row: SuiteRow = {
    id: scenario.id,
    name: scenario.name,
    tests: scenario.tests ?? '',
    inventoryKg: fefo.totals.inventoryKg,
    demandKg: fefo.totals.demandKg,
    fefo: metrics(fefo.totals, fefo.violations.length),
    clearance: metrics(clear.totals, clear.violations.length),
    optimizer: metrics(opt.outcome.totals, opt.outcome.violations.length),
    status: opt.status,
    solveMs: opt.stats.solveMs,
    consistencyGap: opt.consistencyGap,
  };
  if (futures > 0) {
    const fs = sampleFutures(scenario, futures, seed);
    const [a, b, c] = stressPlans(scenario, [fefoPlan, clearPlan, opt.plan], fs);
    row.stress = {
      futures,
      fefo: a.net.mean,
      clearance: b.net.mean,
      optimizer: c.net.mean,
      optimizerP05: c.net.p05,
      clearanceP05: b.net.p05,
    };
  }
  return row;
}

export interface SuiteSummary {
  rows: number;
  netGainVsFefo: number;
  netGainVsClearance: number;
  spoilageFefo: number;
  spoilageClearance: number;
  spoilageOptimizer: number;
  fulfilmentFefo: number;
  fulfilmentClearance: number;
  fulfilmentOptimizer: number;
  optimizerWinsNet: number;
  ties: number;
  optimizerLosesNet: number;
  infeasiblePlans: number;
}

/** Aggregates are kg- and rupee-weighted sums, not averages of percentages. */
export function summarise(rows: SuiteRow[]): SuiteSummary {
  const sum = (f: (r: SuiteRow) => number) => rows.reduce((a, r) => a + f(r), 0);
  const inv = sum((r) => r.inventoryKg) || 1;
  const dem = sum((r) => r.demandKg) || 1;
  const tol = (r: SuiteRow) => Math.max(1, 1e-4 * Math.abs(r.clearance.net));
  return {
    rows: rows.length,
    netGainVsFefo: sum((r) => r.optimizer.net - r.fefo.net),
    netGainVsClearance: sum((r) => r.optimizer.net - r.clearance.net),
    spoilageFefo: sum((r) => r.fefo.spoiledKg) / inv,
    spoilageClearance: sum((r) => r.clearance.spoiledKg) / inv,
    spoilageOptimizer: sum((r) => r.optimizer.spoiledKg) / inv,
    fulfilmentFefo: sum((r) => r.fefo.fulfilment * r.demandKg) / dem,
    fulfilmentClearance: sum((r) => r.clearance.fulfilment * r.demandKg) / dem,
    fulfilmentOptimizer: sum((r) => r.optimizer.fulfilment * r.demandKg) / dem,
    optimizerWinsNet: rows.filter((r) => r.optimizer.net - Math.max(r.fefo.net, r.clearance.net) > tol(r)).length,
    ties: rows.filter((r) => Math.abs(r.optimizer.net - Math.max(r.fefo.net, r.clearance.net)) <= tol(r)).length,
    optimizerLosesNet: rows.filter((r) => Math.max(r.fefo.net, r.clearance.net) - r.optimizer.net > tol(r)).length,
    infeasiblePlans: rows.filter((r) => !r.optimizer.feasible || !r.fefo.feasible || !r.clearance.feasible).length,
  };
}
