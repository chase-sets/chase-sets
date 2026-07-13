import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { PublicPolicyValuesResponse } from "../api/public-policy-values";

export async function loadPublicPolicyValues(
  request: Request,
  init: Readonly<{ signal?: AbortSignal }> = {},
): Promise<PublicPolicyValuesResponse> {
  const input = `${resolveRequestApiBaseUrl(request, "/api/public-presence")}/policy-values`;
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "public-presence" });
  const response = await fetch(input, init.signal ? { signal: init.signal } : undefined);
  if (!response.ok) throw new Error(`Public policy values request failed with ${response.status}.`);
  return (await response.json()) as PublicPolicyValuesResponse;
}
