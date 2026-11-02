# Checkout Glossary

## Cart

A **Cart** is mutable saved purchase intent for one or more products before an active checkout session starts.

## Cart Claim

A **Cart Claim** is an Account taking ownership of an existing anonymous Cart so its lines resolve for that Account without being copied.

Notes:

- The claimed Cart keeps its own source identity; claiming moves ownership, not lines.
- One Account owns a claimed Cart; a second Account cannot take it over.
- Clearing or checking out a claimed Cart empties its lines and leaves the claim in place.

## Checkout Command Attempt

A **Checkout Command Attempt** is one deliberate Cart change, named by an attempt id the caller mints when it submits, that the owner applies at most once and answers with the same recorded result every time it is presented again.

Notes:

- The attempt is recorded in the same all-or-nothing write as the Cart changes it decides, so a recorded attempt and its Cart changes exist together or not at all.
- A lost response is resolved by looking the attempt up, never by sending a new change; an attempt the owner has not observed stays ambiguous until the buyer explicitly sends the same attempt again.
- Presenting an attempt id with a different request, owner, kind or target never replays another result.

## Sell List

A **Sell List** is mutable saved seller intent for one or more Products before selected offers, Smart Match offers, or fallback listings become sale commitments.

Notes:

- Sell List is owned by Checkout because review, payment readiness, ordering, payout, and fulfillment orchestration follow the checkout-plan shape.
- Marketplace remains the owner of Offer acceptance and Listing lifecycle commands.
- Sellers should see Sell List language, not cart language.

## Smart Match

**Smart Match** is the user-facing label for Checkout-owned matching and optimization settings over product-level Cart or Sell List lines.

Examples:

- Smart Match listings for Buy Cart product lines.
- Smart Match offers for Sell List product lines.

## Checkout Session

A **Checkout Session** is a short-lived active purchase workflow snapshot created from the cart, a buy-now action, or an offer-intent action.

## Checkout Closed

**Checkout Closed** is the temporary refusal of new buying, expressed by the public `checkout_closed` response. Existing Checkout Sessions are retained; reads, eligible cancellation, and settlement already in progress remain available.

## Checkout Reservation

A **Checkout Reservation** is a checkout-purpose Inventory hold created per buy-checkout line when the buyer reaches the payment step.

Notes:

- Checkout Reservations are not created when an item is added to the cart.
- Checkout Reservations expire if the buyer abandons checkout before order creation.
- Order creation converts Checkout Reservations to order holds without releasing and replacing the stock commitment.

## Cancel Checkout

**Cancel checkout** is the session owner's action, on the checkout page and the Checkout session API's `cancel` route, that releases every active Checkout Reservation of a session holding only reservations and records the session cancelled. A repeat answers already-cancelled and releases nothing. Once the session has created orders, started payment or placed purchase intent, Cancel checkout is refused: those holds are released only by cancelling the purchase in Ordering, or by Payments reporting the payment terminal.

## Source Intent

**Source Intent** describes how a checkout session began: cart checkout, buy now, or offer intent.

## Offer Intent

An **Offer Intent** is a Checkout-owned source intent that captures a buyer's desired product, offer price, quantity, account registration state, and shipping destination before submitting a Marketplace-owned Offer.

Notes:

- Offer Intent does not create an order, payment, or inventory hold.
- Offer Intent finalization submits an Offer through Marketplace, which remains the owner of offer lifecycle, visibility, matching, and acceptance.
- Buyer-facing UI may describe this as placing purchase intent.

## Selected Shipping Option

A **Selected Shipping Option** is the buyer's chosen shipping preference for the checkout session before orders are created.

## Trusted Checkout Handoff

A **Trusted Checkout Handoff** is a Checkout-owned continuation URL that lets an agent-prepared checkout session move into Chase Sets UI for buyer review and order placement.

Notes:

- UCP checkout completion returns a Trusted Checkout Handoff; the buyer confirms orders and payment in Chase Sets UI.
- Checkout remains the owner of session state, source intent, shipping selection, and orchestration into Ordering and Payments.
