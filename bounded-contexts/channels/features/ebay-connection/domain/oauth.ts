import { createHash, randomBytes } from "node:crypto";
import type { ChannelOAuthTokenSet } from "../../credentials/domain/contracts";

export class EbayConnectionError extends Error {
  constructor(
    public readonly code:
      | "unavailable"
      | "invalid-request"
      | "invalid-state"
      | "invalid-provider-response"
      | "provider-unavailable"
      | "seller-conflict"
      | "stale-authorization",
  ) {
    super(code);
    this.name = "EbayConnectionError";
  }
}
export const createOAuthState = () => randomBytes(32).toString("base64url");
export function hashOAuthState(state: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || Buffer.from(state, "base64url").toString("base64url") !== state)
    throw new EbayConnectionError("invalid-state");
  return createHash("sha256").update(state).digest("hex");
}
export function scopesForCapabilities(publication: boolean): readonly string[] {
  return [
    "commerce.identity.readonly",
    "sell.account.readonly",
    "sell.inventory.readonly",
    ...(publication ? ["sell.inventory"] : []),
  ].map((scope) => `https://api.ebay.com/oauth/api_scope/${scope}`);
}
export const capabilitiesForConsent = (publication: boolean) => [
  "connection",
  "sellerSetup",
  ...(publication ? ["inventoryPublication"] : []),
];

export function closed(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new EbayConnectionError("invalid-provider-response");
}
function text(value: unknown, maximum: number): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.length ||
    Buffer.byteLength(value) > maximum ||
    /[\u0000-\u001f\uD800-\uDFFF]/u.test(value)
  )
    throw new EbayConnectionError("invalid-provider-response");
}
export function parseIdentity(value: unknown): string {
  closed(value, ["accountType", "registrationMarketplaceId", "userId", "username"]);
  for (const key of ["accountType", "registrationMarketplaceId", "userId", "username"]) text(value[key], 1024);
  return value.userId as string;
}
export function parseTokenResponse(value: unknown, issuedAt: string): ChannelOAuthTokenSet {
  closed(value, ["access_token", "expires_in", "refresh_token", "refresh_token_expires_in", "token_type"]);
  text(value.access_token, 16384);
  text(value.refresh_token, 16384);
  if (value.token_type !== "User Access Token") throw new EbayConnectionError("invalid-provider-response");
  const expiry = (seconds: unknown) => {
    if (
      typeof seconds !== "number" ||
      !Number.isSafeInteger(seconds) ||
      seconds < 1 ||
      seconds > 315360000 ||
      !Number.isFinite(Date.parse(issuedAt))
    )
      throw new EbayConnectionError("invalid-provider-response");
    return new Date(Date.parse(issuedAt) + seconds * 1000).toISOString();
  };
  return {
    format: "ChannelOAuthTokenSet/v1",
    accessToken: value.access_token,
    refresh: { kind: "present", token: value.refresh_token, expiresAt: expiry(value.refresh_token_expires_in) },
    accessExpiresAt: expiry(value.expires_in),
    issuedAt,
  };
}
