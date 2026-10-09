# Channels Glossary

This glossary defines the canonical marketplace language for native and
external sales-channel connections. These terms reserve Channels ownership;
they do not imply shipped connection behavior.

## Sales Channel

A **Sales Channel** is an external or native commerce surface connected to an Account.

## Channel Connection

A **Channel Connection** is the linked relationship between a Chase Sets Account and a Sales Channel.

## Connector

A **Connector** is a client authorized for one Channel Connection through a
separate Auth-issued grant. It is neither an agent nor a seller actor. Current
pairing and connection state constrain every operation.

## Connector Pairing

A **Connector Pairing** binds one Connector grant to one Channel Connection after
a seller consumes a one-use, ten-minute pairing code. Channels owns its identity
and lifecycle. Unpairing, replacement, expiry, and disconnect invalidate authority;
closed pairing identities never reopen.

## Connector Raw Export Retention

`createConnectorRetentionStore` owns encrypted raw-export custody and cleanup.
`downloadedAt` is the completed download instant, frozen across retries; it
supersedes `capturedAt` for the 24-hour raw-export deadline. `cleanup-failed`
keeps the connector provider-inert until cleanup succeeds. `upgrade-required`
refuses work while preserving a newer retained schema for its owning version.

## Channel Operation Feed

A **Channel Operation Feed** admits an authorized Connector poll and serves at most
one producer-owned reservation plus its poll window. Paused connections serve an
empty reservation without calling the producer. Inbound admission is write-only
and remains available after membership loss while the pairing and grant are live.

## Connector Liveness Authority

**Connector Liveness Authority** is the never-deleted, lockable current row for a
connection's pairing generation and admitted heartbeat. Pairing changes clear the
heartbeat, not its monotonic revision. Missing authority admits no liveness decision.

## Served Policy Identity

**Served Policy Identity** hashes the exact transport policy value and document
metadata selected for an admitted poll in the Channel Operation Feed. Here,
"served" means selected at admission, not delivered to the connector. Reservation
failure retains that snapshot; it does not prove a response carried the window.

## Connector Inbound Retention Class

A **Connector Inbound Retention Class** is the one closed retention window each
admitted inbound kind belongs to: `inventory-snapshot` (export, 604800 seconds)
or `order-observation` (order, 7776000 seconds). The payload is deleted strictly
after server admission plus the window, measured on the deleting transaction's
clock; the admitted identity, order, cursor and horizon remain and an expired
read returns `expired`.

## Operation Acknowledgement

An **Operation Acknowledgement** reports the complete producer reservation outcome
vector with unchanged attempt, generation and desired-state sequence. Only the
producer settles it; an identical replay returns the same empty success response.

## Channel Order Fulfillment Observation

A **Channel Order Fulfillment Observation** is a closed, revision-qualified
shipping observation joined to committed External Channel Sales. Admission is
transport evidence, not acceptance. Before a matching sale it waits; after 24
hours it contributes `channel-order-sale-absent` to the existing Channel Action.
An unmapped order contributes `channel-order-unmapped`. Neither is connection
health or a reason to pause other orders. Sale and mapping recovery resolve only
the affected order reasons. Accepted ship-to is immutable; subsequent status
facts contain no address, lines, or money.

## Channel Order Fulfillment Observation Reference

A **Channel Order Fulfillment Observation Reference** identifies one observed
revision of an external order. `composeChannelOrderFulfillmentReference` is the
single browser/server export from `@chase-sets/channels/client` and
`@chase-sets/channels/server`. It consumes two validated nonempty strings and
returns `tcf.v1:` followed by lowercase SHA-256 hex of the UTF-8 compact JSON tuple
`["channel-order-fulfillment/v1", externalOrderReference, providerObservedRevisionOrDigest]`.
It preserves case, whitespace, Unicode and tuple order; it does not normalize
observations or qualify provider revisions.

The #7795 interpreter and #8613 connector producer must import this composer,
including their fixtures and seed paths, when they land. #7795 owns the digest of
the bounded, closed normalized observation when no qualified provider revision
exists: status, content and full/status-only variant participate; pull identifiers
and volatile capture times do not. Equal order/content across pulls therefore
keeps the reference; changed status/content/variant changes it. Neither a raw JSON
tuple, a bare order number nor a pull-qualified sale reference is this wire spelling.

