# Catalog Integrations Route IA

This note is the route-level information architecture for the Catalog integrations control plane. The control plane is composed of four real nested routes under `/admin/integrations`, one per audience surface, each built from a shared workbench shell. There is no `?section=` mini-app: the route path is the screen router.

## Route map

| Route | Surface | Workspaces (in render order) | Loader entry point |
| --- | --- | --- | --- |
| `/admin/integrations` | daily | import-to-promotion | `support/route-support/admin-integrations/integrations-loader.ts` |
| `/admin/integrations/providers` | providers | profile-authoring, validation-readiness | `support/route-support/admin-integrations/providers-loader.ts` |
| `/admin/integrations/governance` | governance | conflict-resolution, lifecycle-recovery, governance-controls | `support/route-support/admin-integrations/governance-loader.ts` |
| `/admin/integrations/health` | health | audit-evidence, health-triage | `support/route-support/admin-integrations/health-loader.ts` |

The daily route is the default and renders only the primary import-to-promotion job. The other three routes render their grouped supporting workspaces stacked.

The health surface is the **Integration Health** route: it answers "is import, review, or promotion safe right now?" through health triage, and traces who changed what through the audit timeline.

## Source of truth

- The surfaces, their path segments, and their workspaces are declared in `features/source-observations/ui/admin-control-plane/information-architecture.ts` as `CATALOG_CONTROL_PLANE_ROUTE_SURFACES`. Each workspace also carries a `routeSurface` field, and the IA↔render parity test (`information-architecture.test.ts`) asserts that every workspace belongs to exactly one surface and that every surface workspace is renderable.
- The routes are registered as thin composition roots in the catalog deployable contribution (`context.json`, `deployableContributions[].routes`) with route IDs `integrations`, `integrations-providers`, `integrations-governance`, `integrations-health`. The admin-web deployable resolves them through the established `resolveWebHostRouteConfigRecords` → `toRouteConfigEntry` framework (React Router v7), the same path each sibling catalog admin route uses.
- The route files (`routes/admin/integrations*.tsx`) are thin roots: they re-export the loader/action and render `CatalogIntegrationsSurfaceRouteView` with their surface key. The shared shell lives in `features/source-observations/ui/workbench-shell.tsx`; the surface body composition lives in `integrations-surface-page.tsx`; the render registry lives in `workbench-workspace-renderers.tsx`.

## Section state vs route path

The route path is the screen router. The `section` query param (and the `routeContext.section`) only identifies the precise workspace within a multi-workspace surface, which drives active-nav highlighting and detour telemetry. It is never the screen router.

- A direct visit to `/admin/integrations/providers` opens the surface default workspace (profile authoring) with no query state.
- The action's redirects still set the precise workspace; the shared href helper resolves that workspace to its surface route, so a profile save redirects to `/admin/integrations/providers` and an activation to `/admin/integrations/providers?section=readiness`.

## Return context across routes

Every supporting detour deep-links to the surface route that hosts its workspace and carries a `returnPath` query param that points back to the daily import-to-promotion route, plus the working-set context keys (provider key, unit key, import scope, profile version, Source Observation filters, selected IDs, job ID, promotion preview ID). Because each surface is a real route, browser back/forward and bookmarks preserve context with no `pushState` section router. The route-context href helpers and the `returnPath` round-trip are covered by `primary-workbench-route-context.test.ts`.

## Single canonical router

The four nested routes are the only canonical router. There is no compatibility shim, alias, hidden flag, or fallback branch for an in-page top-level section switcher. The IA parity guard in `information-architecture.test.ts` fails closed if a retired section key, route segment, renderer key, or nav item reappears.
