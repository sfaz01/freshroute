import type { Batch, Commodity, DemandRow, Destination, Scenario } from '../types';
import { saleSession } from '../time';

/**
 * Synthetic but plausibly-scaled dataset: a consolidation hub at Nashik
 * (Maharashtra) supplying wholesale mandis, a contracted modern-retail DC and a
 * local processor. City coordinates and approximate road times are real;
 * every quantity, price and cost is synthetic.
 */

export const COMMODITIES: Commodity[] = [
  { id: 'TOM', name: 'Tomato', handlingCostPerKg: 1.2, spoilageCostPerKg: 14, carryValuePerKg: 0, minSaleLifeHours: 18, fullPriceLifeHours: 42, elasticity: 1.6, shelfLifeCv: 0.15 },
  { id: 'GRP', name: 'Grapes', handlingCostPerKg: 2.5, spoilageCostPerKg: 46, carryValuePerKg: 0, minSaleLifeHours: 24, fullPriceLifeHours: 60, elasticity: 2.0, shelfLifeCv: 0.12 },
  { id: 'COR', name: 'Coriander', handlingCostPerKg: 1.5, spoilageCostPerKg: 20, carryValuePerKg: 0, minSaleLifeHours: 8, fullPriceLifeHours: 20, elasticity: 1.4, shelfLifeCv: 0.2 },
  { id: 'ONI', name: 'Onion', handlingCostPerKg: 0.8, spoilageCostPerKg: 13, carryValuePerKg: 12, minSaleLifeHours: 48, fullPriceLifeHours: 120, elasticity: 0.9, shelfLifeCv: 0.08 },
  { id: 'CAP', name: 'Capsicum', handlingCostPerKg: 1.5, spoilageCostPerKg: 26, carryValuePerKg: 0, minSaleLifeHours: 18, fullPriceLifeHours: 48, elasticity: 1.5, shelfLifeCv: 0.15 },
  { id: 'BAN', name: 'Banana', handlingCostPerKg: 1.0, spoilageCostPerKg: 15, carryValuePerKg: 0, minSaleLifeHours: 18, fullPriceLifeHours: 40, elasticity: 1.3, shelfLifeCv: 0.15 },
];

export const DESTINATIONS: Destination[] = [
  { id: 'MUM', name: 'Mumbai · Vashi APMC', short: 'Mumbai', type: 'mandi', lat: 19.076, lon: 72.998, transitHours: 5, dockHours: 1, marketOpenHour: 5, costPerTruck: 7500, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 0.6, freshnessOffsetHours: 0, transitCv: 0.1 },
  { id: 'RET', name: 'Mumbai · FreshKart DC', short: 'FreshKart', type: 'retail_dc', lat: 19.21, lon: 73.1, transitHours: 5.5, dockHours: 1.5, marketOpenHour: 4, costPerTruck: 8000, costPerKg: 0, shortfallPenaltyPerKg: 6, markdownAppetite: 0, freshnessOffsetHours: 24, transitCv: 0.1 },
  { id: 'PUN', name: 'Pune · Market Yard', short: 'Pune', type: 'mandi', lat: 18.52, lon: 73.856, transitHours: 6, dockHours: 1, marketOpenHour: 5, costPerTruck: 8500, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 0.6, freshnessOffsetHours: 0, transitCv: 0.1 },
  { id: 'SUR', name: 'Surat APMC', short: 'Surat', type: 'mandi', lat: 21.17, lon: 72.831, transitHours: 7, dockHours: 1, marketOpenHour: 6, costPerTruck: 10000, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 0.5, freshnessOffsetHours: 0, transitCv: 0.1 },
  { id: 'AMD', name: 'Ahmedabad · Jamalpur', short: 'Ahmedabad', type: 'mandi', lat: 23.022, lon: 72.571, transitHours: 10, dockHours: 1, marketOpenHour: 6, costPerTruck: 17000, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 0.6, freshnessOffsetHours: 0, transitCv: 0.12 },
  { id: 'HYD', name: 'Hyderabad · Bowenpally', short: 'Hyderabad', type: 'mandi', lat: 17.385, lon: 78.487, transitHours: 16, dockHours: 1.5, marketOpenHour: 5, costPerTruck: 24000, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 0.6, freshnessOffsetHours: 0, transitCv: 0.12 },
  { id: 'DEL', name: 'Delhi · Azadpur', short: 'Delhi', type: 'mandi', lat: 28.704, lon: 77.152, transitHours: 30, dockHours: 2, marketOpenHour: 5, costPerTruck: 44000, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 0.6, freshnessOffsetHours: 0, transitCv: 0.14 },
  { id: 'NSK', name: 'Nashik · Agro Processors', short: 'Processor', type: 'processor', lat: 20.13, lon: 73.95, transitHours: 1, dockHours: 0.5, marketOpenHour: 8, costPerTruck: 1800, costPerKg: 0, shortfallPenaltyPerKg: 0, markdownAppetite: 0, freshnessOffsetHours: -48, transitCv: 0.05, salvageOutlet: true },
];

