import { t } from "@chase-sets/localization";
import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { Hono, type Context } from "hono";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { MarketplaceApiEnv } from "../../../api";
import { marketplaceListingReportReasons, marketplaceReviewReportReasons } from "../domain/domain";
import { DuplicateReportError, reportValidationError, type MarketplaceReportServices } from "./runtime";
import { MarketplaceListingDomainError } from "../../listings/domain/listing-error";
import { ReputationDomainError } from "../../reviews/domain/common";
import { MarketplaceAttemptError } from "../../mutation-recovery/api/attempt";
import { marketplaceReceiptResponse } from "../../mutation-recovery/api/receipt";
import { marketplaceReporterFingerprint } from "./reporter";

const reportListingSubmitRateLimiter = createConfiguredInMemoryRateLimiter("marketplace.report-listing.submit", {
  max: 5,
  windowMs: 10 * 60 * 1000,
});

const MARKETPLACE_REPORT_SYSTEM_TENANT_ID = "tnt_marketplace_reports" as TenantId;
const MARKETPLACE_REPORT_SYSTEM_USER_ID = "usr_marketplace_reports" as UserId;

function reportErrorResponse(c: Context<MarketplaceApiEnv>, error: unknown) {
  if (error instanceof MarketplaceAttemptError) {
    return c.json(
      { error: { code: error.code, message: error.message } },
      error.code === "attempt_conflict" ? 409 : error.code === "history_incomplete" ? 503 : 400,
    );
  }
  if (error instanceof DuplicateReportError) {
    return c.json({ error: { code: "report_already_submitted", message: error.message } }, 409);
  }
  if (error instanceof MarketplaceListingDomainError || error instanceof ReputationDomainError) {
    return c.json({ error: { code: "validation_failed", message: error.message } }, 400);
  }
  // Do not let a dependency's domain name or concurrency code turn a server failure into a caller error.
  throw new Error("Report submission failed.", { cause: error });
}

function reportRequestFields<Reason extends string>(
  body: Record<string, unknown>,
  target: "listing" | "review",
  reasons: readonly Reason[],
  invalidReasonMessage: string,
) {
  try {
    const attemptId = typeof body.attemptId === "string" ? body.attemptId : "";
    const reasonText = String(body.reason ?? "").trim();
    const reason = reasons.find((allowed) => allowed === reasonText);
    if (!reason) throw reportValidationError(target, invalidReasonMessage);
    return {
      attemptId,
      reason,
      details: typeof body.details === "string" ? body.details : null,
      sourceRoutePath: typeof body.sourceRoutePath === "string" ? body.sourceRoutePath : `/${target}s`,
    };
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) throw reportValidationError(target, error.message);
    throw error;
  }
}

function visitorReporterKey(c: { req: { header(name: string): string | undefined } }) {
  const value = c.req.header("x-marketplace-anonymous-report-id")?.trim() ?? "";
  return value.startsWith("anon_") ? value : null;
}

function createVisitorReportContext(reporterKey: string): EventStoreContext {
  return {
    tenantId: MARKETPLACE_REPORT_SYSTEM_TENANT_ID,
    audit: {
      performedByUserId: MARKETPLACE_REPORT_SYSTEM_USER_ID,
      forAccountId: marketplaceReporterFingerprint("visitor", reporterKey) as AccountId,
    },
  };
}

export function createMarketplaceReportRoutes(services: MarketplaceReportServices) {
  const app = new Hono<MarketplaceApiEnv>();

  app.post("/listings/:id/report", async (c) => {
    const actor = c.get("actor");
    const visitorKey = actor ? null : visitorReporterKey(c);
    if (!actor && !visitorKey) {
      return c.json(
        {
          error: {
            code: "reporter_required",
            message: t("marketplace.features.reports.api.reporter.required"),
          },
        },
        400,
      );
    }

    const rateLimitKey = actor
      ? `account:${actor.accountId}`
      : `visitor:${visitorKey ?? publicClientRequestKey(c.req.raw)}`;
    const rateLimit = reportListingSubmitRateLimiter.check(rateLimitKey);
    if (rateLimit.limited) {
      return rateLimitExceededJsonResponse("marketplace.report-listing.submit", rateLimit);
    }

    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context") ?? createVisitorReportContext(visitorKey ?? actor!.accountId);

    try {
      const result = await services.reportListing(
        {
          ...reportRequestFields(body, "listing", marketplaceListingReportReasons, "Report reason is invalid."),
          listingId: c.req.param("id"),
          reporterKind: actor ? "account" : "visitor",
          reporterKey: actor?.accountId ?? visitorKey ?? "",
          reporterAccountId: actor?.accountId ?? null,
          reporterUserId: actor?.userId ?? null,
        },
        context,
      );

      return marketplaceReceiptResponse(
        c.json(
          {
            id: result.reportId,
            version: result.version,
            status: "submitted",
            targetType: "listing",
            targetId: c.req.param("id"),
            reportCount: result.reportCount,
            threshold: result.threshold,
            autoUnlisted: result.autoUnlisted,
          },
          201,
        ),
        result,
      );
    } catch (error) {
      return reportErrorResponse(c, error);
    }
  });

  // Reviews (m108): authenticated only, unlike listing reports --
  // reviews already require a verified transaction, so anonymous reporting
  // is not needed.
  app.post("/reviews/:id/report", async (c) => {
    const actor = c.get("actor");
    if (!actor) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.reports.api.reporter.required"),
          },
        },
        401,
      );
    }

    const rateLimit = reportListingSubmitRateLimiter.check(`account:${actor.accountId}`);
    if (rateLimit.limited) {
      return rateLimitExceededJsonResponse("marketplace.report-listing.submit", rateLimit);
    }

    const body = await c.req.json().catch(() => ({}));
    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("marketplace.features.reports.api.reporter.required"),
          },
        },
        401,
      );
    }

    try {
      const result = await services.reportReview(
        {
          ...reportRequestFields(body, "review", marketplaceReviewReportReasons, "Review report reason is invalid."),
          reviewId: c.req.param("id"),
          reporterAccountId: actor.accountId,
          reporterUserId: actor.userId,
        },
        context,
      );

      return marketplaceReceiptResponse(
        c.json(
          {
            id: result.reportId,
            version: result.version,
            status: "submitted",
            targetType: "review",
            targetId: c.req.param("id"),
          },
          201,
        ),
        result,
      );
    } catch (error) {
      return reportErrorResponse(c, error);
    }
  });

  return app;
}
