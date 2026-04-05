import {
  createActorEventStoreContext as createGenericActorEventStoreContext,
  hasPermission as hasActorPermission,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/auth-runtime";
import {
  createForwardedAuthFetch,
  resolveRequestApiBaseUrl,
} from "@chase-sets/bounded-context-runtime";
import type { PermissionKey } from "./common";
import { createIdentityApiClient } from "./request-support/api-client";
import { hasPermission } from "./request-support/permissions";

export type { ResolvedActor } from "@chase-sets/auth-runtime";

function isSafeReturnTo(value: string | null) {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getSafeReturnTo(request: Request, fallback: string) {
  const returnTo = new URL(request.url).searchParams.get("returnTo");
  return isSafeReturnTo(returnTo) ? returnTo! : fallback;
}

export function createIdentityRequestApiClient(request: Request) {
  return createIdentityApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/identity"),
    fetch: createForwardedAuthFetch(request),
  });
}

export function createActorEventStoreContext(
  actor: ResolvedActor,
) {
  return createGenericActorEventStoreContext(actor);
}

export async function resolveActorFromIdentityApi(options: Readonly<{
  identityApiBaseUrl: string;
  request: Request;
  fetch?: typeof globalThis.fetch;
}>): Promise<ResolvedActor | null> {
  const authApiBaseUrl = new URL(options.identityApiBaseUrl);
  authApiBaseUrl.pathname = "/api/auth";
  return resolveActorFromAuthApi({
    authApiBaseUrl: authApiBaseUrl.toString().replace(/\/$/, ""),
    request: options.request,
    fetch: options.fetch,
  });
}

export async function requireActorFromIdentityApi(options: Readonly<{
  request: Request;
  permission?: PermissionKey;
  signInPath?: string;
  identityApiBaseUrl?: string;
  fetch?: typeof globalThis.fetch;
}>): Promise<ResolvedActor> {
  return requireActorFromAuthApi({
    request: options.request,
    permission: options.permission,
    signInPath: options.signInPath,
    authApiBaseUrl:
      options.identityApiBaseUrl
        ? new URL("/api/auth", `${options.identityApiBaseUrl}/`).toString().replace(/\/$/, "")
        : resolveRequestApiBaseUrl(options.request, "/api/auth"),
    fetch: options.fetch,
  });
}
