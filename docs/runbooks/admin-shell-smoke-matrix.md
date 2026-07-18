# Admin Shell Smoke Matrix

_Status: living admin-shell smoke gate — `scripts/admin-shell-smoke-matrix.mjs` feeds `pnpm run smoke:platform`, and `scripts/admin-shell-smoke-matrix.test.mjs` keeps this matrix in sync with the script. The Milestone #13 framing below records its origin; the gate itself is current._

Milestone #13 closes only when admin shell parity and admin API topology evidence are both recorded. This matrix joins #1023 deployed/browser smoke with #1025 source-aware API topology inventory so release evidence cannot drift from static guardrails.

Use the stable IDs below in PR #1028, #1020, #1023, #1025, and milestone comments. Each row must be marked as one of: automated pass, deployed pass, manual evidence, controlled-unavailable, explicit exception, or explicit deferral with a follow-up issue.

## Evidence Rules

- Record target environment and topology mode: staging, production-proof, public-marketplace, or production-platform-disabled.
- Record actor permissions for signed-in checks; use `all-admin-permissions` only when least-privilege behavior is not the subject of the row.
- Deployed browser evidence must include the target URL, observed status or page state, and artifact link or command output.
- Manual-only evidence must include exact URL, actor fixture, expected result, observed result, and artifact location.
- Local static guardrails can support closure, but they do not replace deployed/browser evidence unless the row is explicitly controlled-unavailable or excepted.
- Not-runnable rows must remain visible as controlled-unavailable, explicit exception, or explicit deferral.

## Section Shell Rows

| ID | Section | Route | Actor | Required Evidence |
| --- | --- | --- | --- | --- |
| SMOKE-SHELL-ACCESS | Access | `/access` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no retired SellerBadge Verified chip. |
| SMOKE-SHELL-CATALOG | Catalog | `/catalog` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no retired SellerBadge Verified chip. |
| SMOKE-SHELL-COMMERCE | Commerce | `/commerce` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no retired SellerBadge Verified chip. |
| SMOKE-SHELL-GROWTH | Growth | `/growth` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no retired SellerBadge Verified chip. |
| SMOKE-SHELL-SUPPORT | Support | `/support` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no retired SellerBadge Verified chip. |
| SMOKE-SHELL-PLATFORM | Platform | `/platform` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no retired SellerBadge Verified chip. |

## Deployed Page Rows

These rows are exercised by `pnpm run smoke:platform` when `PLATFORM_ADMIN_EMAIL` and `PLATFORM_ADMIN_PASSWORD` are configured. The smoke checks assert HTML, shared section navigation, account menu access, page-specific text, and absence of the retired admin-shell SellerBadge `Verified` chip. Other page data and ratified copy may legitimately contain `Verified`.

| ID | Route | Linked Coverage |
| --- | --- | --- |
| SMOKE-PAGE-ACCESS-USERS | `/access/users` | SMOKE-SHELL-ACCESS, SMOKE-API-IDENTITY-ACCESS-ADMIN |
| SMOKE-PAGE-ACCESS-SESSIONS | `/access/sessions` | SMOKE-SHELL-ACCESS, SMOKE-API-AUTH-ACCESS-SESSIONS |
| SMOKE-PAGE-CATALOG-ITEMS | `/catalog/catalog-items` | SMOKE-SHELL-CATALOG, SMOKE-API-CATALOG-ADMIN-SERVER |
| SMOKE-PAGE-COMMERCE-TERMS-SCHEDULES | `/commerce/terms/schedules` | SMOKE-SHELL-COMMERCE, SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER |
| SMOKE-PAGE-COMMERCE-TERMS-AGREEMENTS | `/commerce/terms/agreements` | SMOKE-SHELL-COMMERCE, SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER |
| SMOKE-PAGE-COMMERCE-POSTAGE-POLICIES | `/commerce/postage-policies` | SMOKE-SHELL-COMMERCE, SMOKE-API-MARKETPLACE-POSTAGE-POLICIES |
| SMOKE-PAGE-GROWTH-GOOGLE-SHOPPING | `/growth/google-shopping` | SMOKE-SHELL-GROWTH, SMOKE-API-MARKETPLACE-GOOGLE-SHOPPING |
| SMOKE-PAGE-GROWTH-WAITLIST | `/growth/waitlist` | SMOKE-SHELL-GROWTH, SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER |
| SMOKE-PAGE-GROWTH-PROMO-BAR | `/growth/promo-bar` | SMOKE-SHELL-GROWTH, SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER |
| SMOKE-PAGE-SUPPORT-REQUESTS | `/support/requests` | SMOKE-SHELL-SUPPORT, SMOKE-API-MARKETPLACE-SUPPORT-REQUESTS |
| SMOKE-PAGE-SUPPORT-PLATFORM-FEEDBACK | `/support/platform-feedback` | SMOKE-SHELL-SUPPORT, SMOKE-API-EXPERIENCE-PLATFORM-FEEDBACK |
| SMOKE-PAGE-PLATFORM-PROJECTIONS | `/platform/projections` | SMOKE-SHELL-PLATFORM, SMOKE-API-PLATFORM-PROJECTIONS |

