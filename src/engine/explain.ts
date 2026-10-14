import type { Batch, Commodity, Grade, InfeasibleCode, LaneOption, Scenario, SettlementLine } from './types';
import type { OptimizeResult, OptionRecord } from './optimize';
import { clock, evaluateOption, indexScenario } from './time';
import { kg, perKg, rupees } from './fmt';

/**
 * Receipts: evidence-based explanations generated from the option table, the
 * ledger and the LP sensitivity (duals with truck counts fixed). Every number
 * in a sentence is computed here from scenario data or solver output — nothing
 * is templated without a measured value behind it.
 */

export type Urgency = 'now' | 'soon' | 'flexible' | 'stranded';

export interface AlternativeRow {
  destId: string;
  status: 'chosen' | 'feasible' | 'infeasible' | 'banned';
  day: number | null;
  session: number | null;
  lifeAtSaleHours: number | null;
  grade: Grade | null;
  /** Best list/markdown price this lot could get there. */
  pricePerKg: number | null;
  /** Price − handling − freight at a full truck. */
  unitNet: number | null;
  plannedKg: number;
  /** ₹/kg the plan would lose per kg diverted here (LP reduced cost, trucks fixed). */
  lossPerKg: number | null;
  code?: InfeasibleCode;
  reason: string;
}

export interface BatchBrief {
  batch: Batch;
  commodity: Commodity;
  firstDay: number;
  lastListPriceDay: number | null;
  lastSaleDay: number | null;
  urgency: Urgency;
  priority: number;
  marginalValue: number | null;
  shippedKg: number;
  listKg: number;
  markdownKg: number;
  salvageKg: number;
  wastedKg: number;
  leftoverKg: number;
  leftoverClass: 'none' | 'spoiled' | 'carried';
  headline: string;
  timing: string;
  alternatives: AlternativeRow[];
}

export interface DiscountAdvice {
  batchId: string;
  destId: string;
  day: number;
  session: number;
  tier: number;
  discount: number;
  quantityKg: number;
  listPrice: number;
  pricePerKg: number;
  trigger: 'near_expiry' | 'oversupply';
  netPerKg: number;
  spoilageCostPerKg: number;
  /** Net per kg vs. letting the kg spoil. */
  advantagePerKg: number;
  reason: string;
}

export interface Explanation {
  briefs: Map<string, BatchBrief>;
  discounts: DiscountAdvice[];
  /** Batch ids ordered by dispatch priority. */
  priorityOrder: string[];
}

const codeText = (
  code: InfeasibleCode | undefined,
  o: LaneOption,
  c: Commodity,
  destShort: string,
  ix: ReturnType<typeof indexScenario>,
): string => {
  switch (code) {
    case 'not_available':
      return `Not at the hub until D${ix.batch.get(o.batchId)!.availableFromDay}.`;
    case 'lane_closed':
      return `Lane to ${destShort} is closed on D${o.day}.`;
    case 'no_fleet':
      return `No trucks available on D${o.day}.`;
    case 'no_market':
      return ix.scenario.demand.some((r) => r.destId === o.destId && r.commodityId === c.id)
        ? `Would reach ${destShort} for the D${o.session} session, which has no ${c.name.toLowerCase()} order in this horizon.`
        : `${destShort} does not buy ${c.name.toLowerCase()}.`;
    case 'shelf_life':
      if (o.lifeAtSaleHours >= o.minSaleLifeHours)
        return `Arrives with ${Math.round(o.lifeAtSaleHours)} h of life — below ${destShort}'s ${o.fullPriceLifeHours} h list-price standard, and ${destShort} takes no markdown stock.`;
      return `Would reach the ${clock(o.saleHour)} session with ${Math.max(0, Math.round(o.lifeAtSaleHours))} h of shelf life; ${destShort} needs at least ${o.minSaleLifeHours} h.`;
    case 'committed_past':
      return `Dispatch day already passed.`;
    default:
      return '';
  }
};

