import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createPostgresEventStore,
  withPgTransaction,
  type PgQueryable,
  type PgTransactionalPool,
  type PostgresEventStore,
} from "@chase-sets/event-core-postgres";
import { channelConnectionEventCodec } from "../../connections/domain/codec";
import { evolveChannelConnection, initialChannelConnectionState } from "../../connections/domain/domain";
import type { ChannelConnectionStatus } from "../../connections/domain/contracts";
import {
  decodeChannelHealthChanged,
  decodeChannelHealthObservation,
  decodeChannelHealthQuery,
  decodeChannelHealthRead,
  decodeChannelHealthPolicy,
  digest,
  instant,
} from "../domain/codecs";
import {
  ChannelHealthError,
  type ChannelHealthObservation,
  type ChannelHealthPolicy,
  type ChannelHealthQuery,
  type ChannelHealthReasonGeneration,
  type ChannelHealthSnapshot,
  type ChannelHealthSubmission,
  type ConnectionHealthServices,
} from "../domain/contracts";
import {
  evaluateReason,
  healthAvailability,
  healthTransitionAllowed,
  observeReason,
  rollupHealth,
} from "../domain/reducer";
import { readHealthSnapshot, readTrailingFailures, writeHealthSnapshot } from "../read-model/store";

export type ConnectionHealthDependencies = Readonly<{
  db: PgTransactionalPool;
  eventStore: PostgresEventStore;
  resolvePolicy: (db: PgQueryable, at: string) => Promise<Readonly<{ revision: string; value: ChannelHealthPolicy }>>;
  now?: () => string;
}>;