## Partial-Actor Rows

| ID | Permission | Entry Paths | Expected Sections | Required Evidence |
| --- | --- | --- | --- | --- |
| AS-ACTOR-SECURITY-MANAGE | `security.manage` | `/access` | Access | Direct route entry, section root resolution, and no misleading cross-section links. |
| AS-ACTOR-PROJECTION-OPERATIONS-VIEW | `projection-operations.view` | `/platform`, `/platform/projections` | Platform | Direct route entry, section root resolution, and no misleading cross-section links. |
| AS-ACTOR-MEMBERSHIPS-VIEW | `memberships.view` | `/access`, `/access/memberships` | Access | Direct route entry and section root resolution. |
| AS-ACTOR-PUBLIC-PRESENCE-VIEW | `public-presence.view` | `/growth`, `/growth/waitlist` | Growth | Direct route entry, section root resolution, and no unauthorized Platform/Access/Catalog shortcuts. |
| AS-ACTOR-POSTAGE-POLICIES-VIEW | `postage-policies.view` | `/commerce`, `/commerce/postage-policies` | Commerce | Direct route entry and section root resolution. |
| AS-ACTOR-PLATFORM-FEEDBACK-VIEW | `platform-feedback.view` | `/support`, `/support/platform-feedback` | Support | Direct route entry and section root resolution. |

## Partial-Actor Local Evidence Rows

These rows are exercised by `pnpm --filter @chase-sets/app-admin-web run test -- admin-section-loader.server host`. They do not replace deployed/browser evidence for final closure, but they are the stable local regression evidence for route-specific signed-out fallback permissions, section-root redirects, and shared-permission visibility.

| ID | Actor Row | Evidence Files |
| --- | --- | --- |
| EVIDENCE-AS-ACTOR-SECURITY-MANAGE | AS-ACTOR-SECURITY-MANAGE | `deployables/admin-web/app/admin-section-loader.server.test.ts`, `deployables/admin-web/app/host.test.ts` |
| EVIDENCE-AS-ACTOR-PROJECTION-OPERATIONS-VIEW | AS-ACTOR-PROJECTION-OPERATIONS-VIEW | `deployables/admin-web/app/admin-section-loader.server.test.ts`, `deployables/admin-web/app/host.test.ts` |
| EVIDENCE-AS-ACTOR-MEMBERSHIPS-VIEW | AS-ACTOR-MEMBERSHIPS-VIEW | `deployables/admin-web/app/admin-section-loader.server.test.ts`, `deployables/admin-web/app/host.test.ts` |
| EVIDENCE-AS-ACTOR-PUBLIC-PRESENCE-VIEW | AS-ACTOR-PUBLIC-PRESENCE-VIEW | `deployables/admin-web/app/admin-section-loader.server.test.ts`, `deployables/admin-web/app/host.test.ts` |
| EVIDENCE-AS-ACTOR-POSTAGE-POLICIES-VIEW | AS-ACTOR-POSTAGE-POLICIES-VIEW | `deployables/admin-web/app/admin-section-loader.server.test.ts`, `deployables/admin-web/app/host.test.ts` |
| EVIDENCE-AS-ACTOR-PLATFORM-FEEDBACK-VIEW | AS-ACTOR-PLATFORM-FEEDBACK-VIEW | `deployables/admin-web/app/admin-section-loader.server.test.ts`, `deployables/admin-web/app/host.test.ts` |

## Link Rows

