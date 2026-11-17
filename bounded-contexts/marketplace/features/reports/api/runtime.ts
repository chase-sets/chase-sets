import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import {
  EVENT_STORE_READ_PAGE_SIZE_MAX,
  ZERO_GLOBAL_POSITION,
  type EventStoreContext,
  type StoredEvent,
} from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId, type AccountId } from "@chase-sets/primitives/typed-ids";
import {
  decideMarketplaceListing,
  evolveMarketplaceListing,
  initialMarketplaceListingState,
  type MarketplaceListingEvent,
} from "../../listings/domain/domain";
import { getReviewModerationTarget } from "../../reviews/read-model/queries";
import {
  createMarketplaceAttempt,
  MarketplaceAttemptError,
  hashMarketplaceRequest,
} from "../../mutation-recovery/api/attempt";
import { readMarketplaceRecoveryHistory } from "../../mutation-recovery/domain/history";
import {
  canonicalMarketplaceRequest,
  marketplaceCanonicalRequest,
  type MarketplaceMutationRecoveryResult,
} from "../../mutation-recovery/domain/contracts";
import {
  decideMarketplaceReport,
  evolveMarketplaceReport,
  initialMarketplaceReportState,
  type MarketplaceReportCommand,
  type MarketplaceReportEvent,
  type MarketplaceReportState,
  type MarketplaceListingReportReason,
  type MarketplaceReviewReportReason,
  type MarketplaceReporterKind,
} from "../domain/domain";
import {
  listingReportAttemptResultSchema,
  reviewReportAttemptResultSchema,
  reportAttemptFactSchema,
} from "./attempt-result";
import { marketplaceReporterFingerprint } from "./reporter";

export const LISTING_REPORT_AUTO_UNLIST_THRESHOLD = 3;
export const LISTING_REPORT_AUTO_UNLIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const ALREADY_REPORTED = "This reporter has already reported this content.";

type ListingReportInput = Readonly<{
  attemptId: string;
  listingId: string;
  reporterKind: MarketplaceReporterKind;
  reporterKey: string;
  reporterAccountId: string | null;
  reporterUserId: string | null;
  reason: MarketplaceListingReportReason;
  details?: string | null;
  sourceRoutePath: string;
}>;
type ReviewReportInput = Readonly<{
  attemptId: string;
  reviewId: string;
  reporterAccountId: string;
  reporterUserId: string | null;
  reason: MarketplaceReviewReportReason;
  details?: string | null;
  sourceRoutePath: string;
}>;
type ReportResult = { reportId: string; version: number };
type ListingReportResult = ReportResult & { reportCount: number; threshold: number; autoUnlisted: boolean };
export type MarketplaceReportServices = Readonly<{
  commandHandler: CommandHandler<MarketplaceReportCommand, MarketplaceReportState, MarketplaceReportEvent>;
  reportListing: (params: ListingReportInput, context: EventStoreContext) => Promise<ListingReportResult>;
  reportReview: (params: ReviewReportInput, context: EventStoreContext) => Promise<ReportResult>;
}>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stableReportStreamId(targetType: "listing" | "review", targetId: string, reporterKey: string) {
  return `marketplace.report-${targetType}-${targetId}-${reporterKey}`.replace(/[^A-Za-z0-9_.:-]/g, "-");
}

