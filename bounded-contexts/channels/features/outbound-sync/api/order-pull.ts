import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelProviderIdentity, ChannelProviderRegistry } from "../../publication-port/domain/contracts";
import { assertAdditionalOutboundHold, resolveConnectionExecutionAdmission } from "../domain/admission";
import {
  OutboundSyncError,
  type ClaimedOperationClaimant,
  type ClaimedOrderPullOperation,
  type OrderPullOperationRecord,
  type OutboundConnection,
  type OutboundSyncRuntimeDependencies,
} from "../domain/contracts";
import {
  ORDER_PULL_LEASE_MARGIN_MS,
  assertOrderPullOutcomeBody,
  assertOrderPullOutcomeMatchesPayload,
  assertOrderPullPayload,
  deriveOrderPullId,
  deriveOrderPullOperationId,
  orderPullFitsLease,
  orderPullLawVersion,
  orderPullOperationKind,
  orderPullProviderKey,
  resolveOrderPullBudget,
  allocateOrderPullBudget,
  sameSelector,
  type ClaimedOrderPullOutcome,
  type OrderPullAuthority,
  type OrderPullPayload,
} from "../domain/order-pull";
import { assertOutboundClaimLeaseMs, payloadDigest } from "../domain/validation";
import {
  assertOrderPullCheckpoint,
  orderPullCheckpointDigest,
  type OrderPullCheckpoint,
  type OrderPullPredecessor,
} from "../domain/order-pull-progress";
import { commitOrderPullProgress, readOrderPullWork } from "./order-pull-progress";
import { canonicalJson } from "../../listing-composition/domain/canonical-json";

type OrderPullRow = Readonly<{
  operation_id: string;
  connection_id: string;
  operation_kind: typeof orderPullOperationKind;
  pull_id: string;
  schedule_generation: string | number;
  payload: unknown;
  payload_digest: string;
  status: "pending" | "in-flight" | "succeeded" | "failed";
  revision: string | number;
  attempt_id: string | null;
  claim_generation: string | number;
  claimant_kind: "connector" | null;
  claim_owner_id: string | null;
  reservation_id: string | null;
  claimed_until: Date | string | null;
  attempt_count: string | number;
  outcome: unknown;
  enqueued_at: Date | string;
  first_claimed_at: Date | string | null;
  terminal_at: Date | string | null;
}>;

type ScheduleRow = Readonly<{
  generation: string | number;
  next_due_at: Date | string;
  last_scheduled_at: Date | string;
  revision: string | number;
  checkpoint: OrderPullCheckpoint | null;
  checkpoint_digest: string | null;
}>;

// The data-path envelope: one tick examines at most 100 indexed due connections, never an unbounded drain.
const dueConnectionsPerTick = 100;

/** A keyset position in the due scan; `step` orders the advances made within one lap. */
export type OrderPullScanPosition = Readonly<{ lap: number; step: number; after: string | null }>;

export type OrderPullScanCursor = Readonly<{
  current: () => OrderPullScanPosition;
  /** Advances from `from` past `after`; `null` means the scan was exhausted and wraps to the start. */
  advance: (from: OrderPullScanPosition, after: string | null) => void;
}>;

/**
 * The producer runtime's due-scan continuation. Each tick resumes after the last connection examined
 * by the previous one, so a stable inadmissible prefix cannot starve later connections. An advance
 * computed from a superseded position is dropped, so a late concurrent tick never moves it backwards.
 * A restart begins a new scan; the schedule lock and CAS, not this cursor, keep every mint unique.
 */
export function createOrderPullScanCursor(): OrderPullScanCursor {
  let position: OrderPullScanPosition = { lap: 0, step: 0, after: null };
  return {
    current: () => position,
    advance: (from, after) => {
      const next =
        after === null ? { lap: from.lap + 1, step: 0, after } : { lap: from.lap, step: from.step + 1, after };
      if (next.lap > position.lap || (next.lap === position.lap && next.step > position.step)) position = next;
    },
  };
}

const orderPullColumns = `operation_id, connection_id, operation_kind, pull_id, schedule_generation, payload,
  payload_digest, status, revision, attempt_id, claim_generation, claimant_kind, claim_owner_id,
  reservation_id, claimed_until, attempt_count, outcome, enqueued_at, first_claimed_at, terminal_at`;

