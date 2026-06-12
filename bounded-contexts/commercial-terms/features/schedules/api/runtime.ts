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
import { getSchedule, listSchedules } from "../read-model/queries";
import {
  decideCommercialTermsSchedule,
  evolveCommercialTermsSchedule,
  initialCommercialTermsScheduleState,
  type CommercialTermsScheduleCommand,
  type CommercialTermsScheduleEvent,
  type CommercialTermsScheduleState,
} from "../domain/domain";

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

  return {
    commandHandler,
    async createSchedule(params, context) {
      const scheduleId = createId("cts");
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
