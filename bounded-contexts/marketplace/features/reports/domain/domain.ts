import type { AggregateDecider, AggregateEvolver, DomainEvent } from "@chase-sets/event-core";

export const marketplaceListingReportReasons = [
  "counterfeit-concern",
  "stolen-photos",
  "prohibited-item",
  "pricing-scam",
  "other",
] as const;

export const marketplaceReviewReportReasons = [
  "harassment-or-abuse",
  "hate-or-discrimination",
  "personal-information",
  "spam-or-manipulation",
  "other",
] as const;

export const marketplaceReportReasons = [
  ...new Set([...marketplaceListingReportReasons, ...marketplaceReviewReportReasons]),
];

export type MarketplaceListingReportReason = (typeof marketplaceListingReportReasons)[number];
export type MarketplaceReviewReportReason = (typeof marketplaceReviewReportReasons)[number];
export type MarketplaceReportReason = MarketplaceListingReportReason | MarketplaceReviewReportReason;
export type MarketplaceReportedEntityType = "listing" | "review";
export type MarketplaceReporterKind = "account" | "visitor";

export type MarketplaceReportState = Readonly<{
  reportId: string | null;
  targetType: MarketplaceReportedEntityType | null;
  targetId: string | null;
  reporterKey: string | null;
  status: "submitted" | null;
}>;

export const initialMarketplaceReportState: MarketplaceReportState = {
  reportId: null,
  targetType: null,
  targetId: null,
  reporterKey: null,
  status: null,
};

export type SubmitMarketplaceReportCommand = Readonly<{
  type: "SubmitMarketplaceReport";
  reportId: string;
  targetType: MarketplaceReportedEntityType;
  targetId: string;
  targetOwnerAccountId: string | null;
  reporterKind: MarketplaceReporterKind;
  reporterKey: string;
  reporterAccountId: string | null;
  reporterUserId: string | null;
  reason: MarketplaceReportReason;
  details: string | null;
  sourceRoutePath: string;
  submittedAt: string;
}>;

export type MarketplaceReportCommand = SubmitMarketplaceReportCommand;

export type MarketplaceReportSubmittedEvent = DomainEvent<
  "marketplace.report.submitted",
  Readonly<{
    reportId: string;
    targetType: MarketplaceReportedEntityType;
    targetId: string;
    targetOwnerAccountId: string | null;
    reporterKind: MarketplaceReporterKind;
    reporterKey: string;
    reporterAccountId: string | null;
    reporterUserId: string | null;
    reason: MarketplaceReportReason;
    details: string | null;
    sourceRoutePath: string;
    submittedAt: string;
  }>
>;

export type MarketplaceReportEvent = MarketplaceReportSubmittedEvent;

export const decideMarketplaceReport: AggregateDecider<
  MarketplaceReportState,
  MarketplaceReportCommand,
  MarketplaceReportEvent
> = (state, command) => {
  switch (command.type) {
    case "SubmitMarketplaceReport":
      assert(state.reportId === null, "This reporter has already reported this content.");
      return [
        {
          type: "marketplace.report.submitted",
          data: {
            reportId: normalizeRequiredText(command.reportId, "Report id is required."),
            targetType: normalizeTargetType(command.targetType),
            targetId: normalizeRequiredText(command.targetId, "Reported content id is required."),
            targetOwnerAccountId: normalizeOptionalText(command.targetOwnerAccountId),
            reporterKind: normalizeReporterKind(command.reporterKind),
            reporterKey: normalizeRequiredText(command.reporterKey, "Reporter is required."),
            reporterAccountId: normalizeOptionalText(command.reporterAccountId),
            reporterUserId: normalizeOptionalText(command.reporterUserId),
            reason: normalizeReportReason(command.targetType, command.reason),
            details: normalizeDetails(command.details),
            sourceRoutePath: normalizeRequiredText(command.sourceRoutePath, "Source route path is required."),
            submittedAt: normalizeRequiredText(command.submittedAt, "Submission timestamp is required."),
          },
        },
      ];
  }
};

export const evolveMarketplaceReport: AggregateEvolver<MarketplaceReportState, MarketplaceReportEvent> = (
  state,
  event,
) => {
  switch (event.type) {
    case "marketplace.report.submitted":
      return {
        ...state,
        reportId: event.data.reportId,
        targetType: event.data.targetType,
        targetId: event.data.targetId,
        reporterKey: event.data.reporterKey,
        status: "submitted",
      };
  }
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeRequiredText(value: string, message: string): string {
  const normalized = value.trim();
  assert(normalized.length > 0, message);
  return normalized;
}

function normalizeOptionalText(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeTargetType(value: MarketplaceReportedEntityType): MarketplaceReportedEntityType {
  assert(value === "listing" || value === "review", "Reported content type is invalid.");
  return value;
}

function normalizeReporterKind(value: MarketplaceReporterKind): MarketplaceReporterKind {
  assert(value === "account" || value === "visitor", "Reporter type is invalid.");
  return value;
}

function normalizeReportReason(
  targetType: MarketplaceReportedEntityType,
  value: MarketplaceReportReason,
): MarketplaceReportReason {
  const allowedReasons = targetType === "review" ? marketplaceReviewReportReasons : marketplaceListingReportReasons;
  assert((allowedReasons as readonly string[]).includes(value), "Report reason is invalid for this content.");
  return value;
}

function normalizeDetails(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalText(value);
  assert(!normalized || normalized.length <= 1000, "Report details must be 1000 characters or fewer.");
  return normalized;
}
