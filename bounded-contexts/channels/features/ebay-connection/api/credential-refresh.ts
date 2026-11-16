import { withPgTransaction, type PgQueryable, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelCredentialEnvelope, ChannelOAuthTokenSet } from "../../credentials/domain/contracts";
import type { ChannelHealthObservation, ConnectionHealthServices } from "../../connection-health/domain/contracts";
import { healthDigest } from "../../connection-health/domain/identity";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { EbayConnectionError } from "../domain/oauth";
import { credentialDueAt, ebayMaintenanceRevision } from "../domain/credential-maintenance";
import { createRefreshSchedule, scheduleCredentialRefresh, type RefreshClaim } from "../read-model/refresh-schedule";
import type { EbayOAuthProvider } from "./provider";

export type CurrentEbayCredential = <T>(
  target: Readonly<{ accountId: string; connectionId: string }>,
  expectedGeneration: number,
  work: (db: PgQueryable, envelope: ChannelCredentialEnvelope, tokens: ChannelOAuthTokenSet) => Promise<T>,
  transaction?: PgQueryable,
) => Promise<T>;
export type CurrentEbayEnvelope = <T>(
  target: Readonly<{ accountId: string; connectionId: string }>,
  expectedGeneration: number,
  work: (db: PgQueryable, envelope: ChannelCredentialEnvelope) => Promise<T>,
  transaction?: PgQueryable,
) => Promise<T>;

class RefreshHealthRefused extends Error {}

