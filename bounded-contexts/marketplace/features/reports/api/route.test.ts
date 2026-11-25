import { inspect } from "node:util";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import type { MarketplaceApiEnv } from "../../../api";
import { createMarketplaceReportRoutes } from "./route";
import { createMarketplaceReportRuntime } from "./runtime";

// Report details are private reporter evidence for human review. The public
// authored-text safeguard deliberately does not judge them, and they must
// never reach a response body or a log line in any outcome.
const SECRET_DETAILS = "SECRET-MARKER-7281 password=hunter2 javascript:alert(1) \u202Ereversed";

function actor(accountId: string): NonNullable<MarketplaceApiEnv["Variables"]["actor"]> {
  return {
    sessionId: `ses_${accountId}`,
    tenantId: "tnt_test",
    userId: `usr_${accountId}`,
    accountId,
    membershipId: `mbr_${accountId}`,
    roleKey: "owner",
    permissions: [],
  } as NonNullable<MarketplaceApiEnv["Variables"]["actor"]>;
}

async function createFixture({
  policyError,
  reviewLookupError,
}: { policyError?: Error; reviewLookupError?: Error } = {}) {
  const { allEvents, eventStore } = createInMemoryEventStore();
  const context = {
    tenantId: "tnt_test" as never,
    audit: { performedByUserId: "usr_seller" as never, forAccountId: "acc_seller" as never },
  };
  await eventStore.appendToStream({
    streamId: "marketplace.listing-lst_1",
    expectedVersion: "no_stream",
    context,
    events: [{ eventType: "marketplace.listing.created", payload: { listingId: "lst_1", accountId: "acc_seller" } }],
  });
  const db = {
    query: vi.fn(async () => ({
      rows: [
        {
          review_id: "rev_1",
          subject_account_id: "acc_seller",
          status: "active",
          revealed_at: "2026-04-05T00:00:00.000Z",
          held: false,
        },
      ],
    })),
  };
  if (reviewLookupError) db.query.mockRejectedValue(reviewLookupError);
  const resolvePolicy = vi.fn(async () => {
    throw policyError;
  });
  const app = new Hono<MarketplaceApiEnv>();
  app.onError(errorHandler);
  let current = actor("acc_reporter");
  app.use("*", async (c, next) => {
    c.set("actor", current);
    c.set("context", {
      tenantId: "tnt_test" as never,
      audit: { performedByUserId: current.userId as never, forAccountId: current.accountId as never },
    });
    await next();
  });
  app.route(
    "/",
    createMarketplaceReportRoutes(
      createMarketplaceReportRuntime({
        eventStore,
        db: db as never,
        policies: policyError ? { resolvePolicy } : undefined,
      }),
    ),
  );

  function requestReport(target: string, body: string) {
    return app.request(`/${target}/report`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  return {
    allEvents,
    resolvePolicy,
    db,
    eventStore,
    requestReport,
    actAs(accountId: string) {
      current = actor(accountId);
    },
    report(target: string, reason: string, attemptId: string = crypto.randomUUID(), bodyOverrides = {}) {
      return requestReport(
        target,
        JSON.stringify({ attemptId, reason, details: SECRET_DETAILS, sourceRoutePath: `/${target}`, ...bodyOverrides }),
      );
    },
  };
}

function captureConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("report error responses", () => {
  it("returns a sanitized 500 after a listing policy read rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const policyError = Object.assign(new Error("policy document store is unavailable"), {
      name: "PlatformPolicyDomainError",
    });
    const fixture = await createFixture({ policyError });
    fixture.actAs("acc_policy_failure");

    const response = await fixture.report("listings/lst_1", "other");
    const body = await response.text();

    expect(fixture.resolvePolicy).toHaveBeenCalledOnce();
    expect(fixture.allEvents.filter((event) => event.eventType === "marketplace.report.submitted")).toHaveLength(1);
    expect(response.status).toBe(500);
    expect(JSON.parse(body).error.code).toBe("internal_error");
    expect(body).not.toContain(policyError.message);
  });

  it("returns a sanitized 500 when the review lookup rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reviewLookupError = new Error("review projection connection is unavailable");
    const fixture = await createFixture({ reviewLookupError });
    fixture.actAs("acc_review_lookup_failure");

    const response = await fixture.report("reviews/rev_1", "other");
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(body).error.code).toBe("internal_error");
    expect(body).not.toContain(reviewLookupError.message);
  });

  it.each([
    ["listings/lst_1", "Report reason is invalid."],
    ["reviews/rev_1", "Review report reason is invalid."],
  ])("keeps the invalid-reason message for %s", async (target, message) => {
    const fixture = await createFixture();
    fixture.actAs(`acc_invalid_reason_${target.split("/")[0]}`);

    for (const [body, expectedMessage] of [
      ['{"reason":"not-a-reason"}', message],
      ["{", message],
      ["{}", message],
      ["null", "Cannot read properties of null (reading 'attemptId')"],
      ['{"reason":{"toString":null}}', "Cannot convert object to primitive value"],
    ] as const) {
      const response = await fixture.requestReport(target, body);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "validation_failed", message: expectedMessage } });
    }
  });

  it.each([
    ["listings/lst_1", "counterfeit-concern"],
    ["reviews/rev_1", "harassment-or-abuse"],
  ])("keeps the attempt conflict and invalid-attempt responses for %s", async (target, reason) => {
    const fixture = await createFixture();
    fixture.actAs(`acc_report_attempt_${target.split("/")[0]}`);
    const attemptId = crypto.randomUUID();

    expect((await fixture.report(target, reason, attemptId)).status).toBe(201);
    const conflict = await fixture.report(target, "other", attemptId);
    const invalid = await fixture.report(target, reason, "");

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: {
        code: "attempt_conflict",
        message: "Marketplace attempt identity was already used for a different command.",
      },
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({
      error: { code: "invalid_attempt", message: "A valid Marketplace attempt identity is required." },
    });
  });

  it.each(["listings/lst_1", "reviews/rev_1"])(
    "keeps the incomplete-attempt-history response for %s",
    async (target) => {
      const fixture = await createFixture();
      fixture.actAs("acc_incomplete_report_history");
      vi.spyOn(fixture.eventStore, "readStream").mockRejectedValueOnce(new Error("stream unavailable"));

      const response = await fixture.report(target, "other");

      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "history_incomplete", message: "Marketplace recovery history is incomplete." },
      });
    },
  );

  it.each([
    ["listings/lst_1", { details: "x".repeat(1001) }, "Report details must be 1000 characters or fewer."],
    ["reviews/rev_1", { sourceRoutePath: " " }, "Source route path is required."],
  ] as const)("keeps the domain validation message for %s", async (target, body, message) => {
    const fixture = await createFixture();
    fixture.actAs("acc_report_domain_validation");

    const response = await fixture.report(target, "other", undefined, body);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "validation_failed", message } });
  });

  it.each(["listings", "reviews"])("keeps the invalid target identity response for %s", async (target) => {
    const fixture = await createFixture();
    fixture.actAs("acc_invalid_report_target");

    const response = await fixture.report(`${target}/invalid%20id`, "other");

    expect(response.status).toBe(400);
    const { error } = await response.json();
    expect(error.code).toBe("validation_failed");
    expect(JSON.parse(error.message)).toMatchObject([{ path: ["target", "id"], code: "invalid_format" }]);
  });

  it("keeps the missing listing and review messages", async () => {
    const fixture = await createFixture();
    fixture.actAs("acc_missing_report_targets");
    fixture.db.query.mockResolvedValue({ rows: [] });

    const listing = await fixture.report("listings/lst_missing", "other");
    const review = await fixture.report("reviews/rev_missing", "other");

    expect(listing.status).toBe(400);
    expect(await listing.json()).toEqual({ error: { code: "validation_failed", message: "Listing not found." } });
    expect(review.status).toBe(400);
    expect(await review.json()).toEqual({ error: { code: "validation_failed", message: "Review not found." } });
  });
});

