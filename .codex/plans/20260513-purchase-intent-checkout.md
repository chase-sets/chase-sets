# Purchase Intent Checkout

## Intent

Fold offer submission into the Checkout experience so a buyer expresses purchase intent through the same flow used to start, review, and confirm a purchase, instead of completing a full offer form on the product detail page.

The product detail page should stay a Discovery-owned browse and selection surface. It should hand off a resolved product, target offer price, and requested quantity to Checkout. Checkout should collect account/guest identity choices and shipping details, then submit the Marketplace-owned Offer as the final "place purchase intent" action when no immediately fulfillable purchase is being made.

## Worktree

- Path: `D:\Users\ToddS\Source\Repos\chase-sets-20260513-purchase-intent-checkout`
- Branch: `codex/purchase-intent-checkout`
- Base: current source repo `main` HEAD, commit `4f492f63`
- Sandbox id: `17e49c0a`
- Sandbox ports: marketplace web `http://localhost:7303`, platform API `http://localhost:7312`
- Dependency setup: `pnpm run deps:install` completed.
- Sandbox doctor: `pnpm run sandbox:doctor` completed.
- Setup caveat: repo wants Node `24.x`; current shell reports Node `v26.1.0`.
- Product code status: no product code changes during planning.

## Owning Contexts

- Checkout is the primary owner for the new buyer purchase-intent flow because Checkout owns "account purchase intent and the active purchase workflow before payment" and already owns Cart, Checkout Session, shipping address, fulfillment preview, and payment handoff.
- Marketplace remains the owner of Offer lifecycle, offer visibility, matching, acceptance, and the `marketplace.offer.submitted` fact. The Checkout flow must call a Marketplace API or consume a Checkout-published fact to create the Offer; it must not move Offer aggregate behavior into Checkout.
- Discovery owns the item detail entry point and should only create the handoff intent from product selection state. Discovery should not collect shipping destination fields or submit the Offer directly.
- Ordering should not own this flow until an offer is accepted or a normal checkout line becomes fulfillable. Existing Ordering behavior already treats accepted offers as `offer-acceptance` and checkout lines as `cart-checkout` or `buy-now`.
- Auth owns the registration, passwordless authentication, account-selection, session, and return-path continuation steps used inside the checkout-like purchase-intent flow.
- Identity owns the User, Account, Membership, Contact Method, Authentication Method, and reputation-ready account records created or claimed by the registration step.

## Repo Evidence

- `bounded-contexts/README.md` fixes Offer to Marketplace, Cart and Checkout Session to Checkout, and Order to Ordering.
- `bounded-contexts/checkout/README.md` says Checkout owns account purchase intent and active checkout before payment.
- `bounded-contexts/checkout/GLOSSARY.md` defines Cart as mutable saved purchase intent and Checkout Session as active purchase workflow from cart or buy-now.
- `bounded-contexts/marketplace/GLOSSARY.md` defines Offer as an account-submitted purchase proposal for a product, price, and quantity. It also says public offer rows must not expose shipping destinations.
- `bounded-contexts/discovery/GLOSSARY.md` says Detail Pages may show submitted Marketplace Offers as public product demand but do not own underlying transactions.
- `bounded-contexts/discovery/routes/item-detail.tsx` currently posts `intent=submit-offer` directly from item detail and passes `shippingDestinationSnapshot`, `priceAmount`, and `quantityRequested` to Marketplace.
- `bounded-contexts/marketplace/features/offers/ui/offer-submission-section.tsx` contains the over-large offer form with price, quantity, and full shipping fields.
- `bounded-contexts/checkout/routes/checkout-start.tsx` already accepts buy-now source intent through URL/form handoff and supports signed-in or guest checkout start.
- `bounded-contexts/checkout/features/sessions/domain/domain.ts` already has session lines, shipping address, shipping option, and `availabilityState: "waiting-for-supply"`.
- `bounded-contexts/checkout/features/sessions/ui/checkout-page.tsx` already renders unavailable lines and links buyers back to make an offer, which is a sign the UX is trying to bridge an availability gap but does not yet create purchase intent in place.
- `bounded-contexts/ordering/features/orders/api/runtime.ts` currently disables order creation when no active supply can fulfill a checkout line. That supports a separate "place purchase intent" outcome for no-supply lines rather than forcing Ordering to create an order.
- `bounded-contexts/auth/README.md` says Auth owns sign-in, registration, account-selection continuation, browser sessions, and return-path behavior.
- `bounded-contexts/identity/GLOSSARY.md` says Accounts own offers and even guest checkout users have an associated account.
- `bounded-contexts/auth/support/api-support/guest-checkout-routes.ts` already supports guest checkout start plus later claim by magic link or passkey.
- `bounded-contexts/auth/features/registration/ui/register-page.tsx` already supports passkey, magic-link, and password registration methods.

