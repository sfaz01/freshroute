import type { Scenario } from '../src/engine/types';
import { loadNodeSolver } from '../src/engine/nodeSolver';
import type { LpSolver } from '../src/engine/solver';

let solverPromise: Promise<LpSolver> | null = null;
export const getSolver = () => (solverPromise ??= loadNodeSolver());

/**
 * A micro scenario small enough to check by hand.
 * Hub loads 1 h; dispatch at 18:00. NEAR: 5 h + 1 h dock → ready hour 25,
 * market opens 05:00 → session 1 (hour 29). FAR: 30 h + 2 h → ready hour 51 → session 2 (hour 53).
 */
export function micro(overrides: (s: Scenario) => void = () => {}): Scenario {
  const s: Scenario = {
    id: 'micro',
    name: 'Micro',
    description: 'Hand-checkable test scenario',
    horizonDays: 2,
    dispatchHour: 18,
    hub: { id: 'H', name: 'Hub', lat: 0, lon: 0, loadHours: 1 },
    commodities: [
      { id: 'TOM', name: 'Tomato', handlingCostPerKg: 1, spoilageCostPerKg: 10, carryValuePerKg: 0, minSaleLifeHours: 12, fullPriceLifeHours: 36, elasticity: 1.5, shelfLifeCv: 0.1 },
    ],
    batches: [{ id: 'B1', commodityId: 'TOM', quantityKg: 1000, remainingShelfLifeHours: 100, availableFromDay: 0 }],
    destinations: [
      { id: 'NEAR', name: 'Near market', short: 'Near', type: 'mandi', lat: 0, lon: 0, transitHours: 5, dockHours: 1, marketOpenHour: 5, costPerTruck: 1000, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 1, freshnessOffsetHours: 0, transitCv: 0.1 },
      { id: 'FAR', name: 'Far market', short: 'Far', type: 'mandi', lat: 0, lon: 0, transitHours: 30, dockHours: 2, marketOpenHour: 5, costPerTruck: 3000, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 1, freshnessOffsetHours: 0, transitCv: 0.1 },
    ],
    demand: [
      { destId: 'NEAR', commodityId: 'TOM', session: 1, quantityKg: 600, pricePerKg: 20 },
      { destId: 'NEAR', commodityId: 'TOM', session: 2, quantityKg: 600, pricePerKg: 20 },
      { destId: 'FAR', commodityId: 'TOM', session: 2, quantityKg: 600, pricePerKg: 30 },
      { destId: 'FAR', commodityId: 'TOM', session: 3, quantityKg: 600, pricePerKg: 30 },
    ],
    fleet: { truckCapacityKg: 2000, trucksPerDay: [2, 2] },
    discountTiers: [0.2],
    uncertainty: { demandCv: 0.1, priceCv: 0.05 },
    synthetic: true,
  };
  overrides(s);
  return s;
}
