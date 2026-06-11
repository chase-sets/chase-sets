# Guest Rail Intent Persistence

## Purpose

The simplified item-detail action rail lets signed-out users express Buy, Sell, and Watch intent before registration. Checkout already owns anonymous Buy Cart and Sell List intent. Listing draft creation and Watch alerts need the same guest-first experience, but their durable facts belong to Marketplace and Discovery rather than Checkout.

This note selects the persistence mechanism for guest listing draft intent and guest Watch alert criteria so implementation can proceed without duplicating auth, URL, or storage patterns across contexts.

## Decision

Use context-owned anonymous intent records keyed by opaque HttpOnly SameSite cookies, with one-time account claim commands after registration.

- Marketplace owns anonymous listing draft intent because the preserved fact is future Listing draft/publication input.
- Discovery owns anonymous Product Alert intent because the preserved fact is future Product Alert creation.
- Auth carries only the safe `returnTo` continuation. Auth must not own listing draft or alert payloads.
- Checkout remains the owner of anonymous Buy Cart and Sell List only; do not put Listing draft or Product Alert records into Checkout.

The item-detail rail may redirect signed-out users to registration with a `returnTo` that points back to the owning context claim/review route. The `returnTo` should include only an opaque intent id and route state, not the full price, quantity, threshold, product options, shipping, contact, or commercial terms payload.

## Why Not Return Parameters Only

Return-parameter handoffs are useful for short checkout-start continuations, but they are not the primary mechanism for listing draft and Watch persistence.

Return parameters:

- expose business inputs in browser history, logs, copied links, and auth-provider continuations;
- are fragile when users refresh, open another tab, pause registration, or return later;
- force each route to rebuild tamper handling and stale recovery from client-supplied payloads;
- do not give operators a server-side place for expiration, dedupe, rate limits, or replay status;
- become awkward as listing draft facts grow beyond price and quantity.

## Why Not Stateless Signed Tokens

Signed stateless intent tokens reduce tampering risk, but they still require each owning context to implement claim, replay, stale recovery, telemetry, and limits. They also leave payload placement decisions in cookies or URLs and make operator cleanup harder.

Use signed tokens only as a supporting mechanism if a future route must prove an intent id was issued by the server. They should not replace context-owned anonymous intent records for this milestone.

## Existing Repo Evidence

- Checkout anonymous Buy Cart and Sell List use device cookies such as `chase_sets_anonymous_cart` and `chase_sets_anonymous_sell_list`, store server-side lines under anonymous owner ids, and merge into an account after sign-in.
- Marketplace Listing creation currently requires `listings.manage` and creates a draft or publishes only after account permission, inventory, ship-from, and fee validation.
- Discovery Product Alert creation currently requires `accounts.view` and creates account-owned alert records.
- Auth registration and sign-in already support safe relative `returnTo` continuations.

## Marketplace Listing Draft Intent

Marketplace should add an anonymous listing draft intent owner keyed by a cookie such as `chase_sets_anonymous_listing_drafts`.

The stored intent should include only draft input needed to resume the item-detail or account-listing flow:

- anonymous owner id
- intent id
- source route or catalog item slug for return
- catalog item id
- product id
- normalized selected options
- product summary
- intended price amount
- intended quantity cap
- optional purchase limits if the rail exposes them
- created, updated, expires, claimed, and claim target metadata

The anonymous listing draft intent must not store:

- account id before claim
- ship-from address
- seller contact details
- payout destination
- fee quote fingerprint
- private commercial agreement ids
- listing photos or asset-storage references unless a later slice explicitly designs anonymous media upload cleanup
- any public Listing status or Marketplace event that makes supply visible

Claim behavior:

- After registration/sign-in, Marketplace reads the opaque intent id plus the anonymous listing-draft cookie.
- Marketplace verifies the intent belongs to the cookie owner, is unexpired, unclaimed, and not replayed.
- Marketplace revalidates catalog item, product id, selected options, price, quantity, purchase limits, and current listing policy.
- If seller setup is incomplete, Marketplace should show a listing draft review/setup state with the preserved product, price, and quantity rather than publishing or creating seller-owned side effects.
- If an account draft can be created safely, create a Marketplace draft listing only after account permission and required Inventory/ship-from prerequisites are satisfied.
- Publication remains a separate account-gated action with current terms, inventory, photos, trust, and policy checks.

