# Admin Catalog Realtime Projection Refresh

## Intent

Admin catalog pages are intentionally backed by projections and eventual consistency. After bulk actions, operators currently have to refresh manually because the page revalidates before the relevant read model catches up. Add a scalable realtime projection-refresh path so Catalog-owned admin screens update after Catalog projections publish their new state.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-admin-catalog-realtime`
- Branch: `codex/admin-catalog-realtime`
- Sandbox id: `0ca4ace8`
- Dependency setup status: `pnpm run deps:install` completed; `pnpm run sandbox:doctor` passed
- pnpm store path: `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none found during planning

## Owning Contexts

- Catalog owns the admin catalog pages, request contracts, bulk action orchestration, read models, and projection refresh behavior.
- Platform Runtime owns the reusable SSE transport, durable realtime outbox, cursoring, replay, stream limiting, and route policy composition.
- Admin Web is only a thin deployable host and should only proxy `/api/realtime` for local development; it must not own Catalog behavior.

Repo evidence:

- `bounded-contexts/catalog/README.md` says Catalog owns canonical product authoring and Source Observations.
- `bounded-contexts/catalog/docs/admin-bulk-workflows.md` says Catalog owns bulk request contracts, scope resolution, command execution, projection refresh, and result reporting.
- `docs/runbooks/realtime-sse.md` defines the existing platform pattern: bounded contexts publish client-facing projection patches after read-model updates, deployables compose context stores into `/api/realtime/events`, and clients refetch on `sync.required`.
- `bounded-contexts/marketplace` and `bounded-contexts/discovery` already provide `support/realtime-support` topic manifests and patch factories.

## Resolved Decisions

- Reuse the existing SSE projection-patch transport instead of adding polling, WebSockets, or deployable-specific refresh behavior.
- Publish Catalog-owned admin projection patches after read-model projection writes, not raw domain events. This preserves event-sourced invariants and keeps clients tied to read-model readiness.
- Treat the first implementation as route revalidation, not fine-grained row patch application. Catalog list filters, pagination, and bulk scopes are read-model queries; invalidating and reloading the current route avoids duplicating query semantics in the browser.
- Add Catalog realtime topics under `catalog:admin:<surface>` and authorize them with the existing `catalog.view` permission.
- Add Catalog to the platform API realtime store and topic-policy composition.
- Add admin-web local dev proxying for `/api/realtime` with long-lived request timeouts, matching marketplace-web.
- Keep reusable Catalog realtime topic and subscription helpers in a new `support/realtime-support` directory and declare it in `context.json`, matching existing bounded-context structure rules.

## Implementation Checklist

- Add Catalog realtime outbox schema to Catalog schema composition.
- Add Catalog realtime topic manifest, route topic presets, and topic policy manifest.
- Export Catalog realtime contracts from `bounded-contexts/catalog/server.ts`.
- Include Catalog realtime stores and policy in platform API SSE composition.
- Add `/api/realtime` proxy to `deployables/admin-web/vite.config.ts`.
- Add a Catalog shell-support hook that subscribes to a route topic and debounced `useRevalidator().revalidate()` on patches or `sync.required`.
- Use that hook from Catalog admin list routes or list pages for Dimensions, Fields, Components, Blueprints, Categories, Catalog Items, Reference Types, Reference Records, and Source Observations.
- Emit Catalog admin projection patches from Catalog projection handlers after affected read models are updated.
- Add focused tests for Catalog topic policy, patch creation/application trigger, and at least one projection patch emission path.
- Run worktree dependency setup, `pnpm run sandbox:doctor`, typecheck, focused tests, and relevant fast checks.

## Stress Test

- Normal flow: bulk action writes domain events; Catalog projector updates read model; projector records a projection patch; admin page receives patch and revalidates.
- Partial flow: mixed bulk results still show outcome dialog; realtime revalidation updates only when projections for successful writes land.
- Stale data or replay: SSE cursor replay delivers missed patches; expired or backpressured cursors trigger route revalidation through `sync.required`.
- Cross-context handoff: no downstream context owns this admin refresh behavior; Platform Runtime only transports Catalog-owned projection facts.
- Failure/cancellation: if SSE fails, existing manual navigation and refresh still work. The operation result remains visible even if realtime revalidation is delayed.
- Low-value card economics: bulk Catalog workflows stay efficient by avoiding per-row browser polling and keeping server-side filter scope resolution intact.

## Documentation To Promote

- Updated `bounded-contexts/catalog/docs/admin-bulk-workflows.md` with the realtime projection-refresh behavior.
- No ADR needed; this follows the existing documented Realtime SSE architecture rather than introducing a new system decision.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
