# Command Center — All in Alan (data rules)

Single-file dashboard (`index.html`) + data store (`data.json`). GitHub Pages serves
from `main`. Weekly stats and the event profitability log are entered separately and
reconciled on the Event Profitability tab.

## Golden rules

1. **Never modify historical values in `data.json`** unless Alan explicitly asks.
   Every week must satisfy the invariant:
   `cpo == ev + scp + se + mkt + biz + fed + demo + ror`.
2. All engine changes go through a PR to `main`; `data.json` changes ride Alan's own
   save pipeline.

## Order classification when analyzing exports

When parsing an order export into weekly stats:

- Bucket orders by their **order type flag**, not by where they were written.
- **"RoR Received" rule:** an order where Alan is the Rep of Record but did NOT
  work the event/appointment that produced it (e.g. his customer bought at a
  service event another rep worked) goes in the **`ror`/`rorOrd`** bucket —
  never in `se`, `ev`, or `scp`. It still counts once in the week's total `cpo`
  (it is real CPO with commission), but it must not touch any activity-based
  metric: RoR revenue is excluded from $/shift, orders/shift, and
  CPO-per-working-day calculations, and no event-log entry is created for it.
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
- **Late-order / add-on rule (no retro-edits, no double counting):** revenue is
  booked in the week the ORDER IS PLACED (export order date) — even when the
  appointment that produced it happened in an earlier week. Never retro-edit a
  closed week for a late-closing sale or an order add-on; each order appears in
  exactly one export week, so counting strictly by order date makes double
  counting impossible. Two corollaries:
  - A no-sale appointment that closes later: the appointment was already counted
    (`scb`/`scc`) in the week it was worked — do NOT count it again in the week
    the order lands. YTD closing ratio self-corrects.
  - An add-on to an existing order (same appointment): CPO books in the add-on's
    order week, same bucket as the original — but it is **CPO only, never a new
    order**. Do not increment `ord` or the bucket's order count (`sco`, `evOrd`,
    etc.) for an add-on, even if the export gives it its own order number: one
    appointment + one customer = one order in the stats. Never re-count the
    appointment either. (Practical test when parsing an export: same customer,
    add-on/amendment to an order already counted in a prior week → CPO only.)

## Weekly stats reconcile (fallback for missed weeks)

Weeks run Tuesday → Monday. If a completed week is missing from `weeks[]`, rebuild it
from primary sources — never from a Slack post.

**Preferred path — the VectorConnect order export.** Alan has tooling on his Mac that
logs into VectorConnect and exports the order list; that export is the authoritative
record (it is what the "Order classification when analyzing exports" rules above are
written for) and it is the only source that shows RoR-received orders, which generate
no rep receipt email. Use it whenever the session can reach it.

**When the export is not reachable, say so — do not substitute silently.** Cloud
(claude.ai/code) sessions cannot run it: `vectorconnect.com` is blocked by the
environment's network policy (the agent proxy returns 403), there is no browser
profile carrying Alan's login, and the export tooling is local to his Mac. A session
in that position uses the receipt fallback below and must state plainly, in its PR
and its summary, that the numbers are receipt-derived and unvalidated against an
export.

**Fallback — Gmail receipts (works from any session):**

- **Source:** VectorConnect order receipt emails in Gmail
  (`service@mail.vectormarketing.com`, subject "Order Receipt for …"). The attached
  `order_<num>_rep.pdf` carries Order Date, the Customer Type flag, the Event name,
  and the true CPO (second amount column on the "Order Total" row). Cross-check
  completeness against the daily "Updates for your Cutco customers' orders" digests
  from `service@cutco.com` (Processed Orders tables).
- **Bucketing by receipt flags:** Event says "… Service & Sales Event" → `se`/`seOrd`;
  any other Event booth sale → `ev`/`evOrd`; Customer Type "Service Call" → `scp`/`sco`;
  re-orders by text/email/phone with no event → `mkt`/`mktOrd`; RoR and add-on rules
  above still apply.
- **Activity fields** (evSh, scb/scc, `_seb`/`_sec`, daysOff, workDays) come from the
  CUTCO Google Calendar, not from orders.
- **Yellow rule (appointment completion):** a customer appointment block colored
  YELLOW in Google Calendar (colorId "5") means the customer rescheduled or
  no-showed — it counts in booked (`scb`/`_seb`) but NOT in completed
  (`scc`/`_sec`). Completed appointments are the non-yellow ones (Alan's normal
  appointment color is green, colorId "10"). A Calendly cancellation/reschedule
  email is an equivalent signal. Calendly RSVP status alone proves nothing —
  customers cancel by text and the booking stays "accepted".
- **Do not detect the week via Slack search.** The Slack connector's search API
  returns zero results in this workspace for every query, which is what produced the
  "no summary detected" failure that silently dropped Aug 18–24, 2026. A scheduled
  Routine ("Weekly stats reconcile — Command Center") runs Tuesday mornings and fills
  any missing prior week from receipts on a branch for Alan to review and merge.

## Field glossary (weekly entries)

`cpo`/`ord` totals · `ev`/`evOrd`/`evSh` traditional events · `scp`/`sco`/`scb`/`scc`
service calls (CPO/orders/booked/completed) · `se`/`seOrd` service events ·
`mkt`, `biz`, `fed`(+`fedSh`), `demo`(+booked/comp) other buckets ·
`ror`/`rorOrd` RoR CPO received (passive — excluded from activity metrics) · `daysOff`,
`workDays`, `isVacation` (7 days off = vacation) · `target`, `tnote` planning.

Projections (`projections[wk]`) store Service Calls under the key **`sc`** (not `scp`).
