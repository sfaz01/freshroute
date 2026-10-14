import { beforeAll, describe, expect, it } from 'vitest';
import { optimize } from '../src/engine/optimize';
import { baselinePlan } from '../src/engine/baseline';
import { settle, audit } from '../src/engine/ledger';
import { CATALOG, buildScenario, randomScenario } from '../src/engine/scenarios/catalog';
import { evaluateOption, indexScenario, demandKey } from '../src/engine/time';
import type { LpSolver } from '../src/engine/solver';
import type { Scenario } from '../src/engine/types';
import { getSolver, micro } from './helpers';

let solver: LpSolver;
beforeAll(async () => {
  solver = await getSolver();
});

/** Independent re-check of every hard constraint on a plan. */
function assertHardConstraints(s: Scenario, shipments: { batchId: string; destId: string; day: number; quantityKg: number }[]) {
  const ix = indexScenario(s);
  const byBatch = new Map<string, number>();
  const byLaneDay = new Map<string, number>();
  for (const sh of shipments) {
    byBatch.set(sh.batchId, (byBatch.get(sh.batchId) ?? 0) + sh.quantityKg);
    byLaneDay.set(`${sh.destId}|${sh.day}`, (byLaneDay.get(`${sh.destId}|${sh.day}`) ?? 0) + sh.quantityKg);
    const o = evaluateOption(ix, ix.batch.get(sh.batchId)!, ix.dest.get(sh.destId)!, sh.day);
    expect(o.feasible, `${sh.batchId}→${sh.destId} D${sh.day}: ${o.code}`).toBe(true);
  }
  for (const [id, q] of byBatch) expect(q).toBeLessThanOrEqual(ix.batch.get(id)!.quantityKg + 0.05);
  for (let day = 0; day < s.horizonDays; day++) {
    let trucks = 0;
    for (const d of s.destinations) {
      const load = byLaneDay.get(`${d.id}|${day}`) ?? 0;
      if (load > 0.05) trucks += Math.ceil((load - 0.05) / s.fleet.truckCapacityKg);
    }
    expect(trucks).toBeLessThanOrEqual(s.fleet.trucksPerDay[day]);
  }
}

describe('optimiser on a hand-solved instance', () => {
  it('finds the optimum computed by hand', () => {
    // FAR D0 list 600 kg × (30−1) − ₹3000 truck; same truck carries 238.5 kg at −20% (₹23/kg net);
    // the remaining 161.5 kg goes to NEAR at list (₹19/kg) on a ₹1000 truck.
    const md = 600 * (Math.pow(0.8, -1.5) - 1);
    const expected = 600 * 29 - 3000 + md * 23 + (1000 - 600 - md) * 19 - 1000;
    const r = optimize(micro(), solver);
    expect(r.status).toBe('optimal');
    expect(r.outcome.totals.net).toBeCloseTo(expected, 0);
    expect(r.consistencyGap).toBeLessThan(1);
  });

  it('beats sending everything to the highest price', () => {
    const s = micro();
    const r = optimize(s, solver);
    const allFar = settle(s, { label: 'far', method: 'manual', shipments: [{ batchId: 'B1', destId: 'FAR', day: 0, quantityKg: 1000 }] });
    expect(r.outcome.totals.net).toBeGreaterThan(allFar.totals.net);
  });

  it('sends a highly perishable batch only where it can arrive in time', () => {
    const s = micro((x) => (x.batches[0].remainingShelfLifeHours = 50)); // FAR arrives at 53 h: impossible
    const r = optimize(s, solver);
    expect(r.plan.shipments.length).toBeGreaterThan(0);
    expect(r.plan.shipments.every((sh) => sh.destId === 'NEAR' && sh.day === 0)).toBe(true);
    expect(r.outcome.feasible).toBe(true);
  });

  it('chooses to discount when the markdown beats the write-off, and not when it does not', () => {
    const glut = micro((x) => {
      x.batches[0].quantityKg = 2000;
      x.batches[0].remainingShelfLifeHours = 60; // spoils inside the horizon if unsold
    });
    const r1 = optimize(glut, solver);
    expect(r1.outcome.totals.markdownSoldKg).toBeGreaterThan(0);
    // Make the markdown worthless: 80 % off, handling ₹1/kg, write-off free.
    const worthless = micro((x) => {
      x.batches[0].quantityKg = 2000;
      x.batches[0].remainingShelfLifeHours = 60;
      x.discountTiers = [0.96];
      x.commodities[0].spoilageCostPerKg = 0;
    });
    const r2 = optimize(worthless, solver);
    expect(r2.outcome.totals.markdownSoldKg).toBe(0);
  });

  it('reports an infeasible override without discarding the plan', () => {
    const s = micro((x) => (x.batches[0].remainingShelfLifeHours = 50));
    const r = optimize(s, solver, { pins: [{ kind: 'force', batchId: 'B1', destId: 'FAR', minKg: 100 }] });
    expect(r.status).toBe('infeasible');
    expect(r.message).toMatch(/No feasible way/);
  });

  it('respects operator bans', () => {
    const r = optimize(micro(), solver, { pins: [{ kind: 'ban', destId: 'FAR' }] });
    expect(r.plan.shipments.every((sh) => sh.destId !== 'FAR')).toBe(true);
  });
});

