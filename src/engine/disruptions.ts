import type { Batch, Plan, Scenario, Shipment } from './types';
import { optimize, type OptimizeResult } from './optimize';
import { settle } from './ledger';
import type { LpSolver } from './solver';
import { delta, type Delta } from './counterfactual';
import { kg } from './fmt';

/**
 * Disruptions are explicit, inspectable patches to a scenario. Replanning
 * freezes everything that has already left the hub (dispatch day < asOfDay) and
 * re-optimises the rest under the patched scenario.
 */
export type Disruption =
  | { kind: 'lane_delay'; destId: string; days: number[]; extraHours: number }
  | { kind: 'lane_closure'; destId: string; days: number[] }
  | { kind: 'fleet_change'; days: number[]; trucks: number }
  | { kind: 'demand_change'; destId: string; commodityId?: string; fromSession: number; factor: number }
  | { kind: 'price_change'; destId: string; commodityId?: string; fromSession: number; factor: number }
  | { kind: 'shelf_life_change'; commodityId?: string; batchIds?: string[]; factor: number }
  | { kind: 'new_order'; destId: string; commodityId: string; session: number; quantityKg: number; pricePerKg: number }
  | { kind: 'new_batch'; batch: Batch };

export interface DisruptionEvent {
  id: string;
  title: string;
  detail: string;
  changes: Disruption[];
}

export function applyDisruptions(scenario: Scenario, changes: Disruption[]): Scenario {
  const s: Scenario = structuredClone(scenario);
  for (const ch of changes) {
    switch (ch.kind) {
      case 'lane_delay': {
        const d = s.destinations.find((x) => x.id === ch.destId);
        if (!d) break;
        const arr = d.transitDelayByDay ? [...d.transitDelayByDay] : [];
        for (const day of ch.days) arr[day] = (arr[day] ?? 0) + ch.extraHours;
        for (let i = 0; i < arr.length; i++) arr[i] = arr[i] ?? 0;
        d.transitDelayByDay = arr;
        break;
      }
      case 'lane_closure': {
        const d = s.destinations.find((x) => x.id === ch.destId);
        if (d) d.closedDays = [...new Set([...(d.closedDays ?? []), ...ch.days])].sort();
        break;
      }
      case 'fleet_change':
        for (const day of ch.days) s.fleet.trucksPerDay[day] = Math.max(0, ch.trucks);
        break;
      case 'demand_change':
        for (const r of s.demand)
          if (r.destId === ch.destId && r.session >= ch.fromSession && (!ch.commodityId || r.commodityId === ch.commodityId))
            r.quantityKg = Math.max(0, Math.round(r.quantityKg * ch.factor));
        break;
      case 'price_change':
        for (const r of s.demand)
          if (r.destId === ch.destId && r.session >= ch.fromSession && (!ch.commodityId || r.commodityId === ch.commodityId))
            r.pricePerKg = Math.round(r.pricePerKg * ch.factor * 10) / 10;
        break;
      case 'shelf_life_change':
        for (const b of s.batches)
          if ((ch.commodityId && b.commodityId === ch.commodityId) || ch.batchIds?.includes(b.id))
            b.remainingShelfLifeHours = Math.round(b.remainingShelfLifeHours * ch.factor);
        break;
      case 'new_order': {
        const row = s.demand.find(
          (r) => r.destId === ch.destId && r.commodityId === ch.commodityId && r.session === ch.session,
        );
        if (row) {
          // Blend the price over the enlarged quantity so revenue stays exact for list-price sales.
          const total = row.quantityKg + ch.quantityKg;
          row.pricePerKg = Math.round(((row.pricePerKg * row.quantityKg + ch.pricePerKg * ch.quantityKg) / total) * 10) / 10;
          row.quantityKg = total;
        } else {
          s.demand.push({ destId: ch.destId, commodityId: ch.commodityId, session: ch.session, quantityKg: ch.quantityKg, pricePerKg: ch.pricePerKg });
        }
        break;
      }
      case 'new_batch':
        if (!s.batches.some((b) => b.id === ch.batch.id)) s.batches.push({ ...ch.batch });
        break;
    }
  }
  return s;
}

/* ───────────────────────── replanning ───────────────────────── */

export interface PlanDiffRow {
  batchId: string;
  destId: string;
  day: number;
  beforeKg: number;
  afterKg: number;
}

export function diffPlans(before: Plan, after: Plan, fromDay = 0): PlanDiffRow[] {
  const key = (s: Shipment) => `${s.batchId}|${s.destId}|${s.day}`;
  const map = new Map<string, PlanDiffRow>();
  for (const s of before.shipments) {
    if (s.day < fromDay) continue;
    map.set(key(s), { batchId: s.batchId, destId: s.destId, day: s.day, beforeKg: s.quantityKg, afterKg: 0 });
  }
  for (const s of after.shipments) {
    if (s.day < fromDay) continue;
    const row = map.get(key(s)) ?? { batchId: s.batchId, destId: s.destId, day: s.day, beforeKg: 0, afterKg: 0 };
    row.afterKg += s.quantityKg;
    map.set(key(s), row);
  }
  return [...map.values()]
    .filter((r) => Math.abs(r.afterKg - r.beforeKg) >= 1)
    .sort((a, b) => a.day - b.day || a.batchId.localeCompare(b.batchId) || a.destId.localeCompare(b.destId));
}

