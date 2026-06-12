import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { type AccountId, type UserId } from "@chase-sets/primitives/typed-ids";
import {
  AUTH_BOOTSTRAP_ACCOUNT_ID,
  AUTH_BOOTSTRAP_TENANT_ID,
  AUTH_BOOTSTRAP_USER_ID,
  AUTH_ROLE_PERMISSIONS,
} from "./constants";

export const authIdentityProjectionSchemaSql = `
CREATE TABLE IF NOT EXISTS auth_identity_users (
  user_id text PRIMARY KEY,
  display_name text NOT NULL,
  given_name text NOT NULL,
  family_name text NOT NULL,
  primary_email text NULL,
  status text NOT NULL,
  contact_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  auth_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  password_credential_id text NULL,
  passkey_credential_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  social_login_links jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_identity_accounts (
  account_id text PRIMARY KEY,
  name text NOT NULL,
  display_name text NOT NULL,
  account_type text NOT NULL,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth_identity_users
  ADD COLUMN IF NOT EXISTS social_login_links jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE auth_identity_users
  ALTER COLUMN primary_email DROP NOT NULL;

CREATE TABLE IF NOT EXISTS auth_identity_user_emails (
  email text PRIMARY KEY,
  user_id text NOT NULL,
  contact_method_id text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_identity_user_phones (
  phone text PRIMARY KEY,
  user_id text NOT NULL,
  contact_method_id text NOT NULL,
  is_verified boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_identity_user_social_login_links (
  provider_name text NOT NULL,
  provider_subject text NOT NULL,
  user_id text NOT NULL,
  email text NOT NULL,
  linked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_name, provider_subject)
);

CREATE TABLE IF NOT EXISTS auth_identity_memberships (
  membership_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  role_key text NOT NULL,
  role_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_identity_user_memberships (
  membership_id text PRIMARY KEY,
  user_id text NOT NULL,
  account_id text NOT NULL,
  role_key text NOT NULL,
  role_permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auth_identity_user_memberships_user_status_idx
  ON auth_identity_user_memberships (user_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS auth_identity_user_memberships_user_account_status_idx
  ON auth_identity_user_memberships (user_id, account_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS auth_identity_memberships_user_account_status_idx
  ON auth_identity_memberships (user_id, account_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS auth_identity_invitations (
  invitation_id text PRIMARY KEY,
  account_id text NOT NULL,
  email text NOT NULL,
  role_key text NOT NULL,
  status text NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_by_user_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);`;

export type AuthIdentityUserRow = Readonly<{
  user_id: string;
  display_name: string;
  given_name: string;
  family_name: string;
  primary_email: string | null;
  status: string;
  contact_methods: readonly unknown[];
  auth_methods: readonly string[];
  password_credential_id: string | null;
  passkey_credential_ids: readonly string[];
  social_login_links: readonly unknown[];
  updated_at: string;
}>;

export type AuthIdentityAccountRow = Readonly<{
  account_id: string;
  name: string;
  display_name: string;
  account_type: string;
  status: string;
  updated_at: string;
}>;

export type AuthIdentityMembershipRow = Readonly<{
  membership_id: string;
  user_id: string;
  account_id: string;
  role_key: string;
  role_permissions: readonly string[];
  status: string;
  updated_at: string;
}>;

export type AuthIdentityInvitationRow = Readonly<{
  invitation_id: string;
  account_id: string;
  email: string;
  role_key: string;
  status: string;
  expires_at: string;
  accepted_by_user_id: string | null;
  updated_at: string;
}>;

export type AuthIdentitySessionMembership = Readonly<{
  membershipId: string;
  accountId: string;
  roleKey: string;
  status: string;
  rolePermissions: readonly string[];
}>;

type ContactMethodRow = Readonly<{
  contactMethodId: string;
  type: string;
  value: string;
  verifiedAt: string | null;
}>;

