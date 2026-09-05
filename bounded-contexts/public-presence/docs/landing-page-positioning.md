# Landing Page Positioning

The public prelaunch landing page is seller-first.

Lead with founding seller economics: preserve card margin, create beta listings with a 0% seller fee lock, avoid a separate seller payment-processing fee, and make repeat listing work faster for bulk, raw, graded, chase, and everyday card inventory.

Buyer proof supports the seller-first promise. Delivered-total clarity, shipping credit visibility, order protection, account signals, and support context explain why seller supply can turn into confident collector demand. Do not let buyer messaging replace the first-screen seller outcome.

Use only repo-verifiable credibility until live marketplace proof exists:

- prelaunch status
- no live marketplace transactions during prelaunch
- public policies
- visible support contact
- waitlist consent and removal language
- beta fee-lock terms
- the founders offer mechanics: the 500-founder cap, the numbered badge (claimed by a founder's first listing or offer, not by signing up), and the 60-day 0% seller-fee window from beta access — with the full terms on `/founders`
- founders circle access on Discord for qualified early beta accounts
- sample product previews
- provider-backed payment and visible-total language already present in Public Presence copy
- live waitlist signup counter, sourced from the waitlist read model and threshold-gated so an early, small count never displays (`WAITLIST_COUNTER_DISPLAY_BUCKET`)
- founder identity and story (name, role, and why-building-this narrative), owned by the founder and updated when it goes stale

Until `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=true`, production copy must keep the marketplace framed as prelaunch. Do not publish live-buying, live-listing, transaction-volume, payout, or delivery promises on the public site while the production marketplace gate is closed.

Keep UCP, AP2, autonomous payment, headless checkout, AI-agent checkout, Payment Handler, and Shared Payment Token claims out of launch marketing unless a separate UCP/AP2 certification record exists. Public Presence may describe trusted checkout, visible totals, and provider-backed payment review, but it must not imply agents can complete orders or payments without buyer UI review until Payments, Checkout, Auth, Identity, and Operations have approved production verifier, merchant signing key, provider-backed Stripe Shared Payment Token, OAuth, signed-write, incident-response, and support evidence.

Before marketplace production promotion, build the Marketplace Promotion and UCP/AP2 Marketing launch gates from the final launch review record **and** the exact successful launch-mode copy audit record:

```powershell
pnpm run ops marketplace:promotion-evidence -- --review .\secure\marketplace-promotion-2026-05-30.json --public-presence-copy-audit .\secure\public-presence-copy-audit-2026-05-30.json --reference LAUNCH-REVIEW-2026-05-30
```

The Public Presence evidence in that review must confirm launch-mode copy for home, terms, privacy, refunds and returns, order protection, sales fee, FAQ, and contact pages, removal of future-only live-transaction language, and absence of uncertified UCP/AP2/headless-checkout claims.

Run the live copy audit before the final review. Use prelaunch mode while production is intentionally gated:

```powershell
pnpm run ops marketplace:public-presence-copy-audit -- --base-url https://chasesets.com --mode prelaunch
```

Prelaunch mode keeps its existing eight-page contract and takes no packet: it reports the current legal-corpus membership, leaves every launch-only authority field `null`, and fails while future-only posture is missing from any required page.

Launch mode is a different job and needs the retained counsel review packet and its receipt:

```powershell
pnpm run ops marketplace:public-presence-copy-audit -- --base-url https://chasesets.com --mode launch --counsel-packet <packet.md> --counsel-packet-receipt <packet.receipt.json>
```

Launch mode verifies the exact retained packet bytes against the receipt and the receipt's lifecycle-stable reviewed-content corpus identity against current source, then audits the eight required pages, the six launch-required policy routes, and the five compliance article routes — 17 unique fetches. It fails while future-only copy such as early access, waitlist, or production-promotion-gated checkout language remains, while any policy route is unpublished or exposes a stale version, or while the `registration-status-unverified` DMCA marker is present in source or on the live page.

The promotion command no longer accepts copied audit booleans. `publicPresenceCopyAuditVersion` is now `marketplace-public-presence-copy-audit/v2`, and every `publicPresenceCopyAudit*` value, every `counselPacket*` value, and the legacy `publicPresenceLaunchCopyReviewed`, `futureOnlyLaunchCopyRemoved`, and `policyPagesReviewed` proofs are derived from the audit record; a review that still carries them is rejected as an unknown field. The review keeps only `publicPresenceCopyAuditReference` as a human custody pointer. Rerun the launch-mode audit when its `checkedAt` is older than 30 days at promotion review.

## Launch Copy Replacement Inventory

Current source copy is intentionally prelaunch-only. Do not replace it while `PRODUCTION_MARKETPLACE_PUBLIC_ENABLED=false`; the prelaunch copy is the safer public posture until the owner-owned launch approvals pass.

The final launch-copy pass must review and replace future-only language across all eight required Public Presence pages before production promotion:

| Page | Route | Current source posture | Launch-copy decision |
| --- | --- | --- | --- |
| Home | `/` | Seller beta, early access, waitlist form, no live transaction commitment. | Replace waitlist CTAs with the approved marketplace entry point only after the commerce route and smoke evidence are approved. |
| Terms | `/terms` | Public site and marketplace workflows remain gated until production promotion approval. | State live marketplace operating terms and keep account, checkout, fee, fulfillment, review, and payout responsibilities explicit. |
| Privacy | `/privacy` | Public-site and early access data posture. | Confirm live marketplace data uses, provider processors, support evidence, and account activity records are covered. |
| Refunds and returns | `/refunds-and-returns` | Checkout, refunds, and returns are not available before promotion. | State live refund and return paths only after Payments, Fulfillment, Support, and Settlement proof passes. |
| Order Protection | `/order-protection` | Explains planned checkout clarity and support coverage. | State live protection scope, exclusions, support handoff, and evidence review without implying guaranteed outcomes. |
| Marketplace sales fees | `/sales-fees` | Beta seller fee lock and production-promotion-gated availability. | Preserve founding seller economics, remove gated-checkout language, and keep buyer-side Marketplace Checkout Fee visibility explicit. |
| FAQ | `/faq` | Answers whether Chase Sets is live by pointing to production promotion. | Replace availability answers with the approved live marketplace posture and avoid unsupported scale, demand, or uptime claims. |
| Contact | `/contact` | Support contact for prelaunch questions. | Confirm support contact, response ownership, and transaction support paths match Support readiness. |

Each required public page must have a reviewed launch-mode replacement for every visible phrase that contains one of these future-only signals:

- `prelaunch`
- `early access`
- `waitlist`
- `Request early access`
- `public checkout remains gated`
- `public marketplace checkout opens only after production promotion`
- `marketplace checkout opens only after production promotion`
- `production promotion approval`
- `production promotion`
- `opens only after`
- `gated`
- `no live marketplace transactions`
- `no buying, listing, or payment required`

The replacement review must preserve the concrete seller-economics proof that remains true at launch. Keep the beta seller fee lock, separate seller processing-fee posture, and visible buyer-fee/total clarity when those gates are approved; replace only the future-only availability language around them.

Do not add a browse, checkout, listing, payout, delivery, refund, transaction-volume, or launch-date claim unless the target deployable route is promoted and the matching launch evidence gate is green. If public web remains a product/policy surface while marketplace commerce lives on a separate host, launch copy must name that relationship plainly instead of implying local browse routes exist on `chasesets.com`.

Do not invent testimonials, waitlist counts, partnerships, founder bios, launch dates, transaction volume, or community proof.

Promote new trust proof only when all of these are true:

- the source is durable and public or owned by Chase Sets
- the metric or claim has an owner and a freshness window
- privacy/legal review allows the claim on a public page
- stale or unavailable proof can be removed without changing the offer
- the proof reinforces seller economics or buyer confidence without replacing the seller-first first screen

The primary conversion action is requesting early access. Use `seller beta` for the program and seller-economics context. Use `waitlist` only when naming the durable signup record, queue mechanics, consent/removal records, or internal review surfaces.

The embedded hero form should remain compact, seller-first, and explicit that requesting early access does not require buying, listing, or payment. It should also let visitors choose seller, buyer, or both intent before submitting so invite signals are obvious inside the first screen.

The first viewport should include a concrete product or economics signal in addition to the headline and form. Prefer design-system-owned marketing hero highlights, product previews, or seller math summaries over page-local decorative treatment.
