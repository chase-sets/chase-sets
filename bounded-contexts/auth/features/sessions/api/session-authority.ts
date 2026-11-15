import { isSyntheticAuthSessionId } from "@chase-sets/auth-context";
import { ConfigurationEpochError, type ConfigurationConsumer } from "@chase-sets/event-core/configuration-epoch";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import {
  CONFIGURATION_EPOCH_LOCK_SQL,
  withConfigurationEpochTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { toSessionStreamId } from "../domain/auth-flow";
import {
  foldUserSessionAuthority,
  isCurrentSessionGeneration,
  sessionGenerationOf,
  toUserSessionAuthorityStreamId,
} from "../domain/session-generation";
import type { AuthSessionEpochs } from "./owner-epochs";

export type SessionAuthorityInput = Readonly<{
  sessionId: string;
  userId: string;
  tenantId: string;
  tokenHash: string;
  consumer: ConfigurationConsumer;
}>;

export function sessionExpiry(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new ConfigurationEpochError("invalid UTC Session expiry");
  return new Date(value).toISOString();
}

/** A complete canonical fold, never identity_sessions or an aggregate snapshot. */
export function foldSessionAuthority(
  history: readonly StoredEvent[],
  input: Pick<SessionAuthorityInput, "sessionId" | "userId" | "tenantId">,
) {
  const first = history[0];
  if (
    !first ||
    first.eventType !== "auth.session.started" ||
    first.payload.sessionId !== input.sessionId ||
    first.payload.userId !== input.userId ||
    typeof first.payload.accountId !== "string" ||
    !Array.isArray(first.payload.availableAccountIds) ||
    !first.payload.availableAccountIds.every((id) => typeof id === "string") ||
    typeof first.payload.authenticationMethod !== "string"
  )
    throw new ConfigurationEpochError("foreign or malformed Session creation");
  const expiresAt = sessionExpiry(first.payload.expiresAt);
  let status = "active";
  for (const [index, event] of history.entries()) {
    if (
      event.streamId !== toSessionStreamId(input.sessionId) ||
      event.streamVersion !== index + 1 ||
      event.tenantId !== input.tenantId
    )
      throw new ConfigurationEpochError("partial or foreign Session history");
    if (!index) continue;
    if (status !== "active") throw new ConfigurationEpochError("Session event after termination");
    if (event.eventType === "auth.session.account-switched" && typeof event.payload.accountId === "string") continue;
    if (event.eventType === "auth.session.revoked" || event.eventType === "auth.session.expired") {
      if (Object.keys(event.payload).length) throw new ConfigurationEpochError("malformed Session termination");
      status = event.eventType === "auth.session.revoked" ? "revoked" : "expired";
    } else throw new ConfigurationEpochError("unknown Session event");
  }
  return { status, expiresAt, sessionGeneration: sessionGenerationOf(first.payload), version: history.length };
}

export function createAuthSessionAuthority(
  pool: PgTransactionalPool,
  store: PostgresEventStore,
  epochs: AuthSessionEpochs,
) {
  return {
    async registerConsumer(input: Pick<SessionAuthorityInput, "sessionId" | "consumer">) {
      await (await epochs.source()).registerConsumer(`session/${input.sessionId}`, input.consumer);
    },
    async capture(input: SessionAuthorityInput) {
      try {
        if (!input.sessionId || !input.userId || !input.tokenHash || isSyntheticAuthSessionId(input.sessionId))
          throw new ConfigurationEpochError("unauthenticated Session");
        const source = await epochs.source();
        return await withConfigurationEpochTransaction(pool, async (db: PgQueryable) => {
          const key = `session/${input.sessionId}`;
          await db.query(CONFIGURATION_EPOCH_LOCK_SQL, [key]);
          const readStream = (request: Parameters<PostgresEventStore["readStream"]>[0]) =>
            store.readStreamInTransaction(db, request);
          const history = await readCompleteStream(
            { readStream },
            { streamId: toSessionStreamId(input.sessionId), maxEvents: 10000 },
          );
          const state = foldSessionAuthority(history, input);
          const heads = await db.query<{ current_version: number }>(
            "SELECT current_version FROM event_store_streams WHERE stream_id = $1",
            [toSessionStreamId(input.sessionId)],
          );
          if (Number(heads.rows[0]?.current_version) !== state.version || state.status !== "active")
            throw new ConfigurationEpochError("Session is not active or complete");
          const generation = foldUserSessionAuthority(
            input.userId,
            await readCompleteStream(
              { readStream },
              { streamId: toUserSessionAuthorityStreamId(input.userId), maxEvents: 10000 },
            ),
          );
          if (!isCurrentSessionGeneration(state.sessionGeneration, generation))
            throw new ConfigurationEpochError("superseded Session");
          const tokens = await db.query<{ revision: string; expires_at: Date | string }>(
            "SELECT revision::text, expires_at FROM identity_session_tokens WHERE session_id = $1 AND token_hash = $2",
            [input.sessionId, input.tokenHash],
          );
          const token = tokens.rows[0];
          if (tokens.rows.length !== 1 || !token || !/^[1-9]\d*$/.test(token.revision))
            throw new ConfigurationEpochError("Session Token unavailable");
          const expiresAt = new Date(
            Math.min(Date.parse(state.expiresAt), new Date(token.expires_at).getTime()),
          ).toISOString();
          const validity = await db.query<{ valid: boolean }>("SELECT clock_timestamp() < $1::timestamptz AS valid", [
            expiresAt,
          ]);
          if (validity.rows[0]?.valid !== true) throw new ConfigurationEpochError("Session expired");
          const grant = await source.captureGrantInTransaction(db, key, input.consumer, expiresAt);
          return {
            kind: "granted" as const,
            sessionId: input.sessionId,
            userId: input.userId,
            sessionRevision: state.version,
            tokenRevision: token.revision,
            expiresAt,
            seal: { version: state.version, storeIncarnation: grant.sourceIncarnation },
            grant,
          };
        });
      } catch {
        return { kind: "denied" as const, reason: "session-authority-unavailable" as const };
      }
    },
  };
}