export interface ReplanResult {
  asOfDay: number;
  disrupted: Scenario;
  /** The old plan executed unchanged in the disrupted world. */
  stale: ReturnType<typeof settle>;
  replanned: OptimizeResult;
  /** replanned − stale */
  valueOfReplanning: Delta;
  diff: PlanDiffRow[];
  summary: string[];
}

export function replan(
  scenario: Scenario,
  previous: Plan,
  changes: Disruption[],
  asOfDay: number,
  solver: LpSolver,
): ReplanResult {
  const disrupted = applyDisruptions(scenario, changes);
  const committed = previous.shipments.filter((s) => s.day < asOfDay);
  const stalePlan: Plan = { ...previous, label: 'Original plan, unchanged' };
  const stale = settle(disrupted, stalePlan);
  const replanned = optimize(disrupted, solver, { asOfDay, committed, label: 'Replanned' });
  const valueOfReplanning = delta(stale.totals, replanned.outcome.totals);
  const diff = diffPlans(previous, replanned.plan, asOfDay);

  const summary: string[] = [];
  const staleIssues = stale.violations;
  if (staleIssues.length) {
    const lost = staleIssues.reduce((a, v) => a + v.quantityKg, 0);
    summary.push(
      `Executed unchanged, the original plan breaks ${staleIssues.length} time${staleIssues.length === 1 ? '' : 's'} in the new conditions (${kg(lost)} affected).`,
    );
  }
  const moved = new Set(diff.map((d) => d.batchId));
  if (moved.size) summary.push(`${moved.size} batch${moved.size === 1 ? '' : 'es'} re-routed or re-timed from D${asOfDay} onward.`);
  else summary.push('No change to the remaining dispatches is worth making.');
  return { asOfDay, disrupted, stale, replanned, valueOfReplanning, diff, summary };
}

/* ───────────────────────── demo presets ───────────────────────── */

/** Disruption presets for the bundled Nashik scenario (ids refer to its destinations and batches). */
export function presetEvents(scenario: Scenario): (DisruptionEvent & { asOfDay: number })[] {
  const has = (id: string) => scenario.destinations.some((d) => d.id === id);
  const events: (DisruptionEvent & { asOfDay: number })[] = [];
  if (has('DEL'))
    events.push({
      id: 'del-delay',
      asOfDay: 1,
      title: 'Delhi truck stuck behind a ghat landslide',
      detail: 'It is D1. The D0 truck to Delhi will be 14 h late, and the D1 departure faces the same 14 h hold-up.',
      changes: [{ kind: 'lane_delay', destId: 'DEL', days: [0, 1], extraHours: 14 }],
    });
  events.push({
    id: 'strike',
    asOfDay: 1,
    title: 'Transporter strike cuts the fleet',
    detail: 'It is D1. Only 2 trucks can be hired for the D1 and D2 dispatch waves.',
    changes: [{ kind: 'fleet_change', days: [1, 2], trucks: 2 }],
  });
  if (has('MUM'))
    events.push({
      id: 'mumbai-glut',
      asOfDay: 1,
      title: 'Mumbai market glut',
      detail: 'It is D1. Heavy arrivals from Karnataka: Mumbai demand falls 40% and prices 20% from the D2 session.',
      changes: [
        { kind: 'demand_change', destId: 'MUM', fromSession: 2, factor: 0.6 },
        { kind: 'price_change', destId: 'MUM', fromSession: 2, factor: 0.8 },
      ],
    });
  if (scenario.commodities.some((c) => c.id === 'GRP'))
    events.push({
      id: 'cold-room',
      asOfDay: 0,
      title: 'Cold-room compressor failure',
      detail: 'Before dispatch on D0, grapes in the hub cold room lose 30% of their remaining shelf life.',
      changes: [{ kind: 'shelf_life_change', commodityId: 'GRP', factor: 0.7 }],
    });
  if (has('RET'))
    events.push({
      id: 'rush-order',
      asOfDay: 1,
      title: 'Rush order from FreshKart',
      detail: 'It is D1. FreshKart adds 3 t of tomatoes for the D2 session at ₹34/kg (contract penalty applies).',
      changes: [{ kind: 'new_order', destId: 'RET', commodityId: 'TOM', session: 2, quantityKg: 3000, pricePerKg: 34 }],
    });
  if (has('PUN'))
    events.push({
      id: 'pune-closure',
      asOfDay: 1,
      title: 'Pune lane closed for two nights',
      detail: 'It is D1. A bridge inspection closes the Pune lane for the D1 and D2 waves.',
      changes: [{ kind: 'lane_closure', destId: 'PUN', days: [1, 2] }],
    });
  return events;
}
