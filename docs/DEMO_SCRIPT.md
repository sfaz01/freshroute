# FreshRoute — demo script (≈ 5 minutes)

Setup: `npm install`, then `npm run dev`, open the URL, scenario **Ordinary day**. Press **Reset** at any point to start over —
every result is deterministic, so the numbers below reproduce exactly.

## 0:00 — The problem (Situation)

> "A Nashik hub, 120 tonnes of tomatoes, grapes, coriander, onions, capsicum and bananas. Six trucks tonight, eight outlets from
> Mumbai to Delhi. 43 tonnes are at shelf-life risk — they must leave tonight to earn list price, need a markdown, or can't be sold at all. The dispatcher has to decide tonight what leaves, where, how much and at
> what price."

Point at: the shelf-life clock (red ticks = expiry), the callouts — one coriander lot **cannot be sold by any plan** (we say so before
planning), the lots that only earn list price if they leave tonight, the lots that will need a markdown wherever they go, and *6 trucks carry 48 t but 90 t is at the hub*.

## 0:45 — The decision (Dispatch plan)

Click **Generate dispatch plan**.

> "Same scenario, same prices, same cost model, same ledger. FreshRoute nets ₹28.61 lakh against ₹21.92 lakh for a FEFO dispatcher who
> also marks down end-of-life stock — and spoils 7.7 tonnes instead of 12.2, with four fewer trucks."

Point at the proof strip: *proven optimal (HiGHS, ~0.2 s, 31 integer truck counts) · 5/5 hard-constraint audits · books balance*.
Then the dispatch board (truck manifests per night) and the shelf-life timeline: long-life lots go to Delhi, ripe lots to Mumbai and Pune.

## 1:45 — Why? (Receipt)

Click **GRP-01** in the dispatch priority list.

> "Every batch has a receipt. Grapes from a failing cold room: they reach Mumbai with 37 hours of life, below the 60 hours buyers need for
> list price — so the engine marks them down 15–30 %. Even at −30 % in Mumbai they net ₹47/kg after handling and freight, against a
> ₹46/kg write-off if they spoil: a ₹93/kg swing on every kilogram. Delhi? Impossible —
> 13 hours left on arrival. Every number is computed from the data."

Click **What if not?** on Mumbai.

> "If you disagree, FreshRoute re-solves the whole plan with your condition: not sending it to Mumbai costs ₹56,662 and 749 kg of extra
> spoilage." Optionally **Apply as override** — the plan re-optimises around the dispatcher.

## 2:45 — Something goes wrong (Disrupt & replan)

Choose **Delhi truck stuck behind a ghat landslide** → **Apply disruption and replan**.

> "It's D1. Last night's Delhi truck is 14 hours late. Run the old plan anyway: 17 things break, ₹22.61 lakh. Replan, freezing what
> already left: ₹25.80 lakh, 6.4 tonnes less spoilage, 15 batches re-routed — and here is exactly what changed."

(Also strong: **Transporter strike** — the old plan becomes physically impossible.)

## 3:30 — Is it robust? (Stress test)

Click **Run stress test** (200 futures, risk buffer on).

> "Shelf-life estimates are guesses. In 200 futures where shelf life, transit, demand and price are wrong, FreshRoute still averages ₹16.46
> lakh against ₹13.61 lakh, with a better bad-day outcome. And it tells you which loads are fragile — the Delhi tomatoes are a coin toss.
> A risk-buffered plan, tuned on one set of futures and checked on another, protects the bad day."

## 4:15 — Is it honest? (Benchmark)

Click **Run benchmark**.

> "Eleven named scenarios plus random ones, both baselines, same ledger. FreshRoute wins net in every one — that's guaranteed, because both
> baselines are feasible plans of the model we solve. The interesting columns are where it *loses*: under uncertainty it is worse on
> average in *Short supply*; it serves fewer kilograms in *Heatwave*; with one market and spare trucks it barely improves anything. We
> show those too."

## 4:45 — Close

> "FreshRoute doesn't just recommend. It proves the plan is optimal, books it with the same ledger as the baseline, prices every
> alternative, and tells you which decisions depend on fragile assumptions. Everything runs offline in the browser; `npm test` and
> `npm run evaluate` reproduce every number we showed."

## Questions judges may ask

- *Is "optimal" real?* — HiGHS status "Optimal" at relative gap ≤ 0.01 %; a hand-solved instance is in `tests/optimizer.test.ts`.
- *Do you double count?* — One ledger; revenue only for kg sold; mass balance and objective = ledger are tested on every scenario.
- *Is the baseline a straw man?* — It respects every constraint, ranks markets by net price after freight, refuses trucks that do not
  pay, and (in the clearance variant) marks down end-of-life stock.
- *How much depends on the discount model?* — See *Thin markdown demand* (appetite × 0.25): the gain shrinks but remains.
- *What about the data format of hidden scenarios?* — JSON import with validation and a line-by-line repair report; *Data & assumptions*.
