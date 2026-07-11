import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CommercialTermsPolicyRuntime } from "../../../support/runtime-support/policy-runtime";
import { commercialTermsSchedulePolicy } from "../../../support/runtime-support/terms-policy";
import {
  CommercialTermsDomainError,
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  type CommercialAccountType,
  type CommercialTermsStatus,
} from "../../../support/runtime-support/common";
import { getSchedule, listSchedules } from "../read-model/queries";

/**
 * Schedules converged onto the shared platform-policy machinery:
 * this module no longer owns an aggregate, command handler, or projector --
 * those live once, shared across every commercial-terms policy family, in
 * `support/runtime-support/policy-runtime.ts`. What remains here is
 * schedule-specific: translating the admin-facing create/revise shape into
 * a `commercial-terms.schedule.<accountType>` policy document, and the
 * read-model query surface.
 */

type ScheduleRuntimeDeps = Readonly<{
  policies: CommercialTermsPolicyRuntime;
  db: PgQueryable;
}>;

export type CreateScheduleParams = Readonly<{
  label: string;
  accountType: CommercialAccountType;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps?: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  createdByUserId: string;
}>;

export type ReviseScheduleParams = Readonly<{
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps: number;
  status: CommercialTermsStatus;
  effectiveFrom: string;
  effectiveUntil: string | null;
  revisedByUserId: string;
}>;

export type ScheduleServices = Readonly<{
  createSchedule: (
    params: CreateScheduleParams,
    context: EventStoreContext,
  ) => Promise<{ scheduleId: string; version: number }>;
  reviseSchedule: (
    scheduleId: string,
    params: ReviseScheduleParams,
    context: EventStoreContext,
  ) => Promise<{ scheduleId: string; version: number }>;
  listSchedules: (params: Readonly<{ limit?: number; offset?: number }>) => ReturnType<typeof listSchedules>;
  getSchedule: (scheduleId: string) => ReturnType<typeof getSchedule>;
}>;

export function createScheduleRuntime(deps: ScheduleRuntimeDeps): ScheduleServices {
  return {
    async createSchedule(params, context) {
      const definition = commercialTermsSchedulePolicy(params.accountType);
      return deps.policies.createScheduleDocument(
        definition,
        {
          value: {
            label: params.label,
            accountType: params.accountType,
            marketplaceSalesFeePercentageBps: params.marketplaceSalesFeePercentageBps,
            marketplaceSalesFeeFixedAmount: params.marketplaceSalesFeeFixedAmount,
            shippingAllowancePercentageBps:
              params.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
          },
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
          actorUserId: params.createdByUserId,
        },
        context,
      );
    },
    async reviseSchedule(scheduleId, params, context) {
      const current = await getSchedule(deps.db, scheduleId);
      if (!current) {
        throw new CommercialTermsDomainError("Schedule not found.");
      }
      const accountType = current.account_type as CommercialAccountType;
      const definition = commercialTermsSchedulePolicy(accountType);
      return deps.policies.reviseScheduleDocument(
        definition,
        scheduleId,
        {
          value: {
            label: params.label,
            accountType,
            marketplaceSalesFeePercentageBps: params.marketplaceSalesFeePercentageBps,
            marketplaceSalesFeeFixedAmount: params.marketplaceSalesFeeFixedAmount,
            shippingAllowancePercentageBps: params.shippingAllowancePercentageBps,
          },
          status: params.status,
          effectiveFrom: params.effectiveFrom,
          effectiveUntil: params.effectiveUntil,
          actorUserId: params.revisedByUserId,
        },
        context,
      );
    },
    listSchedules: (params) => listSchedules(deps.db, params),
    getSchedule: (scheduleId) => getSchedule(deps.db, scheduleId),
  };
}
