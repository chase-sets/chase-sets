# Test Suite Cleanup Tasks

This list tracks the cleanup work from the full test-suite review.

- [x] Keep fast test runs from dropping pure tests that live in database-capable workspaces.
- [x] Route DB-backed Catalog, Discovery, and Inventory acceptance tests through DB-profile CI coverage.
- [x] Run full DB-profile tests in PR CI instead of only the fast DB subset.
- [x] Align local fast test workspace concurrency with CI.
- [x] Split DB-capable workspaces into explicit unit and DB test tiers so pure tests do not wait on the DB lane.
- [x] Require platform-runtime realtime DB integration coverage through the DB test tier.
- [x] Make local `verify` include full DB-tier coverage.
- [x] Narrow PR E2E triggers to marketplace-facing deployable and user-journey surfaces.
- [x] Centralize PR dependency installation in the shared pnpm setup action with timing output.
- [x] Move shared marketplace seed test support out of the payments bounded context.
- [ ] Relocate deployable route behavior tests into the bounded contexts that own the behavior.
- [x] Split oversized test files by responsibility:
  - [x] `infrastructure/platform-runtime/realtime.test.ts`
  - [x] `bounded-contexts/ordering/features/orders/api/runtime.test.ts`
  - [x] `bounded-contexts/discovery/tests/item-detail-commerce-panel.test.tsx`
  - [x] `bounded-contexts/discovery/tests/item-detail-buy-now-action.test.ts`
  - [x] `bounded-contexts/checkout/routes/checkout-routes.test.ts`
  - [x] `infrastructure/bounded-context-runtime/index.test.ts`
  - [x] `bounded-contexts/catalog/features/source-observations/api/runtime.test.ts`
  - [x] `bounded-contexts/catalog/features/source-observations/api/route.test.ts`
- [x] Consolidate the design-system test catalog into focused behavior/accessibility tests (merged the parity twin into the catalog suites and removed three duplicated component assertions).
- [ ] Replace source-string tests with exported policies, metadata, or runtime behavior tests.
  - [x] Converted the marketplace service-worker cache/exclusion coverage to assert exported policy helpers.
  - [x] Removed the platform API dependency on the deleted manual marketplace parity matrix.
  - [ ] Convert platform feedback placement coverage away from source scanning (the placement
        contract spans route sources in other contexts and is not exported anywhere yet).
  - [x] Convert admin-support bootstrap profile coverage away from source scanning (now exercises
        the bootstrap entrypoint with mocked dependencies and asserts the orchestration calls).
  - [x] Convert admin-web dev proxy coverage away from source scanning (now imports the vite
        config and asserts the exported proxy table).
- [x] Extract repeated Hono route-test harness helpers for actor/context/service setup.
- [ ] Revisit UI tests that assert class fragments or incidental text and convert them to user-facing contracts.