type SocialLoginLinkRow = Readonly<{
  providerName: string;
  providerSubject: string;
  email: string;
  linkedAt: string;
}>;

type ContactMethodLookupRow = Readonly<{
  value: string;
  userId: string;
  contactMethodId: string;
  isVerified: boolean;
  updatedAt: string;
}>;

const CONTACT_METHOD_LOOKUP_COLUMN_COUNT = 5;

function buildContactMethodLookupValuesSql(rowCount: number): string {
  return Array.from({ length: rowCount }, (_, rowIndex) => {
    const firstParameterIndex = rowIndex * CONTACT_METHOD_LOOKUP_COLUMN_COUNT + 1;
    return `(${Array.from(
      { length: CONTACT_METHOD_LOOKUP_COLUMN_COUNT },
      (_, columnIndex) => `$${firstParameterIndex + columnIndex}`,
    ).join(", ")})`;
  }).join(", ");
}

function buildContactMethodLookupRows(
  contactMethods: readonly ContactMethodRow[],
  methodType: string,
  normalizeValue: (value: string) => string,
  userId: string,
  updatedAt: string,
): ContactMethodLookupRow[] {
  const rowsByValue = new Map<string, ContactMethodLookupRow>();

  for (const method of contactMethods) {
    if (method.type !== methodType) {
      continue;
    }

    const value = normalizeValue(method.value);
    rowsByValue.delete(value);
    rowsByValue.set(value, {
      value,
      userId,
      contactMethodId: method.contactMethodId,
      isVerified: method.verifiedAt !== null,
      updatedAt,
    });
  }

  return [...rowsByValue.values()];
}

function flattenContactMethodLookupRows(rows: readonly ContactMethodLookupRow[]): unknown[] {
  return rows.flatMap((row) => [row.value, row.userId, row.contactMethodId, row.isVerified, row.updatedAt]);
}

export function buildAuthIdentityAccountProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.account.created": async (event) => {
      const { accountId, name, displayName, accountType } = event.data as {
        accountId: string;
        name: string;
        displayName: string;
        accountType: string;
      };
      await db.query(
        `INSERT INTO auth_identity_accounts (
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
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      const { name, displayName } = event.data as { name: string; displayName: string };
      await db.query(
        `UPDATE auth_identity_accounts
         SET name = $2,
             display_name = $3,
             updated_at = $4
         WHERE account_id = $1`,
        [accountId, name, displayName, event.timing.recordedAt],
      );
    },
    "identity.account.suspended": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      await db.query(
        `UPDATE auth_identity_accounts
         SET status = 'suspended',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
    "identity.account.reactivated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      await db.query(
        `UPDATE auth_identity_accounts
         SET status = 'active',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
    "identity.account.closed": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      await db.query(
        `UPDATE auth_identity_accounts
         SET status = 'closed',
             updated_at = $2
         WHERE account_id = $1`,
        [accountId, event.timing.recordedAt],
      );
    },
  };
}

export function normalizeAuthEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeAuthPhoneNumber(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const withoutSeparators = trimmed.replace(/[()\-\s.]/g, "");
  const digits = withoutSeparators.replace(/\D/g, "");
  if (withoutSeparators.startsWith("+")) {
    return `+${digits}`;
  }
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }

  return digits ? `+${digits}` : trimmed;
}

export function createAuthBootstrapContext(): EventStoreContext {
  return {
    tenantId: AUTH_BOOTSTRAP_TENANT_ID as never,
    audit: {
      performedByUserId: AUTH_BOOTSTRAP_USER_ID as UserId,
      forAccountId: AUTH_BOOTSTRAP_ACCOUNT_ID as AccountId,
    },
    trace: {},
  };
}

async function syncUserEmailLookups(
  db: PgQueryable,
  userId: string,
  contactMethods: readonly ContactMethodRow[],
  updatedAt: string,
) {
  await db.query(`DELETE FROM auth_identity_user_emails WHERE user_id = $1`, [userId]);

  const emailRows = buildContactMethodLookupRows(contactMethods, "email", normalizeAuthEmail, userId, updatedAt);
  if (emailRows.length === 0) {
    return;
  }

  await db.query(
    `INSERT INTO auth_identity_user_emails (
       email,
       user_id,
       contact_method_id,
       is_verified,
       updated_at
     )
     VALUES ${buildContactMethodLookupValuesSql(emailRows.length)}
     ON CONFLICT (email) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         contact_method_id = EXCLUDED.contact_method_id,
         is_verified = EXCLUDED.is_verified,
         updated_at = EXCLUDED.updated_at`,
    flattenContactMethodLookupRows(emailRows),
  );
}

async function syncUserPhoneLookups(
  db: PgQueryable,
  userId: string,
  contactMethods: readonly ContactMethodRow[],
  updatedAt: string,
) {
  await db.query(`DELETE FROM auth_identity_user_phones WHERE user_id = $1`, [userId]);

  const phoneRows = buildContactMethodLookupRows(contactMethods, "phone", normalizeAuthPhoneNumber, userId, updatedAt);
  if (phoneRows.length === 0) {
    return;
  }

  await db.query(
    `INSERT INTO auth_identity_user_phones (
       phone,
       user_id,
       contact_method_id,
       is_verified,
       updated_at
     )
     VALUES ${buildContactMethodLookupValuesSql(phoneRows.length)}
     ON CONFLICT (phone) DO UPDATE
     SET user_id = EXCLUDED.user_id,
         contact_method_id = EXCLUDED.contact_method_id,
         is_verified = EXCLUDED.is_verified,
         updated_at = EXCLUDED.updated_at`,
    flattenContactMethodLookupRows(phoneRows),
  );
}

async function syncContactMethodLookups(
  db: PgQueryable,
  userId: string,
  contactMethods: readonly ContactMethodRow[],
  updatedAt: string,
) {
  await syncUserEmailLookups(db, userId, contactMethods, updatedAt);
  await syncUserPhoneLookups(db, userId, contactMethods, updatedAt);
}

export async function upsertRegisteredAuthIdentityUserMirror(
  db: PgQueryable,
  params: Readonly<{
    userId: string;
    displayName: string;
    givenName: string;
    familyName: string;
    email: string;
    authMethods: readonly string[];
    passwordCredentialId: string | null;
    updatedAt: string;
  }>,
) {
  const normalizedEmail = normalizeAuthEmail(params.email);
  const contactMethods: ContactMethodRow[] = normalizedEmail
    ? [
        {
          contactMethodId: `${params.userId}-primary-email`,
          type: "email",
          value: normalizedEmail,
          verifiedAt: null,
        },
      ]
    : [];

  await db.query(
    `INSERT INTO auth_identity_users (
       user_id,
       display_name,
       given_name,
       family_name,
       primary_email,
       status,
       contact_methods,
       auth_methods,
       password_credential_id,
       passkey_credential_ids,
       social_login_links,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, $7::jsonb, $8, '[]'::jsonb, '[]'::jsonb, $9)
     ON CONFLICT (user_id) DO UPDATE
     SET display_name = $2,
         given_name = $3,
         family_name = $4,
         primary_email = $5,
         status = 'active',
         contact_methods = $6::jsonb,
         auth_methods = $7::jsonb,
         password_credential_id = $8,
         updated_at = $9`,
    [
      params.userId,
      params.displayName,
      params.givenName,
      params.familyName,
      normalizedEmail || null,
      JSON.stringify(contactMethods),
      JSON.stringify([...new Set(params.authMethods)].sort((left, right) => left.localeCompare(right))),
      params.passwordCredentialId,
      params.updatedAt,
    ],
  );

  await syncContactMethodLookups(db, params.userId, contactMethods, params.updatedAt);
}

async function upsertMembershipMirror(
  db: PgQueryable,
  membershipId: string,
  userId: string,
  accountId: string,
  roleKey: keyof typeof AUTH_ROLE_PERMISSIONS,
  status: string,
  updatedAt: string,
) {
  await db.query(
    `INSERT INTO auth_identity_user_memberships (
       membership_id,
       user_id,
       account_id,
       role_key,
       role_permissions,
       status,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT (membership_id) DO UPDATE
     SET user_id = $2,
         account_id = $3,
         role_key = $4,
         role_permissions = $5::jsonb,
         status = $6,
         updated_at = $7`,
    [membershipId, userId, accountId, roleKey, JSON.stringify(AUTH_ROLE_PERMISSIONS[roleKey]), status, updatedAt],
  );
}

export async function upsertActiveAuthIdentityMembershipMirror(
  db: PgQueryable,
  params: Readonly<{
    membershipId: string;
    userId: string;
    accountId: string;
    roleKey: keyof typeof AUTH_ROLE_PERMISSIONS;
    updatedAt: string;
  }>,
) {
  await upsertMembershipMirror(
    db,
    params.membershipId,
    params.userId,
    params.accountId,
    params.roleKey,
    "active",
    params.updatedAt,
  );
}

export function buildAuthIdentityUserProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.user.created": async (event) => {
      const { userId, displayName, givenName, familyName, primaryEmail, primaryContactMethod } = event.data as {
        userId: string;
        displayName: string;
        givenName: string;
        familyName: string;
        primaryEmail: string | null;
        primaryContactMethod?: ContactMethodRow;
      };
      const contactMethods: ContactMethodRow[] = primaryContactMethod
        ? [primaryContactMethod]
        : primaryEmail
          ? [
              {
                contactMethodId: `${userId}-primary-email`,
                type: "email",
                value: primaryEmail,
                verifiedAt: null,
              },
            ]
          : [];

      await db.query(
        `INSERT INTO auth_identity_users (
           user_id,
           display_name,
           given_name,
           family_name,
           primary_email,
           status,
           contact_methods,
           auth_methods,
           password_credential_id,
           passkey_credential_ids,
           social_login_links,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, '[]'::jsonb, NULL, '[]'::jsonb, '[]'::jsonb, $7)
         ON CONFLICT (user_id) DO UPDATE
         SET display_name = $2,
             given_name = $3,
             family_name = $4,
             primary_email = $5,
             status = 'active',
             contact_methods = $6::jsonb,
             updated_at = $7`,
        [
          userId,
          displayName,
          givenName,
          familyName,
          primaryEmail,
          JSON.stringify(contactMethods),
          event.timing.recordedAt,
        ],
      );

      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.profile-updated": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const { displayName, givenName, familyName } = event.data as {
        displayName: string;
        givenName: string;
        familyName: string;
      };

      await db.query(
        `UPDATE auth_identity_users
         SET display_name = $2,
             given_name = $3,
             family_name = $4,
             updated_at = $5
         WHERE user_id = $1`,
        [userId, displayName, givenName, familyName, event.timing.recordedAt],
      );
    },
    "identity.user.contact-method-added": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const current = await db.query<{ contact_methods: unknown[] }>(
        `SELECT contact_methods FROM auth_identity_users WHERE user_id = $1`,
        [userId],
      );
      const contactMethods = [
        ...((current.rows[0]?.contact_methods as never[]) ?? []),
        {
          contactMethodId: (event.data as { contactMethodId: string }).contactMethodId,
          type: (event.data as { contactMethodType: string }).contactMethodType,
          value: (event.data as { value: string }).value,
          verifiedAt: null,
        },
      ] as ContactMethodRow[];

      await db.query(
        `UPDATE auth_identity_users
         SET contact_methods = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(contactMethods), event.timing.recordedAt],
      );
      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.contact-method-verified": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const current = await db.query<{ contact_methods: unknown[] }>(
        `SELECT contact_methods FROM auth_identity_users WHERE user_id = $1`,
        [userId],
      );
      const contactMethods = (((current.rows[0]?.contact_methods as never[]) ?? []) as ContactMethodRow[]).map(
        (method) =>
          method.contactMethodId === (event.data as { contactMethodId: string }).contactMethodId
            ? {
                ...method,
                verifiedAt: (event.data as { verifiedAt: string }).verifiedAt,
              }
            : method,
      );

      await db.query(
        `UPDATE auth_identity_users
         SET contact_methods = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(contactMethods), event.timing.recordedAt],
      );
      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.auth-method-enabled": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const current = await db.query<{ auth_methods: string[] }>(
        `SELECT auth_methods FROM auth_identity_users WHERE user_id = $1`,
        [userId],
      );
      const authMethods = [
        ...new Set([...(current.rows[0]?.auth_methods ?? []), (event.data as { authMethod: string }).authMethod]),
      ].sort((left, right) => left.localeCompare(right));

      await db.query(
        `UPDATE auth_identity_users
         SET auth_methods = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(authMethods), event.timing.recordedAt],
      );
    },
    "identity.user.password-credential-attached": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");

      await db.query(
        `UPDATE auth_identity_users
         SET password_credential_id = $2,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, (event.data as { credentialId: string }).credentialId, event.timing.recordedAt],
      );
    },
    "identity.user.passkey-registered": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const current = await db.query<{ passkey_credential_ids: string[] }>(
        `SELECT passkey_credential_ids FROM auth_identity_users WHERE user_id = $1`,
        [userId],
      );
      const passkeys = [
        ...new Set([
          ...(current.rows[0]?.passkey_credential_ids ?? []),
          (event.data as { credentialId: string }).credentialId,
        ]),
      ].sort((left, right) => left.localeCompare(right));

      await db.query(
        `UPDATE auth_identity_users
         SET passkey_credential_ids = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(passkeys), event.timing.recordedAt],
      );
    },
    "identity.user.social-login-linked": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const link = event.data as {
        providerName: string;
        providerSubject: string;
        email: string;
        linkedAt: string;
      };
      const current = await db.query<{ social_login_links: unknown[] }>(
        `SELECT social_login_links FROM auth_identity_users WHERE user_id = $1`,
        [userId],
      );
      const currentLinks = (current.rows[0]?.social_login_links as SocialLoginLinkRow[] | undefined) ?? [];
      const links = [
        ...currentLinks.filter(
          (currentLink) =>
            currentLink.providerName !== link.providerName || currentLink.providerSubject !== link.providerSubject,
        ),
        link,
      ].sort((left, right) =>
        `${left.providerName}:${left.providerSubject}`.localeCompare(`${right.providerName}:${right.providerSubject}`),
      );

      await db.query(
        `UPDATE auth_identity_users
         SET social_login_links = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(links), event.timing.recordedAt],
      );
      await db.query(
        `INSERT INTO auth_identity_user_social_login_links (
           provider_name,
           provider_subject,
           user_id,
           email,
           linked_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (provider_name, provider_subject) DO UPDATE
         SET user_id = $3,
             email = $4,
             linked_at = $5,
             updated_at = $6`,
        [
          link.providerName,
          link.providerSubject,
          userId,
          normalizeAuthEmail(link.email),
          link.linkedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "identity.user.suspended": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      await db.query(
        `UPDATE auth_identity_users
         SET status = 'suspended',
             updated_at = $2
         WHERE user_id = $1`,
        [userId, event.timing.recordedAt],
      );
    },
    "identity.user.reactivated": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      await db.query(
        `UPDATE auth_identity_users
         SET status = 'active',
             updated_at = $2
         WHERE user_id = $1`,
        [userId, event.timing.recordedAt],
      );
    },
  };
}

export function buildAuthIdentityMembershipProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.membership.granted": async (event) => {
      const { membershipId, userId, accountId, roleKey } = event.data as {
        membershipId: string;
        userId: string;
        accountId: string;
        roleKey: keyof typeof AUTH_ROLE_PERMISSIONS;
      };
      await db.query(
        `INSERT INTO auth_identity_memberships (
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
          JSON.stringify(AUTH_ROLE_PERMISSIONS[roleKey]),
          event.timing.recordedAt,
        ],
      );
      await upsertMembershipMirror(db, membershipId, userId, accountId, roleKey, "active", event.timing.recordedAt);
    },
    "identity.membership.role-changed": async (event) => {
      const membershipId = extractIdFromStreamId(event.streamId, "identity.membership-");
      const roleKey = (event.data as { roleKey: keyof typeof AUTH_ROLE_PERMISSIONS }).roleKey;
      const existing = await db.query<{ user_id: string; account_id: string; status: string }>(
        `SELECT user_id, account_id, status
         FROM auth_identity_memberships
         WHERE membership_id = $1`,
        [membershipId],
      );
      const row = existing.rows[0];

      await db.query(
        `UPDATE auth_identity_memberships
         SET role_key = $2,
             role_permissions = $3::jsonb,
             updated_at = $4
         WHERE membership_id = $1`,
        [membershipId, roleKey, JSON.stringify(AUTH_ROLE_PERMISSIONS[roleKey]), event.timing.recordedAt],
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
      const membershipId = extractIdFromStreamId(event.streamId, "identity.membership-");
      const existing = await db.query<{
        user_id: string;
        account_id: string;
        role_key: keyof typeof AUTH_ROLE_PERMISSIONS;
      }>(
        `SELECT user_id, account_id, role_key
         FROM auth_identity_memberships
         WHERE membership_id = $1`,
        [membershipId],
      );

      await db.query(
        `UPDATE auth_identity_memberships
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
      const membershipId = extractIdFromStreamId(event.streamId, "identity.membership-");
      const existing = await db.query<{
        user_id: string;
        account_id: string;
        role_key: keyof typeof AUTH_ROLE_PERMISSIONS;
      }>(
        `SELECT user_id, account_id, role_key
         FROM auth_identity_memberships
         WHERE membership_id = $1`,
        [membershipId],
      );

      await db.query(
        `UPDATE auth_identity_memberships
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

export function buildAuthIdentityInvitationProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.invitation.created": async (event) => {
      const { invitationId, accountId, email, roleKey, expiresAt } = event.data as {
        invitationId: string;
        accountId: string;
        email: string;
        roleKey: string;
        expiresAt: string;
      };
      await db.query(
        `INSERT INTO auth_identity_invitations (
           invitation_id,
           account_id,
           email,
           role_key,
           status,
           expires_at,
           accepted_by_user_id,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'pending', $5, NULL, $6)
         ON CONFLICT (invitation_id) DO UPDATE
         SET account_id = $2,
             email = $3,
             role_key = $4,
             status = 'pending',
             expires_at = $5,
             accepted_by_user_id = NULL,
             updated_at = $6`,
        [invitationId, accountId, normalizeAuthEmail(email), roleKey, expiresAt, event.timing.recordedAt],
      );
    },
    "identity.invitation.resent": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await db.query(
        `UPDATE auth_identity_invitations
         SET expires_at = $2,
             updated_at = $3
         WHERE invitation_id = $1`,
        [invitationId, (event.data as { expiresAt: string }).expiresAt, event.timing.recordedAt],
      );
    },
    "identity.invitation.cancelled": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await db.query(
        `UPDATE auth_identity_invitations
         SET status = 'cancelled',
             updated_at = $2
         WHERE invitation_id = $1`,
        [invitationId, event.timing.recordedAt],
      );
    },
    "identity.invitation.accepted": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await db.query(
        `UPDATE auth_identity_invitations
         SET status = 'accepted',
             accepted_by_user_id = $2,
             updated_at = $3
         WHERE invitation_id = $1`,
        [invitationId, (event.data as { userId: string }).userId, event.timing.recordedAt],
      );
    },
    "identity.invitation.declined": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await db.query(
        `UPDATE auth_identity_invitations
         SET status = 'declined',
             updated_at = $2
         WHERE invitation_id = $1`,
        [invitationId, event.timing.recordedAt],
      );
    },
    "identity.invitation.expired": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await db.query(
        `UPDATE auth_identity_invitations
         SET status = 'expired',
             updated_at = $2
         WHERE invitation_id = $1`,
        [invitationId, event.timing.recordedAt],
      );
    },
  };
}

