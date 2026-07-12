export type WaitlistCommerceIntent = "buy" | "sell" | "both";
export type WaitlistInterest =
  | "low-sales-fees"
  | "bulk-listing"
  | "set-completion"
  | "pricing-tools"
  | "efficient-shipping";

/**
 * The five trading card games the wave-1 admission bar (campaign-admission-bar-policy.ts)
 * measures seller coverage against. Sourced from the games the Catalog
 * bounded context already integrates provider data for (see
 * `bounded-contexts/catalog/features/source-observations/api/provider-integration-profiles.ts`);
 * this is the first place a runtime enum of them is needed, so it is defined
 * here rather than duplicated informally per call site.
 */
export type WaitlistGame = "pokemon" | "magic-the-gathering" | "yu-gi-oh" | "disney-lorcana" | "one-piece-card-game";

export const WAITLIST_GAMES: readonly WaitlistGame[] = [
  "pokemon",
  "magic-the-gathering",
  "yu-gi-oh",
  "disney-lorcana",
  "one-piece-card-game",
];

/**
 * Bucketed self-reported inventory size, captured only from sell/both-intent
 * signups as a wave-1 cohort quality signal. Buckets rather than an exact
 * count: precise inventory counts are not verifiable at waitlist time and
 * would imply a false precision the campaign quality bar does not need.
 */
export type WaitlistInventorySize = "under_100" | "100_to_500" | "500_to_2000" | "2000_plus";

export const WAITLIST_INVENTORY_SIZES: readonly WaitlistInventorySize[] = [
  "under_100",
  "100_to_500",
  "500_to_2000",
  "2000_plus",
];

export type WaitlistSource = Readonly<{
  pagePath: string;
  referrer: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
}>;

export class PublicPresenceDomainError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PublicPresenceDomainError";
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new PublicPresenceDomainError(message);
  }
}

export function assertNever(value: never): never {
  throw new PublicPresenceDomainError(`Unhandled variant: ${JSON.stringify(value)}`);
}

export function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  assert(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email), "Enter a valid email address.");
  return email;
}

export function normalizeWaitlistCommerceIntent(value: string): WaitlistCommerceIntent {
  assert(
    value === "buy" || value === "sell" || value === "both",
    "Choose the marketplace workflow you want early access for.",
  );
  return value;
}

const allowedInterests = new Set<WaitlistInterest>([
  "low-sales-fees",
  "bulk-listing",
  "set-completion",
  "pricing-tools",
  "efficient-shipping",
]);

export function normalizeWaitlistInterests(values: readonly string[]): WaitlistInterest[] {
  const interests = values.filter((value): value is WaitlistInterest =>
    allowedInterests.has(value as WaitlistInterest),
  );
  assert(interests.length > 0, "Choose at least one interest.");
  return [...new Set(interests)].sort((left, right) => left.localeCompare(right));
}

export function ensureIsoTimestamp(value: string, message: string): string {
  assert(!Number.isNaN(Date.parse(value)), message);
  return value;
}

const waitlistGameSet = new Set<WaitlistGame>(WAITLIST_GAMES);

/**
 * Normalizes a candidate games list to the bounded {@link WaitlistGame} set,
 * silently dropping unrecognized values (the same forgiving shape as
 * {@link normalizeWaitlistInterests}) rather than rejecting the whole signup
 * over a stale client build sending an unknown game slug.
 */
export function normalizeWaitlistGames(values: readonly string[] | undefined | null): WaitlistGame[] {
  const games = (values ?? []).filter((value): value is WaitlistGame => waitlistGameSet.has(value as WaitlistGame));
  return [...new Set(games)].sort((left, right) => left.localeCompare(right));
}

const waitlistInventorySizeSet = new Set<WaitlistInventorySize>(WAITLIST_INVENTORY_SIZES);

/** Normalizes a candidate inventory-size bucket, treating anything unrecognized as absent. */
export function normalizeWaitlistInventorySize(value: string | null | undefined): WaitlistInventorySize | null {
  return value && waitlistInventorySizeSet.has(value as WaitlistInventorySize)
    ? (value as WaitlistInventorySize)
    : null;
}

const storeUrlPattern = /^https?:\/\/[^\s]+\.[^\s]{2,}[^\s]*$/i;

/**
 * Normalizes an optional existing-store URL. Only meaningful when
 * `hasStoreLink` is true; a malformed value is dropped (treated as "no URL
 * given") rather than failing the whole waitlist signup over a cohort
 * quality field, which is never a condition of joining the waitlist.
 */
export function normalizeWaitlistStoreUrl(hasStoreLink: boolean, value: string | null | undefined): string | null {
  if (!hasStoreLink) {
    return null;
  }
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 && trimmed.length <= 300 && storeUrlPattern.test(trimmed) ? trimmed : null;
}

export function normalizeSource(source: WaitlistSource): WaitlistSource {
  return {
    pagePath: source.pagePath.trim() || "/",
    referrer: source.referrer?.trim() || null,
    utmSource: source.utmSource?.trim() || null,
    utmMedium: source.utmMedium?.trim() || null,
    utmCampaign: source.utmCampaign?.trim() || null,
    utmContent: source.utmContent?.trim() || null,
    utmTerm: source.utmTerm?.trim() || null,
  };
}

export function stableWaitlistSignupId(email: string): string {
  const normalizedEmail = normalizeEmail(email);
  let hash = 5381;
  for (const char of normalizedEmail) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return `wls_${hash.toString(36)}`;
}

/**
 * Referral count a signup must reach through its own share link before the
 * "move up the list" founding-status mechanic is considered satisfied. Not a
 * binding queue position, only an invite-prioritization input.
 */
export const WAITLIST_REFERRAL_GOAL = 3;

const waitlistSignupIdPattern = /^wls_[0-9a-z]+$/;

/**
 * Normalizes an inbound `?ref=` referral code into a candidate waitlist
 * signup id. Referral codes derive directly from the referring signup's
 * stable id (no new identity surface); anything that does not match the
 * shape is treated as absent rather than rejecting the signup.
 */
export function normalizeReferralCode(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim().toLowerCase();
  return waitlistSignupIdPattern.test(trimmed) ? trimmed : null;
}

/**
 * Clean-number bucket the public waitlist counter rounds down to and the
 * minimum signup count required before the counter displays at all. A single
 * constant drives both so the first thing anyone ever sees is "25+", never a
 * small, unimpressive exact count.
 */
export const WAITLIST_COUNTER_DISPLAY_BUCKET = 25;

/**
 * Rounds an exact waitlist signup count down to the nearest clean bucket for
 * public display, and suppresses display entirely below the first bucket so
 * an early, small count never renders as social proof.
 */
export function roundDownWaitlistCounterForDisplay(signupCount: number): number | null {
  const bucketCount = Math.floor(signupCount / WAITLIST_COUNTER_DISPLAY_BUCKET) * WAITLIST_COUNTER_DISPLAY_BUCKET;
  return bucketCount >= WAITLIST_COUNTER_DISPLAY_BUCKET ? bucketCount : null;
}
