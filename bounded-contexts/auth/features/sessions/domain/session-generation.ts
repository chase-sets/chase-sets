import type { StoredEvent } from "@chase-sets/event-core/storage";

/**
 * Version of the Session Generation compatibility floor this code enforces:
 * every Session start is atomically guarded against its User's Session
 * Authority, and actor resolution rejects a Session whose generation is not
 * the authority's. Each serving pod reports this value from its own code in
 * the floor receipt (`scripts/agent-grant-revocation-release.mjs`), so the
 * capability is never inferred from a planned rollout or another feature's
 * support version.
 */
export const SESSION_GENERATION_CAPABILITY_VERSION = 1;

/** The schema ledger entry that adds `identity_sessions.session_generation`. */
export const SESSION_GENERATION_SCHEMA_MIGRATION_ID = "20261102_auth_session_generation";

export const USER_SESSION_AUTHORITY_STREAM_PREFIX = "auth.user-session-authority-";

/**
 * The only event a User Session Authority stream may hold. No command in this
 * code appends it; a later slice that advances authority must append exactly
 * this shape so every reader at or above this floor folds it.
 */
export const SESSION_GENERATION_ADVANCED_EVENT_TYPE = "auth.user-session-authority.generation-advanced";

/**
 * Complete-fold bound. A longer history refuses rather than authenticating
 * from a capped prefix.
 */
export const USER_SESSION_AUTHORITY_MAX_EVENTS = 10_000;

export type UserSessionAuthority = Readonly<{
  userId: string;
  /** Monotonic; 0 for a User whose authority stream has no events. */
  sessionGeneration: number;
  /** Stream version the fold read; the start guard expects exactly this. */
  version: number;
}>;

export type UserSessionAuthorityUnreadableReason =
  | "foreign-event"
  | "unknown-event"
  | "malformed-generation"
  | "non-monotonic-generation";

export class UserSessionAuthorityUnreadableError extends Error {
  public readonly reason: UserSessionAuthorityUnreadableReason;

  public constructor(reason: UserSessionAuthorityUnreadableReason) {
    super(`User Session Authority is unreadable: ${reason}.`);
    this.name = "UserSessionAuthorityUnreadableError";
    this.reason = reason;
  }
}

export function toUserSessionAuthorityStreamId(userId: string) {
  return `${USER_SESSION_AUTHORITY_STREAM_PREFIX}${userId}`;
}

/**
 * Folds one User's complete authority history. An empty history is
 * generation 0, which is how every User without an authority stream keeps
 * authenticating unchanged. Anything the fold cannot attribute to exactly this
 * User's monotonic generation throws, so no caller can start or resolve a
 * Session from an ambiguous authority.
 */
export function foldUserSessionAuthority(userId: string, storedEvents: readonly StoredEvent[]): UserSessionAuthority {
  const streamId = toUserSessionAuthorityStreamId(userId);
  let sessionGeneration = 0;

  for (const storedEvent of storedEvents) {
    if (storedEvent.streamId !== streamId) {
      throw new UserSessionAuthorityUnreadableError("foreign-event");
    }
    if (storedEvent.eventType !== SESSION_GENERATION_ADVANCED_EVENT_TYPE) {
      throw new UserSessionAuthorityUnreadableError("unknown-event");
    }
    if (storedEvent.payload.userId !== userId) {
      throw new UserSessionAuthorityUnreadableError("foreign-event");
    }
    const advancedTo = storedEvent.payload.sessionGeneration;
    if (!isSessionGeneration(advancedTo)) {
      throw new UserSessionAuthorityUnreadableError("malformed-generation");
    }
    if (advancedTo <= sessionGeneration) {
      throw new UserSessionAuthorityUnreadableError("non-monotonic-generation");
    }
    sessionGeneration = advancedTo;
  }

  return { userId, sessionGeneration, version: storedEvents.at(-1)?.streamVersion ?? 0 };
}

export function isSessionGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The generation a Session started in. A start event recorded before this
 * floor has no field and is generation 0; a present but malformed value is
 * `null`, which no authority accepts.
 */
export function sessionGenerationOf(startedData: Readonly<{ sessionGeneration?: unknown }>): number | null {
  if (!("sessionGeneration" in startedData) || startedData.sessionGeneration === undefined) {
    return 0;
  }
  return isSessionGeneration(startedData.sessionGeneration) ? startedData.sessionGeneration : null;
}

/**
 * A Session is current only in its User's authority generation. An older
 * generation was superseded; a newer one cannot have been committed under the
 * start guard, so it is treated as ambiguous rather than trusted.
 */
export function isCurrentSessionGeneration(
  sessionGeneration: number | null,
  authority: Pick<UserSessionAuthority, "sessionGeneration">,
) {
  return sessionGeneration !== null && sessionGeneration === authority.sessionGeneration;
}

export type SessionGenerationCapabilityReport = Readonly<{
  schemaVersion: "auth-session-generation-capability/v1";
  capabilityVersion: number;
  commit: string | null;
  release: string | null;
  schemaLedger: readonly string[];
}>;

/**
 * What one pod reports for the floor receipt: this code's capability version
 * and Auth schema ledger, plus the deployment identity its environment
 * carries. The receipt validates every field; this only composes them.
 */
export function sessionGenerationCapabilityReport(
  input: Readonly<{
    implementationSha: string | undefined;
    deploymentInstance: string | undefined;
    schemaMigrationIds: readonly string[];
  }>,
): SessionGenerationCapabilityReport {
  return {
    schemaVersion: "auth-session-generation-capability/v1",
    capabilityVersion: SESSION_GENERATION_CAPABILITY_VERSION,
    commit: input.implementationSha || null,
    release: input.deploymentInstance || null,
    schemaLedger: [...input.schemaMigrationIds],
  };
}
