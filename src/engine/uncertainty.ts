import type { Plan, Scenario } from './types';
import { settle } from './ledger';
import { optimize, type OptimizeResult } from './optimize';
import type { LpSolver } from './solver';
import { indexScenario } from './time';

/**
 * Stress testing. A "future" is a perturbed copy of the scenario:
 *   shelf life   × N(1, cv_commodity)                       per batch      (clamped 0.4–1.6)
 *   transit      × lognormal, mean 1, sd ≈ cv_destination    per lane-day   (delays add hours)
 *   demand       × N(1, demandCv)                           per demand row (clamped 0–2)
 *   price        × N(1, priceCv)                            per demand row (clamped 0.5–1.5)
 * Every plan is executed open-loop (no mid-course correction) by the same
 * ledger on the same futures (common random numbers), so differences between
 * plans are paired and not noise from different draws.
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function normal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function sampleFuture(scenario: Scenario, rng: () => number): Scenario {
  const s: Scenario = structuredClone(scenario);
  const cv = new Map(s.commodities.map((c) => [c.id, c.shelfLifeCv]));
  for (const b of s.batches) {
    b.remainingShelfLifeHours *= clamp(1 + (cv.get(b.commodityId) ?? 0) * normal(rng), 0.4, 1.6);
  }
  for (const d of s.destinations) {
    const sigma = Math.sqrt(Math.log(1 + d.transitCv * d.transitCv));
    const delays: number[] = [];
    for (let day = 0; day < s.horizonDays; day++) {
      const factor = Math.exp(sigma * normal(rng) - (sigma * sigma) / 2);
      const base = d.transitHours + (d.transitDelayByDay?.[day] ?? 0);
      delays.push((d.transitDelayByDay?.[day] ?? 0) + Math.max(-0.25 * d.transitHours, base * factor - base));
    }
    d.transitDelayByDay = delays;
  }
  for (const r of s.demand) {
    r.quantityKg = Math.round(r.quantityKg * clamp(1 + s.uncertainty.demandCv * normal(rng), 0, 2));
    r.pricePerKg = r.pricePerKg * clamp(1 + s.uncertainty.priceCv * normal(rng), 0.5, 1.5);
  }
  return s;
}

export function sampleFutures(scenario: Scenario, n: number, seed: number): Scenario[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => sampleFuture(scenario, rng));
}

export interface Distribution {
  mean: number;
  sd: number;
  p05: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
  values: number[];
}

export function distribution(values: number[]): Distribution {
  const v = [...values].sort((a, b) => a - b);
  const n = v.length || 1;
  const mean = v.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const q = (p: number) => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))] ?? 0;
  return { mean, sd, p05: q(0.05), p50: q(0.5), p95: q(0.95), min: v[0] ?? 0, max: v[v.length - 1] ?? 0, values };
}

export interface PlanStress {
  label: string;
  net: Distribution;
  spoilageRate: Distribution;
  fulfilment: Distribution;
  /** Per shipment (batch|dest|day): share of futures in which part of the load was lost or downgraded. */
  fragility: Map<string, { lostShare: number; downgradedShare: number; meanLostKg: number }>;
}

export function stressPlans(scenario: Scenario, plans: Plan[], futures: Scenario[]): PlanStress[] {
  return plans.map((plan) => {
    const nets: number[] = [];
    const spoil: number[] = [];
    const fill: number[] = [];
    const frag = new Map<string, { lost: number; down: number; lostKg: number }>();
    const nominal = settle(scenario, plan);
    const nominalGrade = new Map(nominal.lines.map((l) => [`${l.batchId}|${l.destId}|${l.day}`, l.grade]));
    for (const f of futures) {
      const o = settle(f, plan, indexScenario(f));
      nets.push(o.totals.net);
      spoil.push(o.totals.spoilageRate);
      fill.push(o.totals.fulfilment);
      for (const l of o.lines) {
        const k = `${l.batchId}|${l.destId}|${l.day}`;
        const e = frag.get(k) ?? { lost: 0, down: 0, lostKg: 0 };
        if (l.wastedKg > 1) {
          e.lost++;
          e.lostKg += l.wastedKg;
        }
        if (nominalGrade.get(k) === 'A' && l.grade !== 'A') e.down++;
        frag.set(k, e);
      }
    }
    const fragility = new Map<string, { lostShare: number; downgradedShare: number; meanLostKg: number }>();
    for (const [k, e] of frag)
      fragility.set(k, {
        lostShare: e.lost / futures.length,
        downgradedShare: e.down / futures.length,
        meanLostKg: e.lostKg / futures.length,
      });
    return {
      label: plan.label,
      net: distribution(nets),
      spoilageRate: distribution(spoil),
      fulfilment: distribution(fill),
      fragility,
    };
  });
}