/**
 * The bounded per-connection due runner. Channels background calls it; the connector claim endpoint
 * never does. Each due, active, paired, claimed-execution TCGplayer connection without a live pull
 * gets exactly one new pull in one fenced transaction. Unknown authority, an over-budget bound,
 * not-due, paused, held or revoked connections write nothing. Null authority is an inert no-op, but a
 * resolver or policy that fails rejects with `order-pull-schedule-unavailable` for the worker to report.
 */
export async function scheduleDueOrderPulls(
  dependencies: OutboundSyncRuntimeDependencies,
  input: Readonly<{ registry: ChannelProviderRegistry }>,
  now: () => string,
  scan: OrderPullScanCursor,
): Promise<number> {
  const producer = dependencies.orderPull;
  if (!producer) return 0;
  const authority = await resolveScheduleInput(
    producer.resolveAuthority,
    "The order-pull authority could not be resolved.",
  );
  const preflight = resolveOrderPullBudget(authority);
  const budget =
    preflight.kind === "fits" ? allocateOrderPullBudget(authority, preflight.authority.nListReadMax, 0) : preflight;
  if (budget.kind !== "fits") return 0;
  const cadence = await resolveScheduleInput(
    async () => decodeCadence(await producer.resolveConnectorPolicy()),
    "The connector transport policy could not be resolved.",
  );
  if (budget.bounds.budgetMs + ORDER_PULL_LEASE_MARGIN_MS >= cadence.leaseMs) return 0;
  const scannedAt = now();
  const from = scan.current();
  const candidates = await dependencies.db.query<{ connection_id: string }>(
    `SELECT connection.connection_id
     FROM channel_connections AS connection
     JOIN channel_connector_pairings AS pairing
       ON pairing.connection_id = connection.connection_id AND pairing.state = 'paired'
     LEFT JOIN channel_order_pull_schedules AS schedule ON schedule.connection_id = connection.connection_id
     WHERE connection.status = 'active' AND connection.provider_key = $2
       AND ($5::text IS NULL OR connection.connection_id > $5)
       AND (schedule.connection_id IS NULL OR (schedule.next_due_at <= $1 AND schedule.last_scheduled_at <= $4))
       AND NOT EXISTS (
         SELECT 1 FROM channel_order_pull_operations AS live
         WHERE live.connection_id = connection.connection_id AND live.status IN ('pending', 'in-flight')
       )
     ORDER BY connection.connection_id
     LIMIT $3`,
    [
      scannedAt,
      orderPullProviderKey,
      dueConnectionsPerTick,
      new Date(Date.parse(scannedAt) - cadence.pollWindowMs).toISOString(),
      from.after,
    ],
  );
  let scheduled = 0;
  let examined: string | null = null;
  let completed = false;
  try {
    for (const candidate of candidates.rows) {
      examined = candidate.connection_id;
      const minted = await withPgTransaction(dependencies.db, (db) =>
        scheduleConnectionPull(dependencies, db, {
          connectionId: candidate.connection_id,
          registry: input.registry,
          authority: budget.authority,
          bounds: budget.bounds,
          pollWindowMs: cadence.pollWindowMs,
          at: now(),
        }),
      );
      if (minted) scheduled += 1;
    }
    completed = true;
  } finally {
    // Every examined candidate is passed, admitted or denied; a short page means the scan wraps.
    scan.advance(from, completed && candidates.rows.length < dueConnectionsPerTick ? null : examined);
  }
  return scheduled;
}

async function resolveScheduleInput<T>(resolve: () => Promise<T>, message: string): Promise<T> {
  try {
    return await resolve();
  } catch {
    // The original failure may carry provider or policy detail; the worker records only this safe message.
    throw new OutboundSyncError("order-pull-schedule-unavailable", message);
  }
}

