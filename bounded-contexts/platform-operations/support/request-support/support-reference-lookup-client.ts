import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { SupportReferenceLookupResult } from "../../features/support-reference-lookup/api/contracts";

export type { SupportReferenceLookupResult };

function resolveSupportReferenceLookupApiUrl(request: Request, reference: string) {
  const url = new URL(resolveRequestApiBaseUrl(request, "/api/platform/support-reference-lookup"));
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(reference)}`;
  return url;
}

/**
 * Looks up a support reference via Platform Operations' own mounted API.
 * Returns `null` for a 404 (no record found) so route loaders can render an
 * empty-state instead of throwing; any other non-ok response still throws a
 * `Response` for the route's error boundary, matching this file's sibling
 * clients.
 */
export async function lookupSupportReference(
  request: Request,
  reference: string,
): Promise<SupportReferenceLookupResult | null> {
  const response = await fetch(resolveSupportReferenceLookupApiUrl(request, reference), {
    headers: createForwardedAuthHeaders(request),
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  const body = (await response.json()) as { result: SupportReferenceLookupResult };
  return body.result;
}
