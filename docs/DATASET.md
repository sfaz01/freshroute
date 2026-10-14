# The FreshRoute dataset

**Status: synthetic, as permitted by the hackathon.** No official PS 03 dataset was provided. This document explains what the
bundled dataset contains, what is real, what is invented, how the invented values were chosen and checked against public
figures, and where they were deliberately set conservatively so that results are not inflated.

Source code: `src/engine/scenarios/base.ts` (reference dataset) and `src/engine/scenarios/catalog.ts` (scenario variants and
the random generator). Every value can also be inspected in the app (*Data & assumptions*) or exported as JSON.

## 1. What is real and what is invented

| Element | Real or synthetic | Notes |
|---|---|---|
| Hub location (Nashik) and the eight outlet cities | **Real** | City coordinates. Nashik is India's main onion and table-grape belt. |
| Road times from Nashik to each outlet | **Approximately real** | From approximate road distances at a loaded-truck average of ~40–45 km/h; not measured trips. |
| Crops | **Realistic** | Tomato, grapes, coriander, onion, capsicum, banana — all traded out of the Nashik region. |
| Batches, quantities, shelf lives, farm-cluster labels | Synthetic | 22 batches, 120 t, chosen to create real trade-offs (see §5). |
| Demand per market per day, prices | Synthetic | Scaled to the size of each market; prices checked against public mandi data (§3). |
| Freight, handling, spoilage and carry-over costs | Synthetic | Checked against public freight quotes (§4). |
| Freshness thresholds, markdown response, uncertainty ranges | Synthetic | Judgement, checked against post-harvest literature where available (§6). |
| Buyer names ("FreshKart DC", "Nashik Agro Processors") | Fictional | Not real companies. |

## 2. Structure

| Table | Rows | Fields |
|---|---|---|
| `commodities` | 6 | handling ₹/kg, spoilage ₹/kg, carry-over value ₹/kg, minimum sale life h, list-price life h, markdown elasticity, shelf-life uncertainty |
| `batches` | 22 | commodity, kg, remaining shelf life (hours from D0 00:00), first day at hub, provenance label |
| `destinations` | 8 | type, coordinates, transit h, dock h, market opening hour, ₹ per truck, ₹ per kg, contract shortfall penalty, markdown appetite, freshness offset, transit uncertainty, salvage flag |
| `demand` | 164 | outlet × commodity × market session: kg and ₹/kg |
| `fleet` | — | 8,000 kg trucks, 6 per night for 4 nights |
| `discountTiers` | 2 | −15 % and −30 % |

Planning horizon: 4 dispatch nights (D0–D3), trucks leave at 18:00 after 1 h of loading.

## 3. Prices (₹/kg, wholesale)

| Commodity | Range used (by outlet) | Public reference | Assessment |
|---|---|---|---|
| Tomato | 23–34 (processor 9) | Delhi Azadpur, 2025: ₹4–24 (June) to ₹12–52 (August) | Inside a very volatile range |
| Grapes | 64–92 (processor 30) | Azadpur 2026: ₹94–104; Nashik Thompson Seedless A-grade trader listing ₹80 | Slightly **below** market — conservative |
| Onion | 15–20 | Azadpur 2025: ₹5–20 | **Corrected** from 18–24 (was at the top of the range) |
| Capsicum | 26–40 | Azadpur 2025: ₹15–40 | **Corrected** from 38–58 (was too high) |
| Coriander | 40–56 | No reliable public wholesale series found; highly volatile | Judgement |
| Banana | 22–30 (processor 10) | No reliable source found | Judgement |

- Delhi carries the highest prices and the longest trip; the FreshKart retail contract pays a premium; Surat and Pune pay slightly less.
- A deterministic day-of-week pattern varies quantities (±10 %) and prices (±3 %) across sessions.
- Prices are fixed inputs per market session. Real mandi prices are set by auction and move daily; the stress test perturbs them (±6 %).

## 4. Transport and handling costs

| Lane (from Nashik) | Approx. distance | Transit used | ₹ per 8-t truck | ≈ ₹/km |
|---|---|---|---|---|
| Processor (local) | ~25 km | 1 h | 1,800 | short-haul minimum |
| Mumbai (Vashi APMC) | ~170 km | 5 h | 7,500 | ~44 |
| FreshKart DC (Mumbai) | ~175 km | 5.5 h | 8,000 | ~46 |
| Pune | ~210 km | 6 h | 8,500 | ~40 |
| Surat | ~240 km | 7 h | 10,000 | ~42 |
| Ahmedabad | ~450 km | 10 h | 17,000 | ~38 |
| Hyderabad | ~650 km | 16 h | 24,000 | ~37 |
| Delhi (Azadpur) | ~1,250 km | 30 h | 44,000 | ~35 |

