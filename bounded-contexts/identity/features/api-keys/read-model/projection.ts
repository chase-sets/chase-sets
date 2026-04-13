import type { ProjectorHandlerMap } from "@chase-sets/event-core/projector";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { extractIdFromStreamId } from "../../../support/read-model-support/extract-id-from-stream";

const STREAM_PREFIX = "identity.api-key-";

async function upsertApiKeyLookup(
  db: PgQueryable,
  keyPrefix: string,
  apiKeyId: string,
  userId: string,
  status: string,
  updatedAt: string,
) {
  await db.query(
    `INSERT INTO identity_api_key_lookup (
       key_prefix,
       api_key_id,
       user_id,
       status,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (key_prefix) DO UPDATE
     SET api_key_id = $2,
         user_id = $3,
         status = $4,
         updated_at = $5`,
    [keyPrefix, apiKeyId, userId, status, updatedAt],
  );
}

export function buildApiKeyProjectionHandlers(
  db: PgQueryable,
): ProjectorHandlerMap {
  return {
    "identity.api-key.created": async (event) => {
      const { apiKeyId, userId, name, keyPrefix } = event.data as {
        apiKeyId: string;
        userId: string;
        name: string;
        keyPrefix: string;
      };
      await db.query(
        `INSERT INTO identity_api_keys (
           api_key_id,
           user_id,
           name,
           key_prefix,
           status,
           last_used_at,
           updated_at
         )
         VALUES ($1, $2, $3, $4, 'active', NULL, $5)
         ON CONFLICT (api_key_id) DO UPDATE
         SET user_id = $2,
             name = $3,
             key_prefix = $4,
             status = 'active',
             updated_at = $5`,
        [apiKeyId, userId, name, keyPrefix, event.timing.recordedAt],
      );
      await upsertApiKeyLookup(
        db,
        keyPrefix,
        apiKeyId,
        userId,
        "active",
        event.timing.recordedAt,
      );
    },
    "identity.api-key.rotated": async (event) => {
      const apiKeyId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const existing = await db.query<{ user_id: string }>(
        `SELECT user_id FROM identity_api_keys WHERE api_key_id = $1`,
        [apiKeyId],
      );
      const userId = existing.rows[0]?.user_id;
      const keyPrefix = (event.data as { keyPrefix: string }).keyPrefix;
      await db.query(
        `UPDATE identity_api_keys
         SET key_prefix = $2,
             updated_at = $3
         WHERE api_key_id = $1`,
        [apiKeyId, keyPrefix, event.timing.recordedAt],
      );
      if (userId) {
        await upsertApiKeyLookup(
          db,
          keyPrefix,
          apiKeyId,
          userId,
          "active",
          event.timing.recordedAt,
        );
      }
    },
    "identity.api-key.revoked": async (event) => {
      const apiKeyId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      const existing = await db.query<{ key_prefix: string; user_id: string }>(
        `SELECT key_prefix, user_id FROM identity_api_keys WHERE api_key_id = $1`,
        [apiKeyId],
      );
      await db.query(
        `UPDATE identity_api_keys
         SET status = 'revoked',
             updated_at = $2
         WHERE api_key_id = $1`,
        [apiKeyId, event.timing.recordedAt],
      );
      const row = existing.rows[0];
      if (row) {
        await upsertApiKeyLookup(
          db,
          row.key_prefix,
          apiKeyId,
          row.user_id,
          "revoked",
          event.timing.recordedAt,
        );
      }
    },
    "identity.api-key.used": async (event) => {
      const apiKeyId = extractIdFromStreamId(event.streamId, STREAM_PREFIX);
      await db.query(
        `UPDATE identity_api_keys
         SET last_used_at = $2,
             updated_at = $3
         WHERE api_key_id = $1`,
        [
          apiKeyId,
          (event.data as { usedAt: string }).usedAt,
          event.timing.recordedAt,
        ],
      );
    },
  };
}
