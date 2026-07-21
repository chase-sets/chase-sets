# Release Qualification Evidence

Durable merge-queue qualification records are the promotion authority that lets production prove the exact candidate it is about to promote already passed qualification (issue #5836, epic #5496). Records live in the dedicated private, versioned `chase-sets-release-qualification` Space; Actions artifacts and mutable image tags remain diagnostics only, and a GitHub Deployment or check summary may index the Space but can never replace it.

- Terraform root: [infrastructure/digitalocean/release-qualification](../../infrastructure/digitalocean/release-qualification/README.md)
- Record writer/reader CLI: [scripts/release-qualification-record.mjs](../../scripts/release-qualification-record.mjs)
- Contract and fixture tests: `scripts/release-qualification-record.test.mjs`, `scripts/digitalocean-platform-config.test.mjs`, `scripts/workflow-provider-credentials.test.mjs`

## Record contract (`release-qualification/v1`)

Each record binds repository, merge-group candidate SHA, candidate tree SHA, image repository and digest, qualification lane, classifier policy version, run id/attempt, timestamps, result, and https evidence links. Records are capped at 64 KiB.

Attempt records are append-only at:

```text
v1/attempts/<repository>/<candidate-tree-sha>/<image-digest>/<run-id>-<run-attempt>.json
```

The writer performs head-before-put: a byte-identical retry is an idempotent success; any other object already at the attempt key fails closed and is never overwritten. A requeued same-tree candidate carries a new run id/attempt, so it writes a distinct key. The `v1/canary/` prefix is reserved for the provider-backed canary probe and is the only prefix the tooling ever deletes from.

## Fail-closed reader behavior

The production reader consumes the exact record key selected during release resolution — never an arbitrary old pass found by prefix scan. It fails closed unless ALL of the following hold:

1. The body parses and validates as `release-qualification/v1`; any other schema version (including future versions) is rejected.
2. The record's content re-derives exactly the attempt key it was read from.
3. Repository matches, the record tree matches the release tree recomputed from the checked-out main SHA (`git rev-parse <sha>^{tree}`), the image digest matches the pinned release digest, and the classifier policy version matches.
4. `result` is `pass`.
5. For a new direct release, `completedAt` is at most 24 hours old. Rollback uses the record key retained in the previously promoted release manifest and is exempt from the age limit (`--mode rollback`).

```sh
node scripts/release-qualification-record.mjs verify \
  --record-key "v1/attempts/chase-sets/chase-sets/<tree>/<digest>/<run>-<attempt>.json" \
  --repository chase-sets/chase-sets \
  --main-sha "$(git rev-parse HEAD)" \
  --image-digest "sha256:..." \
  --classifier-policy-version release-scope-classifier/v1 \
  --mode new-release
```

## Credentials and rotation

Runtime record access uses ONLY the dedicated bucket-scoped Spaces key, stored as `RELEASE_EVIDENCE_SPACES_ACCESS_ID` and `RELEASE_EVIDENCE_SPACES_SECRET_KEY` in both the `merge-gate` and `production` GitHub environments. The broad Terraform-state Spaces credentials are never reused at runtime; they apply the Terraform root only. The CLI fails before any provider call when either variable is withheld, and workflow steps must thread both names as step-local env (enforced by `checkWorkflowSpacesEvidenceCredentials` in [scripts/workflow-provider-credentials.mjs](../../scripts/workflow-provider-credentials.mjs)). GitHub logs and records must never contain credential values, database URLs, or raw provider responses with secrets.

Rotation (operator, DigitalOcean control panel → API → Spaces Keys):

1. Create a NEW key scoped to the `chase-sets-release-qualification` bucket with Read/Write/Delete permission.
2. Update `RELEASE_EVIDENCE_SPACES_ACCESS_ID` and `RELEASE_EVIDENCE_SPACES_SECRET_KEY` in the `merge-gate` and `production` GitHub environments.
3. Run the canary probe (below) to prove the new key works.
4. Revoke the old key. Rotate immediately on any suspected exposure; otherwise rotate on the same cadence as the other Spaces keys.

## Canary probe

Provider-backed end-to-end proof of write / idempotent retry / conflict rejection / requeue / read-back, self-cleaning under `v1/canary/`:

```sh
RELEASE_EVIDENCE_SPACES_ACCESS_ID=... RELEASE_EVIDENCE_SPACES_SECRET_KEY=... \
  node scripts/release-qualification-record.mjs canary --out canary-summary.json
```

Retain the redacted summary as evidence; it contains keys and step outcomes only, never credentials.

## Retention and version recovery

Versioning is enabled and lifecycle rules retain current and non-current versions for 400 days (the evidence-retention horizon), then expire them. Versioning protects recovery from accidental overwrite or delete; it is not object lock and does not defend against a DigitalOcean account administrator.

Recovery drill for a deleted current version (run with the dedicated key, `--endpoint-url https://nyc3.digitaloceanspaces.com`):

1. `aws s3api list-object-versions --bucket chase-sets-release-qualification --prefix "<record key>"` — identify the delete marker and the latest surviving version id.
2. `aws s3api delete-object --bucket chase-sets-release-qualification --key "<record key>" --version-id "<delete-marker-id>"` — removing the delete marker restores the previous version as current.
3. Re-run the reader (`verify`) against the restored key and retain the summary. If the object was overwritten rather than deleted, copy the wanted version back atop itself with `get-object --version-id` + a reviewed re-upload, and treat the overwrite as an incident: attempt keys are append-only, so a non-identical overwrite means the writer contract was bypassed.

Run the drill against a canary object, not a live attempt record, unless recovering from a real incident.

## Access accountability

To answer who wrote or read a record:

- Enable Spaces access logging on `chase-sets-release-qualification` (operator, control panel) so provider-side reads/writes are attributable; store logs per DigitalOcean's bucket-logging destination rules.
- Independent of provider logs, every legitimate write happens inside a GitHub Actions run whose run id/attempt is embedded in the attempt key, so `list-object-versions` (an inventory probe: key, version id, last-modified) maps each object to the exact workflow run that wrote it. Reads in workflows are visible in the run logs that consumed the record key.
- Only the dedicated bucket-scoped key and account administrators can touch the bucket; any object whose key does not match a real workflow run is evidence of out-of-band access — rotate the key and investigate.

## Cost wager (ratified on epic #5496, 2026-07-21)

- One bucket on the existing Spaces subscription; no second subscription may be created. Confirm on the invoice before apply.
- 64 KiB per record (writer-enforced), 1 GiB total bucket usage and $1/month projected incremental cost for the first 30 days.
- Crossing either cap keeps downstream enforcement disabled (qualification stays advisory) and opens a cost-decision issue.
- At day 30, keep the permanent bucket only if measured incremental cost is within the cap and the 400-day projection is recorded; otherwise redesign the evidence footprint.

## Operator ownership

Todd owns the one-time control-panel setup and key custody:

1. Apply the Terraform root (Terraform automation credentials): creates the bucket with versioning, `prevent_destroy`, and the 400-day lifecycle.
2. Create a Spaces key scoped to the `chase-sets-release-qualification` bucket with Read/Write/Delete permission (control panel; not scriptable).
3. Add `RELEASE_EVIDENCE_SPACES_ACCESS_ID` and `RELEASE_EVIDENCE_SPACES_SECRET_KEY` to the `merge-gate` and `production` GitHub environments.
4. Verify `get-bucket-versioning` reports `Enabled`, enable access logging, and run the canary probe; retain both redacted outputs as closure evidence.

Until step 2–3 complete, every consumer fails closed by design: the CLI refuses provider calls without the dedicated credentials, and qualification remains advisory.

## Lane classifier (`release-qualification-scope/v1`) and its registration contract

`scripts/release-qualification-scope.mjs` classifies the complete production-marker-to-candidate diff into exactly one qualification lane: `not_applicable` (no deployable/runtime/infrastructure/provider consequence; still emits a signed-off machine record), `isolated` (application/image changes provable with disposable in-cluster Postgres and test-mode providers), or `persistent_required` (migration/schema, seed/bootstrap/import/reconciliation, Terraform, Helm/DOKS/ingress/DNS/Spaces, deployment/release workflows, live-provider contracts, money-movement contracts, destructive data, or anything ambiguous). It runs today as the advisory `Release Qualification Scope Advisory` merge-group job in `.github/workflows/platform-pr.yml`; it changes no required checks, and the advisory qualification issue owns the 20-candidate soak, staging-disagreement review, and the 30-day advisory expiry. The job records its own Actions minutes per classified candidate in the summary output (cost wager: repository-local compute only).

Classification is driven by code/dependency semantics and the registries inside `release-qualification-scope.mjs` — never by path-name vocabulary alone. Registered surfaces catch historical paths; content-semantic detectors (Terraform blocks, Kubernetes manifests, workflow YAML shape, SQL DDL, `BcSchemaMigration`/seed-contract anchors, live-provider SDK usage) catch renamed copies.

Registration contract — every new semantic owner must register, and unknown registrations fail closed to `persistent_required`:

- **Deployables**: add the directory name to `releaseQualificationScopeRegistry.deployables` with role `runtime` or `seed-machinery`. An unregistered (for example renamed) deployable directory classifies `persistent_required` (`unregistered_deployable`).
- **Migration mechanisms**: add historical paths to `migrationSurfacePatterns` and mechanism homes to `migrationMechanismRootPatterns`. DDL content outside every registered mechanism classifies `persistent_required` (`unrecognized_migration_mechanism`).
- **Providers**: add the `infrastructure/` directory to `registry.infrastructure` with ruling `live-provider` (or `test-mode-provider` for capture-only fakes). An unregistered infrastructure directory classifies `persistent_required` (`unregistered_infrastructure`).
- **Workflows**: every file in `.github/workflows` (and every composite action) must be registered as `release` or `ci`. Unregistered workflows classify `persistent_required` (`unregistered_workflow`), and the registration-drift test in `scripts/release-qualification-scope.test.mjs` fails until the registry matches the tree.
- **Seed/bootstrap/import/reconciliation entry points**: register under `seedBootstrapImportReconciliationPatterns` (or `operationalScriptPaths` for operator scripts). The caller-inventory sweep in the test discovers entry points by path tokens and seed-import semantics; anything discovered classifies `persistent_required` unless an explicit `reviewedNonPersistentSurfaces` ruling (with rationale) covers it, and even then a stronger fail-closed result is always accepted.

Fail-closed polarity (deliberate): this classifier treats a missing base, unreadable metadata or file content, unknown categories, classifier errors, and future policy versions as `persistent_required`. The sibling `scripts/release-deployment-scope.mjs` deliberately treats a missing base as deploy-required (fail open-to-deploy). Both fail toward the safer action for their consumer; production reconciliation must preserve both behaviors.
