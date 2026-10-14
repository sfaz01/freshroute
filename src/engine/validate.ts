import type { Batch, Commodity, DemandRow, Destination, Issue, Scenario } from './types';

/**
 * Validates and repairs an untrusted scenario (e.g. an imported JSON file).
 *
 * Errors make the scenario unusable (nothing sensible can be planned).
 * Warnings describe a documented repair: a row dropped, a value defaulted,
 * duplicates merged. The repaired scenario is returned together with every
 * issue so the operator can see exactly what was changed.
 */
export interface ValidationResult {
  scenario: Scenario | null;
  issues: Issue[];
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export function validateScenario(raw: unknown): ValidationResult {
  const issues: Issue[] = [];
  const err = (path: string, message: string) => issues.push({ severity: 'error', path, message });
  const warn = (path: string, message: string) => issues.push({ severity: 'warning', path, message });

  if (!isObj(raw)) {
    err('$', 'Scenario must be a JSON object.');
    return { scenario: null, issues };
  }

  /**
   * Reads a number. `def === null` means required: a missing/invalid value is an
   * error, or — with `rowLevel` — a warning, and the caller drops the row.
   */
  const num = (
    obj: Record<string, unknown>,
    key: string,
    path: string,
    def: number | null,
    opts: { min?: number; int?: boolean; rowLevel?: boolean } = {},
  ): number | null => {
    const fail = opts.rowLevel ? warn : err;
    let v = obj[key];
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
      warn(`${path}.${key}`, `Numeric text "${v}" converted to a number.`);
      v = Number(v);
    }
    if (!fin(v)) {
      if (def === null) {
        fail(`${path}.${key}`, v === undefined ? 'Missing required number.' : `Not a valid number (${JSON.stringify(v)}).`);
        return null;
      }
      if (v !== undefined) warn(`${path}.${key}`, `Invalid value ${JSON.stringify(v)}; using default ${def}.`);
      return def;
    }
    if (opts.min !== undefined && v < opts.min) {
      if (def === null) {
        fail(`${path}.${key}`, `Must be ≥ ${opts.min} (got ${v}).`);
        return null;
      }
      warn(`${path}.${key}`, `Must be ≥ ${opts.min} (got ${v}); using ${def}.`);
      return def;
    }
    if (opts.int && !Number.isInteger(v)) {
      warn(`${path}.${key}`, `Rounded ${v} to ${Math.round(v)}.`);
      return Math.round(v);
    }
    return v;
  };
  const str = (obj: Record<string, unknown>, key: string, path: string, def?: string): string | null => {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
    if (def !== undefined) return def;
    err(`${path}.${key}`, 'Missing required text.');
    return null;
  };

  const horizonDays = num(raw, 'horizonDays', '$', null, { min: 1, int: true });
  const dispatchHour = num(raw, 'dispatchHour', '$', 18, { min: 0 });

  /* commodities */
  const commodities: Commodity[] = [];
  const rawCommodities = Array.isArray(raw.commodities) ? raw.commodities : [];
  if (!Array.isArray(raw.commodities)) err('$.commodities', 'Missing commodity list.');
  rawCommodities.forEach((c, i) => {
    const p = `$.commodities[${i}]`;
    if (!isObj(c)) return warn(p, 'Not an object; dropped.');
    const id = str(c, 'id', p);
    if (!id) return;
    if (commodities.some((x) => x.id === id)) return warn(p, `Duplicate commodity id "${id}"; later entry dropped.`);
    const minLife = num(c, 'minSaleLifeHours', p, 12, { min: 0 })!;
    let fullLife = num(c, 'fullPriceLifeHours', p, minLife, { min: 0 })!;
    if (fullLife < minLife) {
      warn(`${p}.fullPriceLifeHours`, `List-price freshness (${fullLife} h) below minimum sale life (${minLife} h); raised to ${minLife} h.`);
      fullLife = minLife;
    }
    commodities.push({
      id,
      name: str(c, 'name', p, id)!,
      handlingCostPerKg: num(c, 'handlingCostPerKg', p, 0, { min: 0 })!,
      spoilageCostPerKg: num(c, 'spoilageCostPerKg', p, 0, { min: 0 })!,
      carryValuePerKg: num(c, 'carryValuePerKg', p, 0, { min: 0 })!,
      minSaleLifeHours: minLife,
      fullPriceLifeHours: fullLife,
      elasticity: num(c, 'elasticity', p, 1, { min: 0 })!,
      shelfLifeCv: num(c, 'shelfLifeCv', p, 0.1, { min: 0 })!,
    });
  });
  if (rawCommodities.length && !commodities.length) err('$.commodities', 'No valid commodities.');
  const cIds = new Set(commodities.map((c) => c.id));

