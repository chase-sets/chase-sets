import { isSyntheticAuthSessionId } from "@chase-sets/auth-context";
import { createAggregateCommandHandler } from "@chase-sets/event-core/aggregate-command-handler";
import type { AggregateRepository, LoadedAggregate } from "@chase-sets/event-core/aggregate-repository";
import { createPassthroughDomainEventCodec } from "@chase-sets/event-core/codec";
import type {
  CommandExecutionResult,
  CommandHandler,
  CommandHandlerInput,
} from "@chase-sets/event-core/command-handler";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { recordCommittedEvents } from "@chase-sets/event-core/consistency";
import type { EventStore } from "@chase-sets/event-core/event-store";
import type { ExpectedStreamVersion } from "@chase-sets/event-core/storage";
import { createProjectionHandlerSet, type ProjectionHandlerSet } from "@chase-sets/event-core/projector";
import { createNoopNotificationOutbox, type NotificationOutbox } from "@chase-sets/outbound-messaging";
import type { AuthRuntimeDeps } from "./runtime-deps";
import {
  decideSession,
  evolveSession,
  initialSessionState,
  type SessionCommand,
  type SessionCommandRequest,
  type SessionEvent,
  type SessionState,
  type StartSessionRequest,
} from "../domain/domain";
import { toSessionStreamId } from "../domain/auth-flow";
import {
  foldUserSessionAuthority,
  isCurrentSessionGeneration,
  toUserSessionAuthorityStreamId,
  USER_SESSION_AUTHORITY_MAX_EVENTS,
  type UserSessionAuthority,
} from "../domain/session-generation";
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
/**
 * The Session as actor resolution consumes it. `readAuthenticatedSession`
 * has already enforced its Session Generation before returning it, so the
 * generation is carried for display only and no consumer re-decides it.
 */
export type AuthenticatedSessionState = Omit<SessionState, "sessionGeneration"> &
  Readonly<{ sessionGeneration?: SessionState["sessionGeneration"] }>;

export type AuthenticatedSessionRead = Readonly<{
  state: AuthenticatedSessionState;
  authenticatedAt: string | null;
}>;

export type SessionServices = Readonly<{
  /**
   * The only way to write a Session. `StartSession` is completed by the
   * generation guard (`startGenerationGuardedSession`); lifecycle commands
   * run unchanged.
   */
  commandHandler: CommandHandler<SessionCommandRequest, SessionState, SessionEvent>;
  listSessions: (params?: Parameters<typeof listSessions>[1]) => ReturnType<typeof listSessions>;
  getSession: (sessionId: string) => ReturnType<typeof getSession>;
  getSessionState: (sessionId: string) => Promise<SessionState | null>;
  /**
   * Auth-internal companion to `getSessionState` for actor resolution, which
   * needs the session's authentication moment and must not invent one. It is
   * `null` for a synthetic actor handle, a stream that never started, and a
   * Session outside its User's current Session Generation. Seed
   * reconciliation and every other consumer keep using `getSessionState`.
   */
  readAuthenticatedSession: (sessionId: string) => Promise<AuthenticatedSessionRead | null>;
  /** One complete fold of the User's Session Authority; throws when it is unreadable. */
  readUserSessionAuthority: (userId: string) => Promise<UserSessionAuthority>;
  projectors: readonly ProjectionHandlerSet[];
}>;

/** A stale authority guard re-reads authority and retries this many times before refusing the start. */
const SESSION_START_GUARD_ATTEMPTS = 3;

export async function readUserSessionAuthority(
  eventStore: Pick<EventStore, "readStream">,
  userId: string,
): Promise<UserSessionAuthority> {
  const storedEvents = await readCompleteStream(eventStore, {
    streamId: toUserSessionAuthorityStreamId(userId),
    maxEvents: USER_SESSION_AUTHORITY_MAX_EVENTS,
  });
  return foldUserSessionAuthority(userId, storedEvents);
}

