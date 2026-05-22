# Landing Page Analytics

Public Presence landing-page analytics are provider-neutral.

The UI emits browser `CustomEvent` events named `chase-sets:waitlist-analytics` and also pushes the same bounded detail object into `window.dataLayer` when a deployable provides one. This keeps the bounded context testable without adding a vendor SDK, cookie, or third-party script.

The `public-web` deployable owns operational capture. It listens for `chase-sets:waitlist-analytics`, posts an allowlisted subset of bounded properties to `/analytics/waitlist`, and records OpenTelemetry metrics and sanitized logs through the shared observability stack. Grafana visualizes those metrics from the existing Prometheus/Loki pipeline.

Current event names:

- `landing_page_view`
- `cta_clicked`
- `section_viewed`
- `waitlist_form_started`
- `waitlist_form_submitted`
- `waitlist_signup_succeeded`
- `waitlist_signup_failed`
- `waitlist_role_selected`
- `waitlist_interest_selected`
- `waitlist_consent_checked`
- `policy_link_clicked`

Event details include:

- `event`: one of the event names above
- bounded-cardinality metric details such as `section`, `target`, `field`, `role`, `interest`, `status`, and `variant`
- sanitized log-only source details such as `checked`, `page_path`, `utm_source`, `utm_medium`, and `utm_campaign`

Keep event properties free of email addresses, account identifiers, user identifiers, raw URLs, and unbounded text. The public-web bridge may forward only bounded source fields for funnel analysis: `page_path`, `utm_source`, `utm_medium`, and `utm_campaign`. UTM values may contain normal campaign text such as spaces, percent signs, plus signs, periods, or hyphens, but must still reject emails, URLs, and long arbitrary strings. Referrer, `utm_content`, and `utm_term` remain durable waitlist source fields rather than operational analytics labels.

Primary funnel metrics:

- Landing page view to hero form start.
- Hero intent tab selection to form submission.
- Audience-path CTA selection to final form start.
- Mobile sticky CTA click to form submission.
- Consent checked to submitted signup.
- Submitted signup to succeeded or failed action result.

First experiments to run:

- Hero promise: seller margin headline versus founder access headline.
- CTA language: "Join early access" versus "Reserve founder access".
- Section order: audience path immediately after hero versus after seller economics.
- Founder proof: launch-priority panel near top versus near final CTA.
- Mobile sticky CTA enabled versus hidden.

The OpenTelemetry bridge is directional funnel observability, not transactional truth. It may duplicate client events and must never block the landing page or waitlist submission. Durable signup truth remains the Public Presence waitlist domain and read model.

Adding a third-party provider later still requires an adapter outside the page component that listens for `chase-sets:waitlist-analytics` or drains `window.dataLayer`, maps the provider-neutral event names to provider calls, and preserves consent/privacy requirements.
