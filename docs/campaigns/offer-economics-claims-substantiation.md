# Offer Economics Claims Substantiation

Tracks issue #4075 (epic #4076, GTM & Founders Offer). This is the truth gate for the beta campaign: **public campaign copy and landing pages may only cite a claim below marked Substantiated, using the exact wording given.** A claim marked Softened may only run in its softened form. A claim marked Dropped must not appear anywhere in campaign copy until this document is revised.

Live numbers for the "Lower fees" and "Better protections" claims are read from the [offer-economics monitor](../../bounded-contexts/platform-operations/features/offer-economics) (admin route `/insights/offer-economics`, MCP tool `platform-operations.get-offer-economics-summary`) — see [Offer Economics Monitor](../../bounded-contexts/platform-operations/features/offer-economics/read-model/offer-economics-policy.ts) for the computation. That monitor tracks the founders 0%-locked-fee cohort's listing volume, GMV share of the platform, and foregone-fee estimate against the published standard schedule, so "did the offer cost what we modeled" and "is the fee claim still true" are both answerable from the same source.

## Review status as of 2026-07-12 (founders-lock row re-reviewed 2026-07-17 — see Claim 1a)

| Claim | Status | Reason |
|---|---|---|
| "Lower fees" | **Softened** | Ratified target numbers (#4066) are not live; today's schedule is close to, not clearly below, TCGplayer/eBay at the low end. |
| "Founders lock 0% for 60 days" | **Substantiated (offer terms only)** | Admission automation, agreement creation, activation-triggered numbering/cap, and buyer-facing badge display all shipped and verified in code (#4068, #4887 both closed). No cohort-activity numbers ("N founders locked in") until the offer-economics monitor reports a real non-zero cohort — the mechanism is a code-readable fact, but no wave has been admitted yet. |
| "Better protections" | **Substantiated** | Every covered order records a replay-safe 1% protection-reserve contribution with its allowance/overage funding split; buyers never see a separate protection fee line. |
| "Supports graded cards" | **Softened** | Cert-numbered slab data is enforced end-to-end via the API/import path; there is no listing-create UI form for it yet, and no per-grade pricing exists anywhere. |
| "Open offers" | **Substantiated** | The shipped offer aggregate is catalog/product-backed, any eligible non-self seller with matching active supply can accept, and acceptance publishes the handoff consumed by Checkout and Ordering. |
| Market-data numbers | **Dropped outside production** | The generator is repeatable and stat-hygiene-gated, but fixture and staging rows are representative data, not public marketplace activity. |

---

## Claim 1 — "Lower fees"

**Ratified target (Todd, 2026-07-03):** flat 5% seller fee, $0 fixed, capped at $25/item (#4066), substantiated against PayPal Goods & Services at both ends of the price curve — no fixed fee beats G&S's ~13% effective rate on a $5 card, and the $25 cap beats G&S's uncapped 3.49% above ~$700. Approved wording once live: **"Half of what major platforms take"** plus an end-to-end value comparison against G&S. Approved wording explicitly **excludes** "cheaper than G&S everywhere" — G&S is roughly $1 cheaper than the ratified schedule in the ~$100 mid-range, so protections (Claim 3) have to carry that part of the argument, not the fee number.

**Current reality (verified against code, 2026-07-12):** the ratified schedule is not shipped. `bounded-contexts/commercial-terms/support/runtime-support/terms-policy.ts` seeds the live schedule at 900 bps ($0.15 fixed) for personal accounts and 850 bps ($0.10 fixed) for business accounts, **not** 500 bps / $0.00 / $25 cap. There is no cap field on the Commercial Terms schedule/agreement model at all (#4099, open) — a $25/item cap cannot be quoted because the field doesn't exist yet. #4066 (the ratification-to-code slice) and #4099 (the cap-threading slice) are both open, unimplemented, with no PR against either as of this review.

**Ruling: Softened.** Do not cite "half of what major platforms take," "$25 cap," or any specific comparison number in campaign copy until #4066 and #4099 both ship and the offer-economics monitor's `standardScheduleSource` reflects the ratified schedule (`resolveStandardScheduleTerms` will report `marketplaceSalesFeePercentageBps: 500`, `marketplaceSalesFeeFixedAmount: "0.00"` once seeded). Until then, campaign copy may say only the qualitative, currently-true statement: **"No listing fees, no fixed per-item charge on our published rate — you only pay when you sell."** (True today: the live personal schedule has no fixed *listing* fee, only a percentage-plus-small-fixed *sale* fee; do not imply the fee is capped or state a specific percentage.)

**Unblock:** #4066 (ratification-to-seed) and #4099 (cap threading) both merge; re-run this review, confirm the monitor's `resolveStandardScheduleTerms` reports 500 bps / $0.00 / and (once #4099 also lands) a $25 cap; promote to Substantiated with the exact ratified wording above.

## Claim 1a — "Founders lock 0% for 60 days"

This is not one of the three claims named in #4075, but it is the central campaign hook (epic #4076) and shares the same fee-lock substantiation chain, so it is reviewed here rather than left implicit.

**Mechanism (real, per #4068's own capability audit):** the founders 0% entitlement does not need new fee machinery — a founder's 0% window is an ordinary Commercial Terms **agreement** (`{percentageBps: 0, fixedAmount: "0.00", effectiveFrom, effectiveUntil}`), the same account-level override primitive used for any negotiated rate. The listing-time snapshot on `marketplace_listing_pages` (`terms_agreement_id`, `marketplace_sales_fee_unit_amount`) is the existing fee-lock primitive; a listing created while a 0%/0-fixed agreement is active locks `marketplace_sales_fee_unit_amount = 0` permanently, independent of later rate changes. The offer-economics monitor's cohort query (`getLockedFeeListingCohortSummary` in `bounded-contexts/marketplace/features/listings/read-model/queries.ts`) reads exactly this: listings with a non-null `terms_agreement_id` and a zero locked fee.

**Current reality (re-verified against code, 2026-07-17):** #4068 (admission automation, activation-triggered numbering/cap, agreement creation) and #4887 (buyer-facing badge display) — the "actual gaps to build" this row was previously gated on — have both since CLOSED, and the chain is verified end-to-end in code, not just by issue state:

- **Admission automation:** `bounded-contexts/public-presence/features/waitlist/api/runtime.ts`'s admin-gated `admitWave` batch command (behind `public-presence.manage` permission) admits a wave cohort; registration's `requireRegistrationAdmission` (`bounded-contexts/auth/support/api-support/registration-gates.ts`) resolves the admitted signup and threads `foundersBetaAccessStartedAt` through to `identity/api.ts`, which issues `OpenFoundersWindow`.
- **Agreement creation:** `bounded-contexts/commercial-terms/features/agreements/integrations/identity/founders-window-reaction.ts` reacts to `identity.account.founders-window-opened` and creates a real Commercial Terms agreement (`marketplaceSalesFeePercentageBps: 0`, `marketplaceSalesFeeFixedAmount: "0.00"`, `effectiveFrom`/`effectiveUntil` spanning the 60-day window) via the generic `agreements.createAgreement`.
- **Activation, numbering, and the 500 cap:** `bounded-contexts/identity/features/founders-cohort/domain/domain.ts` defines `FOUNDERS_COHORT_CAP = 500` and a `ClaimFounderNumber` decider on one global stream (rejects claims once the cap is hit); `bounded-contexts/identity/features/founders-cohort/integrations/marketplace/founder-claim-reaction.ts` reacts to `marketplace.listing.created`/`marketplace.offer.submitted`, guarded on an existing founders window, and assigns the number + `AssignAccountBadge` on the account's first qualifying event.
- **Buyer-facing badge display:** `bounded-contexts/discovery/features/item-detail/ui/account-badges.tsx` renders a numbered `FounderBadge` (e.g. "Founder #047") alongside the trusted-seller badge, and `bounded-contexts/discovery/routes/public-account.tsx` renders the same numbered badge on the public profile. `manual-payout-review` remains confirmed absent from every buyer-facing surface — only `founding-account` reverses the prior internal-only ruling, per #4887's scope.
- **Cohort is correctly still empty:** the offer-economics monitor's `getLockedFeeListingCohortSummary` (`bounded-contexts/marketplace/features/listings/read-model/queries.ts`) reports an all-zero cohort today — no seed/fixture data injects a fake count, and no wave has been admitted yet (Wave 1 opens 2026-07-20 per the campaign clock, #4060).

**Residual gap, tracked separately (does not block this ruling):** the registration admission gate (`requireRegistrationAdmission`) treats *any* truthy pending-invitation id as founders-qualifying, including an ordinary team-member invitation, not only a waitlist-wave admission — a real scoping gap worth a follow-up issue against #4068's admission guard. It does not make the wording below untrue for a legitimately wave-admitted seller, so it does not block this claim's promotion, but it is out of this doc's docs-only footprint to fix.

**Ruling: Substantiated — offer terms only.** The mechanism, admission path, activation trigger, numbering, cap enforcement, and buyer-facing badge display are all live in production code, so the *offer's terms* are now a static, code-readable fact — the same promotion basis used for Claim 3's cert-number enforcement (real, enforced mechanism; the gap that remains is a different kind of claim entirely). Approved wording: **"Beta access opens a 60-day 0% seller-fee window — every listing you create in that window locks 0% until it sells."** and **"The first 500 accounts to list or make an offer claim a numbered founder badge, publicly displayed."** Do not say "permanent" or otherwise imply the badge or its display can never be revoked or changed: the ratified scope (#4887) is public *display*, not a permanence guarantee. (This can be revisited and "permanent" restored if Todd separately ratifies that as a durability promise; nothing in #4887 makes that claim today.) Do not claim "N founders locked in," a specific claimed-count, or any live cohort activity — that remains gated on the offer-economics monitor reporting a real, non-zero, non-test cohort.

**Unblock (for the still-gated cohort-activity claim only):** Wave 1 admission runs and at least one real founder agreement/badge is claimed; word cohort-activity copy from the offer-economics monitor's own numbers going forward (`listingsCreatedCount > 0`), no separately-maintained count.

## Claim 2 — "Better protections"

**Original substantiation plan (per #4075's own 2026-07-03 update):** every order was to contribute 1% of item value to a protection reserve (allowance-first, buyer-overflow split, per #4098), independent of seller fees — specifically designed so the claim survives the 0% founders cohort (a fee-funded protection promise would be undermined by a 0%-fee cohort; a reserve funded from the shipping-allowance economics is not).

**Current reality (verified against code, 2026-07-12):** Ordering snapshots a 1% Order Protection amount and its allowance/overage funding split. Settlement records one idempotent contribution fact per captured order and proportional, cumulative refund reversal facts that converge exactly on the original split for a full refund. The offer-economics monitor reads the resulting net reserve totals from Settlement.

**Ruling: Substantiated.** Approved wording: **"Every order includes Order Protection — funded at 1% of item value and never itemized as a separate buyer fee."**

The monitor reports net contribution, allowance-funded share, overage-funded share, reversals, and covered-order count for the selected window.

## Claim 3 — "Supports graded cards"

**Scope required by #4075:** state precisely what beta supports — cert-numbered slab listings, per-grade pricing — and drop or soften whatever isn't true today.

**Current reality (verified against code, 2026-07-12):**

- **Cert-numbered slab listings: real, enforced.** `bounded-contexts/inventory/features/inventory-items/domain/domain.ts` defines `GradedCardDetails` (gradingCompany, grade, certificationNumber, population, conditionDescriptors). `bounded-contexts/marketplace/features/listings/domain/domain.ts` defines `MarketplaceGradedCardDetails` plus a `marketplaceGradingCompanyPolicies` table covering PSA/BGS/CGC/SGC with per-company certification-number regex validation and numeric grade normalization (1–10 in 0.5 steps, including label aliases like "Gem Mint 10"). Publishing a graded listing **requires** a certification number (validated against the grading company's pattern) and a slab photo (`domain.ts`: "graded-card listings must include a slab photo"). This is real, live, enforced domain behavior, not aspirational.
- **Gap: no listing-create UI form.** `marketplace/features/listings/ui/listing-create-page.tsx` has no gradingCompany/grade/certificationNumber input fields — a seller cannot create a graded listing through the standard web UI today, only through the API/import path. The listing-detail page also does not render graded-card data. This is a real functional gap between "the domain supports it" and "a seller can use it."
- **Per-grade pricing: does not exist.** Pricing's repricing-policy domain (`bounded-contexts/pricing/features/repricing-policies/domain/domain.ts`) has only a boolean `{ type: "item-grading"; grading: "graded" | "raw" }` condition — raw vs. graded, never a specific numeric grade or grading company. No table anywhere ties a price or market-rollup row to a grade. "PSA 10 price" cannot be queried separately from "PSA 9 price" for the same card; only one blended market price exists per catalog item regardless of grade.

**Ruling: Softened.** Approved wording: **"Beta supports graded-card listings — PSA, BGS, CGC, and SGC certification numbers, validated, with slab photos required."** Do not say "list your graded cards" as a call-to-action implying self-serve UI (there isn't one yet — route graded-card sellers to the import/API path or a manual onboarding assist). Do not claim or imply per-grade pricing, price guides, or "PSA 10 market data" in any form — say nothing about pricing granularity for graded cards rather than imply a capability that doesn't exist.

**Unblock (two independent items, either can ship first):**
1. A listing-create UI form gains grading fields → promote the "list your graded cards" call-to-action to Substantiated.
2. Pricing gains a per-grade dimension on market-rollups/trades → a new, separate claim ("PSA 10 pricing data") becomes reviewable; this document does not pre-approve wording for it.

## Claim 4 — "Open offers"

**Current reality (verified against code and merged PR #4945, 2026-07-12):** a submitted offer records a catalog item, resolved product, price, quantity, and shipping-destination snapshot. It is marketplace-wide rather than addressed to a named seller. Acceptance rejects the buyer's own account, unavailable seller accounts, and sellers without matching active supply; it snapshots the seller's fee terms and emits `marketplace.offer.accepted`. Checkout consumes that event into its accepted-offer page and Ordering consumes it into its offer-acceptance input. Acceptance is therefore the start of the real checkout/order handoff, not a claim that payment has already completed.

**Ruling: Substantiated.** Approved wording: **"Post an open offer for a catalog item at the price you'll pay. Any eligible seller with matching active supply can accept it; acceptance starts the checkout and order handoff with fee terms recorded."** The shorter approved CTA is **"Post an open offer for the card you want — any matching seller can accept it."**

Do not claim a seller-match count, time-to-fill, expiry behavior, completed payment at acceptance, or live offer activity unless a separate production evidence source substantiates it.

## Claim 5 — market-data numbers

**Current reality:** Pricing's Trades Tape contains completed, non-excluded marketplace trades. Its Daily Product Rollup and Market-State Snapshot query API exposes product-level weekly medians, counts, active asks, open offers, and spreads. The query API suppresses medians below the live Stat-Hygiene Policy's minimum sample. It does **not** expose a game/category-wide rollup or a per-grade dimension.

**Ruling: Dropped outside production.** Fixture and staging output may be used to rehearse layout and cadence only. It must retain the generator's `DO NOT PUBLISH` banner. Production output from `pnpm run campaign:market-data` may use only the generated wording after operator review; do not hand-edit numbers, remove the source note, describe a product as the whole game's market, or claim grade-specific pricing. Approved attribution: **"Data from the Chase Sets catalog. Product-level marketplace activity; not a game-wide price index or per-grade price guide."**

---

## Revision log

- **2026-07-17** — Re-ran Claim 1a ("Founders lock 0% for 60 days") against current shipped state per #5579: #4068 and #4887 both closed since the 2026-07-12 review; verified end-to-end in code (admission automation, agreement creation, activation-triggered numbering/cap, buyer-facing badge display) rather than trusting issue state alone. Promoted from Dropped (pre-launch) to Substantiated (offer terms only) — cohort-activity numbers stay gated on real, non-zero monitor data. Softened the badge wording's "permanent" to "publicly displayed" to match #4887's ratified scope.
- **2026-07-12** — Added the open-offer mechanics ruling and the production-only market-data gate for #4073; exact wording follows the shipped offer flow and Pricing's m111 query boundary.
- **2026-07-12** — Initial review (this document). All three named claims plus the implicit founders-lock claim reviewed against shipped code; none promoted to full Substantiated. Offer-economics monitor (#4075) shipped alongside this review as the live-data source for Claims 1 and 1a going forward.

## Process

Re-run this review whenever any of #4066, #4068, #4098, or #4099 ships, or whenever campaign copy wants to cite a new number. A claim only moves to Substantiated when:

1. The underlying mechanism is live in production code (not just ratified in an issue comment), and
2. Either the offer-economics monitor reports a real, non-placeholder number for it, or the claim is a static policy fact directly readable from shipped code (as with Claim 3's cert-number enforcement).

Campaign copy that cites a claim not marked Substantiated in the current revision of this document is out of policy, regardless of what an earlier revision said.
