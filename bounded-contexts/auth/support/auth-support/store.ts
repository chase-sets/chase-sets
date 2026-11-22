import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createAuthSessionEpochs, type AuthSessionEpochs } from "../../features/sessions/api/owner-epochs";
import { sessionExpiry } from "../../features/sessions/api/session-authority";
import type { AuthMethod } from "../../features/sessions/domain/auth-flow";
import type { RegistrationConsentSubmission } from "../api-support/support";

export type PendingRegistrationPasskey = Readonly<{
  credentialId: string;
  externalCredentialId: string;
  label: string;
  publicKey: string;
  signCount: number;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
}>;

/**
 * A registration staged on its magic-link row until the link is consumed. It
 * holds no plaintext password: only the hash computed when it was staged, the
 * already verified passkey material, the signed consent submission, and the
 * ids reserved for the User, its credentials and its Session. Finalization
 * clears it; retention deletes it with the row.
 */
export type PendingRegistration = Readonly<{
  displayName: string;
  givenName: string;
  familyName: string;
  /** As staged, unchecked here: Identity's verifier classifies it, including its absence. */
  registrationConsent: RegistrationConsentSubmission;
  reservedUserId: string;
  reservedSessionId: string;
  password: Readonly<{ credentialId: string; secretHash: string }> | null;
  passkey: PendingRegistrationPasskey | null;
}>;

/**
 * The link's first successful registration admission, committed before any
 * Identity write. While the link is live a retry reuses it instead of deciding
 * admission again; consuming the link clears it with the staged payload.
 */
export type PendingRegistrationAdmission = Readonly<{ foundersBetaAccessStartedAt: string | null }>;

export type PendingMagicLinkRegistration = Readonly<{
  tokenId: string;
  userId: string | null;
  email: string;
  pendingRegistration: PendingRegistration;
  admission: PendingRegistrationAdmission | null;
}>;

class PendingRegistrationPayloadError extends Error {
  constructor() {
    // Never echo the payload: it carries a password hash and consent signature.
    super("Pending Registration payload is malformed.");
    this.name = "PendingRegistrationPayloadError";
  }
}

function requireText(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) {
    throw new PendingRegistrationPayloadError();
  }
  return value;
}

function requireRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PendingRegistrationPayloadError();
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Shape-checks the staged payload except its consent submission, which passes
 * through as stored: Identity alone verifies it, so an absent or malformed
 * submission reaches Identity's terminal consent rejection.
 */
export function parsePendingRegistration(value: unknown): PendingRegistration {
  const record = requireRecord(value);
  const password = record.password === null ? null : requireRecord(record.password);
  const passkey = record.passkey === null ? null : requireRecord(record.passkey);
  if (passkey && (!Number.isSafeInteger(passkey.signCount) || typeof passkey.credentialBackedUp !== "boolean")) {
    throw new PendingRegistrationPayloadError();
  }

  return {
    displayName: requireText(record.displayName),
    givenName: requireText(record.givenName, true),
    familyName: requireText(record.familyName, true),
    registrationConsent: record.registrationConsent as RegistrationConsentSubmission,
    reservedUserId: requireText(record.reservedUserId),
    reservedSessionId: requireText(record.reservedSessionId),
    password: password && {
      credentialId: requireText(password.credentialId),
      secretHash: requireText(password.secretHash),
    },
    passkey: passkey && {
      credentialId: requireText(passkey.credentialId),
      externalCredentialId: requireText(passkey.externalCredentialId),
      label: requireText(passkey.label),
      publicKey: requireText(passkey.publicKey),
      signCount: passkey.signCount as number,
      credentialDeviceType: requireText(passkey.credentialDeviceType),
      credentialBackedUp: passkey.credentialBackedUp as boolean,
    },
  };
}

function parsePendingRegistrationAdmission(value: unknown): PendingRegistrationAdmission | null {
  if (value === undefined || value === null) {
    return null;
  }
  const admission = requireRecord(value);
  return {
    foundersBetaAccessStartedAt:
      admission.foundersBetaAccessStartedAt === null ? null : requireText(admission.foundersBetaAccessStartedAt),
  };
}

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

