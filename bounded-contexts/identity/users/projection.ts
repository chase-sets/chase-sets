import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { normalizeEmail } from "../common";
import { extractIdFromStreamId } from "../projection-support/extract-id-from-stream";

const STREAM_PREFIX = "identity.user-";

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
      [
        normalizeEmail(method.value),
        userId,
        method.contactMethodId,
        method.verifiedAt !== null,
        updatedAt,
      ],
    );
  }
}

export function buildUserProjectionHandlers(db: PgQueryable): ProjectorHandlerMap {
  return {
    "identity.user.created": async (event) => {
      const { userId, displayName, givenName, familyName, primaryEmail } = event.data as {
        userId: string;
        displayName: string;
        givenName: string;
        familyName: string;
        primaryEmail: string;
      };
      const contactMethods = [
        {
          contactMethodId: `${userId}-primary-email`,
          type: "email",
          value: primaryEmail,
          verifiedAt: null,
        },
      ];

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
           updated_at
         )
         VALUES ($1, $2, $3, $4, $5, 'active', $6::jsonb, '[]'::jsonb, NULL, '[]'::jsonb, $7)
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

      await syncUserEmailLookups(db, userId, contactMethods, event.timing.recordedAt);
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
        ...((current.rows[0]?.contact_methods as never[]) ?? []),
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
      await syncUserEmailLookups(
        db,
        userId,
        contactMethods as {
          contactMethodId: string;
          type: string;
          value: string;
          verifiedAt: string | null;
        }[],
        event.timing.recordedAt,
      );
    },
    "identity.user.contact-method-verified": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const current = await db.query<{ contact_methods: unknown[] }>(
        `SELECT contact_methods FROM identity_users WHERE user_id = $1`,
        [userId],
      );
      const contactMethods = (((current.rows[0]?.contact_methods as never[]) ?? []) as {
        contactMethodId: string;
        type: string;
        value: string;
        verifiedAt: string | null;
      }[]).map((method) =>
        method.contactMethodId ===
        (event.data as { contactMethodId: string }).contactMethodId
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
      await syncUserEmailLookups(db, userId, contactMethods, event.timing.recordedAt);
    },
    "identity.user.auth-method-enabled": async (event) => {
      const userId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const current = await db.query<{ auth_methods: string[] }>(
        `SELECT auth_methods FROM identity_users WHERE user_id = $1`,
        [userId],
      );
      const authMethods = [
        ...new Set([
          ...(current.rows[0]?.auth_methods ?? []),
          (event.data as { authMethod: string }).authMethod,
        ]),
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
        [
          userId,
          (event.data as { credentialId: string }).credentialId,
          event.timing.recordedAt,
        ],
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
