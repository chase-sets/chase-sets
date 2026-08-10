import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { LoadedAggregate } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type { CommandHandler } from "@chase-sets/event-core/command-handler";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
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

const SESSION_STARTED_EVENT_TYPE = "auth.session.started";

/**
 * Auth-internal read of a session aggregate: the domain `SessionState`, plus
 * the session's own moment of authentication as a separate storage fact.
 *
 * `authenticatedAt` is deliberately NOT folded into `SessionState`. It is not
 * aggregate state -- it is the event store's own write stamp for this stream's
 * start event -- and folding it would let a snapshot carry it, which would make
 * a suffix load report a fact its events no longer contain.
 */
export type AuthenticatedSessionRead = Readonly<{
  state: SessionState;
  authenticatedAt: string | null;
}>;

export type SessionServices = Readonly<{
  commandHandler: CommandHandler<SessionCommand, SessionState, SessionEvent>;
  listSessions: (params?: Parameters<typeof listSessions>[1]) => ReturnType<typeof listSessions>;
  getSession: (sessionId: string) => ReturnType<typeof getSession>;
  getSessionState: (sessionId: string) => Promise<SessionState | null>;
  /**
   * Auth-internal companion to `getSessionState` for callers that need the
   * session's authentication moment as well as its state -- today only the
   * projection-miss fallback in `resolveActorFromSessionId`, which must not
   * invent one. Seed reconciliation and every other consumer keep using
   * `getSessionState`, whose behavior is unchanged.
   */
  readAuthenticatedSession: (sessionId: string) => Promise<AuthenticatedSessionRead | null>;
  projectors: readonly ProjectionHandlerSet[];
}>;

/**
 * Resolves the session's authoritative moment of authentication from a loaded
 * aggregate, or `null` when the load does not pin it unambiguously.
 *
 * Authority is exactly one value: the `recordedAt` the event store stamped on
 * this stream's `auth.session.started` event. Never `occurredAt` -- that is
 * supplied by whoever appended -- and never read time.
 *
 * `null` (which makes every downstream recent-authentication gate fail closed)
 * is returned whenever that value is not unambiguously present:
 *
 * - the loaded events contain no start event, which includes a snapshot base
 *   that folded the stream prefix away and left only a suffix;
 * - the stream carries more than one start event (ambiguous -- not "last one
 *   wins", because a second start is itself a contradiction);
 * - the decoded and stored views disagree about which position is the start
 *   event, i.e. the positional 1:1 codec alignment `load()` produces does not
 *   hold and no stored event can be attributed to the decoded start;
 * - `recordedAt` is missing, empty, or not a parsable timestamp.
 */
export function resolveSessionAuthenticatedAt(
  loaded: Pick<LoadedAggregate<SessionState, SessionEvent>, "events" | "storedEvents">,
): string | null {
  const decodedStartIndexes = indexesOfSessionStart(loaded.events, (event) => event.type);
  const storedStartIndexes = indexesOfSessionStart(loaded.storedEvents, (event) => event.eventType);

  if (decodedStartIndexes.length !== 1 || storedStartIndexes.length !== 1) {
    return null;
  }
  if (decodedStartIndexes[0] !== storedStartIndexes[0]) {
    return null;
  }

  const recordedAt = loaded.storedEvents[storedStartIndexes[0]].recordedAt;
  if (typeof recordedAt !== "string" || Number.isNaN(new Date(recordedAt).getTime())) {
    return null;
  }

  return recordedAt;
}

function indexesOfSessionStart<Event>(events: readonly Event[], eventTypeOf: (event: Event) => string): number[] {
  const indexes: number[] = [];
  events.forEach((event, index) => {
    if (eventTypeOf(event) === SESSION_STARTED_EVENT_TYPE) {
      indexes.push(index);
    }
  });
  return indexes;
}

export function createSessionRuntime(
  deps: AuthRuntimeDeps &
    Readonly<{
      notificationOutbox?: NotificationOutbox;
      magicLinkDeliveryTokens?: MagicLinkDeliveryTokenStore;
    }>,
): SessionServices {
  const notificationOutbox = deps.notificationOutbox ?? createNoopNotificationOutbox();
  const magicLinkDeliveryTokens = deps.magicLinkDeliveryTokens ?? {
    getMagicLinkDeliveryToken: async () => null,
    clearMagicLinkDeliveryToken: async () => undefined,
  };
  const { commandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: createPassthroughDomainEventCodec<SessionEvent>(),
    initialState: () => initialSessionState,
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
    readAuthenticatedSession: async (sessionId) => {
      const loaded = await repository.load(toSessionStreamId(sessionId));
      if (!loaded.state.id) {
        return null;
      }

      return { state: loaded.state, authenticatedAt: resolveSessionAuthenticatedAt(loaded) };
    },
    projectors: [
      createProjectionHandlerSet({
        projectionName: "auth-session-projection",
        handlers: buildSessionProjectionHandlers(deps.db),
      }),
      createProjectionHandlerSet({
        projectionName: AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
        handlers: buildAuthSessionTransactionalEmailProjectionHandlers(
          notificationOutbox,
          magicLinkDeliveryTokens,
          AUTH_SESSION_TRANSACTIONAL_EMAIL_PROJECTION,
        ),
      }),
    ],
  };
}
