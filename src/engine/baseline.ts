import type { Batch, Destination, LaneOption, Plan, Scenario, Shipment } from './types';
import { EPS_KG, demandKey, evaluateOption, indexScenario, tierOffers } from './time';

/**
 * Baseline: "FEFO, best net price, ship as soon as possible".
 *
 * This is the rule a careful dispatcher with a spreadsheet follows:
 *
 *   Each dispatch day, take the batches at the hub in first-expired-first-out
 *   order. Send each one to the reachable market with the best net realisation
 *   (list price − handling − freight at a full truck) that still has unfilled
 *   list-price demand and where the lot will arrive fresh enough for list price.
 *   Open another truck only if the load put on it pays for that truck.
 *   Repeat until the batch, the demand or the trucks run out.
 *
 * It respects every hard constraint (stock, shelf life, demand, trucks), so any
 * difference from the optimiser is a difference in decision quality, not in
 * feasibility. It never looks ahead, never weighs one batch against another and
 * — in its plain form — never marks stock down.
 *
 * `clearance: true` adds the usual end-of-life rule: once a batch can no longer
 * reach any market at list price, offer what is left at the published markdown
 * tiers wherever the sale still beats the cost of letting it spoil.
 */
export interface BaselineOptions {
  clearance?: boolean;
}

