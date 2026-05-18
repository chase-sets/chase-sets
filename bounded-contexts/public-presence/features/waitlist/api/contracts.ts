import type {
  WaitlistInterest,
  WaitlistCommerceIntent,
  WaitlistSource,
} from "../domain/common";

export type SubmitWaitlistSignupRequest = Readonly<{
  email: string;
  role: WaitlistCommerceIntent;
  interests: readonly WaitlistInterest[];
  emailConsent: boolean;
  source: WaitlistSource;
  website?: string | null;
}>;

export type WaitlistSignupListItem = Readonly<{
  signup_id: string;
  email: string;
  role: WaitlistCommerceIntent;
  interests: readonly WaitlistInterest[];
  email_consent_accepted_at: string;
  page_path: string;
  referrer: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  utm_term: string | null;
  submitted_at: string;
  updated_at: string;
}>;

export type WaitlistMetrics = Readonly<{
  total_count: number;
  buy_count: number;
  sell_count: number;
  both_count: number;
}>;
