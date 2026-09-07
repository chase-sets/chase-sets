import { randomUUID } from "node:crypto";
import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import type {
  ChannelProviderRegistry,
  ChannelPublicationRejectionCode,
  ChannelPublicationResult,
} from "../../publication-port/domain/contracts";
import { resolveConnectionExecutionAdmission } from "../domain/admission";
import {
  OUTBOUND_OPERATION_BUDGET_POLICY_FALLBACK,
  resolveOutboundOperationBudget,
  type OutboundOperationBudget,
  type OutboundOperationBudgetPolicyValue,
} from "../domain/policy";
import {
  OutboundSyncError,
  type ClaimedOperationClaimant,
  type ClaimedOperationOutcome,
  type OutboundConnection,
  type OutboundOperationLane,
  type OutboundOperationLogItem,
  type OutboundOperationLogPage,
  type OutboundOperationRecord,
  type OutboundOperationSummary,
  type OutboundSyncRuntimeDependencies,
} from "../domain/contracts";
import { assertClaimedOperationClaimant, assertClaimedOperationOutcome } from "../domain/validation";
import {
  createOutboundOperationStore,
  mapOutboundLaneRow,
  mapOutboundOperationRow,
  outboundOperationSqlColumns,
} from "./store";

type OperationRow = Parameters<typeof mapOutboundOperationRow>[0];
type LaneRow = Parameters<typeof mapOutboundLaneRow>[0];

type ProviderRateRow = Readonly<{
  provider_key: string;
  environment: "sandbox" | "production";
  window_started_at: Date | string;
  request_count: string | number;
  adaptive_divisor: string | number;
  throttled_until: Date | string | null;
  consecutive_successes: string | number;
  last_rate_limit_at: Date | string | null;
  revision: string | number;
}>;

type SummaryRow = Readonly<{
  total: number | string;
  succeeded: number | string;
  failed: number | string;
  pending: number | string;
  in_flight: number | string;
  blocked: number | string;
  inline_p50: number | string | null;
  inline_p95: number | string | null;
  inline_p99: number | string | null;
  claimed_p50: number | string | null;
  claimed_p95: number | string | null;
  claimed_p99: number | string | null;
}>;

const laneColumns = `connection_id, channel_listing_id, generation, blocked_operation_id,
  blocked_reason, blocked_at, cleared_at, revision`;