## Resolved Decisions

- Keep `Offer` as the Marketplace aggregate and submitted-offer read model. Checkout orchestrates capture; Marketplace remains the behavior owner.
- Add a Checkout source intent for buyer purchase intent instead of overloading cart or buy-now. Recommended name: `offer-intent`, shown to buyers as "purchase intent" or "offer" depending on surface.
- Product detail should hand off only product selection, requested quantity, and offer price. Shipping destination belongs in Checkout.
- Do not create an Order, Payment, or inventory Hold when the buyer places purchase intent. Submitted Offer remains marketplace-wide demand until a seller accepts it.
- Use Checkout's existing shipping address model as the source of the Marketplace `shippingDestinationSnapshot` when submitting the offer.
- Discovery's product detail UI should replace the full form with a compact action: price, quantity, and "Continue to checkout" or "Place purchase intent" handoff.
- Purchase intent should become a registration-oriented checkout journey. A buyer may start the flow from product detail without a full session, but the final Marketplace Offer must be attached to an Account so reputation can accrue.
- Passwordless authentication is the default for the registration step. Passkey is the default method, with a visible switch to magic link. Passwords remain a fallback only if the Auth-owned registration pattern keeps them available.
- Checkout final CTA should branch by session source:
  - cart or buy-now with fulfillable supply: continue to payment through Ordering and Payments.
  - offer-intent: submit Marketplace Offer and redirect to the submitted-offer detail or a checkout confirmation state.

## Recommendations

1. Extend Checkout source language.

Add `offer-intent` to Checkout Source Intent and Checkout Session source type. A source carries `catalogItemId`, `productId`, `itemTitle`, `itemSubtitle`, normalized `selectedOptions`, `productSummary`, `quantity`, and `offerPriceAmount`. The line should start with `availabilityState: "waiting-for-supply"` unless future logic intentionally allows the buyer to offer below available listing prices.

2. Add a Checkout offer-intent route contract.

Extend `/checkout/start` to accept `source=offer-intent`, preserving the current buy-now start pattern. Signed-in buyers continue directly to the checkout session. Signed-out buyers enter an Auth-owned registration step inside the checkout start experience, using passkey by default with magic link as the alternate passwordless path.

3. Add a Checkout finalization path for purchase intent.

On the checkout session page, when `source_type === "offer-intent"`, reuse the shipping form and replace payment controls with "Place purchase intent". The action should set shipping address, then call Marketplace `createSubmittedOffer` with:

- buyer account id from the authenticated or newly registered account
- catalog and product snapshot from Checkout session line
- price amount from the offer-intent source
- quantity requested from the line
- shipping destination snapshot from Checkout shipping address

4. Keep Marketplace validation authoritative.

Marketplace should keep validating active catalog item, product id, selected options, positive money, positive quantity, and shipping snapshot normalization. Checkout should validate enough for UX, but Marketplace remains the final aggregate guard.

5. Remove duplicate offer shipping UI.

Delete or retire the full product-detail offer form in Discovery and the Marketplace offer submission section once all entry points use Checkout. Keep Submitted Offers and Offer Matches account pages in Marketplace.

6. Add tests around the handoff and finalization.

Cover Discovery product-detail handoff, Checkout start preservation through sign-in, Checkout session source normalization, Checkout final "place purchase intent", Marketplace API call payload, and no Ordering/Payments call for offer-intent.

7. Reuse Auth/Identity registration behavior instead of inventing Checkout-owned identity.

Checkout should compose Auth registration or guest-claim APIs, not create users or accounts directly. Identity remains the source of User and Account facts; Auth remains the source of interactive session establishment.

## Stress Tests

- Normal flow: buyer selects product options, price, and quantity on item detail, checks out purchase intent, registers or resumes an account with passwordless auth, enters shipping, and gets a Submitted Offer.
- Existing supply: buyer can still buy now or add to cart. Offer-intent should be a separate buyer choice, not an automatic fallback unless explicitly selected.
- No supply: Checkout shows the session as waiting for supply and lets the buyer place purchase intent without creating orders or payments.
- Stale product selection: Marketplace rejects if product id no longer matches selected options; Checkout surfaces the validation message and lets the buyer return to item detail.
- Replay/idempotency: finalizing the same checkout session twice should return the same submitted offer or block duplicate submission. Implementation needs a stable source reference from Checkout to Marketplace, likely `checkoutSessionId`.
- Cross-context handoff: Checkout should not import Marketplace internals or Identity internals. Use Marketplace and Auth server/client APIs or stable integration facts.
- Accepted offer: Marketplace emits `marketplace.offer.accepted`; Ordering continues to create the later commitment from its existing accepted-offer path.
- Public visibility: shipping destination stays private. Discovery only projects public demand fields.
- Low-value card economics: purchase intent should keep shipping and payment out of the buyer's up-front burden until a seller accepts, preserving margin-sensitive demand capture while still collecting enough destination data for seller confidence and batching.

