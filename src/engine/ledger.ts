import type {
  BatchResult,
  DemandResult,
  Outcome,
  Plan,
  Scenario,
  SettlementLine,
  Totals,
  TruckLoad,
  Violation,
} from './types';
import {
  EPS_KG,
  ScenarioIndex,
  demandKey,
  evaluateOption,
  indexScenario,
  isLaneOpen,
  tierOffers,
} from './time';

/**
 * The ledger: the one and only place where a plan is turned into money and kg.
 *
 * `settle` physically executes a dispatch plan against a scenario and books the
 * result. It is deliberately independent of how the plan was produced, so the
 * baseline, the optimiser, an operator override and a stale plan under a
 * disruption are all measured with exactly the same rules:
 *
 *  1. Dispatch. Day by day, shipments leave the hub in plan order. A shipment
 *     is trimmed or cancelled (and a violation recorded) if the batch is not at
 *     the hub yet, stock is exhausted, the lane is closed, or trucks run out.
 *     Trucks per lane-day = ceil(load / capacity).
 *  2. Arrival. Each load reaches the first market session that opens after it
 *     is ready. Remaining shelf life at that moment grades the lot:
 *     A (full price possible), B (markdown only) or rejected.
 *  3. Sale. Within one destination × commodity × session, grade-A lots fill
 *     list-price demand, freshest first. What is left over, plus grade-B lots,
 *     fills the markdown tiers in order of price. Anything beyond that is
 *     written off at the destination. There is no storage at destinations.
 *  4. Hub leftovers are either still viable after the horizon ("carried",
 *     valued at carryValuePerKg) or spoiled.
 *
 * Net = revenue − transport − handling − spoilage cost − shortfall penalty + carry value.
 * Revenue is booked only for kg actually sold, at the price actually realised.
 */
