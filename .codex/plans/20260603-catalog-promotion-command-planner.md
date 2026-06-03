# Catalog Promotion Command Planner

## Issue

[#627](https://github.com/chase-sets/chase-sets/issues/627) - Build Catalog aggregate promotion command planner from mapping config.

## Context

Source Observation promotion still assembles Catalog Item commands directly in `runtime.ts`. Earlier migration slices moved provider normalization, external reference extraction, selected options, and reference hierarchy provisioning behind profile data. This slice introduces the next boundary: a planner that converts a normalized observation and resolved catalog/profile dependencies into a reviewable command plan before the runtime executes Catalog aggregate commands.

The current executable mapping contract has a `promotionCommandPlan` concept, but the active static provider profiles do not yet expose a full command mapping. The first implementation should use the profile's existing catalog field/category/reference mapping as the source of truth for TCGdex Pokemon promotion parity while leaving provider-product observations unpromotable until they declare a valid promotion plan.

## Plan

1. Add a `provider-promotion-command-planner` module in the source-observations API slice.
2. Define a small planner result model with:
   - `status: "planned"` and ordered Catalog Item commands for create or refresh behavior.
   - `status: "blocked"` diagnostics for unsupported observation kinds, missing promotion capability, missing profile mapping, missing reusable target, ambiguous duplicate evidence, or runtime-preflight failures.
   - review metadata for dry-run/admin inspection.
3. Teach the planner to produce the current Pokemon-card command sequence from profile data:
   - Create path: `CreateCatalogItem`, `AssignBlueprintToCatalogItem`, field values, category assignment, tags, image URL/assets, product reference, and catalog item references.
   - Refresh path: `ReviseCatalogItemMetadata`, field values, tags, image URL/assets, product reference, and catalog item references.
   - Optional field commands only appear when optional normalized values exist.
4. Keep Catalog command execution in `runtime.ts`; have create/refresh helpers request a plan and execute its commands in order.
5. Keep image asset normalization outside the pure mapping interpreter but behind planner inputs so the command plan captures the final asset/image commands before execution.
6. Add tests comparing planned TCGdex Pokemon commands with existing behavior, including refresh/create differences, optional field suppression, external reference linking, and blocked provider-product promotion.

## Tradeoffs

- This does not complete the future executable mapping interpreter for arbitrary command declarations. It creates the runtime boundary and parity planner needed before moving more providers onto declarative promotion.
- Asset fetching/storage remains an effectful pre-plan dependency because the existing Catalog command needs concrete stored asset sets. The planner still returns a validated command plan before any Catalog Item writes.
- Duplicate candidate lookup remains in the runtime promotion coordinator for this issue. The planner receives the chosen create/refresh mode and refuses blocked/ambiguous preflight results.

## Verification

- Focused unit tests for the new planner.
- Existing source-observation profile/runtime-focused tests impacted by command shape.
- `pnpm --filter @chase-sets/catalog run test:unit`
- `pnpm run verify:typecheck`
- `pnpm run check:localization`
- Prettier check on touched files.
- `git diff --check`

## Delivery

- Open a PR linked to #627 with this finished plan.
- Wait for required checks and merge queue.
- Verify Platform Deploy staging and production jobs for the merge commit.
- Check #627 in the #637 tracker and close #627 only after deploy verification.
- Run scoped cleanup: `pnpm run dev:down; pnpm run sandbox:clean`, remove the worktree, and delete the local/remote branch.
