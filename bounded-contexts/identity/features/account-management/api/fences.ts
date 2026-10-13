import { createCheckpointKey } from "@chase-sets/bounded-context-runtime";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import { createEventStoreError, type EventStore } from "@chase-sets/event-core/event-store";
import type { AppendToStreamInput, StoredEvent } from "@chase-sets/event-core/storage";
import {
  readGapSafeEventStoreHead,
  type PgPoolClient,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import manifest from "../../../context.json" with { type: "json" };
import { validateOwnerHistory } from "./owners";

type ScopeEvent = Readonly<{ eventType: string; payload: Readonly<Record<string, unknown>> }>;
export type IdentityMutationTransaction = Readonly<{
  db: PgQueryable;
  read: (streamId: string) => Promise<readonly StoredEvent[]>;
  append: PostgresEventStore["appendToStreams"];
  projectionPredicate: (
    projectionName: "identity-membership-projection" | "identity-consent-current-state-projection",
    parameters: readonly unknown[],
  ) => Promise<readonly Readonly<{ count?: string; consent_id?: string }>[]>;
}>;
export type IdentityMutationPersistence = Readonly<{
  eventStore: EventStore;
  transaction: <T>(
    scopes: readonly string[],
    work: (transaction: IdentityMutationTransaction) => Promise<T>,
  ) => Promise<T>;
}>;

export function eligibilityScopeKeys(
  tenantId: string,
  streamId: string,
  events: readonly ScopeEvent[],
): readonly string[] {
  if (streamId.startsWith("identity.account-acc_"))
    return [JSON.stringify(["identity", tenantId, "account", streamId.slice("identity.account-".length)])];
  if (streamId.startsWith("identity.membership-")) {
    const grant = events.find((event) => event.eventType === "identity.membership.granted");
    if (typeof grant?.payload.accountId !== "string") throw new Error("INDETERMINATE");
    return [JSON.stringify(["identity", tenantId, "account", grant.payload.accountId])];
  }
  if (streamId.startsWith("identity.consent-")) {
    const record = events.find((event) => event.eventType === "identity.consent.recorded");
    const payload = record?.payload;
    const subjectId =
      payload?.subjectType === "user" ? payload.userId : payload?.subjectType === "account" ? payload.accountId : null;
    if (typeof subjectId !== "string" || typeof payload?.policyKey !== "string") throw new Error("INDETERMINATE");
    return [JSON.stringify(["identity", tenantId, "consent", payload.subjectType, subjectId, payload.policyKey])];
  }
  return [];
}

export async function lockEligibilityScopes(db: PgQueryable, scopes: readonly string[]): Promise<void> {
  for (const scope of [...new Set(scopes)].sort()) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7168))", [scope]);
  }
}

