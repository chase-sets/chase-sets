# Landing Page Analytics

Public Presence landing-page analytics are provider-neutral.

The UI emits browser `CustomEvent` events named `chase-sets:waitlist-analytics` and also pushes the same bounded detail object into `window.dataLayer` when a deployable provides one. This keeps the bounded context testable without adding a vendor SDK, cookie, or third-party script.

The `public-web` deployable owns only the browser bridge. It listens for `chase-sets:waitlist-analytics` and posts an allowlisted subset of bounded properties to `/api/public-presence/analytics/waitlist`. The Public Presence API owns validation and vocabulary, then records through a `platform-api` host port into OpenTelemetry metrics and sanitized logs. Grafana visualizes those metrics from the existing Prometheus/Loki pipeline.

Current event names:

- `landing_page_view`
- `cta_clicked`
- `section_viewed`
- `waitlist_form_started`
- `waitlist_form_submitted`
- `waitlist_signup_succeeded`
- `waitlist_signup_failed`
- `waitlist_signup_attributed`
- `waitlist_role_selected`
- `waitlist_interest_selected`
- `waitlist_marketing_consent_checked`
- `referral_link_copied`
- `referral_share_clicked`
- `policy_link_clicked`

Event details include:

- `event`: one of the event names above
- bounded-cardinality metric details such as `section`, `target`, `field`, `role`, `interest`, `status`, and `variant`
- sanitized log-only source details such as `checked`, `page_path`, `utm_source`, `utm_medium`, and `utm_campaign`

The current public landing experiment variants are `seller_first_v1` (the unchanged seller-first default) and `seller_first_v2` (the buyer-intent hero). The assignment is deterministic and first-party: an explicit `?intent=buy` or buyer-oriented UTM signal selects v2, while sell, both, invalid, or absent signals remain on v1. The selected key is included in the landing, section, form, and signup events so campaign funnel metrics can split by variant. Treat variants as durable public experiment keys, not remediation, audit, branch, or implementation labels.

Keep event properties free of email addresses, account identifiers, user identifiers, raw URLs, and unbounded text. The public-web bridge may forward only bounded source fields for funnel analysis: `page_path`, `utm_source`, `utm_medium`, and `utm_campaign`. UTM values may contain normal campaign text such as spaces, percent signs, plus signs, periods, or hyphens, but must still reject emails, URLs, and long arbitrary strings. Referrer, `utm_content`, and `utm_term` remain durable waitlist source fields rather than operational analytics labels.

Primary funnel metrics:

- Landing page view to hero form start.
- Hero intent tab selection to form submission.
- Seller-tools early-access CTA click to final form start.
- Mobile sticky CTA click to form submission.
- Optional marketing consent checked to submitted signup (final-CTA variant only; early-access consent is implied and untracked as a discrete opt-in).
- Submitted signup to succeeded or failed action result.
- Successful signup to referral link copy or share click on the post-signup success page (`/welcome`).
- Referred-signup rate: `waitlist_signup_attributed` fires only when a successful signup carried a well-formed, non-self `?ref=` referral code; it never carries the referring or referred signup id (see privacy rule below), so it is a rate signal, not an attribution graph. The durable referred-by fact lives in the waitlist read model, queried by admins in the Waitlist review page.

First experiments to run:

- Hero promise: seller margin headline versus buyer-total clarity headline.
- CTA framing: "Request early access" with seller-beta context versus seller-beta-only access wording.
- Founder proof: eligibility language in final CTA versus a dedicated status panel.
- Mobile sticky CTA enabled versus hidden.

The OpenTelemetry bridge is directional funnel observability, not transactional truth. It may duplicate client events and must never block the landing page or waitlist submission. Durable signup truth remains the Public Presence waitlist domain and read model.

Adding a third-party provider later still requires an adapter outside the page component that listens for `chase-sets:waitlist-analytics` or drains `window.dataLayer`, maps the provider-neutral event names to provider calls, and preserves consent/privacy requirements.

## Campaign analytics (issue #4071)

Campaign analytics splits across the same durable-vs-directional boundary this doc already draws, rather than inventing a new data path:

- **Funnel by channel** (visit -> hero form start -> signup succeeded -> Discord CTA click-through -> referral share, grouped by `utm_source`) is a Grafana dashboard (`infrastructure/observability/stack/grafana/dashboards/public-presence-waitlist.json`, "Campaign funnel by channel" panel), built from LogQL over the same sanitized structured logs described above. It is directional, not transactional truth, matching every other funnel metric on this page. "Discord join" is measured as a click-through on the Discord invite CTA (`cta_clicked` with `target=discord`); there is no Discord API/OAuth integration in this codebase to confirm actual guild membership, so the click-through is the honest proxy.
- **Wave-1 cohort quality** (games sold, existing store link, inventory-size bucket), **channel/content-piece attribution of signups**, and the **wave-1 admission bar** (`bounded-contexts/public-presence/features/waitlist/read-model/campaign-admission-bar-policy.ts`) are transactional truth: captured on the durable Waitlist Signup read model at signup time (sell/both intent only, never a condition of joining) and surfaced on the `/campaign-analytics` admin page (`public-presence.view` permission), which cross-links to the Grafana funnel dashboard for the directional half.
