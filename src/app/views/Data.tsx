import { useRef, useState } from 'react';
import { useStore } from '../store';
import { Callout, Icon, Seg, commodityColor } from '../ui';
import { validateScenario } from '../../engine/validate';
import { SESSION_GRACE_HOURS, clock, leadHours, saleSession } from '../../engine/time';
import { MIP_REL_GAP } from '../../engine/solver';
import { TIE_BREAK } from '../../engine/optimize';
import { hours, kg, perKg, rupees } from '../../engine/fmt';
import { download } from './Plan';
import type { Issue } from '../../engine/types';

type Tab = 'assumptions' | 'batches' | 'outlets' | 'demand' | 'commodities' | 'import';

export function DataView() {
  const st = useStore();
  const [tab, setTab] = useState<Tab>('assumptions');
  return (
    <>
      <div className="page-head">
        <div>
          <div className="upper">Step 7 · Inspect everything</div>
          <h1>Data & assumptions</h1>
          <p>The complete input of the current scenario and every modelling rule the engine applies. Nothing the engine uses is hidden from this page.</p>
        </div>
      </div>
      <div style={{ marginBottom: 14, overflowX: 'auto' }}>
        <Seg
          label="Section"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'assumptions', label: 'Model & assumptions' },
            { value: 'batches', label: 'Batches' },
            { value: 'outlets', label: 'Outlets & lanes' },
            { value: 'demand', label: 'Demand & prices' },
            { value: 'commodities', label: 'Commodities' },
            { value: 'import', label: 'Import / export' },
          ]}
        />
      </div>
      {st.importIssues.length > 0 && tab !== 'import' && (
        <div style={{ marginBottom: 12 }}>
          <Callout kind="warn">This scenario was imported with {st.importIssues.length} repair(s). See Import / export.</Callout>
        </div>
      )}
      {tab === 'assumptions' && <Assumptions />}
      {tab === 'batches' && <Batches />}
      {tab === 'outlets' && <Outlets />}
      {tab === 'demand' && <Demand />}
      {tab === 'commodities' && <Commodities />}
      {tab === 'import' && <ImportExport />}
    </>
  );
}

