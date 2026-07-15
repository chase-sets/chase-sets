import { MarketplaceApiError } from "../request-support/api-client";
import { createMarketplaceRequestApiClient } from "../request-support/api-client";
import type { ReportReviewRequest } from "../request-support/api-client";
import type { ReviewReportResult } from "../../features/reviews/ui/review-report-action";

function reportErrorMessage(error: unknown) {
  if (error instanceof MarketplaceApiError) {
    const body = error.body as Readonly<{ error?: Readonly<{ message?: unknown }> }> | null;
    const message = body?.error?.message;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }
  return error instanceof Error ? error.message : "Report submission failed. Try again.";
}

function reportErrorCode(error: MarketplaceApiError) {
  const body = error.body as Readonly<{ error?: Readonly<{ code?: unknown }> }> | null;
  return typeof body?.error?.code === "string" ? body.error.code : null;
}

export async function submitReviewReport(
  request: Request,
  submittedFormData?: FormData,
): Promise<ReviewReportResult | null> {
  const formData = submittedFormData ?? (await request.formData());
  if (formData.get("intent") !== "report-review") {
    return null;
  }

  const reviewId = String(formData.get("reviewId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const details = String(formData.get("details") ?? "");
  if (!reviewId) {
    return { reviewId, status: "error", message: "Review not found.", values: { reason, details } };
  }

  try {
    await createMarketplaceRequestApiClient(request).reportReview(reviewId, {
      reason: reason as ReportReviewRequest["reason"],
      details: details || null,
      sourceRoutePath: new URL(request.url).pathname,
    });
    return { reviewId, status: "submitted" };
  } catch (error) {
    if (
      error instanceof MarketplaceApiError &&
      error.status === 409 &&
      reportErrorCode(error) === "report_already_submitted"
    ) {
      return { reviewId, status: "already-submitted" };
    }
    return { reviewId, status: "error", message: reportErrorMessage(error), values: { reason, details } };
  }
}
