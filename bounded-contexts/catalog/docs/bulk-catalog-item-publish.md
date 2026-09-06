# Bulk Catalog Item Publish

Catalog owns bulk publishing for draft Catalog Items because publishing is the Catalog Item lifecycle transition from `draft` to `active`.

## Policy

- Bulk publish must use the existing `PublishCatalogItem` command for every Catalog Item.
- Filter-wide bulk publish uses the selected result-set filters; preview blocks non-draft Catalog Items with an operator-visible reason.
- Preview resolves the matching filter to an explicit Catalog Item ID set.
- Confirmation publishes the previewed IDs, not a freshly evaluated filter.
- Bulk publish uses partial success: valid drafts publish, while stale or invalid rows are skipped or failed with an operator-visible reason.
- Server-side Catalog validation must derive blueprint status and required field IDs from Catalog read models before calling the aggregate command.
- Every single, direct-service, seed, claimed-work-unit, legacy-job, and bulk publication reaches the same server adapter. The adapter requires the event-sourced Catalog Item, its current raw resolver tuple, the current persisted resolver-v3 fact, and a fresh resolver result to agree before the draft-to-active append.
- Publication readiness is separate from stored display resolution and Product Contents resolution: `current-resolved`, `degraded`, `unavailable`, or `outdated`. Blocked items remain drafts and carry bounded retry reasons; an outdated persisted fact may receive one item/language guarded update-only refresh before the adapter re-reads and re-resolves it.
- Confirmation may submit an all-outdated preview even when `ready_count` is zero, because each explicit previewed ID is revalidated at its own publication boundary. Failed and skipped IDs remain available for exact-ID retry, and result counts describe actual appends only.
- Integration-created draft batches should be targeted with the source provider filter from external product references.

## Rationale

Integration imports can create hundreds of draft Catalog Items. Operators need to publish valid records without opening each detail page, but Catalog must avoid sweeping unrelated hand-authored drafts into a batch. Source filtering, previewed ID confirmation, and partial success make the operation efficient while keeping the published facts precise and replay-safe.