function Assumptions() {
  const s = useStore().scenario;
  return (
    <div className="card card-pad prose">
      <h3>The decision</h3>
      <p>
        For every batch, the engine chooses how many kg leave on each dispatch night, for which outlet, and at which price tier they will sell; and how many trucks
        run on every lane each night. It is a mixed-integer linear programme solved to proven optimality (relative gap ≤ {MIP_REL_GAP * 100}%) by HiGHS, compiled
        to WebAssembly and running in your browser.
      </p>
      <h3>Hard constraints (never traded off)</h3>
      <ul>
        <li><b>Stock</b> — a batch never ships more than it holds, and never before it reaches the hub.</li>
        <li><b>Trucks</b> — load on a lane-night ≤ trucks × {kg(s.fleet.truckCapacityKg)}; trucks per night ≤ the fleet ({s.fleet.trucksPerDay.join(', ')}); lane limits and closures respected.</li>
        <li><b>Shelf life</b> — a load is only planned if, when its market session opens, it still has at least the buyer's minimum remaining life.</li>
        <li><b>Demand</b> — no session receives more than it can absorb at list price plus the markdown tiers.</li>
      </ul>
      <h3>Time</h3>
      <p>
        Hour 0 is 00:00 on D0. Trucks leave at {String(s.dispatchHour).padStart(2, '0')}:00 each night after {s.hub.loadHours} h of loading; a load reaches the
        first market session that opens after it is unloaded, or the current session if it arrives within {SESSION_GRACE_HOURS} h of opening. Shelf life is judged
        at the moment the lot is offered for sale. Example: dispatched D0 to {s.destinations[0]?.short}, lead time{' '}
        {s.destinations[0] ? hours(leadHours(s, s.destinations[0], 0)) : '—'}, sells in the D{s.destinations[0] ? saleSession(s, s.destinations[0], 0) : '—'} session (
        {s.destinations[0] ? clock(24 * saleSession(s, s.destinations[0], 0) + s.destinations[0].marketOpenHour) : ''}).
      </p>
      <h3>Freshness grades and markdowns</h3>
      <p>
        A lot with at least the commodity's <i>list-price life</i> left at sale may sell at list price; with less, but above the <i>minimum sale life</i>, it only
        sells at a markdown; below that it is rejected. Retail DCs demand extra life; the processor accepts almost anything. Markdown tiers are{' '}
        {s.discountTiers.map((d) => `−${Math.round(d * 100)}%`).join(' and ')}. The extra demand a markdown unlocks follows constant elasticity:{' '}
        <code>D · appetite · [(1−δₖ)^(−ε) − (1−δₖ₋₁)^(−ε)]</code>, with ε per commodity and an appetite factor per outlet. Discounted lots are assumed to reach
        price-sensitive buyers without cannibalising list-price sales.
      </p>
      <h3>Economics (one ledger for every plan)</h3>
      <ul>
        <li><b>Revenue</b> — only kg actually sold, at the price actually realised. Unsold, rejected or expired kg earn nothing.</li>
        <li><b>Transport</b> — trucks dispatched × lane rate, plus any per-kg freight. A truck is paid in full however empty it runs.</li>
        <li><b>Handling</b> — per kg dispatched.</li>
        <li><b>Spoilage cost</b> — per kg spoiled at the hub or written off at a market (write-off + disposal, as defined per commodity).</li>
        <li><b>Shortfall penalty</b> — per kg of contract demand not served at list price (retail DC).</li>
        <li><b>Carry-over value</b> — stock still viable after the horizon (onions) is valued, not counted as spoilage.</li>
        <li><b>Net</b> = revenue − transport − handling − spoilage − shortfall + carry-over. The optimiser maximises exactly this; a test checks that its objective and the ledger agree.</li>
        <li><b>Fulfilment</b> = customer demand served at list price ÷ customer demand. Salvage outlets place no orders and are excluded. Markdown sales are reported separately.</li>
      </ul>
      <h3>Baselines</h3>
      <p>
        <b>FEFO</b>: each night, first-expired-first-out; each batch goes to the best net-price market that still has list-price demand and where it arrives fresh
        enough; a truck is opened only if the load on it pays for it. <b>FEFO + clearance</b> adds: once a batch can no longer make list price anywhere, mark it
        down wherever that beats spoiling. Both respect every hard constraint.
      </p>
      <h3>Tie-breaking and service weight</h3>
      <p>
        Among plans of equal value the solver prefers first-expired-first-out ({TIE_BREAK} ₹/kg per hour of life left — far below any real margin; excluded from
        reported values). An optional service weight (Trade-offs) adds a value per kg served; it is off by default and never included in reported net.
      </p>
      <h3>Uncertainty</h3>
      <p>
        Stress tests perturb shelf life (per commodity CV), transit time (lognormal per lane-night), demand (±{Math.round(s.uncertainty.demandCv * 100)}%) and
        price (±{Math.round(s.uncertainty.priceCv * 100)}%) with seeded randomness, and execute each plan unchanged. The risk-buffered plan is planned against
        shortened shelf lives, longer trips and lower demand; its buffer is chosen on training futures and reported on separate test futures.
      </p>
      <h3>Known limitations</h3>
      <ul>
        <li>Single hub, single truck type, no storage at destinations, no temperature model; trucks are hired per trip (no round-trip fleet scheduling).</li>
        <li>Prices are exogenous; FreshRoute's own volumes do not move list prices beyond the markdown tiers.</li>
        <li>All data is synthetic; city coordinates and approximate road times are real. Nothing shown is a live vehicle or a live market price.</li>
      </ul>
    </div>
  );
}