export function baselinePlan(scenario: Scenario, opts: BaselineOptions = {}): Plan {
  const s = scenario;
  const ix = indexScenario(s);
  const cap = s.fleet.truckCapacityKg;
  const stock = new Map(s.batches.map((b) => [b.id, b.quantityKg]));
  const tierLeft = new Map<string, number[]>();
  const lanes = new Map<string, { load: number; trucks: number }>();
  const shipments: Shipment[] = [];
  const horizonEnd = 24 * s.horizonDays;

  /** Unfilled demand per price tier for the session an option lands in. */
  const left = (o: LaneOption, commodityId: string): number[] => {
    const key = demandKey(o.destId, commodityId, o.session);
    let arr = tierLeft.get(key);
    if (!arr) {
      const row = ix.demand.get(key);
      arr = row
        ? tierOffers(s, ix.commodity.get(commodityId)!, ix.dest.get(o.destId)!, row).map((t) => t.capacityKg)
        : new Array<number>(s.discountTiers.length + 1).fill(0);
      tierLeft.set(key, arr);
    }
    return arr;
  };

  for (let day = 0; day < s.horizonDays; day++) {
    let fleetLeft = s.fleet.trucksPerDay[day] ?? 0;

    /** How much of `want` fits, opening new trucks only when the load on them covers their cost. */
    const fit = (dest: Destination, want: number, unitValue: number): number => {
      const lk = `${dest.id}|${day}`;
      const lane = lanes.get(lk) ?? { load: 0, trucks: 0 };
      const free = lane.trucks * cap - lane.load;
      let qty = Math.min(want, Math.max(0, free));
      let rest = want - qty;
      let trucks = lane.trucks;
      const laneMax = dest.maxTrucksPerDay ?? Infinity;
      let fleet = fleetLeft;
      while (rest > EPS_KG && fleet > 0 && trucks < laneMax) {
        const onTruck = Math.min(cap, rest);
        if (onTruck * unitValue < dest.costPerTruck) break;
        qty += onTruck;
        rest -= onTruck;
        trucks++;
        fleet--;
      }
      return qty;
    };

    const commit = (batch: Batch, dest: Destination, qty: number, o: LaneOption, tier: number) => {
      const lk = `${dest.id}|${day}`;
      const lane = lanes.get(lk) ?? { load: 0, trucks: 0 };
      lane.load += qty;
      const need = Math.max(1, Math.ceil((lane.load - EPS_KG) / cap));
      fleetLeft -= need - lane.trucks;
      lane.trucks = need;
      lanes.set(lk, lane);
      stock.set(batch.id, stock.get(batch.id)! - qty);
      left(o, batch.commodityId)[tier] -= qty;
      const existing = shipments.find((x) => x.batchId === batch.id && x.destId === dest.id && x.day === day);
      if (existing) existing.quantityKg += qty;
      else shipments.push({ batchId: batch.id, destId: dest.id, day, quantityKg: qty });
    };

    const queue = s.batches
      .filter((b) => b.availableFromDay <= day)
      .sort((a, b) => a.remainingShelfLifeHours - b.remainingShelfLifeHours || a.id.localeCompare(b.id));

    /* pass 1 — list price, FEFO */
    for (const batch of queue) {
      const c = ix.commodity.get(batch.commodityId)!;
      const tried = new Set<string>();
      while (stock.get(batch.id)! > EPS_KG) {
        const candidates = s.destinations
          .filter((d) => !tried.has(d.id))
          .map((d) => ({ d, o: evaluateOption(ix, batch, d, day) }))
          .filter(({ o }) => o.feasible && o.grade === 'A' && o.tiers.some((t) => t.tier === 0))
          .map(({ d, o }) => ({
            d,
            o,
            price: o.tiers.find((t) => t.tier === 0)!.pricePerKg,
          }))
          .filter(({ o }) => left(o, batch.commodityId)[0] > EPS_KG)
          .sort(
            (a, b) =>
              b.price - b.d.costPerKg - b.d.costPerTruck / cap - (a.price - a.d.costPerKg - a.d.costPerTruck / cap) ||
              a.d.id.localeCompare(b.d.id),
          );
        if (candidates.length === 0) break;
        const best = candidates[0];
        const want = Math.min(stock.get(batch.id)!, left(best.o, batch.commodityId)[0]);
        const qty = fit(best.d, want, best.price - c.handlingCostPerKg - best.d.costPerKg);
        if (qty > EPS_KG) commit(batch, best.d, qty, best.o, 0);
        if (qty < want - EPS_KG) tried.add(best.d.id);
      }
    }

    /* pass 2 — clearance markdown for stock that can no longer make list price */
    if (!opts.clearance) continue;
    for (const batch of queue) {
      if (stock.get(batch.id)! <= EPS_KG) continue;
      const c = ix.commodity.get(batch.commodityId)!;
      if (batch.remainingShelfLifeHours - horizonEnd >= c.minSaleLifeHours) continue; // will be carried, not spoiled
      let listPriceLater = false;
      for (let later = day + 1; later < s.horizonDays && !listPriceLater; later++) {
        listPriceLater = s.destinations.some((d) => {
          const o = evaluateOption(ix, batch, d, later);
          return o.feasible && o.grade === 'A';
        });
      }
      if (listPriceLater) continue;
      const tried = new Set<string>();
      while (stock.get(batch.id)! > EPS_KG) {
        const offers = s.destinations
          .map((d) => ({ d, o: evaluateOption(ix, batch, d, day) }))
          .filter(({ o }) => o.feasible)
          .flatMap(({ d, o }) =>
            o.tiers
              .filter((t) => t.tier >= 1 && !tried.has(`${d.id}|${t.tier}`))
              .map((t) => ({ d, o, t, net: t.pricePerKg - c.handlingCostPerKg - d.costPerKg - d.costPerTruck / cap })),
          )
          .filter(({ o, t, net }) => left(o, batch.commodityId)[t.tier] > EPS_KG && net > -c.spoilageCostPerKg)
          .sort((a, b) => b.net - a.net || a.d.id.localeCompare(b.d.id));
        if (offers.length === 0) break;
        const best = offers[0];
        const want = Math.min(stock.get(batch.id)!, left(best.o, batch.commodityId)[best.t.tier]);
        // A clearance load "pays" for a truck if selling beats spoiling by at least the truck cost.
        const qty = fit(best.d, want, best.t.pricePerKg - c.handlingCostPerKg - best.d.costPerKg + c.spoilageCostPerKg);
        if (qty > EPS_KG) commit(batch, best.d, qty, best.o, best.t.tier);
        if (qty < want - EPS_KG) tried.add(`${best.d.id}|${best.t.tier}`);
      }
    }
  }

  return {
    label: opts.clearance ? 'Baseline · FEFO + clearance' : 'Baseline · FEFO',
    method: opts.clearance ? 'baseline-fefo-clearance' : 'baseline-fefo',
    shipments: shipments
      .filter((x) => x.quantityKg > EPS_KG)
      .map((x) => ({ ...x, quantityKg: Math.round(x.quantityKg * 1000) / 1000 })),
  };
}
