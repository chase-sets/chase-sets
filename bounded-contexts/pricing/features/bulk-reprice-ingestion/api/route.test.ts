import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PricingApiEnv } from "../../../api";
import { BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE } from "../domain/policy";
import { createBulkRepriceIngestionRoutes } from "./route";
import type { BulkRepriceIngestionServices, BulkRepriceJob } from "./runtime";

function actor(): NonNullable<PricingApiEnv["Variables"]["actor"]> {
  return {
    sessionId: "ses_1",
    tenantId: "ten_1",
    userId: "usr_1",
    accountId: "acc_1",
    membershipId: "mbr_1",
    roleKey: "owner",
    permissions: ["listings.manage"],
  };
}

function eventContext(): EventStoreContext {
  return {
    tenantId: "ten_1" as never,
    audit: {
      performedByUserId: "usr_1" as never,
      forAccountId: "acc_1" as never,
    },
  };
}

function queuedJob(): BulkRepriceJob {
  const now = "2026-07-16T00:00:00.000Z";
  return {
    jobId: "job_1",
    jobKind: "bulk-reprice",
    status: "queued",
    payload: { accountId: "acc_1", inputId: "bri_1", rowCount: 1 },
    progress: { phase: "queued", completed: 0, total: 1, message: "Bulk reprice job queued." },
    result: null,
    errorMessage: null,
    eventContext: eventContext(),
    claimOwnerId: null,
    claimedUntil: null,
    attemptCount: 0,
    nextEligibleAt: now,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now,
  };
}

function services(
  policy: Partial<typeof BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE> = {},
): BulkRepriceIngestionServices {
  let rateLimitCount = 0;
  return {
    resolvePolicy: vi.fn(async () => ({ ...BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE, ...policy })),
    checkCreateJobRateLimit: vi.fn(async () => {
      rateLimitCount += 1;
      const limit = policy.createJobRateLimitMax ?? BULK_REPRICE_INGESTION_LAUNCH_POLICY_VALUE.createJobRateLimitMax;
      return {
        limited: rateLimitCount > limit,
        count: rateLimitCount,
        limit,
        retryAfterSeconds: 60,
      };
    }),
    enqueueJob: vi.fn(async () => queuedJob()),
    getJob: vi.fn(async () => null),
    listJobEvents: vi.fn(async () => []),
    waitForJobEvents: vi.fn(async () => undefined),
    cancelJob: vi.fn(async () => queuedJob()),
    listJobRows: vi.fn(async () => []),
    getResultsCsv: vi.fn(async () => ""),
    pruneJobRetention: vi.fn(async () => 0),
    processNextBulkRepriceJob: vi.fn(async () => 0),
  };
}

function buildApp(featureServices: BulkRepriceIngestionServices) {
  const app = new Hono<PricingApiEnv>();
  app.use("*", async (c, next) => {
    c.set("actor", actor());
    c.set("context", eventContext());
    await next();
  });
  app.route("/account/bulk-reprice", createBulkRepriceIngestionRoutes(featureServices));
  return app;
}

function createJobRequest() {
  return new Request("http://pricing.test/account/bulk-reprice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows: [{ listingId: "lst_1", newPriceAmount: "12.00" }] }),
  });
}

describe("bulk reprice ingestion API route", () => {
  it("hides the whole feature mount when its launch policy is disabled", async () => {
    const featureServices = services({ enabled: false });
    const response = await buildApp(featureServices).request("/account/bulk-reprice/template.csv");

    expect(response.status).toBe(404);
    expect(featureServices.enqueueJob).not.toHaveBeenCalled();
  });

  it("enforces the effective m110 create-job rate-limit policy", async () => {
    const featureServices = services({ enabled: true, createJobRateLimitMax: 1, createJobRateLimitWindowMs: 60_000 });
    const app = buildApp(featureServices);

    const first = await app.fetch(createJobRequest());
    const second = await app.fetch(createJobRequest());

    expect(first.status).toBe(202);
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBe("60");
    expect(featureServices.enqueueJob).toHaveBeenCalledTimes(1);
    expect(featureServices.checkCreateJobRateLimit).toHaveBeenCalledTimes(2);
  });
});