## Open Questions

### 1. Account requirement for placing purchase intent

Answered: The checkout process should include registration. Accounts need reputation, and passwordless should be the default.

Decision: Purchase intent may begin from a signed-out product detail handoff, but the final Submitted Offer must be attached to an Account through Auth/Identity registration or an existing session.

Consequence: The implementation should reuse Auth-owned registration, return-path, magic-link, passkey, and account-selection behavior. Marketplace does not need anonymous or guest-owned offer semantics in v1.

### 2. Default passwordless method inside checkout registration

Answered: Passkey should be the default, with switching to magic link allowed.

Decision: Purchase-intent checkout registration should default to passkey and keep magic link available in the same step.

Why it matters: Existing marketplace registration defaults to passkey, while guest-checkout claim supports both magic link and passkey. The default changes the first-run buyer experience, recoverability, and test surface.

Repo evidence: `auth/features/registration/ui/register-page.tsx` defaults general registration to passkey and offers magic-link/password alternatives. `auth/support/api-support/guest-checkout-routes.ts` supports claim-with-magic-link and claim-with-passkey. Identity glossary treats Contact Method and Authentication Method as separate identity concepts.

Consequence: This aligns purchase-intent checkout with the current registration UI while keeping magic link as the recovery path when passkey setup is not viable.

### 3. Implementation naming

Resolved by repo language: Use `offer-intent` for the Checkout Source Intent code value because the downstream Marketplace aggregate is still `Offer`. Use buyer-facing copy such as "purchase intent" and "place purchase intent" where the user is not choosing a specific seller or paying today.

### 4. Submission mechanism

Resolved by ownership: Use a Checkout request-support adapter that calls the Marketplace submitted-offer API during offer-intent finalization. Do not add a Checkout-to-Marketplace integration event for v1 because the buyer is waiting synchronously for confirmation and Marketplace already owns validation errors.

### 5. Remaining questions

No blocking product/domain questions remain before implementation.

## Implementation Checklist

- Update Checkout glossary and source intent docs to include `offer-intent`.
- Update Auth registration docs or route docs if the checkout-specific passwordless default differs from the general registration page default.
- Extend Checkout session domain/read model/API/client/start route for `offer-intent` source data.
- Compose Auth/Identity registration into Checkout start without moving identity creation into Checkout.
- Add source reference/idempotency from Checkout session to Marketplace offer submission.
- Update Checkout session UI for offer-intent review, waiting-for-supply copy, shipping capture, and final purchase-intent CTA.
- Add Checkout request-support adapter to submit Marketplace Offer without exposing Marketplace internals to Discovery.
- Update Discovery item detail to hand off offer-intent to Checkout and remove the full shipping form from item detail.
- Retire or repurpose `MarketplaceOfferSubmissionSection` if no account route still needs it.
- Add tests for Discovery handoff, Checkout start/session/finalization, Marketplace payload validation, and "no Ordering/Payments on offer-intent".
- Run context-focused tests plus structure checks.
- Verify mobile and desktop UI for item detail handoff, checkout start, and checkout session.

## Documentation To Promote

- `bounded-contexts/checkout/GLOSSARY.md`: add `Offer Intent` or expand `Source Intent` once naming is accepted.
- `bounded-contexts/checkout/README.md`: clarify Checkout owns capture of purchase intent, including offer-intent, while Marketplace owns Offer lifecycle.
- `bounded-contexts/auth/GLOSSARY.md` or context docs: clarify checkout registration continuation if the implementation introduces a named journey.
- `bounded-contexts/identity/GLOSSARY.md`: no term change needed unless the implementation introduces a special account status beyond existing guest checkout user/account language.
- `bounded-contexts/marketplace/GLOSSARY.md`: clarify Offers can be submitted through Checkout capture and remain Marketplace-owned.
- `docs/GLOSSARY.md`: add the accepted cross-context term if it becomes canonical.
- ADR not recommended yet. This is an ownership-preserving feature evolution, not a hard-to-reverse architecture decision.

## Goal Completion Criteria

The implementation goal should:

- Use this worktree and branch.
- Keep the retained plan at `.codex/plans/20260513-purchase-intent-checkout.md`.
- Implement Checkout-owned purchase-intent capture with Marketplace-owned Offer finalization.
- Promote accepted durable docs.
- Run automated tests and structure checks relevant to Discovery, Checkout, Marketplace, and Ordering.
- Run mobile and desktop visual verification for product detail, checkout start, and checkout purchase-intent session.
- Submit a PR.
- Confirm CI passes.
- Merge the PR.
- Verify the staging deploy behavior after merge.