async function scheduleConnectionPull(
  dependencies: OutboundSyncRuntimeDependencies,
  db: PgQueryable,
  input: Readonly<{
    connectionId: string;
    registry: ChannelProviderRegistry;
    authority: OrderPullAuthority;
    bounds: OrderPullPayload["bounds"];
    pollWindowMs: number;
    at: string;
  }>,
): Promise<boolean> {
  const connection = await readConnection(db, input.connectionId);
  if (!connection || connection.status !== "active" || connection.providerKey !== orderPullProviderKey) return false;
  const paired = await db.query(
    `SELECT pairing_id FROM channel_connector_pairings
     WHERE connection_id = $1 AND state = 'paired' FOR SHARE`,
    [input.connectionId],
  );
  if (paired.rows.length !== 1) return false;
  const admission = resolveConnectionExecutionAdmission(input.registry, connection);
  if (admission.kind !== "claimed") return false;
  const hold = await dependencies.readAdditionalOutboundHold({
    connectionId: connection.connectionId,
    providerIdentity: admission.providerIdentity,
  });
  assertAdditionalOutboundHold(hold);
  if (hold.held) return false;
  const schedule = await db.query<ScheduleRow>(
    `SELECT generation, next_due_at, last_scheduled_at, revision, checkpoint, checkpoint_digest FROM channel_order_pull_schedules
     WHERE connection_id = $1 FOR UPDATE`,
    [input.connectionId],
  );
  const current = schedule.rows[0];
  const persisted = current
    ? { nextDueAt: timestamp(current.next_due_at)!, lastScheduledAt: timestamp(current.last_scheduled_at)! }
    : null;
  if (persisted && !orderPullScheduleDue(persisted, input.at, input.pollWindowMs)) return false;
  const live = await db.query(
    `SELECT operation_id FROM channel_order_pull_operations
     WHERE connection_id = $1 AND status IN ('pending', 'in-flight') FOR UPDATE`,
    [input.connectionId],
  );
  if (live.rows.length > 0) return false;
  const generation = current ? Number(current.generation) + 1 : 1;
  if (!Number.isSafeInteger(generation)) throw new OutboundSyncError("stale-fence");
  const pullId = deriveOrderPullId(input.connectionId, generation);
  const checkpoint =
    current?.checkpoint && !current.checkpoint.drained
      ? current.checkpoint
      : {
          burstId: pullId,
          policyRevision: input.authority.revision,
          selector: input.authority.selector,
          traversal: null,
          gapCount: 0,
          drained: false,
          followUpTail: false,
        };
  assertOrderPullCheckpoint(checkpoint);
  if (
    checkpoint.policyRevision !== input.authority.revision ||
    !sameSelector(checkpoint.selector, input.authority.selector)
  )
    return false;
  if (current?.checkpoint && orderPullCheckpointDigest(current.checkpoint) !== current.checkpoint_digest)
    throw new OutboundSyncError("stale-fence");
  const boundary = persisted
    ? advanceScheduledBoundary(persisted.lastScheduledAt, input.at, input.pollWindowMs)
    : input.at;
  const nextDueAt = new Date(Date.parse(boundary) + input.pollWindowMs).toISOString();
  const advanced = current
    ? await db.query(
        `UPDATE channel_order_pull_schedules
         SET generation = $2, next_due_at = $3, last_scheduled_at = $4, revision = revision + 1, updated_at = $5,
             checkpoint=$8::jsonb, checkpoint_digest=$9
         WHERE connection_id = $1 AND revision = $6 AND generation = $7
         RETURNING connection_id`,
        [
          input.connectionId,
          generation,
          nextDueAt,
          boundary,
          input.at,
          current.revision,
          current.generation,
          JSON.stringify(checkpoint),
          orderPullCheckpointDigest(checkpoint),
        ],
      )
    : await db.query(
        `INSERT INTO channel_order_pull_schedules
           (connection_id, generation, next_due_at, last_scheduled_at, revision, updated_at, checkpoint, checkpoint_digest)
         VALUES ($1, $2, $3, $4, 1, $5, $6::jsonb, $7)
         ON CONFLICT (connection_id) DO NOTHING
         RETURNING connection_id`,
        [
          input.connectionId,
          generation,
          nextDueAt,
          boundary,
          input.at,
          JSON.stringify(checkpoint),
          orderPullCheckpointDigest(checkpoint),
        ],
      );
  // A concurrent tick that inserted the first schedule row owns this boundary.
  if (advanced.rows.length !== 1) {
    if (current) throw new OutboundSyncError("stale-fence");
    return false;
  }
  const payload = await buildPayload(db, {
    connectionId: input.connectionId,
    pullId,
    authority: input.authority,
    bounds: input.bounds,
    checkpoint,
    predecessor: null,
    providerNotBefore: new Date(Date.parse(input.at) + input.authority.providerCadenceMs).toISOString(),
  });
  await insertPull(db, payload, generation, input.at);
  return true;
}

