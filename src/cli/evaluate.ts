/**
 * Reproducible evaluation: `npm run evaluate`
 *
 * Runs both baselines and the optimiser on every named scenario and on seeded
 * random scenarios, stress-tests each plan on common seeded futures, runs the
 * risk-buffer study on the reference scenario, and writes
 *   evaluation/results.json   machine-readable results
 *   docs/EVALUATION.md        the report quoted in the README
 * Every number in the report is computed here; nothing is typed in by hand.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadNodeSolver } from '../engine/nodeSolver';
import { CATALOG, buildScenario, randomScenario } from '../engine/scenarios/catalog';
import { evaluateScenario, summarise, type SuiteRow } from '../engine/evaluate';
import { robustPlan } from '../engine/uncertainty';
import { baselinePlan } from '../engine/baseline';
import { optimize } from '../engine/optimize';
import { presetEvents, replan } from '../engine/disruptions';
import { rupeesCompact, pct, kg, rupeesDelta } from '../engine/fmt';

const RANDOM_SEEDS = Array.from({ length: 30 }, (_, i) => i + 1);
const FUTURES = 100;

const solver = await loadNodeSolver();
const t0 = performance.now();
console.log(`FreshRoute evaluation · solver ${solver.name}`);

const named: SuiteRow[] = [];
for (const entry of CATALOG) {
  const row = evaluateScenario(entry.build(), solver, FUTURES, 11);
  named.push(row);
  console.log(`  ${row.id.padEnd(16)} ${row.status.padEnd(8)} net ${rupeesCompact(row.fefo.net).padStart(10)} → ${rupeesCompact(row.optimizer.net).padStart(10)}`);
}
const random: SuiteRow[] = [];
for (const seed of RANDOM_SEEDS) random.push(evaluateScenario(randomScenario(seed), solver, FUTURES, 11 + seed));
console.log(`  ${random.length} random scenarios done`);

const ordinary = buildScenario('ordinary-day');
const robust = robustPlan(ordinary, solver, { trainSize: 150, testSize: 300, seed: 2024, baseline: baselinePlan(ordinary, { clearance: true }) });
const basePlan = optimize(ordinary, solver);
const replans = presetEvents(ordinary).map((ev) => {
  const rp = replan(ordinary, basePlan.plan, ev.changes, ev.asOfDay, solver);
  return {
    id: ev.id,
    title: ev.title,
    asOfDay: ev.asOfDay,
    staleNet: rp.stale.totals.net,
    staleViolations: rp.stale.violations.length,
    replannedNet: rp.replanned.outcome.totals.net,
    staleSpoiled: rp.stale.totals.spoiledKg,
    replannedSpoiled: rp.replanned.outcome.totals.spoiledKg,
    moved: new Set(rp.diff.map((d) => d.batchId)).size,
  };
});

const sNamed = summarise(named);
const sRandom = summarise(random);
const seconds = ((performance.now() - t0) / 1000).toFixed(1);

mkdirSync('evaluation', { recursive: true });
writeFileSync(
  'evaluation/results.json',
  JSON.stringify(
    {
      generatedBy: 'npm run evaluate',
      solver: solver.name,
      futuresPerScenario: FUTURES,
      named,
      random,
      summary: { named: sNamed, random: sRandom },
      robust: {
        trainSize: robust.trainSize,
        testSize: robust.testSize,
        candidates: robust.candidates.map((c) => ({ kappa: c.kappa, nominalNet: c.nominalNet, trainMean: c.trainMean, testMean: c.testMean })),
        chosenKappa: robust.chosen.kappa,
        test: {
          nominal: { mean: robust.nominalPlanTest.net.mean, p05: robust.nominalPlanTest.net.p05 },
          chosen: { mean: robust.chosenPlanTest.net.mean, p05: robust.chosenPlanTest.net.p05 },
          baseline: robust.baselineTest && { mean: robust.baselineTest.net.mean, p05: robust.baselineTest.net.p05 },
        },
      },
      replans,
    },
    null,
    2,
  ),
);

const L = (v: number) => rupeesCompact(v);
const P = (v: number) => pct(v, 1);
const best = (vals: number[], i: number, higherIsBetter: boolean, fmt: (v: number) => string) => {
  const target = higherIsBetter ? Math.max(...vals) : Math.min(...vals);
  return Math.abs(vals[i] - target) < 1e-9 ? `**${fmt(vals[i])}**` : fmt(vals[i]);
};
const trio = (vals: number[], higher: boolean, fmt: (v: number) => string) => vals.map((_, i) => best(vals, i, higher, fmt));
const tableRow = (r: SuiteRow) => {
  const nets = trio([r.fefo.net, r.clearance.net, r.optimizer.net], true, L);
  const sp = trio([r.fefo.spoilageRate, r.clearance.spoilageRate, r.optimizer.spoilageRate], false, P);
  const fu = trio([r.fefo.fulfilment, r.clearance.fulfilment, r.optimizer.fulfilment], true, P);
  return `| ${r.name} | ${r.tests} | ${nets.join(' | ')} | ${sp.join(' / ')} | ${fu.join(' / ')} | ${r.fefo.violations + r.clearance.violations + r.optimizer.violations} | ${r.status} |`;
};
const stressRow = (r: SuiteRow) => {
  const means = trio([r.stress!.fefo, r.stress!.clearance, r.stress!.optimizer], true, L);
  const p5 = trio([r.stress!.clearanceP05, r.stress!.optimizerP05], true, L);
  return `| ${r.name} | ${means.join(' | ')} | ${p5.join(' | ')} | ${r.stress!.optimizer >= r.stress!.clearance ? 'FreshRoute' : '**FEFO + clearance**'} |`;
};

const worseUnderStress = [...named, ...random].filter((r) => r.stress && r.stress.optimizer < r.stress.clearance);
const fulfilLoss = [...named, ...random].filter((r) => r.optimizer.fulfilment < Math.max(r.fefo.fulfilment, r.clearance.fulfilment) - 0.005);

const md = `# FreshRoute — evaluation report

_Generated by \`npm run evaluate\` with ${solver.name} in ${seconds} s. Every figure below is computed by the code in
\`src/engine\`; re-running the command reproduces it exactly (all randomness is seeded)._

## What is compared

| Plan | Policy |
|---|---|
| **Baseline · FEFO** | Each night, first-expired-first-out; each batch goes to the reachable market with the best net price (after full-truck freight) that still has list-price demand and where it arrives fresh enough for list price; a new truck is opened only if the load on it pays for it. No markdowns. |
| **Baseline · FEFO + clearance** | As above, plus the usual end-of-life rule: once a batch can no longer make list price anywhere, offer it at the published markdown tiers wherever that beats letting it spoil. |
| **FreshRoute** | Mixed-integer optimisation of dispatch day, destination, quantity, markdown tier and integer truck counts (HiGHS), maximising the same net outcome. |

All three are scored by the **same ledger** (\`src/engine/ledger.ts\`) under the same scenario, prices and cost model.
Net = revenue − transport − handling − spoilage cost − contract shortfall penalties + value of still-viable carried stock.
Spoilage rate = spoiled kg ÷ inventory kg. Fulfilment = customer demand served at list price ÷ customer demand (salvage outlets excluded).

## Named scenarios (deterministic, published shelf-life assumptions)

| Scenario | What it tests | Net · FEFO | Net · clearance | Net · FreshRoute | Spoilage FEFO / clear. / FR | Fulfilment FEFO / clear. / FR | Constraint violations | Solver |
|---|---|---|---|---|---|---|---|---|
${named.map(tableRow).join('\n')}

**Totals over ${sNamed.rows} named scenarios:** net gain ${rupeesDelta(sNamed.netGainVsFefo)} vs FEFO and ${rupeesDelta(sNamed.netGainVsClearance)} vs FEFO + clearance;
spoilage (FEFO → clearance → FreshRoute) ${P(sNamed.spoilageFefo)} → ${P(sNamed.spoilageClearance)} → ${P(sNamed.spoilageOptimizer)};
fulfilment ${P(sNamed.fulfilmentFefo)} → ${P(sNamed.fulfilmentClearance)} → ${P(sNamed.fulfilmentOptimizer)} (kg-weighted).
Bold marks the best value in each row.
FreshRoute has the higher net in ${sNamed.optimizerWinsNet}, ties in ${sNamed.ties} and is lower in ${sNamed.optimizerLosesNet} scenarios.
Hard-constraint violations across all plans: ${sNamed.infeasiblePlans === 0 ? 'none' : sNamed.infeasiblePlans}.

## ${random.length} seeded random scenarios

Random batch counts (14–26), sizes, shelf lives, inbound timing, fleet (4–7 trucks), demand level (×0.7–1.3) and price noise (±12 %).

| | FEFO | FEFO + clearance | FreshRoute |
|---|---|---|---|
| Spoilage (kg-weighted) | ${P(sRandom.spoilageFefo)} | ${P(sRandom.spoilageClearance)} | ${P(sRandom.spoilageOptimizer)} |
| Fulfilment (demand-weighted) | ${P(sRandom.fulfilmentFefo)} | ${P(sRandom.fulfilmentClearance)} | ${P(sRandom.fulfilmentOptimizer)} |
| Total net gain of FreshRoute | ${rupeesDelta(sRandom.netGainVsFefo)} | ${rupeesDelta(sRandom.netGainVsClearance)} | — |

FreshRoute net is higher in ${sRandom.optimizerWinsNet}/${sRandom.rows}, tied in ${sRandom.ties}, lower in ${sRandom.optimizerLosesNet}. Violations: ${sRandom.infeasiblePlans === 0 ? 'none' : sRandom.infeasiblePlans}.
(Higher-or-equal net is guaranteed by construction: both baselines are feasible solutions of the model FreshRoute optimises. The tests assert it.)

## Robustness: ${FUTURES} sampled futures per scenario

Each plan is executed **unchanged** in ${FUTURES} seeded futures (shelf life, transit time, demand and price perturbed —
see \`src/engine/uncertainty.ts\`). All plans see the same futures. Mean net (and 5th percentile):

| Scenario | FEFO | Clearance | FreshRoute | Clearance P5 | FreshRoute P5 | Better on average |
|---|---|---|---|---|---|---|
${named.map(stressRow).join('\n')}

Across all ${named.length + random.length} scenarios the nominal FreshRoute plan has a **lower** mean outcome under stress than the clearance
baseline in ${worseUnderStress.length}: ${worseUnderStress.map((r) => r.name).join(', ') || 'none'}.
This is the optimiser's curse: a plan optimised to the published estimates uses every hour of shelf-life slack, so it is more
exposed when those estimates are wrong. The risk-buffered plan below addresses exactly this.

### Risk-buffered planning (reference scenario)

κ is chosen on ${robust.trainSize} training futures and reported on ${robust.testSize} **different** test futures.

| κ | Net under published estimates | Mean net, training futures | Mean net, test futures |
|---|---|---|---|
${robust.candidates.map((c) => `| ${c.kappa}${c.kappa === robust.chosen.kappa ? ' (chosen)' : ''} | ${L(c.nominalNet)} | ${L(c.trainMean)} | ${c.testMean !== undefined ? L(c.testMean) : '—'} |`).join('\n')}

On the test futures: nominal plan mean ${L(robust.nominalPlanTest.net.mean)} (P5 ${L(robust.nominalPlanTest.net.p05)}),
chosen plan mean ${L(robust.chosenPlanTest.net.mean)} (P5 ${L(robust.chosenPlanTest.net.p05)})${
  robust.baselineTest ? `, FEFO + clearance mean ${L(robust.baselineTest.net.mean)} (P5 ${L(robust.baselineTest.net.p05)})` : ''
}.

## Replanning after disruptions (reference scenario)

The original plan is executed unchanged in the disrupted world ("stale") and compared with a replan that freezes every
truck that has already left.

| Disruption | Known at | Stale plan net | Stale plan breaks | Replanned net | Spoilage stale → replanned | Batches re-routed |
|---|---|---|---|---|---|---|
${replans.map((r) => `| ${r.title} | D${r.asOfDay} | ${L(r.staleNet)} | ${r.staleViolations} | **${L(r.replannedNet)}** | ${kg(r.staleSpoiled)} → ${kg(r.replannedSpoiled)} | ${r.moved} |`).join('\n')}

## Honest weaknesses found by this evaluation

- **Fulfilment is not maximised.** The objective is net outcome. In ${fulfilLoss.length} of ${named.length + random.length} scenarios FreshRoute serves a smaller share of
  demand than a baseline (${fulfilLoss.slice(0, 6).map((r) => r.name).join(', ')}${fulfilLoss.length > 6 ? ', …' : ''}), because it sends scarce stock where it is worth
  more rather than where it fills more kilograms. The operator can price service explicitly (service weight, Plan view)
  and see the trade-off curve.
- **Open-loop stress tests.** Plans are not corrected mid-course in the sampled futures, so absolute stressed values are
  pessimistic for every plan; only the comparison between plans is meaningful.
- **The markdown model drives part of the gain.** "Thin markdown demand" (appetite × 0.25) shows how much of the result
  depends on buyers responding to discounts.
- **Synthetic data.** All quantities, prices and costs are synthetic (city coordinates and road times are approximately real).
`;
mkdirSync('docs', { recursive: true });
writeFileSync('docs/EVALUATION.md', md);
console.log(`Wrote evaluation/results.json and docs/EVALUATION.md in ${seconds} s`);
