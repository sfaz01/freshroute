import type { Scenario } from '../types';
import { baseScenario, BASE_BATCHES, COMMODITIES, DESTINATIONS, buildDemand, MARKET } from './base';
import { applyDisruptions } from '../disruptions';
import { mulberry32, normal } from '../uncertainty';

/**
 * The evaluation suite. Every scenario is derived from the bundled Nashik
 * dataset by an explicit, documented transformation, so a reviewer can see
 * exactly what each one stresses. Nothing here is tuned to favour either plan.
 */

type Variant = { id: string; name: string; tests: string; description: string; make: (s: Scenario) => Scenario };

const scaleBatches = (s: Scenario, f: number) => {
  for (const b of s.batches) b.quantityKg = Math.round((b.quantityKg * f) / 10) * 10;
  return s;
};

const VARIANTS: Variant[] = [
  {
    id: 'ordinary-day',
    name: 'Ordinary day',
    tests: 'Ordinary operating conditions',
    description: 'The reference dataset: 22 batches, six crops, eight outlets, six trucks a night.',
    make: (s) => s,
  },
  {
    id: 'harvest-glut',
    name: 'Harvest glut',
    tests: 'Inventory exceeds demand',
    description: 'Every batch is 60% larger. Supply far exceeds list-price demand; the question is what to mark down, where, and what to let go.',
    make: (s) => scaleBatches(s, 1.6),
  },
  {
    id: 'short-supply',
    name: 'Short supply',
    tests: 'Demand exceeds inventory',
    description: 'Every batch is half the size. Demand exceeds stock almost everywhere; the plan must choose which customers to serve.',
    make: (s) => scaleBatches(s, 0.5),
  },
  {
    id: 'fleet-crunch',
    name: 'Fleet crunch',
    tests: 'Insufficient transport capacity',
    description: 'Only three trucks a night instead of six. Truck space, not stock, is the binding constraint.',
    make: (s) => {
      s.fleet.trucksPerDay = s.fleet.trucksPerDay.map(() => 3);
      return s;
    },
  },
  {
    id: 'heatwave',
    name: 'Heatwave',
    tests: 'Highly perishable stock that can only reach some destinations',
    description: 'Remaining shelf life of every batch is cut by 35%. Several lots can now only reach the nearest markets in time.',
    make: (s) => applyDisruptions(s, s.commodities.map((c) => ({ kind: 'shelf_life_change' as const, commodityId: c.id, factor: 0.65 }))),
  },
  {
    id: 'highway-delay',
    name: 'Highway delays',
    tests: 'Delayed shipments',
    description: 'Every Delhi and Hyderabad departure is 12 h slower than the timetable (known in advance).',
    make: (s) =>
      applyDisruptions(s, [
        { kind: 'lane_delay', destId: 'DEL', days: [0, 1, 2, 3], extraHours: 12 },
        { kind: 'lane_delay', destId: 'HYD', days: [0, 1, 2, 3], extraHours: 12 },
      ]),
  },
  {
    id: 'demand-shock',
    name: 'Demand shock',
    tests: 'Unexpected change in destination demand',
    description: 'Mumbai demand halves from the first session while Delhi and Hyderabad demand rises 40%.',
    make: (s) =>
      applyDisruptions(s, [
        { kind: 'demand_change', destId: 'MUM', fromSession: 0, factor: 0.5 },
        { kind: 'demand_change', destId: 'DEL', fromSession: 0, factor: 1.4 },
        { kind: 'demand_change', destId: 'HYD', fromSession: 0, factor: 1.4 },
      ]),
  },
  {
    id: 'diesel-spike',
    name: 'Diesel spike',
    tests: 'Costs that change the preferred decision',
    description: 'Freight per truck rises 70% on every lane. Long hauls that paid yesterday may not pay today.',
    make: (s) => {
      for (const d of s.destinations) d.costPerTruck = Math.round(d.costPerTruck * 1.7);
      return s;
    },
  },
  {
    id: 'thin-markdowns',
    name: 'Thin markdown demand',
    tests: 'Discount assumptions that change the preferred decision',
    description: 'Buyers barely respond to markdowns (appetite × 0.25). Tests how much of the result depends on the discount model.',
    make: (s) => {
      for (const d of s.destinations) d.markdownAppetite *= 0.25;
      return s;
    },
  },
  {
    id: 'no-headroom',
    name: 'Little headroom',
    tests: 'Constraints that leave (almost) nothing to improve',
    description: 'Onions only, one market (Mumbai), ample trucks, demand far above supply. Any sensible plan sells everything at list price; only truck consolidation is left to optimise.',
    make: (s) => {
      s.batches = s.batches.filter((b) => b.commodityId === 'ONI');
      s.destinations = s.destinations.filter((d) => d.id === 'MUM');
      s.demand = s.demand.filter((r) => r.destId === 'MUM').map((r) => ({ ...r, quantityKg: r.quantityKg * 6 }));
      s.fleet.trucksPerDay = s.fleet.trucksPerDay.map(() => 8);
      return s;
    },
  },
  {
    id: 'stranded',
    name: 'Stranded stock',
    tests: 'No feasible allocation exists for all requested demand',
    description: 'Monsoon closures shut every lane except Mumbai, Pune and the processor, and shelf life is 20% shorter. Most demand cannot be served by any plan; the feasible part must still be planned.',
    make: (s) => {
      const s2 = applyDisruptions(
        s,
        [
          ...['SUR', 'AMD', 'HYD', 'DEL', 'RET'].map((id) => ({ kind: 'lane_closure' as const, destId: id, days: [0, 1, 2, 3] })),
          ...s.commodities.map((c) => ({ kind: 'shelf_life_change' as const, commodityId: c.id, factor: 0.8 })),
        ],
      );
      return s2;
    },
  },
];

