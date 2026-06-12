import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeEmail, normalizePhoneNumber } from "../../../support/runtime-support/common";
import { extractIdFromStreamId } from "@chase-sets/event-core";

const STREAM_PREFIX = "identity.user-";

type SocialLoginLinkRow = Readonly<{
  providerName: string;
  providerSubject: string;
  email: string;
  linkedAt: string;
}>;

type ContactMethodProjection = {
  contactMethodId: string;
  type: string;
  value: string;
  verifiedAt: string | null;
};

async function syncUserEmailLookups(
  db: PgQueryable,
  userId: string,
  contactMethods: readonly {
    contactMethodId: string;
    type: string;
    value: string;
    verifiedAt: string | null;
  }[],
  updatedAt: string,
) {
  await db.query(`DELETE FROM identity_user_emails WHERE user_id = $1`, [userId]);

  for (const method of contactMethods.filter((value) => value.type === "email")) {
    await db.query(
      `INSERT INTO identity_user_emails (
         email,
         user_id,
         contact_method_id,
         is_verified,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email) DO UPDATE
       SET user_id = $2,
           contact_method_id = $3,
           is_verified = $4,
           updated_at = $5`,
      [normalizeEmail(method.value), userId, method.contactMethodId, method.verifiedAt !== null, updatedAt],
    );
  }
}

async function syncUserPhoneLookups(
  db: PgQueryable,
  userId: string,
  contactMethods: readonly {
    contactMethodId: string;
    type: string;
    value: string;
    verifiedAt: string | null;
  }[],
  updatedAt: string,
) {
  await db.query(`DELETE FROM identity_user_phones WHERE user_id = $1`, [userId]);

  for (const method of contactMethods.filter((value) => value.type === "phone")) {
    await db.query(
      `INSERT INTO identity_user_phones (
         phone,
         user_id,
         contact_method_id,
         is_verified,
         updated_at
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone) DO UPDATE
       SET user_id = $2,
           contact_method_id = $3,
           is_verified = $4,
           updated_at = $5`,
      [normalizePhoneNumber(method.value), userId, method.contactMethodId, method.verifiedAt !== null, updatedAt],
    );
  }
}

async function syncContactMethodLookups(
  db: PgQueryable,
  userId: string,
  contactMethods: readonly {
    contactMethodId: string;
    type: string;
    value: string;
    verifiedAt: string | null;
  }[],
  updatedAt: string,
) {
  await syncUserEmailLookups(db, userId, contactMethods, updatedAt);
  await syncUserPhoneLookups(db, userId, contactMethods, updatedAt);
}

export function buildUserProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.user.created": async (event) => {
      const { userId, displayName, givenName, familyName, primaryEmail, primaryContactMethod } = event.data as {
        userId: string;
        displayName: string;
        givenName: string;
        familyName: string;
        primaryEmail: string | null;
        primaryContactMethod?: {
          contactMethodId: string;
          type: string;
          value: string;
          verifiedAt: string | null;
        };
      };
      const contactMethods = primaryContactMethod
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
        `INSERT INTO identity_users (
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
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const { displayName, givenName, familyName } = event.data as {
        displayName: string;
        givenName: string;
        familyName: string;
      };
      await db.query(
        `UPDATE identity_users
         SET display_name = $2,
             given_name = $3,
             family_name = $4,
             updated_at = $5
         WHERE user_id = $1`,
        [userId, displayName, givenName, familyName, event.timing.recordedAt],
      );
    },
    "identity.user.contact-method-added": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const current = await db.query<{ contact_methods: unknown[] }>(
        `SELECT contact_methods FROM identity_users WHERE user_id = $1`,
        [userId],
      );
      const contactMethods = [
        ...((current.rows[0]?.contact_methods as ContactMethodProjection[] | undefined) ?? []),
        {
          contactMethodId: (event.data as { contactMethodId: string }).contactMethodId,
          type: (event.data as { contactMethodType: string }).contactMethodType,
          value: (event.data as { value: string }).value,
          verifiedAt: null,
        },
      ];
      await db.query(
        `UPDATE identity_users
         SET contact_methods = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(contactMethods), event.timing.recordedAt],
      );
      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.contact-method-verified": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const current = await db.query<{ contact_methods: unknown[] }>(
        `SELECT contact_methods FROM identity_users WHERE user_id = $1`,
        [userId],
      );
      const contactMethods = (
        ((current.rows[0]?.contact_methods as ContactMethodProjection[] | undefined) ?? []) as ContactMethodProjection[]
      ).map((method) =>
        method.contactMethodId === (event.data as { contactMethodId: string }).contactMethodId
          ? {
              ...method,
              verifiedAt: (event.data as { verifiedAt: string }).verifiedAt,
            }
          : method,
      );
      await db.query(
        `UPDATE identity_users
         SET contact_methods = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(contactMethods), event.timing.recordedAt],
      );
      await syncContactMethodLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.auth-method-enabled": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const current = await db.query<{ auth_methods: string[] }>(
        `SELECT auth_methods FROM identity_users WHERE user_id = $1`,
        [userId],
      );
      const authMethods = [
        ...new Set([...(current.rows[0]?.auth_methods ?? []), (event.data as { authMethod: string }).authMethod]),
      ].sort((left, right) => left.localeCompare(right));
      await db.query(
        `UPDATE identity_users
         SET auth_methods = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(authMethods), event.timing.recordedAt],
      );
    },
    "identity.user.password-credential-attached": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_users
         SET password_credential_id = $2,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, (event.data as { credentialId: string }).credentialId, event.timing.recordedAt],
      );
    },
    "identity.user.passkey-registered": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const current = await db.query<{ passkey_credential_ids: string[] }>(
        `SELECT passkey_credential_ids FROM identity_users WHERE user_id = $1`,
        [userId],
      );
      const passkeys = [
        ...new Set([
          ...(current.rows[0]?.passkey_credential_ids ?? []),
          (event.data as { credentialId: string }).credentialId,
        ]),
      ].sort((left, right) => left.localeCompare(right));
      await db.query(
        `UPDATE identity_users
         SET passkey_credential_ids = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(passkeys), event.timing.recordedAt],
      );
    },
    "identity.user.social-login-linked": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const link = event.data as {
        providerName: string;
        providerSubject: string;
        email: string;
        linkedAt: string;
      };
      const current = await db.query<{ social_login_links: unknown[] }>(
        `SELECT social_login_links FROM identity_users WHERE user_id = $1`,
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
        `UPDATE identity_users
         SET social_login_links = $2::jsonb,
             updated_at = $3
         WHERE user_id = $1`,
        [userId, JSON.stringify(links), event.timing.recordedAt],
      );
      await db.query(
        `INSERT INTO identity_user_social_login_links (
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
          normalizeEmail(link.email),
          link.linkedAt,
          event.timing.recordedAt,
        ],
      );
    },
    "identity.user.suspended": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_users
         SET status = 'suspended',
             updated_at = $2
         WHERE user_id = $1`,
        [userId, event.timing.recordedAt],
      );
    },
    "identity.user.reactivated": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_users
         SET status = 'active',
             updated_at = $2
         WHERE user_id = $1`,
        [userId, event.timing.recordedAt],
      );
    },
  };
}
