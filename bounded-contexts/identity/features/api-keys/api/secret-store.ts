import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { IdentityListingAuthorityServices } from "../../access-hub/api/listing-authority";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { randomUUID } from "node:crypto";

export async function upsertApiKeySecret(
  authority: IdentityListingAuthorityServices,
  params: Readonly<{
    apiKeyId: string;
    userId: string;
    keyPrefix: string;
    secretHash: string;
    context: EventStoreContext;
    mutationId?: string;
  }>,
) {
  const { context, mutationId = randomUUID(), ...command } = params;
  await authority.mutateCredential({ mutationId, context, command: { kind: "api-key-upsert", ...command } });
}

export async function getApiKeySecretByPrefix(db: PgQueryable, keyPrefix: string) {
  const result = await db.query<{
    api_key_id: string;
    user_id: string;
    key_prefix: string;
    secret_hash: string;
  }>(
    `SELECT api_key_id, user_id, key_prefix, secret_hash
     FROM identity_api_key_secrets
     WHERE key_prefix = $1`,
    [keyPrefix],
  );

  return result.rows[0] ?? null;
}

export async function deleteApiKeySecret(
  authority: IdentityListingAuthorityServices,
  apiKeyId: string,
  context: EventStoreContext,
  mutationId = randomUUID(),
) {
  await authority.mutateCredential({ mutationId, context, command: { kind: "api-key-delete", apiKeyId } });
}
