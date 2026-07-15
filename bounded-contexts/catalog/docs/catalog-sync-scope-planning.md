# Catalog Sync Scope Planning

Catalog sync starts from a Catalog-owned semantic scope, then plans provider
participation before any provider pull runs.

Workflow vocabulary:

1. Choose Catalog scope and providers.
2. Pull Source Observations.
3. Build merged Catalog candidates.
4. Resolve split, update, and delete decisions.
5. Promote approved Catalog Item and Product changes.

`CatalogSyncScope` is the provider-neutral operator intent for step 1. It names
the Catalog product domain, optional product form, language, and a reference to a
canonical Catalog Scope Record (`reference.scopeRecordId`) classified by kind —
Product Line, Series, Expansion, Set, or Catalog Item. For Pokemon TCG, an
English Base Set sync is a Pokemon single-card Expansion scope pointing at the
Base Set scope record.

The scope carries no raw provider coordinates. Each provider unit's child
execution scope is resolved through the accepted (or auto-accepted) Provider
Scope Mappings for that scope record — never from the reference's raw id or name.
A scope with no accepted mapping supplying a coordinate a provider unit needs is
an actionable `provider-scope-mapping-missing` blocker that points the operator
at the unmapped-scope inbox, so a fully mapped scope requires no manually
supplied provider coordinates.

Provider selection is part of scope planning, not job execution. The provider
participation preview answers one question before sync starts: "For this Catalog
scope, which provider units can participate and why?" The preview is
unit-aware, so a provider with several active ingestion units is evaluated per
unit rather than by provider key. Each unit reports its role, requirement,
eligibility, default/selected participation, blockers, estimates, explanation,
and the child Source Observation execution scope that would be enqueued.

Provider roles:

- `primary-source-observation` supplies candidate item facts and may have a
  promotion path after review.
- `supplemental-marketplace-reference` supplies provider product or SKU
  evidence such as TCGplayer Product IDs and SKU evidence.
- `reference-data` supplies reusable Reference Record or set/reference facts.
- `image-evidence` supplies provider image evidence.

Required provider units block sync when unavailable or ineligible. Optional
provider units degrade gracefully: operators can deselect them or fix the
actionable blocker without preventing the required units from pulling Source
Observations.

`SourceObservationIntegrationJobScope` remains the child provider execution
scope. It is intentionally provider-shaped: provider key, profile key,
ingestion-unit key, language, series ID, set ID, product-line ID, set name, or
product ID. Catalog sync planning produces these child scopes only after the
provider-neutral Catalog scope and provider participation are resolved.

## Durable Parent Runs

Catalog sync enqueue creates a parent Catalog sync run before provider work
starts. The parent run snapshots the normalized `CatalogSyncScope`, the selected
eligible provider units, their active profile keys and versions, and the
deterministic child `SourceObservationIntegrationJobScope` values produced by
the participation preview. Duplicate parent submissions reuse an active run
when the actor/account context, normalized scope, and selected provider-unit
snapshot match.

The parent run fans out child provider imports through the existing
`SourceObservationIntegrationJobScope` job API. Newly created child jobs carry
the parent `syncRunId` in their durable payload. If the duplicate-submission
policy reuses an already-active child provider job, the parent records that
child job id as a reused active child instead of mutating the existing child
payload. This keeps the existing child retry, resume, cancel, profile snapshot,
and mixed-outcome behavior authoritative.

Parent progress is an aggregate view over the durable child jobs. It reports
child job counts by queued, running, completed, partial, failed, cancelled, and
stale status, plus provider target progress when child jobs expose target
counts. A child enqueue failure is stored on the parent child link so operators
can see partial fan-out failures even when no child job id exists for that
provider unit.

Providers never directly write canonical Catalog Item or Product truth. Provider
pulls write Source Observations and evidence. Promotion, reapply, split, update,
and delete decisions remain Catalog review actions that produce Catalog commands
only after approval.

In Catalog sync decision vocabulary, `delete` means rejecting, ignoring, or
withdrawing a candidate from the proposed merged sync result. It does not mean a
provider can remove canonical Catalog Items or Products. Canonical removal or
archival remains an explicit Catalog Item/Product lifecycle command outside the
provider pull step.
