# Packing Slip 4x6 Address Row

## Intent

Update the Thermal 4x6 Packing Slip so Ship to and Ship from appear on the same row, saving vertical space on thermal-label printer workflows while preserving the existing letter packing slip layout.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-packing-slip-4x6-address-row`
- Branch: `codex/packing-slip-4x6-address-row`
- Base: current source repo `HEAD` at worktree creation
- Sandbox id: `f4047b71`
- Dependency setup: `pnpm run deps:install` completed
- Sandbox setup: `pnpm run sandbox:doctor` completed
- Setup caveats: current shell runs Node `v26.1.0`; repo engine asks for Node `24.x`. Commands complete with an unsupported-engine warning.
- Source worktree caveat: `D:\Users\ToddS\Source\Repos\chase-sets` already has uncommitted implementation edits in the packing slip UI and test files from the earlier non-skill pass. Do not overwrite or revert them without an explicit decision.

## Owning Contexts

- Owner: Fulfillment.
- Slice: `bounded-contexts/fulfillment/features/shipments`.
- Evidence:
  - `bounded-contexts/README.md` states Shipment is owned by Fulfillment.
  - `bounded-contexts/fulfillment/README.md` lists Packing slip preparation under Fulfillment owns.
  - `bounded-contexts/fulfillment/GLOSSARY.md` defines Packing Slip, Letter Packing Slip, and Thermal 4x6 Packing Slip.
  - `bounded-contexts/fulfillment/context.json` contributes the seller packing slip marketplace route from Fulfillment.

## Resolved Decisions

- Keep the behavior in Fulfillment's shipments UI slice because this is a Fulfillment-owned seller-facing shipment document layout concern.
- Do not change domain events, read models, API contracts, localization terms, or deployable composition roots.
- Preserve letter packing slip behavior and scope the layout change to `format="thermal-4x6"`.
- Keep the natural-language labels Ship to and Ship from; they already match the user request and existing localization keys.
- Add focused regression coverage in the existing packing slip UI test so the thermal address grid does not regress to a single-column stack.

## Open Questions

None blocking. The request is explicit and aligns with existing Fulfillment glossary language.

## Implementation Checklist

- Done: Updated `bounded-contexts/fulfillment/features/shipments/ui/packing-slip-page.tsx` in the feature worktree so the Thermal 4x6 address grid renders Ship to and Ship from on the same row.
- Done: Added focused tests in `bounded-contexts/fulfillment/features/shipments/ui/packing-slip-page.test.tsx`, including coverage that the thermal grid override is present for both base preview CSS and narrow-screen CSS.
- Done: Ran `pnpm --filter @chase-sets/fulfillment run test:fast`; 8 test files and 25 tests passed. Command still emits the known Node `v26.1.0` versus repo Node `24.x` warning.
- Done: Ran a browser visual check using a temporary localhost fixture generated from the component stylesheet because the live packing slip route requires authenticated seeded data. Desktop viewport `1280x720` reported `same-row:true; grid:189.203px 189.203px`. Mobile viewport `390x844` reported `same-row:true; grid:160.703px 160.703px`.
- Done: Confirmed no deployable composition roots are changed.

## Documentation To Promote

No durable domain or architecture docs need promotion. Existing Fulfillment glossary already covers Packing Slip and Thermal 4x6 Packing Slip.

## Goal Completion Criteria

The implementation goal must:

- Implement the change in `D:\Users\ToddS\Source\Repos\chase-sets-20260513-packing-slip-4x6-address-row` on branch `codex/packing-slip-4x6-address-row`.
- Retain this plan at `.codex/plans/20260513-packing-slip-4x6-address-row.md`.
- Promote any durable docs only if implementation reveals a real terminology, policy, or architecture change.
- Verify focused fulfillment tests pass.
- Perform or explicitly account for desktop and mobile visual verification of the 4x6 packing slip layout.
- Submit a PR, get CI passing, merge the PR, and verify the staging deploy.
