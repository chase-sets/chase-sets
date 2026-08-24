import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  accountEnforcementReasonCodes,
  accountEnforcementReversalReasonCodes,
  extractIdFromStreamId,
} from "@chase-sets/event-core";
import { accountBadgeKeys, parseAccountEnforcementEventData, type AccountBadgeKey } from "../domain/domain";

const STREAM_PREFIX = "identity.account-";

function readAccountBadgeKeys(value: unknown): AccountBadgeKey[] {
  const values = Array.isArray(value) ? value : [];
  return values.filter(
    (badgeKey): badgeKey is AccountBadgeKey =>
      typeof badgeKey === "string" && accountBadgeKeys.includes(badgeKey as AccountBadgeKey),
  );
}

function addAccountBadge(badges: readonly AccountBadgeKey[], badgeKey: AccountBadgeKey) {
  return [...new Set([...badges, badgeKey])].sort((left, right) => left.localeCompare(right));
}

async function updateAccountBadges(
  db: PgQueryable,
  params: Readonly<{
    accountId: string;
    recordedAt: string;
    update: (badges: readonly AccountBadgeKey[]) => readonly AccountBadgeKey[];
  }>,
) {
  const result = await db.query<{ badges: unknown }>(`SELECT badges FROM identity_accounts WHERE account_id = $1`, [
    params.accountId,
  ]);
  const current = readAccountBadgeKeys(result.rows[0]?.badges);
  await db.query(
    `UPDATE identity_accounts
     SET badges = $2::jsonb,
         updated_at = $3
     WHERE account_id = $1`,
    [params.accountId, JSON.stringify(params.update(current)), params.recordedAt],
  );
}

function accountEnforcementProjectionValues<Reason extends string>(
  event: Readonly<{
    streamId: string;
    data: unknown;
    globalPosition: string;
    timing: Readonly<{ recordedAt: string }>;
  }>,
  allowedReasons: readonly Reason[],
) {
  const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
  const enforcement = parseAccountEnforcementEventData(event.data, allowedReasons);
  return [
    accountId,
    enforcement !== null,
    enforcement?.enforcementActionId ?? null,
    enforcement?.reason ?? null,
    enforcement?.reference === null || enforcement === null ? null : JSON.stringify(enforcement.reference),
    event.timing.recordedAt,
    event.globalPosition,
  ] as const;
}

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
           badges,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'active', '[]'::jsonb, $5)
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
      await db.query(
        `UPDATE identity_accounts
         SET status = 'suspended',
             last_enforcement_action_id = CASE WHEN $2::boolean THEN $3 ELSE last_enforcement_action_id END,
             last_enforcement_reason = CASE WHEN $2::boolean THEN $4 ELSE last_enforcement_reason END,
             last_enforcement_reference = CASE WHEN $2::boolean THEN $5::jsonb ELSE last_enforcement_reference END,
             last_enforcement_at = CASE WHEN $2::boolean THEN $6::timestamptz ELSE last_enforcement_at END,
             last_global_position = $7::bigint,
             updated_at = $6
         WHERE account_id = $1
           AND (last_global_position IS NULL OR last_global_position < $7::bigint)`,
        accountEnforcementProjectionValues(event, accountEnforcementReasonCodes),
      );
    },
    "identity.account.reactivated": async (event) => {
      await db.query(
        `UPDATE identity_accounts
         SET status = 'active',
             last_enforcement_action_id = CASE WHEN $2::boolean THEN $3 ELSE last_enforcement_action_id END,
             last_enforcement_reason = CASE WHEN $2::boolean THEN $4 ELSE last_enforcement_reason END,
             last_enforcement_reference = CASE WHEN $2::boolean THEN $5::jsonb ELSE last_enforcement_reference END,
             last_enforcement_at = CASE WHEN $2::boolean THEN $6::timestamptz ELSE last_enforcement_at END,
             last_global_position = $7::bigint,
             updated_at = $6
         WHERE account_id = $1
           AND (last_global_position IS NULL OR last_global_position < $7::bigint)`,
        accountEnforcementProjectionValues(event, accountEnforcementReversalReasonCodes),
      );
    },
    "identity.account.closed": async (event) => {
      await db.query(
        `UPDATE identity_accounts
         SET status = 'closed',
             last_enforcement_action_id = CASE WHEN $2::boolean THEN $3 ELSE last_enforcement_action_id END,
             last_enforcement_reason = CASE WHEN $2::boolean THEN $4 ELSE last_enforcement_reason END,
             last_enforcement_reference = CASE WHEN $2::boolean THEN $5::jsonb ELSE last_enforcement_reference END,
             last_enforcement_at = CASE WHEN $2::boolean THEN $6::timestamptz ELSE last_enforcement_at END,
             last_global_position = $7::bigint,
             updated_at = $6
         WHERE account_id = $1
           AND (last_global_position IS NULL OR last_global_position < $7::bigint)`,
        accountEnforcementProjectionValues(event, accountEnforcementReasonCodes),
      );
    },
    "identity.account.founders-window-opened": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const data = event.data as { betaAccessStartedAt: string; foundersWindowEndsAt: string };
      await db.query(
        `UPDATE identity_accounts
         SET founders_window_started_at = $2,
             founders_window_ends_at = $3,
             updated_at = $4
         WHERE account_id = $1`,
        [accountId, data.betaAccessStartedAt, data.foundersWindowEndsAt, event.timing.recordedAt],
      );
    },
    "identity.account.badge-assigned": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { badgeKey, founderNumber } = event.data as { badgeKey: AccountBadgeKey; founderNumber?: number };
      await updateAccountBadges(db, {
        accountId,
        recordedAt: event.timing.recordedAt,
        update: (badges) => addAccountBadge(badges, badgeKey),
      });
      if (badgeKey === "founding-account" && founderNumber !== undefined) {
        await db.query(`UPDATE identity_accounts SET founder_number = $2 WHERE account_id = $1`, [
          accountId,
          founderNumber,
        ]);
      }
    },
    "identity.account.badge-removed": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { badgeKey } = event.data as { badgeKey: AccountBadgeKey };
      await updateAccountBadges(db, {
        accountId,
        recordedAt: event.timing.recordedAt,
        update: (badges) => badges.filter((assignedBadgeKey) => assignedBadgeKey !== badgeKey),
      });
      if (badgeKey === "founding-account") {
        await db.query(`UPDATE identity_accounts SET founder_number = NULL WHERE account_id = $1`, [accountId]);
      }
    },
  };
}
