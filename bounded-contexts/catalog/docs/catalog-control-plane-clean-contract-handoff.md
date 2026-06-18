# Catalog Control Plane Clean Contract Handoff

This handoff closes the Stage 0 cleanup gate for the Catalog Control Plane UX rebuild. First-slice implementation must target clean launch contracts, not a migration, reskin, route shuffle, redirect, support-only variant, or hidden flag around retired admin structure.

## Stage 0 Evidence

| Cleanup outcome |
| --- |
| Legacy provider compatibility routes and scripted import endpoints were removed from launch routing, tests, documentation, runbooks, release notes, and operator instructions. |
| Silent active-profile fallback and legacy Source Observation profile semantics were removed; missing or `legacy` profile markers now fail closed and remain reset/drop evidence only. |
| Transitional static profile mode and raw JSON broad patch compatibility were retired from normal authoring; section-scoped typed commands are the launch workflow. |
| Prelaunch integration data reset/drop evidence now requires environment plans, backup/snapshot/export or accepted data-loss decisions, dry-run and before/after reports, staging rehearsal, smoke proof, target-table scope, and clean postconditions. |

## Clean Launch Contracts

- The primary operator path is provider import -> Source Observation review -> promotion into Catalog Items or Catalog-owned references.
- Provider profile authoring uses typed section commands and section registry contracts. `rawJsonBacked=false` is required for normal editable sections.
- Source Observation replay/reapply uses recorded source profile metadata or an explicit current-active-profile mode. Missing or retired `legacy` markers fail closed.
- Provider transport belongs to registered adapters. Catalog profile data owns Source Observation semantics, mapping, duplicate-prevention evidence, selected Options, Reference Record hierarchy, and promotion command plans.
- Prelaunch data can be dropped and rebuilt. Retained data is not accepted as clean reset completion unless it is a clean launch capability or an explicit launch blocker with owner and expiry.
- Retire, remove, deprecate, cleanup, and legacy removal mean complete deletion of the retired code path and product pattern, including runtime code, UI modules, route handlers, API/read-model contracts, clients, feature flags, hidden flags, fallback branches, redirects, compatibility aliases, compatibility shims, migration shims, fixtures/seeds, screenshots, tests preserving old behavior, documentation, runbooks, release notes, and operator instructions.

## First-Slice Unblock Rules

- Stage 1 contract and IA issues can proceed against the clean launch contracts above.
- Stage 2 primary workbench issues can proceed after Stage 1 contracts identify the admin API/read-model surface, route/deep-link rules, design-system section navigation, and primary import-to-promotion framing.
- Stage 3 hardening issues can proceed when their upstream Stage 1 or Stage 2 contracts exist; they no longer wait on generic phase-0 cleanup.
- Production rollout remains blocked by first-slice completion because it must verify the accepted rebuilt MVP slice, not just cleanup.
- Support-workspace follow-up work happens after the first slice unless it directly blocks the primary import-to-promotion path.
- Complete deletion of retired admin pages, modules, route/client/read-model behavior, tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions follows once the rebuilt workbench is accepted.

## Stale Pattern Rejection

New implementation work must not:

- revive provider compatibility routes, scripted import endpoints, or legacy provider selectors;
- add raw profile JSON patching as a normal operator workflow;
- silently choose a different active profile when Source Observation profile metadata is missing;
- retain retired UI modules as support-only, internal, hidden, redirect-only, or migration-only surfaces;
- describe retired behavior as usable in documentation, tests, runbooks, fixtures, screenshots, release notes, or operator instructions.

Any exception is launch-blocking until it is either rebuilt as a clean launch contract or completely deleted.
