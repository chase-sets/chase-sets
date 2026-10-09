# Channels Bounded Context

## Purpose

Channels owns the seller-facing lifecycle for connecting an Account to a Sales
Channel, the provider-neutral contract for publishing listings through it, and
durable reconciliation state for channel exports. The connection slice keeps
setup authority injected, while the publication port and listing-composition
slice project authoritative facts into one closed, provider-neutral desired
state. The connector-client slice publishes the Chromium-observed TCGplayer
connector extension identity and callback constants to its thin deployable.
Its `createConnectorBackground` factory owns the connector lifecycle, closed
extension messages, PKCE pairing and independent work, revocation-retry and
retention alarms. Chrome adapters implement `ConnectorBackgroundPorts`; records
and revision fencing remain internal to the slice. Startup and retained install
reconcile owned records without resetting paired or paused profiles. Missing
alarm reconciliation is not implemented here; no alarm persistence is assumed.
The coordinator is inert unless supplied, and raw cleanup is an injected sweep.
Pause, resume and unpair messages are reserved for tests pending the product
command surface; the action click pairs or opens the platform connection page.
The extension composes that factory with Chrome-only adapters and a no-op raw
sweep. The Channels manifest builder closes the MV3 graph: one module worker,
identity/storage/alarms, a pinned public key, and the configured platform host.
There is no popup, HTML page, content script, provider host, or product message
listener. Both storage areas use trusted access before reads or writes. Builds
use `VITE_PLATFORM_API_URL`, then `PLATFORM_API_URL`, then `http://localhost:6182`;
`VITE_CONNECTOR_CLIENT_ID` supplies an already registered Auth client ID. An
unset ID remains empty and cannot authorize pairing; registration and deployed
cookie topology are not implemented by this shell. Chromium coverage uses only
a loopback fake, not provider traffic or a deployed-session claim.
Outbound sync durably orders that state for provider execution, and
production composition profiles remain empty. The TCGplayer CSV slice
composes a claimed outbound reservation into one Staged Import Batch and ingests
Live or Staged exports without making a provider call. Reconciliation compares
complete inline channel observations with expected Link state, retains seller
drift decisions, records missed external sales through Inventory, and applies
outbound-only health and operator holds.

The [Order Pull Scalability Worksheet](./docs/order-pull-scalability.md) records
the governed allocation envelope and conditional intake/follow-up estimates.
It is not provider qualification or evidence that the executor has shipped.

## Test Support

`@chase-sets/channels/seed-support/channel-publication-browser` provides test-only
mapping candidate authoring and a bounded exact-row hold for local browser-e2e
composition and Channels cross-slice DB acceptance tests. It uses the existing
owned manual-sync scenario connection and the real Channels runtime. The hold
can stall the shared listing-state projection until release. Seed and bootstrap
composition never invoke this helper; it is not a production entrypoint.

## Owns

- Sales Channel and Channel Connection vocabulary
- Non-replayable Channel credential custody, canonical token envelopes, and explicit key rotation
- BYO Channel, Channel Account, authorization, credential, webhook, health,
  and mapping vocabulary
- Channel Listing Link, Channel Sync, Channel Sync Run, Channel Sync Error,
  and Channel Inventory Snapshot vocabulary
- The `channels.` stream namespace and authenticated `/api/channels/connections`
  API
- Channel Connection setup, lifecycle, projection, and account-scoped history
- Channel Publication contracts, provider capability declarations, and the
  immutable Channel Provider Registry
- Durable latest-state Channel Outbound Operations, execution admission,
  claimed reservations, provider budgets, and per-link poison isolation
- Channel Publication Facts, Profiles, Settings, Eligibility, Desired State,
  Links, and durable Reconciliation Runs
- TCGplayer Channel Export schema pins, Channel Inventory Snapshots, Channel
  Sync Runs, immutable reservation membership, and Staged Import Batches
- Provider-neutral Channel Health observations, reason generations, and system
  pause reads through the context-level `connectionHealth` service
- Channel Reconciliation Runs, Drift Classification and Decisions, Missed-Sale
  Gaps, outbound kill-switch policy, bounded health observations and metrics
