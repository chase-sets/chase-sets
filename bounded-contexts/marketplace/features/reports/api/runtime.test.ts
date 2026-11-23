import { describe, expect, it, vi } from "vitest";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getMutationResultCommandReceipt } from "@chase-sets/http/responses";
import type { PolicyRuntime } from "@chase-sets/platform-policy/runtime";
import type { JsonValue } from "@chase-sets/primitives/json";
import { createMarketplaceServices } from "../../../support/runtime-support/services";
import { createMarketplaceReportRuntime } from "./runtime";

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
// The terms in force when no Listing Report Auto-Unlist Policy document is active.
const DEFAULT_DISTINCT_REPORTER_THRESHOLD = 3;
const DEFAULT_WINDOW_DAYS = 7;

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
      listingPublished,
    ],
    context,
  });
}

const listingPublished = {
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
};

function reportListingAsVisitor(reports: ReturnType<typeof createMarketplaceReportRuntime>, index: number) {
  return reports.reportListing(
    {
      attemptId: `activation_listing_report_${index}`,
      listingId: "lst_reported",
      reporterKind: "visitor",
      reporterKey: `anon_reporter_${index}`,
      reporterAccountId: null,
      reporterUserId: null,
      reason: "counterfeit-concern",
      sourceRoutePath: "/listings/reported-listing",
    },
    context,
  );
}

/** Stores one earlier visitor Report against the Listing, submitted `ageMs` before now. */
async function seedEarlierListingReport(eventStore: EventStore, ageMs: number, listingId = "lst_reported") {
  const submittedAt = new Date(Date.now() - ageMs).toISOString();
  await eventStore.appendToStream({
    streamId: `marketplace.report-listing-${listingId}-anon_earlier` as never,
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
          submittedAt,
        },
      },
    ],
    context,
  });
}

/**
 * A Marketplace policy runtime holding one Listing Report Auto-Unlist Policy
 * document. It decodes the stored value through the policy's own decoder, as
 * the platform resolver does, and records what each resolution asked for.
 */
function createListingReportPolicies(document: JsonValue) {
  let stored: JsonValue | Error = document;
  const resolutions: { policyKey: string; at: string | undefined }[] = [];
  const policies: Pick<PolicyRuntime, "resolvePolicy"> = {
    resolvePolicy(definition, params) {
      resolutions.push({ policyKey: definition.policyKey, at: params?.at });
      if (stored instanceof Error) return Promise.reject(stored);
      return Promise.resolve({
        policyKey: definition.policyKey,
        value: definition.decodeValue(stored),
        source: "policy",
        documentId: "pol_listing_report_auto_unlist",
        effectiveFrom: "2026-07-01T00:00:00.000Z",
        effectiveUntil: null,
        resolvedAt: new Date().toISOString(),
      });
    },
  };
  return {
    policies,
    resolutions,
    revise(next: JsonValue) {
      stored = next;
    },
    failWith(error: Error) {
      stored = error;
    },
  };
}

const currentTimeResolution = { policyKey: "marketplace.listing-report-auto-unlist", at: undefined };

function autoUnlistedEvents(allEvents: readonly { eventType: string; payload: unknown }[]) {
  return allEvents.filter((event) => event.eventType === "marketplace.listing.auto-unlisted");
}

