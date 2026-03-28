import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "../projection-support/extract-id-from-stream";

const STREAM_PREFIX = "identity.session-";

export function buildSessionProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.session.started": async (event) => {
      const {
        sessionId,
        userId,
        accountId,
        availableAccountIds,
        authenticationMethod,
        expiresAt,
      } = event.data as unknown as {
        sessionId: string;
        userId: string;
        accountId: string;
        availableAccountIds: string[];
        authenticationMethod: string;
        expiresAt: string;
      };
      await db.query(
        `INSERT INTO identity_sessions (
           session_id,
           user_id,
           account_id,
           available_account_ids,
           authentication_method,
           status,
           expires_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4::jsonb, $5, 'active', $6, $7)
         ON CONFLICT (session_id) DO UPDATE
         SET user_id = $2,
             account_id = $3,
             available_account_ids = $4::jsonb,
             authentication_method = $5,
             status = 'active',
             expires_at = $6,
             updated_at = $7`,
        [
          sessionId,
          userId,
          accountId,
          JSON.stringify(availableAccountIds),
          authenticationMethod,
          expiresAt,
          event.timing.recordedAt,
        ],
      );
    },
    "identity.session.account-switched": async (event) => {
      const sessionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_sessions
         SET account_id = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [
          sessionId,
          (event.data as { accountId: string }).accountId,
          event.timing.recordedAt,
        ],
      );
      await db.query(
        `UPDATE identity_session_lookup
         SET account_id = $2,
             updated_at = $3
         WHERE session_id = $1`,
        [
          sessionId,
          (event.data as { accountId: string }).accountId,
          event.timing.recordedAt,
        ],
      );
    },
    "identity.session.revoked": async (event) => {
      const sessionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_sessions
         SET status = 'revoked',
             updated_at = $2
         WHERE session_id = $1`,
        [sessionId, event.timing.recordedAt],
      );
      await db.query(
        `UPDATE identity_session_lookup
         SET status = 'revoked',
             updated_at = $2
         WHERE session_id = $1`,
        [sessionId, event.timing.recordedAt],
      );
    },
    "identity.session.expired": async (event) => {
      const sessionId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_sessions
         SET status = 'expired',
             updated_at = $2
         WHERE session_id = $1`,
        [sessionId, event.timing.recordedAt],
      );
      await db.query(
        `UPDATE identity_session_lookup
         SET status = 'expired',
             updated_at = $2
         WHERE session_id = $1`,
        [sessionId, event.timing.recordedAt],
      );
    },
  };
}
