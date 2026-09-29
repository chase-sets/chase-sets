import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { isDeepStrictEqual } from "node:util";

export type SessionTokenRecord = Readonly<{
  session_id: string;
  token_hash: string;
  token_revision: string | null;
  expires_at: string;
}>;

export type SessionTokenMutation = Readonly<{
  mutationId: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: string;
  context: EventStoreContext;
}>;

/** Secrets stay in this Auth-owned table, never in the authority event journal. */
export function createSessionTokenStore(db: PgQueryable) {
  async function readMutation(mutationId: string) {
    const result = await db.query<{
      mutation_id: string;
      session_id: string;
      token_hash: string;
      expires_at: string;
      context: EventStoreContext;
      applied: boolean;
    }>(
      `SELECT mutation_id, session_id, token_hash, expires_at, context, applied
       FROM auth_session_token_mutations WHERE mutation_id = $1`,
      [mutationId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      mutationId: row.mutation_id,
      sessionId: row.session_id,
      tokenHash: row.token_hash,
      expiresAt: new Date(row.expires_at).toISOString(),
      context: row.context,
      applied: row.applied,
    };
  }
  return {
    async pending(limit: number, after = "") {
      const result = await db.query<{ mutation_id: string }>(
        `SELECT mutation_id FROM auth_session_token_mutations
         WHERE completed = false AND mutation_id > $2 ORDER BY mutation_id LIMIT $1`,
        [limit, after],
      );
      return result.rows.map((row) => row.mutation_id);
    },
    async complete(mutationId: string) {
      await db.query(
        `UPDATE auth_session_token_mutations SET completed = true WHERE mutation_id = $1 AND applied = true`,
        [mutationId],
      );
    },
    async read(sessionId: string): Promise<SessionTokenRecord | null> {
      const result = await db.query<SessionTokenRecord>(
        `SELECT session_id, token_hash, token_revision, expires_at FROM identity_session_tokens WHERE session_id = $1`,
        [sessionId],
      );
      return result.rows[0] ?? null;
    },
    async authenticate(tokenHash: string): Promise<SessionTokenRecord | null> {
      const result = await db.query<SessionTokenRecord>(
        `SELECT session_id, token_hash, token_revision, expires_at FROM identity_session_tokens WHERE token_hash = $1`,
        [tokenHash],
      );
      return result.rows[0] ?? null;
    },
    readMutation,
    async stage(input: SessionTokenMutation) {
      if (!input.mutationId || !input.sessionId || !input.tokenHash || !Number.isFinite(Date.parse(input.expiresAt)))
        throw new Error("Invalid session token mutation.");
      await db.query(
        `INSERT INTO auth_session_token_mutations
           (mutation_id, session_id, token_hash, expires_at, context, applied)
         VALUES ($1, $2, $3, $4, $5::jsonb, false) ON CONFLICT (mutation_id) DO NOTHING`,
        [input.mutationId, input.sessionId, input.tokenHash, input.expiresAt, JSON.stringify(input.context)],
      );
      const retained = await readMutation(input.mutationId);
      if (
        !retained ||
        !isDeepStrictEqual(
          { ...retained, applied: undefined },
          {
            ...input,
            context: JSON.parse(JSON.stringify(input.context)),
            expiresAt: new Date(input.expiresAt).toISOString(),
            applied: undefined,
          },
        )
      )
        throw new Error("Session token mutation identity conflict.");
    },
    async apply(mutationId: string) {
      // One SQL statement claims the immutable mutation AND replaces the credential.
      // PostgreSQL rechecks applied after a competing row lock. A delayed duplicate
      // cannot overwrite a later credential, including after a lost success reply.
      await db.query(
        `WITH claimed AS (
           UPDATE auth_session_token_mutations SET applied = true
           WHERE mutation_id = $1 AND applied = false
           RETURNING mutation_id, session_id, token_hash, expires_at
         )
         INSERT INTO identity_session_tokens
           (session_id, token_hash, token_revision, expires_at, created_at, updated_at)
         SELECT session_id, token_hash, mutation_id, expires_at, now(), now() FROM claimed
         ON CONFLICT (session_id) DO UPDATE SET token_hash = EXCLUDED.token_hash,
           token_revision = EXCLUDED.token_revision, expires_at = EXCLUDED.expires_at, updated_at = now()`,
        [mutationId],
      );
      const retained = await readMutation(mutationId);
      if (!retained?.applied) throw new Error("Session token mutation has no durable receipt.");
    },
  };
}

export type SessionTokenStore = ReturnType<typeof createSessionTokenStore>;