- Channel Action health-attention generations, independent resolution facts,
  and one shared Seller Desk contribution combining health and manual work
- The public-key-backed TCGplayer connector extension identity and callback URI
- Connector Pairing, connection-scoped operation authority, and safe connector request audit
- Channel Operation Feed claim/report and membership-independent write-only inbound admission

## Connector Transport

Manual Sync panels derive Channel Inbound Coverage from the connector feed's
fenced `readAuthority` on every read, composition and clamp retry. A live pairing
on an active or paused connection stays live after the grantor loses membership;
seller panel permission is resolved separately. Missing authority is dark, and
known pairing removal is dark with the revoked reason. Coverage does not infer
health from claim heartbeats, release listing clamps, or change manual actions.

The existing sessionless `/channel-connector/oauth` mount also serves POST
`/connections/:connectionId/claim`, `/report`, and `/ingest`. Each operation uses
the connection-bound connector bearer, never seller or agent authority. Claim
commits its fenced last-seen and served-window observation before invoking the
producer's own reservation transaction and canonical health hold. Report preserves
the producer outcome and run-settlement contracts. Accepted report and ingest
replays return the same exact `{}` bytes without a duplicate signal.

A claim body of `{}` is incapable and only ever receives listing operations. A
claim declaring `{"capabilities":["tcgplayer-order-pull"]}` may also receive the
connection's single Channel Order Pull, which Channels background schedules on
its persisted cadence boundary (never the claim endpoint). The pull reports a
closed `order-pull-complete`, `order-pull-unknown` or `abandoned` outcome fenced
on attempt, generation, pull identity and payload digest; it never writes listing
lanes or Link state. Scheduling stays denied until #8804/#8838 supply governed
order-pull authority.

Inbound `order` envelopes contain versioned opaque records; `export` envelopes
contain a recursively validated derived live snapshot, never raw CSV. The tuple
of connection, kind and external reference is the retained non-PII inbox identity.
Payloads are separate, atomically admitted rows. Consumers use
`connectorFeed.readAdmittedConnectorInboundEvents` with a pinned committed horizon
and independently counted total, not table access. Missing payloads remain ordered
`expired` events. Consumers own progress and interpretation; #8592 owns deletion
for the exported inventory-snapshot and order-observation retention classes.

The `tcgplayer-orders` interpreter reads only this owner interface. Its expiring
connection claim fences retained, closed sale observations and pull accounting;
unfinished work survives the forward cursor and payload expiry. Inventory remains
the sale and stock authority. Transport digests include pull membership and closed
content; Inventory keys retain connection lineage and the order/product/SKU tuple.
An indexed strict decoder joins the TCGplayer SKU component of active Links before
target validation. Connector gaps never write reconciliation findings or health.
Order-scoped Channel Action contributions preserve other order, manual and health
work. Backdated sales and cancellations stay open without automatic resolution.

## Does Not Own

- Account capability, standing, membership, or credential behavior (Identity)
- Inventory quantity, allocation, reservation, or fulfillment rules (Inventory)
- Listings and offers (Marketplace)
- Notification delivery channels or preferences (Notifications)
- Provider transport, OAuth, browser automation, provider-
  specific paging
- Shared Seller Desk UI (Marketplace)

## Ubiquitous Language

Channels terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

`ChannelConnection` is event sourced and moves through `pending-setup`,
`active`, `paused`, and terminal `disconnected` states.

`ChannelPublicationConfiguration`, `ChannelListingLink`, and
`ChannelListingReconciliationRun` are event sourced. A Link composes one
material desired-state event at a time; reconciliation runs page multi-listing
changes durably and settle only after an independent affected-count check.

`ChannelSyncRun` retains one claimed reservation's complete membership and
moves through `composed`, `claimed`, and `awaiting-verification` before one of
its retained terminal outcomes. Only a newer parsed Staged snapshot can prove
application.

`ChannelReconciliationRun` is a guarded per-connection process with `idle`,
`due`, `running`, `completed`, `bounded-unknown`, and `held` states. Its steady
state is a retained complete `in-sync` run. `ChannelDriftDecision` retains only
the accepted observed/expected fingerprint pair or a repush request.

