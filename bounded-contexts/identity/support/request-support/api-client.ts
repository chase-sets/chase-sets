import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
export {
  createIdentityApiClient,
  identityApi,
  IdentityApiError,
} from "../../client";
export type {
  Account,
  ApiKey,
  Consent,
  IdentityApiClientOptions,
  Invitation,
  Membership,
  User,
} from "../../client";
import { createIdentityApiClient } from "../../client";

export function createIdentityRequestApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/identity"),
    fetch: createForwardedAuthFetch(request),
  });
}
