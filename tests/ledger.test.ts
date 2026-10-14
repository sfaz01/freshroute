import { describe, expect, it } from 'vitest';
import { settle, audit } from '../src/engine/ledger';
import { evaluateOption, indexScenario, tierOffers, saleSession } from '../src/engine/time';
import { micro } from './helpers';

describe('time and shelf-life feasibility', () => {
  it('computes arrival sessions from dispatch, load, transit and dock times', () => {
    const s = micro();
    const [near, far] = s.destinations;
    expect(saleSession(s, near, 0)).toBe(1); // ready 25 h, session opens 29 h
    expect(saleSession(s, far, 0)).toBe(2); // ready 51 h, session opens 53 h
    expect(saleSession(s, near, 1)).toBe(2);
  });

  it('lets a load arriving inside the session window sell that morning, but not later', () => {
    const late = micro((x) => (x.destinations[0].transitDelayByDay = [6.5])); // ready 31.5 h: within 29–32 h
    expect(saleSession(late, late.destinations[0], 0)).toBe(1);
    const tooLate = micro((x) => (x.destinations[0].transitDelayByDay = [7.5])); // ready 32.5 h
    expect(saleSession(tooLate, tooLate.destinations[0], 0)).toBe(2);
  });

  it('grades a lot by remaining life when it is offered for sale', () => {
    const s = micro((x) => (x.batches[0].remainingShelfLifeHours = 60));
    const ix = indexScenario(s);
    const near = evaluateOption(ix, s.batches[0], s.destinations[0], 0); // 60 − 29 = 31 h < 36 h → B
    expect(near.feasible).toBe(true);
    expect(near.grade).toBe('B');
    expect(near.tiers.map((t) => t.tier)).toEqual([1]);
    const far = evaluateOption(ix, s.batches[0], s.destinations[1], 0); // 60 − 53 = 7 h < 12 h → rejected
    expect(far.feasible).toBe(false);
    expect(far.code).toBe('shelf_life');
  });

  it('sizes markdown demand with constant elasticity', () => {
    const s = micro();
    const offers = tierOffers(s, s.commodities[0], s.destinations[0], s.demand[0]);
    expect(offers[0].capacityKg).toBe(600);
    expect(offers[1].pricePerKg).toBeCloseTo(16, 6);
    expect(offers[1].capacityKg).toBeCloseTo(600 * (Math.pow(0.8, -1.5) - 1), 6);
  });

  it('refuses dispatch before a batch reaches the hub, and on closed lanes', () => {
    const s = micro((x) => {
      x.batches[0].availableFromDay = 1;
      x.destinations[0].closedDays = [1];
    });
    const ix = indexScenario(s);
    expect(evaluateOption(ix, s.batches[0], s.destinations[0], 0).code).toBe('not_available');
    expect(evaluateOption(ix, s.batches[0], s.destinations[0], 1).code).toBe('lane_closed');
  });
});