  /* destinations */
  const destinations: Destination[] = [];
  const rawDest = Array.isArray(raw.destinations) ? raw.destinations : [];
  if (!Array.isArray(raw.destinations)) err('$.destinations', 'Missing destination list.');
  rawDest.forEach((d, i) => {
    const p = `$.destinations[${i}]`;
    if (!isObj(d)) return warn(p, 'Not an object; dropped.');
    const id = str(d, 'id', p);
    if (!id) return;
    if (destinations.some((x) => x.id === id)) return warn(p, `Duplicate destination id "${id}"; later entry dropped.`);
    const transit = num(d, 'transitHours', p, null, { min: 0, rowLevel: true });
    if (transit === null) return warn(p, `Destination "${id}" has no usable transit time; dropped.`);
    const type = d.type === 'retail_dc' || d.type === 'processor' ? d.type : 'mandi';
    destinations.push({
      id,
      name: str(d, 'name', p, id)!,
      short: str(d, 'short', p, str(d, 'name', p, id)!)!,
      type,
      lat: num(d, 'lat', p, 0)!,
      lon: num(d, 'lon', p, 0)!,
      transitHours: transit,
      dockHours: num(d, 'dockHours', p, 1, { min: 0 })!,
      marketOpenHour: num(d, 'marketOpenHour', p, 6, { min: 0 })!,
      costPerTruck: num(d, 'costPerTruck', p, 0, { min: 0 })!,
      costPerKg: num(d, 'costPerKg', p, 0, { min: 0 })!,
      maxTrucksPerDay: d.maxTrucksPerDay === undefined ? undefined : num(d, 'maxTrucksPerDay', p, 0, { min: 0, int: true })!,
      closedDays: Array.isArray(d.closedDays) ? d.closedDays.filter(fin) : undefined,
      transitDelayByDay: Array.isArray(d.transitDelayByDay) ? d.transitDelayByDay.map((x) => (fin(x) ? x : 0)) : undefined,
      shortfallPenaltyPerKg: num(d, 'shortfallPenaltyPerKg', p, 0, { min: 0 })!,
      markdownAppetite: num(d, 'markdownAppetite', p, type === 'mandi' ? 0.6 : 0, { min: 0 })!,
      freshnessOffsetHours: num(d, 'freshnessOffsetHours', p, 0)!,
      transitCv: num(d, 'transitCv', p, 0.1, { min: 0 })!,
      salvageOutlet: d.salvageOutlet === true || (d.salvageOutlet === undefined && type === 'processor'),
    });
  });
  const dIds = new Set(destinations.map((d) => d.id));

  /* batches */
  const batches: Batch[] = [];
  const rawBatches = Array.isArray(raw.batches) ? raw.batches : [];
  if (!Array.isArray(raw.batches)) err('$.batches', 'Missing batch list.');
  rawBatches.forEach((b, i) => {
    const p = `$.batches[${i}]`;
    if (!isObj(b)) return warn(p, 'Not an object; dropped.');
    const id = str(b, 'id', p, `BATCH-${i + 1}`)!;
    if (batches.some((x) => x.id === id)) return warn(p, `Duplicate batch id "${id}"; later entry dropped.`);
    const commodityId = str(b, 'commodityId', p, '')!;
    if (!cIds.has(commodityId)) return warn(p, `Batch "${id}" refers to unknown commodity "${commodityId}"; dropped.`);
    const qty = num(b, 'quantityKg', p, null, { rowLevel: true });
    if (qty === null) return warn(p, `Batch "${id}" has no usable quantity; dropped.`);
    if (qty <= 0) return warn(p, `Batch "${id}" has non-positive quantity ${qty}; dropped.`);
    const life = num(b, 'remainingShelfLifeHours', p, null, { rowLevel: true });
    if (life === null) return warn(p, `Batch "${id}" has no shelf-life estimate; dropped (cannot be planned safely).`);
    if (life <= 0) warn(`${p}.remainingShelfLifeHours`, `Batch "${id}" is already expired (${life} h); it will be counted as spoilage.`);
    const avail = num(b, 'availableFromDay', p, 0, { min: 0, int: true })!;
    batches.push({ id, commodityId, quantityKg: qty, remainingShelfLifeHours: life, availableFromDay: avail, source: typeof b.source === 'string' ? b.source : undefined });
  });
  if (rawBatches.length && !batches.length) err('$.batches', 'No valid batches.');