Replay and dedupe:

- Claim is idempotent for the same account and intent id.
- Duplicate active intents for the same anonymous owner, product, selected options, price, and quantity should update the existing intent rather than create unbounded records.
- Claimed or expired intents should fail closed to a recovery state that lets the user re-enter price and quantity.

## Discovery Watch Intent

Discovery should add an anonymous Product Alert intent owner keyed by a cookie such as `chase_sets_anonymous_product_alerts`.

The stored intent should include:

- anonymous owner id
- intent id
- source item route or slug for return
- market side: `listing` or `offer`
- catalog item id
- product id
- normalized selected options
- product summary
- threshold amount, when supplied
- created, updated, expires, claimed, and claim target metadata

The anonymous Watch intent must not store:

- account id before claim
- notification recipient or contact method
- private Marketplace Offer detail
- buyer identity beyond public item-detail facts
- shipping destination
- any notification delivery side effect

Claim behavior:

- After registration/sign-in, Discovery reads the opaque intent id plus the anonymous Product Alert cookie.
- Discovery verifies ownership, expiry, and replay status.
- Discovery revalidates catalog item, product id, selected options, alert side, and threshold.
- Discovery creates the account-owned Product Alert only after account access is available.
- If product state or threshold is stale, Discovery returns to the item-detail Watch rail with the preserved visible criteria where safe and a recovery message.

Replay and dedupe:

- Claim is idempotent for the same account and intent id.
- Duplicate active intents for the same anonymous owner, product, side, and threshold should update the existing intent.
- Product Alert notifications must not be emitted until after the account-owned alert is created.

Implemented Watch guardrails:

- The `chase_sets_anonymous_product_alerts` cookie and the server-side anonymous Product Alert intent expire after 30 days.
- Each anonymous Product Alert cookie can hold up to 20 active Watch intents.
- Active intents dedupe by anonymous owner, market side, catalog item, product id, normalized selected options, and threshold amount. Saving the same criteria updates source path, product summary, expiry, and updated timestamp instead of creating another record.
- The registration return URL carries only `/items/<slug>?market=watch&claimProductAlertIntent=<intentId>`.
- A signed-in claim must present the matching anonymous Product Alert cookie. Missing, expired, claimed-by-another-account, or stale intents return the user to the Watch rail with recovery copy instead of creating a Product Alert.
- Same-account claim replay is idempotent. Different-account replay fails closed.

## Expiration And Limits

Use the same user-facing persistence horizon as anonymous Buy Cart and Sell List unless a narrower slice chooses a stricter limit: 30-day cookies with server-side expiry no longer than 30 days.

Implemented limits:

- Anonymous Buy Cart has a 50-line per-device cap. Duplicate or mergeable lines remain allowed at the cap so a quantity adjustment does not force users to delete and recreate intent.
- Anonymous Sell List has a 50-line per-device cap. Duplicate selected-offer or product lines remain allowed at the cap for the same reason.
- Marketplace listing draft intents use 30-day cookie/server TTL, 20 active intents per anonymous listing-draft cookie, identical-criteria dedupe, and one-time claim.
- Discovery Watch intents use 30-day cookie/server TTL, 20 active intents per anonymous Product Alert cookie, identical-criteria dedupe, and one-time claim.
- Anonymous rail capture write routes are throttled per public client key in-process at 30 requests per 10 minutes for Buy Cart, Sell List, listing draft intent, and Watch intent capture.
- Public standard seller-terms preview is throttled per public client key in-process at 120 requests per 10 minutes.
- Public client keys prefer `x-forwarded-for`, then `cf-connecting-ip`, then `x-real-ip`, and fall back to `local` in development or direct tests.
- In-process rate-limit buckets are bounded and expire by window. The limits provide immediate application-side protection; edge or durable distributed throttling can be added later if production traffic requires cross-instance enforcement.
- Rate-limited routes return HTTP 429 with `Retry-After` and customer-safe recovery copy. Oversized anonymous carts or Sell Lists return a recoverable validation error that asks the user to remove an item before adding another.

