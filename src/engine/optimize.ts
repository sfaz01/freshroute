import type { LaneOption, Outcome, Pin, Plan, Scenario, Shipment } from './types';
import { EPS_KG, ScenarioIndex, demandKey, evaluateOption, indexScenario, tierOffers } from './time';
import { settle } from './ledger';
import type { LpSolver, SolveStatus } from './solver';

/**
 * FreshRoute decision model — a mixed-integer linear programme.
 *
 * Decision variables
 *   x[b,d,t,k] ≥ 0   kg of batch b dispatched to destination d on day t and sold in price tier k
 *   n[d,t] ∈ ℤ≥0     trucks dispatched to d on day t
 *   h[b] ≥ 0         kg of batch b never dispatched (carried forward if still viable, else spoiled)
 *   w[i] ≥ 0         kg of an already-dispatched load that can no longer be sold (replanning only)
 *
 * Hard constraints
 *   stock      Σ_{d,t,k} x[b,d,t,k] + h[b] = Q_b                       every batch
 *   demand     Σ_{b,t→session} x[b,d,t,k] ≤ cap[c,d,session,k]         every commodity × destination × session × tier
 *   trucks     Σ_{b,k} x[b,d,t,k] ≤ C · n[d,t]                         every lane-day
 *   fleet      Σ_d n[d,t] ≤ F_t,  n[d,t] ≤ lane limit                  every day
 *   shelf life x[b,d,t,k] exists only if the load reaches a session with ≥ the buyer's minimum
 *              remaining life; tier 0 additionally needs the buyer's list-price freshness
 *
 * Objective (maximise) — identical to the ledger's "net":
 *   Σ x·(price_k − handling − freight/kg) − Σ n·truck cost − Σ spoiled·spoilage cost
 *   − Σ shortfall·penalty + Σ carried·carry value
 */

export interface OptionRecord {
  option: LaneOption;
  commodityId: string;
  committed: boolean;
  banned: boolean;
  /** Margin per kg by tier, excluding the fixed truck cost: price − handling − freight/kg (+ avoided penalty in tier 0). */
  unitMargin: number[];
  /** Planned kg by tier (aligned with option.tiers). */
  tierKg: number[];
  plannedKg: number;
  /** LP reduced cost per tier with trucks fixed (≤ 0: rupees lost per kg forced in). */
  reducedCost: (number | null)[];
}

export interface Duals {
  /** Marginal value of one more kg of a batch. */
  stock: Map<string, number>;
  /** Scarcity rent of one more kg of demand: key = `${demandKey}|${tier}`. */
  demand: Map<string, number>;
  /** Value of one more kg of space on the trucks already assigned: key = `${destId}|${day}`. */
  laneCapacity: Map<string, number>;
}

export interface OptimizeStats {
  solver: string;
  variables: number;
  constraints: number;
  integers: number;
  solveMs: number;
  provenOptimal: boolean;
}

export interface OptimizeResult {
  status: SolveStatus;
  message?: string;
  plan: Plan;
  outcome: Outcome;
  /** Model objective including constants; equals outcome.totals.net up to rounding. */
  objective: number;
  consistencyGap: number;
  options: OptionRecord[];
  trucks: Map<string, number>;
  duals: Duals | null;
  stats: OptimizeStats;
  asOfDay: number;
  pins: Pin[];
}

export interface OptimizeOptions {
  asOfDay?: number;
  committed?: Shipment[];
  pins?: Pin[];
  label?: string;
  withDuals?: boolean;
  timeLimitSec?: number;
  /**
   * Optional service weight (₹ per kg of customer demand served at list price).
   * 0 (default) maximises the dataset's net outcome exactly. A positive value
   * lets the operator trade net for fulfilment; the reported objective and all
   * metrics exclude it.
   */
  serviceWeightPerKg?: number;
}

/**
 * Tie-break (₹ per kg per hour of shelf life left at sale). Among plans of equal
 * value the solver prefers to sell each kg with as little life to spare as
 * possible, i.e. first-expired-first-out, which keeps fresher lots in reserve
 * and stops interchangeable batches being split arbitrarily. At 0.00001 ₹/kg/h
 * it is two orders of magnitude below any real margin difference in the data;
 * the reported objective excludes it.
 */
export const TIE_BREAK = 1e-5;

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
};

