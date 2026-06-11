# Catalog Primary Workbench Admin Contract

Issue #1060 defines the authoritative admin API and read-model contract for the rebuilt Catalog Control Plane primary workbench. The primary workbench is not a migration of the current Catalog integrations pages. It is a clean-launch workflow centered on pulling provider data, reviewing Source Observations, and promoting eligible observations into Catalog Items or Catalog-owned references.

The authoritative TypeScript surface lives in:

```text
bounded-contexts/catalog/features/source-observations/api/primary-workbench-admin-contracts.ts
```

The contract composes the shared query inventory in [Admin Control Plane Query Contracts](./admin-control-plane-query-contracts.md), the read-model SLO states in [Admin Control Plane Read-Model SLOs](./admin-control-plane-read-model-slos.md), the first-slice provider transport budgets in [Catalog Integration Provider Transport Budgets](./catalog-integration-provider-transport-budgets.md), and the operator-facing copy system in [Catalog Control Plane Operator Copy](./catalog-control-plane-operator-copy.md). It exists so Stage 2 workbench implementation can consume one typed API boundary instead of preserving page-specific selectors, raw JSON patches, or provider-specific UI branches.

## Primary Path

The default operator path is:

1. Select provider, unit, import scope, and active profile context.
2. Confirm readiness: rollout, RBAC, credentials, fixtures, active profile, provider transport, and read-model health.
3. Start, resume, retry, or cancel provider import jobs.
4. Review Source Observations with redaction-safe evidence summaries.
5. Preview promotion into Catalog Items or Catalog-owned references.
6. Execute promotion and review audit evidence.

Supporting evidence, replay, reapply, rollback impact, semantic comparison, fixture validation, and audit history are supporting branches. They must unblock or explain the primary path without becoming peer-level workflows that bury provider import and promotion.

## Read Model

`CatalogPrimaryWorkbenchReadModel` is the server DTO for the rebuilt workbench:

| Field | Purpose |
| --- | --- |
| `schemaVersion` | Must equal `catalog-primary-workbench-v1`; mismatches fail closed. |
| `generatedAt` | Server generation timestamp for freshness and support triage. |
| `routeContext` | Provider, unit, import scope, profile version, filters, selected observations, job, preview, and return-path context that the UI must preserve. |
| `providerScope` | Generic provider/unit/scope options with active profile pointers; no provider-specific UI branches. |
| `readiness` | Rollout, RBAC, transport, fixture, profile, read-model, and audit evidence readiness. |
| `importJobs` | Durable job state, operator state, unit/scope context, profile snapshot, Catalog consistency policy, observation links, and job blockers. |
| `sourceObservationReview` | Counts, cursor, selected observations, redaction marker, duplicate conflicts, and promotion-ready count. |
| `promotionPreview` | Preview id, dispositions, command plan hash, confirmation requirement, destructive count, and blockers. |
| `promotionResult` | Promoted Catalog Item ids, promoted reference ids, skipped observations, and audit evidence ids. |
| `actions` | Command availability with explicit action states, blocker categories, and copy keys. |
| `deploySkew` | Fail-closed version skew policy; unsupported UI/API pairings cannot use fallbacks. |
| `securityPrivacy` | Required redaction and governed-data markers; missing fields fail closed. |
| `instrumentation` | Redaction-safe dimensions for primary-path telemetry and blocker analysis. |

The contract validator fails closed when the schema version, route context, deploy-skew policy, security/privacy fields, or redaction-safe instrumentation are missing or unknown.

## Workbench Sections

| Section | Role | Commands | Default visibility |
| --- | --- | --- | --- |
| `provider-scope-selection` | Select provider, ingestion unit, import scope, active profile, and route context. | `select-provider-scope` | Visible |
| `readiness` | Explain rollout, RBAC, credential, fixture, profile, provider transport, and read-model readiness. | None | Visible |
| `import-jobs` | Start and recover provider import job progress. | `start-provider-import`, `resume-import-job`, `retry-import-job`, `cancel-import-job` | Visible |
| `source-observation-review` | Review changed/eligible Source Observations with redaction-safe summaries and cursor paging. | `select-source-observations`, `reject-source-observations`, `defer-source-observations` | Visible |
| `promotion-preview` | Preview promotion plan, conflicts, destructive changes, and confirmation requirements. | `preview-promotion`, `execute-promotion` | Visible |
| `promotion-result` | Show promotion outcome, audit evidence, recovery links, reapply, and replay entry points. | `start-reapply`, `start-replay` | Visible |
| `supporting-evidence` | Expose dry-run, semantic diff, impact analysis, rollback/retirement impact, and audit evidence. | None | Hidden by default |

The first six sections form the primary workbench. `supporting-evidence` may be linked from blocked/degraded states, evidence side sheets, or secondary navigation, but it must not displace the provider-data-to-promotion path.

## Endpoint Shape

The workbench contract pins command routes under the Source Observations admin API boundary:

