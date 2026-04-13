import {
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import { resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { PermissionKey } from "../runtime-support/common";
export { createIdentityRequestApiClient } from "../request-support/api-client";

export type { ResolvedActor } from "@chase-sets/platform-runtime/auth";

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