export async function getPasswordCredentialByUserId(db: PgQueryable, userId: string) {
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
    signCount: number;
    credentialDeviceType: string;
    credentialBackedUp: boolean;
  }>,
) {
  await db.query(
    `INSERT INTO identity_passkey_credentials (
       credential_id,
       user_id,
       external_credential_id,
       label,
       public_key,
       sign_count,
       credential_device_type,
       credential_backed_up,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT (credential_id) DO UPDATE
     SET external_credential_id = $3,
         label = $4,
         public_key = $5,
         sign_count = $6,
         credential_device_type = $7,
         credential_backed_up = $8,
         updated_at = now()`,
    [
      params.credentialId,
      params.userId,
      params.externalCredentialId,
      params.label,
      params.publicKey,
      params.signCount,
      params.credentialDeviceType,
      params.credentialBackedUp,
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
    [params.externalCredentialId, params.credentialId, params.userId, params.label],
  );
}

/**
 * Pending Registration's password row: the staged hash is written once under
 * its reserved credential id and never rehashed or overwritten on a retry.
 */
export async function insertPasswordCredentialIfAbsent(
  db: PgQueryable,
  params: Readonly<{ credentialId: string; userId: string; secretHash: string }>,
) {
  await db.query(
    `INSERT INTO identity_password_credentials (credential_id, user_id, secret_hash, created_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (credential_id) DO NOTHING`,
    [params.credentialId, params.userId, params.secretHash],
  );
}

/** Pending Registration's passkey rows: written once under the reserved credential id, never replaced. */
export async function insertPasskeyCredentialIfAbsent(
  db: PgQueryable,
  params: PendingRegistrationPasskey & Readonly<{ userId: string }>,
) {
  await db.query(
    `INSERT INTO identity_passkey_credentials (
       credential_id,
       user_id,
       external_credential_id,
       label,
       public_key,
       sign_count,
       credential_device_type,
       credential_backed_up,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
     ON CONFLICT (credential_id) DO NOTHING`,
    [
      params.credentialId,
      params.userId,
      params.externalCredentialId,
      params.label,
      params.publicKey,
      params.signCount,
      params.credentialDeviceType,
      params.credentialBackedUp,
    ],
  );
  await db.query(
    `INSERT INTO identity_passkey_lookup (external_credential_id, credential_id, user_id, label, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (external_credential_id) DO NOTHING`,
    [params.externalCredentialId, params.credentialId, params.userId, params.label],
  );
}

export async function getPasskeyCredentialByExternalId(db: PgQueryable, externalCredentialId: string) {
  const result = await db.query<{
    credential_id: string;
    user_id: string;
    external_credential_id: string;
    label: string;
    public_key: string;
    sign_count: number;
    credential_device_type: string;
    credential_backed_up: boolean;
  }>(
    `SELECT credential_id,
            user_id,
            external_credential_id,
            label,
            public_key,
            sign_count,
            credential_device_type,
            credential_backed_up
     FROM identity_passkey_credentials
     WHERE external_credential_id = $1`,
    [externalCredentialId],
  );

  return result.rows[0] ?? null;
}

export async function updatePasskeySignCount(
  db: PgQueryable,
  params: Readonly<{
    externalCredentialId: string;
    signCount: number;
    credentialDeviceType: string;
    credentialBackedUp: boolean;
  }>,
) {
  await db.query(
    `UPDATE identity_passkey_credentials
     SET sign_count = $2,
         credential_device_type = $3,
         credential_backed_up = $4,
         updated_at = now()
     WHERE external_credential_id = $1`,
    [params.externalCredentialId, params.signCount, params.credentialDeviceType, params.credentialBackedUp],
  );
}

export async function insertMagicLinkToken(
  db: PgQueryable,
  params: Readonly<{
    tokenId: string;
    userId: string | null;
    email: string;
    tokenHash: string;
    deliveryToken: string | null;
    expiresAt: string;
    pendingRegistration?: PendingRegistration | null;
  }>,
) {
  await db.query(
    `INSERT INTO identity_magic_link_tokens (
       token_id,
       user_id,
       email,
       token_hash,
       delivery_token,
       expires_at,
       pending_registration,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())`,
    [
      params.tokenId,
      params.userId,
      params.email,
      params.tokenHash,
      params.deliveryToken,
      params.expiresAt,
      params.pendingRegistration ? JSON.stringify(params.pendingRegistration) : null,
    ],
  );
}

export async function getMagicLinkDeliveryToken(db: PgQueryable, tokenId: string) {
  const result = await db.query<{ delivery_token: string | null }>(
    `SELECT delivery_token
     FROM identity_magic_link_tokens
     WHERE token_id = $1
       AND consumed_at IS NULL
       AND expires_at > now()`,
    [tokenId],
  );

  return result.rows[0]?.delivery_token ?? null;
}

export async function clearMagicLinkDeliveryToken(db: PgQueryable, tokenId: string) {
  await db.query(
    `UPDATE identity_magic_link_tokens
     SET delivery_token = NULL
     WHERE token_id = $1`,
    [tokenId],
  );
}

export async function consumeMagicLinkToken(db: PgQueryable, tokenHash: string) {
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
       AND pending_registration IS NULL
     RETURNING token_id, user_id, email, token_hash, expires_at, consumed_at`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

/** Whether a live link still stages a Pending Registration; it does not lock or consume the row. */
export async function hasPendingMagicLinkRegistration(db: PgQueryable, tokenHash: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1
     FROM identity_magic_link_tokens
     WHERE token_hash = $1
       AND pending_registration IS NOT NULL
       AND consumed_at IS NULL
       AND expires_at > now()`,
    [tokenHash],
  );
  return result.rows.length > 0;
}

