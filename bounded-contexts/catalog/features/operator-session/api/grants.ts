import { createHash, randomBytes, randomUUID } from "node:crypto";
import { withPgTransaction, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { ResolvedActor } from "@chase-sets/auth-context";

type Action = "mint" | "unpair";

function invalid() {
  return Response.json({ code: "grant-invalid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

export function createOperatorSessionGrants(pool: PgTransactionalPool) {
  return {
    async execute(action: Action, request: Request, actor?: ResolvedActor | null): Promise<Response> {
      if (action === "mint") {
        if (!actor) return Response.json({ code: "forbidden" }, { status: 403 });
        const bearer = randomBytes(32).toString("base64url");
        const result = await withPgTransaction(pool, async (db) => {
          await db.query(
            `UPDATE catalog_operator_session_grants
             SET revoked_at = clock_timestamp(), revoke_reason = 'replaced'
             WHERE revoked_at IS NULL`,
          );
          return db.query<{ idle_expires_at: Date }>(
            `WITH instant AS (SELECT clock_timestamp() AS t)
             INSERT INTO catalog_operator_session_grants
               (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
             SELECT $1, $2, $3, $4, t, t, t + interval '30 days' FROM instant
             RETURNING idle_expires_at`,
            [randomUUID(), createHash("sha256").update(bearer, "ascii").digest(), actor.userId, actor.membershipId],
          );
        });
        return Response.json(
          { grant: bearer, idleExpiresAt: result.rows[0]!.idle_expires_at.toISOString() },
          { headers: { "Cache-Control": "no-store" } },
        );
      }

      const authorization = request.headers.get("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
      if (!bearer) return invalid();
      const hash = createHash("sha256").update(bearer, "ascii").digest();
      const revoked = await pool.query(
        `UPDATE catalog_operator_session_grants
         SET revoked_at = clock_timestamp(), revoke_reason = 'unpair'
         WHERE token_hash = $1 AND revoked_at IS NULL AND clock_timestamp() < idle_expires_at
         RETURNING id`,
        [hash],
      );
      return revoked.rows.length ? Response.json({ outcome: "revoked" }) : invalid();
    },
  };
}
