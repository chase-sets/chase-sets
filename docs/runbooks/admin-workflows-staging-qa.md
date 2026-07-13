# Admin Workflows Staging QA

This runbook defines the support-safe actor matrix, evidence rules, and state checks for milestone #65 Admin Workflows Staging QA. Use it before manual deployed admin-web QA so missing credentials, missing account state, and private evidence do not get mixed with product bugs.

## Scope

Use the deployed staging admin interface only. Do not use direct database reads, hidden routes, browser console mutations, provider dashboards, Postman, or ad hoc API calls as replacement evidence for the manual QA checklist. Local tests and smoke probes can support diagnosis, but deployed browser evidence is required for final checklist closure unless a row is explicitly marked controlled-unavailable.

## Actor Matrix

Record only the actor alias in GitHub evidence. Keep emails, passwords, user ids, account ids, session cookies, provider references, and one-time codes private.

| Alias | Intended permission shape | Sign-in host | Primary QA purpose | Account-select expectation |
| --- | --- | --- | --- | --- |
| `admin-qa-platform-admin` | `platform-admin` role | `/access/sign-in` | Full Access, Commerce, Growth, Support, and Platform workflows. | If multiple accounts are visible, select the operator-owned QA account and record only the account alias. |
| `admin-qa-owner` | `owner` account role | `/access/sign-in` | Account-scoped Access and membership visibility. | Lands on or selects the owned representative account alias. |
| `admin-qa-manager` | `manager` account role | `/access/sign-in` | Manager-level account operations and restricted security behavior. | Lands on or selects the managed representative account alias. |
| `admin-qa-fulfillment` | `fulfillment` account role | `/access/sign-in` | Fulfillment-limited Access and commerce/support visibility. | Lands on or selects the fulfillment representative account alias. |
| `admin-qa-viewer` | `viewer` account role | `/access/sign-in` | Read-only account-scoped navigation and denied writes. | Lands on or selects the viewer representative account alias. |
| `admin-qa-security-manage` | `security.manage` only | `/access/sign-in` | Access and Platform section entry without unrelated section shortcuts. | No account selector unless the permission grant is intentionally account-scoped. |
| `admin-qa-memberships-view` | `memberships.view` only | `/access/sign-in` | Access membership route visibility and denied writes. | Selects the memberships fixture account alias when prompted. |
| `admin-qa-postage-policies-view` | `postage-policies.view` only | `/access/sign-in` | Commerce postage-policy read-only route visibility. | No account selector unless the permission grant is intentionally account-scoped. |
| `admin-qa-public-presence-view` | `public-presence.view` only | `/access/sign-in` | Growth waitlist and promo-bar read-only route visibility. | No account selector unless the permission grant is intentionally account-scoped. |
| `admin-qa-platform-feedback-view` | `platform-feedback.view` only | `/access/sign-in` | Support platform-feedback read-only route visibility. | No account selector unless the permission grant is intentionally account-scoped. |
| `admin-qa-catalog-admin` | Catalog admin permission set | `/catalog/sign-in` | Catalog modeling and integrations workbench QA. | Catalog routes must not require the Access sign-in host. |

The partial-actor rows mirror the local evidence rows in [Admin Shell Smoke Matrix](./admin-shell-smoke-matrix.md). Those local tests are regression guardrails only; #65 still needs deployed browser confirmation for the staging actor aliases above.

The five single-permission rows (`admin-qa-security-manage`, `admin-qa-memberships-view`, `admin-qa-postage-policies-view`, `admin-qa-public-presence-view`, `admin-qa-platform-feedback-view`) stay local-only: Identity grants whole roles (`platform-admin`, `owner`, `manager`, `fulfillment`, `viewer`), not scoped single-permission memberships, so there is no way to provision a real staging identity that holds exactly one permission. They remain proven by [Admin Shell Smoke Matrix](./admin-shell-smoke-matrix.md) partial-actor rows until a scoped permission grant primitive exists in Identity. Do not fabricate deployed evidence for these five rows; record them as `controlled-unavailable` with a reference to this limitation.

