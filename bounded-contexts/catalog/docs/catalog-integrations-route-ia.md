# Catalog Integrations Route IA

This note is the route-level information architecture for the Catalog integrations control plane (#1739, milestone 29 "Catalog Integration Decongestion"). It replaces the single `?section=` mini-app with four real nested routes, one per audience surface, each composed from a shared workbench shell.

## Route map

| Route | Surface | Workspaces (in render order) | Loader entry point |
| --- | --- | --- | --- |
| `/admin/integrations` | daily | import-to-promotion | `support/route-support/admin-integrations/integrations-loader.ts` |
| `/admin/integrations/providers` | providers | profile-authoring, validation-readiness | `support/route-support/admin-integrations/providers-loader.ts` |
| `/admin/integrations/governance` | governance | conflict-resolution, lifecycle-recovery, governance-controls | `support/route-support/admin-integrations/governance-loader.ts` |
| `/admin/integrations/release` | release | clean-reset-release, audit-evidence, health-triage | `support/route-support/admin-integrations/release-loader.ts` |

The daily route is the default and renders only the primary import-to-promotion job. The other three routes render their grouped supporting workspaces stacked.

## Source of truth

- The surfaces, their path segments, and their workspaces are declared in `features/source-observations/ui/admin-control-plane/information-architecture.ts` as `CATALOG_CONTROL_PLANE_ROUTE_SURFACES`. Each workspace also carries a `routeSurface` field, and the IA↔render parity test (`information-architecture.test.ts`) asserts that every workspace belongs to exactly one surface and that every surface workspace is renderable.
- The routes are registered as thin composition roots in the catalog deployable contribution (`context.json`, `deployableContributions[].routes`) with route IDs `integrations`, `integrations-providers`, `integrations-governance`, `integrations-release`. The admin-web deployable resolves them through the established `resolveWebHostRouteConfigRecords` → `toRouteConfigEntry` framework (React Router v7), the same path each sibling catalog admin route uses.
- The route files (`routes/admin/integrations*.tsx`) are thin roots: they re-export the loader/action and render `CatalogIntegrationsSurfaceRouteView` with their surface key. The shared shell lives in `features/source-observations/ui/workbench-shell.tsx`; the surface body composition lives in `integrations-surface-page.tsx`; the render registry lives in `workbench-workspace-renderers.tsx`.

## Section state vs route path

The route path is the screen router. The `section` query param (and the `routeContext.section`) only identifies the precise workspace within a multi-workspace surface, which drives active-nav highlighting and detour telemetry. It is never the screen router and is never an alias for the legacy single page.

- A direct visit to `/admin/integrations/providers` opens the surface default workspace (profile authoring) with no query state.
- The action's redirects (unchanged behavior, owned by #1745) still set the precise workspace; the shared href helper now resolves that workspace to its surface route, so a profile save redirects to `/admin/integrations/providers` and an activation to `/admin/integrations/providers?section=readiness`.

## Return context across routes

Every supporting detour deep-links to the surface route that hosts its workspace and carries a `returnPath` query param that points back to the daily import-to-promotion route, plus the working-set context keys (provider key, unit key, import scope, profile version, Source Observation filters, selected IDs, job ID, promotion preview ID). Because each surface is a real route, browser back/forward and bookmarks preserve context with no `pushState` section router. The route-context href helpers and the `returnPath` round-trip are covered by `primary-workbench-route-context.test.ts`.

## Retired single-route shell (#1749, done)

The superseded `?section=` single-page shell (`primary-workbench-page.tsx`, exporting `CatalogPrimaryWorkbenchPage`) has been completely deleted. There is no compatibility shim, alias, hidden flag, or fallback branch. The four nested routes are the only canonical router; the legacy in-page top-level section switching (`normalizeActiveWorkspace`, the `popstate`/`pushState` section handler, and the duplicate in-page command-feedback banner) no longer exists. The IA parity guard in `information-architecture.test.ts` fails closed if a retired section key, route segment, renderer key, or nav item reappears.

## Out of scope for #1739 (later issues)

- Per-route read-model slicing — the four loaders currently share the same read-model composition (#1744).
- Redesigning the daily flow (Run sync → Review → Create/update linearization) (#1740).
- Decomposing the 17-intent action or changing its redirect behavior (#1745).
