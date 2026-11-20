import { randomUUID } from "node:crypto";
import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelCredentialEnvelope, ChannelOAuthTokenSet } from "../../credentials/domain/contracts";
import {
  admitsCredentialLifetime,
  credentialDueAt,
  ebayCredentialMaintenancePolicy,
} from "../domain/credential-maintenance";

export type RefreshClaim = {
  connection_id: string;
  account_id: string;
  token_generation: string;
  schedule_generation: string;
  attempt: number;
  lease_id: string;
  context: EventStoreContext;
};
export async function retireCredentialRefresh(db: PgQueryable, connectionId: string) {
  await db.query("DELETE FROM channels_ebay_credential_refresh WHERE connection_id=$1", [connectionId]);
}

export async function scheduleCredentialRefresh(
  db: PgQueryable,
  envelope: ChannelCredentialEnvelope,
  tokens: ChannelOAuthTokenSet,
  context: EventStoreContext,
  completedAt: Date,
  prior?: RefreshClaim,
) {
  const dueAt = prior
    ? credentialDueAt(tokens, completedAt)
    : admitsCredentialLifetime(tokens)
      ? new Date(
          Date.parse(tokens.accessExpiresAt!) - ebayCredentialMaintenancePolicy.defaultValue.refreshLeadSeconds * 1000,
        )
      : null;
  const sameGeneration = prior && Number(prior.token_generation) === envelope.tokenGeneration;
  const cycle = sameGeneration ? Number(prior.schedule_generation) + 1 : 1;
  if (!Number.isSafeInteger(cycle)) throw new Error("ebay-refresh-cycle-exhausted");
  if (!sameGeneration) await retireCredentialRefresh(db, envelope.connectionId);
  await db.query(
    `INSERT INTO channels_ebay_credential_refresh
      (connection_id,token_generation,account_id,context,schedule_generation,attempt,due_at,lease_id,lease_until,last_outcome)
    VALUES ($1,$2,$3,$4,$5,0,$6,NULL,NULL,$7)
    ON CONFLICT (connection_id,token_generation) DO UPDATE SET schedule_generation=EXCLUDED.schedule_generation,
      attempt=0,due_at=EXCLUDED.due_at,lease_id=NULL,lease_until=NULL,last_outcome=EXCLUDED.last_outcome`,
    [
      envelope.connectionId,
      envelope.tokenGeneration,
      envelope.accountId,
      JSON.stringify(context),
      cycle,
      dueAt,
      dueAt ? (prior ? "succeeded" : "never") : "terminal",
    ],
  );
  return dueAt !== null;
}

export function createRefreshSchedule(pool: PgTransactionalPool, now: () => Date) {
  return {
    async claim(): Promise<RefreshClaim | null> {
      return withPgTransaction(pool, async (db) => {
        const at = now();
        const result = await db.query<RefreshClaim>(
          `WITH candidate AS (
            SELECT connection_id,token_generation FROM channels_ebay_credential_refresh
            WHERE due_at IS NOT NULL AND COALESCE(lease_until,due_at)<=$1
              AND (lease_id IS NOT NULL OR attempt<$4)
            ORDER BY COALESCE(lease_until,due_at),connection_id FOR UPDATE SKIP LOCKED LIMIT 1
          ) UPDATE channels_ebay_credential_refresh r
          SET attempt=CASE WHEN r.lease_id IS NULL THEN r.attempt+1 ELSE r.attempt END,
            lease_id=$2,lease_until=$3 FROM candidate c
          WHERE r.connection_id=c.connection_id AND r.token_generation=c.token_generation
          RETURNING r.*`,
          [at, randomUUID(), new Date(at.getTime() + 60000), ebayCredentialMaintenancePolicy.defaultValue.maxAttempts],
        );
        return result.rows[0] ?? null;
      });
    },
    async lock(db: PgQueryable, claim: RefreshClaim): Promise<boolean> {
      const result = await db.query(
        `SELECT 1 FROM channels_ebay_credential_refresh WHERE connection_id=$1 AND token_generation=$2
          AND schedule_generation=$3 AND attempt=$4 AND lease_id=$5 AND lease_until>$6 FOR UPDATE`,
        [claim.connection_id, claim.token_generation, claim.schedule_generation, claim.attempt, claim.lease_id, now()],
      );
      return result.rows.length === 1;
    },
    async fail(db: PgQueryable, claim: RefreshClaim, terminal: boolean) {
      const policy = ebayCredentialMaintenancePolicy.defaultValue;
      const exhausted = claim.attempt === policy.maxAttempts;
      const outcome = terminal ? "terminal" : exhausted ? "exhausted" : "retryable";
      const dueAt =
        terminal || exhausted
          ? null
          : new Date(now().getTime() + policy.retryBackoffSeconds[claim.attempt - 1]! * 1000);
      await db.query(
        `UPDATE channels_ebay_credential_refresh SET last_outcome=$6,due_at=$7,lease_id=NULL,lease_until=NULL
        WHERE connection_id=$1 AND token_generation=$2 AND schedule_generation=$3 AND attempt=$4 AND lease_id=$5`,
        [
          claim.connection_id,
          claim.token_generation,
          claim.schedule_generation,
          claim.attempt,
          claim.lease_id,
          outcome,
          dueAt,
        ],
      );
      return outcome;
    },
  };
}
