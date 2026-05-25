import { createAggregateRepository } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import { createCommandHandler, type CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createNoopTransactionalEmailOutbox, type TransactionalEmailOutbox } from "@chase-sets/communications-email";
import type { AuthRuntimeDeps } from "./runtime-deps";
import {
  decideSession,
  evolveSession,
  initialSessionState,
  type SessionCommand,
  type SessionEvent,
  type SessionState,
} from "../domain/domain";
import { toSessionStreamId } from "../domain/auth-flow";
import { getSession, listSessions } from "../read-model/queries";
import { buildSessionProjectionHandlers } from "../read-model/projection";
import {
  AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
  buildAuthSessionTransactionalEmailProjectionHandlers,
  type MagicLinkDeliveryTokenStore,
} from "../integrations/transactional-email/transactional-email-projector";

export type SessionServices = Readonly<{
  commandHandler: CommandHandler<SessionCommand, SessionState, SessionEvent>;
  listSessions: (params?: Parameters<typeof listSessions>[1]) => ReturnType<typeof listSessions>;
  getSession: (sessionId: string) => ReturnType<typeof getSession>;
  getSessionState: (sessionId: string) => Promise<SessionState | null>;
  projectors: readonly ProjectionHandlerSet[];
}>;

export function createSessionRuntime(
  deps: AuthRuntimeDeps &
    Readonly<{
      transactionalEmailOutbox?: TransactionalEmailOutbox;
      magicLinkDeliveryTokens?: MagicLinkDeliveryTokenStore;
    }>,
): SessionServices {
  const transactionalEmailOutbox = deps.transactionalEmailOutbox ?? createNoopTransactionalEmailOutbox();
  const magicLinkDeliveryTokens = deps.magicLinkDeliveryTokens ?? {
    getMagicLinkDeliveryToken: async () => null,
    clearMagicLinkDeliveryToken: async () => undefined,
  };
  const repository = createAggregateRepository({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SessionEvent>(),
    initialState: () => initialSessionState,
    evolve: evolveSession,
  });
  const commandHandler = createCommandHandler({
    repository,
    evolve: evolveSession,
    decide: decideSession,
  });

  return {
    commandHandler,
    listSessions: (params) => listSessions(deps.db, params),
    getSession: (sessionId) => getSession(deps.db, sessionId),
    getSessionState: async (sessionId) => {
      const loaded = await repository.load(toSessionStreamId(sessionId));
      return loaded.state.id ? loaded.state : null;
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "auth-session-projection",
        handlers: buildSessionProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildAuthSessionTransactionalEmailProjectionHandlers(
          transactionalEmailOutbox,
          magicLinkDeliveryTokens,
          AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}