export function explain(scenario: Scenario, result: OptimizeResult): Explanation {
  const ix = indexScenario(scenario);
  const cap = scenario.fleet.truckCapacityKg;
  const outcome = result.outcome;
  const asOf = result.asOfDay;
  const duals = result.duals;

  const linesByBatch = new Map<string, SettlementLine[]>();
  for (const l of outcome.lines) {
    if (!linesByBatch.has(l.batchId)) linesByBatch.set(l.batchId, []);
    linesByBatch.get(l.batchId)!.push(l);
  }
  const recsByBatch = new Map<string, OptionRecord[]>();
  for (const r of result.options) {
    if (r.committed) continue;
    if (!recsByBatch.has(r.option.batchId)) recsByBatch.set(r.option.batchId, []);
    recsByBatch.get(r.option.batchId)!.push(r);
  }

  const briefs = new Map<string, BatchBrief>();
  for (const batch of scenario.batches) {
    const c = ix.commodity.get(batch.commodityId)!;
    const recs = recsByBatch.get(batch.id) ?? [];
    const firstDay = Math.max(batch.availableFromDay, asOf);
    const feasibleRecs = recs.filter((r) => r.option.feasible && r.option.day >= firstDay);
    // "List price" means a customer paying list; a salvage outlet accepting the lot does not count.
    const lastListPriceDay = maxOrNull(
      feasibleRecs.filter((r) => r.option.grade === 'A' && !ix.dest.get(r.option.destId)?.salvageOutlet).map((r) => r.option.day),
    );
    const lastSaleDay = maxOrNull(feasibleRecs.map((r) => r.option.day));
    const urgency: Urgency =
      lastSaleDay === null
        ? 'stranded'
        : lastSaleDay <= firstDay || (lastListPriceDay !== null && lastListPriceDay <= firstDay)
          ? 'now'
          : lastSaleDay <= firstDay + 1 || lastListPriceDay === null || lastListPriceDay <= firstDay + 1
            ? 'soon'
            : 'flexible';

    const lines = linesByBatch.get(batch.id) ?? [];
    const br = outcome.batches.find((b) => b.batchId === batch.id)!;
    let listKg = 0;
    let markdownKg = 0;
    let salvageKg = 0;
    for (const l of lines) {
      const salvage = ix.dest.get(l.destId)?.salvageOutlet;
      for (const sale of l.sales) {
        if (salvage) salvageKg += sale.quantityKg;
        else if (sale.tier === 0) listKg += sale.quantityKg;
        else markdownKg += sale.quantityKg;
      }
    }

    /* alternatives, one row per destination */
    const alternatives: AlternativeRow[] = scenario.destinations.map((d) => {
      const mine = recs.filter((r) => r.option.destId === d.id && r.option.day >= firstDay);
      const planned = mine.filter((r) => r.plannedKg > 0);
      const plannedKg = lines.filter((l) => l.destId === d.id).reduce((a, l) => a + l.shippedKg, 0);
      const unitNetOf = (r: OptionRecord, k: number) =>
        r.option.tiers[k].pricePerKg - c.handlingCostPerKg - d.costPerKg - d.costPerTruck / cap;
      if (planned.length > 0 || plannedKg > 0) {
        const r = planned[0] ?? mine.find((x) => x.option.feasible);
        const best = r ? bestTier(r) : 0;
        const days = [...new Set(lines.filter((l) => l.destId === d.id).map((l) => `D${l.day}`))].join(', ');
        return {
          destId: d.id,
          status: 'chosen',
          day: r?.option.day ?? null,
          session: r?.option.session ?? null,
          lifeAtSaleHours: r?.option.lifeAtSaleHours ?? null,
          grade: r?.option.grade ?? null,
          pricePerKg: r ? r.option.tiers[best].pricePerKg : null,
          unitNet: r ? unitNetOf(r, best) : null,
          plannedKg,
          lossPerKg: 0,
          reason: `In the plan: ${kg(plannedKg)} dispatched ${days}.`,
        };
      }
      const banned = mine.filter((r) => r.banned);
      const feasible = mine.filter((r) => r.option.feasible && !r.banned);
      if (feasible.length > 0) {
        // Least-bad option for this destination according to the LP reduced costs.
        let pick = feasible[0];
        let pickK = 0;
        let pickRc = -Infinity;
        for (const r of feasible) {
          r.option.tiers.forEach((_, k) => {
            const rc = r.reducedCost[k] ?? r.unitMargin[k] - (duals?.stock.get(batch.id) ?? 0);
            const truck = result.trucks.get(`${d.id}|${r.option.day}`) ?? 0;
            const adj = truck > 0 ? rc : rc - 1e6; // prefer lane-days that already have a truck
            if (adj > pickRc) {
              pickRc = adj;
              pick = r;
              pickK = k;
            }
          });
        }
        const o = pick.option;
        const trucksThere = result.trucks.get(`${d.id}|${o.day}`) ?? 0;
        const tier = o.tiers[pickK];
        const pi = duals?.stock.get(batch.id) ?? null;
        const rc = pick.reducedCost[pickK];
        const dKey = `${d.id}|${c.id}|${o.session}|${tier.tier}`;
        const mu = duals?.demand.get(dKey) ?? 0;
        const lam = duals?.laneCapacity.get(`${d.id}|${o.day}`) ?? 0;
        let reason: string;
        const price = `${tier.tier === 0 ? 'list' : `−${Math.round(tier.discount * 100)}%`} ${perKg(tier.pricePerKg)}`;
        if (trucksThere === 0) {
          const loadWorth = Math.max(0, pick.unitMargin[pickK]);
          reason = `No truck runs to ${d.short} on D${o.day} in this plan. Opening one costs ${rupees(d.costPerTruck)}; at ${price} this lot nets ${perKg(loadWorth)} before that truck, and the fleet is better used elsewhere.`;
        } else if (rc !== null && rc !== undefined && mu > 0.05 && mu >= lam) {
          reason = `D${o.session} ${c.name.toLowerCase()} demand at ${d.short} (${price}) is already filled by lots that earn more there; displacing them costs ${perKg(mu)}.`;
        } else if (rc !== null && rc !== undefined && lam > 0.05) {
          reason = `The truck to ${d.short} on D${o.day} is full; a kg of space there is worth ${perKg(lam)} to the cargo already on it.`;
        } else if (pi !== null) {
          reason = `Nets ${perKg(pick.unitMargin[pickK])} here at ${price}, versus ${perKg(pi)} for this batch at the margin where it goes now.`;
        } else {
          reason = `Feasible at ${price}, but a better use exists.`;
        }
        const loss = rc !== null && rc !== undefined ? Math.max(0, -rc) : null;
        if (loss !== null && trucksThere > 0) reason += ` Diverting 1 kg here loses ≈ ${perKg(loss)}.`;
        return {
          destId: d.id,
          status: 'feasible',
          day: o.day,
          session: o.session,
          lifeAtSaleHours: o.lifeAtSaleHours,
          grade: o.grade ?? null,
          pricePerKg: tier.pricePerKg,
          unitNet: unitNetOf(pick, pickK),
          plannedKg: 0,
          lossPerKg: trucksThere > 0 ? loss : null,
          reason,
        };
      }
      if (banned.length > 0) {
        return {
          destId: d.id,
          status: 'banned',
          day: banned[0].option.day,
          session: banned[0].option.session,
          lifeAtSaleHours: banned[0].option.lifeAtSaleHours,
          grade: banned[0].option.grade ?? null,
          pricePerKg: null,
          unitNet: null,
          plannedKg: 0,
          lossPerKg: null,
          reason: 'Blocked by an operator override.',
        };
      }
      // Infeasible: explain using the earliest dispatchable day (best chance on shelf life).
      const candidates = mine.length ? mine : recs.filter((r) => r.option.destId === d.id);
      const pref: InfeasibleCode[] = ['shelf_life', 'no_market', 'lane_closed', 'no_fleet', 'not_available', 'committed_past'];
      const first =
        candidates.find((r) => r.option.day === firstDay && r.option.code !== 'no_market') ??
        [...candidates].sort((a, b) => pref.indexOf(a.option.code!) - pref.indexOf(b.option.code!) || a.option.day - b.option.day)[0];
      const o = first?.option ?? evaluateOption(ix, batch, d, Math.min(firstDay, scenario.horizonDays - 1));
      return {
        destId: d.id,
        status: 'infeasible',
        day: o.day,
        session: o.session,
        lifeAtSaleHours: o.lifeAtSaleHours,
        grade: null,
        pricePerKg: null,
        unitNet: null,
        plannedKg: 0,
        lossPerKg: null,
        code: o.code,
        reason: firstDay >= scenario.horizonDays ? 'Arrives after the planning horizon.' : codeText(o.code, o, c, d.short, ix),
      };
    });

    /* headline */
    const parts: string[] = [];
    if (listKg > 0.5) parts.push(`${kg(listKg)} at list price`);
    if (markdownKg > 0.5) parts.push(`${kg(markdownKg)} marked down`);
    if (salvageKg > 0.5) parts.push(`${kg(salvageKg)} to the processor`);
    if (br.wastedAtDestKg > 0.5) parts.push(`${kg(br.wastedAtDestKg)} lost at destination`);
    if (br.leftoverClass === 'carried') parts.push(`${kg(br.leftoverKg)} held as carry-over stock`);
    if (br.leftoverClass === 'spoiled') parts.push(`${kg(br.leftoverKg)} written off at the hub`);
    let headline = parts.length ? cap1(parts.join(', ')) + '.' : 'Nothing planned.';
    if (urgency === 'stranded') {
      headline = `Cannot reach any buyer within its shelf life — ${kg(batch.quantityKg)} is a write-off under every plan.`;
    } else if (br.leftoverClass === 'spoiled' && br.leftoverKg > 0.5) {
      const bestNet = maxOrNull(
        feasibleRecs.flatMap((r) => r.option.tiers.map((_, k) => r.unitMargin[k] - ix.dest.get(r.option.destId)!.costPerTruck / cap)),
      );
      headline += ` Every remaining outlet is full${
        bestNet !== null ? `, or would lose more than the ${perKg(c.spoilageCostPerKg)} it costs to write it off` : ''
      }.`;
    }

    /* timing */
    let timing: string;
    const firstLine = [...lines].sort((a, b) => a.day - b.day)[0];
    if (urgency === 'stranded') timing = 'No dispatch day reaches a buyer in time.';
    else if (!firstLine) timing = `Could leave from D${firstDay}${lastSaleDay !== null ? ` until D${lastSaleDay}` : ''}, but no shipment is worth its cost.`;
    else {
      const t = firstLine.day;
      const d = ix.dest.get(firstLine.destId)!;
      const later = t + 1 < scenario.horizonDays ? evaluateOption(ix, batch, d, t + 1) : null;
      const waitNote = !later
        ? 'D' + t + ' is the last dispatch day of the horizon.'
        : !later.feasible && later.code === 'shelf_life'
          ? `A day later it could no longer be sold in ${d.short} (${Math.max(0, Math.round(later.lifeAtSaleHours))} h left at the D${later.session} session).`
          : later.feasible && later.grade === 'B' && firstLine.grade === 'A'
            ? `A day later it would only sell in ${d.short} at a markdown (${Math.round(later.lifeAtSaleHours)} h < ${later.fullPriceLifeHours} h list-price standard).`
            : `It could still wait a day for ${d.short}; it goes now because ${t === firstDay ? 'there is demand and truck space for it today' : 'earlier trucks were taken by lots with less slack'}.`;
      timing = `${t > firstDay ? `Held at the hub until D${t}. ` : `Leaves on the first possible wave (D${t}). `}${waitNote}`;
    }

    briefs.set(batch.id, {
      batch,
      commodity: c,
      firstDay,
      lastListPriceDay,
      lastSaleDay,
      urgency,
      priority: 0,
      marginalValue: duals?.stock.get(batch.id) ?? null,
      shippedKg: br.shippedKg,
      listKg,
      markdownKg,
      salvageKg,
      wastedKg: br.wastedAtDestKg,
      leftoverKg: br.leftoverKg,
      leftoverClass: br.leftoverClass,
      headline,
      timing,
      alternatives,
    });
  }

  const urgencyRank: Record<Urgency, number> = { now: 0, soon: 1, flexible: 2, stranded: 3 };
  const priorityOrder = [...briefs.values()]
    .sort(
      (a, b) =>
        urgencyRank[a.urgency] - urgencyRank[b.urgency] ||
        (a.lastListPriceDay ?? a.lastSaleDay ?? 99) - (b.lastListPriceDay ?? b.lastSaleDay ?? 99) ||
        a.batch.remainingShelfLifeHours - b.batch.remainingShelfLifeHours ||
        a.batch.id.localeCompare(b.batch.id),
    )
    .map((b) => b.batch.id);
  priorityOrder.forEach((id, i) => (briefs.get(id)!.priority = i + 1));

  /* discounts */
  const discounts: DiscountAdvice[] = [];
  for (const l of outcome.lines) {
    const d = ix.dest.get(l.destId)!;
    if (d.salvageOutlet) continue;
    const c = ix.commodity.get(l.commodityId)!;
    const freightPerKg = l.shippedKg > 0 ? l.transportCost / l.shippedKg : 0;
    for (const sale of l.sales) {
      if (sale.tier === 0) continue;
      const listPrice = sale.pricePerKg / (1 - sale.discount);
      const netPerKg = sale.pricePerKg - c.handlingCostPerKg - freightPerKg;
      const trigger: DiscountAdvice['trigger'] = l.grade === 'B' ? 'near_expiry' : 'oversupply';
      const why =
        trigger === 'near_expiry'
          ? `Reaches ${d.short} with ${Math.round(l.lifeAtSaleHours)} h of shelf life, short of the ${
              evaluateOption(ix, ix.batch.get(l.batchId)!, d, l.day).fullPriceLifeHours
            } h buyers need to pay list price.`
          : `List-price demand for ${c.name.toLowerCase()} at ${d.short} in the D${l.session} session is fully served; this kg only sells to price-sensitive buyers.`;
      discounts.push({
        batchId: l.batchId,
        destId: l.destId,
        day: l.day,
        session: l.session,
        tier: sale.tier,
        discount: sale.discount,
        quantityKg: sale.quantityKg,
        listPrice,
        pricePerKg: sale.pricePerKg,
        trigger,
        netPerKg,
        spoilageCostPerKg: c.spoilageCostPerKg,
        advantagePerKg: netPerKg + c.spoilageCostPerKg,
        reason: `${why} At −${Math.round(sale.discount * 100)}% (${perKg(sale.pricePerKg)}) it nets ${perKg(netPerKg)} after handling and freight, against ${perKg(-c.spoilageCostPerKg)} if it spoils — ${perKg(netPerKg + c.spoilageCostPerKg)} better. Markdown demand assumes elasticity ${c.elasticity} and ${d.short}'s appetite factor ${d.markdownAppetite}.`,
      });
    }
  }
  discounts.sort((a, b) => a.day - b.day || b.quantityKg - a.quantityKg);

  return { briefs, discounts, priorityOrder };
}

function bestTier(r: OptionRecord): number {
  let best = 0;
  r.tierKg.forEach((q, k) => {
    if (q > r.tierKg[best]) best = k;
  });
  return best;
}

function maxOrNull(xs: number[]): number | null {
  return xs.length ? Math.max(...xs) : null;
}

function cap1(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