export function settle(scenario: Scenario, plan: Plan, ix: ScenarioIndex = indexScenario(scenario)): Outcome {
  const s = scenario;
  const violations: Violation[] = [];
  const stock = new Map<string, number>(s.batches.map((b) => [b.id, b.quantityKg]));
  const lines: SettlementLine[] = [];
  const trucks: TruckLoad[] = [];
  const cap = s.fleet.truckCapacityKg;

  /* ── 1. dispatch ─────────────────────────────────────────────── */
  const byDay = new Map<number, typeof plan.shipments>();
  for (const sh of plan.shipments) {
    if (!(sh.quantityKg > EPS_KG)) continue;
    if (!Number.isInteger(sh.day) || sh.day < 0 || sh.day >= s.horizonDays) {
      violations.push({
        code: 'unknown_ref',
        message: `Shipment of ${sh.batchId} uses dispatch day ${sh.day}, outside the ${s.horizonDays}-day horizon.`,
        batchId: sh.batchId,
        destId: sh.destId,
        day: sh.day,
        quantityKg: sh.quantityKg,
      });
      continue;
    }
    if (!byDay.has(sh.day)) byDay.set(sh.day, []);
    byDay.get(sh.day)!.push(sh);
  }

  for (let day = 0; day < s.horizonDays; day++) {
    const todays = byDay.get(day) ?? [];
    let fleetLeft = s.fleet.trucksPerDay[day] ?? 0;
    const destOrder: string[] = [];
    const byDest = new Map<string, typeof todays>();
    for (const sh of todays) {
      if (!byDest.has(sh.destId)) {
        byDest.set(sh.destId, []);
        destOrder.push(sh.destId);
      }
      byDest.get(sh.destId)!.push(sh);
    }

    for (const destId of destOrder) {
      const dest = ix.dest.get(destId);
      const group = byDest.get(destId)!;
      if (!dest) {
        for (const sh of group)
          violations.push({
            code: 'unknown_ref',
            message: `Unknown destination "${destId}".`,
            batchId: sh.batchId,
            destId,
            day,
            quantityKg: sh.quantityKg,
          });
        continue;
      }
      if (!isLaneOpen(s, dest, day)) {
        for (const sh of group)
          violations.push({
            code: 'lane_closed',
            message: `Lane to ${dest.short} is closed on D${day}; ${fmtKg(sh.quantityKg)} of ${sh.batchId} stays at the hub.`,
            batchId: sh.batchId,
            destId,
            day,
            quantityKg: sh.quantityKg,
          });
        continue;
      }

      // Stock and availability checks.
      const accepted: { batchId: string; requested: number; qty: number }[] = [];
      for (const sh of group) {
        const batch = ix.batch.get(sh.batchId);
        if (!batch) {
          violations.push({
            code: 'unknown_ref',
            message: `Unknown batch "${sh.batchId}".`,
            batchId: sh.batchId,
            destId,
            day,
            quantityKg: sh.quantityKg,
          });
          continue;
        }
        if (batch.availableFromDay > day) {
          violations.push({
            code: 'not_available',
            message: `${batch.id} only reaches the hub on D${batch.availableFromDay}; it cannot leave on D${day}.`,
            batchId: batch.id,
            destId,
            day,
            quantityKg: sh.quantityKg,
          });
          continue;
        }
        const have = stock.get(batch.id)!;
        let qty = sh.quantityKg;
        if (qty > have + EPS_KG) {
          violations.push({
            code: 'stock',
            message: `${batch.id}: plan dispatches ${fmtKg(qty)} but only ${fmtKg(have)} is left.`,
            batchId: batch.id,
            destId,
            day,
            quantityKg: qty - have,
          });
          qty = have;
        }
        qty = Math.min(qty, have);
        if (qty > EPS_KG) {
          accepted.push({ batchId: batch.id, requested: sh.quantityKg, qty });
          stock.set(batch.id, have - qty);
        }
      }

      // Truck capacity: lane cap and fleet remaining.
      const maxTrucks = Math.min(fleetLeft, dest.maxTrucksPerDay ?? Infinity);
      const maxKg = maxTrucks * cap;
      let load = accepted.reduce((a, x) => a + x.qty, 0);
      if (load > maxKg + EPS_KG) {
        let excess = load - maxKg;
        for (let i = accepted.length - 1; i >= 0 && excess > EPS_KG; i--) {
          const cut = Math.min(excess, accepted[i].qty);
          accepted[i].qty -= cut;
          excess -= cut;
          stock.set(accepted[i].batchId, stock.get(accepted[i].batchId)! + cut);
          violations.push({
            code: 'capacity',
            message: `No truck space to ${dest.short} on D${day}: ${fmtKg(cut)} of ${accepted[i].batchId} stays at the hub.`,
            batchId: accepted[i].batchId,
            destId,
            day,
            quantityKg: cut,
          });
        }
        load = accepted.reduce((a, x) => a + x.qty, 0);
      }
      if (load <= EPS_KG) continue;

      const n = Math.max(1, Math.ceil((load - EPS_KG) / cap));
      fleetLeft -= n;
      const truckCost = n * dest.costPerTruck;
      trucks.push({ destId, day, trucks: n, loadKg: load, capacityKg: n * cap, cost: truckCost + load * dest.costPerKg });

      for (const a of accepted) {
        if (a.qty <= EPS_KG) continue;
        const batch = ix.batch.get(a.batchId)!;
        const c = ix.commodity.get(batch.commodityId)!;
        // Physical arrival facts are independent of availability/lane checks.
        const opt = evaluateOption(ix, batch, dest, day);
        lines.push({
          batchId: batch.id,
          commodityId: batch.commodityId,
          destId,
          day,
          requestedKg: a.requested,
          shippedKg: a.qty,
          departHour: opt.departHour,
          readyHour: opt.readyHour,
          session: opt.session,
          saleHour: opt.saleHour,
          lifeAtSaleHours: opt.lifeAtSaleHours,
          grade:
            opt.lifeAtSaleHours < opt.minSaleLifeHours
              ? 'rejected'
              : opt.lifeAtSaleHours >= opt.fullPriceLifeHours
                ? 'A'
                : 'B',
          sales: [],
          soldKg: 0,
          wastedKg: 0,
          revenue: 0,
          listValue: 0,
          handlingCost: a.qty * c.handlingCostPerKg,
          transportCost: a.qty * dest.costPerKg + truckCost * (a.qty / load),
        });
      }
    }
  }

  /* ── 2 + 3. arrival and sale ─────────────────────────────────── */
  const groups = new Map<string, SettlementLine[]>();
  for (const line of lines) {
    const key = demandKey(line.destId, line.commodityId, line.session);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(line);
  }

  const demandResults = new Map<string, DemandResult>();
  for (const row of s.demand) {
    demandResults.set(demandKey(row.destId, row.commodityId, row.session), {
      destId: row.destId,
      commodityId: row.commodityId,
      session: row.session,
      demandKg: row.quantityKg,
      pricePerKg: row.pricePerKg,
      fullPriceSoldKg: 0,
      markdownSoldKg: 0,
      shortfallKg: row.quantityKg,
    });
  }

  for (const [key, group] of groups) {
    const row = ix.demand.get(key);
    const dest = ix.dest.get(group[0].destId)!;
    const c = ix.commodity.get(group[0].commodityId)!;
    if (!row || row.quantityKg <= 0) {
      for (const line of group) {
        line.wastedKg = line.shippedKg;
        line.note = `No buyer for ${c.name} at ${dest.short} in session D${line.session}.`;
        violations.push({
          code: 'no_market',
          message: `${line.batchId} → ${dest.short} (D${line.day}): no ${c.name} demand in session D${line.session}; ${fmtKg(line.shippedKg)} written off.`,
          batchId: line.batchId,
          destId: line.destId,
          day: line.day,
          quantityKg: line.shippedKg,
        });
      }
      continue;
    }
    const offers = tierOffers(s, c, dest, row);
    const left = offers.map((o) => o.capacityKg);
    const freshestFirst = (a: SettlementLine, b: SettlementLine) =>
      b.lifeAtSaleHours - a.lifeAtSaleHours || a.batchId.localeCompare(b.batchId) || a.day - b.day;
    const remaining = new Map<SettlementLine, number>(group.map((l) => [l, l.shippedKg]));

    const sell = (line: SettlementLine, tier: number) => {
      const want = remaining.get(line)!;
      const qty = Math.min(want, left[tier]);
      if (qty <= EPS_KG) return;
      left[tier] -= qty;
      remaining.set(line, want - qty);
      const offer = offers[tier];
      line.sales.push({ tier, discount: offer.discount, quantityKg: qty, pricePerKg: offer.pricePerKg });
      line.soldKg += qty;
      line.revenue += qty * offer.pricePerKg;
      line.listValue += qty * row.pricePerKg;
    };

    const gradeA = group.filter((l) => l.grade === 'A').sort(freshestFirst);
    for (const line of gradeA) sell(line, 0);
    const saleable = group.filter((l) => l.grade !== 'rejected').sort(freshestFirst);
    for (let tier = 1; tier < offers.length; tier++) for (const line of saleable) sell(line, tier);

    for (const line of group) {
      const rest = remaining.get(line)!;
      if (rest <= EPS_KG) continue;
      line.wastedKg = rest;
      const markdownCap = offers.slice(1).reduce((a, o) => a + o.capacityKg, 0);
      if (line.grade === 'B' && markdownCap <= EPS_KG) {
        line.note = `Too little shelf life for list price (${line.lifeAtSaleHours.toFixed(0)} h) and this buyer takes no markdown stock.`;
        violations.push({
          code: 'shelf_life',
          message: `${line.batchId} → ${dest.short} (D${line.day}) arrives with ${line.lifeAtSaleHours.toFixed(0)} h of shelf life: below this buyer's list-price standard, and the buyer takes no markdown stock; ${fmtKg(rest)} written off.`,
          batchId: line.batchId,
          destId: line.destId,
          day: line.day,
          quantityKg: rest,
        });
      } else if (line.grade === 'rejected') {
        line.note = `Rejected on arrival: ${line.lifeAtSaleHours.toFixed(0)} h of shelf life left when the D${line.session} session opens.`;
        violations.push({
          code: 'shelf_life',
          message: `${line.batchId} → ${dest.short} (D${line.day}) arrives with ${line.lifeAtSaleHours.toFixed(0)} h of shelf life, below the buyer's minimum; ${fmtKg(rest)} written off.`,
          batchId: line.batchId,
          destId: line.destId,
          day: line.day,
          quantityKg: rest,
        });
      } else {
        line.note = `Market saturated: ${fmtKg(rest)} found no buyer at any price tier.`;
        violations.push({
          code: 'oversupply',
          message: `${line.batchId} → ${dest.short} (D${line.day}) exceeds what the D${line.session} session can absorb; ${fmtKg(rest)} written off.`,
          batchId: line.batchId,
          destId: line.destId,
          day: line.day,
          quantityKg: rest,
        });
      }
    }

    const dr = demandResults.get(key)!;
    dr.fullPriceSoldKg = offers[0].capacityKg - left[0];
    dr.markdownSoldKg = offers.slice(1).reduce((a, o, i) => a + (o.capacityKg - left[i + 1]), 0);
    dr.shortfallKg = Math.max(0, row.quantityKg - dr.fullPriceSoldKg);
  }

  /* ── 4. hub leftovers and totals ─────────────────────────────── */
  const horizonEnd = 24 * s.horizonDays;
  const batches: BatchResult[] = s.batches.map((b) => {
    const c = ix.commodity.get(b.commodityId)!;
    const mine = lines.filter((l) => l.batchId === b.id);
    const leftover = Math.max(0, stock.get(b.id)!);
    const viableAfterHorizon = b.remainingShelfLifeHours - horizonEnd >= c.minSaleLifeHours;
    return {
      batchId: b.id,
      commodityId: b.commodityId,
      quantityKg: b.quantityKg,
      shippedKg: mine.reduce((a, l) => a + l.shippedKg, 0),
      soldKg: mine.reduce((a, l) => a + l.soldKg, 0),
      wastedAtDestKg: mine.reduce((a, l) => a + l.wastedKg, 0),
      leftoverKg: leftover,
      leftoverClass: leftover <= EPS_KG ? 'none' : viableAfterHorizon ? 'carried' : 'spoiled',
    };
  });

  const t: Totals = {
    inventoryKg: 0,
    demandKg: 0,
    shippedKg: 0,
    soldKg: 0,
    fullPriceSoldKg: 0,
    servedDemandKg: 0,
    salvageSoldKg: 0,
    markdownSoldKg: 0,
    spoiledAtHubKg: 0,
    spoiledAtDestKg: 0,
    spoiledKg: 0,
    carriedKg: 0,
    shortfallKg: 0,
    trucksUsed: 0,
    spoilageRate: 0,
    fulfilment: 0,
    minDestinationFill: 1,
    revenue: 0,
    listValue: 0,
    discountGiven: 0,
    transportCost: 0,
    handlingCost: 0,
    spoilageCost: 0,
    shortfallPenalty: 0,
    carryValue: 0,
    net: 0,
  };

  for (const br of batches) {
    const c = ix.commodity.get(br.commodityId)!;
    t.inventoryKg += br.quantityKg;
    t.shippedKg += br.shippedKg;
    t.spoiledAtDestKg += br.wastedAtDestKg;
    t.spoilageCost += br.wastedAtDestKg * c.spoilageCostPerKg;
    if (br.leftoverClass === 'spoiled') {
      t.spoiledAtHubKg += br.leftoverKg;
      t.spoilageCost += br.leftoverKg * c.spoilageCostPerKg;
    } else if (br.leftoverClass === 'carried') {
      t.carriedKg += br.leftoverKg;
      t.carryValue += br.leftoverKg * c.carryValuePerKg;
    }
  }
  for (const line of lines) {
    t.soldKg += line.soldKg;
    t.revenue += line.revenue;
    t.listValue += line.listValue;
    t.handlingCost += line.handlingCost;
    for (const sale of line.sales) {
      if (sale.tier === 0) t.fullPriceSoldKg += sale.quantityKg;
      else t.markdownSoldKg += sale.quantityKg;
    }
  }
  for (const tl of trucks) {
    t.transportCost += tl.cost;
    t.trucksUsed += tl.trucks;
  }
  const fillByDest = new Map<string, { d: number; f: number }>();
  for (const dr of demandResults.values()) {
    const dest = ix.dest.get(dr.destId);
    t.shortfallPenalty += dr.shortfallKg * (dest?.shortfallPenaltyPerKg ?? 0);
    if (dest?.salvageOutlet) {
      t.salvageSoldKg += dr.fullPriceSoldKg + dr.markdownSoldKg;
      continue;
    }
    t.demandKg += dr.demandKg;
    t.servedDemandKg += dr.fullPriceSoldKg;
    t.shortfallKg += dr.shortfallKg;
    const agg = fillByDest.get(dr.destId) ?? { d: 0, f: 0 };
    agg.d += dr.demandKg;
    agg.f += dr.fullPriceSoldKg;
    fillByDest.set(dr.destId, agg);
  }
  t.spoiledKg = t.spoiledAtHubKg + t.spoiledAtDestKg;
  t.discountGiven = t.listValue - t.revenue;
  t.spoilageRate = t.inventoryKg > 0 ? t.spoiledKg / t.inventoryKg : 0;
  t.fulfilment = t.demandKg > 0 ? t.servedDemandKg / t.demandKg : 0;
  const fills = [...fillByDest.values()].filter((x) => x.d > 0).map((x) => x.f / x.d);
  t.minDestinationFill = fills.length ? Math.min(...fills) : 0;
  t.net = t.revenue - t.transportCost - t.handlingCost - t.spoilageCost - t.shortfallPenalty + t.carryValue;

  return {
    lines,
    trucks,
    batches,
    demand: [...demandResults.values()],
    totals: t,
    violations,
    feasible: violations.length === 0,
  };
}