describe('ledger accounting', () => {
  it('books revenue only for kg sold, at the realised price, with no double counting', () => {
    const s = micro();
    // 800 kg to NEAR on D0: 600 at list ₹20, 200 at −20% (₹16); 200 kg left at the hub.
    const o = settle(s, { label: 't', method: 'manual', shipments: [{ batchId: 'B1', destId: 'NEAR', day: 0, quantityKg: 800 }] });
    const t = o.totals;
    expect(o.feasible).toBe(true);
    expect(t.revenue).toBeCloseTo(600 * 20 + 200 * 16, 6);
    expect(t.listValue).toBeCloseTo(800 * 20, 6);
    expect(t.discountGiven).toBeCloseTo(200 * 4, 6);
    expect(t.transportCost).toBe(1000);
    expect(t.handlingCost).toBe(800);
    // B1 expires at 100 h; horizon ends at 48 h; 100 − 48 = 52 ≥ 12 → leftover is carried, not spoiled.
    expect(t.carriedKg).toBeCloseTo(200, 6);
    expect(t.spoiledKg).toBe(0);
    expect(t.net).toBeCloseTo(15200 - 1000 - 800, 6);
    expect(t.fulfilment).toBeCloseTo(600 / 2400, 6);
    expect(t.servedDemandKg + t.shortfallKg).toBeCloseTo(t.demandKg, 6);
    // Mass balance: every kg is sold, spoiled or carried.
    expect(t.soldKg + t.spoiledKg + t.carriedKg).toBeCloseTo(t.inventoryKg, 6);
  });

  it('writes off expired hub stock at the dataset spoilage cost', () => {
    const s = micro((x) => (x.batches[0].remainingShelfLifeHours = 40));
    const o = settle(s, { label: 'empty', method: 'manual', shipments: [] });
    expect(o.totals.spoiledAtHubKg).toBe(1000);
    expect(o.totals.spoilageCost).toBe(10000);
    expect(o.totals.revenue).toBe(0);
    expect(o.totals.net).toBe(-10000);
  });

  it('flags and writes off a load that arrives too old to sell', () => {
    const s = micro((x) => (x.batches[0].remainingShelfLifeHours = 60));
    const o = settle(s, { label: 't', method: 'manual', shipments: [{ batchId: 'B1', destId: 'FAR', day: 0, quantityKg: 500 }] });
    expect(o.feasible).toBe(false);
    expect(o.violations.some((v) => v.code === 'shelf_life')).toBe(true);
    expect(o.totals.spoiledAtDestKg).toBe(500);
    expect(o.totals.revenue).toBe(0);
    expect(audit(o).find((c) => c.id === 'shelf')!.passed).toBe(false);
  });

  it('never dispatches nonexistent stock or exceeds the fleet', () => {
    const s = micro((x) => (x.fleet.trucksPerDay = [1, 1]));
    const o = settle(s, {
      label: 't',
      method: 'manual',
      shipments: [
        { batchId: 'B1', destId: 'NEAR', day: 0, quantityKg: 900 },
        { batchId: 'B1', destId: 'FAR', day: 0, quantityKg: 900 },
        { batchId: 'GHOST', destId: 'NEAR', day: 0, quantityKg: 50 },
      ],
    });
    expect(o.totals.shippedKg).toBeLessThanOrEqual(1000);
    expect(o.trucks.reduce((a, t) => a + t.trucks, 0)).toBeLessThanOrEqual(1);
    const codes = new Set(o.violations.map((v) => v.code));
    expect(codes.has('capacity') || codes.has('stock')).toBe(true);
    expect(codes.has('unknown_ref')).toBe(true);
  });

  it('writes off oversupply beyond list and markdown demand', () => {
    const s = micro((x) => (x.batches[0].quantityKg = 3000));
    const o = settle(s, { label: 't', method: 'manual', shipments: [{ batchId: 'B1', destId: 'NEAR', day: 0, quantityKg: 2000 }] });
    const sold = 600 + 600 * (Math.pow(0.8, -1.5) - 1);
    expect(o.totals.soldKg).toBeCloseTo(sold, 6);
    expect(o.totals.spoiledAtDestKg).toBeCloseTo(2000 - sold, 6);
    expect(o.violations.some((v) => v.code === 'oversupply')).toBe(true);
  });

  it('applies contract shortfall penalties and excludes salvage outlets from fulfilment', () => {
    const s = micro((x) => {
      x.destinations[0].shortfallPenaltyPerKg = 2;
      x.destinations[1].salvageOutlet = true;
    });
    const o = settle(s, { label: 't', method: 'manual', shipments: [{ batchId: 'B1', destId: 'NEAR', day: 0, quantityKg: 600 }] });
    // NEAR demand 1200 over two sessions, 600 served → 600 kg short × ₹2
    expect(o.totals.shortfallPenalty).toBeCloseTo(1200, 6);
    expect(o.totals.demandKg).toBe(1200);
    expect(o.totals.fulfilment).toBeCloseTo(0.5, 6);
  });
});
