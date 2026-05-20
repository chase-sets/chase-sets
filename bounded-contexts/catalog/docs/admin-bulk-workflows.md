# Catalog Admin Bulk Workflows

Catalog admin bulk workflows let operators act on explicit selected rows or on the current filtered list scope without moving Catalog behavior into a deployable. The Catalog bounded context owns the request contracts, scope resolution, command execution, projection refresh, and result reporting.

## Selection Contract

Bulk endpoints accept one of two selection shapes:

```json
{ "mode": "ids", "ids": ["cat_1", "cat_2"] }
```

```json
{ "mode": "filter", "query": { "status": "draft", "search": "charizard" } }
```

Filtered selections are resolved server-side from the owning read model at preview time and again at confirm time. The UI never pages through every row to manufacture a bulk scope.

## Preview And Confirm

Destructive, lifecycle, or partial-success actions use preview and confirm endpoints. Preview returns the current candidate set, ready/blocked counts, and per-record reasons. Confirm re-resolves the selection, runs the existing aggregate command for each ready record, drains the slice projectors, and returns succeeded/skipped/failed outcomes.

This keeps event-sourced invariants authoritative. Bulk operations are orchestration over existing commands, not separate domain shortcuts.

## Covered Admin Screens

Dimensions, Fields, Components, Blueprints, Categories, Reference Types, Reference Records, and Catalog Items use shared lifecycle previews for the lifecycle actions already available per record.

Catalog Items also support low-risk shared edits where one input safely applies to every selected or matching record:

- assign blueprint
- assign category
- remove category
- set tags
- merge tags
- clear tags

Source Observations keep their provider review workflow and support selected or matching-scope rejection with one shared rejection reason.

## Result Semantics

Bulk results are intentionally mixed:

- `ready`: preview says the row can receive the command.
- `blocked`: preview says the row cannot receive the command and includes a reason.
- `succeeded`: confirm applied the command and projectors were drained afterward.
- `skipped`: confirm rechecked the row and did not apply the command.
- `failed`: the aggregate command or runtime operation failed and includes a reason.

Operators should expect mixed results when selections include multiple statuses or stale rows.

## Realtime Projection Refresh

Catalog admin bulk actions still return operation results immediately, but list pages do not rely on that response as read-model truth. Catalog projectors publish small `projection.patch` invalidations to Catalog-owned admin topics after the affected projection has updated. Admin routes subscribe to their surface topic and revalidate the current loader when a patch or `sync.required` message arrives.

This keeps filter semantics, pagination, and bulk scope resolution on the server while removing manual refresh from the normal operator workflow. The SSE transport is platform-owned; Catalog owns the topic names, authorization policy, patch payload shape, and projection emission points.
