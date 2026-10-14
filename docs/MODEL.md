# FreshRoute — concept, model and design decisions

## 1. The problem underneath PS 03

A produce distributor at a consolidation hub has perishable lots with uncertain remaining life, a handful of reachable
markets that each buy a limited amount per day at a given price, and a few hired trucks per night. Every night the dispatcher
has to decide, for every lot: **leave tonight or wait, which market, how much, and at what price.**

What spreadsheets get wrong:

1. **They spend shelf life badly.** First-expired-first-out sends the oldest lots out first, to the best price in reach. It
   never asks whether that market should have been kept for a lot that *only* that market can still take, or whether the far,
   high-price market should go to a lot with days to spare.
2. **They treat trucks one load at a time.** Whether a second Delhi truck pays depends on everything else that could ride on it.
3. **They discount too late or not at all**, because the comparison "markdown now vs. write-off later" is never written down.
4. **They cannot price a disagreement.** When a dispatcher overrides the plan, nobody knows what it cost.
5. **They plan as if the estimates were facts.** A lot that arrives two hours inside its freshness threshold is a coin toss.

## 2. Concepts considered

| Concept | Verdict |
|---|---|
| Greedy rules + dashboard | Fast to build, but it is the baseline, not an improvement. |
| LLM "co-pilot" that writes a plan | Cannot guarantee feasibility or optimality; numbers would be unverifiable. Rejected for the core. |
| Pure LP with per-kg freight | Elegant and fast, but trucks are lumpy: the main real trade-off (is a truck worth it?) disappears. |
| **MIP with integer trucks + one ledger + exact counterfactuals + seeded stress tests** | **Chosen.** Small enough to solve to optimality in the browser in < 0.3 s, so every "what if" can be answered by re-solving rather than guessing. |
| Two-stage stochastic programme (SAA) | Most rigorous for uncertainty, but 20–30× the model size in single-threaded WebAssembly. Replaced by a calibrated buffer (§6) with an honest train/test protocol. |

**Differentiator:** decisions with receipts. Optimality is proven by the solver, every number is booked by one ledger shared with
the baseline, every alternative can be priced exactly, and every plan is tested against futures in which the estimates are wrong.

## 3. Time and feasibility (`src/engine/time.ts`)

- Hour 0 = 00:00 on D0. The dispatch wave of night *t* leaves at `24t + dispatchHour` after `loadHours` of loading.
- Ready on the market floor at `depart + transit (+ delay) + dock`.
- Markets trade in daily sessions opening at `24s + marketOpenHour`; a load sells in the first session whose opening is at most
  3 h before it is ready (late arrivals can still sell that morning).
- Remaining life is measured when the lot is offered: `expiry − max(session open, ready)`.
- Grade: ≥ list-price life → **A** (any tier); ≥ minimum sale life → **B** (markdown tiers only); below → rejected.
  Outlets shift both thresholds (retail DC +24 h; processor −48 h).

The same function is used by the optimiser, the baseline, the ledger and the explanations, so they can never disagree about
whether a delivery is feasible.

## 4. The optimisation model (`src/engine/optimize.ts`)

Sets: batches *b*, outlets *d*, dispatch nights *t*, price tiers *k* (0 = list, 1..K = markdowns), demand rows *r = (d, c, s)*.
An option *(b, d, t)* exists only if the batch is at the hub, the lane is open, a truck exists that night, a buyer exists in the
arrival session and the lot is not rejected on arrival.

```
maximise   Σ x[b,d,t,k] · (p[r,k] − handling_c − freight/kg_d + penalty_d·[k=0])
         − Σ n[d,t] · truckCost_d
         + Σ h[b] · (carryValue_c  if still viable after the horizon, else −spoilageCost_c)
         − Σ_r penalty_d · D_r                                        (constant)

s.t.  Σ_{d,t,k} x[b,d,t,k] + h[b] = Q_b                      ∀ b          stock
      Σ_{b∈c, t→s} x[b,d,t,k] ≤ cap[r,k]                     ∀ r, k       demand per tier
      Σ_{b,k} x[b,d,t,k] ≤ C · n[d,t]                         ∀ d, t       truck capacity
      Σ_d n[d,t] ≤ F_t,   0 ≤ n[d,t] ≤ laneMax[d,t],  n ∈ ℤ   ∀ t          fleet
      Σ_{b∈c} x[b,d,t,k] ≤ cap[r,k] · y[d,t],  y ≤ n,  y ∈ {0,1}            valid inequalities
      x, h ≥ 0
```

