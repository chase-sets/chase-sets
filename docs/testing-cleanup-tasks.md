# Test Suite Cleanup Tasks

This list tracks the cleanup work from the full test-suite review.

- [x] Keep fast test runs from dropping pure tests that live in database-capable workspaces.
- [x] Route DB-backed Catalog, Discovery, and Inventory acceptance tests through DB-profile CI coverage.
- [x] Run full DB-profile tests in PR CI instead of only the fast DB subset.
- [x] Align local fast test workspace concurrency with CI.
- [x] Move shared marketplace seed test support out of the payments bounded context.
- [ ] Relocate deployable route behavior tests into the bounded contexts that own the behavior.
- [ ] Split oversized test files by responsibility:
  - [ ] `infrastructure/platform-runtime/realtime.test.ts`
  - [ ] `bounded-contexts/ordering/features/orders/api/runtime.test.ts`
  - [ ] `bounded-contexts/discovery/tests/item-detail-commerce-panel.test.tsx`
- [ ] Consolidate the design-system test catalog into focused behavior/accessibility tests.
- [ ] Replace source-string tests with exported policies, metadata, or runtime behavior tests.
  - [x] Converted the marketplace service-worker cache/exclusion coverage to assert exported policy helpers.
  - [x] Removed the platform API dependency on the deleted manual marketplace parity matrix.
  - [ ] Convert platform feedback placement coverage away from source scanning.
  - [ ] Convert admin-support bootstrap profile coverage away from source scanning.
- [ ] Extract repeated Hono route-test harness helpers for actor/context/service setup.
- [ ] Revisit UI tests that assert class fragments or incidental text and convert them to user-facing contracts.