/** Base demand (kg per session) and list price (₹/kg) by destination × commodity. */
export const MARKET: Record<string, Record<string, [number, number]>> = {
  MUM: { TOM: [3000, 26], GRP: [1500, 72], COR: [600, 48], ONI: [2500, 19], CAP: [750, 44], BAN: [1250, 24] },
  RET: { TOM: [1000, 30], GRP: [600, 84], COR: [300, 56], CAP: [350, 52], BAN: [500, 28] },
  PUN: { TOM: [1750, 24], GRP: [750, 66], COR: [400, 44], ONI: [1500, 18], CAP: [450, 40], BAN: [750, 22] },
  SUR: { TOM: [1250, 23], GRP: [600, 64], COR: [200, 40], ONI: [1000, 18], CAP: [300, 38], BAN: [600, 23] },
  AMD: { TOM: [1500, 27], GRP: [900, 74], COR: [250, 46], ONI: [1500, 20], CAP: [400, 46], BAN: [750, 26] },
  HYD: { TOM: [1500, 25], GRP: [750, 70], ONI: [1750, 21], CAP: [400, 42] },
  DEL: { TOM: [2500, 34], GRP: [1500, 92], ONI: [2500, 24], CAP: [750, 58], BAN: [1000, 30] },
  NSK: { TOM: [3000, 9], GRP: [1000, 30], BAN: [1250, 10] },
};

/** Day-of-week style pattern on quantity and price, by session offset. Deterministic. */
const QTY_PATTERN = [1.0, 0.9, 1.1, 1.0];
const PRICE_PATTERN = [1.0, 1.03, 0.97, 1.0];

export const BASE_BATCHES: Batch[] = [
  { id: 'TOM-01', commodityId: 'TOM', quantityKg: 6000, remainingShelfLifeHours: 54, availableFromDay: 0, source: 'Pimpalgaon · ripe lot' },
  { id: 'TOM-02', commodityId: 'TOM', quantityKg: 8000, remainingShelfLifeHours: 78, availableFromDay: 0, source: 'Pimpalgaon' },
  { id: 'TOM-03', commodityId: 'TOM', quantityKg: 11000, remainingShelfLifeHours: 110, availableFromDay: 0, source: 'Lasalgaon' },
  { id: 'TOM-04', commodityId: 'TOM', quantityKg: 7000, remainingShelfLifeHours: 144, availableFromDay: 1, source: 'Sinnar · inbound D1' },
  { id: 'TOM-05', commodityId: 'TOM', quantityKg: 8000, remainingShelfLifeHours: 150, availableFromDay: 2, source: 'Dindori · inbound D2' },
  { id: 'GRP-01', commodityId: 'GRP', quantityKg: 3000, remainingShelfLifeHours: 66, availableFromDay: 0, source: 'Niphad · cold room 2' },
  { id: 'GRP-02', commodityId: 'GRP', quantityKg: 6000, remainingShelfLifeHours: 96, availableFromDay: 0, source: 'Niphad' },
  { id: 'GRP-03', commodityId: 'GRP', quantityKg: 7000, remainingShelfLifeHours: 140, availableFromDay: 0, source: 'Dindori' },
  { id: 'GRP-04', commodityId: 'GRP', quantityKg: 5000, remainingShelfLifeHours: 168, availableFromDay: 1, source: 'Dindori · inbound D1' },
  { id: 'COR-01', commodityId: 'COR', quantityKg: 900, remainingShelfLifeHours: 34, availableFromDay: 0, source: 'Nashik Road' },
  { id: 'COR-02', commodityId: 'COR', quantityKg: 2000, remainingShelfLifeHours: 52, availableFromDay: 0, source: 'Nashik Road' },
  { id: 'COR-03', commodityId: 'COR', quantityKg: 1500, remainingShelfLifeHours: 76, availableFromDay: 1, source: 'Ozar · inbound D1' },
  { id: 'COR-04', commodityId: 'COR', quantityKg: 1500, remainingShelfLifeHours: 100, availableFromDay: 2, source: 'Ozar · inbound D2' },
  { id: 'ONI-01', commodityId: 'ONI', quantityKg: 12000, remainingShelfLifeHours: 400, availableFromDay: 0, source: 'Lasalgaon · chawl A' },
  { id: 'ONI-02', commodityId: 'ONI', quantityKg: 12000, remainingShelfLifeHours: 600, availableFromDay: 0, source: 'Lasalgaon · chawl B' },
  { id: 'ONI-03', commodityId: 'ONI', quantityKg: 8000, remainingShelfLifeHours: 700, availableFromDay: 0, source: 'Yeola' },
  { id: 'CAP-01', commodityId: 'CAP', quantityKg: 3000, remainingShelfLifeHours: 78, availableFromDay: 0, source: 'Sinnar polyhouse' },
  { id: 'CAP-02', commodityId: 'CAP', quantityKg: 3500, remainingShelfLifeHours: 100, availableFromDay: 0, source: 'Sinnar polyhouse' },
  { id: 'CAP-03', commodityId: 'CAP', quantityKg: 3000, remainingShelfLifeHours: 150, availableFromDay: 1, source: 'Igatpuri · inbound D1' },
  { id: 'BAN-01', commodityId: 'BAN', quantityKg: 3000, remainingShelfLifeHours: 52, availableFromDay: 0, source: 'Jalgaon · ripening room' },
  { id: 'BAN-02', commodityId: 'BAN', quantityKg: 5000, remainingShelfLifeHours: 84, availableFromDay: 0, source: 'Jalgaon' },
  { id: 'BAN-03', commodityId: 'BAN', quantityKg: 4000, remainingShelfLifeHours: 130, availableFromDay: 1, source: 'Jalgaon · inbound D1' },
];