class Expr {
  terms: string[] = [];
  add(coef: number, name: string) {
    if (Math.abs(coef) < 1e-9) return;
    this.terms.push(`${coef < 0 ? '-' : '+'} ${num(Math.abs(coef))} ${name}`);
  }
  get empty() {
    return this.terms.length === 0;
  }
  toString() {
    const out: string[] = [];
    for (let i = 0; i < this.terms.length; i += 6) out.push(' ' + this.terms.slice(i, i + 6).join(' '));
    return out.join('\n');
  }
}

interface BuiltModel {
  lp(fixedTrucks?: Map<string, number>): string;
  records: OptionRecord[];
  modelled: { rec: OptionRecord; idx: number }[];
  truckVars: { name: string; key: string; ub: number }[];
  constant: number;
  variables: number;
  constraints: number;
  infeasiblePin?: string;
}

function matchesPin(pin: Pin, o: LaneOption): boolean {
  if (pin.destId !== o.destId) return false;
  if (pin.batchId !== undefined && pin.batchId !== o.batchId) return false;
  if (pin.day !== undefined && pin.day !== o.day) return false;
  return true;
}

function buildModel(
  ix: ScenarioIndex,
  asOfDay: number,
  committed: Shipment[],
  pins: Pin[],
  serviceWeight: number,
): BuiltModel {
  const s = ix.scenario;
  const cap = s.fleet.truckCapacityKg;
  const records: OptionRecord[] = [];
  const modelled: { rec: OptionRecord; idx: number }[] = [];
  const bans = pins.filter((p) => p.kind === 'ban');
  const forces = pins.filter((p): p is Extract<Pin, { kind: 'force' }> => p.kind === 'force');

  const margins = (o: LaneOption, commodityId: string, sunkLogistics: boolean) => {
    const c = ix.commodity.get(commodityId)!;
    const d = ix.dest.get(o.destId)!;
    return o.tiers.map(
      (t) =>
        t.pricePerKg -
        (sunkLogistics ? 0 : c.handlingCostPerKg + d.costPerKg) +
        (t.tier === 0 ? d.shortfallPenaltyPerKg + (d.salvageOutlet ? 0 : serviceWeight) : 0),
    );
  };

  /* constants: committed logistics and the shortfall penalty on all demand */
  let constant = 0;
  for (const row of s.demand) {
    constant -= row.quantityKg * (ix.dest.get(row.destId)?.shortfallPenaltyPerKg ?? 0);
  }

  /* committed loads (already on the road) */
  const committedQty = new Map<string, number>();
  const committedLoad = new Map<string, number>();
  const committedRecs: { rec: OptionRecord; qty: number }[] = [];
  for (const sh of committed) {
    const batch = ix.batch.get(sh.batchId);
    const dest = ix.dest.get(sh.destId);
    if (!batch || !dest || !(sh.quantityKg > EPS_KG)) continue;
    const c = ix.commodity.get(batch.commodityId)!;
    const option = evaluateOption(ix, batch, dest, sh.day, true);
    const rec: OptionRecord = {
      option,
      commodityId: batch.commodityId,
      committed: true,
      banned: false,
      unitMargin: margins(option, batch.commodityId, true),
      tierKg: option.tiers.map(() => 0),
      plannedKg: sh.quantityKg,
      reducedCost: option.tiers.map(() => null),
    };
    records.push(rec);
    committedRecs.push({ rec, qty: sh.quantityKg });
    committedQty.set(batch.id, (committedQty.get(batch.id) ?? 0) + sh.quantityKg);
    const lk = `${dest.id}|${sh.day}`;
    committedLoad.set(lk, (committedLoad.get(lk) ?? 0) + sh.quantityKg);
    constant -= sh.quantityKg * (c.handlingCostPerKg + dest.costPerKg);
  }
  for (const [lk, load] of committedLoad) {
    const dest = ix.dest.get(lk.split('|')[0])!;
    constant -= Math.max(1, Math.ceil((load - EPS_KG) / cap)) * dest.costPerTruck;
  }

  /* open options */
  for (const batch of s.batches) {
    for (const dest of s.destinations) {
      for (let day = 0; day < s.horizonDays; day++) {
        let option = evaluateOption(ix, batch, dest, day);
        if (day < asOfDay) option = { ...option, feasible: false, code: 'committed_past', tiers: [] };
        const banned = option.feasible && bans.some((p) => matchesPin(p, option));
        records.push({
          option,
          commodityId: batch.commodityId,
          committed: false,
          banned,
          unitMargin: margins(option, batch.commodityId, false),
          tierKg: option.tiers.map(() => 0),
          plannedKg: 0,
          reducedCost: option.tiers.map(() => null),
        });
      }
    }
  }

  records.forEach((rec) => {
    if (rec.committed || (rec.option.feasible && !rec.banned)) modelled.push({ rec, idx: modelled.length });
  });

  /* ── assemble ── */
  const batchIdx = new Map(s.batches.map((b, i) => [b.id, i]));
  const destIdx = new Map(s.destinations.map((d, i) => [d.id, i]));
  const rowIdx = new Map(s.demand.map((r, i) => [demandKey(r.destId, r.commodityId, r.session), i]));
  const horizonEnd = 24 * s.horizonDays;

  const objective = new Expr();
  const stockRows = s.batches.map(() => new Expr());
  const demandRows = new Map<string, Expr>();
  const capRows = new Map<string, Expr>();
  /**
   * Valid inequalities that tighten the LP bound: what one lane-day delivers into a
   * demand tier is at most that tier's capacity, and zero if no truck runs (y = 0).
   * With them the root relaxation is usually integral in the truck counts.
   */
  const links: { name: string; ck: string; group: string; cap: number }[] = [];
  const committedRows: { expr: Expr; qty: number; idx: number }[] = [];
  const bounds: string[] = [];
  let variables = 0;

  for (const { rec, idx } of modelled) {
    const o = rec.option;
    const rIdx = rowIdx.get(demandKey(o.destId, rec.commodityId, o.session));
    const own = new Expr();
    o.tiers.forEach((t, k) => {
      const name = `x${idx}_${t.tier}`;
      variables++;
      objective.add(rec.unitMargin[k] - TIE_BREAK * o.lifeAtSaleHours, name);
      own.add(1, name);
      if (!rec.committed) {
        stockRows[batchIdx.get(o.batchId)!].add(1, name);
        const ck = `${destIdx.get(o.destId)}_${o.day}`;
        if (!capRows.has(ck)) capRows.set(ck, new Expr());
        capRows.get(ck)!.add(1, name);
        links.push({ name, ck, group: `${ck}|${rIdx}|${t.tier}`, cap: t.capacityKg });
      }
      const dk = `${rIdx}_${t.tier}`;
      if (!demandRows.has(dk)) demandRows.set(dk, new Expr());
      demandRows.get(dk)!.add(1, name);
    });
    if (rec.committed) {
      const c = ix.commodity.get(rec.commodityId)!;
      const wName = `w${idx}`;
      variables++;
      objective.add(-c.spoilageCostPerKg, wName);
      own.add(1, wName);
      committedRows.push({ expr: own, qty: rec.plannedKg, idx });
    }
  }

  s.batches.forEach((b, i) => {
    const c = ix.commodity.get(b.commodityId)!;
    const carried = b.remainingShelfLifeHours - horizonEnd >= c.minSaleLifeHours;
    const name = `h${i}`;
    variables++;
    objective.add(carried ? c.carryValuePerKg : -c.spoilageCostPerKg, name);
    stockRows[i].add(1, name);
  });

  const truckVars: { name: string; key: string; ub: number }[] = [];
  const fleetRows = new Map<number, Expr>();
  for (const [ck, expr] of capRows) {
    const [di, dayStr] = ck.split('_');
    const dest = s.destinations[Number(di)];
    const day = Number(dayStr);
    const name = `n${ck}`;
    const ub = Math.min(s.fleet.trucksPerDay[day] ?? 0, dest.maxTrucksPerDay ?? Infinity);
    truckVars.push({ name, key: `${dest.id}|${day}`, ub });
    variables++;
    expr.add(-cap, name);
    objective.add(-dest.costPerTruck, name);
    if (!fleetRows.has(day)) fleetRows.set(day, new Expr());
    fleetRows.get(day)!.add(1, name);
  }

  /* operator overrides */
  const pinRows: { expr: Expr; minKg: number }[] = [];
  let infeasiblePin: string | undefined;
  for (const pin of forces) {
    const expr = new Expr();
    for (const { rec, idx } of modelled) {
      if (rec.committed || !matchesPin(pin, rec.option)) continue;
      rec.option.tiers.forEach((t) => expr.add(1, `x${idx}_${t.tier}`));
    }
    if (expr.empty) {
      infeasiblePin = `No feasible way to send ${pin.batchId} to ${ix.dest.get(pin.destId)?.short ?? pin.destId}${pin.day !== undefined ? ` on D${pin.day}` : ''}.`;
    }
    pinRows.push({ expr, minKg: pin.minKg });
  }

  const constraints: string[] = [];
  s.batches.forEach((b, i) => {
    const rhs = Math.max(0, b.quantityKg - (committedQty.get(b.id) ?? 0));
    constraints.push(` rs${i}:\n${stockRows[i]} = ${num(rhs)}`);
  });
  for (const [dk, expr] of demandRows) {
    const [ri, tier] = dk.split('_').map(Number);
    const row = s.demand[ri];
    const c = ix.commodity.get(row.commodityId)!;
    const d = ix.dest.get(row.destId)!;
    const capKg = tierOffers(s, c, d, row)[tier].capacityKg;
    constraints.push(` rd${dk}:\n${expr} <= ${num(Math.max(0, capKg))}`);
  }
  for (const [ck, expr] of capRows) constraints.push(` rc${ck}:\n${expr} <= 0`);
  const linkRows: string[] = [];
  const linkGroups = new Map<string, { names: string[]; ck: string; cap: number }>();
  for (const l of links) {
    if (!linkGroups.has(l.group)) linkGroups.set(l.group, { names: [], ck: l.ck, cap: l.cap });
    linkGroups.get(l.group)!.names.push(l.name);
  }
  let gi = 0;
  for (const g of linkGroups.values()) {
    const e = new Expr();
    g.names.forEach((n) => e.add(1, n));
    e.add(-g.cap, `y${g.ck}`);
    linkRows.push(` rl${gi++}:
${e} <= 0`);
  }
  for (const ck of capRows.keys()) linkRows.push(` ry${ck}: y${ck} - n${ck} <= 0`);
  for (const [day, expr] of fleetRows) constraints.push(` rf${day}:\n${expr} <= ${num(s.fleet.trucksPerDay[day] ?? 0)}`);
  for (const cr of committedRows) constraints.push(` rm${cr.idx}:\n${cr.expr} = ${num(cr.qty)}`);
  pinRows.forEach((pr, j) => {
    if (!pr.expr.empty) constraints.push(` rp${j}:\n${pr.expr} >= ${num(pr.minKg)}`);
  });

  const lp = (fixedTrucks?: Map<string, number>) => {
    const b = [...bounds];
    for (const tv of truckVars) {
      if (fixedTrucks) b.push(` ${tv.name} = ${num(fixedTrucks.get(tv.key) ?? 0)}`);
      else b.push(` 0 <= ${tv.name} <= ${num(tv.ub)}`);
    }
    const parts = ['Maximize', ` obj:\n${objective.empty ? ' 0 h0' : objective}`, 'Subject To', ...constraints];
    if (!fixedTrucks) parts.push(...linkRows);
    if (b.length) parts.push('Bounds', ...b);
    if (!fixedTrucks && truckVars.length) {
      parts.push('General', ' ' + truckVars.map((t) => t.name).join(' '));
      parts.push('Binary', ' ' + truckVars.map((t) => 'y' + t.name.slice(1)).join(' '));
    }
    parts.push('End');
    return parts.join('\n');
  };

  return {
    lp,
    records,
    modelled,
    truckVars,
    constant,
    variables,
    constraints: constraints.length,
    infeasiblePin,
  };
}

