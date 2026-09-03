# Channels Bounded Context

## Purpose

Channels owns the marketplace language for connecting an Account to native or
external Sales Channels and reconciling channel-facing state. This foundation
establishes that ownership without implementing connection behavior.

## Owns

- Sales Channel and Channel Connection vocabulary
- BYO Channel, Channel Account, authorization, credential, webhook, health,
  and mapping vocabulary
- Channel Listing Link, Channel Sync, Channel Sync Run, Channel Sync Error,
  and Channel Inventory Snapshot vocabulary
- The `channels.` stream namespace and `/api/channels` path reservation

## Does Not Own

- Account capability, standing, membership, or credential behavior (Identity)
- Inventory quantity, allocation, reservation, or fulfillment rules (Inventory)
- Listings and offers (Marketplace)
- Notification delivery channels or preferences (Notifications)
- Provider integrations, credentials, health observations, policies, routes,
  schemas, projections, events, commands, UI, or deployable composition in this
  foundation

## Ubiquitous Language

Channels terminology is defined in [GLOSSARY.md](./GLOSSARY.md).

## Core Aggregates and Process Managers

None. The connection replacement introduces behavior only when it has a
complete behavior-backed lifecycle to add.

## Incoming Dependencies

None in this foundation.

## Outgoing Integration Events

None in this foundation.

## Invariants

1. Every Channels term has one defining context glossary heading.
2. The manifest contributes no API, runtime, worker, web, shell, schema,
   projection, or provider surface until behavior exists to consume it.
3. Inventory remains the source of stock truth; Channels owns only the
   channel-facing connection and synchronization language moved here.
4. Identity remains the source of Account capability and standing truth.

## Tests

Run `pnpm --filter @chase-sets/channels run test:watch` for the watch-mode inner
loop.
