# Workflow authority grants

Managed Postgres authority is reviewed next to the workflow job that owns it. Each owner uses
`.github/authority/<workflow-basename>/<jobId>.json` and contains a `grants` array with the exact
`file`, `jobId`, `stepAnchor`, `secretName`, and `purpose` values. Docker consumers, when present,
belong in the same fragment under `dockerConsumers` with `pathMapping`.

The canonical `scripts/managed-postgres-authority-manifest.json` is generated from tracked JSON fragments.
Add new fragments to Git before generating; no central source list is maintained:

```sh
node scripts/managed-postgres-authority-sources.mjs
node scripts/managed-postgres-authority-sources.mjs --check
```

The generator preserves repeated grants, rejects duplicate or mismatched owners, and sorts records
with code-unit ordering. Do not edit the canonical manifest directly. A moved workflow job must move
its fragment and update the exact file/job binding. New action-owned ingress requires a reviewed
ownership contract before it can be admitted.

Resolve source conflicts in the owning fragments and regenerate; never hand-merge canonical grants.
Review the central generated diff alongside the sources. Both the direct guard CLI and
`pnpm run check:managed-postgres-authority` check source freshness before independently reconciling ingress.
