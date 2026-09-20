# Channels Pilot Operations

This runbook covers the TCGplayer phase-1 manual-sync pilot only. It does not
restate #7031 acceptance criteria, and it does not document connector,
pairing, or order-absorption procedures — those remain owned by the
connector-client slice and reconciliation's inbound-sale work
(`bounded-contexts/channels/README.md`).

## Scope

TCGplayer phase 1 is the manual-sync round trip: an operator composes a
Staged Import Batch from a claimed outbound reservation, hand-carries it
through the TCGplayer Seller Portal, and ingests the resulting Live or Staged
export. There is no automated provider call in this phase. Everything below
describes the surfaces that exist at current `main`; a route or action not
named here does not exist for this pilot.

## Evidence And Redaction Rules

Evidence for phase-1 operator actions is the `phase1WatchLog` record referenced
in #7728 and #7729. This runbook does not define its wire format; capture the
fields listed in "Evidence Capture Checklist" below and cite the issue for the
authoritative shape.

The redaction rules match
[TCGplayer Automation Operations](./tcgplayer-automation-operations.md#logging-and-retention).
Do not log or persist, in `phase1WatchLog` entries, screenshots, or launch
evidence:

- `TCGAuthTicket_Production` or complete `Cookie` headers;
- `Authorization` headers;
- seller names, seller ids, seller keys, seller email, phone, or
  account-specific marketplace identifiers;
- raw provider request bodies when they include account, seller, or listing
  controls;
- raw provider response bodies outside the bounded context's explicit
  source-payload retention policy.

Redact seller-identifying values from CSV exports and Seller Portal
screenshots before attaching them to an evidence record. Batch ids, run ids,
connection ids, and state names are not seller-identifying and may be logged.

## Where Evidence Lives

- Connection and health state: `bounded-contexts/channels/README.md` (Connection state table, Connection Health section).
- Manual-sync run state and available actions:
  `bounded-contexts/channels/features/manual-sync/domain/contracts.ts`
  (`resolveManualSyncActions`).
- Manual-sync runtime behavior:
  `bounded-contexts/channels/features/manual-sync/api/runtime.ts`.
- Operator evidence: the `phase1WatchLog` record (#7728, #7729).

## TCGplayer Phase 1

### Connect And Confirm Activation

Connector pairing itself is out of scope for this runbook (non-goal; owned by
the connector-client slice). `/account/channels`
(`bounded-contexts/channels/routes/marketplace/account-channels.tsx`) lists
every Channel Connection and its status. After pairing completes elsewhere,
confirm activation here: the connection's status reads `active` in the list
rendered by
`bounded-contexts/channels/features/connections/ui/connection-pages.tsx`. The
only connection actions exposed on this surface are `pause`, `resume`, and
`disconnect` (`allowedChannelConnectionActions` in `connection-pages.tsx`),
posted as `intent` form values to `POST /api/channels/connections/:id/pause`,
`/resume`, and `/disconnect`. There is no `connect` or `activate` action on
this route or its API — do not look for one.

### Pilot Inventory Intake

Go to `/account/inventory/imports`
(`bounded-contexts/inventory/routes/marketplace/account-inventory-imports.tsx`).
Submit the `create-batch` intent with:

- `sourceKey` = `tcgplayer-csv` (profile defined in
  `bounded-contexts/inventory/features/import-batches/domain/import-source-profiles.ts`);
- `quantityMode` = `replace` (labeled "Replace stock" in
  `bounded-contexts/inventory/features/import-batches/ui/import-batch-page.tsx`;
  type `InventoryImportQuantityMode` in
  `bounded-contexts/inventory/features/import-batches/domain/import-source-adapters.ts`).

Replace mode sets each row's stored quantity to the imported value directly
(reason code `correction`, reason "Import exact quantity" in
`bounded-contexts/inventory/features/import-batches/api/runtime.ts`) instead
of adding a delta. Confirm this is the intended pilot behavior before
committing the batch — a replace-mode import on stock the pilot does not
fully cover will zero out anything not present in the file.

Expected state after submission: the batch appears in the batches list and
the action redirects to `/account/inventory/imports?jobId=<jobId>`. Resolve
any unresolved rows through the `resolve-row` intent before committing.

### Repricing Policy Activation

Go to `/account/repricing`
(`bounded-contexts/pricing/routes/marketplace/account-repricing.tsx`). The
available actions are `refresh-recommendations`, `apply-recommendations`, and
`dismiss-recommendations`. Apply the recommendations covering pilot SKUs
through `apply-recommendations`; the action redirects to
`/account/repricing?jobId=<jobId>` and the applied recommendations move out of
the open list. There is no separate "activate policy" toggle distinct from
applying recommendations on this route.

### Inbound-Dark Clamp

For TCGplayer phase 1, inbound sale coverage is hard-coded dark: `buildPanel`
in `bounded-contexts/channels/features/manual-sync/api/runtime.ts` always
returns `inboundCoverage: { state: "dark", reason: "no-inbound-authority" }`.
This means the connector does not observe TCGplayer sales — a sale made on
TCGplayer will not automatically decrement Chase Sets inventory. Read this
value from the Manual Sync Panel
(`bounded-contexts/channels/features/manual-sync/ui/manual-sync-panel.tsx`)
before relying on cross-channel inventory accuracy, and treat any TCGplayer
sale as a manual inventory correction until Reconciliation phase 2 lands
(see #7700).

### Manual-Sync Round Trip

The Manual Sync Panel
(`bounded-contexts/channels/features/manual-sync/ui/manual-sync-panel.tsx`)
exposes the actions gated by `resolveManualSyncActions` in
`bounded-contexts/channels/features/manual-sync/domain/contracts.ts`, keyed
on the run's current state:

1. **Compose** (`compose`, run state `composed`): builds a new outbound
   reservation into a run.
2. **Claim and download** (`download`, run state `claimed`): claims the
   reservation and downloads the CSV export, posted to
   `/account/channels/${connectionId}/manual-sync/download`.
3. **Seller Portal Import Prices**: manual, off-platform. Upload the
   downloaded CSV in the TCGplayer Seller Portal price-import flow. Chase
   Sets has no API visibility into this step.
4. **Record upload attempt** (`record-upload-attempt`): tell the panel the
   Seller Portal import was submitted. This sets `uploadAttemptedAt` on the
   run and is irreversible for that run — see "Release, Abandon, And The
   No-Redelivery Rule" below.
5. **Import Summary receipt**: manual, off-platform. Capture the Seller
   Portal's Import Summary (success/row-error counts) as evidence.
6. **Verify** (`verify`, run state `awaiting-verification`): record the
   Import Summary outcome against the run.
7. **Export From Staged ingest** (`ingest-staged`) / **Export From Live
   ingest** (`ingest-live`): ingest the resulting TCGplayer export file back
   into Chase Sets to reconcile applied prices.

Byte and row limits for downloads and ingests
(`manualSyncIngestContract` in `contracts.ts`): live probe downloads up to
16 MB, staged exports up to 32 MB, and ingest files up to 100,000 rows.

### Lease Expiry, Release, Abandon, And The No-Redelivery Rule

A claimed reservation is time-leased. `bounded-contexts/channels/features/tcgplayer-csv/domain/lifecycle.ts`
defines exactly two ways a run reaches `abandoned`:

- **Lease expiry** (`reservation-lease-expired`): from `composed` or
  `claimed`, if the lease is not acted on in time, the run auto-abandons.
- **Release** (`release`): from `claimed` only, an operator can explicitly
  release the reservation.

`release` (and `recordValidationCancellation`) in
`bounded-contexts/channels/features/manual-sync/api/runtime.ts` refuse the
action once `uploadAttemptedAt` is set on the run — this is the
release-before-submission rule. Once "record upload attempt" has been used,
the run can only move forward through verify/ingest, never back through
release. This is the no-redelivery rule: a run that may have reached the
Seller Portal is never recomposed or reclaimed for redelivery; it is settled
forward to `applied`, `validation-rejected`, `application-unknown`,
`superseded`, or `stale-basis`, or is abandoned only before submission
(`bounded-contexts/channels/features/outbound-sync/domain/contracts.ts`, the
`toState` union).

## Procedures

### Pause And Resume The Connection

Use the `pause` and `resume` intents on `/account/channels`
(`connection-pages.tsx`, `allowedChannelConnectionActions`). Pausing sets the
connection's Channel Outbound Hold source to `seller-pause`
(`bounded-contexts/channels/features/reconciliation/api/runtime.ts`,
`readChannelOutboundHold`); resuming clears that source. Per
`bounded-contexts/channels/README.md` Invariant 9, a seller `paused` state
clears only through this seller command — Health does not write it and does
not clear it.

### Operator Kill Switch For Outbound Work

The kill switch is the `channels.outbound-kill-switch` platform policy
(`bounded-contexts/channels/features/reconciliation/domain/policy.ts`), a
closed record of `heldProviderKeys` and `heldConnectionIds` (unique,
ascending-sorted strings). Set it through the platform policy mechanism
(`definePolicy`/policy store), not through a dedicated admin UI — none exists
for this policy. To hold all TCGplayer outbound work, add the TCGplayer
provider key to `heldProviderKeys`; to hold one connection, add its
connection id to `heldConnectionIds`.

`readChannelOutboundHold` fails closed: if the policy value cannot be
decoded (`killSwitch === null`), outbound work for every connection is held,
not released. A malformed policy write is safe; a missing or corrupt policy
read is not silently permissive.

### Degraded Manual Mode

When the connector is absent or is paired but failing, Channel Health
(`bounded-contexts/channels/README.md`, Connection Health section) reports
`degraded` or `failing` through
`ChannelsServices.connectionHealth.readConnectionHealth`. Per the Connection
state table in that README, an `active` connection in a `failing` health
state has outbound publication held; manual-sync composition and claim are
unaffected by health, since the manual-sync round trip is entirely
operator-driven (no automated provider call in phase 1). Continue the manual
round trip above during degraded/failing health; do not attempt to
troubleshoot connector-level pairing here — that is the connector-client
slice's ownership.

### Possible Submission With No Summary

If "record upload attempt" was used but no Import Summary was ever obtained
(browser crash, lost Seller Portal session, operator uncertainty), do not
release, recompose, or reclaim the reservation — the no-redelivery rule
above forbids it once `uploadAttemptedAt` is set. Verify the run
(`verify` action) with the best available evidence, which will settle it to
`application-unknown` if the outcome cannot be confirmed
(`bounded-contexts/channels/features/outbound-sync/api/runtime.ts`, the
`awaiting-verification` → `application-unknown` mapping). Check the
TCGplayer Seller Portal directly for whether the price import actually
landed before assuming it did not; record the manual check in the
`phase1WatchLog` evidence for that run.

### Evidence Capture Checklist For `phase1WatchLog`

For each manual-sync round trip, capture:

- connection id, run id, and the action taken (compose/claim/download/record-upload-attempt/verify/ingest/release);
- timestamps for claim, upload attempt, and verify;
- the Import Summary outcome (success/error row counts only — no seller-identifying values);
- the inbound-dark clamp acknowledgment for the covered period;
- any operator kill-switch or connection pause/resume action taken during the window.

See #7728 and #7729 for the authoritative `phase1WatchLog` record shape.

## Phase 2

Not yet written; see #7700 phase 2 and #7037.

## eBay

Not yet written; see #7700 phase 2 and #7037.
