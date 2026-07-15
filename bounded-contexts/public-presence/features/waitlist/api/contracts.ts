import type {
  WaitlistGame,
  WaitlistInterest,
  WaitlistInventorySize,
  WaitlistCommerceIntent,
  WaitlistSource,
} from "../domain/common";
import type { WaveOneAdmissionBarStatus } from "../read-model/campaign-admission-bar-policy";

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
  /** Wave-1 cohort quality signals; only meaningful (and only captured) for sell/both role. */
  games?: readonly WaitlistGame[];
  hasStoreLink?: boolean;
  storeUrl?: string | null;
  inventorySize?: WaitlistInventorySize | null;
  source: WaitlistSource;
  website?: string | null;
}>;

/**
 * Progressive welcome-page cohort-quality save ("help us place you in the
 * right wave"). Every field is optional and individually saved; only fields
 * present on the request are updated. Never a condition of staying on the
 * waitlist.
 */
export type ProvideWaitlistCohortQualityRequest = Readonly<{
  games?: readonly WaitlistGame[];
  inventorySize?: WaitlistInventorySize | null;
  hasStoreLink?: boolean;
  storeUrl?: string | null;
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
  games: readonly WaitlistGame[];
  has_store_link: boolean;
  store_url: string | null;
  inventory_size: WaitlistInventorySize | null;
  submitted_at: string;
  updated_at: string;
  referral_count: number;
}>;

/** Wave-1 cohort quality metrics: the "campaign quality bar" side of campaign analytics. */
export type CampaignQualityMetrics = Readonly<{
  totalSignups: number;
  sellerSignupCount: number;
  qualifiedSellerCount: number;
  storeLinkCount: number;
  storeLinkPercent: number;
  inventorySizeDistribution: Readonly<Record<WaitlistInventorySize, number>>;
  qualifiedSellersByGame: Readonly<Record<WaitlistGame, number>>;
}>;

/** One channel's signup attribution row: channel/content-piece attribution. */
export type CampaignChannelAttributionRow = Readonly<{
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  signup_count: number;
  seller_signup_count: number;
  qualified_seller_count: number;
}>;

/** The full campaign analytics admin snapshot: quality bar, channel attribution, wave-1 admission status. */
export type CampaignAnalyticsSnapshot = Readonly<{
  quality: CampaignQualityMetrics;
  channelAttribution: readonly CampaignChannelAttributionRow[];
  admissionBar: WaveOneAdmissionBarStatus;
}>;

export type WaitlistMetrics = Readonly<{
  total_count: number;
  buy_count: number;
  sell_count: number;
  both_count: number;
  wave_fill: readonly Readonly<{
    waveNumber: 1 | 2 | 3;
    admittedCount: number;
    capacity: number;
  }>[];
}>;

/**
 * Referral progress + queue standing for the "move up the list" mechanic.
 * Eventually consistent; safe to show 0 counts while the projection catches
 * up, and `queuePosition` is null (never a fake number) until the signup's
 * own row is visible to the read model.
 */
export type WaitlistReferralSummary = Readonly<{
  referralCount: number;
  referralGoal: number;
  /** 1-based place in the beta invite line per referral-queue-policy.ts, or null while the projection catches up. */
  queuePosition: number | null;
  totalSignups: number;
  /** Places the signup's own referrals bought it (counterfactual vs zero own referrals); 0 when queuePosition is null. */
  positionsAdvanced: number;
}>;

/**
 * Public landing-page waitlist counter. `displayCount` is already rounded
 * down to a clean bucket and `null` below the display threshold, so the
 * route/UI never re-derives or re-guards the raw count.
 */
export type WaitlistCounter = Readonly<{
  displayCount: number | null;
}>;