async function insertPull(db: PgQueryable, payload: OrderPullPayload, generation: number, at: string): Promise<void> {
  assertOrderPullPayload(payload);
  await db.query(
    `INSERT INTO channel_order_pull_operations (
       operation_id, connection_id, operation_kind, pull_id, schedule_generation, payload, payload_digest,
       status, revision, enqueued_at
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'pending', 1, $8)`,
    [
      deriveOrderPullOperationId(payload.connectionId, payload.pullId),
      payload.connectionId,
      orderPullOperationKind,
      payload.pullId,
      generation,
      JSON.stringify(payload),
      payloadDigest(payload),
      at,
    ],
  );
}

async function buildPayload(
  db: PgQueryable,
  input: Readonly<{
    connectionId: string;
    pullId: string;
    authority: OrderPullAuthority;
    bounds: OrderPullPayload["bounds"];
    checkpoint: OrderPullCheckpoint;
    predecessor: OrderPullPredecessor | null;
    providerNotBefore: string;
  }>,
): Promise<OrderPullPayload> {
  return {
    kind: "order-pull",
    version: 2,
    connectionId: input.connectionId,
    pullId: input.pullId,
    policyRevision: input.authority.revision,
    lawVersion: orderPullLawVersion,
    selector: {
      identity: input.authority.selector.identity,
      version: input.authority.selector.version,
      pageSize: input.authority.selector.pageSize,
      traversal: input.authority.selector.traversal,
    },
    bounds: input.bounds,
    // The follow-up reference source is not wired into Channels yet, so the server selects none.
    followUpReferences: [],
    checkpoint: input.checkpoint,
    checkpointDigest: orderPullCheckpointDigest(input.checkpoint),
    work: await readOrderPullWork(db, input.connectionId, input.checkpoint.burstId),
    predecessor: input.predecessor,
    providerNotBefore: input.providerNotBefore,
  };
}

/**
 * A persisted schedule admits a mint only once both its stored due fence and its last scheduled
 * boundary plus the effective poll window have passed, so raising the window never mints early and
 * lowering it never pulls the already-promised fence forward.
 */
export function orderPullScheduleDue(
  schedule: Readonly<{ nextDueAt: string; lastScheduledAt: string }>,
  at: string,
  pollWindowMs: number,
): boolean {
  const instant = Date.parse(at);
  return Date.parse(schedule.nextDueAt) <= instant && Date.parse(schedule.lastScheduledAt) + pollWindowMs <= instant;
}

/** The latest boundary at or before `at` on the effective cadence grid; a missed boundary never schedules a backlog. */
export function advanceScheduledBoundary(lastScheduledAt: string, at: string, pollWindowMs: number): string {
  const start = Date.parse(lastScheduledAt);
  const elapsed = Math.max(0, Date.parse(at) - start);
  return new Date(start + Math.floor(elapsed / pollWindowMs) * pollWindowMs).toISOString();
}

/**
 * Reserves the connection's single pending pull into a capable connector reservation, only when its
 * pre-accounted budget finishes inside the lease with the 30 s margin.
 */