Public references: indicative Indian rates of ₹20–30/km for a 9–11 t truck and ₹25–40/km for 16–20 t; 2025 benchmarks of
₹22–32/km; Mumbai–Delhi online quotes equivalent to ~₹33–42/km. The values used sit at the upper end, with a premium on short
hauls (common in practice), so freight is **not understated**. Distances are approximate road distances, not measured.

Handling (loading + unloading): ₹0.8–2.5/kg depending on crop. Destination dock time: 0.5–2 h.

## 5. Inventory and demand

- **Inventory:** 22 batches, 120.4 t, of which 90.4 t is at the hub on D0 and the rest arrives on D1–D2. Tomato 40 t, onion 32 t,
  grapes 21 t, banana 12 t, capsicum 9.5 t, coriander 5.9 t.
- **Customer demand:** about 128 t of list-price orders over the horizon (salvage outlet excluded), i.e. supply and demand are
  roughly balanced overall, but not crop by crop or day by day.
- **Deliberate stress:** the reference day contains near-expiry lots (a ripe tomato lot, grapes from a failing cold room, a
  ripening-room banana lot), one coriander lot that cannot reach any buyer in time, and a fleet that carries 48 t on D0 while 90 t
  sits at the hub. Without such tension there would be nothing to decide; the "Little headroom" scenario shows the opposite case.
- **Demand window:** each market only has orders for the sessions that the horizon's trucks can reach (so demand that no plan could
  ever serve is not counted against fulfilment).

## 6. Shelf life and freshness

| Commodity | Remaining life of batches | Min. life to sell | Min. life for list price | Public reference |
|---|---|---|---|---|
| Tomato | 54–150 h (2–6 days) | 18 h | 42 h | Half-ripe tomatoes deteriorate from ~day 4 at ambient; 14 days in evaporative cool chambers |
| Grapes | 66–168 h | 24 h | 60 h | Cold-stored at the hub; one lot from a failing cold room |
| Coriander | 34–98 h; **≈2 days on arrival at the hub** | 8 h | 20 h | 24–48 h at ambient, up to 72 h in high-humidity storage (IIHR); **corrected** from up to 100 h |
| Onion | 400–700 h | 48 h | 120 h | Stores for months in ventilated chawls; values are conservative |
| Capsicum | 78–150 h | 18 h | 48 h | No reliable public figure found; judgement (3–6 days ambient) |
| Banana | 52–130 h | 18 h | 40 h | ~6 days in evaporative cool chambers; ripening lots shorter |

Retail DC buyers require 24 h more remaining life than mandis; the processor accepts almost anything.

## 7. Spoilage, carry-over and contract costs

- **Spoilage cost (₹/kg written off):** roughly procurement cost + disposal — tomato 14, grapes 46, coriander 20, onion 11,
  capsicum 18, banana 15. Always below the list price, so a sale is always preferred to spoilage when it covers freight.
- **Carry-over value:** only onion (₹10/kg), the one crop still sellable after the 4-day horizon; it is valued, not counted as spoiled.
- **Contract shortfall penalty:** FreshKart DC only, ₹6/kg of unserved list-price demand.

## 8. Markdown response (the key assumption)

A markdown of δ unlocks extra demand `D · appetite · [(1−δ)^(−ε) − 1]` with elasticity ε = 0.9 (onion) to 2.0 (grapes).
- The appetite factor was **reduced to 0.6 for mandis** (0.5 for Surat; 0 for the retail DC and processor) during development to
  avoid overstating how much stock discounts can clear.
- Example: Mumbai tomato, 2,400 kg/session of list-price demand, gets about +430 kg at −15 % and +680 kg more at −30 %.
- The *Thin markdown demand* scenario cuts the appetite to a quarter: FreshRoute's net advantage over the clearance baseline falls
  from +₹6.7 L to +₹3.4 L on the reference day. No public estimate of this response for Indian mandis was found.

## 9. Uncertainty ranges (stress test only)

Shelf life ±8 % (onion) to ±20 % (coriander) per batch; transit ±5 % (processor) to ±14 % (Delhi) per lane-night, right-skewed;
demand ±18 % and price ±6 % per market session. All draws are seeded, so stress tests are reproducible.

