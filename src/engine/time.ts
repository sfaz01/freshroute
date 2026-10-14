import type {
  Batch,
  Commodity,
  DemandRow,
  Destination,
  LaneOption,
  Scenario,
  TierOffer,
} from './types';

/** Tolerance (kg) under which quantities are treated as zero (absorbs solver round-off; 50 g). */
export const EPS_KG = 0.05;

export interface ScenarioIndex {
  scenario: Scenario;
  commodity: Map<string, Commodity>;
  batch: Map<string, Batch>;
  dest: Map<string, Destination>;
  demand: Map<string, DemandRow>;
  /** Highest session index that has any demand row. */
  lastSession: number;
}

export const demandKey = (destId: string, commodityId: string, session: number) =>
  `${destId}|${commodityId}|${session}`;

export function indexScenario(scenario: Scenario): ScenarioIndex {
  const demand = new Map<string, DemandRow>();
  let lastSession = 0;
  for (const row of scenario.demand) {
    demand.set(demandKey(row.destId, row.commodityId, row.session), row);
    if (row.session > lastSession) lastSession = row.session;
  }
  return {
    scenario,
    commodity: new Map(scenario.commodities.map((c) => [c.id, c])),
    batch: new Map(scenario.batches.map((b) => [b.id, b])),
    dest: new Map(scenario.destinations.map((d) => [d.id, d])),
    demand,
    lastSession,
  };
}

/** Hour at which the dispatch wave of `day` leaves the hub. */
export const departHour = (s: Scenario, day: number) => 24 * day + s.dispatchHour;

/** Door-to-floor lead time: hub loading + road + destination dock handling. */
export function leadHours(s: Scenario, dest: Destination, day: number): number {
  const delay = dest.transitDelayByDay?.[day] ?? 0;
  return s.hub.loadHours + dest.transitHours + delay + dest.dockHours;
}

/** Hour at which the load is on the market floor, ready for sale. */
export const readyHour = (s: Scenario, dest: Destination, day: number) =>
  departHour(s, day) + leadHours(s, dest, day);

/**
 * A market session keeps trading for this many hours after it opens; a load
 * ready within that window still sells in the session (later in the morning).
 */
export const SESSION_GRACE_HOURS = 3;

/** First market session the load can still sell in. */
export function saleSession(s: Scenario, dest: Destination, day: number): number {
  const ready = readyHour(s, dest, day);
  return Math.max(0, Math.ceil((ready - dest.marketOpenHour - SESSION_GRACE_HOURS) / 24 - 1e-9));
}

export const sessionHour = (dest: Destination, session: number) => 24 * session + dest.marketOpenHour;

/** Freshness thresholds a buyer applies to a commodity. */
export function lifeThresholds(c: Commodity, d: Destination) {
  const min = Math.max(2, c.minSaleLifeHours + d.freshnessOffsetHours);
  const full = Math.max(min, c.fullPriceLifeHours + d.freshnessOffsetHours);
  return { minSaleLifeHours: min, fullPriceLifeHours: full };
}

/**
 * Demand available at each price tier for one demand row.
 * Tier 0 is the stated demand at list price. Tier k ≥ 1 is the *incremental*
 * demand unlocked by markdown δ_k under constant elasticity ε:
 *   cap_k = D · appetite · [(1−δ_k)^(−ε) − (1−δ_{k−1})^(−ε)]
 */
export function tierOffers(s: Scenario, c: Commodity, d: Destination, row: DemandRow): TierOffer[] {
  const offers: TierOffer[] = [
    { tier: 0, discount: 0, pricePerKg: row.pricePerKg, capacityKg: row.quantityKg },
  ];
  let prev = 1;
  s.discountTiers.forEach((delta, i) => {
    const mult = Math.pow(1 - delta, -c.elasticity);
    const cap = row.quantityKg * d.markdownAppetite * (mult - prev);
    prev = mult;
    offers.push({
      tier: i + 1,
      discount: delta,
      pricePerKg: row.pricePerKg * (1 - delta),
      capacityKg: Math.max(0, cap),
    });
  });
  return offers;
}

export function isLaneOpen(_s: Scenario, dest: Destination, day: number): boolean {
  if (dest.closedDays?.includes(day)) return false;
  if (dest.maxTrucksPerDay !== undefined && dest.maxTrucksPerDay <= 0) return false;
  return true;
}

/**
 * The single place where "can batch b be sold at destination d if it leaves on
 * day t?" is decided. Used by the optimiser, the baseline, the ledger and the
 * explanations so that all four agree.
 */
export function evaluateOption(
  ix: ScenarioIndex,
  batch: Batch,
  dest: Destination,
  day: number,
  /** For loads that have already left: skip the "can it still be dispatched?" gates. */
  alreadyDispatched = false,
): LaneOption {
  const s = ix.scenario;
  const c = ix.commodity.get(batch.commodityId)!;
  const depart = departHour(s, day);
  const ready = readyHour(s, dest, day);
  const session = saleSession(s, dest, day);
  // Shelf life is judged when the lot is offered: at the open, or on arrival if it arrives during the session.
  const saleHour = Math.max(sessionHour(dest, session), ready);
  const life = batch.remainingShelfLifeHours - saleHour;
  const th = lifeThresholds(c, dest);
  const base: LaneOption = {
    batchId: batch.id,
    destId: dest.id,
    day,
    feasible: false,
    departHour: depart,
    readyHour: ready,
    session,
    saleHour,
    lifeAtSaleHours: life,
    minSaleLifeHours: th.minSaleLifeHours,
    fullPriceLifeHours: th.fullPriceLifeHours,
    tiers: [],
  };
  if (!alreadyDispatched) {
    if (batch.availableFromDay > day) return { ...base, code: 'not_available' };
    if (!isLaneOpen(s, dest, day)) return { ...base, code: 'lane_closed' };
    if ((s.fleet.trucksPerDay[day] ?? 0) <= 0) return { ...base, code: 'no_fleet' };
  }
  const row = ix.demand.get(demandKey(dest.id, batch.commodityId, session));
  if (!row || row.quantityKg <= 0) return { ...base, code: 'no_market' };
  if (life < th.minSaleLifeHours) return { ...base, code: 'shelf_life' };
  const grade = life >= th.fullPriceLifeHours ? 'A' : 'B';
  const tiers = tierOffers(s, c, dest, row).filter(
    (t) => t.capacityKg > EPS_KG && (grade === 'A' || t.tier >= 1),
  );
  if (tiers.length === 0) {
    // A grade-B lot offered to a buyer with no markdown appetite cannot be sold.
    return { ...base, grade, code: 'shelf_life' };
  }
  return { ...base, feasible: true, grade, tiers };
}

/** Human-readable clock label, e.g. "D1 05:00". */
export function clock(hour: number): string {
  const day = Math.floor(hour / 24 + 1e-9);
  const h = hour - day * 24;
  const hh = Math.floor(h + 1e-9);
  const mm = Math.round((h - hh) * 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `D${day} ${pad(mm === 60 ? hh + 1 : hh)}:${pad(mm === 60 ? 0 : mm)}`;
}
