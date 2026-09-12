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
Live or Staged exports without making a provider call. Reconciliation compares
complete inline channel observations with expected Link state, retains seller
drift decisions, records missed external sales through Inventory, and applies
outbound-only health and operator holds.

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
- Channel Reconciliation Runs, Drift Classification and Decisions, Missed-Sale
  Gaps, outbound kill-switch policy, bounded health observations and metrics

## Does Not Own

- Account capability, standing, membership, or credential behavior (Identity)
- Inventory quantity, allocation, reservation, or fulfillment rules (Inventory)
- Listings and offers (Marketplace)
- Notification delivery channels or preferences (Notifications)
- Provider transport, credential custody, OAuth, browser automation, provider-
  specific paging, health scoring, attention policy, or seller UI

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

## Outgoing Integration Events

- `channels.connection.connected`
- `channels.connection.activated`
- `channels.connection.paused`
- `channels.connection.resumed`
- `channels.connection.disconnected`
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
9. Claimed reconciliation reads persisted snapshots through #7034; it never
   invokes a claimed provider. An incomplete source never proves absence.
10. Seller, health, and operator holds block outbound provider work only;
    account-scoped Inventory sale recording remains admitted.

## Tests

Run `pnpm --filter @chase-sets/channels run test:watch` for the watch-mode inner
loop. Use `test:unit` for the finite non-database partition and `test:db` for the
three explicitly enrolled disposable-Postgres suites.
