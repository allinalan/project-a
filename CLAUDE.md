# Command Center — All in Alan (data rules)

Single-file dashboard (`index.html`) + data store (`data.json`). GitHub Pages serves
from `main`. Weekly stats and the event profitability log are entered separately and
reconciled on the Event Profitability tab.

## Golden rules

1. **Never modify historical values in `data.json`** unless Alan explicitly asks.
   Every week must satisfy the invariant: `cpo == ev + scp + se + mkt + biz + fed + demo`.
2. All engine changes go through a PR to `main`; `data.json` changes ride Alan's own
   save pipeline.

## Order classification when analyzing exports

When parsing an order export into weekly stats:

- Bucket orders by their **order type flag**, not by where they were written.
- **"Event Service" rule:** an order written at an event (location/source says Event)
  whose order flag says **Event Service** counts as a **Service Call** order:
  - weekly stats: add its CPO to `scp` and its order count to `sco` — **not** `ev`/`evOrd`
  - it still counts inside the week's total `cpo` exactly once
- For **event attribution**, that same revenue is additionally recorded on the event's
  entry in `events[]` (Step 3 / Event Profitability) as:
  - `svcCPO` — Event Service CPO written at that event
  - `svcOrd` — Event Service order count
  These fields are attribution-only: they are **not** added to the event's `cpo`
  (which stays pure Event-bucket revenue), but they **do** count toward the event's
  commission and net profit, since the event produced that revenue.
- The dashboard's Event Profitability tab shows the reclassified amount per event and
  a YTD "sourced at events" total, so event ROI still gets full credit.

## Field glossary (weekly entries)

`cpo`/`ord` totals · `ev`/`evOrd`/`evSh` traditional events · `scp`/`sco`/`scb`/`scc`
service calls (CPO/orders/booked/completed) · `se`/`seOrd` service events ·
`mkt`, `biz`, `fed`(+`fedSh`), `demo`(+booked/comp) other buckets · `daysOff`,
`workDays`, `isVacation` (7 days off = vacation) · `target`, `tnote` planning.

Projections (`projections[wk]`) store Service Calls under the key **`sc`** (not `scp`).
