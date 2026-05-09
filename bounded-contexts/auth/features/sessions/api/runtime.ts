import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import {
  createNoopTransactionalEmailGateway,
  type TransactionalEmailGateway,
} from "@chase-sets/communications-email";
import type { AuthRuntimeDeps } from "./runtime-deps";
import {
  decideSession,
  evolveSession,
  initialSessionState,
  type SessionCommand,
  type SessionEvent,
  type SessionState,
} from "../domain/domain";
import { getSession, listSessions } from "../read-model/queries";
import { buildSessionProjectionHandlers } from "../read-model/projection";
import { buildAuthSessionTransactionalEmailProjectionHandlers } from "../application/transactional-email-projector";

export type SessionServices = Readonly<{
  commandHandler: CommandHandler<SessionCommand, SessionState, SessionEvent>;
  listSessions: (
    params?: Parameters<typeof listSessions>[1],
  ) => ReturnType<typeof listSessions>;
  getSession: (sessionId: string) => ReturnType<typeof getSession>;
  projectors: readonly Projector[];
}>;

export function createSessionRuntime(
  deps: AuthRuntimeDeps &
    Readonly<{ transactionalEmailGateway?: TransactionalEmailGateway }>,
): SessionServices {
  const transactionalEmailGateway =
    deps.transactionalEmailGateway ?? createNoopTransactionalEmailGateway();
  const commandHandler = createCommandHandler({
    repository: createAggregateRepository({
      eventStore: deps.eventStore,
      codec: createPassthroughDomainEventCodec<SessionEvent>(),
      initialState: () => initialSessionState,
      evolve: evolveSession,
    }),
    evolve: evolveSession,
    decide: decideSession,
  });

  return {
    commandHandler,
    listSessions: (params) => listSessions(deps.db, params),
    getSession: (sessionId) => getSession(deps.db, sessionId),
    projectors: [
      createProjector({
        projectorName: "auth-session-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildSessionProjectionHandlers(deps.db),
      }),
      createProjector({
        projectorName: "auth-session-transactional-email-projection",
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildAuthSessionTransactionalEmailProjectionHandlers(
          transactionalEmailGateway,
        ),
      }),
    ],
  };
}
