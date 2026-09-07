# Channels Bounded Context

## Purpose

Channels owns the seller-facing lifecycle for connecting an Account to a Sales
Channel. The connection slice keeps setup authority injected and provider-free.

## Owns

- Sales Channel and Channel Connection vocabulary
- BYO Channel, Channel Account, authorization, credential, webhook, health,
  and mapping vocabulary
- Channel Listing Link, Channel Sync, Channel Sync Run, Channel Sync Error,
  and Channel Inventory Snapshot vocabulary
- The `channels.` stream namespace and authenticated `/api/channels/connections`
  API
- Channel Connection setup, lifecycle, projection, and account-scoped history

## Does Not Own

- Account capability, standing, membership, or credential behavior (Identity)
- Inventory quantity, allocation, reservation, or fulfillment rules (Inventory)
- Listings and offers (Marketplace)
- Notification delivery channels or preferences (Notifications)
- Provider integrations, credential custody, OAuth, provider execution, health
  observations, attention policy, sync, publication, or seller UI

## Ubiquitous Language

Channels terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

`ChannelConnection` is event sourced and moves through `pending-setup`,
`active`, `paused`, and terminal `disconnected` states.

## Incoming Dependencies

Injected setup, credential, policy, and storage-location authority resolvers.

## Outgoing Integration Events

- `channels.connection.connected`
- `channels.connection.activated`
- `channels.connection.paused`
- `channels.connection.resumed`
- `channels.connection.disconnected`

## Invariants

1. Every Channels term has one defining context glossary heading.
2. Setup is resolved from the persisted provider and two-value Channel
   environment; requests cannot select an environment or replace setup on resume.
3. Inventory remains the source of stock truth; Channels owns only the
   channel-facing connection and synchronization language moved here.
4. Identity remains the source of Account capability and standing truth.

## Tests

Run `pnpm --filter @chase-sets/channels run test:watch` for the watch-mode inner
loop. Use `test:unit` for the finite non-database partition and `test:db` for the
two explicitly enrolled disposable-Postgres suites.
