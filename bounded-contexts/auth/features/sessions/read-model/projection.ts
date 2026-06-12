import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import { transitionStatus, updateRow, upsertRow, type PgQueryable } from "@chase-sets/event-core-postgres";
import { AUTH_SESSION_STREAM_PREFIX } from "../domain/auth-flow";

export function buildSessionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "auth.session.started": async (event) => {
      const { sessionId, userId, accountId, availableAccountIds, authenticationMethod, expiresAt } =
        event.data as unknown as {
          sessionId: string;
          userId: string;
          accountId: string;
          availableAccountIds: string[];
          authenticationMethod: string;
          expiresAt: string;
        };
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
          updated_at: event.timing.recordedAt,
        },
        casts: { available_account_ids: "jsonb" },
      });
    },
    "auth.session.account-switched": async (event) => {
      const sessionId = extractIdFromStreamId(event.streamId, AUTH_SESSION_STREAM_PREFIX);
      const { accountId } = event.data as { accountId: string };
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
  };
}
