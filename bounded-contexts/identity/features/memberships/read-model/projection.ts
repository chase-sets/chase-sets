import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { ROLE_PERMISSIONS } from "./constants";
import { extractIdFromStreamId } from "../../../support/read-model-support/extract-id-from-stream";

const STREAM_PREFIX = "identity.membership-";

async function upsertMembershipMirror(
  db: PgQueryable,
  membershipId: string,
  userId: string,
  accountId: string,
  roleKey: string,
  status: string,
  updatedAt: string,
) {
  await db.query(
    `INSERT INTO identity_user_memberships (
       membership_id,
       user_id,
       account_id,
       role_key,
       status,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (membership_id) DO UPDATE
     SET user_id = $2,
         account_id = $3,
         role_key = $4,
         status = $5,
         updated_at = $6`,
    [membershipId, userId, accountId, roleKey, status, updatedAt],
  );
}

export function buildMembershipProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "identity.membership.granted": async (event) => {
      const { membershipId, userId, accountId, roleKey } = event.data as {
        membershipId: string;
        userId: string;
        accountId: string;
        roleKey: keyof typeof ROLE_PERMISSIONS;
      };
      await db.query(
        `INSERT INTO identity_memberships (
           membership_id,
           user_id,
           account_id,
           role_key,
           role_permissions,
           status,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5::jsonb, 'active', $6)
         ON CONFLICT (membership_id) DO UPDATE
         SET user_id = $2,
             account_id = $3,
             role_key = $4,
             role_permissions = $5::jsonb,
             status = 'active',
             updated_at = $6`,
        [
          membershipId,
          userId,
          accountId,
          roleKey,
          JSON.stringify(ROLE_PERMISSIONS[roleKey]),
          event.timing.recordedAt,
        ],
      );
      await upsertMembershipMirror(
        db,
        membershipId,
        userId,
        accountId,
        roleKey,
        "active",
        event.timing.recordedAt,
      );
    },
    "identity.membership.role-changed": async (event) => {
      const membershipId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const roleKey = (event.data as { roleKey: keyof typeof ROLE_PERMISSIONS }).roleKey;
      const existing = await db.query<{ user_id: string; account_id: string; status: string }>(
        `SELECT user_id, account_id, status
         FROM identity_memberships
         WHERE membership_id = $1`,
        [membershipId],
      );
      const row = existing.rows[0];
      await db.query(
        `UPDATE identity_memberships
         SET role_key = $2,
             role_permissions = $3::jsonb,
             updated_at = $4
         WHERE membership_id = $1`,
        [
          membershipId,
          roleKey,
          JSON.stringify(ROLE_PERMISSIONS[roleKey]),
          event.timing.recordedAt,
        ],
      );
      if (row) {
        await upsertMembershipMirror(
          db,
          membershipId,
          row.user_id,
          row.account_id,
          roleKey,
          row.status,
          event.timing.recordedAt,
        );
      }
    },
    "identity.membership.revoked": async (event) => {
      const membershipId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const existing = await db.query<{ user_id: string; account_id: string; role_key: string }>(
        `SELECT user_id, account_id, role_key
         FROM identity_memberships
         WHERE membership_id = $1`,
        [membershipId],
      );
      await db.query(
        `UPDATE identity_memberships
         SET status = 'revoked',
             updated_at = $2
         WHERE membership_id = $1`,
        [membershipId, event.timing.recordedAt],
      );
      const row = existing.rows[0];
      if (row) {
        await upsertMembershipMirror(
          db,
          membershipId,
          row.user_id,
          row.account_id,
          row.role_key,
          "revoked",
          event.timing.recordedAt,
        );
      }
    },
    "identity.membership.reinstated": async (event) => {
      const membershipId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const existing = await db.query<{ user_id: string; account_id: string; role_key: string }>(
        `SELECT user_id, account_id, role_key
         FROM identity_memberships
         WHERE membership_id = $1`,
        [membershipId],
      );
      await db.query(
        `UPDATE identity_memberships
         SET status = 'active',
             updated_at = $2
         WHERE membership_id = $1`,
        [membershipId, event.timing.recordedAt],
      );
      const row = existing.rows[0];
      if (row) {
        await upsertMembershipMirror(
          db,
          membershipId,
          row.user_id,
          row.account_id,
          row.role_key,
          "active",
          event.timing.recordedAt,
        );
      }
    },
  };
}
