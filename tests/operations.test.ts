import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '../src/engine/optimize';
import { replan, applyDisruptions, presetEvents } from '../src/engine/disruptions';
import { challenge, truckValues } from '../src/engine/counterfactual';
import { explain } from '../src/engine/explain';
import { validateScenario } from '../src/engine/validate';
import { settle } from '../src/engine/ledger';
import { sampleFutures, stressPlans, bufferScenario, robustPlan } from '../src/engine/uncertainty';
import { buildScenario } from '../src/engine/scenarios/catalog';
import { baselinePlan } from '../src/engine/baseline';
import type { LpSolver } from '../src/engine/solver';
import { getSolver, micro } from './helpers';

let solver: LpSolver;
beforeAll(async () => {
  solver = await getSolver();
});

describe('replanning after a disruption', () => {
  it('delayed shipment: freezes what already left, re-plans the rest, and does better than the stale plan', () => {
    const s = buildScenario('ordinary-day');
    const base = optimize(s, solver);
    const event = presetEvents(s).find((e) => e.id === 'del-delay')!;
    const rp = replan(s, base.plan, event.changes, event.asOfDay, solver);
    // Everything dispatched before D1 is unchanged.
    const before = base.plan.shipments.filter((x) => x.day < 1);
    const after = rp.replanned.plan.shipments.filter((x) => x.day < 1);
    expect(after).toEqual(before);
    expect(rp.replanned.outcome.violations.filter((v) => v.day !== undefined && v.day >= 1)).toEqual([]);
    expect(rp.valueOfReplanning.net).toBeGreaterThanOrEqual(-1);
  });

  it('unexpected demand change: re-plan never loses to executing the old plan', () => {
    const s = buildScenario('ordinary-day');
    const base = optimize(s, solver);
    for (const ev of presetEvents(s)) {
      const rp = replan(s, base.plan, ev.changes, ev.asOfDay, solver);
      expect(['optimal', 'feasible']).toContain(rp.replanned.status);
      expect(rp.replanned.outcome.totals.net).toBeGreaterThanOrEqual(rp.stale.totals.net - 1);
    }
  });

  it('a fleet cut makes the stale plan physically impossible, and the ledger says so', () => {
    const s = buildScenario('ordinary-day');
    const base = optimize(s, solver);
    const strike = presetEvents(s).find((e) => e.id === 'strike')!;
    const rp = replan(s, base.plan, strike.changes, strike.asOfDay, solver);
    expect(rp.stale.violations.some((v) => v.code === 'capacity')).toBe(true);
    expect(rp.replanned.outcome.violations.some((v) => v.code === 'capacity')).toBe(false);
  });

  it('applies disruptions as pure patches without mutating the input', () => {
    const s = buildScenario('ordinary-day');
    const snapshot = JSON.stringify(s);
    const s2 = applyDisruptions(s, [{ kind: 'fleet_change', days: [0], trucks: 1 }]);
    expect(JSON.stringify(s)).toBe(snapshot);
    expect(s2.fleet.trucksPerDay[0]).toBe(1);
  });
});

describe('counterfactuals and explanations', () => {
  it('forcing an alternative never beats the optimum', () => {
    const s = buildScenario('ordinary-day');
    const base = optimize(s, solver);
    const brief = explain(s, base).briefs.get('TOM-03')!;
    const alt = brief.alternatives.find((a) => a.status === 'feasible')!;
    const c = challenge(s, base, { kind: 'force', batchId: 'TOM-03', destId: alt.destId, minKg: 200 }, solver);
    expect(c.delta).not.toBeNull();
    expect(c.delta!.net).toBeLessThanOrEqual(1);
    expect(c.result.plan.shipments.filter((x) => x.batchId === 'TOM-03' && x.destId === alt.destId).reduce((a, x) => a + x.quantityKg, 0)).toBeGreaterThanOrEqual(199.9);
  });

  it('explains every batch, and every infeasible destination has a reason', () => {
    const s = buildScenario('ordinary-day');
    const ex = explain(s, optimize(s, solver));
    expect(ex.briefs.size).toBe(s.batches.length);
    for (const b of ex.briefs.values()) {
      expect(b.headline.length).toBeGreaterThan(5);
      for (const a of b.alternatives) expect(a.reason.length).toBeGreaterThan(5);
    }
    expect(ex.priorityOrder.length).toBe(s.batches.length);
  });

  it('flags the coriander lot that no plan can save as stranded', () => {
    const s = buildScenario('ordinary-day');
    const b = explain(s, optimize(s, solver)).briefs.get('COR-01')!;
    expect(b.urgency).toBe('stranded');
    expect(b.alternatives.every((a) => a.status === 'infeasible')).toBe(true);
  });

  it('gives every discount a reason and a positive advantage over spoilage', () => {
    const s = buildScenario('harvest-glut');
    const ex = explain(s, optimize(s, solver));
    expect(ex.discounts.length).toBeGreaterThan(0);
    for (const d of ex.discounts) {
      expect(d.reason).toMatch(/nets/);
      expect(d.advantagePerKg).toBeGreaterThan(0);
    }
  });

  it('prices extra trucks only where the fleet binds', () => {
    const s = buildScenario('fleet-crunch');
    const base = optimize(s, solver);
    const tv = truckValues(s, base, solver);
    expect(tv.length).toBe(s.horizonDays);
    expect(tv.some((t) => t.plusOne > 0)).toBe(true);
    for (const t of tv) expect(t.plusOne).toBeGreaterThanOrEqual(-1);
  });
});