The inbox identity remains `(connectionId, inboundKind, externalReference)`;
the reference does not replace connection isolation or kind separation. There is
no legacy spelling fallback. Actual legacy fulfillment admissions require a
bounded migration before introducing a writer. Manual-kind ingress (#7031) is
not a fulfillment consumer. This encoding changes no sale identity, observation
schema, join, status, currency or retention contract.

## BYO Channel

A **BYO Channel** is an account-supplied Sales Channel connection that Chase Sets supports without owning the external storefront.

## Channel Account

A **Channel Account** is the external account identity linked to a Chase Sets Account for a Sales Channel.

## Channel Authorization

A **Channel Authorization** is the consent that allows Chase Sets to act with scoped access on a Sales Channel.

## Channel Credential

A **Channel Credential** is the secret or token reference used to access a Sales Channel.

Channels owns encrypted, non-replayable custody separately from the connection's
reference and from captured provider authorization. `ChannelCredentialEnvelope/v1`
authenticates the immutable account, provider, environment, connection and row
identity together with both counters and key metadata. Token generation changes
only with token material; envelope revision changes on every actual rewrite.
`ChannelOAuthTokenSet/v1` is the closed canonical plaintext format. Readability does
not establish provider-valid authority.

## Channel Webhook

A **Channel Webhook** is the inbound event subscription configured for a Sales Channel.

## Channel Health

**Channel Health** is the account-visible operational state of a Sales Channel connection.
It is separate from the seller-owned connection lifecycle: `unknown` has no
complete healthy authority, `healthy` has every reason closed, `degraded` has an
open reason below its failure thresholds, and `failing` is a system pause.
Reason generations bind a fingerprint and retain their opening work lineage.
System pause holds outbound publication and polling while independently verified
inbound sale observations remain available; it never clears a seller pause.

## Channel Action

A **Channel Action** is the single shared Seller Desk item for a connection's
unresolved health attention and independently owned manual sync work. Resolving
a health generation neither closes its health reason nor ends manual work.

## Channel Sale Observation

A **Channel Sale Observation** is a closed, PII-free set of captured external
order line facts. Channels interprets it through Inventory's external sale
recorder; it is not an Order or a stock authority. Pull membership and transport
revisions do not change its immutable per-product-and-SKU sale identity.

## External Order Reference

An **External Order Reference** identifies a provider order within one immutable
Channel Connection. Order contributions to a Channel Action retain this reference
and a reason independently of health and manual work. Mapping repairs resolve
only the affected gaps; backdated sales and cancellations remain visible.

## Channel Mapping

A **Channel Mapping** is the account-owned configuration that maps channel fields, SKUs, locations, or policies to Chase Sets terms.

## Channel Listing Link

A **Channel Listing Link** is the association between a Chase Sets Listing or Inventory Item and an external channel listing.

## Channel Publication

**Channel Publication** is sending a Channel Listing Link's current state to a Sales Channel.

## Channel Publication Facts

**Channel Publication Facts** are Channels-owned projections of authoritative Marketplace, Catalog, Inventory, and Channels streams used to compose publication without request-time cross-context reads.

## Channel Composition Profile

A **Channel Composition Profile** declares which provider-neutral publication draft dimensions Chase Sets supplies for one provider and environment, with explicit bounds and derivation evidence.

## Channel Publication Settings

**Channel Publication Settings** are the account-owned title, description, category, and listing-exclusion choices for one Channel Connection.

A **Channel Publish Quantity Cap** on Channel Publication Settings bounds every listing's published quantity on that connection.

## Channel Publish Quantity Cap

**Channel Publish Quantity Cap**: max units per listing, per connection, with the per-item Inventory partition as the only override.

`publishQuantityCap: number | null` — `null` means no cap; otherwise an integer `1..1000`.

## Channel Publication Eligibility

**Channel Publication Eligibility** is the complete fail-closed decision that a Channel Listing Link can publish, update, or delist from current facts, settings, mappings, references, and profile.

## Channel Publication Blocking Reason

A **Channel Publication Blocking Reason** is a closed code naming one unmet condition of
Channel Publication Eligibility for a Channel Listing Link. Configuration reasons name an
account or profile condition and short-circuit before listing reasons. The codes recorded on
a blocked Channel Listing Link are account-readable on the Channel Publication detail surface.

## Channel Listing Desired State

**Channel Listing Desired State** is the closed, versioned publish, update, or delist intent composed for one Channel Listing Link.

## Channel Listing Reconciliation Run

A **Channel Listing Reconciliation Run** durably pages every listing affected by a multi-row fact or configuration change and records complete or failed settlement.

## Channel Provider Registry

The **Channel Provider Registry** is the account-independent, immutable table of provider descriptors keyed by provider and environment.

## Channel Provider Descriptor

A **Channel Provider Descriptor** declares one provider's identity, setup requirements, and optional publication capability.

## Channel Sync

**Channel Sync** is the Channels workflow that reconciles Inventory stock facts with an external Sales Channel.

## Channel Sync Run

A **Channel Sync Run** is the execution record for one Channel Sync attempt.

## Channel Sync Error

A **Channel Sync Error** is the actionable failure captured during Channel Sync.

## Channel Inventory Snapshot

A **Channel Inventory Snapshot** is channel-reported quantity state captured for reconciliation; Inventory remains the source of stock truth.

## Snapshot Staleness

**Snapshot Staleness** is the age of an operator-declared Live capture relative to
the reconciliation run clock. Age strictly beyond the configured window is stale;
missing, unattributed, invalid, future, or non-increasing capture evidence is unknown.
Both require Channel Action attention. Fresh age never proves snapshot completeness.

## Channel Outbound Operation

A **Channel Outbound Operation** is one durable instruction Channels issues against a Channel Connection's provider. A listing-subject operation is a publish, update, or delist for one Channel Listing Link and is the only kind that enters Outbound Operation Lanes, listing supersession and Link writers; a connection-subject operation (below) targets the Channel Connection itself.

## Connection-Subject Channel Outbound Operation

A **connection-subject Channel Outbound Operation** is a Channel Outbound Operation whose subject is the Channel Connection itself, not a Channel Listing Link. It carries no listing identity, revision or desired-state sequence, never enters an Outbound Operation Lane, listing supersession or Link writer, and shares the claimed reservation, lease, attempt, generation and settlement receipt fences. Contract: `features/outbound-sync/domain/contracts.ts`.

## Channel Order Pull

A **Channel Order Pull** (`tcgplayer-order-pull`) is the connection-subject operation that asks a capable Connector to read the TCGplayer Ready to Ship set once under the `ready-to-ship-intake/v1` law. Channels background schedules at most one live pull per due, active, paired connection on its persisted cadence boundary, never before both the stored due time and the last scheduled boundary plus the effective poll window; it binds the pull identity, policy revision, qualified selector, `N_rts_max`/`F_max` bounds and a pre-accounted worst-case budget that fits the unchanged deadline and lease. Its closed outcomes are `order-pull-complete` and `order-pull-unknown`; neither is server sale or fulfillment acceptance. Contract: `features/outbound-sync/domain/order-pull.ts`.

## Outbound Operation Lane

An **Outbound Operation Lane** is the per-connection, per-link ordering and isolation boundary that holds at most one pending and one in-flight operation.

## Outbound Operation Attempt

An **Outbound Operation Attempt** is one fenced execution of an operation under a unique attempt identity and increasing claim generation.

## Claimed Operation Reservation

A **Claimed Operation Reservation** is an atomic, leased, disjoint assignment of claimed-mode operations to one connector or manual claimant.

## Staged Import Batch

A **Staged Import Batch** is the ordered TCGplayer CSV payload composed for one Channel Sync Run against one Snapshot Basis.

## Snapshot Basis

A **Snapshot Basis** is the immutable Staged Channel Inventory Snapshot used to calculate quantity deltas and preserve provider-authored listing fields.

## Channel Export Surface

A **Channel Export Surface** identifies whether a channel export reports Live truth or Staged composition state.

## Mapping Bootstrap Candidate

A **Mapping Bootstrap Candidate** is a real category, condition, or attribute source-key discovery submitted for Channel Mapping review; a local sync refusal is not a candidate.

## Manual Sync Panel

The **Manual Sync Panel** is the authorized Channel Connection surface for composing, downloading, recording, and verifying one manual Staged Import Batch round trip.

## Channel Inbound Coverage

**Channel Inbound Coverage** states whether a Sales Channel currently supplies authoritative inbound sales visibility; missing or unknown authority is dark.

## Channel Inbound Clamp

A **Channel Inbound Clamp** is the Marketplace-owned, revision-fenced pause of every active account Listing represented by a genuine Channel Sync Run while Channel Inbound Coverage is dark.
## Channel Drift

**Channel Drift** is a divergence between a Channel Listing Link's expected material state and complete channel-reported state.

## Channel Drift Decision

A **Channel Drift Decision** is the durable account decision to accept a foreign Channel Drift fingerprint or request a repush of the expected state.

## Drift Classification

**Drift Classification** is the closed `in-sync`, `repairable`, `foreign-edit`, `structural`, or `source-unavailable` result of comparing expected and observed Channel Listing state.

## Channel Reconciliation Run

A **Channel Reconciliation Run** is the bounded, per-connection process that observes channel state, classifies Channel Drift, records missed external sales, and retains guarded counts.

## Missed-Sale Gap

A **Missed-Sale Gap** is a returned external sale line whose exact external Channel sale key has not yet been recorded by Inventory.

## Channel Outbound Hold

A **Channel Outbound Hold** is the outbound-only admission result composed from seller pause, Channel Health, and the operator kill switch; verified inbound sale recording remains admitted.
