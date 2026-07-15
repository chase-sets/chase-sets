import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { extractIdFromStreamId } from "@chase-sets/event-core";
import {
  appendJsonbArrayElement,
  patchJsonbArrayElement,
  replaceJsonbArrayElement,
  transitionStatus,
  updateRow,
  upsertRow,
  type PgQueryable,
} from "@chase-sets/event-core-postgres";
import { type AccountId, type UserId, type TenantId } from "@chase-sets/primitives/typed-ids";
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
  invited_by_user_id text NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE auth_identity_invitations
  ADD COLUMN IF NOT EXISTS invited_by_user_id text NULL;

CREATE INDEX IF NOT EXISTS auth_identity_invitations_email_status_expires_at_idx
  ON auth_identity_invitations (email, status, expires_at DESC);`;

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
  invited_by_user_id: string | null;
  updated_at: string;
}>;

export type AuthIdentityInvitationPresentationRow = AuthIdentityInvitationRow &
  Readonly<{
    account_display_name: string | null;
    invited_by_display_name: string | null;
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
      await upsertRow(db, {
        table: "auth_identity_accounts",
        insertColumns: ["account_id", "name", "display_name", "account_type", "status", "updated_at"],
        conflictColumns: ["account_id"],
        updateColumns: ["name", "display_name", "account_type", "status", "updated_at"],
        values: {
          account_id: accountId,
          name,
          display_name: displayName,
          account_type: accountType,
          status: "active",
          updated_at: event.timing.recordedAt,
        },
      });
    },
    "identity.account.profile-updated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      const { name, displayName } = event.data as { name: string; displayName: string };
      await updateRow(db, {
        table: "auth_identity_accounts",
        setColumns: ["name", "display_name", "updated_at"],
        values: {
          name,
          display_name: displayName,
          updated_at: event.timing.recordedAt,
        },
        where: {
          columns: ["account_id"],
          values: { account_id: accountId },
        },
      });
    },
    "identity.account.suspended": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      await transitionStatus(db, {
        table: "auth_identity_accounts",
        idColumn: "account_id",
        id: accountId,
        status: "suspended",
        updatedAt: event.timing.recordedAt,
      });
    },
    "identity.account.reactivated": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      await transitionStatus(db, {
        table: "auth_identity_accounts",
        idColumn: "account_id",
        id: accountId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });
    },
    "identity.account.closed": async (event) => {
      const accountId = extractIdFromStreamId(event.streamId, "identity.account-");
      await transitionStatus(db, {
        table: "auth_identity_accounts",
        idColumn: "account_id",
        id: accountId,
        status: "closed",
        updatedAt: event.timing.recordedAt,
      });
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
    tenantId: AUTH_BOOTSTRAP_TENANT_ID as TenantId,
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

  await upsertRow(db, {
    table: "auth_identity_users",
    insertColumns: [
      "user_id",
      "display_name",
      "given_name",
      "family_name",
      "primary_email",
      "status",
      "contact_methods",
      "auth_methods",
      "password_credential_id",
      "passkey_credential_ids",
      "social_login_links",
      "updated_at",
    ],
    conflictColumns: ["user_id"],
    updateColumns: [
      "display_name",
      "given_name",
      "family_name",
      "primary_email",
      "status",
      "contact_methods",
      "auth_methods",
      "password_credential_id",
      "updated_at",
    ],
    values: {
      user_id: params.userId,
      display_name: params.displayName,
      given_name: params.givenName,
      family_name: params.familyName,
      primary_email: normalizedEmail || null,
      status: "active",
      contact_methods: contactMethods,
      auth_methods: [...new Set(params.authMethods)].sort((left, right) => left.localeCompare(right)),
      password_credential_id: params.passwordCredentialId,
      passkey_credential_ids: [],
      social_login_links: [],
      updated_at: params.updatedAt,
    },
    casts: {
      contact_methods: "jsonb",
      auth_methods: "jsonb",
      passkey_credential_ids: "jsonb",
      social_login_links: "jsonb",
    },
  });

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
  await upsertRow(db, {
    table: "auth_identity_user_memberships",
    insertColumns: ["membership_id", "user_id", "account_id", "role_key", "role_permissions", "status", "updated_at"],
    conflictColumns: ["membership_id"],
    values: {
      membership_id: membershipId,
      user_id: userId,
      account_id: accountId,
      role_key: roleKey,
      role_permissions: AUTH_ROLE_PERMISSIONS[roleKey],
      status,
      updated_at: updatedAt,
    },
    casts: { role_permissions: "jsonb" },
  });
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

      await upsertRow(db, {
        table: "auth_identity_users",
        insertColumns: [
          "user_id",
          "display_name",
          "given_name",
          "family_name",
          "primary_email",
          "status",
          "contact_methods",
          "auth_methods",
          "password_credential_id",
          "passkey_credential_ids",
          "social_login_links",
          "updated_at",
        ],
        conflictColumns: ["user_id"],
        updateColumns: [
          "display_name",
          "given_name",
          "family_name",
          "primary_email",
          "status",
          "contact_methods",
          "updated_at",
        ],
        values: {
          user_id: userId,
          display_name: displayName,
          given_name: givenName,
          family_name: familyName,
          primary_email: primaryEmail,
          status: "active",
          contact_methods: contactMethods,
          auth_methods: [],
          password_credential_id: null,
          passkey_credential_ids: [],
          social_login_links: [],
          updated_at: event.timing.recordedAt,
        },
        casts: {
          contact_methods: "jsonb",
          auth_methods: "jsonb",
          passkey_credential_ids: "jsonb",
          social_login_links: "jsonb",
        },
      });

      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.profile-updated": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const { displayName, givenName, familyName } = event.data as {
        displayName: string;
        givenName: string;
        familyName: string;
      };

      await updateRow(db, {
        table: "auth_identity_users",
        setColumns: ["display_name", "given_name", "family_name", "updated_at"],
        values: {
          display_name: displayName,
          given_name: givenName,
          family_name: familyName,
          updated_at: event.timing.recordedAt,
        },
        where: {
          columns: ["user_id"],
          values: { user_id: userId },
        },
      });
    },
    "identity.user.contact-method-added": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const contactMethod = {
        contactMethodId: (event.data as { contactMethodId: string }).contactMethodId,
        type: (event.data as { contactMethodType: string }).contactMethodType,
        value: (event.data as { value: string }).value,
        verifiedAt: null,
      } satisfies ContactMethodRow;
      const updated = await appendJsonbArrayElement(db, {
        table: "auth_identity_users",
        key: { column: "user_id", value: userId },
        column: "contact_methods",
        element: contactMethod,
        updatedAt: { value: event.timing.recordedAt },
        returning: ["contact_methods"],
      });
      const contactMethods = (updated.rows[0]?.contact_methods as ContactMethodRow[] | undefined) ?? [];

      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.contact-method-verified": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const data = event.data as { contactMethodId: string; verifiedAt: string };
      const updated = await patchJsonbArrayElement(db, {
        table: "auth_identity_users",
        key: { column: "user_id", value: userId },
        column: "contact_methods",
        match: { kind: "pathText", path: ["contactMethodId"], value: data.contactMethodId },
        patch: { verifiedAt: data.verifiedAt },
        updatedAt: { value: event.timing.recordedAt },
        returning: ["contact_methods"],
      });
      const contactMethods = (updated.rows[0]?.contact_methods as ContactMethodRow[] | undefined) ?? [];

      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.auth-method-enabled": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      await appendJsonbArrayElement(db, {
        table: "auth_identity_users",
        key: { column: "user_id", value: userId },
        column: "auth_methods",
        element: (event.data as { authMethod: string }).authMethod,
        unique: true,
        orderBy: [{ kind: "text" }],
        updatedAt: { value: event.timing.recordedAt },
      });
    },
    "identity.user.password-credential-attached": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");

      await updateRow(db, {
        table: "auth_identity_users",
        setColumns: ["password_credential_id", "updated_at"],
        values: {
          password_credential_id: (event.data as { credentialId: string }).credentialId,
          updated_at: event.timing.recordedAt,
        },
        where: {
          columns: ["user_id"],
          values: { user_id: userId },
        },
      });
    },
    "identity.user.passkey-registered": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      await appendJsonbArrayElement(db, {
        table: "auth_identity_users",
        key: { column: "user_id", value: userId },
        column: "passkey_credential_ids",
        element: (event.data as { credentialId: string }).credentialId,
        unique: true,
        orderBy: [{ kind: "text" }],
        updatedAt: { value: event.timing.recordedAt },
      });
    },
    "identity.user.social-login-linked": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      const link = event.data as {
        providerName: string;
        providerSubject: string;
        email: string;
        linkedAt: string;
      };
      await replaceJsonbArrayElement(db, {
        table: "auth_identity_users",
        key: { column: "user_id", value: userId },
        column: "social_login_links",
        match: {
          kind: "all",
          matches: [
            { kind: "pathText", path: ["providerName"], value: link.providerName },
            { kind: "pathText", path: ["providerSubject"], value: link.providerSubject },
          ],
        },
        element: link satisfies SocialLoginLinkRow,
        orderBy: [
          { kind: "pathText", path: ["providerName"] },
          { kind: "pathText", path: ["providerSubject"] },
        ],
        updatedAt: { value: event.timing.recordedAt },
      });
      await upsertRow(db, {
        table: "auth_identity_user_social_login_links",
        insertColumns: ["provider_name", "provider_subject", "user_id", "email", "linked_at", "updated_at"],
        conflictColumns: ["provider_name", "provider_subject"],
        values: {
          provider_name: link.providerName,
          provider_subject: link.providerSubject,
          user_id: userId,
          email: normalizeAuthEmail(link.email),
          linked_at: link.linkedAt,
          updated_at: event.timing.recordedAt,
        },
      });
    },
    "identity.user.suspended": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      await transitionStatus(db, {
        table: "auth_identity_users",
        idColumn: "user_id",
        id: userId,
        status: "suspended",
        updatedAt: event.timing.recordedAt,
      });
    },
    "identity.user.reactivated": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, "identity.user-");
      await transitionStatus(db, {
        table: "auth_identity_users",
        idColumn: "user_id",
        id: userId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });
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
      await upsertRow(db, {
        table: "auth_identity_memberships",
        insertColumns: [
          "membership_id",
          "user_id",
          "account_id",
          "role_key",
          "role_permissions",
          "status",
          "updated_at",
        ],
        conflictColumns: ["membership_id"],
        values: {
          membership_id: membershipId,
          user_id: userId,
          account_id: accountId,
          role_key: roleKey,
          role_permissions: AUTH_ROLE_PERMISSIONS[roleKey],
          status: "active",
          updated_at: event.timing.recordedAt,
        },
        casts: { role_permissions: "jsonb" },
      });
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

      await updateRow(db, {
        table: "auth_identity_memberships",
        setColumns: ["role_key", "role_permissions", "updated_at"],
        values: {
          role_key: roleKey,
          role_permissions: AUTH_ROLE_PERMISSIONS[roleKey],
          updated_at: event.timing.recordedAt,
        },
        casts: { role_permissions: "jsonb" },
        where: {
          columns: ["membership_id"],
          values: { membership_id: membershipId },
        },
      });

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

      await transitionStatus(db, {
        table: "auth_identity_memberships",
        idColumn: "membership_id",
        id: membershipId,
        status: "revoked",
        updatedAt: event.timing.recordedAt,
      });

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

      await transitionStatus(db, {
        table: "auth_identity_memberships",
        idColumn: "membership_id",
        id: membershipId,
        status: "active",
        updatedAt: event.timing.recordedAt,
      });

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
      await upsertRow(db, {
        table: "auth_identity_invitations",
        insertColumns: [
          "invitation_id",
          "account_id",
          "email",
          "role_key",
          "status",
          "expires_at",
          "accepted_by_user_id",
          "invited_by_user_id",
          "updated_at",
        ],
        conflictColumns: ["invitation_id"],
        values: {
          invitation_id: invitationId,
          account_id: accountId,
          email: normalizeAuthEmail(email),
          role_key: roleKey,
          status: "pending",
          expires_at: expiresAt,
          accepted_by_user_id: null,
          invited_by_user_id: event.audit?.performedByUserId ?? null,
          updated_at: event.timing.recordedAt,
        },
      });
    },
    "identity.invitation.resent": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await updateRow(db, {
        table: "auth_identity_invitations",
        setColumns: ["expires_at", "updated_at"],
        values: {
          expires_at: (event.data as { expiresAt: string }).expiresAt,
          updated_at: event.timing.recordedAt,
        },
        where: {
          columns: ["invitation_id"],
          values: { invitation_id: invitationId },
        },
      });
    },
    "identity.invitation.cancelled": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await transitionStatus(db, {
        table: "auth_identity_invitations",
        idColumn: "invitation_id",
        id: invitationId,
        status: "cancelled",
        updatedAt: event.timing.recordedAt,
      });
    },
    "identity.invitation.accepted": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await updateRow(db, {
        table: "auth_identity_invitations",
        setColumns: ["status", "accepted_by_user_id", "updated_at"],
        values: {
          status: "accepted",
          accepted_by_user_id: (event.data as { userId: string }).userId,
          updated_at: event.timing.recordedAt,
        },
        where: {
          columns: ["invitation_id"],
          values: { invitation_id: invitationId },
        },
      });
    },
    "identity.invitation.declined": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await transitionStatus(db, {
        table: "auth_identity_invitations",
        idColumn: "invitation_id",
        id: invitationId,
        status: "declined",
        updatedAt: event.timing.recordedAt,
      });
    },
    "identity.invitation.expired": async (event) => {
      const invitationId = extractIdFromStreamId(event.streamId, "identity.invitation-");
      await transitionStatus(db, {
        table: "auth_identity_invitations",
        idColumn: "invitation_id",
        id: invitationId,
        status: "expired",
        updatedAt: event.timing.recordedAt,
      });
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
  const result = await db.query<AuthIdentityInvitationPresentationRow>(
    `SELECT invitations.*,
            accounts.display_name AS account_display_name,
            inviter.display_name AS invited_by_display_name
     FROM auth_identity_invitations AS invitations
     LEFT JOIN auth_identity_accounts AS accounts ON accounts.account_id = invitations.account_id
     LEFT JOIN auth_identity_users AS inviter ON inviter.user_id = invitations.invited_by_user_id
     WHERE invitations.invitation_id = $1`,
    [invitationId],
  );
  return result.rows[0] ?? null;
}

export async function getPendingAuthIdentityInvitationByEmail(db: PgQueryable, email: string) {
  const result = await db.query<AuthIdentityInvitationRow>(
    `SELECT *
     FROM auth_identity_invitations
     WHERE email = $1
       AND status = 'pending'
       AND expires_at > now()
     ORDER BY expires_at DESC
     LIMIT 1`,
    [normalizeAuthEmail(email)],
  );
  return result.rows[0] ?? null;
}
