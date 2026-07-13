# Brand & Distribution Kit

Tracks issue #4086 (epic #4076, GTM & Founders Offer). One place for the repo-owned distribution assets — OG/social cards, the creator/press fact sheet, and reusable post templates — so every shared link and weekly drop is produce-not-design.

**Truth gate:** all copy in this kit, and any post derived from it, must stay inside the current rulings in [Offer Economics Claims Substantiation](./offer-economics-claims-substantiation.md). A claim marked Softened runs only in its softened wording; a claim marked Dropped does not run at all. When in doubt, quote the live pages (`/sales-fees`, `/founders`, `/press`) rather than paraphrasing numbers.

## OG / social link-preview cards

Committed 1200x630 PNGs in `bounded-contexts/public-presence/features/waitlist/ui/assets/`:

| Card | File | Used by |
|---|---|---|
| Default landing | `chase-sets-og-default.png` | `/`, `/help`, `/press`, any page without a more specific card |
| Per game (five) | `chase-sets-og-<game-slug>.png` | `/?game=<slug>` campaign variants (the roster links from #4082) |
| Founders offer | `chase-sets-og-founders.png` | `/founders` |

They are deterministic SVG renders of the design-system brand mark and dark palette — regenerate after copy or palette changes with `pnpm --filter @chase-sets/public-presence run generate:og-images` and commit the outputs. Meta wiring lives in `bounded-contexts/public-presence/features/waitlist/ui/social-meta.ts`; every wired page publishes `og:image` plus `twitter:card=summary_large_image`, so X and Discord render large-image previews.

Per-game share links for the weekly series: `https://chasesets.com/?game=pokemon` (also `magic-the-gathering`, `yu-gi-oh`, `disney-lorcana`, `one-piece-card-game`). Append the campaign's UTM parameters; the `game` parameter drives both the preselected signup form and the game-specific preview card.

## Creator / press fact sheet

Live at `https://chasesets.com/press` (source: `bounded-contexts/public-presence/features/help/domain/articles/creators-and-press.en.md`). Fee figures on it are live policy tokens, so the sheet can never quote a stale number. #4074 creator outreach should link the page rather than attach a copy — it updates itself when policy changes.

## Post templates

Placeholders use `{curly braces}`. Fill only from live sources: fee numbers from `/sales-fees`, offer terms from `/founders`, market stats from the pricing market pages. Never fill a placeholder with an internal or unpublished number.

### Weekly per-game data series (#4073)

> **This week in {game} on Chase Sets**
>
> {headline stat from the published market page, e.g. "Biggest mover: {card name} {+X%} this week"}
>
> Full curated catalog. Raw and graded. Track the sets you chase: https://chasesets.com/?game={game-slug}

Rules: the stat must come from a published Chase Sets market page (produce, don't invent); one stat per post; no platform-comparison framing (Claim 1 is Softened).

### Founders offer (evergreen until the 500 cap is reached)

> The first 500 accounts to list or make an offer on Chase Sets claim a numbered founder badge — public and permanent.
>
> Beta access opens a 60-day 0% seller-fee window: every listing you create in that window locks 0% until it sells.
>
> Terms in plain language: https://chasesets.com/founders

Rules: do NOT post "N founders already locked in" or any cohort-activity number until the offer-economics monitor reports a real non-zero cohort (Claim 1a is Dropped pre-launch). Describe the offer's terms only.

### Fees (Softened wording only)

> No listing fees, no fixed per-item charge on our published rate — you only pay when you sell.
>
> The live schedule (it's public, always): https://chasesets.com/sales-fees

Rules: no "half of what major platforms take", no "$25 cap", no named-competitor comparisons until the claims doc promotes Claim 1 to Substantiated.

### Order Protection (Substantiated)

> Every order includes Order Protection — funded at 1% of item value and never itemized as a separate buyer fee.
>
> How it works: https://chasesets.com/order-protection

### Graded cards (Softened wording only)

> Beta supports graded-card listings — PSA, BGS, CGC, and SGC certification numbers, validated, with slab photos required.

Rules: no "list your graded cards" self-serve call-to-action, and nothing about per-grade pricing or "PSA 10 market data" (neither exists).

### Launch countdown

> Chase Sets opens to everyone September 1, 2026. Beta invite waves start late July.
>
> Get in line (and move up by referring): https://chasesets.com

Rules: September 1, 2026 is the only hard public date; never promise a specific wave date.

## Operator follow-ups (creative production outside the repo)

These #4086 deliverables need design tooling or media production and are intentionally not code:

1. **X/Discord profile assets** — avatar (400x400) and banner (1500x500 X / 960x540 Discord) from the design-system brand mark and dark palette. The OG generator script is the palette/layout reference.
2. **Short-clip end-cards** — a 1-2s outro slate for video clips: brand mark, `chasesets.com`, launch date. Same layout language as the OG cards.
3. **Product screenshots** — a small set of current-UI screenshots for the press kit, refreshed when the UI changes; host them where outreach can link them (not in this repo).
4. **Named founder bio + headshot** — the fact sheet ships with the (already-public) anonymous founder story; add a named bio and photo only as a deliberate publication decision.
5. **OG render spot-check** — after deploy, paste `/`, `/?game=pokemon`, `/founders`, and `/press` into X's card validator and a Discord channel to confirm the large-image previews render (the #4086 acceptance check).
