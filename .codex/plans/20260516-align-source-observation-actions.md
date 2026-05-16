# Align Source Observation Actions

## Intent

Fix the Source Observations filter row so the filter-scoped "Promote all matching" action aligns with the field controls. The fix belongs in the design system pattern, not as one-off Source Observation spacing.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260516-bulk-promote-source-observations`
- Branch: `codex/bulk-promote-source-observations`
- Sandbox id: `208d7969`
- Dependency setup: `pnpm run deps:install` completed; shared store already up to date.
- Sandbox status: `pnpm run sandbox:doctor` completed; admin web is assigned to `http://localhost:9652`.
- Setup blockers: none.

## Owning Contexts

- Catalog owns Source Observations, their review workflow, and promotion into canonical Catalog Items.
- `packages/design-system` owns reusable data-heavy admin screen patterns including `FilterBar`, `DataTable`, `BulkActionBar`, and field/action alignment.

## Resolved Decisions

- Treat Source Observation action alignment as a design-system `FilterBar` responsibility.
- Keep Catalog Source Observation behavior unchanged; the action already uses the same filter-scoped promotion preview and confirmation behavior.
- Avoid custom overrides in the Source Observations screen. Consumers should get aligned filter actions by using the design-system filter row pattern.

## Open Questions

- None. The screenshot, repo ownership docs, and existing components are sufficient to ship.

## Implementation Checklist

- Completed: replaced the ad hoc Catalog entity-list inline filter row with design-system `FilterBar`.
- Completed: updated `FilterBar` so filter fields and action content bottom-align when controls include visible labels.
- Completed: added focused design-system test coverage for the alignment contract.
- Completed: ran design-system tests, design-system typecheck, and Source Observation UI tests.
- Completed: visually verified the Source Observations filter row at desktop width and mobile width in the sandbox admin web.

## Documentation To Promote

- No durable domain documentation is required; this is a design-system behavior correction with an already documented Source Observation workflow.

## Goal Completion Criteria

- Implementation remains in the feature worktree and branch listed above.
- The retained plan stays committed with the change.
- Automated checks cover the design-system layout contract and Source Observation UI behavior.
- Desktop and mobile visual checks confirm the action aligns with filter fields and does not regress wrapping.
- The branch is ready for PR submission, CI, merge, staging deploy verification, and plan retention.
