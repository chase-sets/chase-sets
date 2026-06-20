# Catalog Primary Workbench Admin Contract

This note defines the authoritative admin API and read-model contract for the rebuilt Catalog Control Plane primary workbench. The primary workbench is not a migration of retired admin pages. It is a clean-launch workflow centered on pulling provider data, reviewing Source Observations, and promoting eligible observations into Catalog Items or Catalog-owned references.

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
| `schemaVersion` | Must equal `catalog-primary-workbench-v2`; mismatches fail closed. |
| `generatedAt` | Server generation timestamp for freshness and support triage. |
| `routeContext` | Provider, unit, import scope, profile version, filters, selected observations, job, preview, and return-path context that the UI must preserve. |
| `providerScope` | Generic provider/unit/scope options with active profile pointers; no provider-specific UI branches. |
| `readiness` | Rollout, RBAC, transport, fixture, profile, read-model, and audit evidence readiness. |
| `healthTriage` | Support-workspace read model for readiness KPIs, ingestion-unit health, provider adapter transport, rollout controls, active jobs, read-model freshness, and audit lifecycle preview. |
| `profileAuthoring` | Support-workspace read model for selected profile overview, active/profile-version options, lifecycle restrictions, immutable clone facts, view-only state, stale selection, and draft creation. |
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

## Health Triage Support Workspace

`healthTriage` is rendered only when the rebuilt route selects the Health triage support workspace, such as `section=triage` or `section=health-triage`. It is a context-preserving detour, not a second primary page. The module must include a return link to the import-to-promotion workbench and the primary workbench must remain visible below it so operators can continue the provider pull, Source Observation review, and promotion path.

The health-triage read model must keep these states visually and semantically distinct:

- Catalog semantic readiness, fixture validation, dry-run status, and Source Observation fact counts per ingestion unit.
- Provider adapter transport readiness, credential readiness, reachability, option query health, rate-limit state, payload acquisition, and adapter diagnostics per provider.
- Rollout controls and kill switches with owner, issue, metric key, affected provider/unit, and next action.
- Active, queued, and failed durable import jobs with operator state, progress, owner metric, and recovery action.
- Read-model freshness for integration health, provider transport, durable job progress, and audit evidence.
- Recent audit lifecycle facts with projection status and generated timestamp.

Blocked and degraded rows must name the affected provider or ingestion unit, expose the owner metric key, and give the likely next action. The dashboard must not expose raw provider payloads, inspect profile JSON, branch by provider/product category, or preserve retired support routes.

## Profile Authoring Support Workspace

`profileAuthoring` is rendered only when the rebuilt route selects the Profile authoring support workspace, such as `section=profile-work` or `section=profile-authoring`. It is a context-preserving detour, not a migration of the retired profile review page and not a second default route. The detour replaces the primary workbench body while preserving the global provider-data pull command and an explicit return link back to pulling provider data, reviewing Source Observations, and promoting Catalog facts.

The read model must be built from typed `CatalogProviderProfileVersionReview` records, the active route context, and existing control-plane evidence. It must not parse profile payload JSON or preserve old profile-review page selectors. The selected profile overview includes provider key, profile key, version, lifecycle, active state, status, connector kind, capabilities, supported scopes, language options, validation diagnostics, fixture coverage, source contract evidence, mapping fingerprint when reported by typed evidence, reference count, migration evidence, authoring audit, and immutable identity facts.

Draft creation uses the clean `clone-provider-profile` command. The command preserves source provider and source profile version, proposes a new draft version, sets target lifecycle to `draft`, carries immutable identity facts, and redirects back to `profile-work` with the created draft selected. View-only operators can inspect all profile evidence but the draft command is denied with `permission-denied`. Missing profile and stale route-selected profile versions fail closed with `profile-version-missing` rather than silently selecting another version.

## Endpoint Shape

The workbench contract pins command routes under the Source Observations admin API boundary:

