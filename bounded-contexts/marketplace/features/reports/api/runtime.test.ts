import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  AppendToStreamInput,
  GlobalPosition,
  ReadAllInput,
  ReadStreamInput,
  StoredEvent,
} from "@chase-sets/event-core/storage";
import { ZERO_GLOBAL_POSITION } from "@chase-sets/event-core/storage";
import {
  createMarketplaceReportRuntime,
  LISTING_REPORT_AUTO_UNLIST_THRESHOLD,
  LISTING_REPORT_AUTO_UNLIST_WINDOW_MS,
} from "./runtime";

function createReviewModerationTargetDbStub(
  reviews: Readonly<
    Record<string, Readonly<{ subject_account_id: string; status: string; revealed_at: string | null; held: boolean }>>
  >,
): PgQueryable {
  return {
    query: vi.fn(async (_sql: string, params: readonly unknown[] = []) => {
      const reviewId = String(params[0]);
      const row = reviews[reviewId];
      return { rows: row ? [{ review_id: reviewId, ...row }] : [] };
    }),
  } as unknown as PgQueryable;
}

const context = {
  tenantId: "tnt_marketplace" as never,
  audit: {
    performedByUserId: "usr_reporter" as never,
    forAccountId: "acc_reporter" as never,
  },
};

async function seedActiveListing(eventStore: EventStore, listingId = "lst_reported") {
  await eventStore.appendToStream({
    streamId: `marketplace.listing-${listingId}` as never,
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
          marketplaceSalesFeeUnitAmount: "1.20",
          sellerNetUnitAmount: "10.80",
          shippingAllowancePercentageBps: 500,
          termsScheduleId: null,
          termsAgreementId: null,
          termsResolvedAt: null,
          feeQuoteFingerprint: "fee_1",
          quantityCap: 1,
          purchaseLimits: {
            maxUnitsPerOrder: null,
            maxUnitsPerDay: null,
            maxUnitsPerCustomerAccount: null,
          },
          evidence: [],
        },
      },
      {
        eventType: "marketplace.listing.published",
        payload: {
          marketplaceSalesFeeUnitAmount: "1.20",
          sellerNetUnitAmount: "10.80",
          shippingAllowancePercentageBps: 500,
          termsScheduleId: null,
          termsAgreementId: null,
          termsResolvedAt: null,
          feeQuoteFingerprint: "fee_1",
        },
      },
    ],
    context,
  });
}

async function seedOldListingReport(eventStore: EventStore, listingId = "lst_reported") {
  const submittedAt = new Date(Date.now() - LISTING_REPORT_AUTO_UNLIST_WINDOW_MS - 60_000).toISOString();
  await eventStore.appendToStream({
    streamId: `marketplace.report-listing-${listingId}-anon_old` as never,
    expectedVersion: 0,
    events: [
      {
        eventType: "marketplace.report.submitted",
        payload: {
          reportId: "rpt_old",
          targetType: "listing",
          targetId: listingId,
          targetOwnerAccountId: "acc_seller",
          reporterKind: "visitor",
          reporterKey: "anon_old",
          reporterAccountId: null,
          reporterUserId: null,
          reason: "counterfeit-concern",
          details: null,
          sourceRoutePath: "/listings/reported-listing",
          submittedAt,
        },
      },
    ],
    context,
  });
}

