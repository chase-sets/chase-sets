# Progressive Disclosure Design System

## Intent

Make progressive disclosure the default way to handle advanced, optional, risky, or low-frequency UI paths without hiding required marketplace facts. Provide design-system guidance and reusable primitives so bounded-context UI can compose disclosure consistently without local overrides.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260514-progressive-disclosure`
- Branch: `codex/progressive-disclosure-design-system`
- Base: current source repo HEAD `8cc4f1e6 Add notifications database to staging platform (#72)`; source `main` is behind `origin/main` by 6 commits.
- Sandbox id: `88dbdd3d`; port base `11050`.
- Dependency setup status: complete via `pnpm run deps:install`.
- Sandbox doctor status: complete via `pnpm run sandbox:doctor`; no blockers found.

## Owning Contexts

- Design System owns the cross-context UI contract, shared components, interaction primitives, styling, and pattern guidance.
- Bounded contexts own the business workflows that use disclosure; deployables remain thin composition roots.
- No bounded context appears to own "progressive disclosure" as domain language. Treat it as design-system pattern language, not marketplace ubiquitous language.

## Resolved Decisions

- Keep required marketplace decision facts visible. Progressive disclosure applies to advanced controls, extra detail, optional form inputs, recovery/support detail, and dense administrative policy explanations.
- Reuse existing Base UI primitive direction through the design-system package instead of direct `<details>` or context-local disclosure controls.
- Prefer design-system docs in `packages/design-system/`; update `docs/README.md` only if new owner-owned docs are added beyond the existing design-system docs.
- Add `ProgressiveDisclosure` for a single advanced section and `ProgressiveDisclosureGroup` for related advanced sections. Both stay business-agnostic and require callers to provide workflow-specific copy.
- First migration targets: Marketplace listing creation/management, Discovery item detail/search, Checkout/payment recovery, Settlement payout readiness, then Catalog/admin setup.

## Open Questions

- None currently blocking. Implementation can choose conservative component names and place them under existing design-system component buckets.

## Implementation Checklist

- [x] Add design-system documentation that defines progressive disclosure defaults, when not to hide facts, accessibility rules, and first flow recommendations.
- [x] Add reusable component-library tools for disclosure composition under the existing feedback primitive bucket.
- [x] Export the new tools from the public design-system surfaces.
- [x] Add focused tests proving visible summaries, controlled state callbacks, and grouped disclosure behavior.
- [x] Run design-system typecheck, design-system tests, and no-explicit-any check after installing dependencies.

## Documentation To Promote

- `packages/design-system/README.md`: package-wide progressive disclosure contract.
- `packages/design-system/MARKETPLACE_SYSTEM.md`: marketplace-specific disclosure guidance and recommended first flows.
- `packages/design-system/PROGRESSIVE_DISCLOSURE.md`: durable component contract, accessibility rules, and recommended flow order.
- `docs/README.md`: curated owner-owned documentation link.

## Goal Completion Criteria

- Implementation stays in this worktree and branch.
- Durable docs explain progressive disclosure as the default advanced-use pattern and recommend first flows.
- Design-system components are exported through canonical package surfaces.
- Automated design-system tests pass.
- Visual checks are performed for representative mobile and desktop disclosure surfaces if a runnable app route is changed; no runnable app route was changed in this docs/component-library pass.
- PR submission, passing CI, merge, staging deploy verification, and plan retention are completed before the implementation goal is closed.