describe('uncertainty', () => {
  it('samples identical futures for identical seeds', () => {
    const s = buildScenario('ordinary-day');
    expect(JSON.stringify(sampleFutures(s, 5, 42))).toBe(JSON.stringify(sampleFutures(s, 5, 42)));
    expect(JSON.stringify(sampleFutures(s, 5, 42))).not.toBe(JSON.stringify(sampleFutures(s, 5, 43)));
  });

  it('a risk-buffered plan never violates a hard constraint in the nominal world', () => {
    const s = buildScenario('ordinary-day');
    const r = optimize(bufferScenario(s, 1.5), solver);
    const nominal = settle(s, r.plan);
    expect(nominal.violations).toEqual([]);
  });

  it('stress-tests plans on common futures and chooses κ on separate training futures', () => {
    const s = micro();
    const report = robustPlan(s, solver, { kappas: [0, 1], trainSize: 20, testSize: 20, seed: 3, baseline: baselinePlan(s) });
    expect(report.candidates.length).toBe(2);
    expect(report.nominalPlanTest.net.values.length).toBe(20);
    const [a] = stressPlans(s, [report.chosen.result.plan], sampleFutures(s, 10, 1));
    expect(a.net.p05).toBeLessThanOrEqual(a.net.p95);
  });
});

describe('input validation', () => {
  it('accepts the bundled scenario unchanged', () => {
    const s = buildScenario('ordinary-day');
    const v = validateScenario(JSON.parse(JSON.stringify(s)));
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    expect(v.scenario!.batches.length).toBe(s.batches.length);
  });

  it('repairs or drops malformed rows and reports each repair', () => {
    const raw = JSON.parse(JSON.stringify(micro()));
    raw.batches.push({ id: 'B2', commodityId: 'APPLE', quantityKg: 10, remainingShelfLifeHours: 10 });
    raw.batches.push({ id: 'B3', commodityId: 'TOM', quantityKg: -5, remainingShelfLifeHours: 10 });
    raw.batches.push({ id: 'B4', commodityId: 'TOM', quantityKg: '250', remainingShelfLifeHours: 80 });
    raw.batches.push({ id: 'B1', commodityId: 'TOM', quantityKg: 1, remainingShelfLifeHours: 1 });
    raw.batches.push({ id: 'B5', commodityId: 'TOM', quantityKg: 100 });
    raw.demand.push({ destId: 'NEAR', commodityId: 'TOM', session: 1, quantityKg: 100, pricePerKg: 26 });
    raw.demand.push({ destId: 'MOON', commodityId: 'TOM', session: 1, quantityKg: 100, pricePerKg: 26 });
    const v = validateScenario(raw);
    expect(v.scenario).not.toBeNull();
    expect(v.scenario!.batches.map((b) => b.id)).toEqual(['B1', 'B4']);
    expect(v.scenario!.batches[1].quantityKg).toBe(250);
    const merged = v.scenario!.demand.find((r) => r.destId === 'NEAR' && r.session === 1)!;
    expect(merged.quantityKg).toBe(700);
    expect(merged.pricePerKg).toBeCloseTo((600 * 20 + 100 * 26) / 700, 6);
    expect(v.issues.filter((i) => i.severity === 'warning').length).toBeGreaterThanOrEqual(6);
  });

  it('rejects a scenario that cannot be planned', () => {
    const v = validateScenario({ horizonDays: 'soon', batches: 'none' });
    expect(v.scenario).toBeNull();
    expect(v.issues.some((i) => i.severity === 'error')).toBe(true);
    expect(validateScenario(null).scenario).toBeNull();
  });

  it('plans safely around an inconsistent but repairable dataset', async () => {
    const raw = JSON.parse(JSON.stringify(micro()));
    raw.commodities[0].fullPriceLifeHours = 5; // below the minimum sale life → raised
    raw.fleet.trucksPerDay = [2]; // too short → extended
    const v = validateScenario(raw);
    expect(v.scenario!.commodities[0].fullPriceLifeHours).toBe(12);
    expect(v.scenario!.fleet.trucksPerDay).toEqual([2, 2]);
    const r = optimize(v.scenario!, solver);
    expect(r.outcome.violations).toEqual([]);
  });
});
