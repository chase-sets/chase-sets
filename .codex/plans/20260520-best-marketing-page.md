# Best Marketing Page

## Intent

Make the public Chase Sets prelaunch landing page the strongest possible acquisition page for the current product stage.

The page should lead with the clearest market wedge: low-value card economics are broken for sellers, and Chase Sets gives founding sellers a concrete reason to bring supply early while giving buyers transparent delivered totals for set completion.

The implementation should convert more qualified waitlist signups, improve waitlist signal quality, strengthen trust, fix SEO defects, and avoid promises that Payments, Commercial Terms, Marketplace, Checkout, or Discovery cannot support.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\20260520-best-marketing-page`
- Branch: `codex/best-marketing-page`
- Sandbox id: `d80417be`
- Dependency setup status: complete
- pnpm store path: `D:\Users\ToddS\Source\Repos\chase-sets\.codex\worktrees\.chase-sets-pnpm-store`
- Setup blockers: none known

## Owning Contexts

- Public Presence owns the public product pages, prelaunch policy surfaces, waitlist behavior, waitlist read models, route UI, public copy, and tests.
- Public Web composes Public Presence routes and owns deployable SEO mechanics such as sitemap, robots, canonical tags, wildcard routes, redirects, and HTTP status behavior.
- Commercial Terms owns seller-side Marketplace Sales Fee policy and Seller Net calculations. Public marketing may describe the beta fee-lock promise only as a Public Presence claim backed by future commercial terms, not as Commercial Terms runtime behavior unless policy docs are promoted.
- Marketplace owns Listing, Offer, Seller Listing Availability, listing publication, offer acceptance, and account-confirmed sales fee snapshots. Marketing copy must not imply Public Presence owns listing lifecycle or fee confirmation.
- Checkout owns Cart, Sell List, Checkout Session, checkout review, and orchestration into Ordering and Payments. Buyer proof can describe visible totals and intent review, but not bypass Checkout-owned confirmation.
- Payments owns Marketplace Checkout Fee, external payment state, refund execution, and payment-method-specific buyer-side fee quotes. Marketing must not imply buyer checkout is fee-free.
- Discovery owns browse, search, item detail, Product Alerts, set-completion discovery, and public product liquidity presentation. Marketing can preview these experiences but should keep exact browse/search behavior in Discovery.
- The design system is the canonical source for marketing and marketplace primitives. No local UI overrides should be introduced in deployables.

## Repo Evidence

- `bounded-contexts/public-presence/README.md` says Public Presence owns public product pages, policy surfaces, waitlist behavior, UI, and tests.
- `bounded-contexts/public-presence/context.json` exposes only `home`, `faq`, `contact`, `terms`, `privacy`, `refunds-and-returns`, `order-protection`, and `sales-fees` to `public-web`.
- `bounded-contexts/public-presence/features/waitlist/ui/public-pages.tsx` currently hardcodes the compact hero form interest to `set-completion`, even though the hero and first proof section now lead with seller fee economics.
- `deployables/public-web/app/routes.ts` routes `*` to `routes/not-found.tsx`, while live checks showed unknown pages render "Page not found" with HTTP 200. This creates soft 404 risk.
- The old public policy URLs `/buyer-protection` and `/seller-fees` render not-found content with HTTP 200 instead of redirecting to `/order-protection` and `/sales-fees`.
- `bounded-contexts/payments/docs/marketplace-checkout-fee-policy.md` requires buyer-side Marketplace Checkout Fee quoting before payment and notes launch review is needed before final buyer-facing copy.
- `bounded-contexts/marketplace/docs/marketplace-sales-fee-confirmation.md` says listing fee snapshots are account-confirmed and only certain listing changes refresh the snapshot.
- `docs/PRODUCT.md` says the product is optimized for high-volume, low-value cards, lower seller costs, efficient cart building, stable shipping costs, bulk workflows, and transparent pricing.
- Current official competitor fee pages make the seller economics wedge real: TCGplayer marketplace seller fees include marketplace commission plus transaction fee, eBay trading-card categories list final value fees, and Whatnot lists collectible seller commission plus processing fees.

## Resolved Decisions

- Keep product/runtime implementation inside Public Presence route/UI/localization/test files, with Public Web changes only for redirect/status/SEO behavior.
- Keep seller economics as the lead wedge. Supply acquisition is the critical cold-start constraint, and the current beta fee lock is the strongest differentiated claim.
- Balance the page with a concrete buyer proof section instead of making the hero equally split. Buyers need to see set-completion value, delivered total clarity, shipping credit, order processing disclosure, account trust, and order protection.
- Fix waitlist signal quality as a conversion requirement, not a back-office cleanup. The hero form must no longer silently report seller-led traffic as `set-completion`.
- Replace or supplement the high-value Pikachu-only proof with low-value card and bundle economics that match the product brief.
- Do not fabricate social proof. If no real waitlist count, seller count, transaction count, or Discord member count is available, use launch-stage proof: policies, economics, sample math, and clear workflow previews.
- Do not name competitors on the public page in this pass. Use competitor facts only to guide positioning unless legal/product explicitly approves direct comparison copy.
- Keep the buyer-side Marketplace Checkout Fee visible and plain. The page may say Chase Sets does not pass separate seller payment-processing fees to sellers, but must say buyers see Marketplace Checkout Fee / order processing before payment.
- Preserve account-language correctness where identity/capability is discussed, while allowing public marketing phrases like buyers, sellers, collectors, and founding sellers where they describe market-side posture.
- Prefer one primary CTA per decision area: join waitlist. Use Discord as a secondary community CTA only near the final call to action.

## Implementation Checklist

- [x] Fix wildcard not-found behavior so true unknown public routes return HTTP 404.
- [x] Add 301 redirects for `/buyer-protection` to `/order-protection` and `/seller-fees` to `/sales-fees`; preserve canonical URLs on the destination pages.
- [x] Update public-web tests to assert redirect destination and 404 behavior instead of only rendering not-found markup.
- [x] Change the above-the-fold waitlist form so it captures the strongest current intent accurately. The compact hero form now includes both `Marketplace intent` and `First priority`, defaulting to `low-sales-fees` when the page leads with seller economics.
- [x] Update waitlist UI tests so hero and final forms assert the intended default priority and do not regress into hidden `set-completion`.
- [x] Add a segmented early-page path for `Sell cards` and `Finish sets` that keeps the hero seller-led but lets buyers self-identify without scrolling through seller-only economics.
- [x] Add or retain low-value seller economics proof with `Marketplace Sales Fee`, seller payment-processing fee, seller net, and a note that shipping, taxes, rebates, and listing changes are separate.
- [x] Add a buyer proof section for set completion and delivered-total clarity: item subtotal, shipping estimate, 5% shipping credit, order processing quoted before payment, order protection, and estimated total.
- [x] Replace vague "faster listing" claims with workflow-specific copy: bulk listing, pricing context, Sell List / offer acceptance readiness, and fee-lock clarity.
- [x] Make the policy/support trust section stronger without becoming legalese: status, support email, no live transactions yet, policy pages, fee-lock terms before launch, and checkout review before payment.
- [x] Tighten meta description and Open Graph copy around the differentiated seller economics and buyer-visible totals.
- [x] Keep public info pages aligned with the landing page: FAQ, Order Protection, Marketplace Sales Fees, Terms, Refunds, Privacy, and Contact.
- [x] Verify mobile layout does not create horizontal overflow, especially around price math, form controls, listing cards, and long fee strings.

## Copy Strategy

- Hero: "Finish sets. Keep more card margin." remains strong; consider adding one subline that names the cold-start promise: "Founding sellers can lock beta listing economics while collectors get clearer delivered totals."
- Seller proof: lead with "Built for cards other marketplaces make hard to sell profitably." This states the wedge without naming competitors or overpromising exact post-beta economics.
- Buyer proof: frame as confidence and completion, not discounting: "See the card, account signal, shipping credit, order processing, and protection before payment."
- Waitlist CTA: "Join the waitlist" is fine, but nearby support copy should explain what happens next and why early signup matters.
- Trust copy: calm and specific; avoid alarmist language and avoid suggesting live marketplace transactions exist during prelaunch.

## Stress Tests

- Normal flow: visitor understands the seller wedge in the first viewport, submits email, intent, priority, and consent, and lands in a useful waitlist segment.
- Buyer flow: collector does not bounce after seller-led hero because buyer proof and self-identification appear early.
- Seller flow: high-volume seller sees a concrete economic reason to join and can understand fee-lock limits without legal ambiguity.
- Partial flow: visitor reaches old policy URL and is redirected instead of indexed into a not-found page.
- Stale data: waitlist updates remain duplicate-email safe because Public Presence already updates existing normalized email signups.
- Cross-context handoff: marketing copy does not imply Public Presence owns live listing, checkout, payment, or Discovery behavior.
- Failure/cancellation: no live transactions are promised; policy pages remain prelaunch and clearly say final terms publish before live payments.
- Low-value economics: examples should show how fixed processing fees and shipping economics matter on low-value cards, not only high-value singles.

## Verification

- [x] `pnpm --filter @chase-sets/public-presence run test`
- [x] `pnpm --filter @chase-sets/app-public-web run test`
- [x] `pnpm --filter @chase-sets/localization run test`
- [x] `pnpm --filter @chase-sets/public-presence run typecheck`
- [x] `pnpm --filter @chase-sets/app-public-web run typecheck`
- [x] `pnpm --filter @chase-sets/localization run typecheck`
- [x] `pnpm run check:localization`
- [x] `pnpm --filter @chase-sets/app-public-web run build`
- [x] `pnpm run verify:static`
- [x] Browser verification of public web at `http://localhost:10104/` on desktop and mobile viewports. Captures: `.codex/public-web-desktop.png`, `.codex/public-web-mobile.png`.
- [x] HTTP verification for `/`, `/order-protection`, `/sales-fees`, `/buyer-protection`, `/seller-fees`, and `/does-not-exist`.

## Documentation To Promote

- No durable architecture doc is required for copy-only marketing improvements.
- If the beta seller fee lock becomes a contractual launch rule, promote a Public Presence policy note and Commercial Terms/Marketplace documentation that explicitly defines beta eligibility, changed-listing behavior, fee-lock expiration, and post-beta schedule publication timing.
- If public buyer fee language changes materially, update Payments Marketplace Checkout Fee Policy after counsel/provider review.

## Open Questions

None blocking for the first implementation pass. The plan avoids direct competitor naming, fabricated social proof, exact beta duration, and final post-beta fee schedule promises.

## Goal Completion Criteria

- PR submitted for the completed implementation or scoped non-product change.
- CI passing on the PR before merge.
- PR merged after required review and passing checks.
- Staging deployment verified green after merge.
- Production deployment verified green after promotion or rollout.
