# Offer Economics Claims Substantiation

Tracks issue #4075 (epic #4076, GTM & Founders Offer). This is the truth gate for the beta campaign: **public campaign copy and landing pages may only cite a claim below marked Substantiated, using the exact wording given.** A claim marked Softened may only run in its softened form. A claim marked Dropped must not appear anywhere in campaign copy until this document is revised.

Live numbers for the "Lower fees" and "Better protections" claims are read from the [offer-economics monitor](../../bounded-contexts/platform-operations/features/offer-economics) (admin route `/insights/offer-economics`, MCP tool `platform-operations.get-offer-economics-summary`) — see [Offer Economics Monitor](../../bounded-contexts/platform-operations/features/offer-economics/read-model/offer-economics-policy.ts) for the computation. That monitor tracks the founders 0%-locked-fee cohort's listing volume, GMV share of the platform, and foregone-fee estimate against the published standard schedule, so "did the offer cost what we modeled" and "is the fee claim still true" are both answerable from the same source.

## Review status as of 2026-07-12

| Claim | Status | Reason |
|---|---|---|
| "Lower fees" | **Softened** | Ratified target numbers (#4066) are not live; today's schedule is close to, not clearly below, TCGplayer/eBay at the low end. |
| "Founders lock 0% for 60 days" | **Dropped (pre-launch)** | No admission flow exists yet to grant a founder a 0% agreement; the mechanism is real (Commercial Terms agreements) but unused. |
| "Better protections" | **Softened** | The protection-reserve funding mechanism (#4098) that was supposed to substantiate this claim is not implemented; fall back to policy-text framing only. |
| "Supports graded cards" | **Softened** | Cert-numbered slab data is enforced end-to-end via the API/import path; there is no listing-create UI form for it yet, and no per-grade pricing exists anywhere. |

---

## Claim 1 — "Lower fees"

**Ratified target (Todd, 2026-07-03):** flat 5% seller fee, $0 fixed, capped at $25/item (#4066), substantiated against PayPal Goods & Services at both ends of the price curve — no fixed fee beats G&S's ~13% effective rate on a $5 card, and the $25 cap beats G&S's uncapped 3.49% above ~$700. Approved wording once live: **"Half of what major platforms take"** plus an end-to-end value comparison against G&S. Approved wording explicitly **excludes** "cheaper than G&S everywhere" — G&S is roughly $1 cheaper than the ratified schedule in the ~$100 mid-range, so protections (Claim 3) have to carry that part of the argument, not the fee number.

**Current reality (verified against code, 2026-07-12):** the ratified schedule is not shipped. `bounded-contexts/commercial-terms/support/runtime-support/terms-policy.ts` seeds the live schedule at 900 bps ($0.15 fixed) for personal accounts and 850 bps ($0.10 fixed) for business accounts, **not** 500 bps / $0.00 / $25 cap. There is no cap field on the Commercial Terms schedule/agreement model at all (#4099, open) — a $25/item cap cannot be quoted because the field doesn't exist yet. #4066 (the ratification-to-code slice) and #4099 (the cap-threading slice) are both open, unimplemented, with no PR against either as of this review.

**Ruling: Softened.** Do not cite "half of what major platforms take," "$25 cap," or any specific comparison number in campaign copy until #4066 and #4099 both ship and the offer-economics monitor's `standardScheduleSource` reflects the ratified schedule (`resolveStandardScheduleTerms` will report `marketplaceSalesFeePercentageBps: 500`, `marketplaceSalesFeeFixedAmount: "0.00"` once seeded). Until then, campaign copy may say only the qualitative, currently-true statement: **"No listing fees, no fixed per-item charge on our published rate — you only pay when you sell."** (True today: the live personal schedule has no fixed *listing* fee, only a percentage-plus-small-fixed *sale* fee; do not imply the fee is capped or state a specific percentage.)

**Unblock:** #4066 (ratification-to-seed) and #4099 (cap threading) both merge; re-run this review, confirm the monitor's `resolveStandardScheduleTerms` reports 500 bps / $0.00 / and (once #4099 also lands) a $25 cap; promote to Substantiated with the exact ratified wording above.

## Claim 1a — "Founders lock 0% for 60 days"

This is not one of the three claims named in #4075, but it is the central campaign hook (epic #4076) and shares the same fee-lock substantiation chain, so it is reviewed here rather than left implicit.

**Mechanism (real, per #4068's own capability audit):** the founders 0% entitlement does not need new fee machinery — a founder's 0% window is an ordinary Commercial Terms **agreement** (`{percentageBps: 0, fixedAmount: "0.00", effectiveFrom, effectiveUntil}`), the same account-level override primitive used for any negotiated rate. The listing-time snapshot on `marketplace_listing_pages` (`terms_agreement_id`, `marketplace_sales_fee_unit_amount`) is the existing fee-lock primitive; a listing created while a 0%/0-fixed agreement is active locks `marketplace_sales_fee_unit_amount = 0` permanently, independent of later rate changes. The offer-economics monitor's cohort query (`getLockedFeeListingCohortSummary` in `bounded-contexts/marketplace/features/listings/read-model/queries.ts`) reads exactly this: listings with a non-null `terms_agreement_id` and a zero locked fee.

**Current reality:** the *mechanism* is real and requires no new domain code to activate — creating a 0%/0-fixed Commercial Terms agreement for an account today would genuinely lock that account's listings at 0%, and the monitor would correctly count it. What is missing is everything upstream of "create the agreement": cohort admission automation, the 500-cap counter, founder numbering, and the badge (#4068's own "actual gaps to build" list), plus the #3904 P1 invitation-bearer-id security fix that #4068 explicitly blocks admissions on. As of this review, zero founders agreements exist in any environment — the offer-economics monitor will correctly report an all-zero cohort (`listingsCreatedCount: 0`, `lockedSellerAccountIds: []`) until admission starts.

**Ruling: Dropped (pre-launch).** Do not claim "N founders locked in" or reference a live 0% cohort until #4068's admission automation ships and at least one real founder agreement exists. The offer-economics monitor is the literal gate here: campaign copy claiming founder activity becomes Substantiated the moment `listingsCreatedCount > 0` in the monitor for a real (non-test) window, and should be worded from the monitor's own numbers going forward (no separately-maintained count).

## Claim 2 — "Better protections"

**Original substantiation plan (per #4075's own 2026-07-03 update):** every order was to contribute 1% of item value to a protection reserve (allowance-first, buyer-overflow split, per #4098), independent of seller fees — specifically designed so the claim survives the 0% founders cohort (a fee-funded protection promise would be undermined by a 0%-fee cohort; a reserve funded from the shipping-allowance economics is not).

**Current reality (verified against code, 2026-07-12):** #4098 is open and unimplemented. There is no `protection`/`reserve` concept anywhere in `bounded-contexts/ordering` or `bounded-contexts/settlement`; the only "allowance" that exists is `shippingAllowancePercentageBps` on the Commercial Terms schedule (a seller payout offset), not a buyer-facing protection fund. No event, table, or projection records a protection-reserve contribution. The offer-economics monitor's `protectionReserve` field is deliberately hardcoded `{ available: false, reason: "Order protection reserve funding (#4098) is not yet implemented..." }` — see `bounded-contexts/platform-operations/features/offer-economics/read-model/offer-economics-policy.ts` — so this monitor cannot be made to say otherwise until #4098 ships; there is nothing to compute.

**Ruling: Softened.** Do not describe protection as funded, guaranteed at a specific rate, or "included on every order" (that exact phrase was reserved for the reserve-mechanism version of this claim and would misrepresent an unbuilt funding model as live). Campaign copy may describe only what is enumerable in policy today: buyer/seller dispute and support-request workflows exist and are live (m85 dispute self-service, #3720-#3733; m107 trust & safety P0 gates). Approved fallback wording: **"Buyer and seller protection built into every transaction — disputes, support, and fraud controls, not a policy you have to read the fine print on."** Do not attach a percentage, a dollar amount, or the word "reserve"/"fund" to this claim until #4098 ships.

**Unblock:** #4098 ships (ordering economics tuple + settlement reserve fact + refund symmetry per its own acceptance criteria); extend the offer-economics monitor's `protectionReserve` field to read real contribution data (the type already exists — `OfferEconomicsProtectionReserveStatus` — swap `available: false` for a real `{ available: true, contributionAmount, ... }` variant); re-run this review and promote to Substantiated with "included on every order, never itemized" framing per the original design.

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

---

## Revision log

- **2026-07-12** — Initial review (this document). All three named claims plus the implicit founders-lock claim reviewed against shipped code; none promoted to full Substantiated. Offer-economics monitor (#4075) shipped alongside this review as the live-data source for Claims 1 and 1a going forward.

## Process

Re-run this review whenever any of #4066, #4068, #4098, or #4099 ships, or whenever campaign copy wants to cite a new number. A claim only moves to Substantiated when:

1. The underlying mechanism is live in production code (not just ratified in an issue comment), and
2. Either the offer-economics monitor reports a real, non-placeholder number for it, or the claim is a static policy fact directly readable from shipped code (as with Claim 3's cert-number enforcement).

Campaign copy that cites a claim not marked Substantiated in the current revision of this document is out of policy, regardless of what an earlier revision said.