export function createConnectionHealthRuntime(deps: ConnectionHealthDependencies): ConnectionHealthServices {
  const now = deps.now ?? (() => new Date().toISOString());

  async function transact<T>(
    query: ChannelHealthQuery,
    work: (
      db: PgQueryable,
      status: ChannelConnectionStatus | null,
      health: ChannelHealthSnapshot,
      policy: ChannelHealthPolicy | null,
      at: string,
      context: EventStoreContext,
    ) => Promise<T>,
  ): Promise<T> {
    return withPgTransaction(deps.db, async (db) => {
      // The canonical lifecycle stream, rather than an asynchronously updated projection, owns admission.
      await db.query("SELECT stream_id FROM event_store_streams WHERE stream_id = $1 FOR UPDATE", [
        `channels.connection-${query.connectionId}`,
      ]);
      const transactionalReader = createPostgresEventStore({
        pool: { query: db.query.bind(db), connect: deps.db.connect.bind(deps.db) },
      });
      const storedEvents = await readCompleteStream(transactionalReader, {
        streamId: `channels.connection-${query.connectionId}`,
      });
      const state = storedEvents.reduce(
        (current, event) => evolveChannelConnection(current, channelConnectionEventCodec.decode(event)),
        initialChannelConnectionState,
      );
      if (state.accountId !== query.accountId || state.connectionId !== query.connectionId)
        throw new ChannelHealthError("connection-not-found");
      const openingEvent = storedEvents[0];
      if (!openingEvent) throw new ChannelHealthError("connection-not-found");
      const context: EventStoreContext = {
        tenantId: openingEvent.tenantId,
        audit: { performedByUserId: "usr_system", forAccountId: openingEvent.forAccountId },
      };
      const at = instant(now());
      let health = await readHealthSnapshot(db, query.connectionId);
      let resolved: Awaited<ReturnType<ConnectionHealthDependencies["resolvePolicy"]>> | null;
      try {
        resolved = await deps.resolvePolicy(db, at);
        resolved = { revision: digest(resolved.revision), value: decodeChannelHealthPolicy(resolved.value) };
      } catch (error) {
        if (!(error instanceof ChannelHealthError)) throw error;
        resolved = null;
      }
      if (!health) {
        health = {
          policyRevision: resolved?.revision ?? "0".repeat(64),
          evaluationGeneration: 1,
          state: "unknown",
          reasons: [],
          observedAt: null,
        };
        if (healthTransitionAllowed(state.status, health.state))
          await db.query(
            `INSERT INTO channel_connection_health (connection_id, account_id, policy_revision, evaluation_generation, state, reasons, observed_at)
          VALUES ($1, $2, $3, 1, 'unknown', '[]'::jsonb, NULL)`,
            [query.connectionId, query.accountId, health.policyRevision],
          );
      }
      if (
        resolved &&
        health.policyRevision !== resolved.revision &&
        healthTransitionAllowed(state.status, health.state)
      ) {
        const failures = await readTrailingFailures(db, query.connectionId, at, resolved.value.windowSeconds);
        const reasons = health.reasons.map((reason) =>
          evaluateReason(
            { ...reason, trailingFailures: failures(reason.reasonCode, reason.generation) },
            resolved.value,
          ),
        );
        const next = {
          ...health,
          policyRevision: resolved.revision,
          evaluationGeneration: health.evaluationGeneration + 1,
          reasons,
          state: rollupHealth(reasons),
        };
        await persist(db, query.connectionId, health, next);
        // Policy activation is a read-through transaction, with facts for any newly failing reason.
        for (const reason of reasons) {
          const previous = health.reasons.find((candidate) => candidate.reasonCode === reason.reasonCode);
          if (previous?.state !== reason.state) await publish(db, query, reason, at, context);
        }
        health = next;
      }
      return work(db, state.status, health, resolved?.value ?? null, at, context);
    });
  }

  async function publish(
    db: PgQueryable,
    query: ChannelHealthQuery,
    reason: ChannelHealthReasonGeneration,
    observedAt: string,
    context: EventStoreContext,
  ) {
    const payload = decodeChannelHealthChanged({
      schemaVersion: "ChannelHealthChanged/v1",
      connection: query,
      reasonCode: reason.reasonCode,
      generation: reason.generation,
      diagnosticCode:
        reason.state === "closed" ? "reason-closed" : reason.state === "failing" ? "reason-failing" : "reason-opened",
      observedAt,
    });
    await deps.eventStore.appendToStreamInTransaction(db, {
      streamId: `channels.connection-health-${query.connectionId}`,
      wakeSourceContextName: "channels",
      expectedVersion: "any",
      events: [{ eventType: "channels.connection.health-changed", payload }],
      context,
    });
  }

  function read(
    query: ChannelHealthQuery,
    status: ChannelConnectionStatus | null,
    health: ChannelHealthSnapshot,
    policyAvailable: boolean,
  ) {
    const visibleHealth =
      !policyAvailable && health.state === "healthy" ? { ...health, state: "unknown" as const } : health;
    return decodeChannelHealthRead({
      schemaVersion: "ChannelHealthRead/v1",
      connection: { ...query, status },
      health: visibleHealth,
      policyAvailable,
      ...healthAvailability(status, visibleHealth.state, policyAvailable),
    });
  }

  return {
    async readConnectionHealth(input) {
      const query = decodeChannelHealthQuery(input);
      return transact(query, async (_db, status, health, policy) => read(query, status, health, policy !== null));
    },
    async listOpenReasonGenerations(input) {
      const query = decodeChannelHealthQuery(input);
      return transact(query, async (_db, _status, health) =>
        health.reasons.filter((reason) => reason.state !== "closed"),
      );
    },
    async submitObservation(input, context: EventStoreContext) {
      const observation = decodeChannelHealthObservation(input);
      const query = decodeChannelHealthQuery({
        connectionId: observation.connectionId,
        accountId: context.audit.forAccountId,
      });
      return transact(query, async (db, status, health, policy, at, eventContext): Promise<ChannelHealthSubmission> => {
        const result = (outcome: ChannelHealthSubmission["outcome"]) => ({
          outcome,
          health: read(query, status, health, policy !== null),
        });
        if (!healthTransitionAllowed(status, health.state)) return result("inert");
        if (!policy) return result("policy-unavailable");
        if (
          observation.policyRevision !== health.policyRevision ||
          observation.evaluationGeneration !== health.evaluationGeneration ||
          Date.parse(observation.occurredAt) > Date.parse(at)
        )
          return result("stale");
        const existing = await db.query<{ observation: unknown }>(
          `SELECT observation FROM channel_health_observations
          WHERE source_kind = $1 AND source_work_id = $2 AND source_attempt = $3`,
          [observation.sourceKind, observation.sourceWorkId, observation.sourceAttempt],
        );
        const attemptResults = existing.rows.map((row) => decodeChannelHealthObservation(row.observation));
        const replay = attemptResults.find((previous) => previous.resultOrdinal === observation.resultOrdinal);
        if (replay)
          return result(JSON.stringify(replay) === JSON.stringify(observation) ? "replayed" : "conflicting-terminal");
        // A later result can resolve this attempt's failure; it cannot count that failure twice.
        if (attemptResults.some((previous) => previous.outcome === observation.outcome))
          return result("conflicting-terminal");
        if (
          attemptResults.some((previous) => previous.resultOrdinal > observation.resultOrdinal) ||
          (observation.outcome === "failure" && attemptResults.length > 0)
        )
          return result("stale");
        const previous = health.reasons.find((reason) => reason.reasonCode === observation.reasonCode);
        if (await staleObservation(db, observation, previous)) return result("stale");
        const generation =
          previous?.fingerprint === observation.fingerprint ? previous.generation : (previous?.generation ?? 0) + 1;
        await db.query(
          `INSERT INTO channel_health_observations (source_kind, source_work_id, source_attempt, result_ordinal,
          connection_id, reason_code, reason_generation, fingerprint, outcome, occurred_at, observation)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::jsonb)`,
          [
            observation.sourceKind,
            observation.sourceWorkId,
            observation.sourceAttempt,
            observation.resultOrdinal,
            observation.connectionId,
            observation.reasonCode,
            generation,
            observation.fingerprint,
            observation.outcome,
            observation.occurredAt,
            JSON.stringify(observation),
          ],
        );
        const failures = await readTrailingFailures(db, query.connectionId, at, policy.windowSeconds);
        const reason = observeReason(previous, observation, failures(observation.reasonCode, generation), policy);
        const reasons = [...health.reasons.filter((item) => item.reasonCode !== reason.reasonCode), reason].sort(
          (a, b) => a.reasonCode.localeCompare(b.reasonCode),
        );
        const observedAt =
          health.observedAt !== null && Date.parse(health.observedAt) > Date.parse(observation.occurredAt)
            ? health.observedAt
            : observation.occurredAt;
        const next = { ...health, state: rollupHealth(reasons), reasons, observedAt };
        await persist(db, query.connectionId, health, next);
        if (!previous || previous.generation !== reason.generation || previous.state !== reason.state)
          await publish(db, query, reason, observation.occurredAt, eventContext);
        health = next;
        return result("accepted");
      });
    },
  };
}

async function persist(
  db: PgQueryable,
  connectionId: string,
  previous: ChannelHealthSnapshot,
  next: ChannelHealthSnapshot,
) {
  if ((await writeHealthSnapshot(db, connectionId, previous, next)) !== 1)
    throw new ChannelHealthError("health-write-conflict");
}

async function staleObservation(
  db: PgQueryable,
  observation: ChannelHealthObservation,
  previous: ChannelHealthReasonGeneration | undefined,
): Promise<boolean> {
  if (previous && Date.parse(observation.occurredAt) < Date.parse(previous.lastOccurredAt)) return true;
  if (previous && previous.fingerprint !== observation.fingerprint && observation.outcome === "success") return true;
  const result = await db.query(
    `SELECT 1 FROM channel_health_observations
    WHERE (source_kind = $1 AND source_work_id = $2 AND source_attempt > $3)
       OR (connection_id = $4 AND reason_code = $5 AND fingerprint = $6 AND reason_generation < $7)
    LIMIT 1`,
    [
      observation.sourceKind,
      observation.sourceWorkId,
      observation.sourceAttempt,
      observation.connectionId,
      observation.reasonCode,
      observation.fingerprint,
      previous?.generation ?? 1,
    ],
  );
  return result.rows.length > 0;
}