export function createOutboundSyncRuntime(
  dependencies: OutboundSyncRuntimeDependencies,
  options: Readonly<{ assertDelistDirective: (value: unknown) => void }>,
) {
  const store = createOutboundOperationStore(dependencies, options);
  const now = () => (dependencies.clock?.now() ?? new Date()).toISOString();

  return {
    ...store,

    processNextInlineOperation: async (input: {
      registry: ChannelProviderRegistry;
      claimOwnerId: string;
    }): Promise<number> => {
      if (!dependencies.recordOutcome) {
        throw new OutboundSyncError("invalid-input", "The canonical publication outcome writer is not bound.");
      }
      const policy = await (dependencies.resolveBudgetPolicy?.() ??
        Promise.resolve(OUTBOUND_OPERATION_BUDGET_POLICY_FALLBACK));
      const claim = await claimNextInline(dependencies, input.registry, input.claimOwnerId, policy, now());
      if (claim === null) return 0;
      if (claim.kind === "configuration-blocked") return 1;

      let result: ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>;
      try {
        const operation = claim.operation;
        if (operation.operationKind === "publish") {
          if (operation.payload.kind !== "draft") throw new Error("publish payload mismatch");
          result = await claim.publication.publishListing({
            operationId: operation.operationId,
            connectionId: operation.connectionId,
            draft: operation.payload.draft,
          });
        } else if (operation.operationKind === "update") {
          if (operation.payload.kind !== "draft") throw new Error("update payload mismatch");
          result = await claim.publication.updatePriceQuantity({
            operationId: operation.operationId,
            connectionId: operation.connectionId,
            channelListingId: operation.payload.draft.channelListingId,
            listingRevision: operation.payload.draft.listingRevision,
            price: operation.payload.draft.price,
            quantity: operation.payload.draft.quantity,
          });
        } else {
          result = await claim.publication.delistListing({
            operationId: operation.operationId,
            connectionId: operation.connectionId,
            channelListingId: operation.channelListingId,
            listingRevision: operation.listingRevision,
          });
        }
      } catch {
        result = { kind: "outcome-unknown" };
      }
      await settleInlineOperation(dependencies, claim.operation, result, claim.budget, now());
      return 1;
    },

    reportClaimedOperationOutcomes: async (input: {
      reservationId: string;
      claimant: ClaimedOperationClaimant;
      outcomes: readonly ClaimedOperationOutcome[];
      runSettlement?: Readonly<{ runId: string; expectedRunRevision: number }>;
    }): Promise<void> => {
      if (!dependencies.recordOutcome) {
        throw new OutboundSyncError("invalid-input", "The canonical publication outcome writer is not bound.");
      }
      assertClaimedOperationClaimant(input.claimant);
      if (!input.reservationId || input.reservationId.length > 512 || !Array.isArray(input.outcomes)) {
        throw new OutboundSyncError("invalid-input");
      }
      for (const outcome of input.outcomes) assertClaimedOperationOutcome(outcome);
      if (input.runSettlement) {
        throw new OutboundSyncError("run-settlement-unavailable", "The canonical #7029 run settlement is not installed.");
      }
      await withPgTransaction(dependencies.db, async (db) => {
        const members = await db.query<OperationRow>(
          `SELECT ${outboundOperationSqlColumns}
           FROM channel_outbound_operations
           WHERE reservation_id = $1 AND status = 'in-flight'
           ORDER BY operation_id
           FOR UPDATE`,
          [input.reservationId],
        );
        if (members.rows.length === 0 || members.rows.length !== input.outcomes.length) membershipMismatch();
        const reports = new Map(input.outcomes.map((outcome) => [outcome.operationId, outcome]));
        if (reports.size !== input.outcomes.length) membershipMismatch();
        const currentInstant = now();
        for (const row of members.rows) {
          const report = reports.get(row.operation_id);
          if (
            !report ||
            row.claimant_kind !== input.claimant.claimantKind ||
            row.claim_owner_id !== input.claimant.claimantId ||
            row.attempt_id !== report.attemptId ||
            Number(row.claim_generation) !== report.claimGeneration ||
            Number(row.source_desired_state_sequence) !== report.desiredStateSequence
          ) membershipMismatch();
          if (Date.parse(timestamp(row.claimed_until)!) <= Date.parse(currentInstant)) {
            throw new OutboundSyncError("reservation-expired");
          }
        }
        for (const row of members.rows) {
          await settleClaimedMember(dependencies, db, mapOutboundOperationRow(row), reports.get(row.operation_id)!, currentInstant);
        }
      });
    },

    recoverExpiredClaimedOperations: async (): Promise<number> =>
      withPgTransaction(dependencies.db, async (db) => {
        const table = await db.query<{ run_table: string | null }>(
          "SELECT to_regclass('channel_sync_runs')::text AS run_table",
        );
        const hasRunTable = table.rows[0]?.run_table === "channel_sync_runs";
        const superseded = await db.query(
          `DELETE FROM channel_outbound_operations AS expired
           WHERE expired.status = 'in-flight'
             AND expired.claimant_kind IN ('connector', 'manual')
             AND expired.claimed_until <= $1
             AND EXISTS (
               SELECT 1 FROM channel_outbound_operations AS pending
               WHERE pending.connection_id = expired.connection_id
                 AND pending.channel_listing_id = expired.channel_listing_id
                 AND pending.status = 'pending'
                 AND pending.source_desired_state_sequence > expired.source_desired_state_sequence
             )
             ${
               hasRunTable
                 ? "AND NOT EXISTS (SELECT 1 FROM channel_sync_runs AS run WHERE run.reservation_id = expired.reservation_id)"
                 : ""
             }`,
          [now()],
        );
        const result = await db.query(
          `UPDATE channel_outbound_operations AS operation
           SET status = 'pending', revision = operation.revision + 1, attempt_id = NULL,
               claimant_kind = NULL, claim_owner_id = NULL, reservation_id = NULL,
               claimed_until = NULL, next_attempt_at = $1
           WHERE operation.status = 'in-flight'
             AND operation.claimant_kind IN ('connector', 'manual')
             AND operation.claimed_until <= $1
             ${
               hasRunTable
                 ? "AND NOT EXISTS (SELECT 1 FROM channel_sync_runs AS run WHERE run.reservation_id = operation.reservation_id)"
                 : ""
             }`,
          [now()],
        );
        return Number(superseded.rowCount ?? 0) + Number(result.rowCount ?? 0);
      }),

    clearOutboundOperationLane: async (input: {
      connectionId: string;
      channelListingId: string;
      expectedRevision: number;
    }): Promise<OutboundOperationLane> => {
      if (!input.connectionId || !input.channelListingId || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new OutboundSyncError("invalid-input");
      }
      const result = await dependencies.db.query<LaneRow>(
        `UPDATE channel_outbound_lanes
         SET generation = generation + 1, blocked_operation_id = NULL, blocked_reason = NULL,
             blocked_at = NULL, cleared_at = $4, revision = revision + 1
         WHERE connection_id = $1 AND channel_listing_id = $2 AND revision = $3
         RETURNING ${laneColumns}`,
        [input.connectionId, input.channelListingId, input.expectedRevision, now()],
      );
      if (!result.rows[0]) throw new OutboundSyncError("stale-fence");
      return mapOutboundLaneRow(result.rows[0]);
    },

    readOutboundOperationLog: async (input: {
      accountId: string;
      connectionId: string;
      cursor?: string;
      limit?: number;
    }): Promise<OutboundOperationLogPage> => readOperationLog(dependencies.db, input),

    readOutboundOperationSummary: async (input: {
      accountId: string;
      connectionId: string;
      window: { from: string; to: string };
    }): Promise<OutboundOperationSummary> => readOperationSummary(dependencies.db, input),
  };
}

