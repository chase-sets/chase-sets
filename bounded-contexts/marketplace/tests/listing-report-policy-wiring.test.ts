import { describe, expect, it, vi } from "vitest";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import { createMarketplaceServices } from "../support/runtime-support/services";

// Hoisted by Vitest; hands the composed Marketplace services an in-memory event store.
const composition = vi.hoisted(() => ({ eventStore: undefined as EventStore | undefined }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => composition.eventStore,
}));

const policyKey = "marketplace.listing-report-auto-unlist";
const listingId = "lst_reported";
const context = {
  tenantId: "tnt_marketplace" as never,
  audit: { performedByUserId: "usr_reporter" as never, forAccountId: "acc_reporter" as never },
};
const feeTerms = {
  marketplaceSalesFeeUnitAmount: "1.20",
  sellerNetUnitAmount: "10.80",
  shippingAllowancePercentageBps: 500,
  termsScheduleId: null,
  termsAgreementId: null,
  termsResolvedAt: null,
  feeQuoteFingerprint: "fee_1",
};

/** An active Listing and one earlier visitor Report against it, a minute old. */
async function seedReportedActiveListing(eventStore: EventStore) {
  await eventStore.appendToStream({
    streamId: `marketplace.listing-${listingId}`,
    expectedVersion: 0,
    events: [
      {
        eventType: "marketplace.listing.created",
        payload: {
          listingId,
          accountId: "acc_seller",
          inventoryItemId: "inv_1",
          catalogItemId: "cat_1",
          productId: "cat_1::",
          itemLanguageCode: "en",
          itemTitle: "Reported listing",
          itemSubtitle: null,
          selectedOptions: [],
          productSummary: null,
          productMeasureSnapshot: { productId: "cat_1::" },
          gradedCard: null,
          storageLocationName: "Warehouse",
          shipFromCode: "CHI",
          shipFromAddress: {
            name: "Seller",
            line1: "1 Main",
            city: "Chicago",
            state: "IL",
            postalCode: "60601",
            country: "US",
          },
          priceAmount: "12.00",
          ...feeTerms,
          quantityCap: 1,
          purchaseLimits: { maxUnitsPerOrder: null, maxUnitsPerDay: null, maxUnitsPerCustomerAccount: null },
          evidence: [],
        },
      },
      { eventType: "marketplace.listing.published", payload: feeTerms },
    ],
    context,
  });
  await eventStore.appendToStream({
    streamId: `marketplace.report-listing-${listingId}-anon_earlier`,
    expectedVersion: 0,
    events: [
      {
        eventType: "marketplace.report.submitted",
        payload: {
          reportId: "rpt_earlier",
          targetType: "listing",
          targetId: listingId,
          targetOwnerAccountId: "acc_seller",
          reporterKind: "visitor",
          reporterKey: "anon_earlier",
          reporterAccountId: null,
          reporterUserId: null,
          reason: "counterfeit-concern",
          details: null,
          sourceRoutePath: "/listings/reported-listing",
          submittedAt: new Date(Date.now() - 60_000).toISOString(),
        },
      },
    ],
    context,
  });
}

describe("Marketplace services", () => {
  // The report runtime's policy runtime is optional, so leaving it out of
  // createMarketplaceServices type-checks and decides with the compiled default.
  it("decide a Listing Report with the Listing Report Auto-Unlist Policy read from the Marketplace database", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    composition.eventStore = eventStore;
    await seedReportedActiveListing(eventStore);
    const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => ({
      rowCount: 0,
      rows:
        sql.includes("FROM platform_policy_documents") && values.includes(policyKey)
          ? [
              {
                document_id: "pol_listing_report_auto_unlist",
                policy_key: policyKey,
                context_name: "marketplace",
                schema_summary: "{ distinctReporterThreshold: integer 2-100, windowDays: integer 1-90 }",
                status: "active",
                value: { distinctReporterThreshold: 2, windowDays: 7 },
                effective_from: "2026-07-01T00:00:00.000Z",
                effective_until: null,
                created_at: "2026-07-01T00:00:00.000Z",
                updated_at: "2026-07-01T00:00:00.000Z",
              },
            ]
          : [],
    }));
    const { reports } = createMarketplaceServices({ query } as never);

    const result = await reports.reportListing(
      {
        attemptId: "wiring_listing_report_0001",
        listingId,
        reporterKind: "visitor",
        reporterKey: "anon_reporter_1",
        reporterAccountId: null,
        reporterUserId: null,
        reason: "counterfeit-concern",
        sourceRoutePath: "/listings/reported-listing",
      },
      context,
    );

    expect(result).toMatchObject({ reportCount: 2, threshold: 2, autoUnlisted: true });
    expect(allEvents.filter((event) => event.eventType === "marketplace.listing.auto-unlisted")).toMatchObject([
      { payload: { reportId: result.reportId, reportCount: 2, threshold: 2 } },
    ]);
    expect(
      query.mock.calls.filter(
        ([sql, values]) => sql.includes("FROM platform_policy_documents") && values?.includes(policyKey),
      ),
    ).toHaveLength(1);
  });
});