  /* demand */
  const demand: DemandRow[] = [];
  const rawDemand = Array.isArray(raw.demand) ? raw.demand : [];
  if (!Array.isArray(raw.demand)) err('$.demand', 'Missing demand list.');
  rawDemand.forEach((r, i) => {
    const p = `$.demand[${i}]`;
    if (!isObj(r)) return warn(p, 'Not an object; dropped.');
    const destId = str(r, 'destId', p, '')!;
    const commodityId = str(r, 'commodityId', p, '')!;
    if (!dIds.has(destId)) return warn(p, `Unknown destination "${destId}"; row dropped.`);
    if (!cIds.has(commodityId)) return warn(p, `Unknown commodity "${commodityId}"; row dropped.`);
    const session = num(r, 'session', p, null, { min: 0, int: true, rowLevel: true });
    const q = num(r, 'quantityKg', p, null, { min: 0, rowLevel: true });
    const price = num(r, 'pricePerKg', p, null, { min: 0, rowLevel: true });
    if (session === null || q === null || price === null) return warn(p, 'Incomplete demand row; dropped.');
    if (price === 0) warn(`${p}.pricePerKg`, 'Zero price: this demand will never be worth serving.');
    const dup = demand.find((x) => x.destId === destId && x.commodityId === commodityId && x.session === session);
    if (dup) {
      const total = dup.quantityKg + q;
      dup.pricePerKg = total > 0 ? (dup.pricePerKg * dup.quantityKg + price * q) / total : dup.pricePerKg;
      dup.quantityKg = total;
      return warn(p, `Duplicate demand for ${destId}/${commodityId}/session ${session}; merged (quantities summed, price quantity-weighted).`);
    }
    demand.push({ destId, commodityId, session, quantityKg: q, pricePerKg: price });
  });

  /* fleet */
  let truckCapacityKg = 0;
  let trucksPerDay: number[] = [];
  if (!isObj(raw.fleet)) err('$.fleet', 'Missing fleet definition.');
  else {
    truckCapacityKg = num(raw.fleet, 'truckCapacityKg', '$.fleet', null, { min: 1 }) ?? 0;
    const tpd = raw.fleet.trucksPerDay;
    if (fin(tpd)) trucksPerDay = Array.from({ length: horizonDays ?? 1 }, () => Math.max(0, Math.round(tpd)));
    else if (Array.isArray(tpd)) trucksPerDay = tpd.map((x, i) => {
      if (!fin(x) || x < 0) {
        warn(`$.fleet.trucksPerDay[${i}]`, `Invalid truck count ${JSON.stringify(x)}; using 0.`);
        return 0;
      }
      return Math.round(x);
    });
    else err('$.fleet.trucksPerDay', 'Missing trucks per day.');
  }
  if (horizonDays !== null && trucksPerDay.length < horizonDays && trucksPerDay.length > 0) {
    warn('$.fleet.trucksPerDay', `Only ${trucksPerDay.length} day(s) given for a ${horizonDays}-day horizon; last value repeated.`);
    while (trucksPerDay.length < horizonDays) trucksPerDay.push(trucksPerDay[trucksPerDay.length - 1]);
  }

  /* discount tiers */
  let discountTiers = [0.15, 0.3];
  if (raw.discountTiers !== undefined) {
    const t = Array.isArray(raw.discountTiers) ? raw.discountTiers.filter((x) => fin(x) && x > 0 && x < 1) : [];
    if (!Array.isArray(raw.discountTiers) || t.length !== raw.discountTiers.length) warn('$.discountTiers', 'Invalid markdown tiers removed (each must be between 0 and 1).');
    discountTiers = [...new Set(t as number[])].sort((a, b) => a - b);
  }

  if (!demand.length && rawDemand.length) warn('$.demand', 'No usable demand rows: nothing can be sold.');

  const hub = isObj(raw.hub) ? raw.hub : {};
  const unc = isObj(raw.uncertainty) ? raw.uncertainty : {};
  if (issues.some((i) => i.severity === 'error') || horizonDays === null) return { scenario: null, issues };

  return {
    scenario: {
      id: str(raw, 'id', '$', 'imported')!,
      name: str(raw, 'name', '$', 'Imported scenario')!,
      description: str(raw, 'description', '$', 'Imported from JSON.')!,
      tests: typeof raw.tests === 'string' ? raw.tests : undefined,
      horizonDays,
      dispatchHour: dispatchHour!,
      hub: {
        id: str(hub, 'id', '$.hub', 'HUB')!,
        name: str(hub, 'name', '$.hub', 'Hub')!,
        lat: num(hub, 'lat', '$.hub', 0)!,
        lon: num(hub, 'lon', '$.hub', 0)!,
        loadHours: num(hub, 'loadHours', '$.hub', 1, { min: 0 })!,
      },
      commodities,
      batches,
      destinations,
      demand,
      fleet: { truckCapacityKg, trucksPerDay },
      discountTiers,
      uncertainty: { demandCv: num(unc, 'demandCv', '$.uncertainty', 0.15, { min: 0 })!, priceCv: num(unc, 'priceCv', '$.uncertainty', 0.05, { min: 0 })! },
      synthetic: raw.synthetic !== false,
    },
    issues,
  };
}
