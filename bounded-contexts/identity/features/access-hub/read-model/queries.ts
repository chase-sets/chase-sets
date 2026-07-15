import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { getAccount, listAccounts } from "../../accounts/read-model/queries";
import type { AccountRow } from "../../accounts/read-model/queries";
import type { ApiKeyRow } from "../../api-keys/read-model/queries";
import type { InvitationRow } from "../../invitations/read-model/queries";
import type { MembershipRow } from "../../memberships/read-model/queries";
import type { User } from "../../users/ui/contracts";
import type {
  AccessHome,
  AccountAccessHub,
  AccountAuditEvent,
  ApiKeyRotationAttention,
  UserAccountLink,
} from "../api/contracts";

const attentionLimit = 25;
const apiKeyRotationIntervalDays = 90;
const apiKeyRotationWarningDays = 14;

export type AccessHomeQuery = Readonly<{
  search?: string;
  scopeAccountId?: string | null;
  includeMemberships?: boolean;
  includeApiKeys?: boolean;
  now?: Date;
}>;

function scopedAccountCondition(scopeAccountId: string | null | undefined, column: string, values: unknown[]) {
  if (!scopeAccountId) {
    return "";
  }

  values.push(scopeAccountId);
  return ` AND ${column} = $${values.length}`;
}

async function listScopedAccounts(db: PgQueryable, params: Pick<AccessHomeQuery, "search" | "scopeAccountId">) {
  if (!params.scopeAccountId) {
    return listAccounts(db, { search: params.search, limit: 25, offset: 0 });
  }

  const account = await getAccount(db, params.scopeAccountId);
  const search = params.search?.trim().toLocaleLowerCase("en-US") ?? "";
  const matches =
    account &&
    (!search ||
      account.name.toLocaleLowerCase("en-US").includes(search) ||
      account.display_name.toLocaleLowerCase("en-US").includes(search));
  const items = matches && account ? [account] : [];
  return { items, total: items.length };
}

