import { formActionRedirect } from "@chase-sets/platform-runtime/http";
import { createMarketplaceRequestApiClient, MarketplaceApiError } from "../request-support/api-client";
import { appendAnonymousReportCookie, readAnonymousReportId } from "../request-support/anonymous-listing-draft";
import type { ReportListingRequest } from "../../features/reports/api/contracts";
import { runReviewMutation } from "./review-mutation-action";

export async function submitListingReport(request: Request, formData: FormData, sourceRoutePath: string) {
  const listingId = String(formData.get("listingId") ?? "");
  const attemptId = String(formData.get("attemptId") ?? "");
  const anonymousReportId = readAnonymousReportId(request) ?? String(formData.get("anonymousReportId") ?? "");
  if (!listingId || !anonymousReportId.startsWith("anon_"))
    return { attemptId, mutationPhase: "failed-safe" as const, error: "The report was not sent. Reload the form before submitting." };
  const api = createMarketplaceRequestApiClient(request);
  const body: ReportListingRequest = {
    attemptId, reason: String(formData.get("reason") ?? "") as ReportListingRequest["reason"],
    details: String(formData.get("details") ?? "") || null, sourceRoutePath,
  };
  const send = () => api.reportListing(listingId, anonymousReportId, body);
  try {
    const outcome = await runReviewMutation({
      formData, kind: "listing.report", target: listingId, request: { targetId: listingId, ...body },
      send, replay: send, lookup: api.lookupMutationAttempt,
      isResponse: (error) => error instanceof MarketplaceApiError,
      code: (error) => error instanceof MarketplaceApiError ? (error.body as { error?: { code?: string } })?.error?.code ?? null : null,
    });
    if (!("result" in outcome)) return outcome;
    const headers = new Headers();
    appendAnonymousReportCookie(headers, anonymousReportId, request);
    return formActionRedirect(outcome.result, `${sourceRoutePath}?reported=1`, { headers });
  } catch (error) {
    return { attemptId, mutationPhase: "failed-safe" as const, error: error instanceof Error ? error.message : "The report could not be submitted." };
  }
}