describe("issue-5258-marketplace-ac5 report details stay private and unjudged", () => {
  it.each([
    ["listings/lst_1", "counterfeit-concern", "acc_listing_reporter"],
    ["reviews/rev_1", "harassment-or-abuse", "acc_review_reporter"],
  ] as const)(
    "keeps %s report details out of every response and log across accepted, duplicate and invalid outcomes",
    async (target, reason, reporter) => {
      const consoleCalls = captureConsole();
      const fixture = await createFixture();
      fixture.actAs(reporter);

      const accepted = await fixture.report(target, reason);
      const duplicate = await fixture.report(target, reason);
      const invalid = await fixture.report(target, "not-a-reason");
      const bodies = await Promise.all([accepted, duplicate, invalid].map((response) => response.text()));

      expect([accepted.status, duplicate.status, invalid.status]).toEqual([201, 409, 400]);
      expect(JSON.parse(bodies[1]!).error).toEqual({
        code: "report_already_submitted",
        message: "This reporter has already reported this content.",
      });
      expect(bodies.join("\n")).not.toContain("SECRET-MARKER-7281");
      expect(
        inspect(
          consoleCalls.map((spy) => spy.mock.calls),
          { depth: null },
        ),
      ).not.toContain("SECRET-MARKER-7281");
      const reports = fixture.allEvents.filter((event) => event.eventType === "marketplace.report.submitted");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.payload).toMatchObject({ details: SECRET_DETAILS, sourceRoutePath: `/${target}` });
    },
  );

  it("keeps report details out of the rate-limited response", async () => {
    const consoleCalls = captureConsole();
    const fixture = await createFixture();
    fixture.actAs("acc_rate_limited_reporter");

    const responses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      responses.push(await fixture.report("listings/lst_1", "counterfeit-concern"));
    }
    const limited = responses.at(-1)!;
    const body = await limited.text();

    expect(limited.status).toBe(429);
    expect(JSON.parse(body).error.code).toBe("rate_limited");
    expect(body).not.toContain("SECRET-MARKER-7281");
    expect(
      inspect(
        consoleCalls.map((spy) => spy.mock.calls),
        { depth: null },
      ),
    ).not.toContain("SECRET-MARKER-7281");
  });
});
