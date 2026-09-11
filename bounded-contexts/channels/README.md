# Channels Bounded Context

## Purpose

Channels owns the seller-facing lifecycle for connecting an Account to a Sales
Channel and the provider-neutral contract for publishing listings through it.
The connection slice keeps setup authority injected, while the publication
port and listing-composition slice project authoritative facts into one closed,
provider-neutral desired state. Outbound sync durably orders that state for
provider execution, and production composition profiles remain empty.

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

## Does Not Own

- Account capability, standing, membership, or credential behavior (Identity)
- Inventory quantity, allocation, reservation, or fulfillment rules (Inventory)
- Listings and offers (Marketplace)
- Notification delivery channels or preferences (Notifications)
- Provider integrations, credential custody, OAuth, provider-specific
  execution, health observations, attention policy, sync orchestration, or
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

## Tests

Run `pnpm --filter @chase-sets/channels run test:watch` for the watch-mode inner
loop. Use `test:unit` for the finite non-database partition and `test:db` for the
three explicitly enrolled disposable-Postgres suites.