| Command | Method | Route pattern | Permission | Blocking behavior |
| --- | --- | --- | --- | --- |
| `select-provider-scope` | `GET` | `/api/catalog/source-observations/admin/primary-workbench` | `catalog.view` | Fails closed for denied access or retired legacy selectors. |
| `start-provider-import` | `POST` | `/api/catalog/source-observations/admin/import-jobs` | `catalog.manage` | Requires idempotency and fails closed for readiness, transport, job conflict, security, and deploy-skew blockers. |
| `resume-import-job` | `POST` | `/api/catalog/source-observations/admin/import-jobs/:jobId/resume` | `catalog.manage` | Requires idempotency and fails closed when the job is missing. |
| `retry-import-job` | `POST` | `/api/catalog/source-observations/admin/import-jobs/:jobId/retry` | `catalog.manage` | Requires idempotency and fails closed for stale replay, replay reuse, or security blockers. |
| `cancel-import-job` | `POST` | `/api/catalog/source-observations/admin/import-jobs/:jobId/cancel` | `catalog.manage` | Requires idempotency and fails closed for denied or unsupported commands. |
| `clone-provider-profile` | `POST` | `/api/catalog/source-observations/admin/provider-profiles/:providerKey/:profileVersion/clone` | `catalog.manage` | Requires idempotency and fails closed for denied access, missing/stale profile selection, active job conflicts, and retired payload editing behavior. |
| `select-source-observations` | `GET` | `/api/catalog/source-observations/admin/review` | `catalog.view` | Fails closed for stale or unavailable Source Observation read models. |
| `preview-promotion` | `POST` | `/api/catalog/source-observations/admin/promotion-preview` | `catalog.manage` | Requires idempotency and fails closed for empty selections, conflicts, stale projections, or security blockers. |
| `execute-promotion` | `POST` | `/api/catalog/source-observations/admin/promotions` | `catalog.manage` | Requires idempotency and confirmation; fails closed for stale preview, destructive confirmation, conflicts, security, or deploy skew. |
| `reject-source-observations` | `POST` | `/api/catalog/source-observations/admin/rejections` | `catalog.manage` | Requires confirmation and idempotency. |
| `defer-source-observations` | `POST` | `/api/catalog/source-observations/admin/deferrals` | `catalog.manage` | Requires idempotency. |
| `start-reapply` | `POST` | `/api/catalog/source-observations/admin/reapply-jobs` | `catalog.manage` | Requires idempotency and fails closed for missing current active profile, stale replay, replay reuse, or security blockers. |
| `start-replay` | `POST` | `/api/catalog/source-observations/admin/replay-jobs` | `catalog.manage` | Requires idempotency and fails closed for missing profile, stale replay, replay reuse, or security blockers. |

Admin page routes may wrap these API routes, but no implementation may preserve retired admin module structure, hidden compatibility redirects, support-only legacy routes, or raw JSON escape hatches.

## Admin Route Command Bridge

The rebuilt `/catalog/integrations` route may expose native form submits for the default workbench as a progressive-enhancement bridge while the clean admin API route patterns above are completed. That bridge must keep the primary-workbench command names (`start-provider-import`, `retry-import-job`, `resume-import-job`, `cancel-import-job`, `clone-provider-profile`, `preview-promotion`, `execute-promotion`, `reject-source-observations`, `defer-source-observations`, `start-reapply`, `start-replay`) in the UI payload, preserve provider/unit/scope/profile/filter/selection/job/preview context, and redirect back to the rebuilt workbench with sanitized success or fail-closed feedback. Promotion execution must re-check the live preview against a context-bound preview checkpoint before enqueueing work; profile, provider unit, import scope, filters, and selected observation ids are part of that checkpoint, and mutating commands clear the checkpoint after enqueueing. Selected-observation previews must count the exact selected IDs instead of broadening to the current filter scope.