## Fixture Provisioning

The six remaining actor matrix rows (every row except the five single-permission rows above) map to real, grantable roles and are provisioned by an idempotent, staging-only operator action, following the same explicit-action pattern as [Staging Representative Commerce State](./staging-representative-commerce-state.md):

```bash
ADMIN_QA_ACTOR_FIXTURES_CONFIRM="provision admin qa fixtures" \
pnpm --filter @chase-sets/app-platform-api run admin-qa-actor-fixtures:production
```

For local or non-standard non-production environments, set `ADMIN_QA_ACTOR_FIXTURES_ALLOW_LOCAL=true` with the same confirmation phrase. The command refuses to run when `DEPLOYMENT_ENVIRONMENT=production`.

The preferred staging operation is the `Platform Staging Admin QA Actor Fixtures` GitHub Actions workflow (`.github/workflows/platform-staging-admin-qa-actor-fixtures.yml`). It is manually dispatched with the confirmation phrase, reads staging database URLs from Terraform state, and runs the fixture command against current staging. Run it after every `Platform Staging Reset` (#3350), since that reset destroys the admin-qa actor fixtures along with everything else.

Each fixture is magic-link only (no password to leak), stable across reruns, and skipped when it already exists, so reruns after a reset are cheap and reruns mid-cycle are no-ops. `admin-qa-platform-admin` is a dedicated QA identity distinct from the real `PLATFORM_ADMIN_EMAIL` bootstrap operator identity, granted through platform-bootstrap authority the same way normal deployment bootstrap grants it. The command's evidence output lists only `actorAlias`, `roleKey`, `signInHost`, and per-fixture `createdAccount`/`createdUser`/`createdMembership`/`createdConsent` booleans; it never prints emails, account ids, user ids, membership ids, or credentials. Use `ADMIN_QA_ACTOR_FIXTURES_EVIDENCE_OUT` to write that evidence to a file for the workflow artifact.

Signing in as a provisioned alias still requires the private magic-link credential from operator tooling; this command only ensures the identity, role grant, and sign-in host exist. It does not replace the deployed browser evidence collection described below.

## Evidence Rules

Each GitHub issue comment should use this shape:

```text
Environment: staging admin-web
Actor alias: admin-qa-...
Sign-in host: /access/sign-in or /catalog/sign-in
Route or workflow: ...
Expected: ...
Observed: ...
Evidence artifact: <artifact folder or GitHub Actions run/artifact link>
Redaction review: passed / controlled-unavailable
Follow-up issue: #... or none
```

Evidence is support-safe only when it excludes:

- Emails, passwords, passkeys, one-time codes, session cookies, CSRF tokens, and raw authorization headers.
- User ids, account ids, membership ids, invitation tokens, API keys, provider account ids, provider tokens, provider raw payloads, and webhook signatures.
- Raw `afterWrite`, `postWriteToken`, event ids, checkout session ids, payment ids, payout ids, order ids, sale ids, inventory ids, listing ids, and offer ids.
- Full URLs when they contain ids or recovery tokens. Prefer route templates such as `/commerce/postage-policies/:policyId`.
- Screenshots that show private customer, seller, provider, or account identity details.

If an artifact accidentally contains private material, do not attach it to GitHub. Replace it with a redacted screenshot, a support-safe transcript, or a new run.

Before posting public GitHub evidence for the cross-cutting API, SSE, security, PII, responsive, or state rows, lint the proposed Markdown or JSON transcript:

```bash
pnpm run ops admin-workflows:qa-evidence -- --evidence-file artifacts/admin-qa/issue-3027.md --out artifacts/admin-qa/issue-3027-redaction.json
```

The linter fails closed for emails, cookies, authorization/session tokens, raw recovery tokens, domain ids, and full URLs. Its report includes categories, file names, line numbers, and counts only; it never repeats the matched private values.

For final #3027 cross-cutting closure evidence, run the stricter completeness gate:

```bash
pnpm run ops admin-workflows:qa-evidence -- --require-cross-cutting-coverage --evidence-file artifacts/admin-qa/issue-3027.md --out artifacts/admin-qa/issue-3027-redaction.json
```

That mode still applies the redaction scan, and also requires the public packet to include these support-safe labels: `Environment`, `Actor alias`, `Sign-in host`, `Route or workflow`, `Expected`, `Observed`, `Evidence artifact`, `Redaction review`, `Security/PII review`, `Responsive coverage`, and `State coverage`. Use route templates, actor aliases, viewport names, and artifact folder names; do not paste full URLs, raw ids, tokens, or customer/provider details into those fields.

The strict gate also accepts structured JSON evidence from smoke or E2E metadata. The JSON can place fields at the top level or inside nested `records`, `results`, `rows`, `checks`, `evidence`, or `artifacts` arrays/objects. Use these support-safe keys when automation produces the packet: `environment`, `actorAlias`, `signInHost`, `routeTemplate` or `routeOrWorkflow`, `expectedBehavior`, `observedBehavior`, `artifactFolder` or `evidenceArtifact`, `redactionReview`, `securityPiiReview`, `viewports` or `responsiveCoverage`, and `stateChecks` or `stateCoverage`.

### #3027 automated cross-cutting coverage

The following #3027 checklist rows have automated coverage today; cite the linked files/commands as the `Evidence artifact` for those rows instead of collecting new deployed-browser proof:

- **API topology and SSE**: every admin-shell API dependency row and every stream probe (account realtime, catalog integration-job, catalog bulk-job, catalog bulk-authoring-job, platform projection-operation) is enumerated in [Admin Shell Smoke Matrix](./admin-shell-smoke-matrix.md) and exercised by `pnpm run smoke:platform` plus the deployed Playwright probes in `deployables/admin-web/e2e/admin-cross-cutting-topology.spec.ts`, `catalog-integrations.spec.ts`, `catalog-modeling.spec.ts`, and `platform-projection-operations.spec.ts`. All probes assert a controlled `text/event-stream` open or a controlled JSON auth/not-found response and reject host-level HTML fallback.
- **Security/PII — shared error surface**: the root admin shell `ErrorBoundary` (`deployables/admin-web/app/root.tsx`) routes every thrown loader/action message through `redactAdminErrorDetail` (`deployables/admin-web/app/error-detail-redaction.ts`) before it ever reaches the DOM. This mirrors the redaction categories this evidence linter enforces (email, cookie/session, authorization/bearer/JWT tokens, raw `afterWrite`/read-after-write recovery tokens, raw domain ids, full URLs) so a stray raw id or token in a thrown error message can never leak to a signed-in admin operator. Regression coverage: `deployables/admin-web/app/error-detail-redaction.test.ts` and the redaction case in `deployables/admin-web/app/root.test.tsx`.
- **Responsive/mobile + error state**: `deployables/admin-web/e2e/admin-cross-cutting-topology.spec.ts` (`admin cross-cutting error state` describe block) exercises an unknown admin route at desktop and mobile (390x844) viewports against deployed staging, asserting the shared not-found shell renders (never a host-level static 404/HTML page) and that no raw stack trace reaches the DOM; a companion test asserts the authenticated mobile shell has no horizontal overflow on the admin landing route. `deployables/admin-web/e2e/auth-shell-rbac.spec.ts` already covers mobile shell navigation, the account menu, and sign-out at the same viewport.

What remains genuinely staging-only and is **not** faked here: per-section empty/loading-state screenshots (each section's list/detail empty and loading states are that section's own QA lane's evidence, e.g. #3020/#3021/#3022), and the manual deployed-browser sign-off sweep across every checklist row with a support-safe evidence packet. Everything above is automated regression/smoke coverage an operator can cite directly instead of re-proving by hand.

For final #3016 actor-fixture evidence, run the actor matrix gate:

```bash
pnpm run ops admin-workflows:qa-evidence -- --require-actor-matrix-coverage --evidence-file artifacts/admin-qa/issue-3016.md --out artifacts/admin-qa/issue-3016-redaction.json
```

That mode still applies the redaction scan, and also requires every Actor Matrix alias above to appear with its intended `Sign-in host`. Structured JSON packets can provide the same evidence with `actorAlias` and `signInHost` keys at the top level or inside nested `records`, `results`, `rows`, `checks`, `evidence`, or `artifacts` arrays/objects.

For final #3020 Access section evidence, run the Access gate:

```bash
pnpm run ops admin-workflows:qa-evidence -- --require-access-coverage --evidence-file artifacts/admin-qa/issue-3020.md --out artifacts/admin-qa/issue-3020-redaction.json
```

That mode still applies the redaction scan, and also requires the public packet to list every required coverage key with the `Access coverage:` label. Structured JSON packets can provide the same keys with `accessCoverage`, `accessChecklistCoverage`, `coverage`, `coverageKey`, or `check` fields at the top level or inside nested evidence rows.

Use these coverage keys for #3020:

```text
Access coverage: access:accounts-suspend
Access coverage: access:accounts-reactivate
Access coverage: access:accounts-close-terminal
Access coverage: access:accounts-badge-founding-add-remove
Access coverage: access:accounts-badge-trusted-seller-add-remove
Access coverage: access:accounts-badge-manual-payout-review-add-remove
Access coverage: access:users-profile-edit
Access coverage: access:users-suspend
Access coverage: access:users-reactivate
Access coverage: access:memberships-role-owner
Access coverage: access:memberships-role-manager
Access coverage: access:memberships-role-fulfillment
Access coverage: access:memberships-role-viewer
Access coverage: access:memberships-revoke
Access coverage: access:memberships-reinstate
Access coverage: access:memberships-account-scoped-filtering
Access coverage: access:invitations-create
Access coverage: access:invitations-resend
Access coverage: access:invitations-cancel
Access coverage: access:invitations-decline
Access coverage: access:invitations-expire
Access coverage: access:api-keys-create
Access coverage: access:api-keys-rotate
Access coverage: access:api-keys-revoke
Access coverage: access:sessions-switch-active-account
Access coverage: access:sessions-revoke
Access coverage: access:pagination-over-50-accounts
Access coverage: access:pagination-over-50-users
Access coverage: access:pagination-over-50-memberships
Access coverage: access:pagination-over-50-invitations
Access coverage: access:pagination-over-50-api-keys
Access coverage: access:pagination-over-50-sessions
Access coverage: access:actor-security-manage
Access coverage: access:actor-memberships-view
Access coverage: access:least-privilege-denied-writes
```

The #3020 public packet may name only actor aliases, route templates, fixture aliases, expected vs observed behavior, and artifact folders. Keep concrete account ids, user ids, membership ids, invitation tokens, API key ids/secrets, session ids, emails, cookies, and raw recovery tokens out of GitHub.

To start the #3020 packet instead of hand-typing every coverage key, generate a fill-in-the-blanks scaffold:

```bash
pnpm run ops admin-workflows:qa-evidence -- --scaffold-access --out artifacts/admin-qa/issue-3020.md
```

The scaffold pre-fills one evidence block per required coverage key with a suggested least-privilege-appropriate actor alias, the `/access/sign-in` host, and the `Access coverage:` label the gate scans for. Replace every `<TODO: ...>` placeholder — `Route or workflow`, `Observed`, and `Redaction review` — with real deployed staging QA results before running the strict gate above. `access:accounts-suspend`, `access:accounts-reactivate`, `access:accounts-close-terminal`, badge add/remove, user and membership lifecycle, invitation lifecycle, API key lifecycle, and pagination rows default to `admin-qa-platform-admin`; `access:memberships-account-scoped-filtering` defaults to `admin-qa-manager`; `access:actor-security-manage` and `access:actor-memberships-view` default to their matching single-permission actor alias; `access:least-privilege-denied-writes` defaults to `admin-qa-viewer`. Swap any row's actor alias if a different least-privilege actor proves the behavior more precisely.

Per the single-permission limitation in [Fixture Provisioning](#fixture-provisioning), the `access:actor-security-manage` and `access:actor-memberships-view` rows cannot get deployed browser evidence today — record their `Observed` as `controlled-unavailable` with a reference to that limitation instead of fabricating a staging sign-in.

Note: API key create and rotate are no longer known-broken (the route-handler gap tracked as #3002 is resolved), so `access:api-keys-create` and `access:api-keys-rotate` can be confirmed directly against staging without the earlier caveat.

For final #3022 catalog integrations/source-observation evidence, run the catalog integrations gate:

```bash
pnpm run ops admin-workflows:qa-evidence -- --require-catalog-integrations-coverage --evidence-file artifacts/admin-qa/issue-3022.md --out artifacts/admin-qa/issue-3022-redaction.json
```

That mode still applies the redaction scan, and also requires the public packet to list every required coverage key with the `Catalog integrations coverage:` label. Structured JSON packets can provide the same keys with `catalogIntegrationsCoverage`, `catalogIntegrationCoverage`, `sourceObservationCoverage`, `coverage`, `coverageKey`, or `check` fields at the top level or inside nested evidence rows.

Use these coverage keys for #3022:

```text
Catalog integrations coverage: catalog-integrations:provider-tcgplayer-import
Catalog integrations coverage: catalog-integrations:provider-scrydex-import
Catalog integrations coverage: catalog-integrations:provider-tcgdex-import
Catalog integrations coverage: catalog-integrations:live-sse-job-progress
Catalog integrations coverage: catalog-integrations:review-observations
Catalog integrations coverage: catalog-integrations:single-promote
Catalog integrations coverage: catalog-integrations:bulk-promote
Catalog integrations coverage: catalog-integrations:bulk-reject
Catalog integrations coverage: catalog-integrations:bulk-defer
Catalog integrations coverage: catalog-integrations:stale-preview-reconfirm
Catalog integrations coverage: catalog-integrations:job-retry
Catalog integrations coverage: catalog-integrations:job-resume
Catalog integrations coverage: catalog-integrations:job-cancel
Catalog integrations coverage: catalog-integrations:job-reapply
Catalog integrations coverage: catalog-integrations:job-replay
Catalog integrations coverage: catalog-integrations:alias-accept
Catalog integrations coverage: catalog-integrations:alias-reject
Catalog integrations coverage: catalog-integrations:alias-revoke
Catalog integrations coverage: catalog-integrations:provider-profile-clone
Catalog integrations coverage: catalog-integrations:provider-profile-edit-section
Catalog integrations coverage: catalog-integrations:provider-profile-dry-run
Catalog integrations coverage: catalog-integrations:provider-profile-activate
Catalog integrations coverage: catalog-integrations:provider-profile-rollback
Catalog integrations coverage: catalog-integrations:provider-profile-deprecate
Catalog integrations coverage: catalog-integrations:provider-profile-retire
Catalog integrations coverage: catalog-integrations:readiness-blockers
Catalog integrations coverage: catalog-integrations:activation-blockers
Catalog integrations coverage: catalog-integrations:governance-conflict-review
Catalog integrations coverage: catalog-integrations:governance-lifecycle-impact-preview
Catalog integrations coverage: catalog-integrations:governance-kill-switch-403
Catalog integrations coverage: catalog-integrations:magic-imports-disabled
Catalog integrations coverage: catalog-integrations:health-semantic
Catalog integrations coverage: catalog-integrations:health-transport
Catalog integrations coverage: catalog-integrations:health-freshness
Catalog integrations coverage: catalog-integrations:health-audit-timeline
Catalog integrations coverage: catalog-integrations:sse-integration-job-stream
Catalog integrations coverage: catalog-integrations:sse-bulk-job-stream
Catalog integrations coverage: catalog-integrations:sse-reconnect
Catalog integrations coverage: catalog-integrations:sync-required-snapshot-fallback
Catalog integrations coverage: catalog-integrations:actor-catalog-admin
Catalog integrations coverage: catalog-integrations:control-plane-permissions
```

The #3022 public packet may name only route templates, actor aliases, provider/unit/profile aliases, expected vs observed behavior, and artifact folders. Keep provider raw payloads, provider account or data-source ids, job ids, observation ids, profile version ids when private, event ids, full URLs, tokens, credentials, and private seller/account data out of GitHub.

For final #3021 catalog modeling evidence, run the catalog modeling gate:

```bash
pnpm run ops admin-workflows:qa-evidence -- --require-catalog-modeling-coverage --evidence-file artifacts/admin-qa/issue-3021.md --out artifacts/admin-qa/issue-3021-redaction.json
```

That mode still applies the redaction scan, and also requires the public packet to list every required coverage key with the `Catalog modeling coverage:` label. Structured JSON packets can provide the same keys with `catalogModelingCoverage`, `modelingCoverage`, `checklistCoverage`, `coverage`, `coverageKey`, or `check` fields at the top level or inside nested evidence rows.

Use these coverage keys for #3021:

```text
Catalog modeling coverage: primitive:dimensions
Catalog modeling coverage: primitive:fields
Catalog modeling coverage: primitive:components
Catalog modeling coverage: primitive:blueprints
Catalog modeling coverage: primitive:categories
Catalog modeling coverage: primitive:catalog-items
Catalog modeling coverage: primitive:display-templates
Catalog modeling coverage: primitive:reference-types
Catalog modeling coverage: primitive:reference-records
Catalog modeling coverage: lifecycle:create-draft
Catalog modeling coverage: lifecycle:edit-structure
Catalog modeling coverage: lifecycle:publish-or-activate
Catalog modeling coverage: lifecycle:deprecate
Catalog modeling coverage: lifecycle:archive
Catalog modeling coverage: lifecycle:structure-lock
Catalog modeling coverage: lifecycle:archive-terminal
Catalog modeling coverage: dimension-options:add
Catalog modeling coverage: dimension-options:revise
Catalog modeling coverage: dimension-options:reorder
Catalog modeling coverage: dimension-options:deprecate
Catalog modeling coverage: dimension-options:reactivate
Catalog modeling coverage: rules:draft-only-attach-detach
Catalog modeling coverage: catalog-item:field-values
Catalog modeling coverage: catalog-item:image-fallback
Catalog modeling coverage: catalog-item:external-references
Catalog modeling coverage: catalog-item:delete-draft
Catalog modeling coverage: bulk-authoring:bulk-lifecycle-preview
Catalog modeling coverage: bulk-authoring:bulk-lifecycle-confirm
Catalog modeling coverage: bulk-authoring:bulk-lifecycle-counts
Catalog modeling coverage: bulk-authoring:bulk-lifecycle-projection-refresh
Catalog modeling coverage: bulk-authoring:bulk-edit-preview
Catalog modeling coverage: bulk-authoring:bulk-edit-confirm
Catalog modeling coverage: bulk-authoring:bulk-edit-counts
Catalog modeling coverage: bulk-authoring:bulk-edit-projection-refresh
Catalog modeling coverage: bulk-authoring:bulk-publish-preview
Catalog modeling coverage: bulk-authoring:bulk-publish-confirm
Catalog modeling coverage: bulk-authoring:bulk-publish-counts
Catalog modeling coverage: bulk-authoring:bulk-publish-projection-refresh
Catalog modeling coverage: realtime:sse-list-detail
Catalog modeling coverage: realtime:pending-change-reload-bar
Catalog modeling coverage: seed-tripwire:catalog-admin
```

For final #3026 Platform projection-operations evidence, run the projection operations gate:

```bash
pnpm run ops admin-workflows:qa-evidence -- --require-projection-operations-coverage --evidence-file artifacts/admin-qa/issue-3026.md --out artifacts/admin-qa/issue-3026-redaction.json
```

That mode still applies the redaction scan, and also requires the public packet to list every required coverage key with the `Projection operations coverage:` label. Structured JSON packets can provide the same keys with `projectionOperationsCoverage`, `projectionOpsCoverage`, `platformProjectionCoverage`, `coverage`, `coverageKey`, or `check` fields at the top level or inside nested evidence rows.

Use these coverage keys for #3026:

```text
Projection operations coverage: projection-ops:status-stats
Projection operations coverage: projection-ops:tab-overview
Projection operations coverage: projection-ops:tab-attention
Projection operations coverage: projection-ops:tab-operations
Projection operations coverage: projection-ops:tab-projection-groups
Projection operations coverage: projection-ops:tab-subscriptions
Projection operations coverage: projection-ops:tab-blocked-streams
Projection operations coverage: projection-ops:tab-workers
Projection operations coverage: projection-ops:tab-wake-pipeline
Projection operations coverage: projection-ops:tab-diagnostics
Projection operations coverage: projection-ops:refresh-status
Projection operations coverage: projection-ops:retry-blocked-stream
Projection operations coverage: projection-ops:cancel-operation
Projection operations coverage: projection-ops:rebuild-projection-group-disposable
Projection operations coverage: projection-ops:rebuild-context-disposable
Projection operations coverage: projection-ops:completion
Projection operations coverage: projection-ops:attention-clearance
Projection operations coverage: projection-ops:no-data-loss
Projection operations coverage: projection-ops:actor-attribution-or-3011
Projection operations coverage: projection-ops:wake-pipeline-unavailable-controlled
Projection operations coverage: projection-ops:runbook-cross-reference
Projection operations coverage: projection-ops:disposable-projection-recorded
```

The #3026 public packet may name only a support-safe disposable projection alias and the artifact folder. Keep concrete projection ids, operation ids, stream ids, event ids, database rows, recovery tokens, and operator identity details out of GitHub.

## Representative State Checks

Before section QA starts, confirm state exists for these visible workflows:

| Section | Required representative state | Missing-state action |
| --- | --- | --- |
| Access | Users, memberships, invitations, API keys, and sessions visible for the actor aliases. | File a narrow #65 setup issue with the alias and route template. |
| Catalog | Catalog modeling data plus a safe provider/import workbench fixture. | File a catalog setup issue; do not use direct provider URLs as substitute evidence. |
| Commerce | Fee schedules, agreements, and postage policies available for read/write and read-only actor checks. | File a commerce setup issue, or refresh staging data if the row is controlled-empty. |
| Growth | Google Shopping, waitlist, and promo-bar state available without production provider side effects. | File a growth setup issue; production Merchant Center actions remain gated by launch approval. |
| Support | Support requests and platform feedback records available for review/archive flows. | File a support setup issue or create feedback through the public product UI when the workflow requires fresh state. |
| Platform | Projection operations and durable job streams visible without destructive production impact. | File a platform setup issue and keep destructive operations controlled-unavailable until approved. |

For commerce marketplace data, prefer the [Staging Representative Commerce State](./staging-representative-commerce-state.md) workflow and copy only its support-safe selector fields into evidence.

## Verification Sequence

1. Run the [Fixture Provisioning](#fixture-provisioning) command or workflow so the six real-role actor aliases exist (skip if already provisioned and no staging reset has run since).
2. Confirm every actor alias has private credentials or a private credential owner.
3. Sign in through the intended host for each alias.
4. Capture the landing route, section navigation, account-select behavior, and denied-write behavior where applicable.
5. Run each section checklist issue with the least-privilege actor that proves the behavior.
6. File a narrower bug under milestone #65 for any unexpected route error, permission leak, stale state, or missing fixture.
7. Close #3016 only after all six provisionable actor aliases have deployed staging evidence, the five single-permission rows are recorded `controlled-unavailable` per the note above, and representative state gaps are either resolved or tracked in narrower milestone issues.
