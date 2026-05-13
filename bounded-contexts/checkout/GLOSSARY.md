# Checkout Glossary

## Cart

A **Cart** is mutable saved purchase intent for one or more products before an active checkout session starts.

## Checkout Session

A **Checkout Session** is a short-lived active purchase workflow snapshot created from the cart, a buy-now action, or an offer-intent action.

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