/**
 * Claims a live Pending Registration link for the caller's open transaction.
 * READ COMMITTED re-checks these predicates after a row-lock wait, so a waiter
 * behind a committed finalization reads nothing and one behind a rollback
 * claims the still-pending row.
 */
export async function lockPendingMagicLinkRegistration(
  db: PgQueryable,
  tokenHash: string,
): Promise<PendingMagicLinkRegistration | null> {
  const result = await db.query<{
    token_id: string;
    user_id: string | null;
    email: string;
    pending_registration: unknown;
  }>(
    `SELECT token_id, user_id, email, pending_registration
     FROM identity_magic_link_tokens
     WHERE token_hash = $1
       AND pending_registration IS NOT NULL
       AND consumed_at IS NULL
       AND expires_at > now()
     FOR UPDATE`,
    [tokenHash],
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }
  const payload = requireRecord(row.pending_registration);
  return {
    tokenId: row.token_id,
    userId: row.user_id,
    email: row.email,
    pendingRegistration: parsePendingRegistration(payload),
    admission: parsePendingRegistrationAdmission(payload.admission),
  };
}

/**
 * Records a claimed link's successful admission in the caller's transaction,
 * which must commit before the first Identity write. An existing admission is
 * kept, so the first decision and its timestamp stand for every retry.
 */
export async function recordPendingRegistrationAdmission(
  db: PgQueryable,
  tokenId: string,
  admission: PendingRegistrationAdmission,
): Promise<void> {
  const result = await db.query(
    `UPDATE identity_magic_link_tokens
     SET pending_registration = jsonb_set(pending_registration, '{admission}', $2::jsonb)
     WHERE token_id = $1
       AND consumed_at IS NULL
       AND pending_registration IS NOT NULL
       AND pending_registration->'admission' IS NULL
     RETURNING token_id`,
    [tokenId, JSON.stringify(admission)],
  );
  if (result.rows.length !== 1) {
    throw new Error("Pending Registration link was not claimed for admission by this transaction.");
  }
}

/** Consumes a claimed Pending Registration link and clears its staged payload in the caller's transaction. */
export async function finishPendingMagicLinkRegistration(db: PgQueryable, tokenId: string): Promise<void> {
  const result = await db.query(
    `UPDATE identity_magic_link_tokens
     SET consumed_at = now(),
         pending_registration = NULL
     WHERE token_id = $1
       AND consumed_at IS NULL
       AND pending_registration IS NOT NULL
     RETURNING token_id`,
    [tokenId],
  );
  if (result.rows.length !== 1) {
    throw new Error("Pending Registration link was not claimed by this transaction.");
  }
}

