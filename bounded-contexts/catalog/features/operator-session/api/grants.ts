import { createHash, randomBytes, randomUUID } from "node:crypto";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createInMemoryRateLimiter } from "@chase-sets/http/rate-limit";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { withOperatorSessionBackend } from "./operation";
import { OperatorSessionRequestError, readGrantBearer, requireEmptyBody } from "./request";

type Action = "metadata" | "mint" | "disconnect" | "unpair";
type GrantRow = { id: string; active: boolean; created_at: Date; last_used_at: Date; idle_expires_at: Date };
const invalid = () => new OperatorSessionRequestError("grant-invalid", 401);

export function createOperatorSessionGrants(pool: PgTransactionalPool) {
  const globalLimit = createInMemoryRateLimiter({ max: 120, windowMs: 60_000, maxBuckets: 1 });
  const grantLimit = createInMemoryRateLimiter({ max: 6, windowMs: 60_000 });
  let operations = 0;
  function limited(seconds = 1) {
    return Response.json(
      { code: "rate-limited" },
      { status: 429, headers: { "Retry-After": String(seconds), "Cache-Control": "no-store" } },
    );
  }
  async function revoke(db: PgQueryable, reason: "disconnect" | "replaced") {
    await db.query(
      `UPDATE catalog_operator_session_grants SET revoked_at = clock_timestamp(), revoke_reason = $1 WHERE revoked_at IS NULL`,
      [reason],
    );
  }
  async function authenticate(db: PgQueryable, hash: Buffer) {
    const result = await db.query<{ id: string }>(
      `SELECT id FROM catalog_operator_session_grants WHERE token_hash = $1 AND revoked_at IS NULL AND clock_timestamp() < idle_expires_at`,
      [hash],
    );
    if (!result.rows[0]) throw invalid();
    return result.rows[0].id;
  }
  return {
    async execute(action: Action, request: Request, actor?: ResolvedActor | null): Promise<Response> {
      let admitted = false;
      try {
        const global = globalLimit.check("operator-session");
        if (global.limited) return limited(global.retryAfterSeconds);
        if (operations >= 4) return limited();
        operations++;
        admitted = true;
        const hash =
          action === "unpair" ? createHash("sha256").update(readGrantBearer(request), "ascii").digest() : null;
        if (action !== "metadata") await requireEmptyBody(request);
        const result = await withOperatorSessionBackend(pool, async (bound) => {
          if (action === "metadata") {
            const grant = (
              await bound.query<GrantRow>(
                `SELECT id, created_at, last_used_at, idle_expires_at, (revoked_at IS NULL AND clock_timestamp() < idle_expires_at) AS active
                 FROM catalog_operator_session_grants ORDER BY (revoked_at IS NULL) DESC, created_at DESC, id DESC LIMIT 1`,
              )
            ).rows[0];
            return {
              revision: 0,
              storedAt: null,
              browserExpiresAt: null,
              custodyAvailable: false,
              grant: grant
                ? {
                    active: grant.active,
                    createdAt: grant.created_at.toISOString(),
                    idleExpiresAt: grant.idle_expires_at.toISOString(),
                    lastUsedAt: grant.last_used_at.toISOString(),
                  }
                : null,
            };
          }
          if (action === "mint") {
            if (!actor) throw new OperatorSessionRequestError("forbidden", 403);
            const bearer = randomBytes(32).toString("base64url");
            return withPgTransaction(bound, async (db) => {
              await revoke(db, "replaced");
              const inserted = await db.query<{ idle_expires_at: Date }>(
                `WITH instant AS (SELECT clock_timestamp() AS t)
                 INSERT INTO catalog_operator_session_grants
                   (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
                 SELECT $1, $2, $3, $4, t, t, t + interval '30 days' FROM instant RETURNING idle_expires_at`,
                [randomUUID(), createHash("sha256").update(bearer, "ascii").digest(), actor.userId, actor.membershipId],
              );
              return { grant: bearer, idleExpiresAt: inserted.rows[0]!.idle_expires_at.toISOString() };
            });
          }
          if (action === "disconnect") {
            return withPgTransaction(bound, async (db) => {
              await revoke(db, "disconnect");
              return { outcome: "cleared" as const, revision: 0 };
            });
          }
          if (!hash) throw invalid();
          const id = await authenticate(bound, hash);
          const grant = grantLimit.check(id);
          if (grant.limited) return limited(grant.retryAfterSeconds);
          return withPgTransaction(bound, async (db) => {
            const revoked = await db.query(
              `UPDATE catalog_operator_session_grants SET revoked_at = clock_timestamp(), revoke_reason = 'unpair'
               WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL AND clock_timestamp() < idle_expires_at RETURNING id`,
              [id, hash],
            );
            if (!revoked.rows.length) throw invalid();
            return { outcome: "revoked" as const };
          });
        });
        return Response.json(result, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const failure =
          error instanceof OperatorSessionRequestError
            ? error
            : new OperatorSessionRequestError("custody-unavailable", 503);
        return Response.json(
          { code: failure.code },
          { status: failure.status, headers: { "Cache-Control": "no-store" } },
        );
      } finally {
        if (admitted) operations--;
      }
    },
  };
}