## Incoming Dependencies

Injected setup, credential, policy, and storage-location authority resolvers.

## Credential Custody

The `connector-client` slice owns the extension's closed profile and credential
v1 records and the serialized `(revision, state, connectionId)` response fence.
One worker is the sole writer to one profile key and one credential key in
trusted `chrome.storage.local`. The storage port must successfully request
`TRUSTED_CONTEXTS` for both local and session before any owned read or write;
the Chrome adapter and actual access-level calls belong to #7921.

Credential tokens live only in trusted local storage. PKCE verifier and state
live only in trusted session storage, not in either local record. Raw retention
belongs to #7922: ciphertext in private IndexedDB, encryption keys session-only.
These records contain no file field and supply no raw-storage behavior. Secrets
never enter sync storage, messages, logs or status. The custody API accepts no
such egress port; its only log value is `stale-response-discarded`.

Callers capture the fence and stored connection before awaiting transport. They
advance it before unpair, revoke, superseding pairing or re-pair transport, then
submit outcomes under that original fence. Network awaits stay outside the
storage critical section; storage awaits stay inside. Both records are published
in one local `set`; terminal publication writes a null credential then removes
its key. A restart rejects mismatched bindings and finishes interrupted null-key
cleanup. Every owned writer shares the same in-worker local-area lock. This is
not a Chrome CAS or a cross-worker lock: the adapter must preserve one worker
and must not introduce foreign writers to these keys.

Successful exchange and refresh consume #7918's exact six-key token response.
Refresh preserves connection identity and requires rotated tokens. A transport
refusal is not itself a revocation fact: a concurrent one-use refresh loser must
not delete a successful rotation. Lifecycle decisions remain #7920-owned.
Valid v1 inspection is byte/revision preserving; malformed owned v1 produces an
advanced `re-pair-required` profile and removes the credential. Mixed newer or
unknown versions report `upgrade-required` with zero writes or deletes, without
normalizing retained bytes. Revision exhaustion refuses rather than wrapping.

The slice-owned `extension-connector-scope-separation.db.test.ts` composes the
real Auth connector OAuth service and Channels credential routes. It is listed
in the unnumbered `test:db` and excluded by `test:unit`; Auth is an existing
declared dependency used by this test, not a browser-domain dependency. It does
not import a deployable or add an API/bootstrap test duplicate.

`ChannelsServices.credentials` is server-only. Callers supply their transaction
executor to create, replace, or rewrap a `ChannelCredentialEnvelope/v1`; custody
never commits the caller's transaction or emits secret-bearing events. Connections
retain only the generated reference. `ChannelOAuthTokenSet/v1` encodes explicit
refresh presence and nullable expiry, without making provider-validity decisions.

API and worker parse `CHANNELS_CREDENTIAL_KEYRING_JSON` through the same Channels
parser. Missing or empty configuration keeps credential-free TCGplayer and
migration-only bootstrap working; requested custody is unavailable. Malformed
present configuration fails runtime startup. Write uses only the active key;
read uses only the persisted key ID. A missing key or failed authentication leaves
the row intact and unavailable. Errors contain bounded codes, never token bytes.

The secret resolver requires an injected object-identity capability and its exact
account/provider/environment/connection binding, plus the expected reference and
token generation. No capability is registered by either host. Metadata authority
is unchanged: readable bytes are not evidence of provider-valid `current` status.
The later authorization consumer owns that decision. Returned bytes are transient;
the server consumer must dispose of its buffer after use, not log or persist it.

Rotation is explicit: retain old read keys, restart both hosts with the new active
key configuration, switch and drain **all** old-key writers,
then keyset-page at most 100 rows per call and CAS-rewrap each row. Rewrap preserves
token generation and increments envelope revision; active-key day-after calls do
not rewrite. A conflict requires re-reading and deciding again, never replaying
stale token material. Transaction rollback leaves the old row readable; restart
after commit observes the new revision. Missing/corrupt rows are retained, not
silently skipped or deleted.