async function claimNextInline(
  dependencies: OutboundSyncRuntimeDependencies,
  registry: ChannelProviderRegistry,
  claimOwnerId: string,
  policy: OutboundOperationBudgetPolicyValue,
  claimedAt: string,
) {
  if (!claimOwnerId || claimOwnerId.length > 512) throw new OutboundSyncError("invalid-input");
  return withPgTransaction(dependencies.db, async (db) => {
    const candidates = await db.query<OperationRow & ConnectionCandidateRow>(
      `SELECT ${qualifiedOperationColumns()}, connection.provider_key, connection.environment,
              connection.status AS connection_status
       FROM channel_outbound_operations AS operation
       JOIN channel_connections AS connection ON connection.connection_id = operation.connection_id
       JOIN channel_outbound_lanes AS lane
         ON lane.connection_id = operation.connection_id
        AND lane.channel_listing_id = operation.channel_listing_id
       WHERE operation.status = 'pending' AND operation.next_attempt_at <= $1
         AND connection.status = 'active' AND lane.blocked_operation_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM channel_outbound_operations AS sibling
           WHERE sibling.connection_id = operation.connection_id
             AND sibling.channel_listing_id = operation.channel_listing_id
             AND sibling.status = 'in-flight'
         )
       ORDER BY (
         SELECT count(*) FROM channel_outbound_operations AS active
         WHERE active.connection_id = operation.connection_id AND active.status = 'in-flight'
       ), operation.enqueued_at, operation.operation_id
       LIMIT 64
       FOR UPDATE OF operation SKIP LOCKED`,
      [claimedAt],
    );

    for (const candidate of candidates.rows) {
      const connection: OutboundConnection = {
        connectionId: candidate.connection_id,
        providerKey: candidate.provider_key,
        environment: candidate.environment,
        status: candidate.connection_status,
      };
      const admission = resolveConnectionExecutionAdmission(registry, connection);
      if (admission.kind === "blocked") {
        await terminalConfigurationBlock(db, candidate, admission.reason, claimedAt);
        return { kind: "configuration-blocked" as const };
      }
      if (admission.kind !== "inline") continue;
      const resolved = resolveOutboundOperationBudget(policy, admission.providerIdentity);
      if (resolved.disabled) continue;
      const rateState = await lockRateState(db, admission.providerIdentity, resolved.budget, claimedAt);
      const effectiveMax = Math.max(
        1,
        Math.floor(resolved.budget.maxRequestsPerWindow / (resolved.incidentMultiplier * Number(rateState.adaptive_divisor))),
      );
      const throttledUntil = timestamp(rateState.throttled_until);
      if (throttledUntil && Date.parse(throttledUntil) > Date.parse(claimedAt)) continue;
      if (Number(rateState.request_count) >= effectiveMax) continue;
      const active = await db.query<{ active: number | string }>(
        `SELECT count(*)::integer AS active FROM channel_outbound_operations
         WHERE connection_id = $1 AND status = 'in-flight' AND claimant_kind = 'inline'`,
        [candidate.connection_id],
      );
      if (Number(active.rows[0]?.active ?? 0) >= resolved.budget.maxInFlightPerConnection) continue;
      if (Number(candidate.attempt_count) >= resolved.budget.maxAttempts) {
        await terminalConfigurationBlock(db, candidate, "attempts-exhausted", claimedAt);
        return { kind: "configuration-blocked" as const };
      }
      const attemptId = `coa_${randomUUID()}`;
      const claimedUntil = new Date(Date.parse(claimedAt) + resolved.budget.maxBackoffMs).toISOString();
      const updated = await db.query<OperationRow>(
        `UPDATE channel_outbound_operations
         SET status = 'in-flight', revision = revision + 1, attempt_id = $2,
             claim_generation = claim_generation + 1, claimant_kind = 'inline',
             claim_owner_id = $3, claimed_until = $4, attempt_count = attempt_count + 1,
             first_claimed_at = COALESCE(first_claimed_at, $5)
         WHERE operation_id = $1 AND status = 'pending' AND revision = $6
         RETURNING ${outboundOperationSqlColumns}`,
        [candidate.operation_id, attemptId, claimOwnerId, claimedUntil, claimedAt, candidate.revision],
      );
      if (!updated.rows[0]) throw new OutboundSyncError("stale-fence");
      const rateUpdated = await db.query(
        `UPDATE channel_provider_rate_state
         SET request_count = request_count + 1, revision = revision + 1
         WHERE provider_key = $1 AND environment = $2 AND revision = $3`,
        [admission.providerIdentity.providerKey, admission.providerIdentity.environment, rateState.revision],
      );
      if (Number(rateUpdated.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
      return {
        kind: "inline" as const,
        operation: mapOutboundOperationRow(updated.rows[0]),
        publication: admission.publication,
        budget: resolved.budget,
      };
    }
    return null;
  });
}

type ConnectionCandidateRow = Readonly<{
  provider_key: string;
  environment: "sandbox" | "production";
  connection_status: OutboundConnection["status"];
}>;

async function lockRateState(
  db: PgQueryable,
  identity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>,
  budget: OutboundOperationBudget,
  currentInstant: string,
): Promise<ProviderRateRow> {
  await db.query(
    `INSERT INTO channel_provider_rate_state (provider_key, environment, window_started_at)
     VALUES ($1, $2, $3) ON CONFLICT (provider_key, environment) DO NOTHING`,
    [identity.providerKey, identity.environment, currentInstant],
  );
  let state = await db.query<ProviderRateRow>(
    `SELECT provider_key, environment, window_started_at, request_count, adaptive_divisor,
            throttled_until, consecutive_successes, last_rate_limit_at, revision
     FROM channel_provider_rate_state
     WHERE provider_key = $1 AND environment = $2 FOR UPDATE`,
    [identity.providerKey, identity.environment],
  );
  const row = state.rows[0]!;
  if (Date.parse(currentInstant) - Date.parse(timestamp(row.window_started_at)!) >= budget.windowMs) {
    state = await db.query<ProviderRateRow>(
      `UPDATE channel_provider_rate_state
       SET window_started_at = $3, request_count = 0, throttled_until = NULL, revision = revision + 1
       WHERE provider_key = $1 AND environment = $2 AND revision = $4
       RETURNING provider_key, environment, window_started_at, request_count, adaptive_divisor,
                 throttled_until, consecutive_successes, last_rate_limit_at, revision`,
      [identity.providerKey, identity.environment, currentInstant, row.revision],
    );
  }
  return state.rows[0]!;
}

async function settleInlineOperation(
  dependencies: OutboundSyncRuntimeDependencies,
  operation: OutboundOperationRecord,
  result: ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>,
  budget: OutboundOperationBudget,
  terminalAt: string,
): Promise<void> {
  await withPgTransaction(dependencies.db, async (db) => {
    const locked = await lockOperationAttempt(db, operation);
    if (result.kind === "rejected" && (result.code === "rate-limited" || result.code === "provider-unavailable")) {
      if (locked.attemptCount >= budget.maxAttempts) {
        const linkState = await dependencies.recordOutcome!(db, locked, result);
        await terminalize(db, locked, "failed", "attempts-exhausted", result.code, linkState, terminalAt, true);
      } else {
        const delay = Math.min(budget.maxBackoffMs, budget.baseBackoffMs * 2 ** Math.min(locked.attemptCount, 10));
        const updated = await db.query(
          `UPDATE channel_outbound_operations
           SET status = 'pending', revision = revision + 1, attempt_id = NULL, claimant_kind = NULL,
               claim_owner_id = NULL, claimed_until = NULL, reservation_id = NULL,
               next_attempt_at = $6, last_rejection_code = $5
           WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2
             AND attempt_id = $3 AND claim_generation = $4`,
          [
            locked.operationId,
            locked.revision,
            locked.attemptId,
            locked.claimGeneration,
            result.code,
            new Date(Date.parse(terminalAt) + delay).toISOString(),
          ],
        );
        if (Number(updated.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
      }
      await recordRateResult(db, locked, result, budget, terminalAt);
      return;
    }
    const linkState = await dependencies.recordOutcome!(db, locked, result);
    if (result.kind === "succeeded") {
      await terminalize(db, locked, "succeeded", null, null, linkState, terminalAt, linkState === "link-write-refused");
    } else {
      const reason = result.kind === "rejected" ? result.code : "outcome-unknown";
      await terminalize(
        db,
        locked,
        "failed",
        reason,
        result.kind === "rejected" ? result.code : null,
        linkState,
        terminalAt,
        true,
      );
    }
    await recordRateResult(db, locked, result, budget, terminalAt);
  });
}

async function settleClaimedMember(
  dependencies: OutboundSyncRuntimeDependencies,
  db: PgQueryable,
  operation: OutboundOperationRecord,
  report: ClaimedOperationOutcome,
  terminalAt: string,
): Promise<void> {
  if (report.outcome.kind === "abandoned") {
    const newer = await db.query<{ operation_id: string }>(
      `SELECT operation_id FROM channel_outbound_operations
       WHERE connection_id = $1 AND channel_listing_id = $2 AND status = 'pending'
         AND source_desired_state_sequence > $3
       LIMIT 1 FOR UPDATE`,
      [operation.connectionId, operation.channelListingId, operation.sourceDesiredStateSequence],
    );
    if (newer.rows[0]) {
      const removed = await db.query(
        `DELETE FROM channel_outbound_operations
         WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2
           AND attempt_id = $3 AND claim_generation = $4 AND source_desired_state_sequence = $5`,
        [operation.operationId, operation.revision, operation.attemptId, operation.claimGeneration, operation.sourceDesiredStateSequence],
      );
      if (Number(removed.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
      return;
    }
    const result = await db.query(
      `UPDATE channel_outbound_operations
       SET status = 'pending', revision = revision + 1, attempt_id = NULL, claimant_kind = NULL,
           claim_owner_id = NULL, reservation_id = NULL, claimed_until = NULL, next_attempt_at = $6,
           terminal_reason = NULL, last_rejection_code = NULL
       WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2
         AND attempt_id = $3 AND claim_generation = $4 AND source_desired_state_sequence = $5`,
      [operation.operationId, operation.revision, operation.attemptId, operation.claimGeneration, operation.sourceDesiredStateSequence, terminalAt],
    );
    if (Number(result.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
    return;
  }
  const outcome =
    report.outcome.kind === "applied"
      ? report.outcome.result
      : report.outcome.kind === "rejected"
        ? { kind: "rejected" as const, code: report.outcome.code }
        : { kind: "outcome-unknown" as const };
  const linkState = await dependencies.recordOutcome!(db, operation, outcome);
  if (report.outcome.kind === "applied") {
    await terminalize(db, operation, "succeeded", null, null, linkState, terminalAt, linkState === "link-write-refused");
  } else {
    const reason = report.outcome.kind === "rejected" ? report.outcome.code : "outcome-unknown";
    await terminalize(
      db,
      operation,
      "failed",
      reason,
      report.outcome.kind === "rejected" ? report.outcome.code : null,
      linkState,
      terminalAt,
      true,
    );
  }
}

async function lockOperationAttempt(db: PgQueryable, expected: OutboundOperationRecord): Promise<OutboundOperationRecord> {
  const result = await db.query<OperationRow>(
    `SELECT ${outboundOperationSqlColumns} FROM channel_outbound_operations
     WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2
       AND attempt_id = $3 AND claim_generation = $4 FOR UPDATE`,
    [expected.operationId, expected.revision, expected.attemptId, expected.claimGeneration],
  );
  if (!result.rows[0]) throw new OutboundSyncError("stale-fence");
  return mapOutboundOperationRow(result.rows[0]);
}

async function terminalize(
  db: PgQueryable,
  operation: OutboundOperationRecord,
  status: "succeeded" | "failed",
  terminalReason: string | null,
  rejectionCode: ChannelPublicationRejectionCode | null,
  linkWriteState: "applied" | "link-write-refused",
  terminalAt: string,
  block: boolean,
): Promise<void> {
  const result = await db.query(
    `UPDATE channel_outbound_operations
     SET status = $5, revision = revision + 1, terminal_reason = $6,
         last_rejection_code = $7, link_write_state = $8, terminal_at = $9, claimed_until = NULL
     WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2
       AND attempt_id = $3 AND claim_generation = $4`,
    [operation.operationId, operation.revision, operation.attemptId, operation.claimGeneration, status, terminalReason, rejectionCode, linkWriteState, terminalAt],
  );
  if (Number(result.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
  if (block) await blockLane(db, operation, terminalReason ?? linkWriteState, terminalAt);
}

async function terminalConfigurationBlock(db: PgQueryable, row: OperationRow, reason: string, terminalAt: string) {
  const result = await db.query(
    `UPDATE channel_outbound_operations
     SET status = 'failed', revision = revision + 1, terminal_reason = $3,
         terminal_at = $4, link_write_state = 'pending'
     WHERE operation_id = $1 AND status = 'pending' AND revision = $2`,
    [row.operation_id, row.revision, reason, terminalAt],
  );
  if (Number(result.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
  await blockLane(db, mapOutboundOperationRow(row), reason, terminalAt);
}

async function blockLane(db: PgQueryable, operation: OutboundOperationRecord, reason: string, blockedAt: string) {
  const result = await db.query(
    `UPDATE channel_outbound_lanes
     SET blocked_operation_id = $3, blocked_reason = $4, blocked_at = $5,
         cleared_at = NULL, revision = revision + 1
     WHERE connection_id = $1 AND channel_listing_id = $2
       AND (blocked_operation_id IS NULL OR blocked_operation_id = $3)`,
    [operation.connectionId, operation.channelListingId, operation.operationId, reason, blockedAt],
  );
  if (Number(result.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
}

async function recordRateResult(
  db: PgQueryable,
  operation: OutboundOperationRecord,
  result: ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>,
  budget: OutboundOperationBudget,
  at: string,
) {
  const connection = await readConnection(db, operation.connectionId);
  if (!connection) throw new OutboundSyncError("connection-not-found");
  if (result.kind === "rejected" && result.code === "rate-limited") {
    await db.query(
      `UPDATE channel_provider_rate_state
       SET adaptive_divisor = LEAST(64, adaptive_divisor * 2), throttled_until = $3,
           consecutive_successes = 0, last_rate_limit_at = $3, revision = revision + 1
       WHERE provider_key = $1 AND environment = $2`,
      [connection.providerKey, connection.environment, at],
    );
  } else if (result.kind === "succeeded") {
    await db.query(
      `UPDATE channel_provider_rate_state
       SET consecutive_successes = consecutive_successes + 1,
           adaptive_divisor = CASE WHEN consecutive_successes + 1 >= $3 THEN GREATEST(1, adaptive_divisor / 2) ELSE adaptive_divisor END,
           consecutive_successes = CASE WHEN consecutive_successes + 1 >= $3 THEN 0 ELSE consecutive_successes + 1 END,
           revision = revision + 1
       WHERE provider_key = $1 AND environment = $2`,
      [connection.providerKey, connection.environment, budget.maxRequestsPerWindow],
    );
  }
}

async function readConnection(db: PgQueryable, connectionId: string): Promise<OutboundConnection | null> {
  const result = await db.query<{
    connection_id: string;
    provider_key: string;
    environment: "sandbox" | "production";
    status: OutboundConnection["status"];
  }>("SELECT connection_id, provider_key, environment, status FROM channel_connections WHERE connection_id = $1", [connectionId]);
  const row = result.rows[0];
  return row ? { connectionId: row.connection_id, providerKey: row.provider_key, environment: row.environment, status: row.status } : null;
}

async function readOperationLog(
  db: PgQueryable,
  input: { accountId: string; connectionId: string; cursor?: string; limit?: number },
): Promise<OutboundOperationLogPage> {
  const limit = input.limit ?? 50;
  if (!input.accountId || !input.connectionId || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new OutboundSyncError("invalid-input");
  }
  const cursor = input.cursor ? decodeCursor(input.cursor, input.connectionId) : null;
  const values: unknown[] = [input.accountId, input.connectionId, limit + 1];
  const cursorClause = cursor ? "AND (operation.enqueued_at, operation.operation_id) < ($4::timestamptz, $5)" : "";
  if (cursor) values.push(cursor.enqueuedAt, cursor.operationId);
  const [rows, total] = await Promise.all([
    db.query<OperationRow>(
      `SELECT ${qualifiedOperationColumns()}
       FROM channel_outbound_operations AS operation
       JOIN channel_connections AS connection ON connection.connection_id = operation.connection_id
       WHERE connection.account_id = $1 AND operation.connection_id = $2 ${cursorClause}
       ORDER BY operation.enqueued_at DESC, operation.operation_id DESC LIMIT $3`,
      values,
    ),
    db.query<{ total: number | string }>(
      `SELECT count(*)::integer AS total
       FROM channel_outbound_operations AS operation
       JOIN channel_connections AS connection ON connection.connection_id = operation.connection_id
       WHERE connection.account_id = $1 AND operation.connection_id = $2`,
      [input.accountId, input.connectionId],
    ),
  ]);
  const totalCount = Number(total.rows[0]?.total ?? 0);
  const page = rows.rows.slice(0, limit).map(toLogItem);
  const next = rows.rows.length > limit ? rows.rows[limit - 1] : null;
  return {
    items: page,
    ...(next
      ? { nextCursor: encodeCursor({ connectionId: input.connectionId, enqueuedAt: timestamp(next.enqueued_at)!, operationId: next.operation_id }) }
      : {}),
    completeness: Number.isSafeInteger(totalCount) && totalCount >= page.length
      ? { kind: "complete", total: totalCount }
      : { kind: "bounded-incomplete", reason: "authoritative-total-unavailable" },
  };
}

async function readOperationSummary(
  db: PgQueryable,
  input: { accountId: string; connectionId: string; window: { from: string; to: string } },
): Promise<OutboundOperationSummary> {
  if (!input.accountId || !input.connectionId || !instant(input.window.from) || !instant(input.window.to) || Date.parse(input.window.from) >= Date.parse(input.window.to)) {
    throw new OutboundSyncError("invalid-input");
  }
  const result = await db.query<SummaryRow>(
    `SELECT count(*)::integer AS total,
            count(*) FILTER (WHERE operation.status = 'succeeded')::integer AS succeeded,
            count(*) FILTER (WHERE operation.status = 'failed')::integer AS failed,
            count(*) FILTER (WHERE operation.status = 'pending')::integer AS pending,
            count(*) FILTER (WHERE operation.status = 'in-flight')::integer AS in_flight,
            count(DISTINCT lane.channel_listing_id) FILTER (WHERE lane.blocked_operation_id IS NOT NULL)::integer AS blocked,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (operation.terminal_at - operation.source_occurred_at)) * 1000)
              FILTER (WHERE operation.claimant_kind = 'inline' AND operation.terminal_at IS NOT NULL) AS inline_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (operation.terminal_at - operation.source_occurred_at)) * 1000)
              FILTER (WHERE operation.claimant_kind = 'inline' AND operation.terminal_at IS NOT NULL) AS inline_p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (operation.terminal_at - operation.source_occurred_at)) * 1000)
              FILTER (WHERE operation.claimant_kind = 'inline' AND operation.terminal_at IS NOT NULL) AS inline_p99,
            percentile_cont(0.50) WITHIN GROUP (ORDER BY extract(epoch FROM (operation.terminal_at - operation.source_occurred_at)) * 1000)
              FILTER (WHERE operation.claimant_kind IN ('connector', 'manual') AND operation.terminal_at IS NOT NULL) AS claimed_p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (operation.terminal_at - operation.source_occurred_at)) * 1000)
              FILTER (WHERE operation.claimant_kind IN ('connector', 'manual') AND operation.terminal_at IS NOT NULL) AS claimed_p95,
            percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM (operation.terminal_at - operation.source_occurred_at)) * 1000)
              FILTER (WHERE operation.claimant_kind IN ('connector', 'manual') AND operation.terminal_at IS NOT NULL) AS claimed_p99
     FROM channel_outbound_operations AS operation
     JOIN channel_connections AS connection ON connection.connection_id = operation.connection_id
     LEFT JOIN channel_outbound_lanes AS lane
       ON lane.connection_id = operation.connection_id AND lane.channel_listing_id = operation.channel_listing_id
     WHERE connection.account_id = $1 AND operation.connection_id = $2
       AND operation.source_occurred_at >= $3 AND operation.source_occurred_at < $4`,
    [input.accountId, input.connectionId, input.window.from, input.window.to],
  );
  const row = result.rows[0];
  if (!row) return emptySummary();
  const total = Number(row.total);
  return {
    completeness: Number.isSafeInteger(total) ? { kind: "complete", total } : { kind: "bounded-incomplete", reason: "authoritative-total-unavailable" },
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
    pending: Number(row.pending),
    inFlight: Number(row.in_flight),
    blocked: Number(row.blocked),
    inlineEventToProviderAckMs: percentiles(row.inline_p50, row.inline_p95, row.inline_p99),
    claimedEventToProviderAckMs: percentiles(row.claimed_p50, row.claimed_p95, row.claimed_p99),
  };
}

function toLogItem(row: OperationRow): OutboundOperationLogItem {
  const source = Date.parse(timestamp(row.source_occurred_at)!);
  const enqueued = Date.parse(timestamp(row.enqueued_at)!);
  const terminal = row.terminal_at === null ? null : Date.parse(timestamp(row.terminal_at)!);
  return {
    operationId: row.operation_id,
    channelListingId: row.channel_listing_id,
    listingId: row.listing_id,
    operationKind: row.operation_kind,
    status: row.status,
    terminalReason: row.terminal_reason,
    rejectionCode: row.last_rejection_code,
    attemptCount: Number(row.attempt_count),
    linkWriteState: row.link_write_state,
    sourceOccurredAt: timestamp(row.source_occurred_at)!,
    enqueuedAt: timestamp(row.enqueued_at)!,
    terminalAt: timestamp(row.terminal_at),
    eventToEnqueueMs: enqueued - source,
    enqueueToTerminalMs: terminal === null ? null : terminal - enqueued,
    eventToProviderAckMs: terminal === null ? null : terminal - source,
  };
}

function qualifiedOperationColumns(): string {
  return outboundOperationSqlColumns.split(",").map((column) => `operation.${column.trim()}`).join(", ");
}

function membershipMismatch(): never {
  throw new OutboundSyncError("reservation-membership-mismatch");
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value === null ? null : new Date(value).toISOString();
}

function instant(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function encodeCursor(value: { connectionId: string; enqueuedAt: string; operationId: string }): string {
  return Buffer.from(JSON.stringify({ version: "channels-outbound-log/v1", ...value }), "utf8").toString("base64url");
}

function decodeCursor(value: string, connectionId: string): { enqueuedAt: string; operationId: string } {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !== "connectionId,enqueuedAt,operationId,version" ||
      parsed.version !== "channels-outbound-log/v1" || parsed.connectionId !== connectionId ||
      typeof parsed.operationId !== "string" || typeof parsed.enqueuedAt !== "string" || !instant(parsed.enqueuedAt)
    ) throw new Error();
    return { enqueuedAt: parsed.enqueuedAt, operationId: parsed.operationId };
  } catch {
    throw new OutboundSyncError("invalid-input", "invalid-page");
  }
}

function percentiles(p50: number | string | null, p95: number | string | null, p99: number | string | null) {
  return { p50: nullableNumber(p50), p95: nullableNumber(p95), p99: nullableNumber(p99) };
}

function nullableNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function emptySummary(): OutboundOperationSummary {
  return {
    completeness: { kind: "complete", total: 0 }, succeeded: 0, failed: 0, pending: 0, inFlight: 0, blocked: 0,
    inlineEventToProviderAckMs: { p50: null, p95: null, p99: null },
    claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
  };
}
