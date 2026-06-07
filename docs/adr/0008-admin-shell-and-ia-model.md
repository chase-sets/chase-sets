# ADR 0008: Admin Shell And IA Model

## Status

Accepted

## Context

Admin web composes routes and navigation from bounded-context manifests, but its shell and route placement had drifted:

- `AdminShell` used the shared `TopNav` with no primary navigation items, while marketplace used `TopNav` for top-level app navigation.
- Catalog, Identity, and Experience layouts hand-authored cross-section links in page actions.
- Operations routes rendered outside the admin shell.
- Admin section placement was inferred from context names and file names; unmapped contexts fell back to Identity.
- Commercial Terms owns seller-side fee schedules, agreements, and deterministic fee resolutions, but its admin routes were mounted under Identity.
- Admin root redirected directly to Catalog Dimensions.
- Admin pages mixed canonical app-shell primitives with older `UiPage*` and `UiTable*` compatibility aliases.

The bounded-context map identifies Commercial Terms as the owner of seller-side marketplace sales fee policy and account-specific commercial agreements. Identity owns accounts, users, memberships, invitations, API keys, consents, and identity-management surfaces. That makes Commercial Terms an adjacent dependency on Identity account references, not an Identity sub-area.

## Decision

Admin web has five top-level sections:

- Catalog
- Identity
- Experience
- Operations
- Commercial Terms

The stable section key for Commercial Terms is `commercial`; the user-facing label is `Commercial Terms`.

Bounded-context manifests may explicitly declare admin section placement for route and shell contributions. Explicit placement wins over context-name and file-name fallback heuristics. Fallbacks remain only as migration compatibility and should be minimized as manifests are updated.

Commercial Terms routes move to the Commercial Terms section. Existing `/identity/commercial-terms/*` URLs remain compatibility redirects to canonical commercial routes.

Admin shell follows the marketplace navigation pattern:

- Top app bar carries top-level section navigation.
- Side navigation and bottom navigation carry section-local navigation.
- Account and session actions stay in the action area and are not mixed with section navigation.
- Mobile keeps a predictable section model and section-local overflow behavior.

Operations remains one top-level section. Platform Operations, Support, and Google Shopping are section-local Operations entries. Operations layout authorization allows an actor with at least one visible Operations capability to enter the shell; individual routes remain responsible for their own route and action authorization.

Admin root `/` becomes an actor-aware entry hub. It shows visible sections when more than one is available, redirects to the only visible section when exactly one exists, and shows an explicit no-access state when no admin section is visible.

Canonical admin page primitives are `Page`, `PageHeader`, `PageSection`, `DataTable`, `Surface`, and related app-shell primitives from the design system. `UiPage*` and `UiTable*` remain compatibility exports for non-admin or not-yet-migrated consumers only; admin usage should be migrated or explicitly exempted.

## Consequences

- Platform runtime must support explicit admin section metadata on route and shell contributions.
- Admin web needs shared section navigation resolution instead of hand-authored cross-section action buttons.
- Commercial Terms receives a first-class admin navigation and route placement while preserving old Identity-prefixed links through redirects.
- Operations users with narrower capabilities, such as Support operations permissions, can reach the Operations shell without requiring broad Identity admin permission.
- Tests must cover rendered admin route composition, not only registry records.
- Visual QA for admin shell work must cover desktop and mobile top navigation, section-local navigation, account/session actions, active states, overflow behavior, and representative empty/error/detail states.
