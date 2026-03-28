import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "../projection-support/extract-id-from-stream";

const STREAM_PREFIX = "identity.account-";

export function buildAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, name, displayName, accountType } = event.data as {
        accountId: string;
        name: string;
        displayName: string;
        accountType: string;
      };
      await db.query(
        `INSERT INTO identity_accounts (
           account_id,
           name,
           display_name,
           account_type,
           status,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'active', $5)
         ON CONFLICT (account_id) DO UPDATE
         SET name = $2,
             display_name = $3,
             account_type = $4,
             status = 'active',
             updated_at = $5`,
        [accountId, name, displayName, accountType, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { name, displayName } = event.data as {
        name: string;
        displayName: string;
      };
      await db.query(
        `UPDATE identity_accounts
         SET name = $2,
             display_name = $3,
             updated_at = $4
         WHERE account_id = $1`,
        [accountId, name, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_accounts
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_accounts
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_accounts
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
  };
}