export async function insertPhoneCodeToken(
  db: PgQueryable,
  params: Readonly<{
    tokenId: string;
    userId: string | null;
    phone: string;
    codeHash: string;
    deliveryCode: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_phone_code_tokens (
       token_id,
       user_id,
       phone,
       code_hash,
       delivery_code,
       expires_at,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [params.tokenId, params.userId, params.phone, params.codeHash, params.deliveryCode, params.expiresAt],
  );
}

export async function verifyPhoneCodeToken(
  db: PgQueryable,
  params: Readonly<{
    tokenId: string;
    phone: string;
    codeHash: string;
    maxFailedAttempts: number;
  }>,
) {
  const result = await db.query<{
    token_id: string;
    user_id: string | null;
    phone: string;
    code_hash: string;
    expires_at: string;
    consumed_at: string | null;
    invalidated_at: string | null;
    failed_attempt_count: number;
    code_matches: boolean;
  }>(
    `WITH active_phone_code AS (
       SELECT token_id, code_hash = $3 AS code_matches
       FROM identity_phone_code_tokens
       WHERE token_id = $1
         AND phone = $2
         AND consumed_at IS NULL
         AND invalidated_at IS NULL
         AND expires_at > now()
       FOR UPDATE
     )
     UPDATE identity_phone_code_tokens AS token
     SET consumed_at = CASE WHEN active.code_matches THEN now() ELSE token.consumed_at END,
         invalidated_at = CASE
           WHEN NOT active.code_matches AND token.failed_attempt_count + 1 >= $4 THEN now()
           ELSE token.invalidated_at
         END,
         failed_attempt_count = CASE
           WHEN active.code_matches THEN token.failed_attempt_count
           ELSE token.failed_attempt_count + 1
         END,
         delivery_code = CASE
           WHEN active.code_matches OR token.failed_attempt_count + 1 >= $4 THEN NULL
           ELSE token.delivery_code
         END
     FROM active_phone_code AS active
     WHERE token.token_id = active.token_id
     RETURNING token.token_id,
               token.user_id,
               token.phone,
               token.code_hash,
               token.expires_at,
               token.consumed_at,
               token.invalidated_at,
               token.failed_attempt_count,
               active.code_matches`,
    [params.tokenId, params.phone, params.codeHash, params.maxFailedAttempts],
  );

  const record = result.rows[0];
  if (!record || !record.code_matches) {
    return { status: "rejected", invalidated: Boolean(record?.invalidated_at) } as const;
  }

  const { code_matches: _, ...token } = record;
  return { status: "verified", token } as const;
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
    [params.challengeId, params.purpose, params.email, params.userId, params.challengeValue, params.expiresAt],
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

const SESSION_TOKEN_UPSERT_SQL = `INSERT INTO identity_session_tokens (
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
         revision = identity_session_tokens.revision + 1,
         updated_at = now()`;

export async function upsertSessionToken(
  pool: PgTransactionalPool,
  params: Readonly<{
    sessionId: string;
    tokenHash: string;
    expiresAt: string;
  }>,
  epochs: AuthSessionEpochs = createAuthSessionEpochs(pool),
) {
  sessionExpiry(params.expiresAt);
  await epochs.transaction([`session/${params.sessionId}`], (db) =>
    db.query(SESSION_TOKEN_UPSERT_SQL, [params.sessionId, params.tokenHash, params.expiresAt]),
  );
}

/**
 * The same fenced Session Token write on a transaction the caller already
 * holds (Pending Registration's lock client). Enrollment runs first on that
 * client; a pending closure throws `SessionClosureRequired` before any write.
 */
export async function upsertSessionTokenOnClient(
  client: PgQueryable,
  params: Readonly<{
    sessionId: string;
    tokenHash: string;
    expiresAt: string;
  }>,
  epochs: AuthSessionEpochs,
) {
  sessionExpiry(params.expiresAt);
  await epochs.enrollOnClient(client, [`session/${params.sessionId}`]);
  await client.query(SESSION_TOKEN_UPSERT_SQL, [params.sessionId, params.tokenHash, params.expiresAt]);
}

export async function getSessionByTokenHash(db: PgQueryable, tokenHash: string) {
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
    [params.tokenId, params.userId, params.authenticationMethod, params.tokenHash, params.expiresAt],
  );
}

export async function insertSocialLoginState(
  db: PgQueryable,
  params: Readonly<{
    stateHash: string;
    providerName: string;
    journey: string;
    returnTo: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_social_login_states (
       state_hash,
       provider_name,
       journey,
       return_to,
       expires_at,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, now())`,
    [params.stateHash, params.providerName, params.journey, params.returnTo, params.expiresAt],
  );
}

export async function consumeSocialLoginState(
  db: PgQueryable,
  params: Readonly<{
    stateHash: string;
    providerName: string;
  }>,
) {
  const result = await db.query<{
    state_hash: string;
    provider_name: string;
    journey: string;
    return_to: string;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `UPDATE identity_social_login_states
     SET consumed_at = now()
     WHERE state_hash = $1
       AND provider_name = $2
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING state_hash, provider_name, journey, return_to, expires_at, consumed_at`,
    [params.stateHash, params.providerName],
  );

  return result.rows[0] ?? null;
}

export async function getAccountSelectionTokenByHash(db: PgQueryable, tokenHash: string) {
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

export async function consumeAccountSelectionToken(db: PgQueryable, tokenHash: string) {
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

export async function upsertGuestCheckoutToken(
  db: PgQueryable,
  params: Readonly<{
    tokenId: string;
    accountId: string;
    contactEmail: string | null;
    contactName: string | null;
    tokenHash: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_guest_checkout_tokens (
       token_id,
       account_id,
       contact_email,
       contact_name,
       token_hash,
       expires_at,
       created_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, now(), now())
     ON CONFLICT (token_id) DO UPDATE
     SET account_id = $2,
         contact_email = $3,
         contact_name = $4,
         token_hash = $5,
         expires_at = $6,
         revoked_at = NULL,
         updated_at = now()`,
    [params.tokenId, params.accountId, params.contactEmail, params.contactName, params.tokenHash, params.expiresAt],
  );
}

export async function bindGuestCheckoutContact(
  db: PgQueryable,
  params: Readonly<{
    tokenHash: string;
    accountId: string;
    contactEmail: string;
    contactName: string;
  }>,
) {
  const result = await db.query<{
    token_id: string;
    account_id: string;
    contact_email: string;
    contact_name: string;
    token_hash: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    `UPDATE identity_guest_checkout_tokens
     SET contact_email = $3,
         contact_name = $4,
         updated_at = now()
     WHERE token_hash = $1
       AND account_id = $2
       AND revoked_at IS NULL
       AND expires_at > now()
       AND NULLIF(BTRIM(COALESCE(contact_email, '')), '') IS NULL
       AND NULLIF(BTRIM(COALESCE(contact_name, '')), '') IS NULL
     RETURNING token_id, account_id, contact_email, contact_name, token_hash, expires_at, revoked_at`,
    [params.tokenHash, params.accountId, params.contactEmail, params.contactName],
  );

  return result.rows[0] ?? null;
}

export async function getGuestCheckoutTokenByHash(db: PgQueryable, tokenHash: string) {
  const result = await db.query<{
    token_id: string;
    account_id: string;
    contact_email: string | null;
    contact_name: string | null;
    token_hash: string;
    expires_at: string;
    revoked_at: string | null;
  }>(
    `SELECT token_id, account_id, contact_email, contact_name, token_hash, expires_at, revoked_at
     FROM identity_guest_checkout_tokens
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > now()`,
    [tokenHash],
  );

  return result.rows[0] ?? null;
}

export async function revokeGuestCheckoutTokenByHash(db: PgQueryable, tokenHash: string) {
  await db.query(
    `UPDATE identity_guest_checkout_tokens
     SET revoked_at = now(),
         updated_at = now()
     WHERE token_hash = $1
       AND revoked_at IS NULL`,
    [tokenHash],
  );
}

export async function revokeGuestCheckoutTokensForAccount(db: PgQueryable, accountId: string) {
  await db.query(
    `UPDATE identity_guest_checkout_tokens
     SET revoked_at = now(),
         updated_at = now()
     WHERE account_id = $1
       AND revoked_at IS NULL`,
    [accountId],
  );
}

export async function insertGuestCheckoutClaimToken(
  db: PgQueryable,
  params: Readonly<{
    tokenId: string;
    accountId: string;
    paymentId: string;
    email: string;
    displayName: string;
    tokenHash: string;
    continuationHash: string;
    expiresAt: string;
  }>,
) {
  await db.query(
    `INSERT INTO identity_guest_checkout_claim_tokens (
       token_id,
       account_id,
       payment_id,
       email,
       display_name,
       token_hash,
       continuation_hash,
       expires_at,
       created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [
      params.tokenId,
      params.accountId,
      params.paymentId,
      params.email,
      params.displayName,
      params.tokenHash,
      params.continuationHash,
      params.expiresAt,
    ],
  );
}

export async function consumeGuestCheckoutClaimToken(
  db: PgQueryable,
  params: Readonly<{
    tokenHash: string;
    accountId: string;
    paymentId: string;
    email: string;
  }>,
) {
  const result = await db.query<{
    token_id: string;
    account_id: string;
    payment_id: string;
    email: string;
    display_name: string | null;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `UPDATE identity_guest_checkout_claim_tokens
     SET consumed_at = now()
     WHERE token_hash = $1
       AND account_id = $2
       AND payment_id = $3
       AND email = $4
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING token_id, account_id, payment_id, email, display_name, expires_at, consumed_at`,
    [params.tokenHash, params.accountId, params.paymentId, params.email],
  );

  return result.rows[0] ?? null;
}

export async function consumeGuestCheckoutClaimContinuationToken(
  db: PgQueryable,
  params: Readonly<{
    continuationHash: string;
    paymentId: string;
  }>,
) {
  const result = await db.query<{
    token_id: string;
    account_id: string;
    payment_id: string;
    email: string;
    display_name: string | null;
    expires_at: string;
    consumed_at: string | null;
  }>(
    `UPDATE identity_guest_checkout_claim_tokens
     SET consumed_at = now()
     WHERE continuation_hash = $1
       AND payment_id = $2
       AND consumed_at IS NULL
       AND expires_at > now()
     RETURNING token_id, account_id, payment_id, email, display_name, expires_at, consumed_at`,
    [params.continuationHash, params.paymentId],
  );

  return result.rows[0] ?? null;
}
