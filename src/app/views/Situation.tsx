import { useMemo } from 'react';
import { useStore } from '../store';
import { Callout, Icon, Stat } from '../ui';
import { FlowMap, ShelfLifeChart, ShelfLegend, reachability } from '../charts';
import { kg, rupeesCompact } from '../../engine/fmt';

export function Situation() {
  const st = useStore();
  const s = st.scenario;
  const reach = useMemo(() => reachability(s), [s]);

  const inv = s.batches.reduce((a, b) => a + b.quantityKg, 0);
  const atHub = s.batches.filter((b) => b.availableFromDay === 0).reduce((a, b) => a + b.quantityKg, 0);
  const custDemand = s.demand.filter((r) => !s.destinations.find((d) => d.id === r.destId)?.salvageOutlet);
  const demandKg = custDemand.reduce((a, r) => a + r.quantityKg, 0);
  const listValue = custDemand.reduce((a, r) => a + r.quantityKg * r.pricePerKg, 0);
  const fleetKg = s.fleet.trucksPerDay.reduce((a, n) => a + n, 0) * s.fleet.truckCapacityKg;
  const d0Kg = (s.fleet.trucksPerDay[0] ?? 0) * s.fleet.truckCapacityKg;

  const stranded = s.batches.filter((b) => reach.get(b.id)!.lastSaleDay === null);
  const tonight = s.batches.filter((b) => {
    const r = reach.get(b.id)!;
    return r.lastListPriceDay !== null && r.lastListPriceDay <= b.availableFromDay;
  });
  const noList = s.batches.filter((b) => {
    const r = reach.get(b.id)!;
    return r.lastListPriceDay === null && r.lastSaleDay !== null;
  });
  const sum = (bs: typeof s.batches) => bs.reduce((a, b) => a + b.quantityKg, 0);
  const atRisk = sum(stranded) + sum(tonight) + sum(noList);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="upper">Step 1 · D0 00:00 · {s.hub.name}</div>
          <h1>{s.name}</h1>
          <p>{s.description}</p>
        </div>
        <div className="actions">
          <button
            className="btn primary"
            onClick={() => {
              if (st.plan.status !== 'done') st.runPlan();
              st.setView('plan');
            }}
          >
            <Icon name="play" size={14} /> {st.plan.status === 'done' ? 'Open the plan' : 'Generate dispatch plan'}
          </button>
        </div>
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="Inventory to place" value={kg(inv)} delta={{ text: `${s.batches.length} batches`, good: null, vs: `${kg(atHub)} at the hub tonight` }} />
        <Stat
          label="Shelf-life risk"
          value={kg(atRisk)}
          delta={{ text: `${Math.round((atRisk / Math.max(1, inv)) * 100)}% of stock`, good: atRisk === 0 ? true : null, vs: 'must leave tonight, needs markdown, or cannot be sold' }}
        />
        <Stat label="Customer demand in horizon" value={kg(demandKg)} delta={{ text: rupeesCompact(listValue), good: null, vs: 'at list price' }} />
        <Stat
          label="Truck capacity"
          value={kg(fleetKg)}
          delta={{ text: `${kg(d0Kg)} tonight`, good: d0Kg >= atHub ? true : false, vs: d0Kg >= atHub ? 'enough for all stock at the hub' : `short of ${kg(atHub - d0Kg)} at the hub` }}
        />
      </div>

      <div className="stack" style={{ marginBottom: 16, gap: 8 }}>
        {stranded.length > 0 && (
          <Callout kind="crit">
            <b>{stranded.map((b) => b.id).join(', ')}</b> ({kg(sum(stranded))}) cannot reach any buyer with enough shelf life left. No plan can sell
            {stranded.length > 1 ? ' them' : ' it'}; FreshRoute will book {stranded.length > 1 ? 'them' : 'it'} as spoilage under every plan, including the baseline.
          </Callout>
        )}
        {tonight.length > 0 && (
          <Callout kind="warn">
            <b>{tonight.map((b) => b.id).join(', ')}</b> ({kg(sum(tonight))}) can only earn list price if dispatched on {tonight.length > 1 ? 'their' : 'its'} first possible night.
          </Callout>
        )}
        {noList.length > 0 && (
          <Callout kind="warn">
            <b>{noList.map((b) => b.id).join(', ')}</b> ({kg(sum(noList))}) will arrive anywhere too ripe for list price: a markdown, the processor, or a write-off.
          </Callout>
        )}
        {d0Kg < atHub && (
          <Callout kind="neutral" icon="truck">
            Tonight's {s.fleet.trucksPerDay[0]} trucks carry {kg(d0Kg)}, but {kg(atHub)} is at the hub. Something has to wait — the question is what.
          </Callout>
        )}
      </div>

      <div className="grid g-main">
        <div className="card">
          <div className="card-head">
            <h2>Shelf-life clock</h2>
            <span className="sub">Every batch's remaining life against the dispatch waves — most urgent first</span>
          </div>
          <div className="card-body">
            <ShelfLifeChart scenario={s} />
            <div style={{ marginTop: 8 }}>
              <ShelfLegend planned={false} />
            </div>
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Network</h2>
              <span className="sub">Schematic · true bearing from the hub, distance = road time</span>
            </div>
            <div className="card-body">
              <FlowMap scenario={s} height={300} />
              <p className="small muted" style={{ margin: '6px 0 0' }}>
                Nothing on this map is a live vehicle. Dashed lanes have no planned dispatch yet.
              </p>
            </div>
          </div>
          <div className="card card-pad">
            <div className="upper" style={{ marginBottom: 8 }}>What the engine decides</div>
            <ul className="small ink2" style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
              <li>For every batch: which night it leaves, where it goes, how much, and at what price tier.</li>
              <li>How many trucks run on each lane each night, within the fleet.</li>
              <li>What to mark down, and what is not worth moving at all.</li>
              <li>It maximises net outcome (revenue − freight − handling − spoilage − penalties) and proves optimality with HiGHS.</li>
            </ul>
          </div>
        </div>
      </div>
    </>
  );
}
