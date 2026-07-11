import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { createPublicPresenceApiClient, PublicPresenceApiError, publicPresenceApi } from "../../client";
export type {
  PublicPresenceApiClientOptions,
  PromoBarMessage,
  PromoBarMessageTone,
  SavePromoBarMessageRequest,
  SubmitWaitlistSignupRequest,
  WaitlistMetrics,
  WaitlistReferralSummary,
  WaitlistSignupListItem,
} from "../../client";
import { createPublicPresenceApiClient } from "../../client";

export function createPublicPresenceRequestApiClient(request: Request) {
  return createPublicPresenceApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/public-presence"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "public-presence" }),
  });
}