export interface CatalogEntry {
  id: string;
  name: string;
  tests: string;
  description: string;
  build: () => Scenario;
}

export const CATALOG: CatalogEntry[] = VARIANTS.map((v) => ({
  id: v.id,
  name: v.name,
  tests: v.tests,
  description: v.description,
  build: () => {
    const s = v.make(baseScenario());
    return { ...s, id: v.id, name: v.name, tests: v.tests, description: v.description };
  },
}));

export function buildScenario(id: string): Scenario {
  const entry = CATALOG.find((c) => c.id === id);
  if (!entry) throw new Error(`Unknown scenario "${id}"`);
  return entry.build();
}

/**
 * Seeded random scenarios on the same commodity / destination catalogue, for
 * aggregate evaluation. Each seed draws batch count, sizes, shelf lives,
 * inbound timing, fleet size, demand level and price noise.
 */
export function randomScenario(seed: number): Scenario {
  const rng = mulberry32(seed * 7919 + 17);
  const u = (a: number, b: number) => a + (b - a) * rng();
  const pick = <T,>(xs: T[]) => xs[Math.floor(rng() * xs.length)];
  const base = baseScenario();
  const typical = new Map<string, number[]>();
  for (const b of BASE_BATCHES) {
    if (!typical.has(b.commodityId)) typical.set(b.commodityId, []);
    typical.get(b.commodityId)!.push(b.remainingShelfLifeHours);
  }
  const nBatches = Math.round(u(14, 26));
  const batches = Array.from({ length: nBatches }, (_, i) => {
    const c = pick(COMMODITIES);
    const lives = typical.get(c.id)!;
    const life = Math.max(c.minSaleLifeHours + 6, pick(lives) * u(0.8, 1.3));
    const availableFromDay = rng() < 0.7 ? 0 : rng() < 0.6 ? 1 : 2;
    return {
      id: `${c.id}-${String(i + 1).padStart(2, '0')}`,
      commodityId: c.id,
      quantityKg: Math.round(u(1000, 8000) / 100) * 100 * (c.id === 'COR' ? 0.25 : 1),
      remainingShelfLifeHours: Math.round(life + 24 * availableFromDay),
      availableFromDay,
      source: 'synthetic',
    };
  });
  const demandScale = u(0.7, 1.3);
  const market: typeof MARKET = {};
  for (const [d, row] of Object.entries(MARKET)) {
    market[d] = {};
    for (const [c, [q, p]] of Object.entries(row)) {
      const f = Math.max(0.7, Math.min(1.3, 1 + 0.12 * normal(rng)));
      market[d][c] = [q, Math.round(p * f * 10) / 10];
    }
  }
  const trucks = Math.round(u(4, 7));
  return {
    ...base,
    id: `random-${seed}`,
    name: `Random seed ${seed}`,
    description: `${nBatches} batches, ${trucks} trucks/night, demand × ${demandScale.toFixed(2)}, prices ±12%.`,
    tests: 'Randomised operating conditions',
    batches,
    demand: buildDemand({
      commodities: COMMODITIES,
      destinations: DESTINATIONS,
      market,
      horizonDays: base.horizonDays,
      dispatchHour: base.dispatchHour,
      hubLoadHours: base.hub.loadHours,
      demandScale: 0.8 * demandScale,
    }),
    fleet: { truckCapacityKg: base.fleet.truckCapacityKg, trucksPerDay: base.fleet.trucksPerDay.map(() => trucks) },
  };
}