export async function reserveOrderPull(
  db: PgQueryable,
  dependencies: OutboundSyncRuntimeDependencies,
  input: Readonly<{
    connectionId: string;
    providerIdentity: ChannelProviderIdentity;
    claimant: ClaimedOperationClaimant;
    reservationId: string;
    reservedAt: string;
    leaseExpiresAt: string;
    attemptId: string;
  }>,
): Promise<ClaimedOrderPullOperation | null> {
  if (input.claimant.claimantKind !== "connector" || input.providerIdentity.providerKey !== orderPullProviderKey) {
    return null;
  }
  const pending = await db.query<OrderPullRow>(
    `SELECT ${orderPullColumns} FROM channel_order_pull_operations
     WHERE connection_id = $1 AND status = 'pending'
     FOR UPDATE SKIP LOCKED`,
    [input.connectionId],
  );
  const row = pending.rows[0];
  if (!row) return null;
  const record = mapOrderPullRow(row);
  if (!dependencies.orderPull) return null;
  const authority = await dependencies.orderPull.resolveAuthority();
  const budget = resolveOrderPullBudget(authority, record.payload.bounds.plan);
  if (
    budget.kind !== "fits" ||
    budget.authority.revision !== record.payload.policyRevision ||
    !sameSelector(budget.authority.selector, record.payload.selector) ||
    canonicalJson(budget.bounds) !== canonicalJson(record.payload.bounds)
  )
    return null;
  const refreshedPayload = {
    ...record.payload,
    work: await readOrderPullWork(db, record.subject.connectionId, record.payload.checkpoint.burstId),
  };
  assertOrderPullPayload(refreshedPayload);
  if (
    !orderPullFitsLease({
      budgetMs: record.payload.bounds.budgetMs,
      at: input.reservedAt,
      leaseExpiresAt: input.leaseExpiresAt,
    })
  ) {
    return null;
  }
  const updated = await db.query<OrderPullRow>(
    `UPDATE channel_order_pull_operations
     SET status = 'in-flight', revision = revision + 1, attempt_id = $2, claim_generation = claim_generation + 1,
         claimant_kind = 'connector', claim_owner_id = $3, reservation_id = $4, claimed_until = $5,
         attempt_count = attempt_count + 1, first_claimed_at = COALESCE(first_claimed_at, $6),
         payload=$8::jsonb, payload_digest=$9
     WHERE operation_id = $1 AND status = 'pending' AND revision = $7
     RETURNING ${orderPullColumns}`,
    [
      record.operationId,
      input.attemptId,
      input.claimant.claimantId,
      input.reservationId,
      input.leaseExpiresAt,
      input.reservedAt,
      record.revision,
      JSON.stringify(refreshedPayload),
      payloadDigest(refreshedPayload),
    ],
  );
  const claimed = updated.rows[0] ? mapOrderPullRow(updated.rows[0]) : null;
  if (!claimed) throw new OutboundSyncError("stale-fence");
  return {
    operationId: claimed.operationId,
    attemptId: claimed.attemptId!,
    claimGeneration: claimed.claimGeneration,
    connectionId: claimed.subject.connectionId,
    providerIdentity: input.providerIdentity,
    subject: claimed.subject,
    operationKind: claimed.operationKind,
    pullId: claimed.pullId,
    scheduleGeneration: claimed.scheduleGeneration,
    payload: claimed.payload,
    payloadDigest: claimed.payloadDigest,
    enqueuedAt: claimed.enqueuedAt,
  };
}

export async function lockReservedOrderPulls(
  db: PgQueryable,
  reservationId: string,
): Promise<readonly OrderPullOperationRecord[]> {
  const members = await db.query<OrderPullRow>(
    `SELECT ${orderPullColumns} FROM channel_order_pull_operations
     WHERE reservation_id = $1 AND status = 'in-flight'
     ORDER BY operation_id
     FOR UPDATE`,
    [reservationId],
  );
  return members.rows.map(mapOrderPullRow);
}

/** Checks the exact attempt/generation/subject/membership/digest fence before any member settles. */
export function assertOrderPullReportFence(
  member: OrderPullOperationRecord,
  report: ClaimedOrderPullOutcome,
  claimant: ClaimedOperationClaimant,
): void {
  if (
    member.claimantKind !== claimant.claimantKind ||
    member.claimOwnerId !== claimant.claimantId ||
    member.attemptId !== report.attemptId ||
    member.claimGeneration !== report.claimGeneration ||
    member.pullId !== report.pullId ||
    member.payloadDigest !== report.payloadDigest
  ) {
    throw new OutboundSyncError("reservation-membership-mismatch");
  }
  assertOrderPullOutcomeMatchesPayload(report, member.payload);
}

/**
 * Complete and unknown are terminal and never touch listing lanes or Link state; proven no-dispatch
 * (`abandoned`) returns the same pull to pending for a later attempt.
 */