export async function getAuthIdentityUser(db: PgQueryable, userId: string) {
  const result = await db.query<AuthIdentityUserRow>(`SELECT * FROM auth_identity_users WHERE user_id = $1`, [userId]);
  return result.rows[0] ?? null;
}

export async function getAuthIdentityUserByEmail(db: PgQueryable, email: string) {
  const result = await db.query<AuthIdentityUserRow>(
    `SELECT users.*
     FROM auth_identity_user_emails AS emails
     INNER JOIN auth_identity_users AS users ON users.user_id = emails.user_id
     WHERE emails.email = $1`,
    [normalizeAuthEmail(email)],
  );
  return result.rows[0] ?? null;
}

export async function getAuthIdentityUserByPhone(db: PgQueryable, phone: string) {
  const result = await db.query<AuthIdentityUserRow>(
    `SELECT users.*
     FROM auth_identity_user_phones AS phones
     INNER JOIN auth_identity_users AS users ON users.user_id = phones.user_id
     WHERE phones.phone = $1`,
    [normalizeAuthPhoneNumber(phone)],
  );
  return result.rows[0] ?? null;
}

export async function getAuthIdentityUserBySocialLogin(
  db: PgQueryable,
  params: Readonly<{ providerName: string; providerSubject: string }>,
) {
  const result = await db.query<AuthIdentityUserRow>(
    `SELECT users.*
     FROM auth_identity_user_social_login_links AS links
     INNER JOIN auth_identity_users AS users ON users.user_id = links.user_id
     WHERE links.provider_name = $1
       AND links.provider_subject = $2`,
    [params.providerName, params.providerSubject],
  );
  return result.rows[0] ?? null;
}

