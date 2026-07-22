# Creator Seeding

Tracks issue #4074 (epic #4076, GTM & Founders Offer). Creator seeding is the weeks-3–4 amplification channel of the 30-day campaign — deliberately last in the epic's channel priority (X → Discord → Reddit → Shorts → creators) — targeting 15–20 mid-size creators across the five supported games with the founders offer plus a personal tracked referral link. Decisions #5896 (offer mechanics, sender identity/voice, approval authority) and #5897 (selection criteria, "accepted" definition, threshold) are resolved (2026-07-22); this collateral restates both rulings verbatim rather than reinterpreting them.

**Truth gate:** this collateral follows [Offer Economics Claims Substantiation](./offer-economics-claims-substantiation.md) exactly — a claim not marked Substantiated or Softened-and-quoted-as-such in that document does not appear here. Founders-offer wording cites Claim 1a (Substantiated, offer terms only); the badge wording says "publicly displayed," never "permanent"; no cohort-activity or claimed-count numbers appear anywhere below. Approval authority for this collateral is the #5896 ruling plus the claims-substantiation doc — there is no per-message approval loop.

**Build gate:** every mechanical surface this channel needs already shipped (referral codes, UTM attribution, wave admission ranking). This is a docs-only, zero-build slice — see [Scope fence](https://github.com/chase-sets/chase-sets/issues/4074) on the tracking issue for the full non-goals list.

## Audience

Mid-size creators — **~10,000–250,000 followers/subscribers on their primary platform** — across the three outreach archetypes: box breakers, market-analysis YouTube/TikTok, and finance podcasters. The populated 15–20 target list lives outside git (this repo is public); this doc carries the selection criteria and a counts-only coverage template, not names, handles, or contact details.

## Creator offer copy (truth-gated)

This is the exact offer per the #5896 ruling — three parts, zero build:

1. **The founders offer**, in Claim 1a's approved wording:

   > Beta access opens a 60-day 0% seller-fee window — every listing you create in that window locks 0% until it sells.
   >
   > The first 500 accounts to list or make an offer claim a numbered founder badge, publicly displayed.

2. **Priority placement, truthfully scoped** — never a hard wave guarantee:

   > Sign up as a seller with your games and inventory, and you're ranked for the earliest invite waves through our normal Qualified Seller Signup process, plus referral-leader standing if your audience refers others. That's real priority, not a promise of a specific wave.

3. **The audience benefit** — joining through the creator's tracked link:

   > Anyone who joins through your link gets in the beta line, and their signup immediately gets its own shareable code to pass along — the same loop every signup gets.

## Personal-link + attribution convention

Every creator gets one personal tracked link, built from the shipped `?ref=` and UTM mechanics — no new build:

```
https://chasesets.com/?ref=<creator-signup-id>&utm_source=creator&utm_medium=<platform>&utm_campaign=<creator-slug>
```

- `<creator-signup-id>` — the creator's own Waitlist Signup id, captured **after** they sign up as a seller (sell/both intent) themselves; pull it from the admin Waitlist review (`bounded-contexts/public-presence/features/waitlist/ui/admin-pages.tsx:165-167`). This is the same `?ref=` mechanic the welcome page's own share link uses (`bounded-contexts/public-presence/features/waitlist/ui/success-page.tsx:250-253`).
- `utm_source=creator` — fixed value; aggregates every creator-channel signup into one funnel row.
- `utm_medium` — the creator's platform, e.g. `youtube`, `tiktok`, `x`, or `podcast`.
- `utm_campaign` — a short slug identifying the creator, not their public handle verbatim (e.g. `creator-mtg-03`, not an @handle or URL).

Values must conform to the sanitization bounds in [Landing Page Analytics](../../bounded-contexts/public-presence/docs/landing-page-analytics.md#L34) — UTM values may use normal campaign text (spaces, `%`, `+`, `.`, `-`) but must never be an email address, a URL, or a long arbitrary string.

**Worked sanitized example** (placeholder values only — no real creator identity):

```
https://chasesets.com/?ref=WLS-7f3a91&utm_source=creator&utm_medium=youtube&utm_campaign=creator-onepiece-01
```

This rides the durable UTM tuple already recorded on every signup (`bounded-contexts/public-presence/features/waitlist/read-model/schema.ts:10-14`). Per-creator attribution then appears on shipped surfaces with zero new panels:

- **Per-creator channel row** in the `/campaign-analytics` channel attribution table, grouped by `utm_source`/`utm_medium`/`utm_campaign` (`bounded-contexts/public-presence/features/waitlist/ui/campaign-analytics-page.tsx:160-189`).
- **Aggregate creator-channel funnel** in the Grafana "Campaign funnel by channel" panel, which groups by `utm_source` only — every creator link rolls up under `utm_source=creator` (`infrastructure/observability/stack/grafana/dashboards/public-presence-waitlist.json`).
- **Referred-by graph and referral sort**: `?ref=` drives the durable referred-by fact and the admin Waitlist review's referral-count sort (`bounded-contexts/public-presence/features/waitlist/ui/admin-pages.tsx:165-167`), and feeds Wave-2/Wave-3 referral-leader standing (`bounded-contexts/public-presence/features/waitlist/read-model/referral-queue-policy.ts`).

## Coverage-matrix template (5 games × archetypes, counts only)

This restates the #5897 ruling verbatim. The populated target list — creator names, handles, contact details, reply status — lives **outside git**; this repo is public, so this table stays a counts-only template. Only per-game coverage counts (no names) get posted to the tracking issue.

| Game | Box breakers | Market-analysis YouTube/TikTok | Finance podcasters | Game total |
|---|---:|---:|---:|---:|
| Pokemon (English and Japanese) | | | | |
| Magic: The Gathering | | | | |
| Yu-Gi-Oh! | | | | |
| Disney Lorcana | | | | |
| One Piece Card Game | | | | |

**Selection criteria (per #5897, restated verbatim):**

- Mid-size = ~10,000–250,000 followers/subscribers on the creator's primary platform.
- Outreach list = 15–20 targets, with every one of the five supported games covered by ≥2 targets each, mixed across the three archetypes above.
- **Accepted** = replied yes + signed up (personal tracked link exists) + committed to ≥1 post/mention in the weeks-3–4 window.
- **Threshold** = ≥5 accepted spanning ≥3 of the 5 games.
- **Attribution success** = each accepted creator's `utm_campaign` row/referral count shows ≥1 attributed signup after their first post — no aggregate creator-channel quota (the Wave-1 Admission Bar stays the campaign-level measure).

## Per-platform outreach templates

Sender identity per the #5896 ruling: Todd's X account for DMs, `support@chasesets.com` for email, founder voice throughout — not brand voice. Every message links [`/press`](../../bounded-contexts/public-presence/features/help/domain/articles/creators-and-press.en.md) instead of attaching a copy of the offer terms.

### X / TikTok / YouTube DM

> Hey [creator] — I'm Todd, founder of Chase Sets, a new trading card marketplace opening beta invites this summer. I think your audience would be a great fit for [game].
>
> The offer: anyone who signs up through your link joins the beta line and gets their own shareable code too. Sign up yourself as a seller and you're ranked for the earliest invite waves through our normal process, plus referral-leader standing if people join through you — not a guaranteed wave, but real priority.
>
> Beta access opens a 60-day 0% seller-fee window — every listing you create in that window locks 0% until it sells. First 500 accounts to list or make an offer get a numbered founder badge, publicly displayed.
>
> Full terms and fee schedule, no fine print: [chasesets.com/press]
>
> No cash sponsorship on this — just an early look and the founders offer for you and your audience. If you're up for it, I'll send your personal tracked link. Would a mention or post in the first half of August work for you?
>
> — Todd

### Email (podcast hosts / general outreach)

> **Subject:** Chase Sets — early access + founders offer for [game] fans
>
> Hi [creator],
>
> I'm Todd, founder of Chase Sets — a trading card marketplace opening beta invites this summer, built for people who buy and sell across [game] and four other supported games.
>
> I'd like to invite your audience in early through a personal tracked link: anyone who signs up through it joins the beta line and gets their own shareable code to pass along. If you sign up yourself as a seller, you're ranked for the earliest invite waves through our normal process, plus referral-leader standing from your audience's signups — real priority, not a guaranteed wave.
>
> The founders offer: beta access opens a 60-day 0% seller-fee window, and every listing you create in that window locks 0% until it sells. The first 500 accounts to list or make an offer claim a numbered founder badge, publicly displayed.
>
> Full plain-language terms and fee schedule: chasesets.com/press
>
> This isn't a paid placement — no cash sponsorship, just early access and the founders offer for your audience. If you're interested, reply here and I'll send your personal link. A mention in the first half of August would line up perfectly with our beta invite window.
>
> Thanks for considering it,
> Todd
> support@chasesets.com

## Claim boundaries specific to this collateral

- No "permanent" — the founder badge is "publicly displayed," matching Claim 1a's ratified scope exactly.
- No claimed-count or cohort-activity numbers ("N creators already signed up," "N founders locked in") until the offer-economics monitor reports a real non-zero cohort.
- No cash sponsorship, affiliate fee, or revenue share of any kind.
- No public-listing or partnership-announcement promise — prelaunch publishes no traction numbers (`/press`); publicly naming a creator is a separate, deliberate publication decision this collateral does not make.
- No referred-side queue boost beyond the shipped referral-queue policy, and no reserved or pre-numbered founder slot — founder numbers claim at first Qualifying Act in activation order under the 500-cap, same as every other account (`bounded-contexts/identity/GLOSSARY.md#L94-L96`).
- No hard wave guarantee — "priority placement" always cites Qualified Seller Signup ranking plus referral-leader standing, never a specific promised wave.

## Operator handoff

**TODD owns** every send, list-build, and evidence session below — this collateral does not execute the campaign, it only prepares it. These are planned operator sessions, not completed work; none has run as of this collateral's commit:

1. **List build** — authenticated research across YouTube/TikTok/X/podcast platforms to populate the outside-git target list per the coverage-matrix criteria above; post per-game coverage counts (no names) to the tracking issue.
2. **Outreach sends** — send the per-platform templates above from the #5896-ruled sender identity, linking `/press`; post send counts per game to the tracking issue.
3. **Acceptance + link provisioning** (rolling) — for each accepting creator: they sign up with sell/both intent (ranking as a Qualified Seller Signup), pull their signup id from the admin Waitlist review, construct their personal link per the convention above, and send it; post accepted counts per game to the tracking issue.
4. **Attribution evidence** — after each creator's first post in the weeks-3–4 window, capture `/campaign-analytics` channel-attribution rows and the admin referral-sort view showing their signups.

## Measurement

No new analytics events, panels, or dashboard changes — this channel measures entirely on shipped surfaces:

- **Per-creator attribution**: `/campaign-analytics` channel attribution table, one row per `utm_source=creator`/`utm_medium`/`utm_campaign` combination (`bounded-contexts/public-presence/features/waitlist/ui/campaign-analytics-page.tsx:160-189`).
- **Referral standing**: admin Waitlist review, sorted by referral count, per creator's `?ref=` signups (`bounded-contexts/public-presence/features/waitlist/ui/admin-pages.tsx:165-167`).
- **Aggregate channel trend**: Grafana "Campaign funnel by channel" panel, `utm_source=creator` (`infrastructure/observability/stack/grafana/dashboards/public-presence-waitlist.json`).
- **Success bar**: per #5897, each accepted creator needs ≥1 attributed signup after their first post — there is no aggregate creator-channel quota; the campaign-level measure stays the Wave-1 Admission Bar.

## Revision log

- **2026-07-22** — Initial version, drafted from the ratified #5896/#5897 decision records and the shipped referral/attribution/wave-admission mechanics (#4070, #4071, #4068).