export async function settleOrderPullMember(
  db: PgQueryable,
  dependencies: OutboundSyncRuntimeDependencies,
  member: OrderPullOperationRecord,
  report: ClaimedOrderPullOutcome,
  settledAt: string,
): Promise<void> {
  const progress = report.outcome.kind !== "abandoned" && report.outcome.kind !== "order-pull-unknown";
  let schedule: ScheduleRow | undefined;
  let checkpoint: OrderPullCheckpoint | undefined;
  let settledOutcome = report.outcome;
  if (progress) {
    const locked = await db.query<ScheduleRow>(
      `SELECT generation, next_due_at, last_scheduled_at, revision, checkpoint, checkpoint_digest
       FROM channel_order_pull_schedules WHERE connection_id=$1 FOR UPDATE`,
      [member.subject.connectionId],
    );
    schedule = locked.rows[0];
    if (
      !schedule ||
      Number(schedule.generation) !== member.scheduleGeneration ||
      schedule.checkpoint_digest !== member.payload.checkpointDigest ||
      !schedule.checkpoint ||
      orderPullCheckpointDigest(schedule.checkpoint) !== schedule.checkpoint_digest
    )
      throw new OutboundSyncError("stale-fence");
    const body = report.outcome as Exclude<
      ClaimedOrderPullOutcome["outcome"],
      { kind: "abandoned" | "order-pull-unknown" }
    >;
    const committed = await commitOrderPullProgress(db, member.payload, body);
    checkpoint = committed.checkpoint;
    settledOutcome = { ...body, kind: committed.kind };
  }
  const fence = [member.operationId, member.revision, member.attemptId, member.claimGeneration, member.reservationId];
  const result =
    report.outcome.kind === "abandoned"
      ? await db.query(
          `UPDATE channel_order_pull_operations
           SET status = 'pending', revision = revision + 1, attempt_id = NULL, claimant_kind = NULL,
               claim_owner_id = NULL, reservation_id = NULL, claimed_until = NULL
           WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2 AND attempt_id = $3
             AND claim_generation = $4 AND reservation_id = $5`,
          fence,
        )
      : await db.query(
          `UPDATE channel_order_pull_operations
           SET status = $6, revision = revision + 1, outcome = $7::jsonb, terminal_at = $8, claimed_until = NULL
           WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2 AND attempt_id = $3
             AND claim_generation = $4 AND reservation_id = $5`,
          [
            ...fence,
            settledOutcome.kind === "order-pull-complete" ? "succeeded" : "failed",
            JSON.stringify(settledOutcome),
            settledAt,
          ],
        );
  if (Number(result.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
  if (!checkpoint || !schedule) return;
  let generation = member.scheduleGeneration;
  let successor: OrderPullPayload | null = null;
  if (settledOutcome.kind === "continuation-required") {
    const authority = await dependencies.orderPull?.resolveAuthority();
    const preflight = resolveOrderPullBudget(authority);
    const budget =
      preflight.kind === "fits" ? allocateOrderPullBudget(authority, preflight.authority.nListReadMax, 0) : preflight;
    if (
      budget.kind !== "fits" ||
      budget.authority.revision !== checkpoint.policyRevision ||
      !sameSelector(budget.authority.selector, checkpoint.selector)
    )
      throw new OutboundSyncError("stale-fence");
    const cadence = decodeCadence(await dependencies.orderPull!.resolveConnectorPolicy());
    if (budget.bounds.budgetMs + ORDER_PULL_LEASE_MARGIN_MS >= cadence.leaseMs)
      throw new OutboundSyncError("invalid-input", "Continuation cannot fit fresh lease.");
    generation++;
    if (!Number.isSafeInteger(generation)) throw new OutboundSyncError("stale-fence");
    successor = await buildPayload(db, {
      connectionId: member.subject.connectionId,
      pullId: deriveOrderPullId(member.subject.connectionId, generation),
      authority: budget.authority,
      bounds: budget.bounds,
      checkpoint,
      predecessor: {
        operationId: member.operationId,
        attemptId: member.attemptId!,
        claimGeneration: member.claimGeneration,
        checkpointDigest: orderPullCheckpointDigest(checkpoint),
      },
      providerNotBefore: new Date(Date.parse(settledAt) + budget.authority.providerCadenceMs).toISOString(),
    });
  }
  const advanced = await db.query(
    `UPDATE channel_order_pull_schedules SET generation=$2, checkpoint=$3::jsonb, checkpoint_digest=$4,
       revision=revision+1, updated_at=$5
     WHERE connection_id=$1 AND generation=$6 AND revision=$7 AND checkpoint_digest=$8 RETURNING connection_id`,
    [
      member.subject.connectionId,
      generation,
      JSON.stringify(checkpoint),
      orderPullCheckpointDigest(checkpoint),
      settledAt,
      member.scheduleGeneration,
      schedule.revision,
      member.payload.checkpointDigest,
    ],
  );
  if (advanced.rows.length !== 1) throw new OutboundSyncError("stale-fence");
  // Pending is immediately claimable. The idle schedule is untouched; provider cadence remains in the new payload.
  if (successor) await insertPull(db, successor, generation, settledAt);
}

/** Lease expiry returns the same pull to pending; the next claim gets a new attempt and generation. */
export async function recoverExpiredOrderPulls(db: PgQueryable, currentInstant: string): Promise<number> {
  const result = await db.query(
    `UPDATE channel_order_pull_operations AS operation
     SET status = 'pending', revision = operation.revision + 1, attempt_id = NULL, claimant_kind = NULL,
         claim_owner_id = NULL, reservation_id = NULL, claimed_until = NULL
     FROM (
       SELECT operation_id FROM channel_order_pull_operations
       WHERE status = 'in-flight' AND claimed_until <= $1
       ORDER BY claimed_until, operation_id
       LIMIT 100
       FOR UPDATE SKIP LOCKED
     ) AS expired
     WHERE operation.operation_id = expired.operation_id AND operation.status = 'in-flight'`,
    [currentInstant],
  );
  return Number(result.rowCount ?? 0);
}

export async function readOrderPullOperations(
  db: PgQueryable,
  input: Readonly<{ connectionId: string }>,
): Promise<readonly OrderPullOperationRecord[]> {
  if (typeof input.connectionId !== "string" || input.connectionId.length < 1 || input.connectionId.length > 512) {
    throw new OutboundSyncError("invalid-input");
  }
  const result = await db.query<OrderPullRow>(
    `SELECT ${orderPullColumns} FROM channel_order_pull_operations
     WHERE connection_id = $1 ORDER BY schedule_generation DESC LIMIT 100`,
    [input.connectionId],
  );
  return result.rows.map(mapOrderPullRow);
}

function mapOrderPullRow(row: OrderPullRow): OrderPullOperationRecord {
  assertOrderPullPayload(row.payload);
  const outcome = row.outcome;
  if (outcome !== null) {
    assertOrderPullOutcomeBody(outcome);
    if (outcome.kind === "abandoned") throw new OutboundSyncError("stale-fence", "Abandonment is never persisted.");
  }
  if (
    row.operation_kind !== orderPullOperationKind ||
    row.payload.connectionId !== row.connection_id ||
    row.payload.pullId !== row.pull_id ||
    payloadDigest(row.payload) !== row.payload_digest
  ) {
    throw new OutboundSyncError("stale-fence", "Stored order-pull identity does not match its payload.");
  }
  return {
    operationId: row.operation_id,
    subject: { kind: "connection", connectionId: row.connection_id },
    operationKind: row.operation_kind,
    pullId: row.pull_id,
    scheduleGeneration: Number(row.schedule_generation),
    payload: row.payload,
    payloadDigest: row.payload_digest,
    status: row.status,
    revision: Number(row.revision),
    attemptId: row.attempt_id,
    claimGeneration: Number(row.claim_generation),
    claimantKind: row.claimant_kind,
    claimOwnerId: row.claim_owner_id,
    reservationId: row.reservation_id,
    claimedUntil: timestamp(row.claimed_until),
    attemptCount: Number(row.attempt_count),
    outcome,
    enqueuedAt: timestamp(row.enqueued_at)!,
    firstClaimedAt: timestamp(row.first_claimed_at),
    terminalAt: timestamp(row.terminal_at),
  };
}

function decodeCadence(value: unknown): Readonly<{ pollWindowMs: number; leaseMs: number }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new OutboundSyncError("invalid-input");
  const { pollWindowSeconds, leaseMs } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(pollWindowSeconds) || Number(pollWindowSeconds) < 1 || Number(pollWindowSeconds) > 3600) {
    throw new OutboundSyncError("invalid-input", "pollWindowSeconds is invalid.");
  }
  assertOutboundClaimLeaseMs(leaseMs);
  return { pollWindowMs: Number(pollWindowSeconds) * 1000, leaseMs };
}

async function readConnection(db: PgQueryable, connectionId: string): Promise<OutboundConnection | null> {
  const result = await db.query<{
    connection_id: string;
    provider_key: string;
    environment: "sandbox" | "production";
    status: OutboundConnection["status"];
  }>(
    `SELECT connection_id, provider_key, environment, status FROM channel_connections
     WHERE connection_id = $1 FOR SHARE`,
    [connectionId],
  );
  const row = result.rows[0];
  return row
    ? {
        connectionId: row.connection_id,
        providerKey: row.provider_key,
        environment: row.environment,
        status: row.status,
      }
    : null;
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value === null ? null : new Date(value).toISOString();
}
