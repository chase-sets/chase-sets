import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

export function buildCommercialTermsAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const data = event.data as {
        accountId: string;
        name: string;
        displayName: string;
        accountType: string;
      };

      await db.query(
        `INSERT INTO commercial_terms_account_pages (
           account_id,
           name,
           display_name,
           account_type,
           status,
           updated_at
         ) VALUES ($1, $2, $3, $4, 'active', $5)
         ON CONFLICT (account_id) DO UPDATE
         SET name = EXCLUDED.name,
             display_name = EXCLUDED.display_name,
             account_type = EXCLUDED.account_type,
             status = EXCLUDED.status,
             updated_at = EXCLUDED.updated_at`,
        [data.accountId, data.name, data.displayName, data.accountType, event.timing.recordedAt],
      );
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = event.streamId.replace("identity.account-", "");
      const data = event.data as {
        name: string;
        displayName: string;
      };

      await db.query(
        `UPDATE commercial_terms_account_pages
         SET name = $2,
             display_name = $3,
             updated_at = $4
         WHERE account_id = $1`,
        [accountId, data.name, data.displayName, event.timing.recordedAt],
      );
    },
    "identity.account.founders-window-opened": async (event) => {
      const accountId = event.streamId.replace("identity.account-", "");
      const data = event.data as { betaAccessStartedAt: string; foundersWindowEndsAt: string };
      await db.query(
        `UPDATE commercial_terms_account_pages
         SET founders_window_started_at = $2,
             founders_window_ends_at = $3,
             updated_at = $4
         WHERE account_id = $1`,
        [accountId, data.betaAccessStartedAt, data.foundersWindowEndsAt, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      const accountId = event.streamId.replace("identity.account-", "");
      await db.query(
        `UPDATE commercial_terms_account_pages
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      const accountId = event.streamId.replace("identity.account-", "");
      await db.query(
        `UPDATE commercial_terms_account_pages
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      const accountId = event.streamId.replace("identity.account-", "");
      await db.query(
        `UPDATE commercial_terms_account_pages
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
  };
}
