export type WaitlistCommerceIntent = "buy" | "sell" | "both";
export type WaitlistInterest =
  | "low-sales-fees"
  | "bulk-listing"
  | "set-completion"
  | "pricing-tools"
  | "efficient-shipping";

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

export function assert(
  condition: boolean,
  message: string,
): asserts condition {
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

export function normalizeWaitlistInterests(
  values: readonly string[],
): WaitlistInterest[] {
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
