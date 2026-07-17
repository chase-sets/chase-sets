# High-Volume Seller Outreach Collateral

Tracks issue #4337 (epic #4076, GTM & Founders Offer). This is the Segment A ("the 250k archetype") one-pager and outreach copy ratified on #4337 (2026-07-16); see [GTM Wave Targeting And Seller Positioning](./wave-targeting.md) §1-§2 for the narrative and segment criteria this collateral is built from, and §4 for the capability-calendar gate every claim below is checked against.

**Truth gate:** this collateral follows [Offer Economics Claims Substantiation](./offer-economics-claims-substantiation.md) exactly — a claim not marked Substantiated or Softened-and-quoted-as-such in that document does not appear here, regardless of how well it fits the pitch. The founders-offer terms below cite Claim 1a, re-reviewed 2026-07-17 and Substantiated as offer terms (not cohort-activity numbers); the badge wording says "publicly displayed," not "permanent," matching #4887's ratified scope exactly. **The demo script for policy repricing is explicitly out of scope for this collateral.** It is anchored on the policy UX with dry-run preview (#4332), which is open; see [Wave Targeting §4](./wave-targeting.md#4-beta-capability-calendar). Do not draft or record a repricing demo until #4332 ships. The existing [Open-Offer Demo Walkthrough](./offer-flow-demo.md) covers the open-offer flow only and is unrelated to this gap.

## Audience

Online-only sellers with 10,000+ active listings (up to 250k+), selling today on TCGplayer and/or eBay, currently paying for a third-party repricer ($50-300/mo) or repricing by spreadsheet. Identified via the two-step-signup cohort-quality fields (inventory size, store link, games); no new build needed to source the list.

## One-pager copy

*Gate: this full one-pager leads with policy repricing as live, which requires #4331 (repricing engine) and #4332 (dry-run policy UX) in staging — neither has shipped as of 2026-07-17 (see [Wave Targeting §4](./wave-targeting.md#4-beta-capability-calendar)). Do not send this variant until both are staged for the target wave; use the [Wave-1 truth-gated variant](#wave-1-truth-gated-variant) below until then.*

> **You didn't get into this business to babysit a spreadsheet.**
>
> Set a repricing policy once — anchor to the live market estimate, the lowest competing ask, or a percentile of comps; add your offset; set a floor in dollars or as cost-plus-margin — and Chase Sets holds your prices against the market from then on. The market moves, your prices follow. The floor is never crossed: if the market drops below it, your price stops at the floor and you get flagged, not undercut. Preview any policy against your real inventory before it touches a single price, cap how far and how often prices can move in a day, and pause everything instantly. Every change — and every change it *didn't* make, and why — is in your audit trail.
>
> **Built on real market data.** Price history on every card from a manipulation-resistant trades tape — actual platform sales, fraud- and self-deal-excluded, not scraped guesses. Live market panels on every item. Your whole portfolio, valued continuously.
>
> **Built for your whole inventory.** Six-figure listing counts are the design target here, not the stress case. Bring your inventory in via diff-first bulk import; only what changed gets written; nothing about your catalog size slows you down.
>
> **Built in. Included.** This is not a $50-300/month third-party repricer bolted onto someone else's marketplace. It's native, it's included with your account, and it is never a paid add-on.
>
> **Founders offer:** the first 500 accounts to list or make an offer claim a numbered founder badge, publicly displayed. Beta access opens a 60-day 0% seller-fee window: every listing you create in that window locks 0% until it sells. *0% locked, and your prices manage themselves.*
>
> Terms in plain language: https://chasesets.com/founders

## Wave-1 truth-gated variant

Use this shorter variant for Wave-1 invites (2026-07-31), where policy repricing is staged but not yet demonstrable — see the capability-calendar gate in [Wave Targeting §4](./wave-targeting.md#4-beta-capability-calendar). Lead with what is live today; stage the rest honestly as roadmap inside the founders window:

> **Market analytics that already price your whole catalog.** Price history from a manipulation-resistant trades tape, live market panels, and continuous portfolio valuation — live today.
>
> **Bulk migration built for six-figure inventories.** Diff-first import means only what changed gets written; bring your TCGplayer or eBay export in without babysitting it. (Hold this line if #4328 has not reached staging; if it has not, say "bulk migration is arriving during your beta window" instead — never promise a live capability that is not in staging.)
>
> **Policy repricing arrives during your beta window.** Set-it-and-forget-it repricing — anchor to the market, set a floor, never crossed — is landing as your 60-day founders window runs, so you get it while your 0% lock is still active.
>
> **Founders offer:** 0% seller fees locked at listing time for 60 days, first 500 accounts get a public numbered badge. Terms: https://chasesets.com/founders

## Dual-role framing (say this honestly, do not omit it)

This cohort is m113 #4334's adoption-instrumentation proving cohort (per the pairing comment on epic #4335): their bulk-import-vs-policy-repricing usage data drives the bulk-ingestion sunset decision. Outreach should include a line like:

> As one of our first high-volume sellers, how you use bulk import versus repricing policies shapes how we build this — you'll help decide what stays and what we simplify.

## Claim boundaries specific to this collateral

- No specific fee percentage, cap, or named-competitor comparison in this collateral (Claim 1 stays Softened per [Offer Economics Claims Substantiation](./offer-economics-claims-substantiation.md)); the fee calculator (#4072) and comparison SEO pages (#4087) carry named comparisons under #4075's discipline, not this one-pager.
- No "N founders already locked in" or cohort-activity number until the offer-economics monitor reports a real non-zero cohort.
- No repricing-engine screenshot, walkthrough, or demo clip — the engine (#4331) and its dry-run UX (#4332) are both open; nothing to film yet.
- No per-grade pricing claim, and no "list your graded cards" self-serve call-to-action — neither exists (see Claim 3 in the claims-substantiation doc) and this collateral is not the graded-card pitch.
- No throughput promise beyond "scales with your track record" — limits are level-scaled by design, never "unlimited."

## Operator handoff

TODD owns: recipient list pull from the waitlist admin view's cohort-quality fields, send scheduling against the Wave-1/Wave-2 slots in [Wave Targeting §2](./wave-targeting.md#2-wave-targeting), and swapping the Wave-1 variant for the full one-pager once #4331/#4332 land in staging (re-check [Wave Targeting §4](./wave-targeting.md#4-beta-capability-calendar) before switching).

## Revision log

- **2026-07-17** — Re-ran founders-offer substantiation per #5579: #4068/#4887 both closed and verified shipped end-to-end in code, so the founders-terms lines here now cite Claim 1a (Substantiated as offer terms) rather than an implicit claim. Softened "public and permanent" to "publicly displayed" (badge wording, one-pager) to match #4887's ratified public-display scope — no permanence guarantee was ratified. Added an inline gating note under the one-pager heading pointing to the Wave-1 variant until #4331/#4332 stage.
- **2026-07-16** — Initial version: Segment A one-pager and Wave-1 truth-gated variant drafted from the ratified #4337 GTM strategy update. Demo script intentionally excluded, gated on #4332.