export async function listActiveAuthMembershipsForUser(
  db: PgQueryable,
  userId: string,
): Promise<readonly AuthIdentitySessionMembership[]> {
  const result = await db.query<AuthIdentityMembershipRow>(
    `SELECT *
     FROM auth_identity_user_memberships
     WHERE user_id = $1
       AND status = 'active'
     ORDER BY updated_at DESC`,
    [userId],
  );

  return result.rows.map((membership) => ({
    membershipId: membership.membership_id,
    accountId: membership.account_id,
    roleKey: membership.role_key,
    status: membership.status,
    rolePermissions: membership.role_permissions,
  }));
}

export async function getActiveAuthMembershipForUserAccount(db: PgQueryable, userId: string, accountId: string) {
  const userMembership = await db.query<AuthIdentityMembershipRow>(
    `SELECT *
     FROM auth_identity_user_memberships
     WHERE user_id = $1
       AND account_id = $2
       AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId, accountId],
  );
  if (userMembership.rows[0]) {
    return userMembership.rows[0];
  }

  const result = await db.query<AuthIdentityMembershipRow>(
    `SELECT *
     FROM auth_identity_memberships
     WHERE user_id = $1
       AND account_id = $2
       AND status = 'active'
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId, accountId],
  );
  return result.rows[0] ?? null;
}

export async function getAuthIdentityInvitation(db: PgQueryable, invitationId: string) {
  const result = await db.query<AuthIdentityInvitationRow>(
    `SELECT * FROM auth_identity_invitations WHERE invitation_id = $1`,
    [invitationId],
  );
  return result.rows[0] ?? null;
}
