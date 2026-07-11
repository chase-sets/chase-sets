import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingCommand,
  type MarketplaceListingEvent,
  type MarketplaceListingState,
} from "../../listings/domain/domain";
import { getReviewModerationTarget } from "../../reviews/read-model/queries";
import {
  decideMarketplaceReport,
  evolveMarketplaceReport,
  initialMarketplaceReportState,
  marketplaceReportReasons,
  type MarketplaceReportCommand,
  type MarketplaceReportEvent,
  type MarketplaceReportReason,
  type MarketplaceReportState,
  type MarketplaceReporterKind,
} from "../domain/domain";

export const LISTING_REPORT_AUTO_UNLIST_THRESHOLD = 3;
export const LISTING_REPORT_AUTO_UNLIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

type MarketplaceReportRuntimeDeps = Readonly<{
  eventStore: EventStore;
  db: PgQueryable;
}>;

export type MarketplaceReportServices = Readonly<{
  commandHandler: CommandHandler<MarketplaceReportCommand, MarketplaceReportState, MarketplaceReportEvent>;
  reportListing: (
    params: Readonly<{
      listingId: string;
      reporterKind: MarketplaceReporterKind;
      reporterKey: string;
      reporterAccountId: string | null;
      reporterUserId: string | null;
      reason: MarketplaceReportReason;
      details?: string | null;
      sourceRoutePath: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{
    reportId: string;
    version: number;
    reportCount: number;
    threshold: number;
    autoUnlisted: boolean;
  }>;
  /**
   * Report a review (m108): authenticated only (visitors cannot
   * report reviews -- reviews already require a verified transaction, so
   * anonymous reporting is not needed), and only on a revealed review --
   * pre-reveal review text is not public yet, so there is nothing to report.
   * Feeds the same reported-content queue as `reportListing` (built once for
   * both listing and review targets); reviews have no auto-unlist
   * equivalent, so this never triggers an automatic domain action.
   */
  reportReview: (
    params: Readonly<{
      reviewId: string;
      reporterAccountId: string;
      reporterUserId: string | null;
      reason: MarketplaceReportReason;
      details?: string | null;
      sourceRoutePath: string;
    }>,
    context: EventStoreContext,
  ) => Promise<{ reportId: string; version: number }>;
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function stableReporterKey(kind: MarketplaceReporterKind, value: string) {
  return `${kind}:${value.trim()}`;
}

function stableReportStreamId(targetType: "listing" | "review", targetId: string, reporterKey: string) {
  return `marketplace.report-${targetType}-${targetId}-${reporterKey}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
}

function normalizeReason(value: MarketplaceReportReason) {
  assert(marketplaceReportReasons.includes(value), "Report reason is invalid.");
  return value;
}

function isReportForTarget(
  event: Awaited<ReturnType<EventStore["readAll"]>>[number],
  targetType: string,
  targetId: string,
) {
  const payload = event.payload as Record<string, unknown>;
  return (
    event.eventType === "marketplace.report.submitted" &&
    payload.targetType === targetType &&
    payload.targetId === targetId
  );
}

export function createMarketplaceReportRuntime(deps: MarketplaceReportRuntimeDeps): MarketplaceReportServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceReportEvent>(),
    initialState: () => initialMarketplaceReportState,
    evolve: evolveMarketplaceReport,
    decide: decideMarketplaceReport,
  });
  const { commandHandler: listingCommandHandler, repository: listingRepository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });

  async function countTargetReports(targetType: "listing" | "review", targetId: string, countedAt: string) {
    const events = await deps.eventStore.readAll();
    const reporterKeys = new Set<string>();
    const windowStartsAt = new Date(new Date(countedAt).getTime() - LISTING_REPORT_AUTO_UNLIST_WINDOW_MS).getTime();
    for (const event of events) {
      if (!isReportForTarget(event, targetType, targetId)) {
        continue;
      }
      const payload = event.payload as Record<string, unknown>;
      const submittedAt = typeof payload.submittedAt === "string" ? Date.parse(payload.submittedAt) : Number.NaN;
      if (Number.isNaN(submittedAt) || submittedAt < windowStartsAt) {
        continue;
      }
      const reporterKey = payload.reporterKey;
      if (typeof reporterKey === "string" && reporterKey.trim()) {
        reporterKeys.add(reporterKey);
      }
    }

    return reporterKeys.size;
  }

  return {
    commandHandler,
    async reportListing(params, context) {
      const listingAggregate = await listingRepository.load(`marketplace.listing-${params.listingId}`);
      const listing = listingAggregate.state;
      assert(listing.listingId !== null, "Listing not found.");
      if (params.reporterAccountId) {
        assert(listing.accountId !== params.reporterAccountId, "Sellers cannot report their own listing.");
      }

      const reportId = createId("rpt");
      const reporterKey = stableReporterKey(params.reporterKind, params.reporterKey);
      const submittedAt = new Date().toISOString();
      const result = await commandHandler({
        streamId: stableReportStreamId("listing", params.listingId, reporterKey),
        command: {
          type: "SubmitMarketplaceReport",
          reportId,
          targetType: "listing",
          targetId: params.listingId,
          targetOwnerAccountId: listing.accountId,
          reporterKind: params.reporterKind,
          reporterKey,
          reporterAccountId: params.reporterAccountId,
          reporterUserId: params.reporterUserId,
          reason: normalizeReason(params.reason),
          details: params.details ?? null,
          sourceRoutePath: params.sourceRoutePath,
          submittedAt,
        },
        context,
      });

      const reportCount = await countTargetReports("listing", params.listingId, submittedAt);
      const shouldAutoUnlist = listing.status === "active" && reportCount >= LISTING_REPORT_AUTO_UNLIST_THRESHOLD;
      if (shouldAutoUnlist) {
        await listingCommandHandler({
          streamId: `marketplace.listing-${params.listingId}`,
          command: {
            type: "AutoUnlistListing",
            reportId,
            reportCount,
            threshold: LISTING_REPORT_AUTO_UNLIST_THRESHOLD,
            autoUnlistedAt: new Date().toISOString(),
          } satisfies MarketplaceListingCommand,
          context,
        });
      }

      return {
        reportId,
        version: result.version,
        reportCount,
        threshold: LISTING_REPORT_AUTO_UNLIST_THRESHOLD,
        autoUnlisted: shouldAutoUnlist,
      };
    },
    async reportReview(params, context) {
      const review = await getReviewModerationTarget(deps.db, params.reviewId);
      assert(review !== null, "Review not found.");
      assert(review.status === "active", "This review is no longer active.");
      assert(review.revealed_at !== null, "This review has not been revealed yet.");

      const reportId = createId("rpt");
      const reporterKey = stableReporterKey("account", params.reporterAccountId);
      const submittedAt = new Date().toISOString();
      const result = await commandHandler({
        streamId: stableReportStreamId("review", params.reviewId, reporterKey),
        command: {
          type: "SubmitMarketplaceReport",
          reportId,
          targetType: "review",
          targetId: params.reviewId,
          targetOwnerAccountId: review.subject_account_id,
          reporterKind: "account",
          reporterKey,
          reporterAccountId: params.reporterAccountId,
          reporterUserId: params.reporterUserId,
          reason: normalizeReason(params.reason),
          details: params.details ?? null,
          sourceRoutePath: params.sourceRoutePath,
          submittedAt,
        },
        context,
      });

      return { reportId, version: result.version };
    },
  };
}
