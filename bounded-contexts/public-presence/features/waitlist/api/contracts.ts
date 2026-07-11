import type { WaitlistInterest, WaitlistCommerceIntent, WaitlistSource } from "../domain/common";

export type SubmitWaitlistSignupRequest = Readonly<{
  email: string;
  role: WaitlistCommerceIntent;
  interests: readonly WaitlistInterest[];
  /**
   * Optional consent to additional product updates beyond early-access
   * notifications. Early-access consent is implied by signing up and is
   * never a required condition of joining the waitlist.
   */
  marketingConsent?: boolean;
  /** Referral code (referring signup's id) captured from an inbound `?ref=` link, if any. */
  referredBySignupId?: string | null;
  source: WaitlistSource;
  website?: string | null;
}>;

export type WaitlistSignupListItem = Readonly<{
  signup_id: string;
  email: string;
  role: WaitlistCommerceIntent;
  interests: readonly WaitlistInterest[];
  email_consent_accepted_at: string;
  marketing_consent_accepted_at: string | null;
  referred_by_signup_id: string | null;
  page_path: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  submitted_at: string;
  updated_at: string;
  referral_count: number;
}>;

export type WaitlistMetrics = Readonly<{
  total_count: number;
  buy_count: number;
  sell_count: number;
  both_count: number;
}>;

/** Referral progress for the "move up the list" founding-status mechanic. Eventually consistent; safe to show 0 while the projection catches up. */
export type WaitlistReferralSummary = Readonly<{
  referralCount: number;
  referralGoal: number;
}>;

/**
 * Public landing-page waitlist counter. `displayCount` is already rounded
 * down to a clean bucket and `null` below the display threshold, so the
 * route/UI never re-derives or re-guards the raw count.
 */
export type WaitlistCounter = Readonly<{
  displayCount: number | null;
}>;
