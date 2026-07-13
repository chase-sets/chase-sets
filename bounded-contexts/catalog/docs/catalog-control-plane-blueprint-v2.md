# Catalog Control Plane Blueprint (v2)

The v2 information architecture for the Catalog integration control plane. This is
the design-first contract the m90 (#3849) implementation slices build against. The
machine-readable contract is
[`information-architecture-v2.ts`](../features/source-observations/ui/admin-control-plane/information-architecture-v2.ts);
this document is its narrative rationale, capability crosswalk, and disclosure rules.

## Why a third UX iteration

Three prior overhauls (m15 UX overhaul, m31 guided control plane, m38 workbench
overhaul) each reorganized the machine's internals and none shrank the interface.
The deprecated IA
([`information-architecture.ts`](../features/source-observations/ui/admin-control-plane/information-architecture.ts))
is a 373-line data structure: four route surfaces, eight workspaces in four
navigation groups, a workflow map that declares the primary path "blocked by" six
supporting workspaces, a `?section=` workspace router, detour telemetry, and
`returnPath` propagation across ten context keys. Operators detour to fix. **They
should fix in place.**

The differentiator of this milestone is shrinking the interface, not reorganizing
internals: three pages, two utilities, and a per-entity action vocabulary.

## Three pages + two utilities

| Surface | Kind | Route (`/admin/catalog`) | The operator job it completes |
| --- | --- | --- | --- |
| Catalog home | page | `/` | See every scope and the attention queue; open the scope that needs work. |
| Scope detail | page | `/scopes/:scopeId` | Run one scope's whole journey — import, review Source Observations, resolve conflicts and candidates, promote — in place. |
| Provider detail | page | `/providers/:providerKey` | Manage one provider — profile authoring, validation readiness, and the linear activate/rollback/deprecate/retire lifecycle. |
| Settings | page (utility) | `/settings` | Govern RBAC, rollout modes, kill switches, and observability ownership. |
| Evidence | drawer (utility) | — | Trace who changed what, when, with what redaction state for any entity — opened over the current page, never a detour. |

The three journey pages carry the daily work. Settings is a governance page an
operator visits rarely. The Evidence drawer has no route of its own: any entity on
any page opens it over the current context and closes it back to exactly where the
operator stood.

## Entities own behavior, not pages

Actions attach to **entities**, not to pages, so the same action renders wherever
its entity appears — a list row, a detail header, or an evidence drawer. Six
entities, each with one home page:

| Entity | Home page |
| --- | --- |
| Scope | Scope detail |
| Import job | Scope detail |
| Source Observation | Scope detail |
| Merge candidate | Scope detail |
| Catalog Alias | Scope detail |
| Provider profile | Provider detail |

## Per-entity action vocabulary

The target vocabulary that replaces today's form intents across the four command
handlers. The 2026-07-03 review estimated ~31 intents; the live handlers carry 27
(16 daily, 5 alias-review, 3 provider-setup, 3 governance). Every current intent
maps to exactly one v2 action; several collapse (retry/resume/cancel are job
lifecycle transitions; accept/auto-accept are one alias accept; preview/execute
promotion are one guarded flow).

| Action | Entity | Permission | Feedback shape | Disclosure | Replaces current intents |
| --- | --- | --- | --- | --- | --- |
| `scope.sync` | Scope | `catalog.manage` | job-progress | inline | `start-catalog-sync` |
| `scope.import` | Scope | `catalog.manage` | job-progress | inline | `start-provider-import` |
| `job.retry` | Import job | `catalog.manage` | job-progress | inline | `retry-import-job` |
| `job.resume` | Import job | `catalog.manage` | job-progress | inline | `resume-import-job` |
| `job.cancel` | Import job | `catalog.manage` | confirmation-gate | inline | `cancel-import-job` |
| `observation.promote` | Source Observation | `catalog.manage` | preview-panel | inline | `preview-promotion`, `execute-promotion` |
| `observation.reject` | Source Observation | `catalog.manage` | row-transition | inline | `reject-source-observations` |
| `observation.defer` | Source Observation | `catalog.manage` | row-transition | inline | `defer-source-observations` |
| `observation.reapply` | Source Observation | `catalog.manage` | job-progress | inline | `start-reapply` |
| `observation.replay` | Source Observation | `catalog.manage` | job-progress | inline | `start-replay` |
| `candidate.promote` | Merge candidate | `catalog.manage` | status-banner | inline | `promote-merge-candidate` |
| `candidate.edit` | Merge candidate | `catalog.manage` | preview-panel | drawer | `update-merge-candidate` |
| `candidate.split` | Merge candidate | `catalog.manage` | preview-panel | drawer | `split-merge-candidate` |
| `candidate.ignore` | Merge candidate | `catalog.manage` | row-transition | inline | `ignore-merge-candidate` |
| `candidate.defer` | Merge candidate | `catalog.manage` | row-transition | inline | `defer-merge-candidate` |
| `alias.accept` | Catalog Alias | `catalog.manage` | row-transition | inline | `accept`, `auto-accept` |
| `alias.reject` | Catalog Alias | `catalog.manage` | row-transition | inline | `reject` |
| `alias.revoke` | Catalog Alias | `catalog.manage` | row-transition | inline | `revoke` |
| `alias.defer` | Catalog Alias | `catalog.manage` | row-transition | inline | `defer` |
| `provider-profile.clone` | Provider profile | `catalog.manage` | status-banner | inline | `clone-provider-profile` |
| `provider-profile.edit-section` | Provider profile | `catalog.manage` | status-banner | inline | `update-provider-profile-section` |
| `provider-profile.activate` | Provider profile | `catalog.manage` | confirmation-gate | inline | `activate-provider-profile` |
| `provider-profile.rollback` | Provider profile | `catalog.manage` | confirmation-gate | inline | `rollback-provider-profile` |
| `provider-profile.deprecate` | Provider profile | `catalog.manage` | confirmation-gate | inline | `deprecate-provider-profile` |
| `provider-profile.retire` | Provider profile | `catalog.manage` | confirmation-gate | inline | `retire-provider-profile` |

Permissions follow the existing binary Catalog policy
([RBAC](./catalog-integration-admin-control-plane-rbac.md)): reads need
`catalog.view`, every state-changing action needs `catalog.manage`. No new roles.

### Feedback shapes

- **status-banner** — a transient success/error banner on the surface the action
  was invoked from.
- **row-transition** — the entity's own row transitions state in place (accept,
  defer, ignore, reject).
