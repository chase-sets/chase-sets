# GTM Wave Targeting And Seller Positioning

Tracks issue #4337 (epic #4076, GTM & Founders Offer). Ratified by Todd on #4337 (2026-07-16) as the GTM strategy update covering seller-outreach positioning, wave targeting segments, and pricing posture for algorithmic repricing. This document is the campaign-strategy home for that ratification; it does not restate or reinterpret the underlying capability rulings it cites — the m128 monetization epic (#4895) is the source of the pricing-posture ruling, and the repricing-specific ruling posted on epic #4335 (2026-07-11) is adopted here, not reopened.

Wave ladder, dates, and claim-gating discipline follow [30-Day Campaign Content Calendar](./30-day-content-calendar.md) and [Offer Economics Claims Substantiation](./offer-economics-claims-substantiation.md). This document adds the seller-outreach lead narrative and the wave-by-wave targeting/segment criteria; it does not change the campaign clock (day 1 = 2026-07-20, per #4060) or the wave dates.

## 1. Seller-outreach positioning

**Platform spearhead and buyer narrative are unchanged.** Open offers, and being the place for people who both buy and sell, remain the identity. The buyer narrative stays protection + selection; its only echo of this work is the fairness/freshness halo already scoped in #4336 ("prices that track the market").

**The seller-outreach lead changes: repricing goes first.** For the seller audience, the platform narrative opens with algorithmic repricing and market-analytics proof, then brings in the rest of the platform as supporting cast. Core message: **your prices manage themselves.** Set a repricing policy once — anchor to the live market estimate, the lowest competing ask, or a percentile of comps; add an offset; set a floor in dollars or as cost-plus-margin — and the platform holds prices against the market from then on, with the floor never crossed (a below-floor market flags instead of undercutting). Preview any policy against real inventory before it touches a price, cap daily move frequency/magnitude, pause instantly, and keep every change (and every change it *didn't* make, and why) in an audit trail.

Supporting proof points, in order: market analytics built on the manipulation-resistant trades tape (real platform sales, fraud/self-deal excluded, not scraped estimates) with live market panels and continuous portfolio valuation; built for high-volume inventory (six-figure listing counts are the design target, not the stress case) via diff-first bulk import that only writes what changed; and repricing as a native, included capability — never a paid third-party repricer bolted on.

**Founders offer pairing:** *0% locked, and your prices manage themselves.* Founding accounts pay 0% seller fees, locked at listing time, on every listing created in their 60-day window, with the numbered founder badge (500-cap, publicly displayed) claimed by the first listing or offer.

**Claims discipline (unchanged, per #4336):** comparison framing stays legal-safe — incumbents are characterized ("requires a third-party repricer subscription"), never named in the repricing claim itself. Named-competitor comparisons stay confined to the fee calculator (#4072) and comparison SEO pages (#4087) under #4075's claims-substantiation discipline. Pitch what is live/staged for the wave being invited; stage the rest as roadmap. See §4 for the wave-by-wave claim gate.

## 2. Wave targeting

Wave ladder as ratified in #3955, unchanged by this update: **Wave 1 — 2026-07-31, 100 invites** (~50 qualified sellers, game-balanced); **Wave 2 — ~2026-08-07, 250 invites** (priority to live store links + referral leaders); **Wave 3 — ~2026-08-14, 500 invites**; **public launch — 2026-09-01**. Between-wave ops gates (checkout failure <2%, near-real-time projections, support ceiling) are unchanged; see [Beta Wave Exposure](../runbooks/beta-wave-exposure.md) for the admission mechanics.

### Segment A — online-only high-volume ("the 250k archetype"). The wedge target.

- **Criteria:** 10,000+ active listings (up to 250k+), selling today on TCGplayer and/or eBay, currently repricing via a paid third-party tool ($50-300/mo) or spreadsheets. Identified through the two-step-signup cohort-quality fields (inventory size, store link, games) already carried by the waitlist admin view — no new build required.
- **Wave slots:** top of the Wave-1 qualified-seller list (they anchor the five-games-by-five-sellers spread with depth), and the live-store-link priority bucket of Wave 2 ratified in #3955 — that priority bucket *is* this segment's volume wave.
- **Capability gate:** bulk ingestion #4328 must be in staging before any invite promises "migrate your inventory"; policy-engine claims follow the wave-by-wave gate in §4.
- **Dual role:** this cohort is m113 #4334's adoption-instrumentation proving cohort (per the pairing comment on epic #4335) — bulk-vs-policy usage data from this cohort drives the bulk-sunset decision. Outreach says so honestly ("you'll shape how this works"). See [High-Volume Seller Outreach](./high-volume-seller-outreach.md) for the Segment A collateral.

### Segment B — mid-volume ambitious

1,000-10,000 listings, spreadsheet repricing, no store storefront. Wave 2/3 fill. Same pitch as Segment A with lower migration friction; the referral queue reaches this segment organically.

### Segment C — brick-and-mortar stores. Hard-gated; not recruited in Waves 1-3.

The deepest-inventory whale segment carries a standing capability gate from the enterprise-seller wave-readiness review, quoted verbatim because it is the controlling rule:

> Brick-and-mortar stores (the deepest-inventory whale segment) have an explicit capability gate before recruitment - m116 complete (offline sales, collision protection, transfers) + m117 #4368 channel allocations minimum; POS (#4373) and pickup (#4371-#4372) enhance but don't gate. m117 #4375 owns the gate documentation and posts it to the capability calendar - a store that oversells its first weekend churns forever, so this gate is hard.

As of 2026-07-16, m116 (#4362-#4367) and #4368 remain open, so Segment C stays on a nurture-only list (waitlist-tagged via the store-link field, no invite) until #4375 posts the gate as cleared. If the gate clears before 2026-09-01, this segment slots into whichever wave is next when it clears; otherwise it is a post-launch recruitment track. There is no exception path for this gate.

## 3. Pricing posture

**Policy repricing, and bulk import, are included free for every account, permanently.** This retires any earlier "free during beta, revisit with cohort data" framing for repricing — that revisit is superseded by the ratified m128 model and is not a live posture.

This is a restatement, not a reopening, of two already-ratified rulings:

- **m128 Law 3** (#4888, epic #4895): capabilities that directly grow on-platform GMV are free for everyone — the marketplace sales fee is the price, and every sale repricing wins earns that fee. Repricing and bulk import appear by name in the ratified inventory table as free.
- **The repricing-specific ruling on epic #4335** (2026-07-11): the repricing engine is free permanently; throughput/frequency scales with account LEVEL (m121 #4412), not payment. `pricing.repricing` is declared with level-scaled throughput limits and no metered attribute.

**Founders-lock scope** (epic #4895 / #4081): the 0% lock covers the marketplace sales fee only. Any future metered capability charge is separate, opt-in, and never retroactive — repricing being free by law means the founders pitch never needs a repricing caveat.

**Copy this posture unblocks** (feeds the m97 chain, #4336): "Algorithmic repricing built in — included with your account, never a paid add-on," substantiated by the interim ruling on epic #4335 (2026-07-11) — a recorded law, not a promotion — within #4075's claims discipline; #4888 is the open issue tracking the formal monetization ADR write-up of that ruling, not a closed ADR itself; the unnamed-competitor line "no $50-300/month repricer subscription"; and a "repricing: included vs. subscription" row on the fee calculator (#4072) and comparison SEO pages (#4087).

**Copy boundaries this posture does not lift:** do not write "all analytics free forever" — analytics deep-history/export remain recorded m128 metered *candidates*; phrase claims around the presently-free surfaces (price history panels, market pages, portfolio value) specifically. Do not imply the 0% founders lock covers future usage charges. Throughput language is "scales with your track record," never "unlimited" — limits are level-scaled by design.

## 4. Beta capability calendar

Wave dates cross-referenced against m111/m112/m113 reality, as of 2026-07-16. A capability is claimable in seller outreach only once it clears this gate for the target wave — this is the wave-specific instance of the truth-gating rule in [Offer Economics Claims Substantiation](./offer-economics-claims-substantiation.md).

| Capability | Status (2026-07-16) | Earliest honest wave claim |
|---|---|---|
| Market analytics: trades tape, integrity exclusions, rollups, item-detail market panel, public market pages (m111 #4303-#4310) | Shipped | Wave 1 — live |
| Throughput foundations: no-op suppression, chunked appends, terms session, snapshots (#4325/#4326/#4327/#4329) | Shipped | Wave 1 (invisible; enables the scale claims) |
| Bulk reprice ingestion, diff-first CSV/API (#4328) | In flight | Wave 1 if in staging by 2026-07-31; otherwise staged as "coming in beta" and migration promises held for Wave 2 |
| RepricingPolicy aggregate — anchors/offset/floors/tolerance/scope (#4330) | Shipped (schema only; no engine) | Not independently claimable |
| Signal-reactive evaluation engine (#4331) | Open; depends on m112 #4315 (open), with a designed degradation path (lowest-competing-ask anchor ships without estimates) | Wave 2 target — claim live only if in staging by ~2026-08-07 |
| Policy UX with dry-run preview (#4332) | Open (after #4331) | Wave 2-3; the demo script in [High-Volume Seller Outreach](./high-volume-seller-outreach.md) stays blocked until this ships |
| Blended market estimate, `MarketPriceEstimated` (m112 #4315) | Open | Enhances anchors when it lands; the engine does not wait for it |
| MCP repricing + market tools (#4333, m112 #4319) | Open | Wave 3 / post-launch — "agent-ready" stays roadmap-staged until then |

**Wave-1 sequencing consequence:** the headline differentiator — policy repricing — is most likely live-demonstrable at Wave 2, not Wave 1. Wave-1 seller outreach leads with what is live today (market analytics, bulk migration if #4328 lands in time, the 0% lock) and stages policy repricing as "arriving during your beta window" — which the 60-day founders window makes both true and comfortable. #4331 and #4332 are lane-prioritized immediately after #4328 so Wave-2 invites (~2026-08-07) go out with the engine demonstrable and the dry-run demo script ready for Wave 3.

## Revision log

- **2026-07-17** — Precision fix per #5579: §3 no longer calls #4888 "the ADR" — it is an open issue tracking the formal monetization ADR write-up; the ruling it will formalize was already made as an interim ruling on epic #4335 (2026-07-11), which is what actually substantiates the "included, never a paid add-on" copy today.
- **2026-07-16** — Initial version, folding the ratified #4337 GTM strategy update (positioning narrative, wave-targeting segments A/B/C, pricing posture, capability calendar) into the campaign-strategy corpus.
