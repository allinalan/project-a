# Command Center Marketing: the store

The Marketing page keeps its plan here, not in `data.json` and not in the HUB's Sheets snapshot.
It is an Apps Script bound to its own Google Sheet ("Command Center Marketing"), separate from the
HUB's sync script, so nothing here can touch weekly stats, events or goals.

What it does:
- **Stores the plan** with a revision number. A save based on an old revision is refused and the
  caller re-applies its edit on the newer plan, so a stale tab, the calendar check and ALMA can never
  overwrite each other. Every save goes to History first (last 60 kept), then Store, then is read back.
- **Checks the calendar every Monday at 6am Arizona time**: purple all-day banners = shows and service
  events, lavender multi-day = sales. Confident matches move plan dates; everything else becomes a
  question on the page. If the calendar can't be read or comes back empty, nothing changes, the error
  shows on the page and in ALMA's morning note, and Google emails the trigger failure.
- **Answers ALMA** on the Mac mini: the morning digest, and the Claude drafts of next year's changes.
  Claude runs on the mini with the key from the Keychain; this script never holds an API key.
- Never sends email or texts, never touches the Vast Action CRM. Read-only calendar access.

## Setup (once, about 10 minutes)

1. In Google Drive (the account that owns your CUTCO Calendar), create a Google Sheet named **Command Center Marketing**.
2. In the Sheet: **Extensions → Apps Script**. Name the project **Command Center Marketing**.
3. **Project Settings** (gear): tick **Show "appsscript.json" manifest file in editor**.
4. Back in the **Editor**: open `appsscript.json`, replace everything with this repo's
   [`apps-script/appsscript.json`](appsscript.json). Open `Code.gs`, replace everything with
   [`apps-script/Marketing.gs`](Marketing.gs) (the raw file on GitHub, all of it). Save.
5. Pick **setup** in the function menu → **Run** → approve access (your Sheet, read your calendar,
   run on a schedule). The execution log prints the **store key**. It also stays under
   Project Settings → Script properties → `MA_KEY`.
6. Optional: run **testCalendar**. The log lists what the check will read, and nothing is saved.
7. **Deploy → New deployment →** type **Web app**, Execute as **Me**, Who has access **Anyone** →
   Deploy. Copy the **Web app URL** (ends in `/exec`).
8. Send Claude the URL. Put the key in the mini's Keychain (Claude opens the prompt for you):
   `security add-generic-password -U -a vector-assistant -s cc_marketing_key -w`
9. On each device, open the Command Center → Marketing and paste the key once.

## Updating the script

Edit `marketing/calcore.js`, `marketing/engine.js` or `apps-script/Marketing.src.gs`, run
`node tools/build-gs.js`, then paste the new `Marketing.gs` into the editor and
**Deploy → Manage deployments → edit (pencil) → Version: New version → Deploy**. Editing the existing
deployment keeps the URL; a *new* deployment would change it.

## From the Mac mini

```
node tools/store.js status               # revision, items, last calendar check, Claude drafts waiting
node tools/store.js history              # the last 60 saves
node tools/store.js restore --rev N      # put revision N back as the newest (nothing is deleted)
node tools/store.js backup --out f.json  # a copy of the plan (600 mode; never commit it)
```

## Actions (POST, text/plain JSON body with `action` and `key`)

`ping` (no key) · `load` · `save {baseRev, doc, hash}` · `calcheck` · `digest {today?}` ·
`pending` · `propose {pk, id, requestedAt, raw, model}` · `drafterror {pk, id, requestedAt, message}` ·
`history` · `restore {rev}`