- `cap[r,0] = D_r`; `cap[r,k] = D_r · appetite_d · [(1−δ_k)^(−ε_c) − (1−δ_{k−1})^(−ε_c)]` (incremental constant-elasticity demand).
- The `y` rows are redundant for integer solutions but make the LP relaxation almost integral in the truck counts: HiGHS proves
  optimality at the root node in ~0.1–0.3 s instead of ~2.5 s. Sub-MIP heuristics and restarts are switched off because they only
  add fixed overhead in the single-threaded Wasm build (measured).
- **Replanning** adds committed loads (dispatched before `asOfDay`) as fixed quantities whose sale tiers are re-decided under the new
  conditions; any part that can no longer be sold is forced into a write-off variable.
- **Overrides** add `Σ x ≥ minKg` (force) or remove options (ban). An impossible override is reported as infeasible with the reason.
- **Service weight** (optional, default 0) adds ₹w per kg of customer demand served at list price; it is excluded from all reported values.
- **Tie-break** of 1e-5 ₹/kg per hour of life left at sale prefers first-expired-first-out among equal-value plans; excluded from reported values.

After the MIP, the truck counts are fixed and the LP is re-solved to read **shadow prices**: value of one more kg of each batch, of
list-price demand in each session, and of space on each dispatched truck. Lanes without a truck have degenerate duals and are not shown.

## 5. The ledger (`src/engine/ledger.ts`)

`settle(scenario, plan)` executes any plan physically and books it:

1. Night by night, loads leave in plan order; a load is trimmed or cancelled (and a violation recorded) if the batch is not at the hub,
   stock is exhausted, the lane is closed or the trucks run out. Trucks per lane-night = ⌈load / capacity⌉.
2. Each load reaches its session; remaining life grades it.
3. Within an outlet × commodity × session, grade-A lots fill list-price demand freshest first; the rest and grade-B lots fill markdown
   tiers; anything left is written off at the destination. For fixed shipments this greedy fill is revenue-optimal, so the ledger
   reproduces the optimiser's objective exactly (tested on every scenario).
4. Hub leftovers are carried (if viable after the horizon) or spoiled.

`audit()` groups violations into five hard-constraint checks shown in the UI.

## 6. Uncertainty (`src/engine/uncertainty.ts`)

A future perturbs: shelf life per batch (`× N(1, cv_c)`, clamped), transit per lane-night (lognormal, mean 1), demand per row (±18 %)
and price per row (±6 %). Plans are executed unchanged in the same futures (common random numbers) by the same ledger.

**Risk-buffered plan:** re-optimise against a pessimistic copy (shelf life × (1 − κ·cv), transit + κ·cv·hours, demand × (1 − ½κ·cv)),
pick κ ∈ {0, 0.5, 1, 1.5, 2} on *training* futures, report on *different test* futures. It is a heuristic; the honest finding is that a
small buffer (κ = 0.5) keeps the mean and raises the bad-day (5th-percentile) outcome.

## 7. Explanations (`src/engine/explain.ts`, `counterfactual.ts`)

- **Priority**: batches ordered by urgency (must leave tonight / within 48 h / can wait / unreachable), then by the last night a customer
  can still pay list price, then by expiry.
- **Alternatives**: for each outlet, *chosen* (with quantities), *possible but worse* (dominant reason from the duals: demand already taken
  by lots that earn more, truck full, or lower margin — with the reduced cost ₹/kg), *impossible* (the exact feasibility failure with hours),
  or *blocked by override*.
- **Markdowns**: trigger (near-expiry vs oversupply), net ₹/kg after handling and freight vs the write-off, and the elasticity assumption.
- **Counterfactuals**: re-solve the full MIP with the condition; the quoted cost includes every knock-on effect.
- **Fleet value**: re-solve with ±1 truck per night.

## 8. Design decisions and trade-offs

- **Browser-only architecture.** No backend: the solver runs in a Web Worker. Zero setup for judges; the same engine code runs in Node for
  tests and the evaluation CLI.
- **Daily market sessions, no destination storage.** Matches mandi practice and keeps the model linear; unsold stock at a market is lost.
- **Exogenous prices + elastic markdown tiers.** Simple, inspectable, and the main assumption behind discount value — so it has its own
  stress scenario (*Thin markdown demand*).
- **Net outcome as the single objective**, with fulfilment exposed as a priced trade-off rather than an arbitrary weighted sum.
- **Salvage outlet excluded from fulfilment.** A processor that absorbs anything at ₹9/kg is not a customer order; counting it would
  reward pulping fresh tomatoes.
- **Spoilage cost is a dataset parameter** (write-off + disposal per kg). Whether it should include the sunk procurement cost is a business
  choice; the engine simply uses what the dataset defines.
