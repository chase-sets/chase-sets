import type { AgreementServices } from "../../agreements/api/runtime";
import type { CommercialAgreementRow } from "../../agreements/read-model/queries";
import type { ScheduleServices } from "../../schedules/api/runtime";
import type { CommercialTermsScheduleRow } from "../../schedules/read-model/queries";
import type { CommercialAccountType } from "../../../support/runtime-support/common";
import { COMMERCIAL_TERMS_SCHEDULE_LAUNCH_VALUES } from "../../../support/runtime-support/terms-policy";

/**
 * The Commercial Terms home answer: one read over the schedule and agreement
 * read models, resolved at one server instant, so every client renders the
 * same schedule in effect, term order, phase and create-form starting terms.
 */

/** The schedule and agreement list read models cap a page at this many rows. */
const SOURCE_PAGE_SIZE = 250;

export type CommercialTermsHomePhase = "scheduled" | "in_effect" | "expiring";

type TermPhase = Readonly<{ phase: CommercialTermsHomePhase; phaseAt: string }>;

export type CommercialTermsHomeTerm =
  | (TermPhase & Readonly<{ kind: "schedule"; id: string; item: CommercialTermsScheduleRow }>)
  | (TermPhase & Readonly<{ kind: "agreement"; id: string; item: CommercialAgreementRow }>);

/** Create-form starting values; a null label leaves the client's own new-term label in place. */
export type CommercialTermsStartingTerms = Readonly<{
  label: string | null;
  marketplace_sales_fee_percentage_bps: number;
  marketplace_sales_fee_fixed_amount: string;
  shipping_allowance_percentage_bps: number;
  status: string;
  effective_from: string;
  effective_until: string | null;
}>;

export type CommercialTermsHome = Readonly<{
  resolvedAt: string;
  schedulesInEffect: Readonly<Record<CommercialAccountType, CommercialTermsScheduleRow | null>>;
  activeTerms: readonly CommercialTermsHomeTerm[];
  startingTerms: Readonly<{
    schedule: CommercialTermsStartingTerms;
    override: Readonly<Record<CommercialAccountType | "default", CommercialTermsStartingTerms>>;
  }>;
  scheduleComparison: CommercialTermsScheduleRow | null;
}>;

export class CommercialTermsHomeIncompleteError extends Error {
  public constructor(
    public readonly source: "schedules" | "agreements",
    public readonly rowCount: number,
    public readonly total: number,
  ) {
    super(`Commercial Terms home read ${rowCount} of ${total} ${source}; the home answer needs every row.`);
    this.name = "CommercialTermsHomeIncompleteError";
  }
}

type TermWindow = Readonly<{ status: string; effective_from: string; effective_until: string | null }>;

// node-postgres returns timestamptz columns as Date objects although the row types declare strings.
function isoTimestamp(value: string | Date) {
  return new Date(value).toISOString();
}

function withIsoTimestamps<T extends TermWindow & Readonly<{ created_at: string; updated_at: string }>>(row: T): T {
  return {
    ...row,
    effective_from: isoTimestamp(row.effective_from),
    effective_until: row.effective_until === null ? null : isoTimestamp(row.effective_until),
    created_at: isoTimestamp(row.created_at),
    updated_at: isoTimestamp(row.updated_at),
  };
}

