import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  csatAnalyticsDefaultPageSize,
  csatAnalyticsMaximumPageSize,
  csatAnalyticsMaximumRangeDays,
  csatAnalyticsTimezone,
  csatTrendGranularities,
  type CsatAnalyticsQuery,
  type CsatAnalyticsSnapshot,
  type CsatMetricAvailability,
  type CsatMetricSlice,
  type CsatProjectionHealth,
  type CsatProjectionReadiness,
  type CsatRatingDistribution,
  type CsatTrendBucket,
  type CsatTrendGranularity,
  type CsatVolume,
  type CsatWindowMetrics,
} from "../api/analytics-contract";
import {
  calculateCsat,
  calculateResponseRate,
  csatDefaultMinimumSampleSize,
  csatWindows,
  type CsatWindow,
} from "../domain/csat-metric";
import type { OutcomeSubjectKind } from "../domain/outcome-fact";
import {
  findSurveyDefinition,
  transactionalCsatV1,
  type CsatRatingValue,
  type SurveyVersionId,
} from "../domain/survey";
import type { CsatWorkflowOutcomeCode } from "../domain/workflow-outcomes";

type AnalyticsFactRow = Readonly<{
  invitation_id: string;
  survey_kind: string;
  survey_version: string;
  question_version: string;
  outcome_code: CsatWorkflowOutcomeCode | null;
  customer_role: OutcomeSubjectKind | null;
  sampling_cohort: string | null;
  eligible_at: string | null;
  issued_at: string | null;
  presented_at: string | null;
  dismissed_at: string | null;
  expired_at: string | null;
  submitted_at: string | null;
  rating: CsatRatingValue | null;
}>;

type NormalizedQuery = Readonly<{
  asOf: string;
  trendFrom: string;
  trendTo: string;
  trendGranularity: CsatTrendGranularity;
  cursor: string | null;
  limit: number;
  minimumSampleSize: number | undefined;
  surveyVersion: SurveyVersionId;
  outcomeCodes: readonly CsatWorkflowOutcomeCode[];
  customerRoles: readonly OutcomeSubjectKind[];
  samplingCohorts: readonly string[];
}>;

const dayMs = 86_400_000;

export async function readCsatAnalytics(
  db: PgQueryable,
  query: CsatAnalyticsQuery,
  readiness: CsatProjectionReadiness,
): Promise<CsatAnalyticsSnapshot> {
  const normalized = normalizeQuery(query);
  const earliestWindowStart = addDays(normalized.asOf, -30);
  const earliest =
    Date.parse(normalized.trendFrom) < Date.parse(earliestWindowStart) ? normalized.trendFrom : earliestWindowStart;
  const rows = await loadFacts(db, normalized, earliest);
  const health = projectionHealth(rows, readiness);

  const windows = Object.fromEntries(
    csatWindows.map((window) => {
      const from = addDays(normalized.asOf, window === "trailing-7d" ? -7 : -30);
      return [
        window,
        {
          window,
          from,
          to: normalized.asOf,
          ...metricSlice(
            rows,
            from,
            normalized.asOf,
            normalized.surveyVersion,
            normalized.minimumSampleSize,
            readiness,
          ),
        } satisfies CsatWindowMetrics,
      ];
    }),
  ) as Record<CsatWindow, CsatWindowMetrics>;

  const allBuckets = buildTrendBuckets(rows, normalized, readiness);
  const offset = cursorOffset(allBuckets, normalized.cursor, normalized.trendGranularity);
  const items = allBuckets.slice(offset, offset + normalized.limit);
  const nextCursor =
    offset + normalized.limit < allBuckets.length
      ? encodeCursor(
          items.at(-1)?.bucketStart ?? allBuckets[offset + normalized.limit - 1]!.bucketStart,
          normalized.trendGranularity,
        )
      : null;

  return {
    asOf: normalized.asOf,
    timezone: csatAnalyticsTimezone,
    filters: {
      surveyVersion: normalized.surveyVersion,
      outcomeCodes: normalized.outcomeCodes,
      customerRoles: normalized.customerRoles,
      samplingCohorts: normalized.samplingCohorts,
    },
    windows,
    trend: {
      items,
      nextCursor,
      limit: normalized.limit,
      granularity: normalized.trendGranularity,
      from: normalized.trendFrom,
      to: normalized.trendTo,
    },
    health,
  };
}

