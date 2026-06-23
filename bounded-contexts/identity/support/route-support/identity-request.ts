import {
  isTransientAuthResolutionError,
  requireActorFromAuthApi,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/platform-runtime/auth";
import { resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { readFreshWriteToken } from "@chase-sets/http/responses";
import type { PermissionKey } from "../runtime-support/common";
export { createIdentityRequestApiClient } from "../request-support/api-client";

export type { ResolvedActor } from "@chase-sets/platform-runtime/auth";

export function requestWithoutFreshWrite(request: Request) {
  const url = new URL(request.url);
  url.searchParams.delete("afterWrite");
  return new Request(url, {
    headers: request.headers,
    method: request.method,
    signal: request.signal,
  });
}

function shouldRetryWithoutFreshWrite(request: Request, error: unknown) {
  return Boolean(readFreshWriteToken(request)) && isTransientAuthResolutionError(error);
}

function resolveAuthApiBaseUrl(request: Request, identityApiBaseUrl?: string) {
  return identityApiBaseUrl
    ? new URL("/api/auth", `${identityApiBaseUrl}/`).toString().replace(/\/$/, "")
    : resolveRequestApiBaseUrl(request, "/api/auth");
}

export async function resolveActorFromIdentityApi(
  options: Readonly<{
    identityApiBaseUrl: string;
    request: Request;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<ResolvedActor | null> {
  const authApiBaseUrl = resolveAuthApiBaseUrl(options.request, options.identityApiBaseUrl);
  try {
    return await resolveActorFromAuthApi({
      authApiBaseUrl,
      request: options.request,
      fetch: options.fetch,
    });
  } catch (error) {
    if (!shouldRetryWithoutFreshWrite(options.request, error)) {
      throw error;
    }

    return resolveActorFromAuthApi({
      authApiBaseUrl,
      request: requestWithoutFreshWrite(options.request),
      fetch: options.fetch,
    });
  }
}

export async function requireActorFromIdentityApi(
  options: Readonly<{
    request: Request;
    permission?: PermissionKey;
    signInPath?: string;
    identityApiBaseUrl?: string;
    fetch?: typeof globalThis.fetch;
  }>,
): Promise<ResolvedActor> {
  const authApiBaseUrl = resolveAuthApiBaseUrl(options.request, options.identityApiBaseUrl);
  try {
    return await requireActorFromAuthApi({
      request: options.request,
      permission: options.permission,
      signInPath: options.signInPath,
      authApiBaseUrl,
      fetch: options.fetch,
    });
  } catch (error) {
    if (!shouldRetryWithoutFreshWrite(options.request, error)) {
      throw error;
    }

    return requireActorFromAuthApi({
      request: requestWithoutFreshWrite(options.request),
      permission: options.permission,
      signInPath: options.signInPath,
      authApiBaseUrl,
      fetch: options.fetch,
    });
  }
}