/* ── feasibility audit ─────────────────────────────────────────── */

export interface AuditCheck {
  id: string;
  label: string;
  detail: string;
  passed: boolean;
  count: number;
}

/** Groups ledger violations into the hard constraints of the model. */
export function audit(outcome: Outcome): AuditCheck[] {
  const count = (...codes: string[]) => outcome.violations.filter((v) => codes.includes(v.code)).length;
  const mk = (id: string, label: string, detail: string, n: number): AuditCheck => ({
    id,
    label,
    detail,
    passed: n === 0,
    count: n,
  });
  return [
    mk('stock', 'Stock availability', 'No batch dispatches more than it holds, or before it reaches the hub.', count('stock', 'not_available', 'unknown_ref')),
    mk('capacity', 'Transport capacity', 'Loads fit the trucks dispatched; trucks fit the daily fleet and lane limits.', count('capacity')),
    mk('lane', 'Lane availability', 'Nothing is dispatched on a closed lane.', count('lane_closed')),
    mk('shelf', 'Shelf-life allowance', "Every load reaches a market session with at least the buyer's minimum remaining life.", count('shelf_life')),
    mk('demand', 'Destination demand', 'No session receives more than it can absorb across list-price and markdown demand.', count('oversupply', 'no_market')),
  ];
}

function fmtKg(kg: number): string {
  return kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${kg.toFixed(0)} kg`;
}