async function loadFacts(
  db: PgQueryable,
  query: NormalizedQuery,
  earliest: string,
): Promise<readonly AnalyticsFactRow[]> {
  const values: unknown[] = [
    query.surveyVersion.surveyKind,
    query.surveyVersion.surveyVersion,
    query.surveyVersion.questionVersion,
    earliest,
    query.asOf,
  ];
  const dimensionPredicates: string[] = [];
  appendArrayPredicate(dimensionPredicates, values, "outcome_code", query.outcomeCodes);
  appendArrayPredicate(dimensionPredicates, values, "customer_role", query.customerRoles);
  appendArrayPredicate(dimensionPredicates, values, "sampling_cohort", query.samplingCohorts);

  const result = await db.query<AnalyticsFactRow>(
    `SELECT invitation_id, survey_kind, survey_version, question_version,
            outcome_code, customer_role, sampling_cohort,
            eligible_at, issued_at, presented_at, dismissed_at, expired_at,
            submitted_at, rating
     FROM customer_feedback_csat_analytics_facts
     WHERE survey_kind = $1
       AND survey_version = $2
       AND question_version = $3
       AND (
         (eligible_at >= $4 AND eligible_at < $5) OR
         (issued_at >= $4 AND issued_at < $5) OR
         (presented_at >= $4 AND presented_at < $5) OR
         (dismissed_at >= $4 AND dismissed_at < $5) OR
         (expired_at >= $4 AND expired_at < $5) OR
         (submitted_at >= $4 AND submitted_at < $5)
       )
       ${dimensionPredicates.join("\n       ")}
     ORDER BY invitation_id ASC`,
    values,
  );
  return result.rows;
}

function appendArrayPredicate(
  predicates: string[],
  values: unknown[],
  column: string,
  filter: readonly string[],
): void {
  if (filter.length === 0) return;
  values.push(filter);
  predicates.push(`AND ${column} = ANY($${values.length}::text[])`);
}

function normalizeQuery(query: CsatAnalyticsQuery): NormalizedQuery {
  const asOf = timestamp(query.asOf, "asOf");
  const trendTo = timestamp(query.trendTo ?? asOf, "trendTo");
  const trendFrom = timestamp(query.trendFrom ?? addDays(trendTo, -30), "trendFrom");
  if (Date.parse(trendFrom) >= Date.parse(trendTo)) throw new Error("CSAT trendFrom must be before trendTo.");
  if (Date.parse(trendTo) > Date.parse(asOf)) throw new Error("CSAT trendTo cannot be after asOf.");
  if (Date.parse(trendTo) - Date.parse(trendFrom) > csatAnalyticsMaximumRangeDays * dayMs) {
    throw new Error(`CSAT analytics ranges cannot exceed ${csatAnalyticsMaximumRangeDays} days.`);
  }
  if (Date.parse(asOf) - Date.parse(trendFrom) > csatAnalyticsMaximumRangeDays * dayMs) {
    throw new Error(`CSAT analytics history cannot begin more than ${csatAnalyticsMaximumRangeDays} days before asOf.`);
  }

  const surveyVersion = query.surveyVersion ?? transactionalCsatV1.id;
  const definition = findSurveyDefinition(surveyVersion);
  if (!definition?.csatEligible) throw new Error("CSAT analytics require a registered CSAT-compatible survey version.");
  const trendGranularity = query.trendGranularity ?? "day";
  if (!csatTrendGranularities.includes(trendGranularity)) throw new Error("Unsupported CSAT trend granularity.");
  const limit = query.limit ?? csatAnalyticsDefaultPageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > csatAnalyticsMaximumPageSize) {
    throw new Error(`CSAT trend page size must be between 1 and ${csatAnalyticsMaximumPageSize}.`);
  }
  if (
    query.minimumSampleSize !== undefined &&
    (!Number.isInteger(query.minimumSampleSize) || query.minimumSampleSize < 1)
  ) {
    throw new Error("CSAT minimum sample size must be a positive integer.");
  }

  return {
    asOf,
    trendFrom,
    trendTo,
    trendGranularity,
    cursor: query.cursor ?? null,
    limit,
    minimumSampleSize: query.minimumSampleSize,
    surveyVersion,
    outcomeCodes: sortedUnique(query.outcomeCodes ?? []),
    customerRoles: sortedUnique(query.customerRoles ?? []),
    samplingCohorts: sortedUnique((query.samplingCohorts ?? []).map((value) => requiredText(value, "sampling cohort"))),
  };
}

