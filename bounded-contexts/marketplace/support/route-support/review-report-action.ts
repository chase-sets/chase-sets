import { MarketplaceApiError } from "../request-support/api-client";
import { createMarketplaceRequestApiClient } from "../request-support/api-client";
import type { ReportReviewRequest } from "../request-support/api-client";
import type { ReviewReportResult } from "../../features/reviews/ui/review-report-action";
import { runReviewMutation } from "./review-mutation-action";

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
  if (!["report-review", "confirm:report-review"].includes(String(formData.get("intent")))) {
    return null;
  }

  const reviewId = String(formData.get("reviewId") ?? "");
  const reason = String(formData.get("reason") ?? "");
  const details = String(formData.get("details") ?? "");
  const attemptId = String(formData.get("attemptId") ?? "");
  if (!reviewId) {
    return { reviewId, status: "error", message: "Review not found.", values: { reason, details } };
  }

  try {
    const api = createMarketplaceRequestApiClient(request);
    const body = {
      attemptId,
      reason: reason as ReportReviewRequest["reason"],
      details: details || null,
      sourceRoutePath: new URL(request.url).pathname,
    };
    const outcome = await runReviewMutation({
      formData,
      kind: "review.report",
      target: reviewId,
      request: { targetId: reviewId, ...body },
      send: () => api.reportReview(reviewId, body),
      replay: () => api.reportReview(reviewId, body),
      lookup: api.lookupMutationAttempt,
      isResponse: (error) => error instanceof MarketplaceApiError,
      code: (error) => (error instanceof MarketplaceApiError ? reportErrorCode(error) : null),
    });
    if (!("result" in outcome)) return { ...outcome, reviewId, status: "error", values: { reason, details } };
    return { reviewId, status: "submitted", attemptId, mutationPhase: "succeeded" };
  } catch (error) {
    if (error instanceof MarketplaceApiError && error.status === 401) throw error;
    if (
      error instanceof MarketplaceApiError &&
      error.status === 409 &&
      reportErrorCode(error) === "report_already_submitted"
    ) {
      return { reviewId, status: "already-submitted", attemptId, mutationPhase: "succeeded" };
    }
    return {
      reviewId,
      status: "error",
      message: reportErrorMessage(error),
      error: reportErrorMessage(error),
      values: { reason, details },
      attemptId,
      mutationPhase: "failed-safe",
    };
  }
}
