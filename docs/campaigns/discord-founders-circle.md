# Discord Founders Circle

Operating blueprint for the founders-circle Discord server (issue #4084, epic #4076). This is the reproducible setup and day-to-day operating procedure; it is not a status log. The one-time go-live operator session lives at the end of this document and is Todd-only — it never occupies an implementation lane.

**Access model (ruled by #5893, option A):** the server is open warm-holding. Anyone who reaches the invite — home page, welcome page, or welcome email, wherever `CHASE_SETS_DISCORD_INVITE_URL` is set — can join and see public channels immediately. `#founders-lounge` is the one gated channel: visible only to accounts holding the Founder role, granted manually at each admission wave. There is no Discord↔account linkage and no automated gating; every grant is a manual operator action.

## Channel map

| Channel | Visibility | Purpose |
| --- | --- | --- |
| `#rules` | Public | Server rules, code of conduct, and the scam-report path (see Moderation). Read-only. |
| `#announcements` | Public | Founder-posted updates only (server-wide announcement permission). |
| `#founders-lounge` | Founder role only | The gated founders surface promised in shipped copy — early roadmap discussion, direct founder access. See Roles below. |
| `#pokemon` | Public | Trading/discussion for Pokémon. |
| `#magic-the-gathering` | Public | Trading/discussion for Magic: The Gathering. |
| `#yu-gi-oh` | Public | Trading/discussion for Yu-Gi-Oh!. |
| `#disney-lorcana` | Public | Trading/discussion for Disney Lorcana. |
| `#one-piece-card-game` | Public | Trading/discussion for One Piece Card Game. |
| `#beta-feedback` | Public | General product feedback outside the formal in-app channel. |
| `#bug-reports` | Public | Bug reports; triage owner cross-references in-app support tickets. |
| `#scam-reports` | Public | Scam/fraud reports routed by a moderator to the admin surface below — see Moderation. |

The per-game channel set matches the five supported games in the brand kit's per-game share links (`docs/campaigns/brand-distribution-kit.md:19`): `pokemon`, `magic-the-gathering`, `yu-gi-oh`, `disney-lorcana`, `one-piece-card-game`.

## Roles and permissions

| Role | Grant | Permissions |
| --- | --- | --- |
| Owner | Todd (server creator) | Full server administration. |
| Moderator | Assigned by Todd to trusted early community members as the server grows | Manage messages/timeouts in public channels, AutoMod exemptions, view `#scam-reports`. No `#founders-lounge` access unless separately granted the Founder role. |
| Founder | Granted manually at each admission wave (see Founder flair procedure) | Read/post in `#founders-lounge` in addition to all public channels. |
| @everyone (member) | Automatic on join via the invite | Read/post in every public channel; no `#founders-lounge` access. |

No role is granted or revoked automatically. Founder role grants are a recurring operator action at each admission wave (see Recurring operations).

## Rules text and scam-report path

`#rules` must state, in plain language:

- What this server is (warm-holding community for Chase Sets beta signups) and what it is not (no Discord-based support ticketing, no automated account linkage).
- Standard code-of-conduct expectations (no harassment, no spam, no unsolicited DMs soliciting trades off-platform).
- The scam-report path, stated by exact destination: **report suspected scams in `#scam-reports`; a moderator escalates confirmed reports to the Chase Sets reported-content admin queue** (`bounded-contexts/platform-operations/routes/admin/reported-content-detail.tsx`, feature home `bounded-contexts/platform-operations/features/reported-content/`) **per the fraud-operations runbook** (`docs/runbooks/fraud-operations.md`). Discord moderation action (timeout, kick, ban) is independent of and does not substitute for the in-app moderation/fraud pipeline.
- The manual Founder-flair procedure (see below), so members know why "Founder #N" appears next to some names and not others.

## Moderation baseline

- **AutoMod**: keyword filter tuned to spam/scam vocabulary (external trade solicitation, phishing links, crypto/giveaway scam patterns) and a mention/message-rate spam rule. Configure through Discord's built-in AutoMod rule editor; no custom bot.
- **Membership screening**: enable Discord's membership screening (rules acknowledgment gate) so every joiner accepts `#rules` before posting.
- **Solo-operator escalation note**: Todd is the only owner in Wave 0. Until a Moderator is appointed, all `#scam-reports` triage and AutoMod tuning is Todd's responsibility; if reports back up, prioritize `#scam-reports` over general community engagement — trust surface takes precedence over programming cadence.

## Onboarding copy

Server description / welcome-screen copy (consistent with the shipped locale strings after the #5893 alignment, see Copy alignment below):

> Welcome to the Chase Sets founders circle — the warm-holding community for beta signups. Public channels are open to every member. The `#founders-lounge` unlocks with your Founder role at each admission wave. Read `#rules` first, including how to report a scam.

This mirrors `publicPresence.home.discordCta` ("Join the founders circle on Discord") and the corrected `publicPresence.welcome.whatNext.point.discord` string — do not introduce new marketing claims here; quote the shipped copy rather than paraphrasing a different promise.

## Founder flair procedure

Founder Numbers claim at first Qualifying Act in activation order, capped at 500 activated founders (`bounded-contexts/identity/GLOSSARY.md:81-104`, #4068 amendment) — so Discord flair can never exist at signup time; it is always manual and always post-activation:

1. At each admission wave, an operator manually grants the Discord Founder role to members who have been admitted for that wave (per the Beta Wave Policy — `bounded-contexts/public-presence/GLOSSARY.md` "Beta Wave Policy").
2. On request, and only after the account has actually claimed a Founder Number (activated, not merely admitted), an operator sets that member's server nickname or a flair role to "Founder #N", verified against the account's public profile badge (#4887) before applying — the Discord number must match the profile badge exactly.
3. Never apply "Founder #N" flair speculatively or before the public profile badge shows the same number.

## First-two-weeks event schedule

Cross-referenced from the committed calendar (`docs/campaigns/30-day-content-calendar.md`); dates re-anchor with #4060, not here — do not hardcode a different date if the campaign re-anchors:

| Calendar day | Event | Channel |
| --- | --- | --- |
| Day 1 | Founder office hours | Discord event |
| Day 7 | Feedback roundup | Discord |
| Day 12 | Founder office hours | Discord event |
| Day 19 | Live offer-flow Q&A | Discord event |
| Day 26 | Founder office hours | Discord event |

Scheduling and facilitation are TODD-owned per the calendar; this blueprint only names which calendar rows are Discord-hosted.

## Invite and secret provisioning

- **Secret**: `CHASE_SETS_DISCORD_INVITE_URL`, a permanent non-expiring Discord invite URL.
- **Stores**: the GitHub Actions secret store consumed by the platform workflows (staging + production), and the local env store via `pnpm run env:push`.
- **Threading**: `infrastructure/helm/platform/values.yaml:94-96` / `runtime-values.json:134-136`, rendered by `scripts/render-platform-helm-values.mjs` into all six platform workflows (`.github/workflows/platform-{pr,production,staging-reset,ephemeral-verification,preview-cleanup,merge-gate-verification}.yml`), and required by `scripts/marketplace-production-launch-readiness.mjs:29`.
- **Render sites once set**: home page CTA (`bounded-contexts/public-presence/routes/marketplace/home.tsx:51-59`), welcome page CTA (`bounded-contexts/public-presence/routes/marketplace/welcome.tsx:31-38`), welcome page share button (`bounded-contexts/public-presence/features/waitlist/ui/success-page.tsx:403-414`), welcome email invite line (`deployables/platform-worker/src/email-template-renderer.ts:197`).
- Unset is a startup-config gap, not a feature flag — see the loud non-prod warning at `home.tsx:52-58`.

## Measurement

- **Funnel proxy**: Discord CTA click-through is the join proxy (not confirmed guild membership), instrumented per #4071 — `infrastructure/observability/stack/grafana/dashboards/public-presence-waitlist.json:62` and `:100-107`, admin pointer `bounded-contexts/public-presence/routes/admin/campaign-analytics.tsx:7-10`.
- **Weekly invite-uses check** (recurring, not session-blocking): an operator checks the Discord invite's use count weekly during the 30-day window to sanity-check the CTA proxy against actual joins. This is manual server-owner inspection, not a new analytics event.

## Recurring operations (not session-blocking)

- Weekly invite-uses check (see Measurement).
- Founder role grants at each admission wave (see Founder flair procedure step 1).
- "Founder #N" flair on request, post-activation (see Founder flair procedure step 2).

## Go-live operator session (Todd-only, parked)

The following is enumerated here for completeness and blueprint traceability only. It is a one-time, credentialed operator session — never an implementation-lane task, and out of scope for this PR:

1. Sign in as the Discord server owner; create the server from this blueprint (channels, roles, permissions, AutoMod, membership screening, rules text).
2. Configure `#founders-lounge` per the #5893 ruling.
3. Upload avatar + 960×540 banner (brand-kit "not-code" list; an OG-derived export is acceptable at go).
4. Create a permanent, non-expiring invite; record the URL.
5. Set `CHASE_SETS_DISCORD_INVITE_URL` in the GitHub Actions secret store (staging + production) and the local env store (`pnpm run env:push`); redeploy.
6. Verify in production with one real signup end-to-end (admin visibility, confirmation email, welcome email Discord line, welcome page CTA, home CTA) via `pnpm run ops campaign:start-gate --operator-evidence`.
7. Schedule the first two weeks of Discord events per the calendar rows above, anchored to the #4060 go date.
8. OG spot-check: paste `/`, `/?game=pokemon`, `/founders`, `/press` into a Discord channel (brand-kit `:85`).
9. Post-go: confirm Grafana `discord_cta_clicked` > 0.