function metricSlice(
  rows: readonly AnalyticsFactRow[],
  from: string,
  to: string,
  surveyVersion: SurveyVersionId,
  minimumSampleSize: number | undefined,
  readiness: CsatProjectionReadiness,
): CsatMetricSlice {
  const submitted = rows.filter((row) => inRange(row.submitted_at, from, to) && row.rating !== null);
  const presented = rows.filter((row) => inRange(row.presented_at, from, to));
  const respondedPresented = presented.filter(
    (row) =>
      row.submitted_at !== null &&
      row.presented_at !== null &&
      Date.parse(row.submitted_at) >= Date.parse(row.presented_at) &&
      Date.parse(row.submitted_at) < Date.parse(to),
  );
  const calculatorWindow: CsatWindow = "trailing-7d";
  const csat = calculateCsat({
    surveyVersion,
    window: calculatorWindow,
    ratings: submitted.map((row) => ({
      surveyVersion,
      csatEligible: true,
      rating: row.rating!,
      submittedAt: row.submitted_at!,
    })),
    ...(minimumSampleSize === undefined ? {} : { minimumSampleSize }),
  });
  const responseRate = calculateResponseRate(calculatorWindow, {
    presentedCount: presented.length,
    submittedCount: respondedPresented.length,
  });
  const responseSampleSufficient = responseRate.presentedCount >= (minimumSampleSize ?? csatDefaultMinimumSampleSize);

  return {
    csat: csat.csat,
    csatAvailability: availability(readiness, csat.submittedCount, csat.sampleSufficient),
    satisfiedCount: csat.satisfiedCount,
    submittedCount: csat.submittedCount,
    responseRate: responseRate.responseRate,
    responseRateAvailability: availability(readiness, responseRate.presentedCount, responseSampleSufficient),
    presentedCount: responseRate.presentedCount,
    respondedPresentedCount: responseRate.submittedCount,
    ratingDistribution: distribution(submitted),
    volume: volume(rows, from, to),
  };
}

function buildTrendBuckets(
  rows: readonly AnalyticsFactRow[],
  query: NormalizedQuery,
  readiness: CsatProjectionReadiness,
): readonly CsatTrendBucket[] {
  const buckets: CsatTrendBucket[] = [];
  let start = bucketStart(query.trendFrom, query.trendGranularity);
  while (Date.parse(start) < Date.parse(query.trendTo)) {
    const naturalEnd = nextBucket(start, query.trendGranularity);
    const from = Date.parse(start) < Date.parse(query.trendFrom) ? query.trendFrom : start;
    const to = Date.parse(naturalEnd) > Date.parse(query.trendTo) ? query.trendTo : naturalEnd;
    buckets.push({
      bucketStart: start,
      bucketEnd: to,
      granularity: query.trendGranularity,
      ...metricSlice(rows, from, to, query.surveyVersion, query.minimumSampleSize, readiness),
    });
    start = naturalEnd;
  }
  return buckets;
}

function volume(rows: readonly AnalyticsFactRow[], from: string, to: string): CsatVolume {
  return {
    eligible: countTimestamp(rows, "eligible_at", from, to),
    issued: countTimestamp(rows, "issued_at", from, to),
    presented: countTimestamp(rows, "presented_at", from, to),
    dismissed: countTimestamp(rows, "dismissed_at", from, to),
    expired: countTimestamp(rows, "expired_at", from, to),
    submitted: countTimestamp(rows, "submitted_at", from, to),
  };
}