/**
 * Starts a Session in its User's current Session Generation. The authority
 * read participates in the start's own all-or-nothing append as a zero-event
 * version guard, so a Session can never commit in a generation that was
 * already superseded when it committed. A stale guard conflicts, nothing is
 * written, and the start re-reads authority and retries in the new
 * generation. No Session Token exists until this returns.
 */
async function startGenerationGuardedSession(
  deps: Readonly<{
    eventStore: EventStore;
    repository: AggregateRepository<SessionState, SessionEvent>;
  }>,
  input: CommandHandlerInput<StartSessionRequest>,
): Promise<CommandExecutionResult<SessionState, SessionEvent>> {
  const appendToStreams = deps.eventStore.appendToStreams?.bind(deps.eventStore);
  if (!appendToStreams) {
    throw new Error("Session start requires the atomic multi-stream append for its generation guard.");
  }

  for (let attempt = 1; ; attempt += 1) {
    const authority = await readUserSessionAuthority(deps.eventStore, input.command.userId);
    const loaded = await deps.repository.load(input.streamId);
    const command: SessionCommand = { ...input.command, sessionGeneration: authority.sessionGeneration };
    const newEvents = decideSession(loaded.state, command);
    try {
      const [, started] = await appendToStreams([
        {
          streamId: toUserSessionAuthorityStreamId(authority.userId),
          expectedVersion: expectedVersionOf(authority.version),
          context: input.context,
          events: [],
        },
        {
          streamId: input.streamId,
          expectedVersion: input.expectedVersion ?? expectedVersionOf(loaded.version),
          context: input.context,
          events: newEvents.map((event) => sessionEventCodec.encode(event)),
        },
      ]);
      const storedEvents = started?.storedEvents ?? [];
      recordCommittedEvents(storedEvents);
      return {
        state: newEvents.reduce(evolveSession, loaded.state),
        version: storedEvents.at(-1)?.streamVersion ?? loaded.version,
        newEvents,
        storedEvents,
      };
    } catch (error) {
      if (!isConcurrencyConflict(error) || attempt >= SESSION_START_GUARD_ATTEMPTS) {
        throw error;
      }
    }
  }
}

const sessionEventCodec = createPassthroughDomainEventCodec<SessionEvent>();

function expectedVersionOf(version: number): ExpectedStreamVersion {
  return version === 0 ? "no_stream" : version;
}

function isConcurrencyConflict(error: unknown) {
  return (error as { code?: unknown } | null)?.code === "concurrency_conflict";
}

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
  const { commandHandler: lifecycleCommandHandler, repository } = createAggregateCommandHandler({
    eventStore: deps.eventStore,
    codec: sessionEventCodec,
    initialState: () => initialSessionState,
    evolve: evolveSession,
    decide: decideSession,
  });

  return {
    commandHandler: (input) =>
      input.command.type === "StartSession"
        ? startGenerationGuardedSession(
            { eventStore: deps.eventStore, repository },
            { ...input, command: input.command },
          )
        : lifecycleCommandHandler({ ...input, command: input.command }),
    listSessions: (params) => listSessions(deps.db, params),
    getSession: (sessionId) => getSession(deps.db, sessionId),
    getSessionState: async (sessionId) => {
      const loaded = await repository.load(toSessionStreamId(sessionId));
      return loaded.state.id ? loaded.state : null;
    },
    readAuthenticatedSession: async (sessionId) => {
      if (isSyntheticAuthSessionId(sessionId)) {
        return null;
      }
      const loaded = await repository.load(toSessionStreamId(sessionId));
      if (!loaded.state.id || !loaded.state.userId) {
        return null;
      }
      const authority = await readUserSessionAuthority(deps.eventStore, loaded.state.userId);
      if (!isCurrentSessionGeneration(loaded.state.sessionGeneration, authority)) {
        return null;
      }

      return { state: loaded.state, authenticatedAt: resolveSessionAuthenticatedAt(loaded) };
    },
    readUserSessionAuthority: (userId) => readUserSessionAuthority(deps.eventStore, userId),
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