Retirement preflight requires the operator's old-writer-drain acknowledgement and
an indexed, authoritative zero-reference query. A page is never retirement proof.
Never assign different bytes to a key ID, including after process restart or key
removal; `assertKeyringContinuity` checks retained IDs when comparing configurations,
but cannot establish historical operator facts. No automatic retirement, revocation,
queue, production key provisioning, or deletion policy is supplied here.

## Outgoing Integration Events

- `channels.connection.connected`
- `channels.connection.activated`
- `channels.connection.paused`
- `channels.connection.resumed`
- `channels.connection.disconnected`
- `channels.connection.health-changed` (closed `ChannelHealthChanged/v1` payload)
- `channels.connection.attention-opened` (closed `ChannelAttentionOpened/v1` payload)
- `channels.connection.attention-resolved` (closed `ChannelAttentionResolved/v1` payload)
- `channels.channel-publication-configuration.settings-replaced`
- `channels.channel-publication-configuration.mapping-candidate-recorded`
- `channels.channel-publication-configuration.mapping-review-decided`
- `channels.channel-listing.desired-state-changed`
- `channels.channel-listing.publication-blocked`
- `channels.channel-listing.publication-recorded`
- `channels.channel-listing-reconciliation.run-enqueued`
- `channels.channel-listing-reconciliation.chunk-drained`
- `channels.channel-listing-reconciliation.run-settled`

## Invariants

1. Every Channels term has one defining context glossary heading.
2. Setup is resolved from the persisted provider and two-value Channel
   environment; requests cannot select an environment or replace setup on resume.
3. Inventory remains the source of stock truth; Channels owns only the
   channel-facing connection and synchronization language moved here.
4. Identity remains the source of Account capability and standing truth.
5. Marketplace Listing is the only source of the amount/currency price pair;
   incomplete historical pairs block and are never assigned a default.
6. Desired-state sequence, Marketplace listing revision, desired-state hash,
   publication operation ID, and consumer payload digest are distinct identities.
7. TCGplayer composition uses Staged state only; Live is channel truth and
   never a quantity-delta basis.
8. The policy-served batch cap is independent of unknown provider capacity,
   and every reservation member receives exactly one acknowledgement.
9. Health never writes the seller lifecycle. `failing` is a system pause read
   through `connectionHealth.readConnectionHealth`; seller `paused` clears only
   through the seller command. Verified inbound sale availability is independent
   of both pauses. Unknown authority holds outbound publication and polling.
10. Claimed reconciliation reads persisted snapshots through #7034; it never
    invokes a claimed provider. An incomplete source never proves absence.
11. Seller, health, and operator holds block outbound provider work only;
    account-scoped Inventory sale recording remains admitted.

## Connection Health

`ChannelsServices`, exported from `@chase-sets/channels/server`, includes
`connectionHealth.submitObservation`, `readConnectionHealth`, and
`listOpenReasonGenerations`. Trusted producer slices submit the recursively
closed `ChannelHealthObservation/v1` contract. A source work ID is a SHA-256
digest of immutable producer, connection, authority, operation mode, setup,
schedule and policy identities, generated by `deriveChannelHealthSourceWorkId`.
Attempt and result ordinal are separate positive integers. Each full tuple is
immutable: replay is inert and a conflicting terminal is refused. An attempt
counts at most one failure and may resolve it with a later success ordinal;
the retained opening tuple supports that resolution. A later attempt counts once.

The controller-owned `channels.connection-health/v1` policy retains `900/3/5`
for window seconds, consecutive failures, and trailing failure budget. Each
value is an integer in `1..2592000`. This is engineering law, not a provider
limit or a new approval, under #7350 comment 5483791378. The reducer reserves
the ruled single-failure threshold for downstream connector liveness under
#7330 comment 5610796742; this feature does not admit that producer or run it.

