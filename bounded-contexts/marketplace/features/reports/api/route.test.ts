import { inspect } from "node:util";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { MarketplaceApiEnv } from "../../../api";
import { createMarketplaceReportRoutes } from "./route";
import { createMarketplaceReportRuntime } from "./runtime";

// Report details are private reporter evidence for human review. The public
// authored-text safeguard deliberately does not judge them, and they must
// never reach a response body or a log line in any outcome.
const SECRET_DETAILS = "SECRET-MARKER-7281 password=hunter2 javascript:alert(1) ‮reversed";

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

async function createFixture() {
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
  const app = new Hono<MarketplaceApiEnv>();
  let current = actor("acc_reporter");
  app.use("*", async (c, next) => {
    c.set("actor", current);
    c.set("context", {
      tenantId: "tnt_test" as never,
      audit: { performedByUserId: current.userId as never, forAccountId: current.accountId as never },
    });
    await next();
  });
  app.route("/", createMarketplaceReportRoutes(createMarketplaceReportRuntime({ eventStore, db: db as never })));

  return {
    allEvents,
    actAs(accountId: string) {
      current = actor(accountId);
    },
    report(target: "listings/lst_1" | "reviews/rev_1", reason: string) {
      return app.request(`/${target}/report`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason, details: SECRET_DETAILS, sourceRoutePath: `/${target}` }),
      });
    },
  };
}

function captureConsole() {
  return (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => undefined),
  );
}

afterEach(() => vi.restoreAllMocks());

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
      expect(JSON.parse(bodies[1]!).error.code).toBe("report_already_submitted");
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
