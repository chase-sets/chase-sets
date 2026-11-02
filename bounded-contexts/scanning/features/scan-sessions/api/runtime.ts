import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { buildScanSessionProjectionHandlers } from "../read-model/projection";
import {
  decideScanSession,
  evolveScanSession,
  initialScanSessionState,
  scanSessionStreamId,
  type ScanSessionCommand,
  type ScanSessionEvent,
} from "../domain/scan-session";

export function createScanSessionRuntime(deps: { eventStore: EventStore; db: PgQueryable }) {
  const handler = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<ScanSessionEvent>(),
    initialState: () => initialScanSessionState,
    evolve: evolveScanSession,
    decide: decideScanSession,
    commitSourceContextName: "scanning",
  });
  return {
    command: async (sessionId: string, command: ScanSessionCommand, context: EventStoreContext) =>
      handler.commandHandler({ streamId: scanSessionStreamId(sessionId), command, context }),
    repository: handler.repository,
    projectors: [
      {
        projectionName: "scanning-scan-session-projection",
        handlers: buildScanSessionProjectionHandlers(deps.db),
      } as ProjectionHandlerSet,
    ],
  };
}