const snap = (kg: number) => Math.round(kg * 1000) / 1000;

export function optimize(scenario: Scenario, solver: LpSolver, opts: OptimizeOptions = {}): OptimizeResult {
  const ix = indexScenario(scenario);
  const asOfDay = opts.asOfDay ?? 0;
  const pins = opts.pins ?? [];
  const committed = (opts.committed ?? []).filter((sh) => sh.day < asOfDay);
  const label = opts.label ?? 'FreshRoute plan';
  const serviceWeight = Math.max(0, opts.serviceWeightPerKg ?? 0);
  const model = buildModel(ix, asOfDay, committed, pins, serviceWeight);

  const stats: OptimizeStats = {
    solver: solver.name,
    variables: model.variables,
    constraints: model.constraints,
    integers: model.truckVars.length,
    solveMs: 0,
    provenOptimal: false,
  };
  const fallbackPlan: Plan = { label, method: 'optimizer', shipments: committed.map((c) => ({ ...c })) };
  const fail = (status: SolveStatus, message: string): OptimizeResult => ({
    status,
    message,
    plan: fallbackPlan,
    outcome: settle(scenario, fallbackPlan, ix),
    objective: NaN,
    consistencyGap: NaN,
    options: model.records,
    trucks: new Map(),
    duals: null,
    stats,
    asOfDay,
    pins,
  });

  if (model.infeasiblePin) return fail('infeasible', model.infeasiblePin);
  if (scenario.batches.length === 0) {
    return { ...fail('optimal', 'No inventory to plan.'), objective: 0, consistencyGap: 0 };
  }

  const mip = solver.solve(model.lp(), { timeLimitSec: opts.timeLimitSec });
  stats.solveMs = mip.ms;
  if (mip.status === 'infeasible') {
    return fail('infeasible', 'The operator overrides cannot all be satisfied together with stock, demand, truck and shelf-life limits.');
  }
  if (mip.status === 'error') return fail('error', `Solver error: ${mip.rawStatus}`);
  stats.provenOptimal = mip.status === 'optimal';

  /* decode */
  const shipments: Shipment[] = committed.map((c) => ({ ...c }));
  for (const { rec, idx } of model.modelled) {
    rec.tierKg = rec.option.tiers.map((t) => snap(Math.max(0, mip.primal.get(`x${idx}_${t.tier}`) ?? 0)));
    if (rec.committed) continue;
    rec.plannedKg = snap(rec.tierKg.reduce((a, b) => a + b, 0));
    if (rec.plannedKg > 0.0005) {
      shipments.push({
        batchId: rec.option.batchId,
        destId: rec.option.destId,
        day: rec.option.day,
        quantityKg: rec.plannedKg,
      });
    } else {
      rec.plannedKg = 0;
    }
  }
  shipments.sort((a, b) => a.day - b.day || a.destId.localeCompare(b.destId) || a.batchId.localeCompare(b.batchId));
  const trucks = new Map<string, number>();
  for (const tv of model.truckVars) trucks.set(tv.key, Math.round(mip.primal.get(tv.name) ?? 0));

  const plan: Plan = { label, method: 'optimizer', shipments };
  const outcome = settle(scenario, plan, ix);
  // Remove the tie-break and service-weight terms so the objective is the dataset's net outcome.
  let adjustment = 0;
  for (const { rec } of model.modelled) {
    adjustment += TIE_BREAK * rec.option.lifeAtSaleHours * rec.tierKg.reduce((a, b) => a + b, 0);
    const dest = ix.dest.get(rec.option.destId)!;
    rec.option.tiers.forEach((t, k) => {
      if (t.tier === 0 && !dest.salvageOutlet) adjustment -= serviceWeight * rec.tierKg[k];
    });
  }
  const objective = mip.objective + adjustment + model.constant;

  /* sensitivity: fix the truck counts and read LP duals */
  let duals: Duals | null = null;
  if (opts.withDuals !== false) {
    const lpRes = solver.solve(model.lp(trucks), { timeLimitSec: opts.timeLimitSec });
    stats.solveMs += lpRes.ms;
    if (lpRes.status === 'optimal' && lpRes.rowDual.size > 0) {
      duals = { stock: new Map(), demand: new Map(), laneCapacity: new Map() };
      scenario.batches.forEach((b, i) => duals!.stock.set(b.id, lpRes.rowDual.get(`rs${i}`) ?? 0));
      scenario.demand.forEach((row, ri) => {
        for (let tier = 0; tier <= scenario.discountTiers.length; tier++) {
          const v = lpRes.rowDual.get(`rd${ri}_${tier}`);
          if (v !== undefined) duals!.demand.set(`${demandKey(row.destId, row.commodityId, row.session)}|${tier}`, v);
        }
      });
      scenario.destinations.forEach((d, di) => {
        for (let day = 0; day < scenario.horizonDays; day++) {
          const v = lpRes.rowDual.get(`rc${di}_${day}`);
          if (v !== undefined) duals!.laneCapacity.set(`${d.id}|${day}`, v);
        }
      });
      for (const { rec, idx } of model.modelled) {
        rec.reducedCost = rec.option.tiers.map((t) => lpRes.reducedCost.get(`x${idx}_${t.tier}`) ?? null);
      }
    }
  }

  return {
    status: mip.status,
    message:
      mip.status === 'feasible'
        ? 'Time limit reached: this is the best feasible plan found, not a proven optimum.'
        : undefined,
    plan,
    outcome,
    objective,
    consistencyGap: Math.abs(objective - outcome.totals.net),
    options: model.records,
    trucks,
    duals,
    stats,
    asOfDay,
    pins,
  };
}
