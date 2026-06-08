# Admin Shell Smoke Matrix

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
| SMOKE-SHELL-ACCESS | Access | `/access` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no Verified chip. |
| SMOKE-SHELL-CATALOG | Catalog | `/catalog` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no Verified chip. |
| SMOKE-SHELL-COMMERCE | Commerce | `/commerce` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no Verified chip. |
| SMOKE-SHELL-GROWTH | Growth | `/growth` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no Verified chip. |
| SMOKE-SHELL-SUPPORT | Support | `/support` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no Verified chip. |
| SMOKE-SHELL-PLATFORM | Platform | `/platform` | all-admin-permissions | Shared top app bar, account/sign-out access, local navigation, no Verified chip. |

## Partial-Actor Rows

| ID | Permission | Entry Paths | Expected Sections | Required Evidence |
| --- | --- | --- | --- | --- |
| AS-ACTOR-SECURITY-MANAGE | `security.manage` | `/access`, `/platform` | Access, Platform | Direct route entry, section root resolution, and no misleading cross-section links. |
| AS-ACTOR-MEMBERSHIPS-VIEW | `memberships.view` | `/access`, `/access/memberships` | Access | Direct route entry and section root resolution. |
| AS-ACTOR-PUBLIC-PRESENCE-VIEW | `public-presence.view` | `/growth`, `/growth/waitlist` | Growth | Direct route entry, section root resolution, and no unauthorized Platform/Access/Catalog shortcuts. |
| AS-ACTOR-POSTAGE-POLICIES-VIEW | `postage-policies.view` | `/commerce`, `/commerce/postage-policies` | Commerce | Direct route entry and section root resolution. |
| AS-ACTOR-PLATFORM-FEEDBACK-VIEW | `platform-feedback.view` | `/support`, `/support/platform-feedback` | Support | Direct route entry and section root resolution. |

## Link Rows

| ID | Route | Actor | Required Evidence |
| --- | --- | --- | --- |
| SMOKE-LINK-PROMO-BAR-PUBLIC-HREF | `/growth/promo-bar` | `public-presence.view` | Content-managed public relative hrefs resolve to the marketplace origin or render inert when no marketplace origin is configured. |
| SMOKE-LINK-CROSS-SECTION-PERMISSION-AWARE | `/growth/google-shopping`, `/platform/projections` | least-privilege section actor | Same-host cross-section shortcuts render only when the actor has the target route permission. |

## API And Topology Rows

| ID | Dependency ID | Path | Caller | Required Evidence |
| --- | --- | --- | --- | --- |
| SMOKE-API-AUTH-ACCESS-SESSIONS | API-AUTH-ACCESS-SESSIONS | `/api/auth` | server-loader/action | Access session loaders/actions reach Auth through admin-support API route or internal origin; no host-level fallback. |
| SMOKE-API-IDENTITY-ACCESS-ADMIN | API-IDENTITY-ACCESS-ADMIN | `/api/identity` | server-loader/action | Access identity loaders/actions reach Identity through admin-support API route or internal origin; no host-level fallback. |
| SMOKE-API-CATALOG-ADMIN-SERVER | API-CATALOG-ADMIN-SERVER | `/api/catalog` | server-loader/action | Catalog admin loaders/actions return authenticated API data or controlled-unavailable evidence. |
| SMOKE-API-COMMERCIAL-TERMS-ADMIN-SERVER | API-COMMERCIAL-TERMS-ADMIN-SERVER | `/api/commercial-terms` | server-loader/action | Commercial Terms schedules/agreements verify through authenticated admin page/loader evidence and internal-origin routing. |
| SMOKE-API-MARKETPLACE-POSTAGE-POLICIES | API-MARKETPLACE-POSTAGE-POLICIES | `/api/marketplace/admin/postage-policies` | server-loader/action | Commerce Postage Policies loaders/actions reach Ordering through the approved internal-origin topology. |
| SMOKE-API-MARKETPLACE-GOOGLE-SHOPPING | API-MARKETPLACE-GOOGLE-SHOPPING | `/api/marketplace/google-shopping` | server-loader/action | Growth Google Shopping loaders/actions reach Discovery through the approved internal-origin topology. |
| SMOKE-API-PUBLIC-PRESENCE-ADMIN-SERVER | API-PUBLIC-PRESENCE-ADMIN-SERVER | `/api/public-presence` | server-loader/action | Growth Waitlist and Promo Bar server loaders/actions return authenticated API data or controlled-unavailable evidence. |
| SMOKE-API-MARKETPLACE-SUPPORT-REQUESTS | API-MARKETPLACE-SUPPORT-REQUESTS | `/api/marketplace/support-requests/ops` | server-loader/action | Support request operations loaders/actions reach Support through the approved internal-origin topology. |
| SMOKE-API-EXPERIENCE-PLATFORM-FEEDBACK | API-EXPERIENCE-PLATFORM-FEEDBACK | `/api/experience` | server-loader/action | Platform Feedback loaders/actions reach Experience through admin-support API route or internal origin. |
| SMOKE-API-PLATFORM-PROJECTIONS | API-PLATFORM-PROJECTIONS | `/api/platform/projections` | server-loader/action | Authenticated API/data evidence or controlled-unavailable state; must fail if routed to the wrong deployed component. |
| SMOKE-API-PLATFORM-RELEASE-CONTROLS | API-PLATFORM-RELEASE-CONTROLS | `/api/platform/release-controls` | server-loader/action | Authenticated API/data evidence or controlled-unavailable state; must use approved internal-origin/topology contract. |
| SMOKE-API-WAITLIST-EXPORT | API-PUBLIC-PRESENCE-WAITLIST-EXPORT | `/api/public-presence/admin/waitlist/export` | direct-download | Direct navigation/download returns CSV or a controlled authorization response from the intended component. |
| SMOKE-API-CATALOG-REALTIME | API-CATALOG-REALTIME-ACCOUNT-EVENTS | `/api/realtime/account/events` | EventSource | SSE opens or returns a controlled authorization response; no host-level 404 or HTML fallback. |
| SMOKE-API-CATALOG-INTEGRATION-JOB-STREAM | API-CATALOG-SOURCE-OBS-INTEGRATION-JOB-EVENTS | `/api/catalog/source-observations/integration-jobs/:jobId/events` | durable-job EventSource | SSE opens or returns controlled authorization/not-found response; no host-level 404 or HTML fallback. |
| SMOKE-API-CATALOG-BULK-JOB-STREAM | API-CATALOG-SOURCE-OBS-BULK-JOB-EVENTS | `/api/catalog/source-observations/bulk-jobs/:jobId/events` | durable-job EventSource | SSE opens or returns controlled authorization/not-found response; no host-level 404 or HTML fallback. |
| SMOKE-API-CATALOG-AUTHORING-JOB-STREAM | API-CATALOG-AUTHORING-BULK-JOB-EVENTS | `/api/catalog/bulk-authoring-jobs/:jobId/events` | durable-job EventSource | SSE opens or returns controlled authorization/not-found response; no host-level 404 or HTML fallback. |

## Topology Modes

| Mode | Closure Expectation |
| --- | --- |
| staging | Deployed browser/API evidence should run for admin shell, actor, link, and API rows that have prepared fixtures. |
| production-proof | Proof admin ingress or server-side internal-origin evidence must cover every API row required for production proof. |
| public-marketplace | Admin routes must keep marketplace/public links cross-host and API dependencies on approved ingress/internal-origin paths. |
| production-platform-disabled | Platform-api-owned admin surfaces must be hidden, controlled-unavailable, or proven to have a valid routing/internal-origin contract. |