## 10. How the results relate to national loss figures

The NABCONS study for MoFPI (2020–22) reports total post-harvest losses of about 11.6 % for tomato, 7.6 % for banana and
7.3 % for onion, of which only ~2–3.3 percentage points occur at the market stage.

The reference day's baseline spoilage (15.4 % FEFO, 10.1 % FEFO + clearance) is **higher** than those market-stage figures
because the day was deliberately built around distressed lots (§5). The absolute spoilage percentages in this project should therefore
**not** be read as estimates of real-world losses; the meaningful number is the **difference between plans on the same data**.

## 11. Scenario variants and random scenarios

The 11 named scenarios are explicit transformations of the reference dataset (larger or smaller batches, fewer trucks, 35 % shorter
shelf life, lane delays, demand shocks, freight +70 %, markdown appetite ×0.25, a single-market case and lane closures). See
`catalog.ts` and *docs/EVALUATION.md*.

The 30 random scenarios redraw batch count (14–26), sizes, shelf lives (×0.8–1.3 of the reference crop values), arrival days,
fleet (4–7 trucks) and demand (×0.7–1.3, prices ±12 %) from a seeded generator on the same crops and outlets.

## 12. Using a different dataset

Export the current scenario from *Data & assumptions → Import / export* to get a template, edit or replace the values, and import
it. Each row is validated; invalid rows are dropped or repaired with a line-by-line report. For a dataset in another format (e.g.
CSV tables from organisers), a small converter to this JSON structure is all that is needed — the engine, baselines, ledger and
evaluation run unchanged.

## Corrections made after checking public data

| Change | Before | After | Reason |
|---|---|---|---|
| Capsicum wholesale prices | ₹38–58/kg | ₹26–40/kg | Azadpur 2025 range ₹15–40 |
| Capsicum spoilage cost | ₹26/kg | ₹18/kg | Kept below the corrected price |
| Onion wholesale prices | ₹18–24/kg | ₹15–20/kg | Azadpur 2025 range ₹5–20 |
| Onion spoilage / carry-over | ₹13 / ₹12 per kg | ₹11 / ₹10 per kg | Kept consistent with the corrected price |
| Coriander shelf life | up to 100 h | ≈2 days on arrival at the hub | 24–72 h ambient (IIHR) |

All tests and the evaluation were re-run after these corrections; every figure in the README and *docs/EVALUATION.md* reflects
the corrected data.

## Sources

- NABCONS post-harvest loss figures, as reported in [FreshPlaza](https://www.freshplaza.com/asia/article/9756104/india-reports-high-guava-and-tomato-losses/) and [Global Agriculture](https://www.global-agriculture.com/india-region/indias-highest-post-harvest-losses-guava-and-tomato-among-the-worst-hit/), and Parliament answers ([Rajya Sabha, Feb 2025](https://rsdebate.nic.in/bitstream/123456789/758453/1/PQ_267_07022025_U572_p312_p312.pdf))
- Delhi Food & Supplies Department, Azadpur weekly vegetable prices: [25 June 2025](https://fsd.delhi.gov.in/sites/default/files/FS/universal-tab/essential_vegetables-25-06-25.pdf), [13 August 2025](https://fsd.delhi.gov.in/sites/default/files/FS/universal-tab/vegetable_end_on_13_aug_2025.pdf)
- Grapes: [Azadpur rates (ACROP, from Agmarknet)](https://acrop.app/mandi/delhi/shahdara/azadpur/grapes), [Nashik trader listing](https://m.indiamart.com/the-parth-enterprises)
- Freight: [ABC Transport — per-km charges](https://abctransport.co.in/blog/truck-transportation-charges-in-india-calculate-per-km-cost/), [91trucks — 2025 margins](https://www.91trucks.com/news/profit-margins-in-trucking-breaking-down-the-numbers-for-2025), [FR8 — Mumbai to Delhi](https://www.fr8.in/transport-service/mumbai-transport-service/mumbai-to-delhi/)
- Shelf life: [IIHR high-humidity storage for coriander (Indian Journal of Horticulture)](https://journal.iahs.org.in/index.php/ijh/article/view/156), [IIHR storage box for leafy greens](https://www.indiascienceandtechnology.gov.in/hi/technologies/arka-high-humidity-storage-box-shelf-life-extension-green-leafy-vegetables), [zero-energy cool chamber trials](https://independent.academia.edu/NeeruDubey)