function countTimestamp(
  rows: readonly AnalyticsFactRow[],
  key: "eligible_at" | "issued_at" | "presented_at" | "dismissed_at" | "expired_at" | "submitted_at",
  from: string,
  to: string,
): number {
  return rows.filter((row) => inRange(row[key], from, to)).length;
}

function distribution(rows: readonly AnalyticsFactRow[]): CsatRatingDistribution {
  const result: Record<CsatRatingValue, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const row of rows) if (row.rating !== null) result[row.rating] += 1;
  return result;
}

function projectionHealth(rows: readonly AnalyticsFactRow[], readiness: CsatProjectionReadiness): CsatProjectionHealth {
  if (readiness.projectionLagMs !== null && readiness.projectionLagMs < 0) {
    throw new Error("CSAT projection lag cannot be negative.");
  }
  if (!Number.isInteger(readiness.rejectedEventCount) || readiness.rejectedEventCount < 0) {
    throw new Error("CSAT rejected event count cannot be negative.");
  }
  const latencies = rows
    .filter((row) => row.presented_at !== null && row.submitted_at !== null)
    .map((row) => Date.parse(row.submitted_at!) - Date.parse(row.presented_at!))
    .filter((latency) => latency >= 0)
    .sort((left, right) => left - right);
  const anomalies = rows.filter(
    (row) =>
      row.submitted_at !== null &&
      (row.presented_at === null || Date.parse(row.submitted_at) < Date.parse(row.presented_at)),
  ).length;
  return {
    ...readiness,
    denominatorAnomalyCount: anomalies,
    invitationToSubmissionLatency: {
      sampleCount: latencies.length,
      medianMs: percentile(latencies, 0.5),
      p95Ms: percentile(latencies, 0.95),
      maximumMs: latencies.at(-1) ?? null,
    },
  };
}

function percentile(sorted: readonly number[], percentileValue: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.ceil(sorted.length * percentileValue) - 1] ?? null;
}

function availability(
  readiness: CsatProjectionReadiness,
  denominator: number,
  sampleSufficient: boolean,
): CsatMetricAvailability {
  if (!readiness.complete) return "incomplete";
  if (readiness.stale) return "stale";
  if (denominator === 0) return "zero-denominator";
  return sampleSufficient ? "available" : "insufficient-sample";
}

function inRange(value: string | null, from: string, to: string): boolean {
  return value !== null && Date.parse(value) >= Date.parse(from) && Date.parse(value) < Date.parse(to);
}

function timestamp(value: string, field: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid CSAT ${field} timestamp.`);
  return new Date(parsed).toISOString();
}

function addDays(value: string, days: number): string {
  return new Date(Date.parse(value) + days * dayMs).toISOString();
}

function bucketStart(value: string, granularity: CsatTrendGranularity): string {
  const date = new Date(value);
  date.setUTCHours(0, 0, 0, 0);
  if (granularity === "week") date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString();
}

function nextBucket(value: string, granularity: CsatTrendGranularity): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + (granularity === "day" ? 1 : 7));
  return date.toISOString();
}

function encodeCursor(bucketStartValue: string, granularity: CsatTrendGranularity): string {
  return Buffer.from(JSON.stringify({ version: 1, bucketStart: bucketStartValue, granularity }), "utf8").toString(
    "base64url",
  );
}

function cursorOffset(
  buckets: readonly CsatTrendBucket[],
  cursor: string | null,
  granularity: CsatTrendGranularity,
): number {
  if (!cursor) return 0;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid CSAT trend cursor.");
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    !("version" in decoded) ||
    decoded.version !== 1 ||
    !("bucketStart" in decoded) ||
    typeof decoded.bucketStart !== "string" ||
    !("granularity" in decoded) ||
    decoded.granularity !== granularity
  ) {
    throw new Error("Invalid CSAT trend cursor.");
  }
  const index = buckets.findIndex((bucket) => bucket.bucketStart === decoded.bucketStart);
  if (index < 0) throw new Error("CSAT trend cursor is outside the requested range.");
  return index + 1;
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`CSAT ${label} cannot be empty.`);
  return normalized;
}

function sortedUnique<T extends string>(values: readonly T[]): readonly T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
