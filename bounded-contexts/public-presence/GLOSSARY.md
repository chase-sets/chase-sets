# Public Presence Glossary

## Public Presence

Public Presence is the product-facing surface that explains Chase Sets before marketplace launch.

## Waitlist Signup

A **Waitlist Signup** is a request for Chase Sets early access, qualified by account intent and product interests. Joining implies consent to early-access emails; consent to additional product updates beyond early-access notifications is a separate, optional opt-in.

Notes:

- Waitlist Signup is owned by Public Presence.
- Duplicate normalized email submissions update the existing signup.
- Waitlist Signup is not an Account, User, Buyer, or Seller.

## Promo Bar Message

A **Promo Bar Message** is public marketplace copy shown in the site promo bar to communicate temporary or evergreen marketplace-wide information.

Notes:

- Promo Bar Messages are owned by Public Presence.
- Promo Bar Messages may link to public policy or explanation pages, but they do not own fee, listing, order, payment, or fulfillment policy truth.
- Multiple active Promo Bar Messages can cycle in display order on public marketplace pages.

## Cohort Quality Signal

A **Cohort Quality Signal** is a wave-1 campaign field captured only from sell/both-intent Waitlist Signups: the games the signer-upper sells, whether they already have an existing online store link, and a bucketed self-reported inventory size.

Notes:

- Cohort Quality Signals are owned by Public Presence, stored on the Waitlist Signup read model.
- Never a condition of joining the waitlist; every field is optional and defaults to "unset" rather than blocking signup.
- Feeds the Wave-1 Admission Bar and the Campaign Analytics dashboard; not a Seller, Listing, or Inventory record in the Marketplace/Inventory bounded-context sense.

## Qualified Seller Signup

A **Qualified Seller Signup** is a sell/both-intent Waitlist Signup whose Cohort Quality Signal names at least one game and a real (non-empty) inventory-size bucket.

Notes:

- Sell/both intent alone does not make a signup "qualified" -- it must also carry real cohort quality data.
- The unit the Wave-1 Admission Bar counts against `WAVE_ONE_ADMISSION_BAR.minQualifiedSellers` and per-game coverage thresholds.

## Wave-1 Admission Bar

The **Wave-1 Admission Bar** is the pre-declared, campaign-day-one pass/fail threshold (issue #4071 / m104 #4061) that turns "did the campaign work" into a measurement: a minimum count of Qualified Seller Signups, per-game coverage across all five supported games, and an overall Waitlist Signup floor.

Notes:

- Defined in `bounded-contexts/public-presence/features/waitlist/read-model/campaign-admission-bar-policy.ts`; business-literal thresholds live there, not scattered across call sites.
- Surfaced live on the Campaign Analytics admin page and recorded in m104 #4061.

## Campaign Channel Attribution

**Campaign Channel Attribution** is the durable per-channel breakdown of Waitlist Signups, grouped by the UTM source/medium/campaign captured at signup time.

Notes:

- Read from the durable Waitlist Signup read model (transactional truth), distinct from the directional funnel-event telemetry Grafana/Loki visualizes (see `bounded-contexts/public-presence/docs/landing-page-analytics.md`).
- Surfaced on the Campaign Analytics admin page alongside the Wave-1 Admission Bar.
