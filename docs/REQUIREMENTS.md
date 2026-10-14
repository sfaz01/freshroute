# Requirements → implementation → test

Source: *Problem Statements.pdf*, PS 03 — FreshRoute. Test files are in `tests/`; run `npm test`.

## Mandatory MVP

| # | Requirement (PS 03) | Implementation | Verified by |
|---|---|---|---|
| M1 | Represent inventory batches by commodity, quantity and estimated remaining shelf life | `Batch` in `src/engine/types.ts`; batch tables in *Data & assumptions*; shelf-life clock in *Situation* | `ledger.test.ts` (accounting on batches), `operations.test.ts › input validation` |
| M2 | Allocate stock across destinations using demand, prices, transport time or cost, and capacity constraints | MIP in `src/engine/optimize.ts` (demand per tier, price per row, transit → session, truck cost, integer trucks, fleet and lane limits) | `optimizer.test.ts › finds the optimum computed by hand`, `› feasible … never worse than either baseline` (all scenarios), `› fleet is the binding constraint` |
| M3 | Prioritise dispatches by perishability and feasibility, including whether arrival + handling fit the remaining shelf-life allowance | `evaluateOption` in `src/engine/time.ts` (load + transit + dock → session → life at sale vs. buyer thresholds); urgency and priority in `explain.ts`; dispatch board and priority list | `ledger.test.ts › time and shelf-life feasibility`, `optimizer.test.ts › sends a highly perishable batch only where it can arrive in time`, independent `assertHardConstraints` |
| M4 | Recommend discounts for batches at risk of remaining unsold or spoiling, with disclosed assumptions | Markdown tiers with constant-elasticity demand (`tierOffers`); recommendations with trigger and economics in `explain.ts › discounts`; *Markdown desk*; assumptions page | `optimizer.test.ts › chooses to discount when the markdown beats the write-off, and not when it does not`, `operations.test.ts › gives every discount a reason and a positive advantage` |
| M5 | Compare against a baseline; report spoilage, demand fulfilment and net revenue after defined costs | Two documented baselines (`baseline.ts`); single ledger (`ledger.ts`); KPI tiles, ledger table, benchmark; `npm run evaluate` | `ledger.test.ts › books revenue only for kg sold…`, `› writes off expired hub stock`, `› applies contract shortfall penalties…`; optimiser-vs-ledger consistency on every scenario |

## Mission requirements beyond the MVP list

| Requirement | Implementation | Verified by |
|---|---|---|
| Explain recommendations; make assumptions inspectable | Receipts (`explain.ts`, `views/Receipt.tsx`), LP shadow prices, *Data & assumptions* page | `operations.test.ts › explains every batch…`, `› flags the coriander lot … as stranded` |
| Repeatable evaluation on multiple scenarios | 11 named + 30 seeded random scenarios (`scenarios/catalog.ts`); `src/cli/evaluate.ts` | `optimizer.test.ts › is reproducible`, `operations.test.ts › samples identical futures for identical seeds` |
| Ordinary operating conditions | scenario `ordinary-day` | suite test |
| Highly perishable batch reachable only by some destinations | `heatwave`; micro test | `› sends a highly perishable batch only where it can arrive in time` |
| Demand exceeding inventory | `short-supply` | `› demand exceeding inventory` |
| Inventory exceeding demand | `harvest-glut` | `› inventory exceeding demand` |
| Insufficient transport capacity | `fleet-crunch`; strike disruption | `› insufficient transport capacity`, `› a fleet cut makes the stale plan physically impossible` |
| Delayed shipment | `highway-delay`; in-transit delay replanning (`del-delay`) | `operations.test.ts › delayed shipment: freezes what already left…` |
| Unexpected change in destination demand | `demand-shock`; `mumbai-glut`, `rush-order` disruptions | `› unexpected demand change: re-plan never loses to executing the old plan` |
| Missing, malformed or inconsistent data | `validate.ts`; *Import / export* with a broken example | `operations.test.ts › input validation` (4 tests) |
| Discounts and costs that change the preferred decision | `diesel-spike`, `thin-markdowns`; markdown on/off micro test | `› chooses to discount when … and not when …`, suite |
| No feasible allocation for all requested demand; preserve partial plan | `stranded`; infeasible override handling | `› no feasible allocation for all demand: a partial, feasible plan is preserved`, `› reports an infeasible override without discarding the plan` |
| Never allocate nonexistent inventory, exceed capacity or demand, or plan infeasible deliveries silently | Ledger violations + `audit()`; independent checker in tests | `› never dispatches nonexistent stock or exceeds the fleet`, `› writes off oversupply…`, `assertHardConstraints` on every scenario and both baselines |
| Disruption and replanning | `disruptions.ts`, *Disrupt & replan* view | `operations.test.ts › replanning after a disruption` (4 tests) |
| Uncertainty / robustness | `uncertainty.ts`, *Stress test* view | `operations.test.ts › uncertainty` (3 tests) |
| Works offline, no paid APIs or credentials | HiGHS WebAssembly in a Web Worker; fonts bundled | `npm run build` output is static |

## Optional extensions (PS 03) — status

| Extension | Status |
|---|---|
| Forecast demand from history / seasonality | Not implemented (demand is an input; session pattern only). |
| Optimise discount timing under uncertainty | Partly: markdown tier and timing are optimised in the MIP; uncertainty handled by stress test + risk buffer, not inside the optimiser. |
| Replan on route disruption, capacity change, new orders | Implemented (`disruptions.ts`). |
| Uncertainty ranges for shelf life, travel time, demand and their effect | Implemented (`uncertainty.ts`, fragile shipments, risk-buffered plan). |
| Simulated temperature readings / live price feeds | Not implemented (shelf-life re-estimate disruption covers a cold-room failure). |
