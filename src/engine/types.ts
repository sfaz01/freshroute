/**
 * FreshRoute data model.
 *
 * Time convention: hour 0 is 00:00 on day 0 (the planning day, "D0").
 * - The dispatch wave of day t leaves the hub at hour 24·t + dispatchHour.
 * - The market session s at a destination opens at hour 24·s + marketOpenHour.
 * - A batch expires at hour `remainingShelfLifeHours` (measured from hour 0).
 * All quantities are kilograms, all money is rupees.
 */

export interface Commodity {
  id: string;
  name: string;
  /** Loading + unloading cost for every kg dispatched. */
  handlingCostPerKg: number;
  /** Cost booked for every kg that spoils (write-off + disposal), as defined by the dataset. */
  spoilageCostPerKg: number;
  /** Value of a kg still viable at the end of the horizon (0 for short-life produce). */
  carryValuePerKg: number;
  /** Below this remaining life at the point of sale the lot is rejected. */
  minSaleLifeHours: number;
  /** Below this remaining life at the point of sale the lot only sells at a markdown. */
  fullPriceLifeHours: number;
  /** Price elasticity of demand used to size markdown demand. */
  elasticity: number;
  /** Coefficient of variation of the shelf-life estimate (stress tests only). */
  shelfLifeCv: number;
}

export interface Batch {
  id: string;
  commodityId: string;
  quantityKg: number;
  /** Estimated remaining shelf life at hour 0. */
  remainingShelfLifeHours: number;
  /** First dispatch day on which the batch is physically at the hub. */
  availableFromDay: number;
  /** Free-text provenance label (farm cluster, lot note). */
  source?: string;
}

export type DestinationType = 'mandi' | 'retail_dc' | 'processor';

export interface Destination {
  id: string;
  name: string;
  short: string;
  type: DestinationType;
  lat: number;
  lon: number;
  /** Road time hub → destination. */
  transitHours: number;
  /** Unloading / gate / auction-floor handling time at the destination. */
  dockHours: number;
  /** Hour of day at which the daily market session opens. */
  marketOpenHour: number;
  costPerTruck: number;
  costPerKg: number;
  maxTrucksPerDay?: number;
  /** Dispatch days on which the lane is closed. */
  closedDays?: number[];
  /** Extra transit hours for the dispatch wave of a given day (index = day). */
  transitDelayByDay?: number[];
  /** Contract penalty per kg of full-price demand left unserved. */
  shortfallPenaltyPerKg: number;
  /** Multiplier on markdown demand (0 = buyer never takes discounted surplus). */
  markdownAppetite: number;
  /** Added to both commodity freshness thresholds for this buyer (may be negative). */
  freshnessOffsetHours: number;
  /** Coefficient of variation of transit time (stress tests only). */
  transitCv: number;
  /**
   * A salvage outlet (processor, pulp unit) absorbs whatever is offered up to its
   * capacity at a low price. It places no orders, so it is excluded from the
   * demand-fulfilment metric; its purchases still count as revenue.
   */
  salvageOutlet?: boolean;
}

export interface DemandRow {
  destId: string;
  commodityId: string;
  /** Market session (day index of the session). */
  session: number;
  quantityKg: number;
  pricePerKg: number;
}

export interface Fleet {
  truckCapacityKg: number;
  /** Trucks available for the dispatch wave of each day (index = day). */
  trucksPerDay: number[];
}

export interface UncertaintySpec {
  demandCv: number;
  priceCv: number;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  /** Free-text note on what this scenario is meant to exercise. */
  tests?: string;
  horizonDays: number;
  dispatchHour: number;
  hub: { id: string; name: string; lat: number; lon: number; loadHours: number };
  commodities: Commodity[];
  batches: Batch[];
  destinations: Destination[];
  demand: DemandRow[];
  fleet: Fleet;
  /** Markdown tiers as fractions off list price, ascending (e.g. [0.15, 0.30]). */
  discountTiers: number[];
  uncertainty: UncertaintySpec;
  synthetic: boolean;
}

/* ───────────────────────────── plans ───────────────────────────── */

export interface Shipment {
  batchId: string;
  destId: string;
  day: number;
  quantityKg: number;
}

export type PlanMethod = 'optimizer' | 'baseline-fefo' | 'baseline-fefo-clearance' | 'manual';

export interface Plan {
  label: string;
  method: PlanMethod;
  shipments: Shipment[];
}

/* ─────────────────────── feasibility of an option ─────────────────────── */