Health is `unknown` without authority, `degraded` while a reason is open, and
`failing` when any open reason reaches either threshold. `healthy` requires
closed authority for all eight admitted reasons. Partial successes do not
invent historical authority. Counters are per reason and fingerprint generation;
success resets consecutive failures while retaining distinct trailing failures.
A changed fingerprint starts a new generation. An already failing reason stays
paused until a matching success, including across fingerprint and policy changes.
The opening work ID, attempt and occurrence time remain available to later
liveness closure consumers.

| Connection state | Health observations | Publication/polling | Verified inbound sale |
| --- | --- | --- | --- |
| pending-setup | admitted for all four health states | held | available |
| active | admitted for all four health states | allowed only for healthy/degraded with valid policy | available |
| paused | inert for all four health states | held | available |
| disconnected | inert for all four health states | held | available |
| absent or unrecognized | rejected | held | unavailable |

Each read/intake serializes on the canonical connection stream before loading
its complete lifecycle, so a lagging connection projection cannot admit work.
The persistent health row and tuple ledger commit together with health facts.
Snapshot writes compare evaluation generation, policy revision, state, and the
entire reason vector (including every generation and fingerprint).

Policy resolution uses the actual Platform Policy machinery with a fresh cache
inside the transaction. A shared document-table lock also protects the absent
candidate from a concurrent insert. The first read/intake that sees a changed
policy atomically activates its revision for that connection, increments the
evaluation generation and re-evaluates retained failures in the new window.
Old claims become inert; loosened thresholds never close reasons or resume a
pause. Malformed values make policy unavailable. Policy reads do not advance
the last real observation timestamp. Re-evaluation is time-bounded by the policy
window, with an index on connection and occurrence time; it has no count cap.

Reconciliation #4382 remains responsible for connecting its landed drift
producer and hold reader to this service and proving its AC5/AC6 integration.
Attention #7930 and liveness #7933 own their downstream behavior.

## Operations

The TCGplayer phase-1 manual-sync pilot operator procedures live in
[Channels Pilot Operations](../../docs/runbooks/channels-pilot-operations.md).

## Connector Pairing

Auth owns the separate public PKCE connector client and rotating grant mechanism.
Channels owns one-use, ten-minute pairing codes and the one live pairing per
connection. The seller's current membership and `channels.manage` permission
authorize pairing. Connector credentials never resolve an agent or seller actor.
The credential mount is `/channel-connector/oauth`, outside the authenticated
seller `/api/channels` mount. The existing connection detail owns code generation,
expiry, current pairing, and unpair controls.

`connectorFeed.readAuthority` returns the bound connection, pairing, grant, and
current inbound state: `absent`, `live`, or `revoked`. `withAuthority` keeps the
canonical connection stream locked while an admitted consumer runs. Both active
and paused connections retain write-only ingest authority after the grantor loses
membership; claim and report require current membership. Pending setup and
disconnected connections never admit connector operations. Claim transport records
a fenced last-seen observation and served poll window before calling the outbound
producer. Pairing itself does not reserve work or evaluate inbound coverage.

Supersession, unpair, and disconnect revoke Auth authority before closing a
pairing or publishing its replacement. Auth and Channels have separate databases:
if Channels rolls back after revocation, the old row may remain paired but its
revoked grant cannot authorize work. Repeated cleanup reconciles that state;
pairing identities are never reopened. Code consumption and cleanup serialize
on the canonical connection stream and compare pairing revision/state. Pairing
transition facts and the indexed lifecycle state commit in one Channels transaction.
If Auth commits issuance before Channels rolls back consumption, the grant has no
paired authority. Regeneration revokes by the complete pairing binding before
replacement; Auth also enforces one unrevoked grant per connection. The credential
lifecycle tables are durable state, not disposable projection caches.

One request boundary appends one credential-safe audit row. Identities are null
until resolved from owned state. Tokens, codes, verifiers, cookies, request bodies,
and exception text never enter pairing events or audit rows.

## Tests

Run `pnpm --filter @chase-sets/channels run test:watch` for the watch-mode inner
loop. Use `test:unit` for the finite non-database partition and `test:db` for the
explicitly enrolled disposable-Postgres suites, including health replay, policy
revision, generation interleavings, the complete day-after state matrix, and
manual-sync projection rebuild and seed scenarios.