| Command | Method | Route pattern | Permission | Blocking behavior |
| --- | --- | --- | --- | --- |
| `select-provider-scope` | `GET` | `/api/catalog/source-observations/admin/primary-workbench` | `catalog.view` | Fails closed for denied access or retired legacy selectors. |
| `start-provider-import` | `POST` | `/api/catalog/source-observations/admin/import-jobs` | `catalog.manage` | Requires idempotency and fails closed for readiness, transport, job conflict, security, and deploy-skew blockers. |
| `resume-import-job` | `POST` | `/api/catalog/source-observations/admin/import-jobs/:jobId/resume` | `catalog.manage` | Requires idempotency and fails closed when the job is missing. |
| `retry-import-job` | `POST` | `/api/catalog/source-observations/admin/import-jobs/:jobId/retry` | `catalog.manage` | Requires idempotency and fails closed for stale replay, replay reuse, or security blockers. |
| `cancel-import-job` | `POST` | `/api/catalog/source-observations/admin/import-jobs/:jobId/cancel` | `catalog.manage` | Requires idempotency and fails closed for denied or unsupported commands. |
| `select-source-observations` | `GET` | `/api/catalog/source-observations/admin/review` | `catalog.view` | Fails closed for stale or unavailable Source Observation read models. |
| `preview-promotion` | `POST` | `/api/catalog/source-observations/admin/promotion-preview` | `catalog.manage` | Requires idempotency and fails closed for empty selections, conflicts, stale projections, or security blockers. |
| `execute-promotion` | `POST` | `/api/catalog/source-observations/admin/promotions` | `catalog.manage` | Requires idempotency and confirmation; fails closed for stale preview, destructive confirmation, conflicts, security, or deploy skew. |
| `reject-source-observations` | `POST` | `/api/catalog/source-observations/admin/rejections` | `catalog.manage` | Requires confirmation and idempotency. |
| `defer-source-observations` | `POST` | `/api/catalog/source-observations/admin/deferrals` | `catalog.manage` | Requires idempotency. |
| `start-reapply` | `POST` | `/api/catalog/source-observations/admin/reapply-jobs` | `catalog.manage` | Requires idempotency and fails closed for missing current active profile, stale replay, replay reuse, or security blockers. |
| `start-replay` | `POST` | `/api/catalog/source-observations/admin/replay-jobs` | `catalog.manage` | Requires idempotency and fails closed for missing profile, stale replay, replay reuse, or security blockers. |

Admin page routes may wrap these API routes, but no implementation may preserve the current two-page Catalog integrations module structure, hidden compatibility redirects, support-only legacy routes, or raw JSON escape hatches.

## Admin Route Command Bridge

The rebuilt `/catalog/integrations` route may expose native form submits for the default workbench as a progressive-enhancement bridge while the clean admin API route patterns above are completed. That bridge must keep the primary-workbench command names (`start-provider-import`, `retry-import-job`, `resume-import-job`, `cancel-import-job`, `preview-promotion`, `execute-promotion`, `reject-source-observations`, `defer-source-observations`, `start-reapply`, `start-replay`) in the UI payload, preserve provider/unit/scope/profile/filter/selection/job/preview context, and redirect back to the rebuilt workbench with sanitized success or fail-closed feedback. Promotion execution must re-check the live preview against a context-bound preview checkpoint before enqueueing work; profile, provider unit, import scope, filters, and selected observation ids are part of that checkpoint, and mutating commands clear the checkpoint after enqueueing. Selected-observation previews must count the exact selected IDs instead of broadening to the current filter scope.

The bridge may translate to existing lower-level Source Observation API client methods as an implementation detail, but it must not expose the old two-page route structure, legacy provider selectors, raw JSON payloads, compatibility redirects, aliases, or support-only legacy paths. Provider import lifecycle commands call launch-ready retry/resume/cancel durable job APIs and require the row job id. Retry requeues the same job while pruning failed outcomes, resume requeues only queued or stale running jobs, and cancel records operator status `cancelled`. `defer-source-observations` enqueues a durable bulk review job that records the operator reason and keeps each observation in `observed` or `changed` review state. `start-reapply` uses `current-active-profile` mode and snapshots the active provider profile at enqueue. `start-replay` uses `original-source-profile` mode and fails closed when original Source Observation profile evidence is missing or retired. If a command has no launch-ready backend route, the bridge must fail closed with `unsupported-command` instead of rendering a working-looking no-op.

The import operations workbench scopes durable job rows to the selected provider and ingestion unit, sorts exact import-scope matches first, and keeps overlapping active jobs visible as blockers. Each job row carries `unitKey`, normalized `importScope`, `profileSnapshot`, `scopeMatchesRoute`, consistency policy names, failure groups, retry/resume/cancel availability, and links back to filtered Source Observation review and audit evidence. The start-provider-import action must be blocked when selected-context active jobs create duplicate-submit or overlap risk.

## Blocker Categories

Every blocked, denied, degraded, unsafe, unavailable, or disabled action must expose a `CatalogPrimaryWorkbenchBlockerCategory`. Generic disabled booleans are not enough.

