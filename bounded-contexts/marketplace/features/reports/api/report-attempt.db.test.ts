import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  closeMultiContextTestPools, createMultiContextTestDatabaseUrls, createMultiContextTestPools,
  ensureMultiContextTestDatabases, resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { getMutationResultCommandReceipt } from "@chase-sets/http/responses";
import { module as marketplaceModule } from "../../../index";
import { createMarketplaceReportRuntime } from "./runtime";
import { createMarketplaceMutationLookup } from "../../mutation-recovery/api/lookup";
import { marketplaceCanonicalRequest } from "../../mutation-recovery/domain/contracts";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";

const url = process.env.TEST_DATABASE_URL;
if (!url && process.env.CI) throw new Error("TEST_DATABASE_URL is required for report attempt DB proof.");
const dbDescribe = url ? describe : describe.skip;
const context: EventStoreContext = { tenantId: "tnt_marketplace", audit: { performedByUserId: "usr_reporter", forAccountId: "acc_reporter" } };
const visitor = (id: number) => ({
  attemptId: `report_listing_identity_${id.toString().padStart(4, "0")}`, listingId: "lst_one",
  reporterKind: "visitor" as const, reporterKey: `anon_visitor_${id}`, reporterAccountId: null, reporterUserId: null,
  reason: "other" as const, details: "Please check.", sourceRoutePath: "/listings/one",
});

