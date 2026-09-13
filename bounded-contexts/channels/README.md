# Channels Bounded Context

## Purpose

Channels owns the seller-facing lifecycle for connecting an Account to a Sales
Channel, the provider-neutral contract for publishing listings through it, and
durable reconciliation state for channel exports. The connection slice keeps
setup authority injected, while the publication port and listing-composition
slice project authoritative facts into one closed, provider-neutral desired
state. Outbound sync durably orders that state for provider execution, and
production composition profiles remain empty. The TCGplayer CSV slice
composes a claimed outbound reservation into one Staged Import Batch and ingests
Live or Staged exports without making a provider call.

## Owns

- Sales Channel and Channel Connection vocabulary
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

## Does Not Own

- Account capability, standing, membership, or credential behavior (Identity)
- Inventory quantity, allocation, reservation, or fulfillment rules (Inventory)
- Listings and offers (Marketplace)
- Notification delivery channels or preferences (Notifications)
- Provider transport, credential custody, OAuth, browser automation, order
  ingestion, drift classification, attention policy, or
  seller UI

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

## Incoming Dependencies

Injected setup, credential, policy, and storage-location authority resolvers.

## Outgoing Integration Events

- `channels.connection.connected`
- `channels.connection.activated`
- `channels.connection.paused`
- `channels.connection.resumed`
- `channels.connection.disconnected`
- `channels.connection.health-changed` (closed `ChannelHealthChanged/v1` payload)
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

## Tests

Run `pnpm --filter @chase-sets/channels run test:watch` for the watch-mode inner
loop. Use `test:unit` for the finite non-database partition and `test:db` for the
explicitly enrolled disposable-Postgres suites, including health replay, policy
revision, generation interleavings and the complete day-after state matrix.