async function connectBounded(pool: PgTransactionalPool): Promise<PgPoolClient> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = pool.connect().then((client) => {
    if (timedOut) {
      client.release();
      throw new Error("INDETERMINATE");
    }
    return client;
  });
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error("INDETERMINATE"));
        }, 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createIdentityMutationPersistence(
  pool: PgTransactionalPool,
  store: PostgresEventStore,
): IdentityMutationPersistence {
  async function transaction<T>(
    scopes: readonly string[],
    work: (transaction: IdentityMutationTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await connectBounded(pool);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await lockEligibilityScopes(client, scopes);
      const result = await work({
        db: client,
        read: async (streamId) => {
          const history = await readCompleteStream(
            { readStream: (input) => store.readStreamInTransaction(client, input) },
            { streamId, maxEvents: 10000 },
          );
          const head = await client.query<{ current_version: number }>(
            "SELECT current_version FROM event_store_streams WHERE stream_id = $1",
            [streamId],
          );
          if (Number(head.rows[0]?.current_version ?? 0) !== history.length) throw new Error("INDETERMINATE");
          return history;
        },
        append: (inputs) => store.appendToStreamsInTransaction(client, inputs),
        projectionPredicate: async (projectionName, parameters) => {
          // Autocommit horizon observation, never the command transaction's global lock.
          const horizonClient = await connectBounded(pool);
          let horizon;
          try {
            await horizonClient.query("SET statement_timeout = '2s'");
            horizon = await readGapSafeEventStoreHead({
              query: horizonClient.query.bind(horizonClient),
              connect: pool.connect.bind(pool),
            });
          } finally {
            try {
              await horizonClient.query("RESET statement_timeout");
            } finally {
              horizonClient.release();
            }
          }
          const group = manifest.projectionGroups.find((candidate) => candidate.projectionName === projectionName);
          if (!group) throw new Error("INDETERMINATE");
          const revision = "projectionRevision" in group ? group.projectionRevision : 1;
          const checkpointKey = createCheckpointKey({
            projectionName,
            sourceContextName: "identity",
            subscriptionVersion: 1,
          });
          // Reset and cutover take these same rows FOR UPDATE before replacing projection data.
          const generation = await client.query(
            `SELECT g.active_generation FROM event_projection_group_generations g
             JOIN event_projection_group_revisions v USING (target_context_name, projection_name)
             WHERE g.target_context_name = 'identity' AND g.projection_name = $1
               AND g.state = 'active' AND g.rebuilding_generation IS NULL AND v.projection_revision = $2
             FOR SHARE OF g, v`,
            [projectionName, revision],
          );
          if (generation.rows.length !== 1) throw new Error("INDETERMINATE");
          const predicate =
            projectionName === "identity-membership-projection"
              ? "SELECT count(*)::text AS count FROM identity_memberships WHERE account_id = $5 AND role_key = 'owner' AND status = 'active'"
              : "SELECT consent_id FROM identity_consent_current_states WHERE subject_type = $5 AND subject_id = $6 AND policy_key = $7";
          const health = await client.query<{
            healthy: boolean;
            authority: readonly Readonly<{ count?: string; consent_id?: string }>[];
          }>(
            `SELECT EXISTS (
               SELECT 1 FROM event_subscription_checkpoints c
               JOIN event_projection_recovery_markers r ON r.projection_kind = 'subscription' AND r.projection_key = c.checkpoint_key
               JOIN event_projection_group_revisions v ON v.target_context_name = 'identity' AND v.projection_name = c.projection_name
               JOIN event_projection_group_generations g ON g.target_context_name = v.target_context_name AND g.projection_name = v.projection_name
               WHERE c.checkpoint_key = $1 AND c.projection_name = $2 AND c.source_context_name = 'identity' AND c.subscription_version = 1
                 AND c.last_global_position >= $3::bigint AND r.last_global_position >= c.last_global_position
                 AND v.projection_revision = $4 AND g.state = 'active' AND g.rebuilding_generation IS NULL
             ) AND NOT EXISTS (
               SELECT 1 FROM event_projection_poison_events WHERE projection_key = $1 AND global_position <= $3::bigint AND state <> 'resolved'
             ) AND NOT EXISTS (
               SELECT 1 FROM event_projection_blocked_streams WHERE projection_key = $1 AND first_blocked_global_position <= $3::bigint AND state <> 'resolved'
             ) AND NOT EXISTS (
               SELECT 1 FROM event_subscription_applications WHERE projection_key = $1 AND global_position <= $3::bigint AND status <> 'applied'
             ) AS healthy, (SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) FROM (${predicate}) p) AS authority`,
            [checkpointKey, projectionName, horizon, revision, ...parameters],
          );
          if (health.rows[0]?.healthy !== true) throw new Error("INDETERMINATE");
          return health.rows[0].authority;
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function append(inputs: readonly AppendToStreamInput[]) {
    const contributors = await Promise.all(
      inputs.map(async (input) => {
        const history = await readCompleteStream(store, { streamId: input.streamId, maxEvents: 10000 });
        const events = [...history, ...input.events];
        return { input, scopes: eligibilityScopeKeys(input.context.tenantId, input.streamId, events) };
      }),
    );
    if (contributors.every((entry) => entry.scopes.length === 0)) {
      if (!store.appendToStreams) throw new Error("INDETERMINATE");
      return store.appendToStreams(inputs);
    }
    return transaction(
      contributors.flatMap((entry) => entry.scopes),
      async (tx) => {
        const guards = new Map<string, AppendToStreamInput>();
        for (const { input, scopes } of contributors) {
          const history = await tx.read(input.streamId);
          if (
            JSON.stringify(
              eligibilityScopeKeys(input.context.tenantId, input.streamId, [...history, ...input.events]),
            ) !== JSON.stringify(scopes)
          )
            throw new Error("INDETERMINATE");
          const guard = await enforceLegacyEligibility(tx, input, history);
          if (guard && !inputs.some((candidate) => candidate.streamId === guard.streamId))
            guards.set(guard.streamId, guard);
        }
        return tx.append!([...inputs, ...guards.values()]);
      },
    );
  }

  return {
    transaction,
    eventStore: {
      readStream: (input) => store.readStream(input),
      readAll: (input) => store.readAll(input),
      appendToStreams: append,
      appendToStream: async (input) => (await append([input]))[0].storedEvents,
    },
  };
}

async function enforceLegacyEligibility(
  tx: IdentityMutationTransaction,
  input: AppendToStreamInput,
  history: readonly StoredEvent[],
) {
  if (input.streamId.startsWith("identity.membership-")) {
    const grant = history.find((event) => event.eventType === "identity.membership.granted");
    if (!grant) return;
    const membership = validateOwnerHistory("membership", history, input.context.tenantId);
    if (membership.kind !== "membership") throw new Error("INDETERMINATE");
    if (
      membership.state.status !== "active" ||
      membership.state.roleKey !== "owner" ||
      !input.events.some(
        (event) =>
          event.eventType === "identity.membership.revoked" ||
          (event.eventType === "identity.membership.role-changed" && event.payload.roleKey !== "owner"),
      )
    )
      return;
    const accountId = String(grant.payload.accountId);
    const accountHistory = await tx.read(`identity.account-${accountId}`);
    const account = validateOwnerHistory("account", accountHistory, input.context.tenantId);
    if (account.kind !== "account" || !account.state.id) throw new Error("INDETERMINATE");
    if (account.state.status === "closed")
      return {
        streamId: `identity.account-${accountId}`,
        expectedVersion: accountHistory.length,
        context: input.context,
        events: [],
      } as const;
    const count = await tx.projectionPredicate("identity-membership-projection", [accountId]);
    if (BigInt(count[0]?.count ?? "0") <= 1n) throw createEventStoreError("concurrency_conflict", "last-active-owner");
    return {
      streamId: `identity.account-${accountId}`,
      expectedVersion: accountHistory.length,
      context: input.context,
      events: [],
    } as const;
  }
  if (input.events.some((event) => event.eventType === "identity.consent.withdrawn")) {
    const record = history.find((event) => event.eventType === "identity.consent.recorded");
    if (!record) throw new Error("INDETERMINATE");
    validateOwnerHistory("consent", history, input.context.tenantId);
    const payload = record.payload;
    const current = await tx.projectionPredicate("identity-consent-current-state-projection", [
      payload.subjectType,
      payload.subjectType === "user" ? payload.userId : payload.accountId,
      payload.policyKey,
    ]);
    if (current[0]?.consent_id !== payload.consentId)
      throw createEventStoreError("concurrency_conflict", "current-consent");
  }
}
