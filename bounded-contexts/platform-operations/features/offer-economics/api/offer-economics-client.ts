import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { OfferEconomicsSnapshot } from "../read-model/offer-economics-policy";

export type { OfferEconomicsSnapshot };

export type OfferEconomicsSummaryResponse = Readonly<{ snapshot: OfferEconomicsSnapshot }>;

function resolveOfferEconomicsApiUrl(
  request: Request,
  path: string,
  query: Readonly<Record<string, string | undefined>> = {},
) {
  const url = new URL(resolveRequestApiBaseUrl(request, `/api/platform/insights/offer-economics${path}`));
  for (const [key, value] of Object.entries(query)) {
    if (value) url.searchParams.set(key, value);
  }
  return url;
}

async function parseJsonOrThrow<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }
  return (await response.json()) as T;
}

export async function loadOfferEconomicsSummary(
  request: Request,
  params: Readonly<{ from?: string; to?: string; accountType?: string }> = {},
): Promise<OfferEconomicsSummaryResponse> {
  const response = await fetch(resolveOfferEconomicsApiUrl(request, "/summary", params), {
    headers: createForwardedAuthHeaders(request),
  });
  return parseJsonOrThrow(response);
}
