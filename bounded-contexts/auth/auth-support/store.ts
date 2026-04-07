import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { AuthMethod } from "./auth-flow";

export async function upsertPasswordCredential(
  db: PgQueryable,
  params: Readonly<{
    credentialId: string;
    userId: string;
    secretHash: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_password_credentials (
       credential_id,
       user_id,
       secret_hash,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (credential_id) DO UPDATE
     SET user_id = $2,
         secret_hash = $3,
         updated_at = now()`,
    [params.credentialId, params.userId, params.secretHash],
  );
}

export async function getPasswordCredentialByUserId(
  db: PgQueryable,
  userId: string,
) {
  const result = await db.query<{
    credential_id: string;
    user_id: string;
    secret_hash: string;
  }>(
    `SELECT credential_id, user_id, secret_hash
     FROM identity_password_credentials
     WHERE user_id = $1`,
    [userId],
  );

  return result.rows[0] ?? null;
}

export async function upsertPasskeyCredential(
  db: PgQueryable,
  params: Readonly<{
    credentialId: string;
    userId: string;
    externalCredentialId: string;
    label: string;
    publicKey: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_passkey_credentials (
       credential_id,
       user_id,
       external_credential_id,
       label,
       public_key,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, now(), now())
     ON CONFLICT (credential_id) DO UPDATE
     SET external_credential_id = $3,
         label = $4,
         public_key = $5,
         updated_at = now()`,
    [
      params.credentialId,
      params.userId,
      params.externalCredentialId,
      params.label,
      params.publicKey,
    ],
  );
  await db.query(
    `INSERT INTO identity_passkey_lookup (
       external_credential_id,
       credential_id,
       user_id,
       label,
       updated_at
     )
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (external_credential_id) DO UPDATE
     SET credential_id = $2,
         user_id = $3,
         label = $4,
         updated_at = now()`,
    [
      params.externalCredentialId,
      params.credentialId,
      params.userId,
      params.label,
    ],
  );
}

export async function getPasskeyCredentialByExternalId(
  db: PgQueryable,
  externalCredentialId: string,
) {
  const result = await db.query<{
    credential_id: string;
    user_id: string;
    external_credential_id: string;
    label: string;
    public_key: string;
  }>(
    `SELECT credential_id, user_id, external_credential_id, label, public_key
     FROM identity_passkey_credentials
     WHERE external_credential_id = $1`,
    [externalCredentialId],
  );

  return result.rows[0] ?? null;
}

export async function insertMagicLinkToken(
  db: PgQueryable,
  params: Readonly<{
    tokenId: string;
    userId: string | null;
    email: string;
    tokenHash: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_magic_link_tokens (
       token_id,
       user_id,
       email,
       token_hash,
       expires_at,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, now())`,
    [params.tokenId, params.userId, params.email, params.tokenHash, params.expiresAt],
  );
}

export async function consumeMagicLinkToken(
  db: PgQueryable,
  tokenHash: string,
) {
  const result = await db.query<{
    token_id: string;
    user_id: string | null;
    email: string;
    token_hash: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `UPDATE identity_magic_link_tokens
     SET consumed_at = now()
     WHERE token_hash = $1
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING token_id, user_id, email, token_hash, expires_at, consumed_at`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export async function insertChallenge(
  db: PgQueryable,
  params: Readonly<{
    challengeId: string;
    purpose: string;
    email: string | null;
    userId: string | null;
    challengeValue: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_auth_challenges (
       challenge_id,
       purpose,
       email,
       user_id,
       challenge_value,
       expires_at,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [
      params.challengeId,
      params.purpose,
      params.email,
      params.userId,
      params.challengeValue,
      params.expiresAt,
    ],
  );
}

export async function consumeChallenge(
  db: PgQueryable,
  params: Readonly<{
    challengeId: string;
    purpose: string;
    challengeValue: string;
  }>,
) {
  const result = await db.query<{
    challenge_id: string;
    purpose: string;
    email: string | null;
    user_id: string | null;
    challenge_value: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `UPDATE identity_auth_challenges
     SET consumed_at = now()
     WHERE challenge_id = $1
       AND purpose = $2
       AND challenge_value = $3
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING challenge_id, purpose, email, user_id, challenge_value, expires_at, consumed_at`,
    [params.challengeId, params.purpose, params.challengeValue],
  );

  return result.rows[0] ?? null;
}

export async function upsertSessionToken(
  db: PgQueryable,
  params: Readonly<{
    sessionId: string;
    tokenHash: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_session_tokens (
       session_id,
       token_hash,
       expires_at,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (session_id) DO UPDATE
     SET token_hash = $2,
         expires_at = $3,
         updated_at = now()`,
    [params.sessionId, params.tokenHash, params.expiresAt],
  );
}

export async function getSessionByTokenHash(
  db: PgQueryable,
  tokenHash: string,
) {
  const result = await db.query<{
    session_id: string;
    token_hash: string;
    expires_at: string;
  }>(
    `SELECT session_id, token_hash, expires_at
     FROM identity_session_tokens
     WHERE token_hash = $1`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export async function insertAccountSelectionToken(
  db: PgQueryable,
  params: Readonly<{
    tokenId: string;
    userId: string;
    authenticationMethod: AuthMethod;
    tokenHash: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_account_selection_tokens (
       token_id,
       user_id,
       authentication_method,
       token_hash,
       expires_at,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, now())`,
    [
      params.tokenId,
      params.userId,
      params.authenticationMethod,
      params.tokenHash,
      params.expiresAt,
    ],
  );
}

export async function getAccountSelectionTokenByHash(
  db: PgQueryable,
  tokenHash: string,
) {
  const result = await db.query<{
    token_id: string;
    user_id: string;
    authentication_method: string;
    token_hash: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `SELECT token_id, user_id, authentication_method, token_hash, expires_at, consumed_at
     FROM identity_account_selection_tokens
     WHERE token_hash = $1
       AND consumed_at IS NULL
       AND expires_at > now()`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export async function consumeAccountSelectionToken(
  db: PgQueryable,
  tokenHash: string,
) {
  const result = await db.query<{
    token_id: string;
    user_id: string;
    authentication_method: string;
    token_hash: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `UPDATE identity_account_selection_tokens
     SET consumed_at = now()
     WHERE token_hash = $1
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING token_id, user_id, authentication_method, token_hash, expires_at, consumed_at`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}