// No executable eBay response has terminal authority. The injected classifier permits labeled synthetic controls.
export function createEbayCredentialRefresh(deps: {
  db: PgTransactionalPool;
  now: () => Date;
  health: ConnectionHealthServices;
  provider: EbayOAuthProvider | null;
  credentials: ReturnType<typeof createChannelCredentialRuntime>;
  current: CurrentEbayCredential;
  currentEnvelope: CurrentEbayEnvelope;
  classifyFailure?: (error: unknown) => "retryable" | "terminal";
}) {
  const schedule = createRefreshSchedule(deps.db, deps.now);
  async function observe(db: PgQueryable, claim: RefreshClaim, success: boolean) {
    const snapshot = await deps.health.readConnectionHealth(
      {
        connectionId: claim.connection_id,
        accountId: claim.account_id,
      },
      db,
    );
    const previous = snapshot.health.reasons.find((reason) => reason.reasonCode === "credential");
    // A new failure after recovery opens a new reason episode. Retries and matching recovery
    // retain that episode across token changes; work-cycle identity remains independent.
    const fingerprint =
      previous && (success || previous.state !== "closed")
        ? previous.fingerprint
        : healthDigest(["ebay-credential-reason", claim.connection_id, (previous?.generation ?? 0) + 1]);
    const observation: ChannelHealthObservation = {
      schemaVersion: "ChannelHealthObservation/v1",
      sourceKind: "credential",
      reasonCode: "credential",
      sourceWorkId: healthDigest([
        "ebay-credential-refresh",
        claim.connection_id,
        Number(claim.token_generation),
        ebayMaintenanceRevision,
        Number(claim.schedule_generation),
      ]),
      sourceAttempt: claim.attempt,
      resultOrdinal: 1,
      policyRevision: snapshot.health.policyRevision,
      evaluationGeneration: snapshot.health.evaluationGeneration,
      connectionId: claim.connection_id,
      fingerprint,
      outcome: success ? "success" : "failure",
      occurredAt: deps.now().toISOString(),
    };
    await db.query(
      `INSERT INTO channels_ebay_credential_refresh_outcomes
      (connection_id,token_generation,schedule_generation,attempt,observation) VALUES ($1,$2,$3,$4,$5)`,
      [
        claim.connection_id,
        claim.token_generation,
        claim.schedule_generation,
        claim.attempt,
        JSON.stringify(observation),
      ],
    );
    const submission = await deps.health.submitObservation(observation, claim.context, db);
    if (submission.outcome !== "accepted" && submission.outcome !== "replayed")
      throw new RefreshHealthRefused(submission.outcome);
  }
  async function initialize(
    db: PgQueryable,
    envelope: ChannelCredentialEnvelope,
    tokens: ChannelOAuthTokenSet,
    context: EventStoreContext,
  ) {
    const admitted = await scheduleCredentialRefresh(db, envelope, tokens, context, deps.now());
    if (!admitted)
      await observe(
        db,
        {
          connection_id: envelope.connectionId,
          account_id: envelope.accountId,
          token_generation: String(envelope.tokenGeneration),
          schedule_generation: "1",
          attempt: 1,
          lease_id: "initial-admission",
          context,
        },
        false,
      );
  }
  return {
    initialize,
    claim: schedule.claim,
    async process(claim: RefreshClaim) {
      if (!deps.provider) return false;
      let result: { tokens: ChannelOAuthTokenSet } | { terminal: boolean };
      try {
        const retained = await deps.current(
          { accountId: claim.account_id, connectionId: claim.connection_id },
          Number(claim.token_generation),
          async (db, _envelope, tokens) => {
            if (!(await schedule.lock(db, claim))) return null;
            const snapshot = await deps.health.readConnectionHealth(
              { accountId: claim.account_id, connectionId: claim.connection_id },
              db,
            );
            return snapshot.connection.status === "paused" ? null : tokens;
          },
        );
        if (!retained) return false;
        const tokens = await deps.provider.refresh(retained, AbortSignal.timeout(20000));
        result = { tokens };
      } catch (error) {
        if (error instanceof EbayConnectionError && error.code === "stale-authorization") return false;
        result = { terminal: deps.classifyFailure?.(error) === "terminal" };
      }
      try {
        return await withPgTransaction(deps.db, async (db) =>
          deps.currentEnvelope(
            { accountId: claim.account_id, connectionId: claim.connection_id },
            Number(claim.token_generation),
            async (db, envelope) => {
              if (!(await schedule.lock(db, claim))) return false;
              if ("tokens" in result && credentialDueAt(result.tokens, deps.now())) {
                const after = await deps.credentials.replace(db, envelope, result.tokens, deps.now().toISOString());
                await observe(db, claim, true);
                await scheduleCredentialRefresh(db, after, result.tokens, claim.context, deps.now(), claim);
              } else {
                await observe(db, claim, false);
                await schedule.fail(db, claim, "tokens" in result || result.terminal);
              }
              return true;
            },
            db,
          ),
        );
      } catch (error) {
        // A refused observation rolls back custody, journal and schedule together. Keep the
        // leased attempt/cycle for recovery, including when pause races the provider response.
        if (error instanceof RefreshHealthRefused) return false;
        if (error instanceof EbayConnectionError && error.code === "stale-authorization") return false;
        throw error;
      }
    },
    async sweep() {
      if (!deps.provider) return 0;
      // Existing OAuth connections predate this slice. Seed missing rows from encrypted custody,
      // under the physical seller-binding fence, without resetting retained cycles.
      const missing = await deps.db.query<{
        account_id: string;
        connection_id: string;
        token_generation: string;
        tenant_id: EventStoreContext["tenantId"];
        for_account_id: EventStoreContext["audit"]["forAccountId"];
      }>(
        `SELECT c.account_id,c.connection_id,c.token_generation,e.tenant_id,e.for_account_id
        FROM channels_connection_credentials c
        JOIN channels_ebay_seller_bindings b ON b.current_connection_id=c.connection_id AND b.credential_reference=c.row_id
        JOIN event_store_events e ON e.stream_id='channels.connection-' || c.connection_id AND e.stream_version=1
        WHERE c.provider_key='ebay' AND c.environment='sandbox'
          AND NOT EXISTS (SELECT 1 FROM channels_ebay_credential_refresh r WHERE r.connection_id=c.connection_id)
        ORDER BY c.connection_id LIMIT 100`,
      );
      for (const row of missing.rows) {
        try {
          await withPgTransaction(deps.db, (db) =>
            deps.current(
              { accountId: row.account_id, connectionId: row.connection_id },
              Number(row.token_generation),
              async (db, envelope, tokens) => {
                const existing = await db.query(
                  "SELECT 1 FROM channels_ebay_credential_refresh WHERE connection_id=$1",
                  [row.connection_id],
                );
                if (!existing.rows.length)
                  await initialize(db, envelope, tokens, {
                    tenantId: row.tenant_id,
                    audit: { performedByUserId: "usr_channels_worker", forAccountId: row.for_account_id },
                  });
              },
              db,
            ),
          );
        } catch (error) {
          if (!(error instanceof EbayConnectionError) || error.code !== "stale-authorization") throw error;
        }
      }
      let processed = 0;
      for (let count = 0; count < 100; count++) {
        const claim = await schedule.claim();
        if (!claim) break;
        if (await this.process(claim)) processed++;
      }
      return processed;
    },
    async replay(connectionId: string) {
      const rows = await deps.db.query<{
        observation: ChannelHealthObservation;
        tenant_id: EventStoreContext["tenantId"];
        for_account_id: EventStoreContext["audit"]["forAccountId"];
      }>(
        `SELECT o.observation, e.tenant_id, e.for_account_id FROM channels_ebay_credential_refresh_outcomes o
        JOIN LATERAL (SELECT tenant_id,for_account_id FROM event_store_events WHERE stream_id=$2
          ORDER BY stream_version LIMIT 1) e ON true
        WHERE o.connection_id=$1 ORDER BY o.token_generation,o.schedule_generation,o.attempt`,
        [connectionId, `channels.connection-${connectionId}`],
      );
      return Promise.all(
        rows.rows.map(({ observation, tenant_id, for_account_id }) =>
          deps.health.submitObservation(observation, {
            tenantId: tenant_id,
            audit: { performedByUserId: "usr_channels_worker", forAccountId: for_account_id },
          }),
        ),
      );
    },
  };
}