async function listPendingInvitations(db: PgQueryable, scopeAccountId?: string | null) {
  const values: unknown[] = [];
  const scope = scopedAccountCondition(scopeAccountId, "invitations.account_id", values);
  values.push(attentionLimit);
  const result = await db.query<InvitationRow>(
    `SELECT invitations.invitation_id,
            invitations.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            invitations.email,
            invitations.role_key,
            invitations.status,
            invitations.expires_at,
            invitations.accepted_by_user_id,
            accepted_users.display_name AS accepted_by_user_display_name,
            accepted_users.primary_email AS accepted_by_user_primary_email,
            invitations.updated_at
     FROM identity_invitations AS invitations
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = invitations.account_id
     LEFT JOIN identity_users AS accepted_users ON accepted_users.user_id = invitations.accepted_by_user_id
     WHERE invitations.status = 'pending'${scope}
     ORDER BY invitations.expires_at ASC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

async function listSuspendedAccounts(db: PgQueryable, scopeAccountId?: string | null) {
  const values: unknown[] = [];
  const scope = scopedAccountCondition(scopeAccountId, "account_id", values);
  values.push(attentionLimit);
  const result = await db.query<AccountRow>(
    `SELECT *
     FROM identity_accounts
     WHERE status = 'suspended'${scope}
     ORDER BY updated_at DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

async function listMembershipsAwaitingReview(db: PgQueryable, scopeAccountId?: string | null) {
  const values: unknown[] = [];
  const scope = scopedAccountCondition(scopeAccountId, "memberships.account_id", values);
  values.push(attentionLimit);
  const result = await db.query<MembershipRow>(
    `SELECT memberships.membership_id,
            memberships.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            memberships.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            memberships.role_key,
            memberships.role_permissions,
            memberships.status,
            memberships.updated_at
     FROM identity_memberships AS memberships
     LEFT JOIN identity_users AS users ON users.user_id = memberships.user_id
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = memberships.account_id
     WHERE memberships.status = 'pending-review'${scope}
     ORDER BY memberships.updated_at ASC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

async function listApiKeysNeedingRotation(db: PgQueryable, scopeAccountId: string | null | undefined, now: Date) {
  const rotationThreshold = new Date(
    now.getTime() - (apiKeyRotationIntervalDays - apiKeyRotationWarningDays) * 24 * 60 * 60 * 1000,
  ).toISOString();
  const values: unknown[] = [rotationThreshold];
  const scope = scopedAccountCondition(scopeAccountId, "memberships.account_id", values);
  values.push(attentionLimit);
  const result = await db.query<ApiKeyRotationAttention>(
    `WITH last_rotations AS (
       SELECT stream_id,
              MAX(recorded_at) AS last_rotated_at
       FROM event_store_events
       WHERE stream_context_name = 'identity'
         AND event_type IN ('identity.api-key.created', 'identity.api-key.rotated')
       GROUP BY stream_id
     )
     SELECT DISTINCT ON (api_keys.api_key_id, memberships.account_id)
            api_keys.api_key_id,
            api_keys.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            api_keys.name,
            api_keys.key_prefix,
            api_keys.status,
            api_keys.last_used_at,
            api_keys.updated_at,
            memberships.account_id,
            accounts.display_name AS account_display_name,
            COALESCE(last_rotations.last_rotated_at, api_keys.updated_at) AS last_rotated_at,
            COALESCE(last_rotations.last_rotated_at, api_keys.updated_at) + INTERVAL '${apiKeyRotationIntervalDays} days' AS rotation_due_at
     FROM identity_api_keys AS api_keys
     INNER JOIN identity_memberships AS memberships
       ON memberships.user_id = api_keys.user_id
      AND memberships.status = 'active'
     INNER JOIN identity_accounts AS accounts ON accounts.account_id = memberships.account_id
     LEFT JOIN identity_users AS users ON users.user_id = api_keys.user_id
     LEFT JOIN last_rotations ON last_rotations.stream_id = 'identity.api-key-' || api_keys.api_key_id
     WHERE api_keys.status = 'active'
       AND COALESCE(last_rotations.last_rotated_at, api_keys.updated_at) <= $1${scope}
     ORDER BY api_keys.api_key_id, memberships.account_id, rotation_due_at ASC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows;
}

export async function getAccessHome(db: PgQueryable, params: AccessHomeQuery = {}): Promise<AccessHome> {
  const [accounts, pendingInvitations, suspendedAccounts, membershipsAwaitingReview, apiKeysNeedingRotation] =
    await Promise.all([
      listScopedAccounts(db, params),
      params.includeMemberships === false ? [] : listPendingInvitations(db, params.scopeAccountId),
      listSuspendedAccounts(db, params.scopeAccountId),
      params.includeMemberships === false ? [] : listMembershipsAwaitingReview(db, params.scopeAccountId),
      params.includeApiKeys === false
        ? []
        : listApiKeysNeedingRotation(db, params.scopeAccountId, params.now ?? new Date()),
    ]);

  return {
    accounts: accounts.items,
    account_total: accounts.total,
    attention: {
      pending_invitations: pendingInvitations,
      api_keys_needing_rotation: apiKeysNeedingRotation,
      suspended_accounts: suspendedAccounts,
      memberships_awaiting_review: membershipsAwaitingReview,
    },
  };
}

async function listAccountMemberships(db: PgQueryable, accountId: string) {
  const result = await db.query<MembershipRow>(
    `SELECT memberships.membership_id,
            memberships.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            memberships.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            memberships.role_key,
            memberships.role_permissions,
            memberships.status,
            memberships.updated_at
     FROM identity_memberships AS memberships
     LEFT JOIN identity_users AS users ON users.user_id = memberships.user_id
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = memberships.account_id
     WHERE memberships.account_id = $1
     ORDER BY memberships.status ASC, memberships.updated_at DESC`,
    [accountId],
  );
  return result.rows;
}

async function listAccountUsers(db: PgQueryable, accountId: string) {
  const result = await db.query<User>(
    `SELECT users.*
     FROM identity_users AS users
     WHERE EXISTS (
       SELECT 1
       FROM identity_memberships AS memberships
       WHERE memberships.account_id = $1
         AND memberships.user_id = users.user_id
     )
     ORDER BY users.display_name ASC`,
    [accountId],
  );
  return result.rows;
}

async function listAccountInvitations(db: PgQueryable, accountId: string) {
  const result = await db.query<InvitationRow>(
    `SELECT invitations.invitation_id,
            invitations.account_id,
            accounts.display_name AS account_display_name,
            accounts.name AS account_name,
            invitations.email,
            invitations.role_key,
            invitations.status,
            invitations.expires_at,
            invitations.accepted_by_user_id,
            accepted_users.display_name AS accepted_by_user_display_name,
            accepted_users.primary_email AS accepted_by_user_primary_email,
            invitations.updated_at
     FROM identity_invitations AS invitations
     LEFT JOIN identity_accounts AS accounts ON accounts.account_id = invitations.account_id
     LEFT JOIN identity_users AS accepted_users ON accepted_users.user_id = invitations.accepted_by_user_id
     WHERE invitations.account_id = $1
     ORDER BY invitations.updated_at DESC`,
    [accountId],
  );
  return result.rows;
}

async function listAccountApiKeys(db: PgQueryable, accountId: string) {
  const result = await db.query<ApiKeyRow>(
    `SELECT api_keys.api_key_id,
            api_keys.user_id,
            users.display_name AS user_display_name,
            users.primary_email AS user_primary_email,
            api_keys.name,
            api_keys.key_prefix,
            api_keys.status,
            api_keys.last_used_at,
            api_keys.updated_at
     FROM identity_api_keys AS api_keys
     LEFT JOIN identity_users AS users ON users.user_id = api_keys.user_id
     WHERE EXISTS (
       SELECT 1
       FROM identity_memberships AS memberships
       WHERE memberships.account_id = $1
         AND memberships.user_id = api_keys.user_id
     )
     ORDER BY api_keys.updated_at DESC`,
    [accountId],
  );
  return result.rows;
}

async function listAccountAuditEvents(db: PgQueryable, streamIds: readonly string[]) {
  if (streamIds.length === 0) {
    return [];
  }

  const result = await db.query<AccountAuditEvent>(
    `SELECT event_id, stream_id, event_type, performed_by_user_id, recorded_at
     FROM event_store_events
     WHERE stream_context_name = 'identity'
       AND stream_id = ANY($1::text[])
     ORDER BY global_position DESC
     LIMIT 100`,
    [[...streamIds]],
  );
  return result.rows;
}

export async function getAccountAccessHub(db: PgQueryable, accountId: string): Promise<AccountAccessHub | null> {
  const account = await getAccount(db, accountId);
  if (!account) {
    return null;
  }

  const [memberships, users, invitations, apiKeys] = await Promise.all([
    listAccountMemberships(db, accountId),
    listAccountUsers(db, accountId),
    listAccountInvitations(db, accountId),
    listAccountApiKeys(db, accountId),
  ]);
  const streamIds = [
    `identity.account-${accountId}`,
    ...memberships.map((membership) => `identity.membership-${membership.membership_id}`),
    ...users.map((user) => `identity.user-${user.user_id}`),
    ...invitations.map((invitation) => `identity.invitation-${invitation.invitation_id}`),
    ...apiKeys.map((apiKey) => `identity.api-key-${apiKey.api_key_id}`),
  ];
  const auditEvents = await listAccountAuditEvents(db, streamIds);

  return {
    account,
    users,
    memberships,
    invitations,
    api_keys: apiKeys,
    audit_events: auditEvents,
  };
}

export async function getUserAccountLink(db: PgQueryable, userId: string): Promise<UserAccountLink> {
  const result = await db.query<{ account_id: string }>(
    `SELECT account_id
     FROM identity_memberships
     WHERE user_id = $1
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, account_id ASC
     LIMIT 1`,
    [userId],
  );
  return { account_id: result.rows[0]?.account_id ?? null };
}
