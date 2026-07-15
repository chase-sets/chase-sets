import type { CsatWindow } from "../domain/csat-metric";
import type { OutcomeSubjectKind } from "../domain/outcome-fact";
import type { CsatRatingValue, SurveyVersionId } from "../domain/survey";
import type { CsatWorkflowOutcomeCode } from "../domain/workflow-outcomes";

export const csatTrendGranularities = ["day", "week"] as const;
export type CsatTrendGranularity = (typeof csatTrendGranularities)[number];

export const csatAnalyticsTimezone = "UTC" as const;
export const csatAnalyticsMaximumRangeDays = 366 as const;
export const csatAnalyticsDefaultPageSize = 31 as const;
export const csatAnalyticsMaximumPageSize = 100 as const;

export type CsatAnalyticsFilters = Readonly<{
  surveyVersion?: SurveyVersionId;
  outcomeCodes?: readonly CsatWorkflowOutcomeCode[];
  customerRoles?: readonly OutcomeSubjectKind[];
  samplingCohorts?: readonly string[];
}>;

/**
 * All ranges are half-open UTC intervals: `[from, to)`. Daily buckets begin at
 * 00:00 UTC and weekly buckets begin Monday at 00:00 UTC. Device and delivery
 * channel are deliberately absent until a lifecycle contract legitimately
 * records them; callers cannot manufacture either dimension.
 */
export type CsatAnalyticsQuery = Readonly<
  CsatAnalyticsFilters & {
    asOf: string;
    trendFrom?: string;
    trendTo?: string;
    trendGranularity?: CsatTrendGranularity;
    cursor?: string | null;
    limit?: number;
    minimumSampleSize?: number;
  }
>;

export type CsatProjectionReadiness = Readonly<{
  complete: boolean;
  stale: boolean;
  lastProjectedAt: string | null;
  projectionLagMs: number | null;
  rejectedEventCount: number;
}>;

export type CsatMetricAvailability = "available" | "insufficient-sample" | "zero-denominator" | "incomplete" | "stale";

export type CsatVolume = Readonly<{
  eligible: number;
  issued: number;
  presented: number;
  dismissed: number;
  expired: number;
  submitted: number;
}>;

export type CsatRatingDistribution = Readonly<Record<CsatRatingValue, number>>;

export type CsatMetricSlice = Readonly<{
  csat: number | null;
  csatAvailability: CsatMetricAvailability;
  satisfiedCount: number;
  submittedCount: number;
  responseRate: number | null;
  responseRateAvailability: CsatMetricAvailability;
  presentedCount: number;
  respondedPresentedCount: number;
  ratingDistribution: CsatRatingDistribution;
  volume: CsatVolume;
}>;

export type CsatWindowMetrics = CsatMetricSlice & Readonly<{ window: CsatWindow; from: string; to: string }>;

export type CsatTrendBucket = CsatMetricSlice &
  Readonly<{
    bucketStart: string;
    bucketEnd: string;
    granularity: CsatTrendGranularity;
  }>;

export type CsatProjectionHealth = CsatProjectionReadiness &
  Readonly<{
    denominatorAnomalyCount: number;
    invitationToSubmissionLatency: Readonly<{
      sampleCount: number;
      medianMs: number | null;
      p95Ms: number | null;
      maximumMs: number | null;
    }>;
  }>;

export type CsatAnalyticsSnapshot = Readonly<{
  asOf: string;
  timezone: typeof csatAnalyticsTimezone;
  filters: Required<Pick<CsatAnalyticsFilters, "surveyVersion">> & Omit<CsatAnalyticsFilters, "surveyVersion">;
  windows: Readonly<Record<CsatWindow, CsatWindowMetrics>>;
  trend: Readonly<{
    items: readonly CsatTrendBucket[];
    nextCursor: string | null;
    limit: number;
    granularity: CsatTrendGranularity;
    from: string;
    to: string;
  }>;
  health: CsatProjectionHealth;
}>;

export type CsatAdminQueueFilters = Readonly<{
  from?: string;
  to?: string;
  surveyVersion?: SurveyVersionId;
  outcomeCodes?: readonly CsatWorkflowOutcomeCode[];
  customerRoles?: readonly OutcomeSubjectKind[];
  states?: readonly string[];
  ratings?: readonly CsatRatingValue[];
  followUpConsent?: "granted" | "not-granted";
}>;

export type CsatAdminQueueQuery = CsatAdminQueueFilters &
  Readonly<{
    cursor?: string | null;
    direction?: "next" | "previous";
    limit?: number;
  }>;

export type CsatAdminQueueItem = Readonly<{
  invitationId: string;
  state: string;
  surveyVersion: SurveyVersionId;
  outcomeCode: string;
  customerRole: OutcomeSubjectKind;
  eligibleAt: string;
  issuedAt: string | null;
  presentedAt: string | null;
  submittedAt: string | null;
  dismissedAt: string | null;
  expiredAt: string | null;
  rating: CsatRatingValue | null;
  followUpConsent: boolean | null;
}>;

export type CsatAdminQueuePage = Readonly<{
  items: readonly CsatAdminQueueItem[];
  nextCursor: string | null;
  previousCursor: string | null;
  limit: number;
}>;

export type CsatAdminExportAudit = Readonly<{
  exportId?: string;
  actorId: string;
  capability: string;
  filters: CsatAdminQueueFilters;
  reason: string;
  startedAt: string;
  completedAt: string | null;
  artifactExpiresAt: string;
  rowCount: number;
  result: "completed" | "failed";
  failureCode: string | null;
  artifactContent: string | null;
}>;

export type CsatAdminExportArtifact = Readonly<{
  exportId: string;
  actorId: string;
  artifactExpiresAt: string;
  artifactContent: string;
}>;