| Group | Categories |
| --- | --- |
| Permission and authorization | `permission-denied`, `authorization-denied`, `rbac-missing` |
| Rollout and kill switch | `rollout-disabled`, `kill-switch-active` |
| Job concurrency and lifecycle | `active-job-conflict`, `concurrent-job`, `job-not-found`, `idempotency-replay`, `stale-replay` |
| Profile and fixture readiness | `missing-active-profile`, `profile-version-missing`, `missing-fixture-coverage`, `fixture-validation-blocked` |
| Provider credentials | `provider-credential-missing`, `provider-credential-invalid`, `provider-credential-expired` |
| Provider transport | `provider-transport-rate-limited`, `provider-transport-throttled`, `provider-transport-quota-exceeded`, `provider-transport-timeout`, `provider-transport-pagination-failure`, `provider-transport-partial-data`, `provider-transport-stale-cache`, `provider-transport-degraded` |
| Source/read-model health | `source-projection-stale`, `read-model-degraded`, `read-model-partial`, `read-model-unavailable`, `observation-not-found` |
| Selection and promotion | `selection-empty`, `no-promotion-eligible-observations`, `duplicate-conflict`, `promotion-conflict`, `destructive-confirmation-required`, `stale-promotion-preview` |
| Security and privacy | `security-privacy-blocked` |
| Unsupported or skewed commands | `unsupported-command`, `deploy-skew-unsupported-version` |
| Retired behavior | `raw-json-retired`, `legacy-selector-retired` |

All blocker contracts set `failClosed: true`, map to primary-path copy keys, and emit the redaction-safe `blocker_category` instrumentation dimension. The UI must render blocker categories through `primary-workbench-copy.ts`, which gives each category a human label, reason, next step, support target, and language group. It must not derive visible copy by splitting category slugs.

## Deploy Skew

The contract supports only the `current` UI/API pairing. `old-ui-new-api` and `new-ui-old-api` are unsupported deploy-skew states and must fail closed with `deploy-skew-unsupported-version`.

Forbidden fallback examples include:

- legacy provider selector;
- current two-page module coupling;
- raw JSON broad patch;
- silent active-profile fallback;
- raw provider payload fallback;
- generic disabled state;
- support-only legacy route;
- compatibility redirect.

These are not temporary launch aids. They are prohibited implementation outcomes for this milestone.

## Retirement Rule

For this control plane rebuild, "retire", "remove", "deprecate", and "cleanup" mean complete removal, not soft deprecation. Retired behavior must be deleted from runtime code, API routes, UI modules, product patterns, tests, fixtures, screenshots, documentation, runbooks, release notes, operator instructions, aliases, flags, fallbacks, redirects, support-only routes, and compatibility shims.

Forbidden outcomes include compatibility shims, legacy support paths, migration of the current two-page surface, raw JSON escape hatches, support-only preserved routes, or docs that teach operators how to use retired behavior.

## Downstream Issue Handoff

| Issue | Consumes | Required fields |
| --- | --- | --- |
| #1056 | Primary workbench assembly | `schemaVersion`, `routeContext`, `providerScope`, `readiness`, `importJobs`, `sourceObservationReview`, `promotionPreview`, `actions` |
| #1038 | Provider/scope/import controls | `providerScope.providers.units.importScopes`, `readiness.providerTransport`, `importJobs.jobs.consistency` |
| #1039 | Source Observation review | `sourceObservationReview.counts`, `sourceObservationReview.cursor`, `sourceObservationReview.evidenceSummariesRedacted`, `promotionPreview.dispositions` |
| #1040 | Promotion preview and execution | `promotionPreview.commandPlanHash`, `promotionPreview.dispositions`, `promotionResult.auditEvidenceIds` |
| #1057 | Route-context preservation | `routeContext.providerKey`, `routeContext.unitKey`, `routeContext.importScope`, `routeContext.selectedObservationIds`, `routeContext.promotionPreviewId` |
| #1058 | Operator copy and blocked-state clarity | `actions.copyKey`, `readiness.blockers`, `primary-workbench-copy.ts`, `catalogPrimaryWorkbenchBlockerCopy`, `catalogPrimaryWorkbenchProviderTransportCopy`, `catalogPrimaryWorkbenchGlossaryTerms` |
| #1059 | Telemetry and instrumentation | `instrumentation.dimensions`, `instrumentation.redactionSafe` |
| #1062 | Real-provider proof | `providerScope.providers.providerKey`, `readiness.providerTransport`, `promotionResult.promotedCatalogItemIds` |
| #1063 | Durable-job edge cases | `importJobs.jobs.consistency`, `promotionPreview.blockers` |
| #1064 | Security/privacy | `securityPrivacy.redactionApplied`, `securityPrivacy.unsafeEvidenceBlocked`, `securityPrivacy.missingSecurityFieldsBlocker` |
| #1065 | Provider transport budgets | `readiness.providerTransport`, `readiness.blockers` |

Downstream issues may add implementation-specific fields, but they must not weaken this contract by adding provider-specific workbench branches, generic disabled-only states, raw provider payload reads, or legacy route fallbacks.
