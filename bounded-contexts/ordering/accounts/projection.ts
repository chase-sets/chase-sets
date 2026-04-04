import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const ACCOUNT_STREAM_PREFIX = "identity.account-";

function extractAccountId(streamId: string) {
  if (!streamId.startsWith(ACCOUNT_STREAM_PREFIX)) {
    throw new Error(`Stream ID "${streamId}" does not start with "${ACCOUNT_STREAM_PREFIX}".`);
  }

  return streamId.slice(ACCOUNT_STREAM_PREFIX.length);
}

export function buildOrderingAccountProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, displayName } = event.data as {
        accountId: string;
        displayName: string;
      };

      await db.query(
        `INSERT INTO ordering_account_pages (
           account_id,
           display_name,
           status,
           updated_at
         ) VALUES ($1, $2, 'active', $3)
         ON CONFLICT (account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at`,
        [accountId, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const { displayName } = event.data as { displayName: string };
      await db.query(
        `INSERT INTO ordering_account_pages (
           account_id,
           display_name,
           updated_at
         ) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
         SET display_name = EXCLUDED.display_name,
             updated_at = EXCLUDED.updated_at`,
        [extractAccountId(event.streamId), displayName, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      await db.query(
        `UPDATE ordering_account_pages
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [extractAccountId(event.streamId), event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE ordering_account_pages
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [extractAccountId(event.streamId), event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE ordering_account_pages
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [extractAccountId(event.streamId), event.timing.recordedAt],
      );
    },
  };
}