- **preview-panel** — a typed, freshness-guarded preview renders inline and must be
  re-confirmed before the committing action runs. This replaces the stale raw-JSON
  promotion/candidate preview.
- **confirmation-gate** — a destructive action requires a typed match confirmation
  inline, then a status banner reports the outcome.
- **job-progress** — an asynchronous job is enqueued and its progress tracks on the
  entity.

## Disclosure rules

1. **Inline first.** Anything that acts on an entity already visible on the current
   page renders and resolves inline: list-row actions, readiness banners, promotion
   previews, confirmation gates.
2. **Drawer for depth over the same context.** Evidence/audit for any entity, and
   the typed structured editors for candidate edit/split, open in a drawer over the
   current page and close back to exactly where the operator stood. A drawer never
   changes the route.
3. **Page only for forward navigation.** Opening a scope from the home queue, or a
   provider from a scope, is a forward step into that entity's own detail — never a
   detour to fix a blocker.
4. **Blockers always resolve inline or in a drawer.** No action requires navigating
   to another page to become unblocked. Because there is no detour, there is no
   `returnPath` and no `?section=` router; the surviving context keys are entity
   references (`scopeId`, `providerKey`, `profileVersion`, `candidateId`,
   `observationSelection`, `jobId`, `evidenceRef`). Selection is durable page state,
   not a URL detour.

## Capability crosswalk — the eight deprecated workspaces

Nothing is silently dropped. Standalone triage and audit pages fold into inline
readiness and the evidence drawer.

| Deprecated workspace | Disposition | New home | Rationale |
| --- | --- | --- | --- |
| import-to-promotion | moved | Scope detail | The import → review → promotion journey is the scope-detail page; the queue that starts it is on catalog-home. |
| health-triage | folded | Scope detail (+ provider-detail for transport) | Readiness renders as inline blocker banners on the affected scope/provider; fix in place. |
| profile-authoring | moved | Provider detail | Drafting and section editing are part of one provider's linear lifecycle. |
| validation-readiness | folded | Provider detail | Fixture/dry-run/compare/activation/credential/transport readiness render inline as the gate before activate. |
| conflict-resolution | folded | Scope detail (+ evidence drawer) | Conflicts resolve inline on the observation they block; precedence/audit open in the evidence drawer. |
| lifecycle-recovery | moved | Provider detail (+ scope-detail) | Rollback/deprecate/retire are the profile lifecycle; observation reapply/replay live with observations. |
| governance-controls | moved | Settings | RBAC, rollout, kill switches, and observability ownership are the Settings page. |
| audit-evidence | folded | Evidence drawer | Audit traceability becomes a drawer openable over any entity, not its own page. |

### Intentionally retired machine internals

These are structural, not operator capabilities — no operator job is lost:

- **`returnPath` propagation** — blockers resolve inline or in a drawer, so there is
  never a surface to return from.
- **`?section=` workspace router** — three real pages replace one route that
  switched among eight stacked workspaces.
- **detour telemetry and the `blockedBy` workflow map** — nothing left to instrument
  once every blocker is fixed in place.
- **stale raw-JSON promotion/candidate preview** — replaced by typed,
  freshness-guarded preview panels.

## Sequencing

This is the first m90 slice and blocks the implementation slices. It assumes the m88
scope registry (#3791-#3794) is underway so the blueprint can lean on
auto-mapping/auto-participation, and m88 scope-first landing/detail (#3801) as the
daily-path foundation this milestone extends. The deprecated IA and its live
consumers stay in place, marked for deletion, until the implementation slices land:
#3820 (catalog-home), #3821 (scope-detail), #3832 (provider-detail), #3833
(settings + evidence drawer), and #3834 (typed promotion preview).