dbDescribe("report first outcomes and threshold repair on PostgreSQL", () => {
  let pools: Readonly<Record<"marketplace", PgTransactionalPool>>;
  let store: EventStore;
  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(url!, ["marketplace"], "marketplace_report_attempts");
    await ensureMultiContextTestDatabases(url!, urls);
    pools = createMultiContextTestPools(urls);
  });
  beforeEach(async () => {
    await resetMultiContextTestSchemas(pools);
    await bootstrapContextDatabase(marketplaceModule, pools.marketplace);
    store = createPostgresEventStore({ pool: pools.marketplace });
    await store.appendToStream({
      streamId: "marketplace.listing-lst_one", expectedVersion: "no_stream", context,
      events: [{
        eventType: "marketplace.listing.created", payload: {
          listingId: "lst_one", accountId: "acc_seller", inventoryItemId: "inv_one", catalogItemId: "cat_one",
          productId: "cat_one::", itemTitle: "Item", selectedOptions: [], priceAmount: "10.00", priceCurrencyCode: "USD",
          marketplaceSalesFeeUnitAmount: "0", sellerNetUnitAmount: "10", shippingAllowancePercentageBps: 500,
          termsScheduleId: null, termsAgreementId: null, termsResolvedAt: null, feeQuoteFingerprint: "fixture", feeLocks: [],
          quantityCap: 10, purchaseLimits: { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
          evidence: [],
        },
      }, { eventType: "marketplace.listing.published", payload: {} }],
    });
    await pools.marketplace.query(`INSERT INTO marketplace_review_pages
      (review_id, order_id, author_account_id, subject_account_id, author_role, rating, feedback, status, submitted_at, updated_at, revealed_at)
      VALUES ('rev_one','ord_one','acc_buyer','acc_seller','buyer',5,'Feedback','active',NOW(),NOW(),NOW())`);
  });
  afterAll(async () => { if (pools) await closeMultiContextTestPools(pools); });
  const runtime = (eventStore = store) => createMarketplaceReportRuntime({ eventStore, db: pools.marketplace });
  const events = () => store.readAll();

  it.each(["visitor", "account"] as const)("recovers lost completion and concurrent %s replay without raw visitor identity", async (kind) => {
    const input = kind === "visitor" ? visitor(1) : { ...visitor(1), reporterKind: kind, reporterKey: "acc_reporter", reporterAccountId: "acc_reporter", reporterUserId: "usr_reporter" };
    const interrupted: EventStore = { ...store, appendToStreams: async (inputs) => {
      await store.appendToStreams!(inputs); throw new Error("Completion response lost");
    } };
    await expect(runtime(interrupted).reportListing(input, context)).rejects.toThrow("Completion response lost");
    const [first, replay] = await Promise.all([runtime().reportListing(input, context), runtime().reportListing(input, context)]);
    expect(first).toEqual(replay);
    expect(getMutationResultCommandReceipt(first)).toEqual(getMutationResultCommandReceipt(replay));
    expect((await events()).filter((event) => event.eventType === "marketplace.report.submitted")).toHaveLength(1);
    expect((await events()).filter((event) => event.eventType === "marketplace.mutation-attempt.completed")).toHaveLength(1);
    expect(first).toMatchObject({ reportCount: 1, autoUnlisted: false });
    await expect(runtime().reportListing({ ...input, details: "Changed" }, context)).rejects.toMatchObject({ code: "attempt_conflict" });
    if (kind === "visitor") expect(JSON.stringify(await events())).not.toContain(input.reporterKey);
  });

  it("converges Review reports, isolates account lookup, and conflicts changed reasons", async () => {
    const input = { attemptId: "review_report_identity_0001", reviewId: "rev_one", reporterAccountId: "acc_reporter", reporterUserId: "usr_reporter", reason: "other" as const, details: "Please check.", sourceRoutePath: "/accounts/seller" };
    const [first, replay] = await Promise.all([runtime().reportReview(input, context), runtime().reportReview(input, context)]);
    expect(first).toEqual(replay);
    await expect(runtime().reportReview({ ...input, reason: "personal-information" }, context)).rejects.toMatchObject({ code: "attempt_conflict" });
    expect(await createMarketplaceMutationLookup(store)({
      attemptId: input.attemptId, accountId: "acc_other", mutationKind: "review.report", target: { kind: "review", id: "rev_one" },
      requestHash: hashMarketplaceRequest(marketplaceCanonicalRequest("review.report", { targetId: input.reviewId, reason: input.reason, details: input.details })),
    })).toMatchObject({ ownerStatus: "not-observed" });
  });

  it.each(["retry", "next-report"] as const)("repairs append/effect interruption through %s with one report-keyed enforcement", async (mode) => {
    await runtime().reportListing(visitor(1), context);
    await runtime().reportListing(visitor(2), context);
    const interrupted: EventStore = { ...store, appendToStream: async (input) => {
      if (input.events.some((event) => event.eventType === "marketplace.listing.auto-unlisted")) throw new Error("Effect interrupted");
      return store.appendToStream(input);
    } };
    await expect(runtime(interrupted).reportListing(visitor(3), context)).rejects.toThrow("Effect interrupted");
    expect((await events()).filter((event) => event.eventType === "marketplace.report.submitted")).toHaveLength(3);
    expect((await events()).filter((event) => event.eventType === "marketplace.listing.auto-unlisted")).toHaveLength(0);
    if (mode === "next-report") await runtime().reportListing(visitor(4), context);
    await Promise.all([runtime().reportListing(visitor(3), context), runtime().reportListing(visitor(3), context)]);
    const all = await events();
    const removals = all.filter((event) => event.eventType === "marketplace.listing.auto-unlisted");
    expect(removals).toHaveLength(1);
    const triggering = all.filter((event) => event.eventType === "marketplace.report.submitted")[2]!;
    expect(removals[0]!.payload).toMatchObject({ reportId: triggering.payload.reportId, listingEnforcement: { sourceActionId: triggering.payload.reportId } });
    const count = all.length;
    await runtime().reportListing(visitor(3), context);
    expect(await events()).toHaveLength(count);
  });

  it("never counts concurrent threshold-minus-one replay as another reporter", async () => {
    await runtime().reportListing(visitor(1), context);
    const outcomes = await Promise.all(Array.from({ length: 6 }, () => runtime().reportListing(visitor(2), context)));
    expect(outcomes.every((value) => value.reportCount === 2 && !value.autoUnlisted)).toBe(true);
    const all = await events();
    expect(all.filter((event) => event.eventType === "marketplace.report.submitted")).toHaveLength(2);
    expect(all.filter((event) => event.eventType === "marketplace.listing.auto-unlisted")).toHaveLength(0);
  });
});