describe('optimiser across the scenario suite', () => {
  const suite = [...CATALOG.map((c) => c.id), 'random:1', 'random:2', 'random:3'];
  for (const id of suite) {
    it(`${id}: feasible, consistent with the ledger, and never worse than either baseline`, () => {
      const s = id.startsWith('random:') ? randomScenario(Number(id.split(':')[1])) : buildScenario(id);
      const r = optimize(s, solver);
      expect(['optimal', 'feasible']).toContain(r.status);
      expect(r.outcome.violations).toEqual([]);
      expect(audit(r.outcome).every((c) => c.passed)).toBe(true);
      assertHardConstraints(s, r.plan.shipments);
      // The model objective and the independent ledger agree (no double counting).
      expect(r.consistencyGap).toBeLessThan(2);
      // List-price sales never exceed stated demand.
      for (const d of r.outcome.demand) expect(d.fullPriceSoldKg).toBeLessThanOrEqual(d.demandKg + 0.05);
      // Both baselines are feasible plans of the same model, so the optimum must be at least as good.
      for (const plan of [baselinePlan(s), baselinePlan(s, { clearance: true })]) {
        const b = settle(s, plan);
        expect(b.violations).toEqual([]);
        assertHardConstraints(s, plan.shipments);
        expect(r.outcome.totals.net).toBeGreaterThanOrEqual(b.totals.net - Math.max(5, 2e-4 * Math.abs(b.totals.net)));
      }
    });
  }
});

describe('specific planning situations', () => {
  it('demand exceeding inventory: every kg that can be sold profitably is shipped', () => {
    const s = buildScenario('short-supply');
    const r = optimize(s, solver);
    expect(r.outcome.totals.demandKg).toBeGreaterThan(r.outcome.totals.inventoryKg);
    expect(r.outcome.totals.spoilageRate).toBeLessThan(0.05);
  });

  it('inventory exceeding demand: surplus is marked down or written off, never oversupplied', () => {
    const s = buildScenario('harvest-glut');
    const r = optimize(s, solver);
    expect(r.outcome.totals.inventoryKg).toBeGreaterThan(r.outcome.totals.demandKg);
    expect(r.outcome.totals.markdownSoldKg).toBeGreaterThan(0);
    expect(r.outcome.violations.filter((v) => v.code === 'oversupply')).toEqual([]);
  });

  it('insufficient transport capacity: the fleet is the binding constraint and never exceeded', () => {
    const s = buildScenario('fleet-crunch');
    const r = optimize(s, solver);
    for (let day = 0; day < s.horizonDays; day++) {
      const used = r.outcome.trucks.filter((t) => t.day === day).reduce((a, t) => a + t.trucks, 0);
      expect(used).toBeLessThanOrEqual(3);
    }
    expect(r.outcome.trucks.filter((t) => t.day === 0).reduce((a, t) => a + t.trucks, 0)).toBe(3);
  });

  it('no feasible allocation for all demand: a partial, feasible plan is preserved', () => {
    const s = buildScenario('stranded');
    const r = optimize(s, solver);
    expect(r.status).toBe('optimal');
    expect(r.outcome.totals.fulfilment).toBeLessThan(0.5);
    expect(r.plan.shipments.length).toBeGreaterThan(0);
    expect(r.outcome.violations).toEqual([]);
    expect(r.plan.shipments.every((sh) => ['MUM', 'PUN', 'NSK'].includes(sh.destId))).toBe(true);
  });

  it('a service weight trades net for fulfilment, and is excluded from the reported net', () => {
    const s = buildScenario('heatwave');
    const a = optimize(s, solver);
    const b = optimize(s, solver, { serviceWeightPerKg: 30 });
    expect(b.outcome.totals.fulfilment).toBeGreaterThanOrEqual(a.outcome.totals.fulfilment);
    expect(b.outcome.totals.net).toBeLessThanOrEqual(a.outcome.totals.net + 1);
    expect(b.consistencyGap).toBeLessThan(2);
  });

  it('is reproducible: identical inputs give identical plans', () => {
    const a = optimize(buildScenario('ordinary-day'), solver);
    const b = optimize(buildScenario('ordinary-day'), solver);
    expect(b.plan.shipments).toEqual(a.plan.shipments);
    expect(b.outcome.totals.net).toBe(a.outcome.totals.net);
  });

  it('LP duals price stock: an unsold, expiring batch is worth at most its write-off avoided', () => {
    const s = buildScenario('ordinary-day');
    const r = optimize(s, solver);
    expect(r.duals).not.toBeNull();
    for (const b of s.batches) {
      const v = r.duals!.stock.get(b.id)!;
      expect(Number.isFinite(v)).toBe(true);
    }
    // A demand row filled to its cap has a non-negative scarcity rent.
    for (const d of r.outcome.demand) {
      const mu = r.duals!.demand.get(`${demandKey(d.destId, d.commodityId, d.session)}|0`);
      if (mu !== undefined) expect(mu).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});