The bridge may translate to existing lower-level Source Observation API client methods as an implementation detail, but it must not expose retired route structure, legacy provider selectors, raw JSON payloads, compatibility redirects, aliases, or support-only legacy paths. Provider import lifecycle commands call launch-ready retry/resume/cancel durable job APIs and require the row job id. Retry requeues the same job while pruning failed outcomes, resume requeues only queued or stale running jobs, and cancel records operator status `cancelled`. `clone-provider-profile` calls the typed provider profile clone API, clears stale promotion preview context, and returns to the profile authoring detour with the new draft selected. `defer-source-observations` enqueues a durable bulk review job that records the operator reason and keeps each observation in `observed` or `changed` review state. `start-reapply` uses `current-active-profile` mode and snapshots the active provider profile at enqueue. `start-replay` uses `original-source-profile` mode and fails closed when original Source Observation profile evidence is missing or retired. If a command has no launch-ready backend route, the bridge must fail closed with `unsupported-command` instead of rendering a working-looking no-op.

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
- retired module coupling;
- raw JSON broad patch;
- silent active-profile fallback;
- raw provider payload fallback;
- generic disabled state;
- support-only legacy route;
- compatibility redirect.

These are not temporary launch aids. They are prohibited implementation outcomes for this milestone.

## Retirement Rule

For this control plane rebuild, "retire", "remove", "deprecate", and "cleanup" mean complete removal, not soft deprecation. Retired behavior must be deleted from runtime code, API routes, UI modules, product patterns, read-model contracts, clients, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, operator instructions, route aliases, feature flags, hidden flags, fallback branches, redirects, compatibility aliases, compatibility shims, migration shims, and support-only routes.

Forbidden outcomes include compatibility shims, legacy support paths, migration of retired admin behavior, raw JSON escape hatches, support-only preserved routes, documentation-only deprecation, hidden flag fallbacks, or documentation that teaches operators how to use retired behavior.

## Downstream Issue Handoff

| Consumes | Required fields |
| --- | --- |
| Profile overview and draft creation support detour | `profileAuthoring.status`, `profileAuthoring.selectedProfile`, `profileAuthoring.availableProfiles`, `profileAuthoring.cloneDraft` |
| Primary workbench assembly | `schemaVersion`, `routeContext`, `providerScope`, `readiness`, `importJobs`, `sourceObservationReview`, `promotionPreview`, `actions` |
| Provider/scope/import controls | `providerScope.providers.units.importScopes`, `readiness.providerTransport`, `importJobs.jobs.consistency` |
| Source Observation review | `sourceObservationReview.counts`, `sourceObservationReview.cursor`, `sourceObservationReview.evidenceSummariesRedacted`, `promotionPreview.dispositions` |
| Promotion preview and execution | `promotionPreview.commandPlanHash`, `promotionPreview.dispositions`, `promotionResult.auditEvidenceIds` |
| Route-context preservation | `routeContext.providerKey`, `routeContext.unitKey`, `routeContext.importScope`, `routeContext.selectedObservationIds`, `routeContext.promotionPreviewId` |
| Operator copy and blocked-state clarity | `actions.copyKey`, `readiness.blockers`, `primary-workbench-copy.ts`, `catalogPrimaryWorkbenchBlockerCopy`, `catalogPrimaryWorkbenchProviderTransportCopy`, `catalogPrimaryWorkbenchGlossaryTerms` |
| Telemetry and instrumentation | `instrumentation.dimensions`, `instrumentation.redactionSafe` |
| Real-provider proof | `providerScope.providers.providerKey`, `readiness.providerTransport`, `promotionResult.promotedCatalogItemIds` |
| Durable-job edge cases | `importJobs.jobs.consistency`, `promotionPreview.blockers` |
| Security/privacy | `securityPrivacy.redactionApplied`, `securityPrivacy.unsafeEvidenceBlocked`, `securityPrivacy.missingSecurityFieldsBlocker` |
| Provider transport budgets | `readiness.providerTransport`, `readiness.blockers` |

Downstream issues may add implementation-specific fields, but they must not weaken this contract by adding provider-specific workbench branches, generic disabled-only states, raw provider payload reads, or legacy route fallbacks.
