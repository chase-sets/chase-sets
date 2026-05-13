# Offer Listing Parity

## Intent

Public offers on the Discovery item detail sell view should present the same kind of information as public listings. Public offer rows already only show submitted Marketplace Offers, so rendering `status: submitted` on every visible row is redundant and adds noise. The implementation should make offer cards mirror listing cards: price and account attribution, quantity, and product selection.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-offer-listing-parity`
- Branch: `codex/offer-listing-parity`
- Base: source repo `HEAD` at worktree creation (`4f492f63`)
- Sandbox id: `0e31d6f5`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox doctor: `pnpm run sandbox:doctor` completed.
- Setup caveat: Node is `v26.1.0` in this shell; repo engine asks for Node `24.x`. Commands completed with warnings.

## Owning Contexts

- Primary implementation owner: Discovery, `features/item-detail`.
- Source-of-truth owner: Marketplace owns Offer lifecycle and publishes submitted and accepted offer facts.
- Cross-context relationship: Discovery projects Marketplace offer facts into `discovery_buyer_offer_matches` for item detail demand display. Discovery may reshape presentation but must not change Offer lifecycle semantics.

## Resolved Decisions

- Public item-detail offer cards should not render the Offer Status badge because `getDiscoveryItemDetail` filters public offers with `offer.status = 'submitted'`.
- The Discovery item-detail sell view should align public offers with the public listing card structure:
  - Price plus buyer attribution, preserving `Your offer` visibility when the viewer owns the offer.
  - Quantity requested.
  - Product selection summary.
- Seller-only acceptance readiness (`Can fulfill`, `Needs supply`, `In sell list`) should not stay in the public offer card grid because it does not match public listing information. Seller acceptance readiness remains available in seller-specific Marketplace flows and commerce panels.
- No Marketplace domain, event, schema, or API contract change is needed.
- No glossary change is needed. Existing Discovery glossary already says Detail Pages may show submitted Marketplace Offers and accepted offers should not remain public rows. Existing Marketplace glossary already says submitted offers remain public marketplace-wide demand until accepted.

## Repo Evidence

- `bounded-contexts/README.md` fixes Listing and Offer ownership to Marketplace.
- `bounded-contexts/marketplace/README.md` says Marketplace owns listing and offer workflows before an order exists.
- `bounded-contexts/discovery/README.md` says Discovery owns browse and item detail presentation models and may reshape upstream facts.
- `bounded-contexts/discovery/GLOSSARY.md` says Detail Pages may show submitted Marketplace Offers as public product demand and accepted Offers should not remain visible as public offer rows.
- `bounded-contexts/discovery/features/item-detail/read-model/queries.ts` queries public offers with `offer.status = 'submitted'`.
- `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx` currently renders public listing cards with price/seller, availability, and product, while public offer cards render price/buyer, quantity, product, and a status/fulfillment column.

## Stress Test

- Normal flow: submitted public offers display without repeated `submitted` badges and still sort by seller price.
- Accepted flow: accepted offers remain filtered out of public item detail demand by the read model.
- Seller signed-in flow: seller-specific offer match data can still drive the commerce panel selection; card-level fulfillment badges are removed only from the public offer list.
- Viewer owns offer: `Your offer` and the private visibility note remain, because they are attribution/visibility cues rather than status.
- Stale projection or replay: if accepted offers are replayed, the existing `offer.status = 'submitted'` query keeps them out of public rows.
- Low-value card economics: less visual noise improves quick comparison of price and quantity, which supports efficient low-value-card workflows.

## Implementation Checklist

- Completed: Updated `bounded-contexts/discovery/features/item-detail/ui/item-detail-page.tsx`.
  - Removed the now-unused `offerStatusTone`.
  - Changed public offer cards from four columns to three columns.
  - Removed the status/fulfillment stack from public offer cards.
  - Preserved selected, viewer-owned, buyer attribution, quantity, and product summary behavior.
- Completed: Updated Discovery item-detail UI tests in `bounded-contexts/discovery/tests/item-detail-commerce-panel.test.tsx`.
  - Assert public offer cards no longer render `submitted` status.
  - Assert public offer cards still show price, buyer, product summary, and selected state.
  - Adjust seller-account coverage to verify `Can fulfill` is not rendered in the public offer card.
- Completed: Focused Discovery item-detail UI test passed.
- Completed: Workspace typecheck passed.
- Completed: Marketplace dev surface visual check passed on desktop and mobile.

## Verification

- `pnpm --filter @chase-sets/discovery run test -- item-detail-commerce-panel.test.tsx` passed: 22 tests.
- `pnpm run verify:typecheck` passed.
- Browser visual check:
  - Desktop `http://localhost:7053/items/charizard-base-set-4-102-holo-rare-seed-charizard-base-set-xsr3yp?market=sell`: offer cards show price/buyer, quantity, and product; no `Status`, `submitted`, `Can fulfill`, or `Needs supply` text in the offer list.
  - Mobile viewport `390x844` on the same route: offer cards stack cleanly and show price/buyer, quantity, and product; no status or fulfillment badges in the offer list.
- Persistent environment caveat: commands pass, but Node remains `v26.1.0` while the repo asks for Node `24.x`.

## Documentation To Promote

- None expected. This is a presentation cleanup within existing Discovery and Marketplace language.

## Goal Completion Criteria

The implementation goal must:

- Implement the UI and test changes in `D:\Users\ToddS\Source\Repos\chase-sets-20260513-offer-listing-parity` on branch `codex/offer-listing-parity`.
- Keep the retained plan at `.codex/plans/20260513-offer-listing-parity.md`.
- Preserve Marketplace ownership of Offer lifecycle and Discovery ownership of item-detail presentation.
- Verify focused Discovery tests and any necessary type/static checks.
- Run desktop and mobile visual checks of the Discovery item detail sell view in the worktree sandbox.
- Promote durable docs only if implementation uncovers a real language or ownership contradiction.
- Prepare a PR after implementation, confirm CI passes, merge when approved, and verify staging deploy behavior.