export interface MarketSpec {
  commodities: Commodity[];
  destinations: Destination[];
  market: Record<string, Record<string, [number, number]>>;
  horizonDays: number;
  dispatchHour: number;
  hubLoadHours: number;
  qtyPattern?: number[];
  pricePattern?: number[];
  demandScale?: number;
}

/**
 * Demand rows cover, for every destination, exactly the sessions that the
 * horizon's dispatch waves can reach on an undisrupted lane ("plannable demand").
 */
export function buildDemand(spec: MarketSpec): DemandRow[] {
  const shell = {
    dispatchHour: spec.dispatchHour,
    hub: { loadHours: spec.hubLoadHours },
  } as unknown as Scenario;
  const rows: DemandRow[] = [];
  const qp = spec.qtyPattern ?? QTY_PATTERN;
  const pp = spec.pricePattern ?? PRICE_PATTERN;
  for (const d of spec.destinations) {
    const first = saleSession(shell, { ...d, transitDelayByDay: undefined }, 0);
    for (const [commodityId, [qty, price]] of Object.entries(spec.market[d.id] ?? {})) {
      for (let i = 0; i < spec.horizonDays; i++) {
        rows.push({
          destId: d.id,
          commodityId,
          session: first + i,
          quantityKg: Math.round((qty * (spec.demandScale ?? 1) * qp[i % qp.length]) / 10) * 10,
          pricePerKg: Math.round(price * pp[i % pp.length] * 10) / 10,
        });
      }
    }
  }
  return rows;
}

export function baseScenario(): Scenario {
  const horizonDays = 4;
  const dispatchHour = 18;
  const hubLoadHours = 1;
  return {
    id: 'ordinary-day',
    name: 'Ordinary day',
    description:
      'Nashik hub, 22 batches across six crops, eight outlets, six 8-tonne trucks a night. Demand slightly exceeds supply overall, but the ripest lots can only reach nearby markets.',
    tests: 'Ordinary operating conditions',
    horizonDays,
    dispatchHour,
    hub: { id: 'HUB', name: 'Nashik consolidation hub', lat: 19.9975, lon: 73.7898, loadHours: hubLoadHours },
    commodities: structuredClone(COMMODITIES),
    batches: structuredClone(BASE_BATCHES),
    destinations: structuredClone(DESTINATIONS),
    demand: buildDemand({ commodities: COMMODITIES, destinations: DESTINATIONS, market: MARKET, horizonDays, dispatchHour, hubLoadHours, demandScale: 0.8 }),
    fleet: { truckCapacityKg: 8000, trucksPerDay: [6, 6, 6, 6] },
    discountTiers: [0.15, 0.3],
    uncertainty: { demandCv: 0.18, priceCv: 0.06 },
    synthetic: true,
  };
}
