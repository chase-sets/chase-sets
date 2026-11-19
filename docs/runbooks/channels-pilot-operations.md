# Channels Pilot Operations

This runbook covers the TCGplayer phase-1 manual-sync pilot and the supported
seller connector build/load handoff. It does not restate #7031 acceptance
criteria or document order-absorption procedures, which remain owned by
reconciliation's inbound-sale work (`bounded-contexts/channels/README.md`).

## Scope

TCGplayer phase 1 is the manual-sync round trip: an operator composes a
Staged Import Batch from a claimed outbound reservation, hand-carries it
through the TCGplayer Seller Portal, and ingests the resulting Live or Staged
export. There is no automated provider call in this phase. Everything below
describes the surfaces that exist at current `main`; a route or action not
named here does not exist for this pilot.

## Evidence And Redaction Rules

For production packages, use the shared [Operator-Package Target Reachability](../../.agents/skills/delivery/SKILL.md#operator-package-target-reachability) gate before package READY, at host signal and at window-open re-verification. The #7728 inventory includes Account Channels, connection and publication routes, the manual-sync download route, Admin `/catalog/catalog-items/<id>`, Seller Portal entry, all sign-in hops and tooling/API calls. Never claim a reservation or send a mutating download request to prove reachability. Preserve read-only Phase A, performer/custody and no-redelivery gates; routing evidence is neither authenticated data proof nor execution GO.

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
  `bounded-contexts/channels/features/manual-sync/api/runtime.ts`
  (`buildPanel`, `assertManualRunAction`).
- Operator evidence: the `phase1WatchLog` record (#7728, #7729).

## TCGplayer Phase 1

### Seller Connector Build And Load

Register one public client per environment. The request is an ordinary `POST`
to the environment origin (the register mount does not require a seller actor):

```http
POST <origin>/channel-connector/oauth/register
Content-Type: application/json

{"redirect_uri":"https://ebnhngdhefamkdjajldafonajgkadfhh.chromiumapp.org/ucp/oauth/callback","scope":"channel-connector:claim channel-connector:report channel-connector:ingest","token_endpoint_auth_method":"none"}
```

Keep only the returned public `cc_client_<uuid>` identifier. Verify the
registration before building. The authorize route requires all six query
parameters, including a 43-character base64url challenge and state; these
literal PowerShell probes must not follow the callback redirect:

```powershell
$origin = 'https://marketplace.staging.chasesets.com'
$redirect = 'https://ebnhngdhefamkdjajldafonajgkadfhh.chromiumapp.org/ucp/oauth/callback'
$challenge = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
$state = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
$registered = '<client-id>'
$unregistered = 'cc_client_00000000-0000-4000-8000-000000000000'
$authorize = "$origin/channel-connector/oauth/authorize?response_type=code&client_id={0}&redirect_uri={1}&code_challenge=$challenge&code_challenge_method=S256&state=$state"
(Invoke-WebRequest -MaximumRedirection 0 -SkipHttpErrorCheck -Uri ($authorize -f $registered, $redirect)).StatusCode
# Expected: 302, with Location containing error_description=authorization_refused.
(Invoke-WebRequest -MaximumRedirection 0 -SkipHttpErrorCheck -Uri ($authorize -f $unregistered, $redirect)).StatusCode
# Expected: 400.
```

Record the client id and the two status observations in the executing issue,
never in a trace or connector receipt.

Build a reproducible handoff from a clean worktree. Replace `<client-id>` with
the registered public identifier:

```powershell
pnpm --filter @chase-sets/app-tcgplayer-connector-extension run build:handoff -- --target staging --client-id <client-id>
```

Inspect `artifacts/connector-extension/handoff.json`. It binds the source
commit, target origin, public client id, pinned extension id, version, and
every emitted-file digest, and records that both builds were identical. Load
the retained unpacked directory at
`artifacts/connector-extension/<target>/` in Chromium (`chrome://extensions` →
**Load unpacked**), then reload that directory after a rebuild. Remove the unpacked
extension when the session ends. This procedure never contacts TCGplayer; only
the extension's separately governed browser flow can do so.

### Connect And Confirm Activation

Connector pairing itself is out of scope for this runbook (non-goal; owned by
the connector-client slice). `/account/channels`
(`bounded-contexts/channels/routes/marketplace/account-channels.tsx`) lists
every Channel Connection and its status. After pairing completes elsewhere,
confirm activation here: the connection's status reads `active` in the list
rendered by
`bounded-contexts/channels/features/connections/ui/connection-pages.tsx`. The
only connection actions exposed on this surface are `pause`, `resume`, and
`disconnect` (the Channels API `allowedActions` response),
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

### Ready to Ship Founder Canary

**Live no-go.** The package for [#11555 Intake a qualified Ready to Ship canary through the claimed connector](https://github.com/chase-sets/chase-sets/issues/11555)
does not authorize launch or intake. Do not open Chrome or sign in until the
exact head has passed independent review and the founder window is separately
admitted. A qualified receipt is not sale authority. Real sale effects require
Todd to separately authorize that exact opaque page claim for the already-paired
connection, after teardown and before the handoff expires. Require hosted
exact-head DB proof for the owner claim before lifting this no-go. Never
substitute a scheduled pull, generic connector claim, or direct ingest.

1. In a clean Windows checkout of the independently reviewed head, confirm the
   previous isolated profile is gone. Use the already-paired connection and
   pairing IDs from its private Chase Sets pairing detail, not a new pairing.
   Set `$t0` to the UTC start of the admitted window, before launching the
   profile. Use a new run name. Preparation grants no extension of the 15-minute
   window and does not start Chrome. Run from the repository root:

   ```powershell
   $probe = 'bounded-contexts/channels/features/connector-client/integrations/order-authority-probe/package.mjs'
   $run = Join-Path (Get-Location).Path 'artifacts/9115/<new-run-name>'
   node $probe --prepare-founder-canary --out $run --t0 $t0 --reviewed-head $reviewedHead `
     --connection-id $connectionId --pairing-id $pairingId --cadence-ms 30000 `
     --cadence-source 'https://github.com/chase-sets/chase-sets/issues/8607#issuecomment-5983720229'
   node $probe --verify --out $run
   ```

   Stop on any refusal. The packager creates the root with a non-inherited
   ACL granting full control only to the current Windows user, before creating
   the key or any child directories. Do not elevate or try to fix a denied run.

2. Only after the no-go is lifted, use the exact `launchCommand` from the
   private `preparation.json`. Todd signs in privately in that isolated profile;
   do not copy cookies or use another profile. Set Downloads inside that profile
   and enable **Ask where to save each file**. In `chrome://extensions`, load
   only `<run>/package` unpacked, confirm the recorded `extensionId`, and open
   the recorded `captureUrl`. In that helper console only, invoke
   `await orderAuthorityCapture.run()` once, with no arguments. Do not open the
   portal console or capture screenshots, traces, raw responses, or identifiers.

3. Attest the same seller and isolated session throughout. For both brackets,
   confirm the fixed **Last 2 years** range before reading the count. Transcribe
   the **Ready to Ship** quick-filter label, then the adjacent count once after
   the display settles. The after-count must come from a fresh, settled Orders
   view after the worker responds. Stop on any range change, stale count, label
   mismatch, missing detail, or refusal. The worker requires one closed first
   page and requests at most three matching details; there is no range
   correction, fallback, pagination, or retry.

4. Save `ready-to-ship-handoff.json` only in `<run>/custody` and the two scrubbed
   files, `selector-receipt.json` and `selector-inventory.json`, only in
   `<run>/receipt`. A refused run has no handoff. Do not move a download from
   an unprotected location, export the handoff or key, or copy the whole run.
   Verify the export with `node $probe --verify-export --out $run`.

5. Remove the extension from that exact profile, confirm absence and record its
   actual UTC time, close the isolated browser, and dispose of only that
   profile. Confirm there are no processes for it and the directory is gone.
   Record the observed removal and verify the two-file export again:

   ```powershell
   node $probe --record-removal --extension-absent --extension-absent-at $observedUtc --out $run
   node $probe --verify-export --out $run
   ```

   The CLI checks directory absence and records the attestation; it cannot
   verify the operator actually removed the extension or that Chrome exited.
   Share only the verified receipt pair. Stop on decline, expiry, missed
   teardown, or absent authorization; do not reopen or retry the page. The
   earlier of five minutes after capture and the run deadline ends custody.

6. Only in a separately authorized intake window, enable the platform API's
   `CHANNELS_READY_TO_SHIP_CANARY_OWNER_USER_ID` for Todd's user. Leave it unset
   otherwise. With the same pairing still active and the connector idle, Todd
   separately approves the exact `canary.pageClaim` from the verified receipt:

   ```powershell
   node $probe --release-founder-canary --out $run --page-claim $approvedPageClaim `
     --connection-id $connectionId --pairing-id $pairingId
   ```

   In the existing Chase Sets owner session, submit the private
   `<run>/custody/ready-to-ship-owner-request.json` as the JSON body of one
   `POST /api/channels/connections/<connectionId>/connector-pairing/ready-to-ship-canary`.
   Do not put the body, credentials, or key on a command line, in logs, or in
   evidence. Remove the private request file after submission or refusal.
   A `204` only arms the page for that pairing. The paired connector's next
   eligible claim gets one lease capped by the handoff deadline; it does not
   access TCGplayer. Do not resubmit after a lost reply or expiry. A post or
   report acknowledgement is transport evidence, not Inventory acceptance.

### Manual-Sync Round Trip

The Manual Sync Panel
(`bounded-contexts/channels/features/manual-sync/ui/manual-sync-panel.tsx`)
exposes the actions gated by `resolveManualSyncActions` in
`bounded-contexts/channels/features/manual-sync/domain/contracts.ts`, keyed
on the run's current state:

1. **Compose** (`compose`, no run yet): builds a new outbound
   reservation into a run.
2. **Claim and download** (`download`, run state `composed`): claims the
   reservation as a side effect of the download call — the run lands in
   `claimed` only afterward — and downloads the CSV export, posted to
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
(`domain.ts`, `allowedChannelConnectionActions`). Pausing sets the
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

### Account-deletion receipts

Weekly, and immediately before the #8618 Production Save, a staff operator with
`support.manage` opens **eBay Deletion Lookup** in admin. Look up each exact
operator-held eBay user ID separately. The page does not list or export subjects;
an empty result means only that no unexpired receipt matches that identity.
For every matching receipt, delete the corresponding tokens and usernames from
the operator store. Record completion separately in the operator's restricted
record, using the notification ID and completion time, not a copied subject.
Receipt presence is not proof of erasure or of provider acceptance.

In-platform eBay custody is handled automatically by the Channels account-deletion
consumer. Every 3600 seconds and on worker restart it scans unexpired receipts in
500-row pages, matches root-qualified fingerprints without opening subject
envelopes, and uses the shipped disconnect to remove the credential envelope and
seller identity atomically with a subject-free completion record. Completion
records expire with their receipts. An unmatched receipt remains eligible until
expiry, including for a seller connecting later. A completed receipt fences new
OAuth callbacks for that subject until expiry; it is not an Account deletion or
an eBay erasure claim. Remote revocation remains `unconfirmed`.

Inspect `channels.ebay-deletion.unavailable` and
`channels.ebay-deletion.incomplete` counts/signals without copying subject data.
Unavailable fingerprints are retried, not treated as unmatched. Restore worker,
database or key continuity before treating an incomplete sweep as handled.
The manual lookup and deletion step above remains the owner for operator-held
data only.

Before Production Save, both displayed platform counts must be zero:
non-disconnected Production `ebay` connections and their credential envelopes.
A failed lookup/count is not zero. Stop Save on unavailable or nonzero counts;
do not copy user IDs into logs, issue comments, screenshots, or verification
artifacts. This lookup does not activate provider receipt delivery or Production
connections; the automatic consumer does not change those enablement gates.

Receipts retain encrypted subjects for 30 days from server receipt time. The
worker starts on restart, then at fixed 1800-second intervals, draining up to
500 rows per DELETE for at most 1800 seconds. `cleanup-incomplete` is a failure,
not successful expiry. Inspect subject-free reason/count/timing observations
and restore the worker/database promptly; never infer cleanup from a short
batch. An outage or backlog outside the measured operating envelope requires
an explicit host decision, not a retention waiver.

The existing `CHANNELS_CREDENTIAL_KEYRING_JSON` must retain the immutable named
root `ebay-subject-root-v1`, independent of `activeKeyId`. Keep its material and
identity unchanged across seal rotations. Keep historical seal keys while
referenced. Before installing a replacement keyring, use Channels' receipt and
subject-binding continuity checks against receipt references and subject-binding
references owned by #9299/#9304. Never remove referenced root or seal keys. A
missing key makes custody unavailable; it does not authorize overwriting a
receipt or treating a retry as a different subject. Root metadata lives in the
fingerprint, not an additional table column or keyring.
