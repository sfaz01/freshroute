/// <reference lib="webworker" />
/**
 * Runs the decision engine off the main thread. Every call is a plain function
 * of its inputs; the worker keeps no state besides the loaded solver.
 */
import highsLoader from 'highs';
import wasmUrl from 'highs/runtime?url';
import { wrapHighs, type LpSolver } from '../engine/solver';
import { optimize } from '../engine/optimize';
import { baselinePlan } from '../engine/baseline';
import { settle } from '../engine/ledger';
import { explain } from '../engine/explain';
import { challenge, truckValues } from '../engine/counterfactual';
import { replan } from '../engine/disruptions';
import { robustPlan, sampleFutures, stressPlans } from '../engine/uncertainty';
import { evaluateScenario, summarise, type SuiteRow } from '../engine/evaluate';
import { CATALOG, randomScenario } from '../engine/scenarios/catalog';
import type { Op, OpArgs } from './protocol';

let solverPromise: Promise<LpSolver> | null = null;
const getSolver = () =>
  (solverPromise ??= highsLoader({ locateFile: () => wasmUrl }).then((h) => {
    const v = (h as unknown as { version?: { major: number; minor: number; patch: number } }).version;
    return wrapHighs(h as never, v ? `HiGHS ${v.major}.${v.minor}.${v.patch}` : 'HiGHS');
  }));

const post = (msg: unknown) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg);

async function handle<K extends Op>(id: number, op: K, args: OpArgs[K]): Promise<unknown> {
  const solver = await getSolver();
  const progress = (done: number, total: number, label?: string) => post({ id, progress: { done, total, label } });
  switch (op) {
    case 'plan': {
      const a = args as OpArgs['plan'];
      const result = optimize(a.scenario, solver, { pins: a.pins, serviceWeightPerKg: a.serviceWeight });
      const fefoPlan = baselinePlan(a.scenario);
      const clearPlan = baselinePlan(a.scenario, { clearance: true });
      return {
        result,
        explanation: explain(a.scenario, result),
        fefo: { plan: fefoPlan, outcome: settle(a.scenario, fefoPlan) },
        clearance: { plan: clearPlan, outcome: settle(a.scenario, clearPlan) },
      };
    }
    case 'challenge': {
      const a = args as OpArgs['challenge'];
      return challenge(a.scenario, a.base, a.pin, solver);
    }
    case 'truckValues': {
      const a = args as OpArgs['truckValues'];
      return truckValues(a.scenario, a.base, solver);
    }
    case 'frontier': {
      const a = args as OpArgs['frontier'];
      return a.weights.map((w, i) => {
        progress(i, a.weights.length);
        const r = optimize(a.scenario, solver, { serviceWeightPerKg: w, pins: a.pins, withDuals: false });
        const t = r.outcome.totals;
        return { weight: w, net: t.net, fulfilment: t.fulfilment, spoilageRate: t.spoilageRate, status: r.status };
      });
    }
    case 'replan': {
      const a = args as OpArgs['replan'];
      const rp = replan(a.scenario, a.plan, a.changes, a.asOfDay, solver);
      return { ...rp, explanation: explain(rp.disrupted, rp.replanned) };
    }
    case 'stress': {
      const a = args as OpArgs['stress'];
      const futures = sampleFutures(a.scenario, a.futures, a.seed);
      return stressPlans(a.scenario, a.plans, futures);
    }
    case 'robust': {
      const a = args as OpArgs['robust'];
      const rep = robustPlan(a.scenario, solver, {
        trainSize: a.trainSize,
        testSize: a.testSize,
        seed: a.seed,
        baseline: a.baseline,
        onProgress: (d, t) => progress(d, t),
      });
      // Drop the heavy option tables before posting back.
      for (const c of rep.candidates) c.result = { ...c.result, options: [], duals: null };
      return rep;
    }
    case 'benchmark': {
      const a = args as OpArgs['benchmark'];
      const scenarios = [...CATALOG.map((c) => () => c.build()), ...a.seeds.map((s) => () => randomScenario(s))];
      const rows: SuiteRow[] = [];
      scenarios.forEach((make, i) => {
        const s = make();
        progress(i, scenarios.length, s.name);
        rows.push(evaluateScenario(s, solver, a.futures, 11 + i));
      });
      progress(scenarios.length, scenarios.length);
      const named = rows.slice(0, CATALOG.length);
      const random = rows.slice(CATALOG.length);
      return { rows, named: summarise(named), random: summarise(random), solver: solver.name };
    }
    case 'ping':
      return { solver: solver.name };
  }
}

self.onmessage = async (e: MessageEvent<{ id: number; op: Op; args: never }>) => {
  const { id, op, args } = e.data;
  try {
    const result = await handle(id, op, args);
    post({ id, ok: true, result });
  } catch (err) {
    post({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
