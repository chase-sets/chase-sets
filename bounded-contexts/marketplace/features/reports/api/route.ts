import { t } from "@chase-sets/localization";
import {
  createConfiguredInMemoryRateLimiter,
  publicClientRequestKey,
  rateLimitExceededJsonResponse,
} from "@chase-sets/http/rate-limit";
import { Hono } from "hono";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { MarketplaceApiEnv } from "../../../api";
import type { MarketplaceReportReason } from "../domain/domain";
import type { MarketplaceReportServices } from "./runtime";

const reportListingSubmitRateLimiter = createConfiguredInMemoryRateLimiter("marketplace.report-listing.submit", {
  max: 5,
  windowMs: 10 * 60 * 1000,
});

const MARKETPLACE_REPORT_SYSTEM_TENANT_ID = "tnt_marketplace_reports" as TenantId;
const MARKETPLACE_REPORT_SYSTEM_USER_ID = "usr_marketplace_reports" as UserId;

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("marketplace.features.reports.api.request.failed");
}

function normalizeReason(value: unknown): MarketplaceReportReason {
  const reason = String(value ?? "").trim();
  if (
    reason === "counterfeit-concern" ||
    reason === "stolen-photos" ||
    reason === "prohibited-item" ||
    reason === "pricing-scam" ||
    reason === "other"
  ) {
    return reason;
  }

  throw new Error("Report reason is invalid.");
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
      forAccountId: reporterKey as AccountId,
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
          listingId: c.req.param("id"),
          reporterKind: actor ? "account" : "visitor",
          reporterKey: actor?.accountId ?? visitorKey ?? "",
          reporterAccountId: actor?.accountId ?? null,
          reporterUserId: actor?.userId ?? null,
          reason: normalizeReason(body.reason),
          details: typeof body.details === "string" ? body.details : null,
          sourceRoutePath: typeof body.sourceRoutePath === "string" ? body.sourceRoutePath : "/listings",
        },
        context,
      );

      return c.json(
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
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
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
          reviewId: c.req.param("id"),
          reporterAccountId: actor.accountId,
          reporterUserId: actor.userId,
          reason: normalizeReason(body.reason),
          details: typeof body.details === "string" ? body.details : null,
          sourceRoutePath: typeof body.sourceRoutePath === "string" ? body.sourceRoutePath : "/reviews",
        },
        context,
      );

      return c.json(
        {
          id: result.reportId,
          version: result.version,
          status: "submitted",
          targetType: "review",
          targetId: c.req.param("id"),
        },
        201,
      );
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  return app;
}