function Batches() {
  const s = useStore().scenario;
  return (
    <div className="card table-wrap">
      <table className="t">
        <thead>
          <tr><th>Batch</th><th>Commodity</th><th className="r">Quantity</th><th className="r">Shelf life left</th><th>Expires</th><th>At hub from</th><th>Source</th></tr>
        </thead>
        <tbody>
          {s.batches.map((b) => (
            <tr key={b.id}>
              <td style={{ fontWeight: 600 }}>{b.id}</td>
              <td><span className="badge"><span className="dot" style={{ background: commodityColor(s, b.commodityId) }} />{s.commodities.find((c) => c.id === b.commodityId)?.name}</span></td>
              <td className="r num">{kg(b.quantityKg)}</td>
              <td className="r num">{hours(b.remainingShelfLifeHours)}</td>
              <td className="num">{clock(b.remainingShelfLifeHours)}</td>
              <td>D{b.availableFromDay}</td>
              <td className="small ink2">{b.source ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Outlets() {
  const s = useStore().scenario;
  return (
    <div className="card table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Outlet</th><th>Type</th><th className="r">Road</th><th className="r">Dock</th><th className="r">Opens</th><th className="r">D0 sells</th>
            <th className="r">₹/truck</th><th className="r">Shortfall pen.</th><th className="r">Markdown appetite</th><th className="r">Freshness offset</th><th>Disruptions</th>
          </tr>
        </thead>
        <tbody>
          {s.destinations.map((d) => (
            <tr key={d.id}>
              <td style={{ fontWeight: 600 }}>{d.name}</td>
              <td className="small">{d.salvageOutlet ? 'salvage' : d.type.replace('_', ' ')}</td>
              <td className="r num">{d.transitHours} h</td>
              <td className="r num">{d.dockHours} h</td>
              <td className="r num">{String(d.marketOpenHour).padStart(2, '0')}:00</td>
              <td className="r num">D{saleSession(s, d, 0)}</td>
              <td className="r num">{rupees(d.costPerTruck)}</td>
              <td className="r num">{d.shortfallPenaltyPerKg ? perKg(d.shortfallPenaltyPerKg) : '—'}</td>
              <td className="r num">{d.markdownAppetite}</td>
              <td className="r num">{d.freshnessOffsetHours > 0 ? '+' : ''}{d.freshnessOffsetHours} h</td>
              <td className="small ink2">
                {[d.closedDays?.length ? `closed D${d.closedDays.join(', D')}` : '', d.transitDelayByDay?.some((x) => x) ? `delays ${d.transitDelayByDay.map((x, i) => (x ? `D${i}+${Math.round(x)}h` : '')).filter(Boolean).join(' ')}` : ''].filter(Boolean).join(' · ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Demand() {
  const s = useStore().scenario;
  const sessions = [...new Set(s.demand.map((r) => r.session))].sort((a, b) => a - b);
  return (
    <div className="card table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Outlet</th><th>Commodity</th>
            {sessions.map((x) => (
              <th key={x} className="r">D{x} session</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {s.destinations.flatMap((d) =>
            s.commodities
              .filter((c) => s.demand.some((r) => r.destId === d.id && r.commodityId === c.id))
              .map((c) => (
                <tr key={d.id + c.id}>
                  <td style={{ fontWeight: 600 }}>{d.short}</td>
                  <td>{c.name}</td>
                  {sessions.map((x) => {
                    const r = s.demand.find((q) => q.destId === d.id && q.commodityId === c.id && q.session === x);
                    return (
                      <td key={x} className="r num small">
                        {r ? <>{kg(r.quantityKg)} <span className="muted">@ ₹{r.pricePerKg.toFixed(1)}</span></> : <span className="muted">—</span>}
                      </td>
                    );
                  })}
                </tr>
              )),
          )}
        </tbody>
      </table>
    </div>
  );
}

function Commodities() {
  const s = useStore().scenario;
  return (
    <div className="card table-wrap">
      <table className="t">
        <thead>
          <tr>
            <th>Commodity</th><th className="r">Handling</th><th className="r">Spoilage cost</th><th className="r">Carry value</th><th className="r">Min. sale life</th>
            <th className="r">List-price life</th><th className="r">Elasticity ε</th><th className="r">Shelf-life CV</th>
          </tr>
        </thead>
        <tbody>
          {s.commodities.map((c) => (
            <tr key={c.id}>
              <td><span className="badge"><span className="dot" style={{ background: commodityColor(s, c.id) }} />{c.name}</span></td>
              <td className="r num">{perKg(c.handlingCostPerKg)}</td>
              <td className="r num">{perKg(c.spoilageCostPerKg)}</td>
              <td className="r num">{c.carryValuePerKg ? perKg(c.carryValuePerKg) : '—'}</td>
              <td className="r num">{c.minSaleLifeHours} h</td>
              <td className="r num">{c.fullPriceLifeHours} h</td>
              <td className="r num">{c.elasticity}</td>
              <td className="r num">±{Math.round(c.shelfLifeCv * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ImportExport() {
  const st = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [issues, setIssues] = useState<Issue[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = (raw: string) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      setIssues([{ severity: 'error', path: '$', message: `Not valid JSON: ${(e as Error).message}` }]);
      setFailed(true);
      return;
    }
    const v = validateScenario(parsed);
    setIssues(v.issues);
    setFailed(!v.scenario);
    if (v.scenario) st.importScenario(v.scenario, v.issues);
  };
  const shown = issues ?? (st.importIssues.length ? st.importIssues : null);

  return (
    <div className="grid g2">
      <div className="card card-pad stack">
        <div>
          <h2 style={{ margin: '0 0 4px', fontSize: 15 }}>Export</h2>
          <p className="small ink2" style={{ margin: 0 }}>The current scenario as JSON — the exact input the engine plans on. Edit it and import it back.</p>
        </div>
        <div className="row">
          <button className="btn" onClick={() => download(`freshroute-scenario-${st.scenario.id}.json`, st.scenario)}>
            <Icon name="download" size={14} /> Download scenario JSON
          </button>
        </div>
        <div>
          <h2 style={{ margin: '12px 0 4px', fontSize: 15 }}>Import</h2>
          <p className="small ink2" style={{ margin: 0 }}>
            Load a scenario file. Every row is validated: unusable rows are dropped, fixable values repaired, and each change listed — nothing is silently
            ignored.
          </p>
        </div>
        <div className="row">
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) load(await f.text());
              e.target.value = '';
            }}
          />
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={14} /> Choose JSON file
          </button>
        </div>
        <textarea className="code" placeholder="…or paste scenario JSON here" value={text} onChange={(e) => setText(e.target.value)} aria-label="Scenario JSON" />
        <div className="row">
          <button className="btn primary" disabled={!text.trim()} onClick={() => load(text)}>
            Validate and load
          </button>
          <button
            className="btn ghost"
            onClick={() => {
              const broken = JSON.parse(JSON.stringify(st.scenario));
              broken.batches[0].quantityKg = -500;
              broken.batches[1].commodityId = 'MANGO';
              broken.batches[2].remainingShelfLifeHours = 'about two days';
              broken.demand.push({ ...broken.demand[0] });
              broken.fleet.trucksPerDay = [broken.fleet.trucksPerDay[0]];
              setText(JSON.stringify(broken, null, 2));
            }}
          >
            Fill with a deliberately broken example
          </button>
        </div>
      </div>
      <div className="card card-pad">
        <h2 style={{ margin: '0 0 8px', fontSize: 15 }}>Validation report</h2>
        {!shown && <p className="small muted">Nothing imported yet. The bundled scenarios pass validation without changes.</p>}
        {shown && (
          <div className="stack" style={{ gap: 8 }}>
            {failed ? (
              <Callout kind="crit">Not loaded: the file has errors that make planning impossible. The previous scenario is still active.</Callout>
            ) : (
              <Callout kind={shown.length ? 'warn' : 'info'}>Loaded "{st.scenario.name}" with {shown.length} repair{shown.length === 1 ? '' : 's'}. Generate a plan to use it.</Callout>
            )}
            <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
              {shown.map((i, k) => (
                <li key={k} className={i.severity === 'error' ? 'bad' : 'ink2'}>
                  <code className="mono">{i.path}</code> — {i.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
