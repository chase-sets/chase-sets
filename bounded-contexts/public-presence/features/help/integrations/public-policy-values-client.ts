import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { PublicPolicyValuesResponse } from "../api/public-policy-values";

export type PublicPolicyValuesFailureClassification = "transport" | "non-ok" | "malformed";

export class PublicPolicyValuesRequestError extends Error {
  constructor(
    readonly classification: PublicPolicyValuesFailureClassification,
    readonly status?: number,
  ) {
    super("Public policy values request failed.");
    this.name = "PublicPolicyValuesRequestError";
  }
}

export async function loadPublicPolicyValues(
  request: Request,
  init: Readonly<{ signal?: AbortSignal }> = {},
): Promise<PublicPolicyValuesResponse> {
  const input = `${resolveRequestApiBaseUrl(request, "/api/public-presence")}/policy-values`;
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "public-presence" });
  let response: Response;
  try {
    response = await fetch(input, init.signal ? { signal: init.signal } : undefined);
  } catch {
    throw new PublicPolicyValuesRequestError("transport");
  }
  if (!response.ok) {
    throw new PublicPolicyValuesRequestError("non-ok", response.status);
  }
  try {
    return (await response.json()) as PublicPolicyValuesResponse;
  } catch {
    throw new PublicPolicyValuesRequestError("malformed");
  }
}