describe("Marketplace report runtime", () => {
  it("bounded-contexts/marketplace/features/reports/api/runtime.ts#readStream#1", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    await seedActiveListing(eventStore);
    const streamId = "marketplace.report-listing-lst_reported-visitor:anon_legacy";
    await eventStore.appendToStream({
      streamId,
      expectedVersion: "no_stream",
      events: [
        {
          eventType: "marketplace.report.submitted",
          payload: {
            reportId: "rpt_legacy",
            targetType: "listing",
            targetId: "lst_reported",
            targetOwnerAccountId: "acc_seller",
            reporterKind: "visitor",
            reporterKey: "visitor:anon_legacy",
            reporterAccountId: null,
            reporterUserId: null,
            reason: "other",
            details: null,
            sourceRoutePath: "/listings/reported-listing",
            submittedAt: new Date().toISOString(),
          },
        },
      ],
      context,
    });
    const read = vi.spyOn(eventStore, "readStream");
    const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });
    const eventCount = allEvents.length;

    await expect(
      reports.reportListing(
        {
          attemptId: "legacy_report_attempt_0001",
          listingId: "lst_reported",
          reporterKind: "visitor",
          reporterKey: "anon_legacy",
          reporterAccountId: null,
          reporterUserId: null,
          reason: "other",
          details: null,
          sourceRoutePath: "/listings/reported-listing",
        },
        context,
      ),
    ).rejects.toThrow("This reporter has already reported this content.");
    expect(read.mock.calls.filter(([request]) => request.streamId === streamId)).toEqual([[{ streamId, limit: 1 }]]);
    expect(allEvents).toHaveLength(eventCount);
  });

  it("auto-unlists an active listing only when the distinct reporter window threshold is reached", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    await seedActiveListing(eventStore);
    await seedEarlierListingReport(eventStore, DEFAULT_WINDOW_DAYS * MILLISECONDS_PER_DAY + 60_000);
    const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });

    for (let index = 1; index < DEFAULT_DISTINCT_REPORTER_THRESHOLD; index += 1) {
      const result = await reports.reportListing(
        {
          attemptId: `listing_report_attempt_${index.toString().padStart(4, "0")}`,
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
        attemptId: "account_report_attempt_0001",
        listingId: "lst_reported",
        reporterKind: "account",
        reporterKey: "acc_buyer",
        reporterAccountId: "acc_buyer",
        reporterUserId: "usr_buyer",
        reason: "stolen-photos",
        details: "Wrong card shown.",
        sourceRoutePath: "/listings/reported-listing",
      },
      { ...context, audit: { ...context.audit, forAccountId: "acc_buyer" as never } },
    );

    expect(thresholdResult).toMatchObject({
      reportCount: DEFAULT_DISTINCT_REPORTER_THRESHOLD,
      threshold: DEFAULT_DISTINCT_REPORTER_THRESHOLD,
      autoUnlisted: true,
    });
    expect(allEvents.map((event) => event.eventType)).toContain("marketplace.listing.auto-unlisted");
    expect(allEvents.filter((event) => event.eventType === "marketplace.mutation-attempt.completed")).toHaveLength(
      DEFAULT_DISTINCT_REPORTER_THRESHOLD,
    );
    expect(getMutationResultCommandReceipt(thresholdResult)?.commitEventIds).toEqual([allEvents.at(-1)!.eventId]);
  });

  it.each([0, 501])(
    "mints one listing enforcement identity per automatic removal and keeps the threshold payload after %i unrelated reports",
    async (unrelatedCount) => {
      const { eventStore, allEvents } = createInMemoryEventStore();
      await seedActiveListing(eventStore);
      if (unrelatedCount) {
        await eventStore.appendToStream({
          streamId: "marketplace.report-unrelated-history",
          expectedVersion: "no_stream",
          context,
          events: Array.from({ length: unrelatedCount }, (_, index) => ({
            eventType: "marketplace.report.submitted",
            payload: {
              reportId: `rpt_unrelated_${index}`,
              targetType: "listing",
              targetId: "lst_unrelated",
              reporterKind: "visitor",
              reporterKey: `anon_unrelated_${index}`,
              submittedAt: new Date().toISOString(),
            },
          })),
        });
      }
      const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });
      const report = (index: number) =>
        reports.reportListing(
          {
            attemptId: `enforcement_report_attempt_${index.toString().padStart(4, "0")}`,
            listingId: "lst_reported",
            reporterKind: "visitor",
            reporterKey: `anon_enforcement_${index}`,
            reporterAccountId: null,
            reporterUserId: null,
            reason: "counterfeit-concern",
            details: null,
            sourceRoutePath: "/listings/reported-listing",
          },
          context,
        );
      const { createId, parseStrictTypedUlid } = await import("@chase-sets/primitives/typed-ids");
      const { parseIsoUtcTimestamp } = await import("@chase-sets/primitives/iso-utc-timestamp");
      vi.mocked(createId).mockClear();

      const results = [];
      for (let index = 1; index <= DEFAULT_DISTINCT_REPORTER_THRESHOLD + 1; index += 1) {
        results.push(await report(index));
      }

      expect(results.map((result) => result.autoUnlisted)).toEqual([false, false, true, false]);
      const { calls, results: minted } = vi.mocked(createId).mock;
      const leaMints = calls.flatMap(([prefix], index) => (prefix === "lea" ? [minted[index]!.value] : []));
      const removals = allEvents.filter((event) => event.eventType === "marketplace.listing.auto-unlisted");
      expect(removals).toHaveLength(1);
      const thresholdReport = results[DEFAULT_DISTINCT_REPORTER_THRESHOLD - 1]!;
      const payload = removals[0]!.payload as Readonly<Record<string, unknown>> & {
        autoUnlistedAt: string;
        listingEnforcement: Readonly<{ listingEnforcementActionId: string }>;
      };
      expect(payload).toEqual({
        reportId: thresholdReport.reportId,
        reportCount: DEFAULT_DISTINCT_REPORTER_THRESHOLD,
        threshold: DEFAULT_DISTINCT_REPORTER_THRESHOLD,
        autoUnlistedAt: payload.autoUnlistedAt,
        listingEnforcement: {
          version: 1,
          listingEnforcementActionId: payload.listingEnforcement.listingEnforcementActionId,
          accountId: "acc_seller",
          source: "automatic-report-threshold",
          sourceActionId: thresholdReport.reportId,
          occurredAt: payload.autoUnlistedAt,
        },
      });
      expect(leaMints).toEqual([payload.listingEnforcement.listingEnforcementActionId]);
      expect(parseStrictTypedUlid(payload.listingEnforcement.listingEnforcementActionId, "lea")).toBeTruthy();
      expect(parseIsoUtcTimestamp(payload.autoUnlistedAt)).toBe(payload.autoUnlistedAt);
    },
  );

  it("auto-unlists a republished listing again using the next distinct report as the enforcement source", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    await seedActiveListing(eventStore);
    const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });
    const report = (index: number) =>
      reports.reportListing(
        {
          attemptId: `republished_listing_report_${index}`,
          listingId: "lst_reported",
          reporterKind: "visitor",
          reporterKey: `anon_reporter_${index}`,
          reporterAccountId: null,
          reporterUserId: null,
          reason: "counterfeit-concern",
          sourceRoutePath: "/listings/reported-listing",
        },
        context,
      );

    await report(1);
    await report(2);
    const firstCrossing = await report(3);
    expect(firstCrossing.autoUnlisted).toBe(true);
    const streamId = "marketplace.listing-lst_reported";
    await eventStore.appendToStream({
      streamId,
      expectedVersion: (await eventStore.readStream({ streamId })).length,
      events: [listingPublished],
      context,
    });

    const fourth = await report(4);
    expect(fourth).toMatchObject({ reportCount: 4, autoUnlisted: true });
    expect(await report(4)).toEqual(fourth);
    expect(allEvents.filter((event) => event.eventType === "marketplace.listing.auto-unlisted")).toMatchObject([
      { payload: { reportId: firstCrossing.reportId, listingEnforcement: { sourceActionId: firstCrossing.reportId } } },
      { payload: { reportId: fourth.reportId, listingEnforcement: { sourceActionId: fourth.reportId } } },
    ]);
  });

  it("attributes a re-unlist to the report after republish, not a report made while unlisted", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { eventStore, allEvents } = createInMemoryEventStore();
      vi.setSystemTime(new Date("2026-07-07T00:00:00.000Z"));
      await seedActiveListing(eventStore);
      const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });
      const report = (index: number) => {
        vi.setSystemTime(new Date(`2026-07-07T00:0${index}:00.000Z`));
        return reportListingAsVisitor(reports, index);
      };

      await report(1);
      await report(2);
      const crossing = await report(3);
      expect(crossing.autoUnlisted).toBe(true);
      expect((await report(4)).autoUnlisted).toBe(false);

      vi.setSystemTime(new Date("2026-07-07T00:04:30.000Z"));
      const [republished] = await eventStore.appendToStream({
        streamId: "marketplace.listing-lst_reported",
        expectedVersion: 3,
        events: [listingPublished],
        context,
      });
      const fifth = await report(5);
      const removals = allEvents.filter((event) => event.eventType === "marketplace.listing.auto-unlisted");
      expect(removals).toHaveLength(2);
      expect(removals[1]!.payload).toMatchObject({
        reportId: fifth.reportId,
        listingEnforcement: { sourceActionId: fifth.reportId },
        autoUnlistedAt: "2026-07-07T00:05:00.000Z",
      });
      expect(Date.parse(String(removals[1]!.payload.autoUnlistedAt))).toBeGreaterThanOrEqual(
        Date.parse(republished!.occurredAt),
      );
      expect(fifth).toMatchObject({ reportCount: 5, autoUnlisted: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("clamps a retried crossing to the activation that made the listing active", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { eventStore, allEvents } = createInMemoryEventStore();
      const at = (minute: number) => new Date(`2026-07-07T00:0${minute}:00.000Z`);
      vi.setSystemTime(at(0));
      await seedActiveListing(eventStore);
      const interrupted: EventStore = {
        ...eventStore,
        appendToStream: (input) => {
          if (input.events.some(({ eventType }) => eventType === "marketplace.listing.auto-unlisted")) {
            throw new Error("Effect interrupted");
          }
          return eventStore.appendToStream(input);
        },
      };
      const report = (index: number, store = eventStore) =>
        reportListingAsVisitor(
          createMarketplaceReportRuntime({ eventStore: store, db: createReviewModerationTargetDbStub({}) }),
          index,
        );
      vi.setSystemTime(at(1));
      await report(1);
      await report(2);
      await expect(report(3, interrupted)).rejects.toThrow("Effect interrupted");
      const crossing = allEvents.filter(({ eventType }) => eventType === "marketplace.report.submitted").at(-1)!;
      const streamId = "marketplace.listing-lst_reported";
      vi.setSystemTime(at(2));
      await eventStore.appendToStream({
        streamId,
        expectedVersion: 2,
        events: [{ eventType: "marketplace.listing.paused", payload: { reason: "seller" } }],
        context,
      });
      vi.setSystemTime(at(3));
      const [activation] = await eventStore.appendToStream({
        streamId,
        expectedVersion: 3,
        events: [listingPublished],
        context,
      });
      vi.setSystemTime(at(4));
      const retry = await report(3);
      expect(retry).toMatchObject({ reportId: crossing.payload.reportId, autoUnlisted: true });
      expect(allEvents.filter(({ eventType }) => eventType === "marketplace.listing.auto-unlisted")).toMatchObject([
        {
          payload: {
            reportId: crossing.payload.reportId,
            listingEnforcement: { sourceActionId: crossing.payload.reportId, occurredAt: activation!.occurredAt },
            autoUnlistedAt: activation!.occurredAt,
          },
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("Listing Report Auto-Unlist Policy", () => {
    const reportedAt = new Date("2026-07-08T12:00:00.000Z");

    async function activeListingAt(time: Date) {
      vi.setSystemTime(time);
      const store = createInMemoryEventStore();
      await seedActiveListing(store.eventStore);
      return store;
    }

    it.each([
      { age: "exactly 7 days", beyondWindowMs: 0, counted: true },
      { age: "one millisecond more than 7 days", beyondWindowMs: 1, counted: false },
    ])(
      "with no policy document, counts a Report submitted $age before the evaluated Report: $counted",
      async ({ beyondWindowMs, counted }) => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const { eventStore, allEvents } = await activeListingAt(reportedAt);
          await seedEarlierListingReport(eventStore, 7 * MILLISECONDS_PER_DAY + beyondWindowMs);
          const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });

          expect(await reportListingAsVisitor(reports, 1)).toMatchObject({
            reportCount: counted ? 2 : 1,
            threshold: 3,
            autoUnlisted: false,
          });
          const second = await reportListingAsVisitor(reports, 2);
          expect(second).toMatchObject({ reportCount: counted ? 3 : 2, threshold: 3, autoUnlisted: counted });
          if (!counted) {
            expect(autoUnlistedEvents(allEvents)).toEqual([]);
            expect(await reportListingAsVisitor(reports, 3)).toMatchObject({
              reportCount: 3,
              threshold: 3,
              autoUnlisted: true,
            });
          }
          expect(autoUnlistedEvents(allEvents)).toMatchObject([{ payload: { reportCount: 3, threshold: 3 } }]);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it("unlists at the second distinct reporter inside one day when the active document says 2 reporters in 1 day", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { eventStore, allEvents } = await activeListingAt(reportedAt);
        // Inside the default 7 days, outside this document's 1 day.
        await seedEarlierListingReport(eventStore, MILLISECONDS_PER_DAY + 1);
        const { policies, resolutions } = createListingReportPolicies({ distinctReporterThreshold: 2, windowDays: 1 });
        const reports = createMarketplaceReportRuntime({
          eventStore,
          db: createReviewModerationTargetDbStub({}),
          policies,
        });

        expect(await reportListingAsVisitor(reports, 1)).toMatchObject({
          reportCount: 1,
          threshold: 2,
          autoUnlisted: false,
        });
        expect(autoUnlistedEvents(allEvents)).toEqual([]);
        vi.setSystemTime(new Date(reportedAt.getTime() + 60_000));
        const second = await reportListingAsVisitor(reports, 2);

        expect(second).toMatchObject({ reportCount: 2, threshold: 2, autoUnlisted: true });
        expect(autoUnlistedEvents(allEvents)).toMatchObject([
          { payload: { reportId: second.reportId, reportCount: 2, threshold: 2 } },
        ]);
        // One resolution per evaluation, at the current time, decides both numbers.
        expect(resolutions).toEqual([currentTimeResolution, currentTimeResolution]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("counts a Report submitted exactly one day earlier under a 1-day document", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const { eventStore, allEvents } = await activeListingAt(reportedAt);
        await seedEarlierListingReport(eventStore, MILLISECONDS_PER_DAY);
        const { policies } = createListingReportPolicies({ distinctReporterThreshold: 2, windowDays: 1 });
        const reports = createMarketplaceReportRuntime({
          eventStore,
          db: createReviewModerationTargetDbStub({}),
          policies,
        });

        const first = await reportListingAsVisitor(reports, 1);

        expect(first).toMatchObject({ reportCount: 2, threshold: 2, autoUnlisted: true });
        expect(autoUnlistedEvents(allEvents)).toMatchObject([
          { payload: { reportId: first.reportId, reportCount: 2, threshold: 2 } },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("evaluates the retry of a stored Report under the terms revised since it was stored", async () => {
      const { eventStore, allEvents } = createInMemoryEventStore();
      await seedActiveListing(eventStore);
      const { policies, resolutions, revise } = createListingReportPolicies({
        distinctReporterThreshold: 3,
        windowDays: 7,
      });
      const db = createReviewModerationTargetDbStub({});
      const reports = createMarketplaceReportRuntime({ eventStore, db, policies });
      const interruptedBeforeCompletion = createMarketplaceReportRuntime({
        eventStore: {
          ...eventStore,
          appendToStreams: () => {
            throw new Error("Effect interrupted");
          },
        },
        db,
        policies,
      });

      await reportListingAsVisitor(reports, 1);
      await expect(reportListingAsVisitor(interruptedBeforeCompletion, 2)).rejects.toThrow("Effect interrupted");
      const stored = allEvents.filter(({ eventType }) => eventType === "marketplace.report.submitted");
      expect(stored).toHaveLength(2);
      expect(autoUnlistedEvents(allEvents)).toEqual([]);

      revise({ distinctReporterThreshold: 2, windowDays: 7 });
      const retry = await reportListingAsVisitor(reports, 2);

      expect(retry).toMatchObject({
        reportId: stored[1]!.payload.reportId,
        reportCount: 2,
        threshold: 2,
        autoUnlisted: true,
      });
      expect(allEvents.filter(({ eventType }) => eventType === "marketplace.report.submitted")).toHaveLength(2);
      expect(autoUnlistedEvents(allEvents)).toMatchObject([
        { payload: { reportId: retry.reportId, reportCount: 2, threshold: retry.threshold } },
      ]);
      // The first Report, the interrupted evaluation and its retry each resolved once.
      expect(resolutions).toEqual([currentTimeResolution, currentTimeResolution, currentTimeResolution]);
    });

    it("fails the attempt on a rejected resolution, keeps the Report and unlists nothing until the retry", async () => {
      const { eventStore, allEvents } = createInMemoryEventStore();
      await seedActiveListing(eventStore);
      const { policies, resolutions, revise, failWith } = createListingReportPolicies({
        distinctReporterThreshold: 3,
        windowDays: 7,
      });
      const reports = createMarketplaceReportRuntime({
        eventStore,
        db: createReviewModerationTargetDbStub({}),
        policies,
      });
      await reportListingAsVisitor(reports, 1);
      await reportListingAsVisitor(reports, 2);

      failWith(new Error("platform policy documents are unavailable"));
      await expect(reportListingAsVisitor(reports, 3)).rejects.toThrow("platform policy documents are unavailable");

      const stored = allEvents.filter(({ eventType }) => eventType === "marketplace.report.submitted");
      expect(stored).toHaveLength(3);
      expect(autoUnlistedEvents(allEvents)).toEqual([]);
      expect(allEvents.filter(({ eventType }) => eventType === "marketplace.mutation-attempt.completed")).toHaveLength(
        2,
      );
      expect(allEvents.at(-1)).toBe(stored[2]);

      revise({ distinctReporterThreshold: 3, windowDays: 7 });
      const retry = await reportListingAsVisitor(reports, 3);

      expect(retry).toMatchObject({
        reportId: stored[2]!.payload.reportId,
        reportCount: 3,
        threshold: 3,
        autoUnlisted: true,
      });
      expect(allEvents.filter(({ eventType }) => eventType === "marketplace.report.submitted")).toHaveLength(3);
      expect(autoUnlistedEvents(allEvents)).toMatchObject([{ payload: { reportId: retry.reportId, threshold: 3 } }]);
      expect(resolutions).toHaveLength(4);
    });
  });

  it("replays the first report and rejects duplicate reports using a different attempt", async () => {
    const { eventStore } = createInMemoryEventStore();
    await seedActiveListing(eventStore);
    const reports = createMarketplaceReportRuntime({ eventStore, db: createReviewModerationTargetDbStub({}) });
    const input = {
      attemptId: "duplicate_report_attempt_0001",
      listingId: "lst_reported",
      reporterKind: "visitor" as const,
      reporterKey: "anon_dup",
      reporterAccountId: null,
      reporterUserId: null,
      reason: "other" as const,
      details: null,
      sourceRoutePath: "/listings/reported-listing",
    };

    const first = await reports.reportListing(input, context);
    expect(await reports.reportListing(input, context)).toEqual(first);
    await expect(
      reports.reportListing({ ...input, attemptId: "different_report_attempt_0001" }, context),
    ).rejects.toThrow("This reporter has already reported this content.");
    await expect(reports.reportListing({ ...input, details: "Changed" }, context)).rejects.toMatchObject({
      code: "attempt_conflict",
    });
  });
});

// Hoisted by Vitest; observes how many listing enforcement identities the dispatcher mints.
vi.mock("@chase-sets/primitives/typed-ids", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@chase-sets/primitives/typed-ids")>();
  return { ...actual, createId: vi.fn(actual.createId) };
});

// Hoisted by Vitest; lets a test hand the composed Marketplace services an in-memory event store.
const composition = vi.hoisted(() => ({ eventStore: undefined as EventStore | undefined }));
vi.mock("@chase-sets/event-core-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/event-core-postgres")>()),
  createPostgresEventStore: () => composition.eventStore,
}));

describe("Marketplace services", () => {
  it("decide a Listing Report with the Listing Report Auto-Unlist Policy read from the Marketplace database", async () => {
    const { eventStore, allEvents } = createInMemoryEventStore();
    composition.eventStore = eventStore;
    await seedActiveListing(eventStore);
    await seedEarlierListingReport(eventStore, 60_000);
    const policyKey = "marketplace.listing-report-auto-unlist";
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

    const result = await reportListingAsVisitor(reports, 1);

    expect(result).toMatchObject({ reportCount: 2, threshold: 2, autoUnlisted: true });
    expect(autoUnlistedEvents(allEvents)).toMatchObject([
      { payload: { reportId: result.reportId, reportCount: 2, threshold: 2 } },
    ]);
    expect(
      query.mock.calls.filter(
        ([sql, values]) => sql.includes("FROM platform_policy_documents") && values?.includes(policyKey),
      ),
    ).toHaveLength(1);
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
        attemptId: "review_report_attempt_0001",
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
    expect(allEvents.map((event) => event.eventType)).toEqual([
      "marketplace.report.submitted",
      "marketplace.mutation-attempt.completed",
    ]);
    expect(getMutationResultCommandReceipt(result)?.commitEventIds).toEqual([allEvents[1]!.eventId]);
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
          attemptId: "missing_report_attempt_0001",
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
          attemptId: "hidden_report_attempt_0001",
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
          attemptId: "held_report_attempt_0001",
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
