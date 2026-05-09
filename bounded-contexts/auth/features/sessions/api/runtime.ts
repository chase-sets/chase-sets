import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import {
  createCommandHandler,
  type CommandHandler,
} from "@chase-sets/event-core/command-handler";
import { createProjector, type Projector } from "@chase-sets/event-core/projector";
import {
  createNoopTransactionalEmailOutbox,
  type TransactionalEmailOutbox,
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
import {
  AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
  buildAuthSessionTransactionalEmailProjectionHandlers,
  type MagicLinkDeliveryTokenStore,
} from "../application/transactional-email-projector";

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
    Readonly<{
      transactionalEmailOutbox?: TransactionalEmailOutbox;
      magicLinkDeliveryTokens?: MagicLinkDeliveryTokenStore;
    }>,
): SessionServices {
  const transactionalEmailOutbox =
    deps.transactionalEmailOutbox ?? createNoopTransactionalEmailOutbox();
  const magicLinkDeliveryTokens =
    deps.magicLinkDeliveryTokens ?? {
      getMagicLinkDeliveryToken: async () => null,
      clearMagicLinkDeliveryToken: async () => undefined,
    };
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
        projectorName: AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
        eventStore: deps.eventStore,
        checkpointStore: deps.checkpointStore,
        handlers: buildAuthSessionTransactionalEmailProjectionHandlers(
          transactionalEmailOutbox,
          magicLinkDeliveryTokens,
          AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}
