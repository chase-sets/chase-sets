# Progressive Disclosure First Flows

## Goal

Update the recommended first flows for progressive disclosure so the design-system guidance points at concrete bounded-context-owned adoption slices, with visible facts and disclosed depth stated for each flow.

## Skill Workflow

- Skill: `plan-with-context`
- Worktree: `D:\Users\ToddS\Source\Repos\chase-sets-20260515-progressive-disclosure-first-flows`
- Branch: `codex/progressive-disclosure-first-flows`
- Base: `origin/main` at `f1db06a5`
- Dependency setup: `pnpm run deps:install` completed successfully.
- Sandbox doctor: `pnpm run sandbox:doctor` completed successfully.
- Sandbox id: `fc4d70ba`
- Port base: `9300`

## Contexts Read

- Strategic context map: `bounded-contexts/README.md`
- Structure rules: `docs/architecture/bounded-context-structure.md`
- Design-system guidance: `packages/design-system/PROGRESSIVE_DISCLOSURE.md`, `packages/design-system/MARKETPLACE_SYSTEM.md`
- Candidate context docs: Marketplace, Discovery, Checkout, Payments, Settlement, and Catalog `README.md`, `GLOSSARY.md`, and `context.json`
- Supporting notes: money operations runbook, marketplace checkout fee policy, account money navigation, and dynamic search filters

## Code Cross-Check

- Marketplace listing create/update routes currently expose optional purchase limits, fee preview, fee-lock history, and publishing recovery state inline.
- Discovery search currently has primary category/language filters plus dynamic facets; item detail keeps commerce facts and item details visible.
- Checkout session review owns fulfillment readiness, shipping, wallet credit, and the continue-to-payment action.
- Payments owns payment fee quote, payment confirmation, provider events, support details, guest claim fallback, and recovery panels.
- Settlement owns payout readiness, grouped provider requirements, unavailable payout reasons, payout request confirmation, and payout history.
- Catalog admin slices expose blueprint rules, dimension rules, product-resolution rules, external references, tags, image URLs, lifecycle controls, and publish checks.
- `ProgressiveDisclosure` exists in the design system and is exported. The candidate bounded-context routes do not yet use it.
- Raw `<details>` remains in the payments guest claim fallback and design-system navigation action component; the payments instance is part of the recommended payment recovery adoption slice.

## Decisions

- Progressive disclosure stays design-system pattern language, not bounded-context ubiquitous language.
- Required decision facts stay visible: price, total, status, availability, destination, buyer/seller commitment, blocking errors, and primary actions.
- Adoption slices stay in their owning bounded contexts; deployables should not own disclosure behavior.
- Cross-context Checkout/Payments work must preserve ownership: Checkout handles session and fulfillment disclosure, while Payments handles fee quote, confirmation, provider-event, support, and recovery disclosure.
- The first-flow recommendations should favor surfaces already backed by current code instead of aspirational routes.

## Updated Recommendations

1. Marketplace seller listing creation and listing management.
   Keep inventory identity, price, quantity cap, fee preview, status, and listing actions visible. Disclose optional seller limits, fee-lock history, stale quote recovery detail, grading population detail, and certification extras.
2. Discovery search and item detail.
   Keep primary filters, applied filter chips, result count, item identity, listing/offer comparison, and commerce actions visible. Disclose dynamic advanced facets, specification depth, policy explanation, market-history detail, and saved-search recovery.
3. Checkout session and payment recovery.
   Keep fulfillment state, final cost, wallet credit, selected destination, payment method, secure payment cue, blocking failure copy, and payment/recovery action visible. Disclose address-book defaults, optional wallet custom amount detail, support details, provider event history, claim-token fallback, and recovery diagnostics in the owning context.
4. Settlement payout readiness and payout requests.
   Keep payout readiness status, available amount, amount policy, destination status, unavailable state, and setup/preview/confirm actions visible. Disclose grouped verification requirement detail, provider capability detail, ledger context, unavailable reason detail, optional payout note, and provider-safe payout explanations.
