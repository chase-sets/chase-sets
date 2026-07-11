export const waitlistAnalyticsEventNames = [
  "landing_page_view",
  "cta_clicked",
  "waitlist_form_started",
  "waitlist_form_submitted",
  "waitlist_signup_succeeded",
  "waitlist_signup_failed",
  "waitlist_role_selected",
  "waitlist_interest_selected",
  "waitlist_marketing_consent_checked",
  "section_viewed",
  "policy_link_clicked",
] as const;

export type WaitlistAnalyticsEventName = (typeof waitlistAnalyticsEventNames)[number];

export type WaitlistAnalyticsProperties = Readonly<Record<string, string | number | boolean | null | undefined>>;

declare global {
  interface Window {
    dataLayer?: Array<Record<string, unknown>>;
  }
}

export function trackWaitlistEvent(name: WaitlistAnalyticsEventName, properties: WaitlistAnalyticsProperties = {}) {
  if (typeof window === "undefined") {
    return;
  }

  const detail = {
    event: name,
    ...properties,
  };

  window.dispatchEvent(new CustomEvent("chase-sets:waitlist-analytics", { detail }));
  window.dataLayer?.push(detail);
}
