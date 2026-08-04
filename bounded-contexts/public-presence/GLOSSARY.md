# Public Presence Glossary

## Public Presence

Public Presence is the product-facing surface that explains Chase Sets before marketplace launch.

## Help Article

A **Help Article** is a locale-specific, public explanation authored as Markdown in Public Presence and compiled into typed content before public-web builds.

Notes:

- Help Articles explain landed marketplace behavior; they do not own policy, transaction, or catalog truth.
- Frontmatter records the article's audience, Help Category, review date, cited policy keys, related flows, and evidence for behavioral promises.
- Article prose is content, not localization chrome. Each locale has its own Markdown file.

## Help Category

A **Help Category** is the stable, URL-safe topic grouping used to browse Help Articles.

Notes:

- Public Presence owns the category taxonomy and its localized navigation labels.
- Audience identifies who an article helps; Help Category identifies what the article explains.

## Developer Article

A **Developer Article** is a locale-specific guide for integrating with Chase Sets agent-facing protocols. Developer Articles compile from a corpus separate from consumer Help Articles and publish only through the readiness-gated Developer Portal.

Notes:

- Developer Articles may accurately describe UCP, agent-commerce, and planned MCP capabilities before certification because every Developer Portal route remains gated and noindex.
- Generated MCP tool descriptors come from the platform runtime registry rather than article prose.
- Developer Articles never enter the consumer `publicHelpArticles` manifest or consumer launch-copy guards.

## Developer Portal

The **Developer Portal** is the `/developers` route family plus its agent-readable manifest and `llms.txt` index.

Notes:

- The m86 certification readiness flag defaults off.
- Enabled routes still emit `noindex,nofollow` and remain absent from sitemaps until a separate public-indexing change.

## Public Policy Artifact

A **Public Policy Artifact** is a locale-specific, versioned policy document published by Public Presence at a stable public route with machine-readable policy key, version, publication status, and effective-date metadata.

Notes:

- Public Presence owns publication and the policy text; the bounded context whose behavior the policy describes remains the semantic source.
- A Public Policy Artifact awaiting required counsel review is linkable for review but is explicitly marked non-effective and cannot satisfy the production launch-copy gate.
- Identity consumes generated publication metadata through `@chase-sets/public-docs` while remaining the sole owner of acceptance facts and active required consent versions.
- Every artifact in the launch legal corpus is enumerated by the public policy registry (`features/policies/domain/policy-registry.ts`); the corpus compiler emits one generated metadata module per document plus a content-insensitive index, so parallel document drafting cannot collide.
- Each artifact section carries a review manifest (scope note, decision refs, product truth refs, open questions, assumptions) that feeds the counsel review packet; every manifest field is packet-only and never rendered on the public page.
- A document can be required by a consent bundle only when published and readiness-valid; the compiled `consentActivatable` flag carries that invariant to Identity, so a placeholder stub can never produce represented acceptance.

## Waitlist Signup

A **Waitlist Signup** is a request for Chase Sets early access, qualified by account intent and product interests. Joining implies consent to early-access emails; consent to additional product updates beyond early-access notifications is a separate, optional opt-in.

Notes:

- Waitlist Signup is owned by Public Presence.
- Duplicate normalized email submissions update the existing signup.
- Waitlist Signup is not an Account, User, Buyer, or Seller.

## Public Referral Code

A **Public Referral Code** is the immutable opaque `wlr_` capability issued to one Waitlist Signup from at least 24 cryptographically secure random bytes.

Notes:

- It is never derived from or used as the private Waitlist Signup identity.
- Its raw value appears only on the signup's issuance event and protected provisioning receipt; uniqueness is reserved by its SHA-256 digest.
- Projection presence never proves complete issuance coverage; the fixed-horizon Event Store reconciliation owns that proof.

## Waitlist Referral Code

**Waitlist Referral Code** is the event-language noun for a Public Referral Code. It exists to keep reservation and issuance facts inside the Waitlist bounded-context language without creating a second kind of code.

## Waitlist Referral Link

A **Waitlist Referral Link** is the complete `https://chasesets.com/` URL produced by the protected provisioner from one issued Public Referral Code and one validated creator UTM tuple.

## Referral Link Provisioning ID

A **Referral Link Provisioning ID** is the opaque `wlp_` identifier for one idempotent protected referral-link provisioning audit fact.

Notes:

- It is generated from at least 16 cryptographically secure random bytes.
- The audit fact stores tuple and link digests, actor, and time, but never the Public Referral Code or complete link.

## Reconciliation Subject Ledger

A **Reconciliation Subject Ledger** is the record that makes one Public Referral Code reconciliation subject take exactly one refusal count: the first write on a subject key wins, and every later write on that key changes neither the recorded row nor the recorded Reconciliation Refusal Category.

Notes:

