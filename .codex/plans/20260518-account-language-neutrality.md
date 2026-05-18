# Account Language Neutrality

## Intent

Remove buyer/seller bucket language where it implies account identity, profile, navigation, setup, analytics, public marketing category, or reusable component contracts. Preserve buyer/seller only where it names a concrete transaction role inside an order, purchase, sale, shipment, refund, fee snapshot, payout, listing, or offer workflow.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260518-account-language-neutrality`
- Branch: `codex/account-language-neutrality`
- Sandbox id: `5414b715`
- Dependency setup status: complete via `node ./scripts/worktree-deps.mjs install`
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Sandbox doctor: passed
- Setup blockers: none

## Owning Contexts

- Design system owns reusable marketplace UI primitives and must not expose seller-only account profile components.
- Discovery owns browse/item detail read models and can project public offer demand without naming it as buyer account identity.
- Insights owns read-only dashboards and should name account performance metrics by purchase/sale/reporting intent instead of seller identity.
- Public Presence owns public policy pages and waitlist behavior; it should sell the value of order protection and marketplace sales fees without segmenting accounts into buyers and sellers.
- Marketplace remains the behavior owner for Listing, Offer, Seller Listing Availability, and Marketplace Sales Fee confirmation. Existing seller terms inside concrete listing/sale/fee workflows are transaction-role language and are intentionally preserved unless they leak into account identity.

## Resolved Decisions

- Public account surfaces use Account Profile names. `AccountProfileHeader` and `AccountProfileSkeleton` become account-profile primitives.
- Public protection copy becomes Order Protection where it explains policy value outside a concrete buyer transaction.
- Public fee copy becomes Marketplace Sales Fees or Sales Fees where it explains selling economics without defining seller accounts.
- Waitlist segmentation remains useful, but the domain term changes from `WaitlistRole` to `WaitlistCommerceIntent`, and the fee interest changes from `low-seller-fees` to `low-sales-fees`.
- Discovery public demand projections change from `buyer_offer_matches` / `discovery_buyer_offer_matches` to `offer_demand_matches` / `discovery_offer_demand_matches`.
- Insights dashboard identity changes from `Seller Performance KPI` to `Sales Performance KPI`.
- UCP/MCP "public marketplace" discovery language changes to public/order-safe discovery language unless the text is explicitly describing a transaction role.
- Structural tests expand to include `packages/` and `contracts/`, plus snake_case/kebab-case variants that caught this pass.

## Implementation Checklist

- [x] Rename design-system seller profile, seller trust, buyer protection, and seller quality primitives and tests.
- [x] Rename Discovery offer-demand DTOs, table names, indexes, route dependencies, tests, realtime patches, and context manifest entries.
- [x] Rename Insights sales performance KPI contracts, query names, read-model names, tests, glossary, and context manifest entries.
- [x] Rename Public Presence routes and route ids from buyer/seller policy pages to order protection and marketplace sales fees; update sitemap/tests/localization.
- [x] Rename waitlist role/interest domain language to commerce intent and low sales fees.
- [x] Update docs, design-system guidance, MCP/UCP copy, and localization strings that still imply buyer/seller account buckets.
- [x] Expand account language structural guard and unit tests.

## Verification Log

- `pnpm run sandbox:doctor` passed with sandbox `5414b715`.
- `pnpm run test:structure` passed after final edits.
- `pnpm run check:structure` passed after final edits.
- `pnpm run check:localization` passed after final edits.
- `pnpm --filter @chase-sets/design-system test` passed after final edits.
- `pnpm --filter @chase-sets/discovery test` passed after final edits with existing jsdom `scrollTo` warnings.
- `pnpm run typecheck` passed after final edits.
- `pnpm run test:fast` passed after final edits with existing jsdom CSS/`scrollTo` warnings.
- `pnpm run build` passed after final edits.

## Documentation To Promote

- Keep this plan with the implementation.
- Update context glossaries and cross-context docs only where canonical terms change.
- Prefer editing existing docs over adding an ADR; this is a continuation of the already-established account role language rule rather than a new hard-to-reverse architectural decision.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