export function createMarketplaceReportRuntime(
  deps: Readonly<{ eventStore: EventStore; db: PgQueryable }>,
): MarketplaceReportServices {
  const reportCodec = createPassthroughDomainEventCodec<MarketplaceReportEvent>();
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: reportCodec,
    initialState: () => initialMarketplaceReportState,
    evolve: evolveMarketplaceReport,
    decide: decideMarketplaceReport,
  });
  const listingRuntime = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<MarketplaceListingEvent>(),
    initialState: () => initialMarketplaceListingState,
    evolve: evolveMarketplaceListing,
    decide: decideMarketplaceListing,
  });

  async function readReport(streamId: string, binding: MarketplaceMutationRecoveryResult, reporterKey: string) {
    const history = await readMarketplaceRecoveryHistory<StoredEvent | null>(
      deps.eventStore,
      streamId,
      null,
      (state, event) => {
        if (state || event.eventType !== "marketplace.report.submitted") throw new Error("Invalid report history.");
        const fact = reportAttemptFactSchema.parse(event.payload);
        const actor = fact.reporterKind === "account" ? fact.reporterAccountId : fact.reporterKey;
        if (
          actor !== fact.recovery.actorBinding.accountId ||
          actor !== binding.actorBinding.accountId ||
          event.forAccountId !== actor ||
          fact.reporterKey !== reporterKey ||
          fact.targetId !== fact.recovery.target.id ||
          fact.targetId !== binding.target.id ||
          fact.recovery.target.kind !== binding.target.kind ||
          fact.recovery.mutationKind !== `${fact.targetType}.report` ||
          fact.recovery.mutationKind !== binding.mutationKind ||
          fact.recovery.canonicalRequestHash !==
            hashMarketplaceRequest(marketplaceCanonicalRequest(fact.recovery.mutationKind, fact))
        )
          throw new Error("Invalid report binding.");
        return event;
      },
    );
    if (!history.complete)
      throw new MarketplaceAttemptError("history_incomplete", "Report history could not be confirmed.");
    if (history.state) {
      const fact = reportAttemptFactSchema.parse(history.state.payload);
      assert(fact.recovery.attemptKeyFingerprint === binding.attemptKeyFingerprint, ALREADY_REPORTED);
      if (canonicalMarketplaceRequest(fact.recovery) !== canonicalMarketplaceRequest(binding))
        throw new MarketplaceAttemptError(
          "attempt_conflict",
          "This reporter already used this report attempt with a different payload.",
        );
    }
    return history.state;
  }

  async function submitReport(
    command: MarketplaceReportCommand,
    binding: MarketplaceMutationRecoveryResult,
    context: EventStoreContext,
    legacyReporterKey: string,
  ) {
    const streamId = stableReportStreamId(command.targetType, command.targetId, command.reporterKey);
    const prior = await readReport(streamId, binding, command.reporterKey);
    if (prior) return prior;
    // @stream-read-contract bounded-contexts/marketplace/features/reports/api/runtime.test.ts
    const legacy = await deps.eventStore.readStream({
      streamId: stableReportStreamId(
        command.targetType,
        command.targetId,
        `${command.reporterKind}:${legacyReporterKey.trim()}`,
      ),
      limit: 1,
    });
    assert(legacy.length === 0, ALREADY_REPORTED);
    try {
      const events = decideMarketplaceReport(initialMarketplaceReportState, { ...command, recovery: binding });
      const result = await deps.eventStore.appendToStream({
        streamId,
        expectedVersion: "no_stream",
        events: events.map(reportCodec.encode),
        context,
      });
      const stored = result[0];
      assert(stored, "Report append returned no event.");
      return stored;
    } catch (error) {
      if ((error as { code?: string }).code !== "concurrency_conflict") throw error;
      const first = await readReport(streamId, binding, command.reporterKey);
      assert(first, "Concurrent report could not be confirmed.");
      return first;
    }
  }

  async function repairListingThreshold(
    listingId: string,
    reportId: string,
    countedAt: string,
    context: EventStoreContext,
  ) {
    const events: StoredEvent[] = [];
    let afterGlobalPosition = ZERO_GLOBAL_POSITION;
    for (;;) {
      const page = await deps.eventStore.readAll({
        afterGlobalPosition,
        eventTypes: ["marketplace.report.submitted"],
        limit: EVENT_STORE_READ_PAGE_SIZE_MAX,
      });
      events.push(...page);
      if (page.length < EVENT_STORE_READ_PAGE_SIZE_MAX) break;
      afterGlobalPosition = page.at(-1)!.globalPosition;
    }
    const reporterKeys = new Set<string>();
    const windowStartsAt = Date.parse(countedAt) - LISTING_REPORT_AUTO_UNLIST_WINDOW_MS;
    const eligibleReports: { reportId: string; submittedAt: string }[] = [];
    for (const event of events) {
      if (event.eventType !== "marketplace.report.submitted") continue;
      const payload = event.payload as Record<string, unknown>;
      if (
        payload.targetType !== "listing" ||
        payload.targetId !== listingId ||
        typeof payload.submittedAt !== "string" ||
        !Number.isFinite(Date.parse(payload.submittedAt)) ||
        Date.parse(payload.submittedAt) < windowStartsAt
      )
        continue;
      if (typeof payload.reporterKey !== "string" || typeof payload.reportId !== "string")
        throw new MarketplaceAttemptError("history_incomplete", "Report threshold history is invalid.");
      const key = payload.recovery
        ? payload.reporterKey
        : marketplaceReporterFingerprint(
            payload.reporterKind as MarketplaceReporterKind,
            payload.reporterKey.replace(/^(account|visitor):/, ""),
          );
      reporterKeys.add(key);
      if (reporterKeys.size >= LISTING_REPORT_AUTO_UNLIST_THRESHOLD)
        eligibleReports.push({ reportId: payload.reportId, submittedAt: payload.submittedAt });
    }
    let autoUnlisted = false;
    if (eligibleReports.length > 0) {
      const streamId = `marketplace.listing-${listingId}`;
      for (let retry = 0; retry < 3; retry++) {
        const current = await listingRuntime.repository.load(streamId);
        const appliedSources = new Set(
          current.state.appliedListingEnforcements.map(({ sourceActionId }) => sourceActionId),
        );
        autoUnlisted = appliedSources.has(reportId);
        if (current.state.status !== "active") break;
        const source = eligibleReports.find((candidate) => !appliedSources.has(candidate.reportId));
        if (!source) break;
        try {
          const removal = await listingRuntime.commandHandler({
            streamId,
            expectedVersion: current.version,
            command: {
              type: "AutoUnlistListing",
              reportId: source.reportId,
              reportCount: reporterKeys.size,
              threshold: LISTING_REPORT_AUTO_UNLIST_THRESHOLD,
              autoUnlistedAt: source.submittedAt,
              listingEnforcementActionId: createId("lea"),
            },
            context,
          });
          autoUnlisted = removal.state.appliedListingEnforcements.some(
            ({ sourceActionId }) => sourceActionId === reportId,
          );
          if (removal.state.status !== "active") break;
        } catch (error) {
          if ((error as { code?: string }).code !== "concurrency_conflict" || retry === 2) throw error;
        }
      }
    }
    return {
      reportCount: reporterKeys.size,
      threshold: LISTING_REPORT_AUTO_UNLIST_THRESHOLD,
      autoUnlisted,
    };
  }

  return {
    commandHandler,
    async reportListing(params, suppliedContext) {
      const reporterKey = marketplaceReporterFingerprint(params.reporterKind, params.reporterKey);
      const accountId = params.reporterKind === "account" ? params.reporterAccountId : reporterKey;
      assert(accountId, "Reporter is required.");
      if (params.reporterKind === "account") {
        assert(
          params.reporterKey === accountId && suppliedContext.audit.forAccountId === accountId,
          "Report actor account mismatch.",
        );
      } else
        assert(
          params.reporterAccountId === null && params.reporterUserId === null,
          "Visitor reports cannot carry account authority.",
        );
      const context: EventStoreContext = {
        ...suppliedContext,
        audit: { ...suppliedContext.audit, forAccountId: accountId as AccountId },
      };
      const attempt = createMarketplaceAttempt(
        deps.eventStore,
        {
          attemptId: params.attemptId,
          mutationKind: "listing.report",
          accountId,
          target: { kind: "listing", id: params.listingId },
          request: { targetId: params.listingId, reason: params.reason, details: params.details ?? null },
        },
        listingReportAttemptResultSchema,
      );
      const first = await attempt.read();
      if (first) return first;
      const listing = (await listingRuntime.repository.load(`marketplace.listing-${params.listingId}`)).state;
      assert(listing.listingId !== null, "Listing not found.");
      assert(
        !params.reporterAccountId || listing.accountId !== params.reporterAccountId,
        "Sellers cannot report their own listing.",
      );
      const report = await submitReport(
        {
          type: "SubmitMarketplaceReport",
          reportId: createId("rpt"),
          targetType: "listing",
          targetId: params.listingId,
          targetOwnerAccountId: listing.accountId,
          reporterKind: params.reporterKind,
          reporterKey,
          reporterAccountId: params.reporterAccountId,
          reporterUserId: params.reporterUserId,
          reason: params.reason,
          details: params.details ?? null,
          sourceRoutePath: params.sourceRoutePath,
          submittedAt: new Date().toISOString(),
        },
        attempt.binding,
        context,
        params.reporterKey,
      );
      const threshold = await repairListingThreshold(
        params.listingId,
        (report.payload as { reportId: string }).reportId,
        (report.payload as { submittedAt: string }).submittedAt,
        context,
      );
      const result = {
        reportId: (report.payload as { reportId: string }).reportId,
        version: report.streamVersion,
        ...threshold,
      };
      return attempt.commit([], result, { id: result.reportId, version: result.version }, context);
    },
    async reportReview(params, context) {
      assert(context.audit.forAccountId === params.reporterAccountId, "Report actor account mismatch.");
      const reporterKey = marketplaceReporterFingerprint("account", params.reporterAccountId);
      const attempt = createMarketplaceAttempt(
        deps.eventStore,
        {
          attemptId: params.attemptId,
          mutationKind: "review.report",
          accountId: params.reporterAccountId,
          target: { kind: "review", id: params.reviewId },
          request: { targetId: params.reviewId, reason: params.reason, details: params.details ?? null },
        },
        reviewReportAttemptResultSchema,
      );
      const first = await attempt.read();
      if (first) return first;
      const streamId = stableReportStreamId("review", params.reviewId, reporterKey);
      let report = await readReport(streamId, attempt.binding, reporterKey);
      if (!report) {
        const review = await getReviewModerationTarget(deps.db, params.reviewId);
        assert(review !== null, "Review not found.");
        assert(review.status === "active", "This review is no longer active.");
        assert(review.revealed_at !== null, "This review has not been revealed yet.");
        assert(!review.held, "This review is not publicly available.");
        report = await submitReport(
          {
            type: "SubmitMarketplaceReport",
            reportId: createId("rpt"),
            targetType: "review",
            targetId: params.reviewId,
            targetOwnerAccountId: review.subject_account_id,
            reporterKind: "account",
            reporterKey,
            reporterAccountId: params.reporterAccountId,
            reporterUserId: params.reporterUserId,
            reason: params.reason,
            details: params.details ?? null,
            sourceRoutePath: params.sourceRoutePath,
            submittedAt: new Date().toISOString(),
          },
          attempt.binding,
          context,
          params.reporterAccountId,
        );
      }
      const result = { reportId: (report.payload as { reportId: string }).reportId, version: report.streamVersion };
      return attempt.commit([], result, { id: result.reportId, version: result.version }, context);
    },
  };
}
