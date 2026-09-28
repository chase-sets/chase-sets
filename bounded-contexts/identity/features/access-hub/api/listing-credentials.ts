import { withPgTransaction, type PgTransactionalPool, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { isDeepStrictEqual } from "node:util";
import type {
  LinkedPlatformAuthorizationRow,
  LinkedPlatformAuthorizationStore,
} from "./linked-platform-authorizations";

export type IdentityCredentialCommand =
  | Readonly<{ kind: "api-key-upsert"; apiKeyId: string; userId: string; keyPrefix: string; secretHash: string }>
  | Readonly<{ kind: "api-key-delete"; apiKeyId: string }>
  | Readonly<{ kind: "delegation-grant"; params: Parameters<LinkedPlatformAuthorizationStore["grant"]>[0] }>
  | Readonly<{
      kind: "delegation-rotate";
      authorizationId: string;
      params: Parameters<LinkedPlatformAuthorizationStore["rotateRefreshToken"]>[0];
    }>
  | Readonly<{
      kind: "delegation-revoke";
      authorizationId: string;
      accountId: string;
      revokedAt: string;
      reason: string;
    }>;
export type IdentityCredentialMutation = Readonly<{
  mutationId: string;
  command: IdentityCredentialCommand;
  context: EventStoreContext;
}>;
export type IdentityApiKeyCredential = Readonly<{
  api_key_id: string;
  user_id: string;
  key_prefix: string;
  secret_hash: string;
  authority_revision: string | null;
}>;
export type IdentityDelegationCredential = LinkedPlatformAuthorizationRow &
  Readonly<{ authority_revision: string | null }>;
type Receipt = IdentityCredentialMutation &
  Readonly<{ applied: boolean; result: IdentityDelegationCredential | boolean | null }>;

export function identityCredentialResource(command: IdentityCredentialCommand) {
  return command.kind === "api-key-upsert" || command.kind === "api-key-delete"
    ? `api-key/${command.apiKeyId}`
    : `delegation/${command.kind === "delegation-grant" ? command.params.authorizationId : command.authorizationId}`;
}

/** Credential hashes and replay receipts stay in Identity SQL, never shared event payloads. */
export function createIdentityCredentialStore(pool: PgTransactionalPool) {
  async function readMutation(id: string, db: PgQueryable = pool): Promise<Receipt | null> {
    const result = await db.query<{
      mutation_id: string;
      command: IdentityCredentialCommand;
      context: EventStoreContext;
      applied: boolean;
      result: Receipt["result"];
    }>(
      "SELECT mutation_id, command, context, applied, result FROM identity_listing_credential_mutations WHERE mutation_id = $1",
      [id],
    );
    const row = result.rows[0];
    return row
      ? {
          mutationId: row.mutation_id,
          command: row.command,
          context: row.context,
          applied: row.applied,
          result: row.result,
        }
      : null;
  }
  return {
    readMutation,
    async authenticateApiKey(hash: string): Promise<IdentityApiKeyCredential | null> {
      const result = await pool.query<IdentityApiKeyCredential>(
        "SELECT api_key_id, user_id, key_prefix, secret_hash, authority_revision FROM identity_api_key_secrets WHERE secret_hash = $1 LIMIT 2",
        [hash],
      );
      return result.rows.length === 1 ? result.rows[0]! : null;
    },
    async authenticateDelegation(hash: string): Promise<IdentityDelegationCredential | null> {
      return (
        (
          await pool.query<IdentityDelegationCredential>(
            "SELECT * FROM identity_linked_platform_authorizations WHERE access_token_hash = $1 AND status = 'active' AND access_token_expires_at > now()",
            [hash],
          )
        ).rows[0] ?? null
      );
    },
    async readApiKey(id: string): Promise<IdentityApiKeyCredential | null> {
      return (
        (
          await pool.query<IdentityApiKeyCredential>(
            "SELECT api_key_id, user_id, key_prefix, secret_hash, authority_revision FROM identity_api_key_secrets WHERE api_key_id = $1",
            [id],
          )
        ).rows[0] ?? null
      );
    },
    async readDelegation(id: string): Promise<IdentityDelegationCredential | null> {
      return (
        (
          await pool.query<IdentityDelegationCredential>(
            "SELECT * FROM identity_linked_platform_authorizations WHERE authorization_id = $1",
            [id],
          )
        ).rows[0] ?? null
      );
    },
    async stage(input: IdentityCredentialMutation) {
      if (!input.mutationId || !identityCredentialResource(input.command).split("/")[1])
        throw new Error("Invalid Identity credential mutation.");
      await pool.query(
        "INSERT INTO identity_listing_credential_mutations (mutation_id, command, context) VALUES ($1, $2::jsonb, $3::jsonb) ON CONFLICT (mutation_id) DO NOTHING",
        [input.mutationId, JSON.stringify(input.command), JSON.stringify(input.context)],
      );
      const retained = await readMutation(input.mutationId);
      if (
        !retained ||
        !isDeepStrictEqual(
          { mutationId: retained.mutationId, command: retained.command, context: retained.context },
          JSON.parse(JSON.stringify(input)),
        )
      )
        throw new Error("Identity credential mutation identity conflict.");
    },
    async apply(id: string) {
      // The row lock and effect commit in one OWNER-LOCAL transaction. There are no remote calls here.
      return withPgTransaction(pool, async (db) => {
        await db.query(
          "SELECT mutation_id FROM identity_listing_credential_mutations WHERE mutation_id = $1 FOR UPDATE",
          [id],
        );
        const receipt = await readMutation(id, db);
        if (!receipt) throw new Error("Unknown Identity credential mutation.");
        if (receipt.applied) return receipt.result;
        const result = JSON.parse(JSON.stringify(await applyCredential(db, receipt.command, id))) as Receipt["result"];
        await db.query(
          "UPDATE identity_listing_credential_mutations SET applied = true, result = $2::jsonb WHERE mutation_id = $1",
          [id, JSON.stringify(result)],
        );
        return result;
      });
    },
    async complete(id: string) {
      await pool.query(
        "UPDATE identity_listing_credential_mutations SET completed = true WHERE mutation_id = $1 AND applied = true",
        [id],
      );
    },
    async pending(limit: number, after = "") {
      return (
        await pool.query<{ mutation_id: string }>(
          "SELECT mutation_id FROM identity_listing_credential_mutations WHERE completed = false AND mutation_id > $2 ORDER BY mutation_id LIMIT $1",
          [limit, after],
        )
      ).rows.map((row) => row.mutation_id);
    },
  };
}
export type IdentityCredentialStore = ReturnType<typeof createIdentityCredentialStore>;

async function applyCredential(
  db: PgQueryable,
  command: IdentityCredentialCommand,
  revision: string,
): Promise<Receipt["result"]> {
  switch (command.kind) {
    case "api-key-upsert":
      await db.query(
        `INSERT INTO identity_api_key_secrets(api_key_id, user_id, key_prefix, secret_hash, authority_revision)
        VALUES ($1,$2,$3,$4,$5) ON CONFLICT(api_key_id) DO UPDATE SET user_id=$2,key_prefix=$3,secret_hash=$4,authority_revision=$5,updated_at=now()`,
        [command.apiKeyId, command.userId, command.keyPrefix, command.secretHash, revision],
      );
      return true;
    case "api-key-delete":
      await db.query("DELETE FROM identity_api_key_secrets WHERE api_key_id = $1", [command.apiKeyId]);
      return true;
    case "delegation-grant": {
      const p = command.params;
      return (
        await db.query<IdentityDelegationCredential>(
          `INSERT INTO identity_linked_platform_authorizations
        (authorization_id,platform_profile_url,client_id,user_id,account_id,scopes,status,access_token_hash,refresh_token_hash,access_token_expires_at,refresh_token_expires_at,granted_at,authority_revision)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,'active',$7,$8,$9,$10,$11,$12) RETURNING *`,
          [
            p.authorizationId,
            p.platformProfileUrl,
            p.clientId,
            p.userId,
            p.accountId,
            JSON.stringify([...new Set(p.scopes)].sort()),
            p.accessTokenHash,
            p.refreshTokenHash ?? null,
            p.accessTokenExpiresAt,
            p.refreshTokenExpiresAt ?? null,
            p.grantedAt,
            revision,
          ],
        )
      ).rows[0]!;
    }
    case "delegation-rotate": {
      const p = command.params;
      return (
        (
          await db.query<IdentityDelegationCredential>(
            `UPDATE identity_linked_platform_authorizations SET access_token_hash=$2,refresh_token_hash=$3,
        access_token_expires_at=$4,refresh_token_expires_at=$5,last_refreshed_at=$6,refresh_token_rotated_at=$6,authority_revision=$7,updated_at=now()
        WHERE authorization_id=$8 AND refresh_token_hash=$1 AND status='active' AND refresh_token_expires_at > now() RETURNING *`,
            [
              p.refreshTokenHash,
              p.newAccessTokenHash,
              p.newRefreshTokenHash,
              p.accessTokenExpiresAt,
              p.refreshTokenExpiresAt,
              p.refreshedAt,
              revision,
              command.authorizationId,
            ],
          )
        ).rows[0] ?? null
      );
    }
    case "delegation-revoke":
      return (
        ((
          await db.query(
            `UPDATE identity_linked_platform_authorizations SET status='revoked',revoked_at=$3,revocation_reason=$4,authority_revision=$5,updated_at=now()
        WHERE authorization_id=$1 AND account_id=$2 AND status='active'`,
            [command.authorizationId, command.accountId, command.revokedAt, command.reason, revision],
          )
        ).rowCount ?? 0) > 0
      );
  }
}

export const identityListingCredentialSchemaStatements = [
  "ALTER TABLE identity_api_key_secrets ADD COLUMN IF NOT EXISTS authority_revision text NULL;",
  "ALTER TABLE identity_linked_platform_authorizations ADD COLUMN IF NOT EXISTS authority_revision text NULL;",
  "CREATE INDEX IF NOT EXISTS identity_api_key_secrets_hash_idx ON identity_api_key_secrets(secret_hash);",
  `CREATE TABLE IF NOT EXISTS identity_listing_credential_mutations (
    mutation_id text PRIMARY KEY, command jsonb NOT NULL, context jsonb NOT NULL,
    applied boolean NOT NULL DEFAULT false, completed boolean NOT NULL DEFAULT false, result jsonb NULL);`,
  "CREATE INDEX IF NOT EXISTS identity_listing_credential_pending_idx ON identity_listing_credential_mutations(mutation_id) WHERE completed = false;",
] as const;