5. Catalog admin authoring and setup.
   Keep entity identity, status, lifecycle controls, current blueprint/category assignment, required field state, and publish action visible. Disclose field rules, dimension rules, product-resolution rules, external references, tag/image URL management, automation settings, and audit/history detail.

## Docs Changed

- `packages/design-system/PROGRESSIVE_DISCLOSURE.md`
- `packages/design-system/MARKETPLACE_SYSTEM.md`

## Implementation Path

1. Marketplace: wrap purchase limits and fee-lock history with `ProgressiveDisclosure`; add summary text for active limits and stale quotes.
2. Discovery: group dynamic facets behind `ProgressiveDisclosureGroup` after category/language; add active advanced-filter summaries.
3. Checkout and Payments: replace payment raw `<details>` and support detail sections with design-system disclosure; keep totals and failures visible.
4. Settlement: disclose grouped requirement details and unavailable reason details while leaving status and actions visible.
5. Catalog: disclose admin rule and reference depth after entity status and lifecycle controls.

## Implementation Evidence

- Marketplace listing creation/detail now disclose purchase limits and fee-lock history while keeping price, quantity cap, fee preview, status, and listing actions visible.
- Discovery search now discloses dynamic facets on desktop and mobile after category/language filters; active advanced facets open by default and summarize selected values.
- Checkout session review now discloses address-book defaults and optional wallet-balance use while keeping shipping destination, payment method, totals, and continue action visible.
- Payments recovery now replaces the guest-claim raw `<details>` and support/provider event details with `ProgressiveDisclosure`.
- Settlement payout readiness/request now discloses provider setup details, unavailable reasons, payout preview blockers, and optional payout notes while keeping readiness, amount, policy, and actions visible.
- Catalog blueprint/item admin now discloses field rules, dimension rules, product-resolution rules, tags, image URLs, and external references after identity/status/lifecycle controls.
- Localization learning: nested facet controls use localized "{facet} choices" labels so the disclosure trigger owns the visible advanced-section label without duplicate exact text in mounted mobile drawers.

## Verification Plan

- Docs-only update: run `git diff --check`.
- Product implementation follow-up: run affected context tests plus design-system tests, then use Browser on marketplace/admin desktop and mobile routes to verify collapsed and expanded states.
- Pressure tests: mobile scanning, stale read models, failed/canceled actions, replayed events, low-value card margin visibility, and provider-safe recovery details.

## Verification Evidence

- `git diff --check`: passed.
- `pnpm run typecheck`: passed after implementation.
- `pnpm --filter @chase-sets/design-system run test`: 87 passed after rebase onto `origin/main`.
- `pnpm --filter @chase-sets/marketplace run test`: 35 passed.
- `pnpm --filter @chase-sets/discovery run test`: 68 passed, 3 skipped after rebase onto `origin/main`.
- `pnpm --filter @chase-sets/checkout run test`: 49 passed.
- `pnpm --filter @chase-sets/catalog run test`: 101 passed, 2 skipped.
- `pnpm --filter @chase-sets/payments run test:fast`: 30 passed.
- `pnpm --filter @chase-sets/settlement run test:fast`: 41 passed.
- `pnpm run check:localization`: passed.
- `pnpm run check:structure`: passed.
- `pnpm run typecheck`: passed after localized summary cleanup.
- Browser plugin note: the Browser/browser-use plugin did not expose a callable navigation or screenshot tool in this session. Local Microsoft Edge headless screenshots were used as the rendered browser fallback.
- Visual checks: captured desktop and mobile Discovery search at `http://localhost:9303/search?q=charizard`; authenticated Marketplace listing management at `http://localhost:9303/account/listings`, including a scrolled desktop screenshot of the collapsed purchase-limits disclosure; authenticated Settlement payouts at `http://localhost:9303/account/payouts`; and authenticated Catalog blueprint detail at `http://localhost:9302/catalog/blueprints/bpr_seed_pokemon_card_single`.
- Visual limitation: the seeded checkout session route `http://localhost:9303/checkout/chk_seed_started_cart` returned the app's "Checkout session not found" error in this sandbox, so checkout's disclosure adoption remains covered by typecheck and affected tests rather than a rendered route screenshot.