describe("Marketplace report runtime", () => {
  it("auto-unlists an active listing only when the distinct reporter window threshold is reached", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    await seedActiveListing(eventStore);
    await seedOldListingReport(eventStore);
    const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });

    for (let index = 1; index < LISTING_REPORT_AUTO_UNLIST_THRESHOLD; index += 1) {
      const result = await reports.reportListing(
        {
          listingId: "lst_reported",
          reporterKind: "visitor",
          reporterKey: `anon_${index}`,
          reporterAccountId: null,
          reporterUserId: null,
          reason: "counterfeit-concern",
          details: null,
          sourceRoutePath: "/listings/reported-listing",
        },
        context,
      );

      expect(result.autoUnlisted).toBe(false);
      expect(result.reportCount).toBe(index);
    }

    const thresholdResult = await reports.reportListing(
      {
        listingId: "lst_reported",
        reporterKind: "account",
        reporterKey: "acc_buyer",
        reporterAccountId: "acc_buyer",
        reporterUserId: "usr_buyer",
        reason: "stolen-photos",
        details: "Wrong card shown.",
        sourceRoutePath: "/listings/reported-listing",
      },
      context,
    );

    expect(thresholdResult).toMatchObject({
      reportCount: LISTING_REPORT_AUTO_UNLIST_THRESHOLD,
      threshold: LISTING_REPORT_AUTO_UNLIST_THRESHOLD,
      autoUnlisted: true,
    });
    expect(allEvents.map((event) => event.eventType)).toContain("marketplace.listing.auto-unlisted");
  });

  it("rejects duplicate reports from the same reporter for the same listing", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedActiveListing(eventStore);
    const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });
    const input = {
      listingId: "lst_reported",
      reporterKind: "visitor" as const,
      reporterKey: "anon_dup",
      reporterAccountId: null,
      reporterUserId: null,
      reason: "other" as const,
      details: null,
      sourceRoutePath: "/listings/reported-listing",
    };

    await reports.reportListing(input, context);
    await expect(reports.reportListing(input, context)).rejects.toThrow("already reported");
  });
});

describe("Marketplace review report", () => {
  it("reports a revealed review into the same queue as listing reports", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    const db = createReviewModerationTargetDbStub({
      rev_1: {
        subject_account_id: "acc_seller",
        status: "active",
        revealed_at: "2026-07-01T00:00:00.000Z",
        held: false,
      },
    });
    const reports = createMarketplaceReportRuntime({ eventStore, db });

    const result = await reports.reportReview(
      {
        reviewId: "rev_1",
        reporterAccountId: "acc_reporter",
        reporterUserId: "usr_reporter",
        reason: "harassment-or-abuse",
        details: "Abusive language.",
        sourceRoutePath: "/accounts/acc_seller/reviews",
      },
      context,
    );

    expect(result.reportId).toMatch(/^rpt_/);
    const submitted = allEvents.find((event) => event.eventType === "marketplace.report.submitted");
    expect(submitted?.payload).toMatchObject({
      targetType: "review",
      targetId: "rev_1",
      targetOwnerAccountId: "acc_seller",
      reporterKind: "account",
      reporterAccountId: "acc_reporter",
      reason: "harassment-or-abuse",
    });
  });

  it("rejects reporting a review that does not exist", async () => {
    const { eventStore } = createInMemoryEventStore();
    const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });

    await expect(
      reports.reportReview(
        {
          reviewId: "rev_missing",
          reporterAccountId: "acc_reporter",
          reporterUserId: "usr_reporter",
          reason: "other",
          details: null,
          sourceRoutePath: "/accounts/acc_seller/reviews",
        },
        context,
      ),
    ).rejects.toThrow("Review not found.");
  });

  it("rejects reporting a review that has not been revealed yet", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = createReviewModerationTargetDbStub({
      rev_hidden: { subject_account_id: "acc_seller", status: "active", revealed_at: null, held: false },
    });
    const reports = createMarketplaceReportRuntime({ eventStore, db });

    await expect(
      reports.reportReview(
        {
          reviewId: "rev_hidden",
          reporterAccountId: "acc_reporter",
          reporterUserId: "usr_reporter",
          reason: "other",
          details: null,
          sourceRoutePath: "/accounts/acc_seller/reviews",
        },
        context,
      ),
    ).rejects.toThrow("has not been revealed yet");
  });

  it("rejects reporting a held review even when its stored content was previously revealed", async () => {
    const { eventStore } = createInMemoryEventStore();
    const db = createReviewModerationTargetDbStub({
      rev_held: {
        subject_account_id: "acc_seller",
        status: "active",
        revealed_at: "2026-07-01T00:00:00.000Z",
        held: true,
      },
    });
    const reports = createMarketplaceReportRuntime({ eventStore, db });

    await expect(
      reports.reportReview(
        {
          reviewId: "rev_held",
          reporterAccountId: "acc_reporter",
          reporterUserId: "usr_reporter",
          reason: "personal-information",
          details: null,
          sourceRoutePath: "/accounts/acc_seller/reviews",
        },
        context,
      ),
    ).rejects.toThrow("not publicly available");
  });
});
