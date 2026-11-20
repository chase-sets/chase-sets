import { formActionRedirect } from "@chase-sets/platform-runtime/http";
import { data } from "react-router";
import { createMarketplaceRequestApiClient, MarketplaceApiError } from "../request-support/api-client";
import { appendAnonymousReportCookie, readAnonymousReportId } from "../request-support/anonymous-listing-draft";
import type { ReportListingRequest } from "../../features/reports/api/contracts";
import { runReviewMutation } from "./review-mutation-action";
import { t } from "@chase-sets/localization";

export async function submitListingReport(request: Request, formData: FormData, sourceRoutePath: string) {
  const listingId = String(formData.get("listingId") ?? "");
  const attemptId = String(formData.get("attemptId") ?? "");
  const anonymousReportId = readAnonymousReportId(request) ?? String(formData.get("anonymousReportId") ?? "");
  if (!listingId || !anonymousReportId.startsWith("anon_"))
    return { attemptId, mutationPhase: "failed-safe" as const, error: t("marketplace.reviewRecovery.reportNotSent") };
  const api = createMarketplaceRequestApiClient(request);
  const body: ReportListingRequest = {
    attemptId,
    reason: String(formData.get("reason") ?? "") as ReportListingRequest["reason"],
    details: String(formData.get("details") ?? "") || null,
    sourceRoutePath,
  };
  const send = () => api.reportListing(listingId, anonymousReportId, body);
  try {
    const outcome = await runReviewMutation({
      formData,
      kind: "listing.report",
      target: listingId,
      request: { targetId: listingId, ...body },
      send,
      replay: send,
      lookup: api.lookupMutationAttempt,
      isResponse: (error) => error instanceof MarketplaceApiError,
      code: (error) => (error instanceof MarketplaceApiError ? reportErrorCode(error) : null),
    });
    if (!("result" in outcome)) return outcome;
    const headers = new Headers();
    appendAnonymousReportCookie(headers, anonymousReportId, request);
    return formActionRedirect(outcome.result, `${sourceRoutePath}?reported=1`, { headers });
  } catch (error) {
    if (!(error instanceof MarketplaceApiError) || error.status >= 500) throw error;
    if (reportErrorCode(error) === "report_already_submitted")
      return data({ attemptId, mutationPhase: "succeeded" as const, alreadyReported: true as const }, { status: 409 });
    const values = { reason: body.reason, details: body.details ?? "" };
    const message = error.status === 429 ? t("marketplace.reviewRecovery.reportLimited") : error.message;
    return data({ attemptId, mutationPhase: "failed-safe" as const, error: message, values }, { status: error.status });
  }
}

function reportErrorCode(error: MarketplaceApiError) {
  const code = (error.body as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : null;
}