function compareIso(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isActiveAndNotEnded(item: TermWindow, at: string) {
  return item.status === "active" && (item.effective_until === null || item.effective_until > at);
}

function isInEffect(item: TermWindow, at: string) {
  return isActiveAndNotEnded(item, at) && item.effective_from <= at;
}

function scheduleInEffect(
  schedules: readonly CommercialTermsScheduleRow[],
  accountType: string,
  at: string,
  excludedScheduleId: string | null = null,
) {
  return (
    schedules
      .filter(
        (item) => item.account_type === accountType && item.schedule_id !== excludedScheduleId && isInEffect(item, at),
      )
      .sort(
        (left, right) =>
          compareIso(right.effective_from, left.effective_from) ||
          compareIso(right.updated_at, left.updated_at) ||
          right.schedule_id.localeCompare(left.schedule_id),
      )[0] ?? null
  );
}

function termPhase(kind: CommercialTermsHomeTerm["kind"], item: TermWindow, at: string): TermPhase {
  if (item.effective_from > at) {
    return { phase: "scheduled", phaseAt: item.effective_from };
  }
  if (kind === "agreement" && item.effective_until !== null) {
    return { phase: "expiring", phaseAt: item.effective_until };
  }
  return { phase: "in_effect", phaseAt: item.effective_from };
}

function startingTermsFrom(schedule: CommercialTermsScheduleRow | null, at: string): CommercialTermsStartingTerms {
  if (schedule) {
    return {
      label: schedule.label,
      marketplace_sales_fee_percentage_bps: schedule.marketplace_sales_fee_percentage_bps,
      marketplace_sales_fee_fixed_amount: schedule.marketplace_sales_fee_fixed_amount,
      shipping_allowance_percentage_bps: schedule.shipping_allowance_percentage_bps,
      status: schedule.status,
      effective_from: schedule.effective_from,
      effective_until: schedule.effective_until,
    };
  }
  // Every account type starts from the business launch fees, as the admin create forms always have.
  const launch = COMMERCIAL_TERMS_SCHEDULE_LAUNCH_VALUES.business;
  return {
    label: null,
    marketplace_sales_fee_percentage_bps: launch.marketplaceSalesFeePercentageBps,
    marketplace_sales_fee_fixed_amount: launch.marketplaceSalesFeeFixedAmount,
    shipping_allowance_percentage_bps: launch.shippingAllowancePercentageBps,
    status: "active",
    effective_from: at,
    effective_until: null,
  };
}

export function resolveCommercialTermsHome(
  input: Readonly<{
    schedules: readonly CommercialTermsScheduleRow[];
    agreements: readonly CommercialAgreementRow[];
    resolvedAt: string;
    scheduleId: string | null;
  }>,
): CommercialTermsHome {
  const at = isoTimestamp(input.resolvedAt);
  const schedules = input.schedules.map(withIsoTimestamps);
  const agreements = input.agreements.map(withIsoTimestamps);
  const schedulesInEffect = {
    personal: scheduleInEffect(schedules, "personal", at),
    business: scheduleInEffect(schedules, "business", at),
    enterprise: scheduleInEffect(schedules, "enterprise", at),
  } satisfies Record<CommercialAccountType, CommercialTermsScheduleRow | null>;
  const activeTerms: CommercialTermsHomeTerm[] = [
    ...schedules
      .filter((item) => isActiveAndNotEnded(item, at))
      .map((item) => ({ kind: "schedule" as const, id: item.schedule_id, ...termPhase("schedule", item, at), item })),
    ...agreements
      .filter((item) => isActiveAndNotEnded(item, at))
      .map((item) => ({
        kind: "agreement" as const,
        id: item.agreement_id,
        ...termPhase("agreement", item, at),
        item,
      })),
  ].sort(
    (left, right) => compareIso(right.item.effective_from, left.item.effective_from) || left.id.localeCompare(right.id),
  );
  const selectedSchedule = input.scheduleId
    ? schedules.find((item) => item.schedule_id === input.scheduleId)
    : undefined;

  return {
    resolvedAt: at,
    schedulesInEffect,
    activeTerms,
    startingTerms: {
      schedule: startingTermsFrom(schedulesInEffect.business, at),
      override: {
        personal: startingTermsFrom(schedulesInEffect.personal, at),
        business: startingTermsFrom(schedulesInEffect.business, at),
        enterprise: startingTermsFrom(schedulesInEffect.enterprise, at),
        default: startingTermsFrom(null, at),
      },
    },
    scheduleComparison: selectedSchedule
      ? scheduleInEffect(schedules, selectedSchedule.account_type, at, selectedSchedule.schedule_id)
      : null,
  };
}

function completeRows<T>(
  source: CommercialTermsHomeIncompleteError["source"],
  page: Readonly<{ items: readonly T[]; total: number }>,
) {
  if (page.total > SOURCE_PAGE_SIZE || page.items.length !== page.total) {
    throw new CommercialTermsHomeIncompleteError(source, page.items.length, page.total);
  }
  return page.items;
}

export type HomeServices = Readonly<{
  readHome: (params: Readonly<{ resolvedAt: string; scheduleId: string | null }>) => Promise<CommercialTermsHome>;
}>;

type HomeRuntimeDeps = Readonly<{
  schedules: Pick<ScheduleServices, "listSchedules">;
  agreements: Pick<AgreementServices, "listAgreements">;
}>;

export function createHomeRuntime(deps: HomeRuntimeDeps): HomeServices {
  return {
    async readHome({ resolvedAt, scheduleId }) {
      const firstPage = { limit: SOURCE_PAGE_SIZE, offset: 0 };
      const [schedules, agreements] = await Promise.all([
        deps.schedules.listSchedules(firstPage),
        deps.agreements.listAgreements(firstPage),
      ]);
      return resolveCommercialTermsHome({
        schedules: completeRows("schedules", schedules),
        agreements: completeRows("agreements", agreements),
        resolvedAt,
        scheduleId,
      });
    },
  };
}