| ID | Route | Actor | Required Evidence |
| --- | --- | --- | --- |
| SMOKE-LINK-PROMO-BAR-PUBLIC-HREF | `/growth/promo-bar` | `public-presence.view` | Content-managed public relative hrefs resolve to the marketplace origin or render inert when no marketplace origin is configured. |
| SMOKE-LINK-CROSS-SECTION-PERMISSION-AWARE | `/growth/google-shopping`, `/platform/projections` | least-privilege section actor | Same-host cross-section shortcuts render only when the actor has the target route permission. |

## API And Topology Rows

| ID | Dependency ID | Path | Caller | Required Evidence |
| --- | --- | --- | --- | --- |
| SMOKE-API-AUTH-ACCESS-SESSIONS | API-AUTH-ACCESS-SESSIONS | `/api/auth` | server-loader/action | Access session loaders/actions reach Auth through platform-api landing route or internal origin; no host-level fallback. |
| SMOKE-API-IDENTITY-ACCESS-ADMIN | API-IDENTITY-ACCESS-ADMIN | `/api/identity` | server-loader/action | Access identity loaders/actions reach Identity through platform-api landing route or internal origin; no host-level fallback. |
| SMOKE-API-CATALOG-ADMIN-SERVER | API-CATALOG-ADMIN-SERVER | `/api/catalog` | server-loader/action | Catalog admin loaders/actions return authenticated API data or controlled-unavailable evidence. |
| SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER | API-COMMERCIAL-TERMS-ADMIN-SERVER | `/api/commercial-terms` | server-loader/action | Commercial Terms schedules/agreements verify through authenticated admin page/loader evidence and internal-origin routing. |
| SMOKE-API-MARKETPLACE-POSTAGE-POLICIES | API-MARKETPLACE-POSTAGE-POLICIES | `/api/marketplace/admin/postage-policies` | server-loader/action | Commerce Postage Policies loaders/actions reach Ordering through the approved internal-origin topology. |
| SMOKE-API-MARKETPLACE-GOOGLE-SHOPPING | API-MARKETPLACE-GOOGLE-SHOPPING | `/api/marketplace/google-shopping` | server-loader/action | Growth Google Shopping loaders/actions reach Discovery through the approved internal-origin topology. |
| SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER | API-PUBLIC-PRESENCE-ADMIN-SERVER | `/api/public-presence` | server-loader/action | Growth Waitlist and Promo Bar server loaders/actions return authenticated API data or controlled-unavailable evidence. |
| SMOKE-API-MARKETPLACE-SUPPORT-REQUESTS | API-MARKETPLACE-SUPPORT-REQUESTS | `/api/marketplace/support-requests/ops` | server-loader/action | Support request operations loaders/actions reach Support through the approved internal-origin topology. |
| SMOKE-API-EXPERIENCE-PLATFORM-FEEDBACK | API-EXPERIENCE-PLATFORM-FEEDBACK | `/api/experience` | server-loader/action | Platform Feedback loaders/actions reach Experience through platform-api landing route or internal origin. |
| SMOKE-API-PLATFORM-PROJECTIONS | API-PLATFORM-PROJECTIONS | `/api/platform/projections` | server-loader/action | Authenticated API/data evidence or controlled-unavailable state; must fail if routed to the wrong deployed component. |
| SMOKE-API-WAITLIST-EXPORT | API-PUBLIC-PRESENCE-WAITLIST-EXPORT | `/api/public-presence/admin/waitlist/export` | direct-download | Direct navigation/download returns CSV or a controlled authorization response from the intended component. |
| SMOKE-API-CATALOG-REALTIME | API-CATALOG-REALTIME-ACCOUNT-EVENTS | `/api/realtime/account/events` | EventSource | SSE opens or returns a controlled authorization response; no host-level 404 or HTML fallback. |
| SMOKE-API-CATALOG-INTEGRATION-JOB-STREAM | API-CATALOG-SOURCE-OBS-INTEGRATION-JOB-EVENTS | `/api/catalog/source-observations/integration-jobs/:jobId/events` | durable-job EventSource | SSE opens or returns controlled authorization/not-found response; no host-level 404 or HTML fallback. |
| SMOKE-API-CATALOG-BULK-JOB-STREAM | API-CATALOG-SOURCE-OBS-BULK-JOB-EVENTS | `/api/catalog/source-observations/bulk-jobs/:jobId/events` | durable-job EventSource | SSE opens or returns controlled authorization/not-found response; no host-level 404 or HTML fallback. |
| SMOKE-API-CATALOG-AUTHORING-JOB-STREAM | API-CATALOG-AUTHORING-BULK-JOB-EVENTS | `/api/catalog/bulk-authoring-jobs/:jobId/events` | durable-job EventSource | SSE opens or returns controlled authorization/not-found response; no host-level 404 or HTML fallback. |

