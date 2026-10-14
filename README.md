# FreshRoute — dispatch decisions, with receipts

**PS 03 · Intelligent decision support for perishable produce distribution.**

FreshRoute is a dispatch desk for a produce consolidation hub. Every night it decides **which batches leave, where they go,
how much, at what price tier, and how many trucks run on each lane** — and it proves each decision instead of asserting it:

- **Proven optimal, not "AI-suggested".** The plan is a mixed-integer programme solved to a certified optimum by
  [HiGHS](https://highs.dev) (compiled to WebAssembly, running in the browser — no server, no API key, works offline).
- **One ledger for every plan.** The baseline, the optimised plan, an operator override and a stale plan under a disruption are all
  scored by the same accounting code. A test checks that the optimiser's objective and the ledger agree to the rupee.
- **A receipt for every batch.** Why this outlet, why tonight, why the markdown — from the option table, LP shadow prices and the ledger.
  Any alternative can be **priced exactly** ("what if this lot went to Delhi instead?") by re-solving the full model with that condition.
- **It knows what it doesn't know.** Plans are stress-tested on seeded futures where shelf life, transit time, demand and price are
  wrong; the tool flags fragile loads and calibrates a risk-buffered plan on training futures, reporting it on different test futures.

> Data is synthetic. City coordinates and approximate road times are real; every quantity, price and cost is invented. Nothing on screen is a live vehicle or live price.

---

## Run it

Requirements: Node.js ≥ 20 (tested on Node 24, Windows 11).

```bash
npm install
```

```bash
npm run dev
```

Open the printed URL (default http://localhost:5173). Then click **Generate dispatch plan**.

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Type-check and production build to `dist/` (static files; serve with any web server or `npm run preview`) |
| `npm test` | 57 automated tests (engine, accounting, constraints, scenarios, replanning, uncertainty, validation, formatting) |
| `npm run evaluate` | Full reproducible evaluation → `docs/EVALUATION.md` + `evaluation/results.json` (≈15 s) |

The demo needs no network connection, credentials or paid services.

## The 2-minute tour

1. **Situation** — 120 t across 22 batches, 6 crops, 8 outlets, 6 trucks a night. 24 t is at shelf-life risk; one coriander lot
   cannot reach any buyer in time (the tool says so up front, for every plan).
2. **Dispatch plan** — FreshRoute vs. the baseline on the same ledger: net **₹30.98 L vs ₹23.57 L**, spoilage **6.5 t vs 11.9 t**,
   fulfilment 60.9% vs 60.0%, 20 trucks vs 24. Proof strip: *proven optimal · 5/5 hard-constraint audits passed · books balance*.
   Truck manifests per night, shelf-life timeline, demand served per outlet, markdown desk.
3. **Receipt** — click any batch. Itemised economics, the shadow price of the lot, every outlet with the reason it was chosen,
   rejected or impossible, and buttons that re-solve the plan to price an alternative (e.g. *not* sending GRP-01 to Mumbai costs
   ₹55,925 and 749 kg of extra spoilage). Apply it as an override if you disagree — the plan re-optimises around you.
4. **Disrupt & replan** — it is D1, the Delhi truck is 14 h late. Executing the old plan breaks 17 times (₹24.55 L);
   the replan freezes what has left and re-routes 12 batches (₹28.03 L, 6.6 t less spoilage).
5. **Stress test** — 200 seeded futures. FreshRoute's mean ₹17.98 L vs ₹14.85 L for the baseline, the ten most fragile loads,
   and a risk-buffered plan chosen on training futures.
6. **Trade-offs** — what one more truck tonight is worth (+₹42,572), what each extra point of fulfilment costs, scarcest markets.
7. **Benchmark** — every scenario, both baselines, in the browser. **Data & assumptions** — every input and rule; import your own JSON.

A step-by-step judging script is in [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

## Results (from `npm run evaluate`)

Full report: [docs/EVALUATION.md](docs/EVALUATION.md). Every number there is generated; none is typed in.

| 11 named scenarios | FEFO baseline | FEFO + clearance | FreshRoute |
|---|---|---|---|
| Spoilage (kg-weighted) | 22.8% | 17.8% | **14.1%** |
| Fulfilment (demand-weighted) | 44.0% | 44.2% | **45.7%** |
| Net gain of FreshRoute | +₹98.95 L | +₹63.92 L | — |
| Hard-constraint violations | 0 | 0 | 0 |

30 seeded random scenarios: spoilage 26.3% / 22.7% / **18.3%**, fulfilment 34.0% / 34.1% / **36.1%**, FreshRoute net higher in 30/30.

**Where it does not win** (reported, not hidden):
- Under uncertainty the *nominal* optimum loses to the clearance baseline on average in 1 of 41 scenarios (*Short supply*):
  it uses every hour of shelf-life slack, so it is fragile when estimates are wrong. The risk-buffered plan exists for this.
- Fulfilment is lower than a baseline in 7 of 41 scenarios — the objective is net outcome, so scarce stock goes where it is
  worth more, not where it fills more kilograms. The Trade-offs view shows the exact price of serving more.
- In *Little headroom* (one market, ample trucks) the gain is only truck consolidation (+2.6%), as it should be.
- Higher-or-equal net *under published estimates* is guaranteed by construction (both baselines are feasible plans of the model),
  so spoilage, fulfilment and stressed outcomes are the informative comparisons.

## How it works

```
src/engine/            pure TypeScript, no DOM — runs in the browser worker, in Node (CLI) and in tests
  types.ts             data model (batches, commodities, outlets/lanes, demand rows, fleet, plans, ledger)
  time.ts              the single feasibility rule: dispatch → arrival session → remaining life → grade → price tiers
  optimize.ts          MIP builder (CPLEX-LP text) + decoding + LP duals with trucks fixed
  solver.ts            HiGHS wrapper (status, primal, reduced costs, row duals)
  ledger.ts            settle(): executes any plan physically and books revenue/costs; audit()
  baseline.ts          FEFO and FEFO + clearance policies
  explain.ts           receipts: priorities, alternatives with reasons, markdown rationale
  counterfactual.ts    exact re-solve with an override; value of ±1 truck
  disruptions.ts       disruption patches, replanning with frozen dispatches, plan diff, presets
  uncertainty.ts       seeded futures, paired stress tests, risk-buffered planning (train/test)
  validate.ts          import validation and documented repair
  evaluate.ts          scenario suite runner and aggregation
  scenarios/           the Nashik dataset, 11 named scenarios, seeded random generator
src/app/               React UI (Vite); the engine runs in a Web Worker (engine.worker.ts)
src/cli/evaluate.ts    writes docs/EVALUATION.md and evaluation/results.json
tests/                 Vitest suites
```

### The model

Decision variables: `x[b,d,t,k]` kg of batch *b* dispatched to outlet *d* on night *t* and sold in price tier *k*;
`n[d,t]` integer trucks per lane-night; `h[b]` kg never dispatched; `y[d,t]` binary "lane runs" (valid inequalities only).

Hard constraints:
- **stock** `Σ x[b,·] + h[b] = Q_b`; a batch cannot leave before it reaches the hub;
- **demand** per outlet × commodity × market session × tier: list-price demand at tier 0, markdown demand at tiers ≥ 1;
- **trucks** `Σ x[·,d,t,·] ≤ C · n[d,t]`, `Σ_d n[d,t] ≤ fleet_t`, lane limits and closures;
- **shelf life** a variable exists only if the load reaches its session with ≥ the buyer's minimum life; tier 0 additionally needs list-price freshness.

Objective (maximise, identical to the ledger's net): revenue − handling − freight (per truck and per kg) − spoilage cost of unsold stock
− contract shortfall penalties + value of stock still viable after the horizon.

Markdown demand uses constant elasticity: a −δ markdown unlocks `D · appetite · [(1−δ)^(−ε) − 1]` extra kg (incremental per tier),
with ε per commodity and an appetite factor per outlet. Fresh lots fill list-price demand first; near-expiry lots can only be sold at a markdown.

Typical size: ~830 variables, 31 integer truck counts, ~450 constraints; solved in 50–250 ms with relative gap ≤ 0.01%.
A tie-break of 0.00001 ₹/kg/h prefers first-expired-first-out among equal-value plans (excluded from reported values).
Full detail: [docs/MODEL.md](docs/MODEL.md).

### Accounting rules (no double counting)

- Revenue only for kg sold, at the price realised; unsold, rejected or expired kg earn nothing.
- Transport = trucks × lane rate (+ per-kg freight); a truck is paid in full however empty.
- Handling per kg dispatched; spoilage cost per kg spoiled at hub or written off at market.
- Stock still viable after the horizon is *carried* (valued), not spoiled.
- Fulfilment = customer demand served at list price ÷ customer demand; salvage outlets place no orders and are excluded.
- Mass balance: sold + spoiled + carried = inventory (tested).

### Baselines

- **FEFO**: each night, first-expired-first-out; each batch to the best net-price market with list-price demand left where it arrives
  fresh enough; a new truck only if its load pays for it. No markdowns.
- **FEFO + clearance**: plus the usual end-of-life rule — once a batch cannot make list price anywhere, mark it down wherever that beats spoiling.

Both respect every hard constraint; the difference is decision quality, not feasibility.

## Data format

Scenarios are JSON (export one from *Data & assumptions → Import / export* to get a template). Main fields:
`horizonDays`, `dispatchHour`, `hub`, `commodities[]` (handling, spoilage cost, carry value, freshness thresholds, elasticity, shelf-life CV),
`batches[]` (commodity, kg, remaining shelf life in hours from D0 00:00, first day at hub), `destinations[]` (transit, dock, market open hour,
truck rate, per-kg freight, lane limits/closures/delays, shortfall penalty, markdown appetite, freshness offset, salvage flag),
`demand[]` (outlet, commodity, session, kg, ₹/kg), `fleet` (truck capacity, trucks per night), `discountTiers`, `uncertainty`.
Invalid rows are dropped or repaired with a line-by-line report; unusable files are rejected without replacing the current scenario.

## Assumptions and limitations

- Single hub, one truck type, trucks hired per trip (no round-trip fleet scheduling), no storage at destinations, no temperature model.
- Prices are exogenous apart from the markdown tiers; FreshRoute's own volume does not move list prices.
- Markdown demand is an assumption (elasticity × appetite); *Thin markdown demand* shows how much of the gain depends on it.
- Stress tests execute plans open-loop (no mid-course correction), so stressed values are pessimistic for every plan.
- The risk-buffered plan is a calibrated heuristic, not a stochastic-programming optimum.
- Data is synthetic. Government post-harvest loss estimates give context only; they are not batch-level shelf-life data.

## Documents

- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — every mandatory requirement → implementation → test
- [docs/MODEL.md](docs/MODEL.md) — concept, formulation, design decisions and trade-offs
- [docs/EVALUATION.md](docs/EVALUATION.md) — generated evaluation report
- [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) — the hackathon demo, step by step
