import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createId } from "@chase-sets/primitives/typed-ids";
import { buildScheduleProjectionHandlers } from "../read-model/projection";
import { findOverlappingActiveSchedule, getSchedule, listSchedules } from "../read-model/queries";
import {
  decideCommercialTermsSchedule,
  evolveCommercialTermsSchedule,
  initialCommercialTermsScheduleState,
  type CommercialTermsScheduleCommand,
  type CommercialTermsScheduleEvent,
  type CommercialTermsScheduleState,
} from "../domain/domain";
import { CommercialTermsDomainError } from "../../../support/runtime-support/common";

type ScheduleRuntimeDeps = Readonly<{
  eventStore: EventStore;
  checkpointStore: ProjectionCheckpointStore;
  db: PgQueryable;
}>;

export type ScheduleServices = Readonly<{
  commandHandler: CommandHandler<
    CommercialTermsScheduleCommand,
    CommercialTermsScheduleState,
    CommercialTermsScheduleEvent
  >;
  createSchedule: (
    params: Omit<Extract<CommercialTermsScheduleCommand, { type: "CreateSchedule" }>, "type" | "scheduleId">,
    context: EventStoreContext,
  ) => Promise<{ scheduleId: string; version: number }>;
  reviseSchedule: (
    scheduleId: string,
    params: Omit<Extract<CommercialTermsScheduleCommand, { type: "ReviseSchedule" }>, "type">,
    context: EventStoreContext,
  ) => Promise<{ scheduleId: string; version: number }>;
  listSchedules: (params: Readonly<{ limit?: number; offset?: number }>) => ReturnType<typeof listSchedules>;
  getSchedule: (scheduleId: string) => ReturnType<typeof getSchedule>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createScheduleRuntime(deps: ScheduleRuntimeDeps): ScheduleServices {
  const { commandHandler } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<CommercialTermsScheduleEvent>(),
    initialState: () => initialCommercialTermsScheduleState,
    evolve: evolveCommercialTermsSchedule,
    decide: decideCommercialTermsSchedule,
  });

  async function assertNoActiveOverlap(
    params: Readonly<{
      accountType: string;
      status: string;
      effectiveFrom: string;
      effectiveUntil: string | null;
      excludeScheduleId?: string | null;
    }>,
  ) {
    if (params.status !== "active") {
      return;
    }

    const overlap = await findOverlappingActiveSchedule(deps.db, params);
    if (overlap) {
      throw new CommercialTermsDomainError(
        `Active schedule ${overlap.schedule_id} already covers that account type and effective window.`,
      );
    }
  }

  return {
    commandHandler,
    async createSchedule(params, context) {
      const scheduleId = createId("cts");
      await assertNoActiveOverlap({
        accountType: params.accountType,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
      });
      const result = await commandHandler({
        streamId: `commercial-terms.schedule-${scheduleId}`,
        command: {
          type: "CreateSchedule",
          scheduleId,
          ...params,
        },
        context,
      });
      return { scheduleId, version: result.version };
    },
    async reviseSchedule(scheduleId, params, context) {
      const current = await getSchedule(deps.db, scheduleId);
      if (!current) {
        throw new CommercialTermsDomainError("Schedule not found.");
      }
      await assertNoActiveOverlap({
        accountType: current.account_type,
        status: params.status,
        effectiveFrom: params.effectiveFrom,
        effectiveUntil: params.effectiveUntil,
        excludeScheduleId: scheduleId,
      });
      const result = await commandHandler({
        streamId: `commercial-terms.schedule-${scheduleId}`,
        command: {
          type: "ReviseSchedule",
          ...params,
        },
        context,
      });
      return { scheduleId, version: result.version };
    },
    listSchedules: (params) => listSchedules(deps.db, params),
    getSchedule: (scheduleId) => getSchedule(deps.db, scheduleId),
    projectors: [
      createProjectionHandlerSet({
        projectionName: "commercial-terms-schedule-projection",
        handlers: buildScheduleProjectionHandlers(deps.db),
      }),
    ],
  };
}