## Deployed API Probe Rows

These rows are also exercised by `pnpm run smoke:platform` when admin credentials are configured. The probe can pass with an authorized result or a controlled authorization/not-found result, but must not return a host-level HTML/plain-text fallback.
Production smoke sets `SMOKE_ADMIN_TOPOLOGY`; when production runs with the marketplace platform disabled, probes for rows documented as controlled-unavailable/internal-origin only are skipped while deployed platform-api landing/public-ingress probes and `SMOKE-PROBE-PLATFORM-PROJECTIONS` still run.

| ID | Path | Linked Coverage |
| --- | --- | --- |
| SMOKE-PROBE-AUTH-SESSION | `/api/auth/session` | SMOKE-API-AUTH-ACCESS-SESSIONS |
| SMOKE-PROBE-IDENTITY-CURRENT-ACTOR | `/api/identity/current-actor-display` | SMOKE-API-IDENTITY-ACCESS-ADMIN |
| SMOKE-PROBE-CATALOG-PROVIDER-PROFILES | `/api/catalog/source-observations/provider-profiles` | SMOKE-API-CATALOG-ADMIN-SERVER |
| SMOKE-PROBE-COMMERCIAL-TERMS-SCHEDULES | `/api/commercial-terms/schedules?limit=1&offset=0` | SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER |
| SMOKE-PROBE-MARKETPLACE-POSTAGE-POLICIES | `/api/marketplace/admin/postage-policies?limit=1&offset=0` | SMOKE-API-MARKETPLACE-POSTAGE-POLICIES |
| SMOKE-PROBE-MARKETPLACE-GOOGLE-SHOPPING | `/api/marketplace/google-shopping/feed-rows?limit=1&offset=0` | SMOKE-API-MARKETPLACE-GOOGLE-SHOPPING |
| SMOKE-PROBE-PUBLIC-PRESENCE-WAITLIST | `/api/public-presence/admin/waitlist?limit=1&offset=0` | SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER |
| SMOKE-PROBE-MARKETPLACE-SUPPORT-REQUESTS | `/api/marketplace/support-requests/ops?limit=1&offset=0` | SMOKE-API-MARKETPLACE-SUPPORT-REQUESTS |
| SMOKE-PROBE-EXPERIENCE-PLATFORM-FEEDBACK | `/api/experience/platform-feedback?limit=1&offset=0` | SMOKE-API-EXPERIENCE-PLATFORM-FEEDBACK |
| SMOKE-PROBE-PLATFORM-PROJECTIONS | `/api/platform/projections` | SMOKE-API-PLATFORM-PROJECTIONS |
| SMOKE-PROBE-WAITLIST-EXPORT | `/api/public-presence/admin/waitlist/export` | SMOKE-API-WAITLIST-EXPORT |
| SMOKE-PROBE-CATALOG-REALTIME | `/api/realtime/account/events?topic=account%3Atopology-smoke%3Alistings` | SMOKE-API-CATALOG-REALTIME |
| SMOKE-PROBE-CATALOG-INTEGRATION-JOB-STREAM | `/api/catalog/source-observations/integration-jobs/topology-smoke/events` | SMOKE-API-CATALOG-INTEGRATION-JOB-STREAM |
| SMOKE-PROBE-CATALOG-BULK-JOB-STREAM | `/api/catalog/source-observations/bulk-jobs/topology-smoke/events` | SMOKE-API-CATALOG-BULK-JOB-STREAM |
| SMOKE-PROBE-CATALOG-AUTHORING-JOB-STREAM | `/api/catalog/bulk-authoring-jobs/topology-smoke/events` | SMOKE-API-CATALOG-AUTHORING-JOB-STREAM |

## Topology Modes

| Mode | Closure Expectation |
| --- | --- |
| staging | Deployed browser/API evidence should run for admin shell, actor, link, and API rows that have prepared fixtures. |
| production-proof | Proof admin ingress or server-side internal-origin evidence must cover every API row required for production proof. |
| public-marketplace | Admin routes must keep marketplace/public links cross-host and API dependencies on approved ingress/internal-origin paths. |
| production-platform-disabled | Platform-api-owned admin surfaces must be hidden, controlled-unavailable, or proven to have a valid routing/internal-origin contract. |
