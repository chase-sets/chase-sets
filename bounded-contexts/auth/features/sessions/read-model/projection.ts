import type { ChaseSetsEventPayloads } from "@chase-sets/event-core";
import { defineProjectorHandlers, type ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { transitionStatus, updateRow, upsertRow, type PgQueryable } from "@chase-sets/event-core-postgres";
import { AUTH_SESSION_STREAM_PREFIX } from "../domain/auth-flow";

export function buildSessionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return defineProjectorHandlers<
    Pick<
      ChaseSetsEventPayloads,
      "auth.session.started" | "auth.session.account-switched" | "auth.session.revoked" | "auth.session.expired"
    >
  >({
    "auth.session.started": async (event) => {
      const { sessionId, userId, accountId, availableAccountIds, authenticationMethod, expiresAt } = event.data;
      await upsertRow(db, {
        table: "identity_sessions",
        insertColumns: [
          "session_id",
          "user_id",
          "account_id",
          "available_account_ids",
          "authentication_method",
          "status",
          "expires_at",
          "started_at",
          "updated_at",
        ],
        conflictColumns: ["session_id"],
        values: {
          session_id: sessionId,
          user_id: userId,
          account_id: accountId,
          available_account_ids: availableAccountIds,
          authentication_method: authenticationMethod,
          status: "active",
          expires_at: expiresAt,
          // Recorded only here, from the session's own started event, and
          // deliberately absent from every other handler's setColumns below
          // so account-switch/revoke/expire never overwrite it. A replay of
          // this same started event is idempotent (same recordedAt).
          started_at: event.timing.recordedAt,
          updated_at: event.timing.recordedAt,
        },
        casts: { available_account_ids: "jsonb" },
      });
    },
    "auth.session.account-switched": async (event) => {
      const sessionId = extractIdFromStreamId(event.streamId, AUTH_SESSION_STREAM_PREFIX);
      const { accountId } = event.data;
      const values = {
        account_id: accountId,
        updated_at: event.timing.recordedAt,
      };
      const where = {
        columns: ["session_id"],
        values: { session_id: sessionId },
      } as const;

      await updateRow(db, {
        table: "identity_sessions",
        setColumns: ["account_id", "updated_at"],
        values,
        where,
      });
      await updateRow(db, {
        table: "identity_session_lookup",
        setColumns: ["account_id", "updated_at"],
        values,
        where,
      });
    },
    "auth.session.revoked": async (event) => {
      const sessionId = extractIdFromStreamId(event.streamId, AUTH_SESSION_STREAM_PREFIX);
      await transitionStatus(db, {
        table: "identity_sessions",
        idColumn: "session_id",
        id: sessionId,
        status: "revoked",
        updatedAt: event.timing.recordedAt,
      });
      await transitionStatus(db, {
        table: "identity_session_lookup",
        idColumn: "session_id",
        id: sessionId,
        status: "revoked",
        updatedAt: event.timing.recordedAt,
      });
    },
    "auth.session.expired": async (event) => {
      const sessionId = extractIdFromStreamId(event.streamId, AUTH_SESSION_STREAM_PREFIX);
      await transitionStatus(db, {
        table: "identity_sessions",
        idColumn: "session_id",
        id: sessionId,
        status: "expired",
        updatedAt: event.timing.recordedAt,
      });
      await transitionStatus(db, {
        table: "identity_session_lookup",
        idColumn: "session_id",
        id: sessionId,
        status: "expired",
        updatedAt: event.timing.recordedAt,
      });
    },
  });
}
