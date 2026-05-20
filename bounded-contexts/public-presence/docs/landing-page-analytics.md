# Landing Page Analytics

Public Presence landing-page analytics are provider-neutral.

The UI emits browser `CustomEvent` events named `chase-sets:waitlist-analytics` and also pushes the same bounded detail object into `window.dataLayer` when a deployable provides one. This keeps the bounded context testable without adding a vendor SDK, cookie, or third-party script. Deployables or future analytics adapters may listen for the event and forward it to an approved provider.

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
- bounded-cardinality details such as `section`, `target`, `field`, `role`, `interest`, `checked`, `page_path`, `utm_source`, `utm_medium`, `utm_campaign`, or `variant`

Keep event properties free of email addresses, account identifiers, user identifiers, raw URLs, and unbounded text. UTM parameters and referrer capture remain server-submitted waitlist source fields rather than client analytics properties in this pass.

Adding a provider requires an adapter outside the page component that listens for `chase-sets:waitlist-analytics` or drains `window.dataLayer`, maps the provider-neutral event names to provider calls, and preserves consent/privacy requirements.