Cleanup behavior:

- Marketplace listing draft and Discovery Watch runtimes mark stale active intent records as `expired` before active-count checks and claim lookups. Expired rows remain available for bounded recovery/debugging until a future retention job physically deletes them.
- Checkout anonymous Buy Cart and Sell List rows remain tied to their anonymous owner ids until the user removes lines, merges into an account, or a future retention job prunes abandoned anonymous owners.
- The route throttles are intentionally side-effect-free: a 429 response does not create or mutate Cart, Sell List, listing draft, Watch, Product Alert, Listing, Offer, payout, notification, order, or payment records.
- #1188 owns funnel analytics. Any telemetry added there for saved, claimed, expired, deduped, rate-limited, stale-recovered, or preview-throttled outcomes must avoid PII, private shipping/contact facts, account-specific agreement ids, fee quote fingerprints, and high-cardinality monetary values unless policy explicitly allows them.

## Public Standard Terms Preview Boundaries

The public standard seller-terms preview exists to support guest selected-offer payout estimates before a seller account is attached.

It may expose display-safe standard terms facts:

- basis amount
- marketplace sales fee amount
- estimated seller net amount
- shipping allowance percentage
- public standard source kind and source label
- display schedule label
- source and resolution timestamps

It must not expose:

- fee quote fingerprints
- schedule ids
- account-specific agreement ids
- buyer or seller private facts
- contact details
- shipping destination details
- payout destination details

Guest previews are informational only. Registered seller review must resolve current account-specific terms before offer acceptance, listing publication, payout, or seller checkout commitment.

Cache behavior:

- The route does not introduce a durable response cache. Callers should treat the preview as a current display estimate and refresh it during review.
- Future edge or client caching is allowed only for the display-safe response shape above and must respect the same request limit and privacy boundary.

## Privacy And Security

Anonymous intent ids are bearer references scoped by the HttpOnly cookie owner. A copied claim URL without the matching cookie must not claim the intent.

Context claim routes must:

- trust only server-side stored intent records, not query payloads;
- revalidate every product, price, quantity, threshold, and policy input;
- keep contact, shipping, payout, account-specific terms, fee fingerprints, and alert recipient data out of anonymous records;
- mark successful claims so replay does not create duplicate listings or alerts;
- expose only customer-safe recovery details on failure.

## Registration Return Contract

The rail should create the anonymous intent first, then redirect to registration/sign-in with a safe relative `returnTo`. The route target must be URL-encoded when embedded in the registration or sign-in URL.

Decoded return targets:

- Listing draft: `/account/listings?claimListingIntent=<intentId>`
- Watch alert: `/items/<slug>?market=watch&claimProductAlertIntent=<intentId>`

Encoded registration URLs:

- Listing draft: `/register?returnTo=%2Faccount%2Flistings%3FclaimListingIntent%3D<intentId>`
- Watch alert: `/register?returnTo=%2Fitems%2F<slug>%3Fmarket%3Dwatch%26claimProductAlertIntent%3D<intentId>`

The exact route can change during implementation, but the payload rule cannot: only opaque intent ids and UI route state belong in `returnTo`.

## Implementation Consequences

#1185 should implement Marketplace anonymous listing draft intent storage, claim/review behavior, stale recovery, and registration return for listing price and quantity.

#1187 should implement Discovery anonymous Product Alert intent storage, claim behavior, stale recovery, and registration return for listing/offer Watch criteria.

#1192 should cover shared guardrails for all expanded anonymous rail intent: Buy Cart, Sell List, listing drafts, and Watch alerts.

#1186 should treat listing draft and Watch claim routes as first-class registration-return paths alongside anonymous Sell List merge.
