# Catalog Integration Admin Control Plane RBAC

Catalog owns the permission policy for provider integration control-plane actions. Auth and Identity own actor, membership, role, and permission facts; deployable hosts resolve the actor and enforce the coarse Catalog API boundary. Catalog routes also enforce the same action policy so tests and future route composition cannot bypass high-risk workflow checks.

## Permission Model

Use the existing Catalog permissions:

- `catalog.view`: inspect Catalog integration control-plane read models, profiles, Source Observations, readiness, job status, redacted diagnostics, and impact summaries.
- `catalog.manage`: perform profile authoring, lifecycle, import, reapply, promotion, rejection, raw-profile compatibility, and other actions that can change Catalog-owned integration state or provider-facing workload.

Catalog does not define new roles in this policy. Role-to-permission assignment remains upstream of Catalog.

## Action Matrix

| Action | Permission | Destructive | Notes |
| --- | --- | --- | --- |
| Integration health, readiness, overview, active profile summaries | `catalog.view` | No | Redacted control-plane state only. |
| Provider option reads | `catalog.view` | No | May use cached/stale provider option data according to provider option query policy. |
| Source Observation list/detail reads | `catalog.view` | No | Detail payloads remain governed and redacted. |
| Provider profile list, authoring read model, lifecycle impact preview | `catalog.view` | No | Impact previews expose counts, samples, and diagnostics, not raw payloads. |
| Job status and job event streams | `catalog.view` | No | Durable job snapshots and progress events only. |
| Create, clone, patch, or section-save provider profiles | `catalog.manage` | Yes | Section commands must carry authoring audit context. |
| Fixture/dry-run request submission | `catalog.manage` | No | Submitting payloads or fixture overrides is operator work, even when it does not persist profile lifecycle state. |
| Activate, rollback, deprecate, or retire provider profiles | `catalog.manage` | Yes | Must use readiness and lifecycle impact safeguards before confirmation. |
| Import or reapply job enqueue | `catalog.manage` | Yes | Confirmed scope must be resolved server-side when the action runs. |
| Promotion/reapply/bulk review previews submitted through POST endpoints | `catalog.manage` | No | These are manage-gated because they prepare destructive follow-up work and match host API method enforcement. |
| Promote or reject Source Observations, including bulk jobs | `catalog.manage` | Yes | Bulk flows must support mixed outcomes and audit context. |

## Destructive-Action Safeguards

Destructive actions must show an operator-facing confirmation path before execution when initiated from Admin UI:

- activation: readiness diagnostics, fixture coverage, unsafe evidence checks, lifecycle impact, active job conflicts, profile pointer, and mapping fingerprint
- rollback, deprecation, retirement: lifecycle impact counts, active job conflicts, referenced observations, impacted Catalog Item samples, and external reference samples
- import and reapply: provider, language, set or filter scope, active profile snapshot, expected work count where available, and active overlapping jobs
- promote and reject: selected IDs or server-resolved filter scope, eligible/skipped counts, reason capture for rejection, and affected Catalog Item samples when available
- raw-profile compatibility actions: quarantine owner issue, reason, retirement condition, and audit context

The server remains authoritative. UI confirmations help operators understand blast radius, but route guards, lifecycle consistency checks, rollout controls, and command validation must still block unsafe or unauthorized execution.

## Denied-State Behavior

- Missing actor returns `401 authentication_required`.
- Actor without the required permission returns `403 forbidden`.
- Admin UI should disable or hide manage-only controls for operators lacking `catalog.manage` and explain that the missing permission is `catalog.manage`.
- Read models may surface `permission_denied` when a lower-level query cannot expose a sensitive state to the current operator. UI modules should render it as a blocked state and must not query raw profile JSON or lower-level tables as a workaround.

## Audit Expectations

Manage actions must preserve actor context through the existing Catalog event-store audit context. Profile rows, job payloads, lifecycle evidence, Source Observation review actions, and audit/evidence timeline entries should include actor user/account identifiers where the existing command path supports them. Sensitive provider credentials, raw payloads, seller/account facts, prices, inventory, quantities, listing facts, and provider-controlled commerce data remain governed by the Catalog Integration Data Governance policy.
