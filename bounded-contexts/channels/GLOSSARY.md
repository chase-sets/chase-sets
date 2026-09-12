# Channels Glossary

This glossary defines the canonical marketplace language for native and
external sales-channel connections. These terms reserve Channels ownership;
they do not imply shipped connection behavior.

## Sales Channel

A **Sales Channel** is an external or native commerce surface connected to an Account.

## Channel Connection

A **Channel Connection** is the linked relationship between a Chase Sets Account and a Sales Channel.

## BYO Channel

A **BYO Channel** is an account-supplied Sales Channel connection that Chase Sets supports without owning the external storefront.

## Channel Account

A **Channel Account** is the external account identity linked to a Chase Sets Account for a Sales Channel.

## Channel Authorization

A **Channel Authorization** is the consent that allows Chase Sets to act with scoped access on a Sales Channel.

## Channel Credential

A **Channel Credential** is the secret or token reference used to access a Sales Channel.

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

## Channel Publication Eligibility

**Channel Publication Eligibility** is the complete fail-closed decision that a Channel Listing Link can publish, update, or delist from current facts, settings, mappings, references, and profile.

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

## Channel Outbound Operation

A **Channel Outbound Operation** is one durable publish, update, or delist instruction for a Channel Connection and Channel Listing Link.

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
