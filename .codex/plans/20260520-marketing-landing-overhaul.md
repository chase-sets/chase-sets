# Marketing Landing Overhaul

## Intent

Overhaul the public Chase Sets prelaunch landing page so the marketing leads with the strongest launch wedge:

- founding sellers can create beta listings with 0% seller-side marketplace sales fees until sold;
- listings keep that 0% seller fee while unchanged after beta ends;
- Chase Sets does not pass separate seller payment-processing fees such as 2.9% plus 30 cents to sellers;
- buyer-side Marketplace Checkout Fee / order processing is visible before payment and can be reduced through lower-cost payment methods;
- buyer value remains clear delivered totals, shipping credit, order protection, and set completion.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-marketing-landing-overhaul`
- Branch: `codex/marketing-landing-overhaul`
- Sandbox id: `07bd014b`
- Dependency setup status: complete
- pnpm store path: default embedded worktree store, `.codex/worktrees/.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Public Presence owns the public product pages, policy surfaces, waitlist behavior, public copy, UI, and tests.
- Commercial Terms owns seller-side marketplace sales fee policy, Marketplace Sales Fee, and Seller Net.
- Marketplace owns Listing lifecycle and seller fee confirmation snapshots, including the invariant that listing fee snapshots are calculated at listing publication and refreshed on active price or quantity-cap changes.
- Payments owns buyer-side Marketplace Checkout Fee, payment-method-specific fee quotes, and buyer-paid share refund execution.

## Resolved Decisions

- Keep implementation inside Public Presence route/UI/localization files. Do not move marketing copy into deployables.
- Lead the homepage with seller economics because the 0% beta seller fee lock and no seller payment-processing fee are stronger supply-acquisition hooks than generic waitlist urgency.
- Keep buyer messaging as total-cost transparency rather than "no fees" because Payments owns buyer-side Marketplace Checkout Fee / order processing.
- Use public marketing language such as buyers, sellers, collectors, and founding sellers while preserving domain terms where policy precision matters.
- Avoid promising a post-beta 5% fee because the user said the expected fee is not final. Say post-beta fee schedules will be published before the beta ends.
- Add proof-style economics copy instead of only abstract benefits.
- Keep `/buyer-protection` and `/seller-fees` as canonical current repo routes because `public-presence/context.json`, `sitemap.ts`, and tests already define them.

## Open Questions

None blocking. Future launch/legal review should confirm exact beta duration, post-beta fee schedule, and public buyer fee wording before live transactions.

## Implementation Checklist

- [x] Update public homepage copy to emphasize founding seller economics and buyer-visible order processing.
- [x] Add or revise an above-the-fold seller economics proof panel.
- [x] Update FAQ and policy-page copy for 0% beta seller fee lock, no seller payment-processing fees, and buyer-visible order processing.
- [x] Update tests that assert landing copy.
- [x] Run localization/public-presence tests and public-web route tests.
- [x] Run a local visual verification of the public landing page.

## Verification

- `pnpm run deps:install`
- `pnpm run sandbox:doctor`
- `pnpm --filter @chase-sets/localization run test`
- `pnpm --filter @chase-sets/public-presence run test`
- `pnpm --filter @chase-sets/app-public-web run test`
- `pnpm --filter @chase-sets/localization run typecheck`
- `pnpm --filter @chase-sets/public-presence run typecheck`
- `pnpm --filter @chase-sets/app-public-web run typecheck`
- `pnpm run check:localization`
- `pnpm --filter @chase-sets/app-public-web run build`
- Browser verification at `http://127.0.0.1:8554/` on desktop and mobile viewports; seller-economics section had no horizontal overflow on a 390px mobile viewport.
- After rebasing onto `origin/main`, reran focused tests, typechecks, localization check, public-web build, and Playwright screenshot verification for 390px mobile and 1440px desktop at `http://127.0.0.1:8554/`.

## Documentation To Promote

No durable domain docs are required for this marketing-only change. If beta fee-lock policy becomes a contractual launch rule, promote it to a Public Presence policy note and/or Commercial Terms documentation after legal/product confirmation.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