/**
 * Risk-buffered planning: plan against a deliberately pessimistic copy of the
 * scenario — shelf life shortened by κ·cv, transit lengthened by κ·cv and
 * demand reduced by ½·κ·cv — so loads keep a safety margin against freshness
 * thresholds and demand shortfalls. The buffered plan never violates a hard
 * constraint in the nominal scenario (it assumes less life, longer trips and
 * less demand than the estimate), but it is a heuristic, not a stochastic optimum.
 */
export function bufferScenario(scenario: Scenario, kappa: number): Scenario {
  const s: Scenario = structuredClone(scenario);
  const cv = new Map(s.commodities.map((c) => [c.id, c.shelfLifeCv]));
  for (const b of s.batches) b.remainingShelfLifeHours *= Math.max(0.3, 1 - kappa * (cv.get(b.commodityId) ?? 0));
  // Plan against somewhat less demand than forecast: a load sized to the forecast loses
  // more when demand falls short than it gains when demand runs over.
  for (const r of s.demand) r.quantityKg *= Math.max(0, 1 - 0.5 * kappa * s.uncertainty.demandCv);
  for (const d of s.destinations) {
    const extra = kappa * d.transitCv * d.transitHours;
    d.transitDelayByDay = Array.from({ length: s.horizonDays }, (_, day) => (d.transitDelayByDay?.[day] ?? 0) + extra);
  }
  return s;
}

export interface RobustCandidate {
  kappa: number;
  result: OptimizeResult;
  /** Ledger outcome of the buffered plan in the nominal scenario. */
  nominalNet: number;
  trainMean: number;
  testMean?: number;
}

export interface RobustReport {
  candidates: RobustCandidate[];
  chosen: RobustCandidate;
  nominalPlanTest: PlanStress;
  chosenPlanTest: PlanStress;
  baselineTest?: PlanStress;
  trainSize: number;
  testSize: number;
}

/**
 * Picks κ on "training" futures and reports on a disjoint set of "test" futures,
 * so the reported improvement is not an artefact of tuning on the same draws.
 */
export function robustPlan(
  scenario: Scenario,
  solver: LpSolver,
  opts: {
    kappas?: number[];
    trainSize?: number;
    testSize?: number;
    seed?: number;
    baseline?: Plan;
    onProgress?: (done: number, total: number) => void;
  } = {},
): RobustReport {
  const kappas = opts.kappas ?? [0, 0.5, 1, 1.5, 2];
  const trainSize = opts.trainSize ?? 120;
  const testSize = opts.testSize ?? 200;
  const seed = opts.seed ?? 7;
  const train = sampleFutures(scenario, trainSize, seed);
  const test = sampleFutures(scenario, testSize, seed + 100_003);
  const candidates: RobustCandidate[] = [];
  kappas.forEach((kappa, i) => {
    const result = optimize(bufferScenario(scenario, kappa), solver, { withDuals: false, label: `Risk-buffered κ=${kappa}` });
    const plan = { ...result.plan, label: kappa === 0 ? 'Nominal optimum' : `Risk-buffered (κ = ${kappa})` };
    result.plan = plan;
    const nominalNet = settle(scenario, plan).totals.net;
    const [st] = stressPlans(scenario, [plan], train);
    candidates.push({ kappa, result, nominalNet, trainMean: st.net.mean });
    opts.onProgress?.(i + 1, kappas.length + 1);
  });
  const chosen = candidates.reduce((a, b) => (b.trainMean > a.trainMean + 1e-6 ? b : a));
  const nominal = candidates.find((c) => c.kappa === 0) ?? candidates[0];
  const plans = [nominal.result.plan, chosen.result.plan, ...(opts.baseline ? [opts.baseline] : [])];
  const tested = stressPlans(scenario, plans, test);
  nominal.testMean = tested[0].net.mean;
  chosen.testMean = tested[1].net.mean;
  opts.onProgress?.(kappas.length + 1, kappas.length + 1);
  return {
    candidates,
    chosen,
    nominalPlanTest: tested[0],
    chosenPlanTest: tested[1],
    baselineTest: opts.baseline ? tested[2] : undefined,
    trainSize,
    testSize,
  };
}