export type Grade = 'A' | 'B';

export type InfeasibleCode =
  | 'not_available'
  | 'lane_closed'
  | 'no_fleet'
  | 'no_market'
  | 'shelf_life'
  | 'committed_past';

export interface TierOffer {
  /** 0 = list price, k ≥ 1 = markdown tier k. */
  tier: number;
  discount: number;
  pricePerKg: number;
  capacityKg: number;
}

export interface LaneOption {
  batchId: string;
  destId: string;
  day: number;
  feasible: boolean;
  code?: InfeasibleCode;
  departHour: number;
  readyHour: number;
  session: number;
  saleHour: number;
  /** Remaining shelf life when the session opens. */
  lifeAtSaleHours: number;
  minSaleLifeHours: number;
  fullPriceLifeHours: number;
  grade?: Grade;
  /** Tiers this lot may be sold in (empty if infeasible). */
  tiers: TierOffer[];
}

/* ───────────────────────────── ledger ───────────────────────────── */

export type ViolationCode =
  | 'unknown_ref'
  | 'stock'
  | 'not_available'
  | 'lane_closed'
  | 'capacity'
  | 'no_market'
  | 'shelf_life'
  | 'oversupply';

export interface Violation {
  code: ViolationCode;
  message: string;
  batchId?: string;
  destId?: string;
  day?: number;
  quantityKg: number;
}

export interface TierSale {
  tier: number;
  discount: number;
  quantityKg: number;
  pricePerKg: number;
}

export interface SettlementLine {
  batchId: string;
  commodityId: string;
  destId: string;
  day: number;
  requestedKg: number;
  /** Quantity that physically left the hub. */
  shippedKg: number;
  departHour: number;
  readyHour: number;
  session: number;
  saleHour: number;
  lifeAtSaleHours: number;
  grade: Grade | 'rejected';
  sales: TierSale[];
  soldKg: number;
  wastedKg: number;
  revenue: number;
  listValue: number;
  handlingCost: number;
  /** Per-kg freight plus this line's pro-rata share of the lane's truck cost. */
  transportCost: number;
  note?: string;
}

export interface TruckLoad {
  destId: string;
  day: number;
  trucks: number;
  loadKg: number;
  capacityKg: number;
  cost: number;
}

export interface BatchResult {
  batchId: string;
  commodityId: string;
  quantityKg: number;
  shippedKg: number;
  soldKg: number;
  wastedAtDestKg: number;
  leftoverKg: number;
  leftoverClass: 'none' | 'spoiled' | 'carried';
}

export interface DemandResult {
  destId: string;
  commodityId: string;
  session: number;
  demandKg: number;
  pricePerKg: number;
  fullPriceSoldKg: number;
  markdownSoldKg: number;
  shortfallKg: number;
}

export interface Totals {
  inventoryKg: number;
  /** List-price demand placed by customers (salvage outlets excluded). */
  demandKg: number;
  shippedKg: number;
  soldKg: number;
  /** Sold at list price, any outlet. */
  fullPriceSoldKg: number;
  /** Customer demand served at list price (salvage outlets excluded). */
  servedDemandKg: number;
  /** Sold to salvage outlets. */
  salvageSoldKg: number;
  markdownSoldKg: number;
  spoiledAtHubKg: number;
  spoiledAtDestKg: number;
  spoiledKg: number;
  carriedKg: number;
  shortfallKg: number;
  trucksUsed: number;
  /** spoiledKg / inventoryKg */
  spoilageRate: number;
  /** servedDemandKg / demandKg */
  fulfilment: number;
  /** Lowest fill rate across destinations that have demand. */
  minDestinationFill: number;
  revenue: number;
  listValue: number;
  discountGiven: number;
  transportCost: number;
  handlingCost: number;
  spoilageCost: number;
  shortfallPenalty: number;
  carryValue: number;
  /** revenue − transport − handling − spoilage − shortfall + carry */
  net: number;
}

export interface Outcome {
  lines: SettlementLine[];
  trucks: TruckLoad[];
  batches: BatchResult[];
  demand: DemandResult[];
  totals: Totals;
  violations: Violation[];
  feasible: boolean;
}

/* ───────────────────────── operator overrides ───────────────────────── */

export type Pin =
  | { kind: 'force'; batchId: string; destId: string; day?: number; minKg: number; note?: string }
  | { kind: 'ban'; batchId?: string; destId: string; day?: number; note?: string };

/* ───────────────────────────── issues ───────────────────────────── */

export interface Issue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}
