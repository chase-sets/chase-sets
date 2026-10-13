import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import {
  assertRevocationActivationProof,
  revocationActivationProofDigest as digest,
  type RevocationActivationProof,
} from "./revocation-floor";

export type RevocationMembershipFence = Readonly<{
  revalidate: () => Promise<RevocationActivationProof>;
}>;

const streamId = "identity.agent-grant-revocation-release-v1";

export function withDormantAgentGrantWrite<T>(pool: PgTransactionalPool, work: (db: PgQueryable) => Promise<T>) {
  return withPgTransaction(pool, async (db) => {
    await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [streamId]);
    const activated = await db.query("SELECT 1 FROM event_store_events WHERE stream_id = $1 LIMIT 1", [streamId]);
    if (activated.rows.length) throw new Error("revocation_dormant_write_closed");
    return work(db);
  });
}

export function createAgentGrantRevocationRelease(
  pool: PgTransactionalPool,
  eventStore: PostgresEventStore,
  instanceId = hostname(),
) {
  const read = async (db: PgQueryable) => {
    const events = await readCompleteStream(
      { readStream: (input) => eventStore.readStreamInTransaction(db, input) },
      { streamId, maxEvents: 500 },
    );
    if (!events.length) return null;
    const event = events[0];
    if (
      events.length !== 1 ||
      event.streamVersion !== 1 ||
      event.eventType !== "identity.agent-grant-revocation-release.activated" ||
      Object.keys(event.payload).sort().join() !== "proof,proofDigest,reconciledDormantRequests,supportVersion" ||
      event.payload.supportVersion !== 1 ||
      typeof event.payload.proofDigest !== "string" ||
      !Number.isSafeInteger(event.payload.reconciledDormantRequests) ||
      Number(event.payload.reconciledDormantRequests) < 0 ||
      Buffer.byteLength(JSON.stringify(events), "utf8") > 128 * 1024
    )
      throw new Error("revocation_support_floor");
    const proof = event.payload.proof as RevocationActivationProof;
    assertRevocationActivationProof(proof, proof?.capturedAt);
    if (event.payload.proofDigest !== digest(proof)) throw new Error("revocation_support_floor");
    return event;
  };

  return {
    requireActivated: async (db: PgQueryable) => {
      if (!(await read(db))) throw new Error("revocation_support_floor");
    },
    isActivated: async () => Boolean(await read(pool)),
    activationProof: () =>
      withPgTransaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [streamId]);
        return (await read(db))?.payload.proof as RevocationActivationProof | undefined;
      }),
    withMode: async <T>(work: (activated: boolean) => Promise<T>): Promise<T> => {
      const requestId = randomUUID();
      const activated = await withPgTransaction(pool, async (db) => {
        await db.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [streamId]);
        const activated = Boolean(await read(db));
        if (!activated) {
          await db.query(
            "INSERT INTO identity_agent_grant_dormant_requests (request_id, instance_id) VALUES ($1, $2)",
            [requestId, instanceId],
          );
        }
        return activated;
      });
      try {
        return await work(activated);
      } finally {
        // Admission commits before the unchanged dormant writes/effects. It
        // survives process loss and prevents activation while code can still run.
        if (!activated)
          await pool.query("DELETE FROM identity_agent_grant_dormant_requests WHERE request_id = $1", [requestId]);
      }
    },
    activate: (proof: RevocationActivationProof, context: EventStoreContext, fence: RevocationMembershipFence) =>
      withPgTransaction(pool, async (db) => {
        if (
          !fence?.revalidate ||
          context?.tenantId !== "tnt_identity" ||
          context?.audit?.performedByUserId !== "usr_identity_deployment" ||
          context?.audit?.forAccountId !== "acc_identity_deployment"
        )
          throw new Error("revocation_activation_authority_required");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [streamId]);
        const previous = await read(db);
        assertRevocationActivationProof(proof, previous ? proof?.capturedAt : new Date().toISOString());
        if (previous) {
          if (previous.payload.proofDigest !== digest(proof)) throw new Error("revocation_activation_conflict");
          return;
        }
        const unresolved = await db.query(
          "SELECT request_id FROM identity_agent_grant_dormant_requests WHERE instance_id = ANY($1::text[]) LIMIT 1",
          [proof.expectedReplicas],
        );
        if (unresolved.rows.length) throw new Error("revocation_dormant_request_unresolved");
        // All revoked rows become discoverable in the same Identity transaction
        // as activation. No historical cleanup success or user intent is inferred.
        await db.query(`INSERT INTO identity_agent_grant_revocation_work (account_id, grant_id)
          SELECT account_id, authorization_id FROM identity_linked_platform_authorizations WHERE status = 'revoked'
          ON CONFLICT (account_id, grant_id) DO NOTHING`);
        const reconciled = await db.query("DELETE FROM identity_agent_grant_dormant_requests RETURNING request_id");
        const current = await fence.revalidate();
        assertRevocationActivationProof(current, new Date().toISOString());
        const membership = (value: RevocationActivationProof) => ({ ...value, capturedAt: "" });
        if (digest(membership(current)) !== digest(membership(proof))) throw new Error("revocation_membership_changed");
        await eventStore.appendToStreamInTransaction(db, {
          streamId,
          expectedVersion: 0,
          context,
          events: [
            {
              eventType: "identity.agent-grant-revocation-release.activated",
              payload: {
                supportVersion: 1,
                proof,
                proofDigest: digest(proof),
                reconciledDormantRequests: reconciled.rows.length,
              },
            },
          ],
        });
      }),
  };
}
