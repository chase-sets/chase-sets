# Offer Abuse Controls

Marketplace owns offer abuse controls because offers and offer matches are Marketplace behavior before an order exists.

## Active policy

Policy version: `marketplace-offer-abuse-controls-v2`

Defaults:

- Buyer daily offer submission cap: `25` submitted offers per rolling 24 hours.

## Scope

Offers are product-scoped, marketplace-wide demand. There are no seller mutes, price floor, per-Listing submission cap, or lowball cooldown. Every seller with matching active supply sees an Offer regardless of its price, subject to the existing currency, managed-policy, and supply gates.

A Decline privately hides only that Offer from that seller across their matching Listings. Other sellers still see it. Declines do not count toward a buyer limit or start a cooldown. Stored mute, unmute, and cooldown-bearing Decline events continue to replay unchanged, but legacy control rows no longer filter Matches and new Declines carry no cooldown.
