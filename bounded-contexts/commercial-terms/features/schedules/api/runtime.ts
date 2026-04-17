import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import type { EventStore } from "@chase-sets/event-core/event-store";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
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
  listSchedules: (params: Readonly<{ limit?: number; offset?: number }>) => ReturnType<typeof listSchedules>;
  getSchedule: (scheduleId: string) => ReturnType<typeof getSchedule>;
  projectors: readonly Projector[];
}>;

export function createScheduleRuntime(deps: ScheduleRuntimeDeps): ScheduleServices {
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<CommercialTermsScheduleEvent>(),
      initialState: () => initialCommercialTermsScheduleState,
      evolve: evolveCommercialTermsSchedule,
    }),
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
    listSchedules: (params) => listSchedules(deps.db, params),
    getSchedule: (scheduleId) => getSchedule(deps.db, scheduleId),
    projectors: [
      createProjector({
        projectorName: "commercial-terms-schedule-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildScheduleProjectionHandlers(deps.db),
      }),
    ],
  };
}
