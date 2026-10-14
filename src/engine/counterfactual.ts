import type { Pin, Scenario, Totals } from './types';
import { optimize, type OptimizeResult } from './optimize';
import type { LpSolver } from './solver';
import { kg, pts, rupeesDelta } from './fmt';

/**
 * Counterfactuals are exact: the full model is re-solved with the extra
 * condition, so the reported cost of an override includes every knock-on
 * effect (displaced lots, re-packed trucks, changed markdowns).
 */

export interface Delta {
  net: number;
  spoiledKg: number;
  fulfilment: number;
  markdownKg: number;
  trucks: number;
}

export function delta(from: Totals, to: Totals): Delta {
  return {
    net: to.net - from.net,
    spoiledKg: to.spoiledKg - from.spoiledKg,
    fulfilment: to.fulfilment - from.fulfilment,
    markdownKg: to.markdownSoldKg - from.markdownSoldKg,
    trucks: to.trucksUsed - from.trucksUsed,
  };
}

export function describeDelta(d: Delta): string {
  const bits = [`net ${rupeesDelta(d.net)}`];
  if (Math.abs(d.spoiledKg) >= 1) bits.push(`spoilage ${d.spoiledKg > 0 ? '+' : '−'}${kg(Math.abs(d.spoiledKg))}`);
  if (Math.abs(d.fulfilment) >= 0.0005) bits.push(`fulfilment ${pts(d.fulfilment)}`);
  if (d.trucks !== 0) bits.push(`${d.trucks > 0 ? '+' : ''}${d.trucks} truck${Math.abs(d.trucks) === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

export interface ChallengeResult {
  pin: Pin;
  result: OptimizeResult;
  delta: Delta | null;
  verdict: string;
}

export function challenge(scenario: Scenario, base: OptimizeResult, pin: Pin, solver: LpSolver): ChallengeResult {
  const committed = base.plan.shipments.filter((s) => s.day < base.asOfDay);
  const result = optimize(scenario, solver, {
    asOfDay: base.asOfDay,
    committed,
    pins: [...base.pins, pin],
    label: 'Plan with override',
  });
  if (result.status === 'infeasible' || result.status === 'error') {
    return { pin, result, delta: null, verdict: result.message ?? 'This override cannot be satisfied.' };
  }
  const d = delta(base.outcome.totals, result.outcome.totals);
  const verdict =
    Math.abs(d.net) < 1
      ? `No cost: an equally good plan exists with this override (${describeDelta(d)}).`
      : d.net < 0
        ? `Costs ${rupeesDelta(-d.net).replace('+', '')} against the recommended plan (${describeDelta(d)}).`
        : `Improves the plan (${describeDelta(d)}) — the original was not optimal for these conditions.`;
  return { pin, result, delta: d, verdict };
}

export interface TruckValue {
  day: number;
  available: number;
  used: number;
  /** Net gained by one more truck that day (exact re-solve). */
  plusOne: number;
  plusOneFulfilment: number;
  /** Net lost if one truck were withdrawn (exact re-solve; −Infinity if infeasible). */
  minusOne: number;
}

/** Prices the fleet constraint day by day by re-solving with ±1 truck. */
export function truckValues(scenario: Scenario, base: OptimizeResult, solver: LpSolver): TruckValue[] {
  const committed = base.plan.shipments.filter((s) => s.day < base.asOfDay);
  const out: TruckValue[] = [];
  for (let day = base.asOfDay; day < scenario.horizonDays; day++) {
    const used = base.outcome.trucks.filter((t) => t.day === day).reduce((a, t) => a + t.trucks, 0);
    const available = scenario.fleet.trucksPerDay[day] ?? 0;
    const variant = (deltaTrucks: number) => {
      const s2: Scenario = structuredClone(scenario);
      s2.fleet.trucksPerDay[day] = Math.max(0, available + deltaTrucks);
      return optimize(s2, solver, { asOfDay: base.asOfDay, committed, pins: base.pins, withDuals: false });
    };
    const plus = variant(1);
    const minus = used < available ? null : available > 0 ? variant(-1) : null;
    out.push({
      day,
      available,
      used,
      plusOne: plus.status === 'infeasible' ? 0 : plus.outcome.totals.net - base.outcome.totals.net,
      plusOneFulfilment: plus.status === 'infeasible' ? 0 : plus.outcome.totals.fulfilment - base.outcome.totals.fulfilment,
      minusOne:
        minus === null
          ? 0
          : minus.status === 'infeasible'
            ? -Infinity
            : minus.outcome.totals.net - base.outcome.totals.net,
    });
  }
  return out;
}