- A subject key is a typed discriminated value over exactly four kinds -- a `stream` keyed by its stream id, a `fact` keyed by its stream id together with its stream version, an `issued-digest` keyed by a canonical issuance digest, and a `provisioning-identity` keyed by a Referral Link Provisioning ID -- never a concatenated string, so a stream key and a fact key cannot collide on a stream id that ends in a version-shaped suffix.
- A suppressed write is reported, never dropped: the ledger carries an inventory of every attempted later write with its key, the row that attempted it, and the category it would have moved.
- Two rows writing one key therefore move one count, and two rows writing two keys of different kinds move two, by construction rather than by convention.
- Owned by `features/waitlist/domain/referral-code-reconciliation-algebra.ts`; every downstream reconciliation slice imports it rather than declaring its own.

## Reconciliation Refusal Category

A **Reconciliation Refusal Category** is one of the six frozen, ordered names a reconciliation row can refuse a Reconciliation Subject under: `unexpected`, `mismatched`, `duplicate`, `missingRecorded`, `missingIssued`, and `missingReservation`.

Notes:

- The names and their order are fixed once and consumed unchanged by every downstream reconciliation slice and its retained receipt; renaming or reordering one is a breaking change to a retained artifact, not a local edit.
- The refusal count object is built from the exported category tuple rather than hand-written, so a category added without a counter fails the typecheck.

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
- Collected progressively: optionally at signup, and field-by-field from the post-signup welcome page's wave-placement step, where each answer saves individually (no submit wall).
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

## Referral Queue Position

A **Referral Queue Position** is a Waitlist Signup's 1-based place in the beta invite line: base signup order improved by attributed referrals under the referral queue policy (each counted referral is worth a fixed number of places, with a hard cap on counted referrals).

Notes:

- Defined in `bounded-contexts/public-presence/features/waitlist/read-model/referral-queue-policy.ts`; the per-referral worth and the counted-referral cap live there, not scattered across call sites.
- Deterministic: a pure function of signup order and attributed referral counts, both replayable from recorded waitlist events. No randomness, no wall-clock reads.
- Anti-gaming: self-referrals never record, duplicate emails collapse into one signup, and the cap keeps a late signup from leapfrogging genuine early signups entirely.
- An invite-prioritization input, not guaranteed admission and not founder status -- wave placement still weighs Cohort Quality Signals and the Wave-1 Admission Bar.
- Surfaced truthfully on the welcome page: the real position from the read model, or "updating" while the projection catches up, never a fake number.

## Waitlist Nurture Sequence

A **Waitlist Nurture Sequence** is the suppressible early-access email series anchored to a Waitlist Signup's recorded time and completed by an Identity-owned founders-window grant.

Notes:

- Signup age schedules the welcome, fee-lock, open-offers, and wave-approaching touches; no wall-clock polling re-derives eligibility.
- The founders-window-opened fact triggers the wave-admission touch and starts the stated 60-day window.
- Every touch carries the signup's tracked referral link. Stable per-touch idempotency keys and the durable notification outbox make projection replay safe.

## Beta Wave Policy

The **Beta Wave Policy** is the revisable `public-presence.beta-waves` policy document that owns wave dates, per-wave invite counts, admission/operations gates, and the proportional Argo exposure paired with each wave.

## Founders Circle

The **Founders Circle** is the Discord community surface for the beta-signup campaign: an open warm-holding server joinable via the invite everywhere it renders (home page, welcome page, welcome email), with a role-gated `#founders-lounge` channel visible only to accounts holding the Founder role.

Notes:

- Access model ruled by #5893 option A: public channels are open to every member on join; `#founders-lounge` access is granted manually at each admission wave, never automatically.
- No Discord↔account linkage exists or is planned; "Founder #N" flair is applied manually, post-activation, and only after it matches the account's public profile badge (#4887).
- Operating blueprint: [Discord Founders Circle](../../docs/campaigns/discord-founders-circle.md).

## Beta Admission

A **Beta Admission** is the one-time, event-sourced placement of a Waitlist Signup into a numbered beta wave. It grants registration admission for that email and issues one idempotent beta invitation; it is not a Founder Number or an Identity team membership.

## Creator Seeding

**Creator Seeding** is the weeks-3–4 outreach channel that invites mid-size creators (~10,000–250,000 followers/subscribers on their primary platform) to join the beta waitlist and share a personal tracked link with their audience.

Notes:

- Reuses shipped mechanics only — the `?ref=` referral code, the durable UTM tuple, and Qualified Seller Signup wave ranking; it adds no new referral, queue, or admission machinery.
- Each creator's personal link carries `utm_source=creator`, so per-creator attribution surfaces on the Campaign Channel Attribution table and rolls up into the Grafana channel funnel under one aggregate `creator` channel.
- The populated target list, creator identities, and contact details are never committed to this public repository; only counts-only coverage templates and per-game outreach counts are.
- Operating blueprint: [Creator Seeding](../../docs/campaigns/creator-seeding.md).
