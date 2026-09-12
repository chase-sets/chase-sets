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
import { resolveInlineRejectionDisposition } from "../domain/rejection";
import {
  OutboundSyncError,
  type ClaimedOperationClaimant,
  type ClaimedOperationOutcome,
  type ClaimedReservationRunSettlement,
  type BoundClaimedReservationRun,
  type OutboundConnection,
  type OutboundOperationLane,
  type OutboundOperationLogItem,
  type OutboundOperationLogPage,
  type OutboundOperationRecord,
  type OutboundOperationSummary,
  type OutboundSyncRuntimeDependencies,
} from "../domain/contracts";
import { assertClaimedOperationClaimant, assertClaimedOperationOutcome, canonicalJson } from "../domain/validation";
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
  request_count: number;
  adaptive_divisor: number;
  throttled_until: Date | string | null;
  consecutive_successes: number;
  last_rate_limit_at: Date | string | null;
  revision: string;
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
      const currentInstant = now();
      const batch = await claimNextInlineBatch(
        dependencies,
        input.registry,
        input.claimOwnerId,
        policy,
        currentInstant,
      );
      const attempted = await Promise.all(
        batch.claims.map(async (claim) => {
          const result = await invokeInlineOperation(claim);
          return { claim, result, terminalAt: now() };
        }),
      );
      if (attempted.length > 0) await settleInlineOperationBatch(dependencies, attempted);
      return batch.configurationBlocked + batch.claims.length;
    },

    reportClaimedOperationOutcomes: async (input: {
      reservationId: string;
      claimant: ClaimedOperationClaimant;
      outcomes: readonly ClaimedOperationOutcome[];
      runSettlement?: ClaimedReservationRunSettlement;
    }): Promise<void> => {
      if (!dependencies.recordOutcome) {
        throw new OutboundSyncError("invalid-input", "The canonical publication outcome writer is not bound.");
      }
      assertClaimedOperationClaimant(input.claimant);
      if (!input.reservationId || input.reservationId.length > 512 || !Array.isArray(input.outcomes)) {
        throw new OutboundSyncError("invalid-input");
      }
      for (const outcome of input.outcomes) assertClaimedOperationOutcome(outcome);
      assertRunSettlement(input.runSettlement);
      await withPgTransaction(dependencies.db, async (db) => {
        const receipt = await db.query<{
          claimant: unknown;
          outcomes: unknown;
          run_settlement: unknown;
        }>(
          `SELECT claimant,outcomes,run_settlement FROM channel_outbound_reservation_settlements
           WHERE reservation_id=$1 FOR UPDATE`,
          [input.reservationId],
        );
        if (receipt.rows[0]) {
          assertSettlementReceiptMatches(receipt.rows[0], input.claimant, input.outcomes, input.runSettlement);
          return;
        }
        const members = await db.query<OperationRow>(
          `SELECT ${outboundOperationSqlColumns}
           FROM channel_outbound_operations
           WHERE reservation_id = $1 AND status = 'in-flight'
           ORDER BY operation_id
           FOR UPDATE`,
          [input.reservationId],
        );
        if (members.rows.length === 0) {
          const concurrentlySettled = await db.query<{
            claimant: unknown;
            outcomes: unknown;
            run_settlement: unknown;
          }>(
            `SELECT claimant,outcomes,run_settlement FROM channel_outbound_reservation_settlements
             WHERE reservation_id=$1 FOR UPDATE`,
            [input.reservationId],
          );
          if (concurrentlySettled.rows[0]) {
            assertSettlementReceiptMatches(
              concurrentlySettled.rows[0],
              input.claimant,
              input.outcomes,
              input.runSettlement,
            );
            return;
          }
          membershipMismatch();
        }
        if (members.rows.length !== input.outcomes.length) membershipMismatch();
        const reports = new Map(input.outcomes.map((outcome) => [outcome.operationId, outcome]));
        if (reports.size !== input.outcomes.length) membershipMismatch();
        const port = dependencies.claimedReservationRunSettlement;
        if (input.runSettlement && !port) {
          throw new OutboundSyncError(
            "run-settlement-unavailable",
            "The downstream run settlement port is not installed.",
          );
        }
        const currentInstant = now();
        const expired = members.rows.every(
          (row) => Date.parse(timestamp(row.claimed_until)!) <= Date.parse(currentInstant),
        );
        let boundRun: BoundClaimedReservationRun | null = null;
        if (input.runSettlement) {
          boundRun = await port!.lockBoundRun(db, {
            reservationId: input.reservationId,
            runId: input.runSettlement.runId,
            expectedRunRevision: input.runSettlement.expectedRunRevision,
          });
          if (!boundRun) throw new OutboundSyncError("stale-fence", "The bound run fence did not match.");
          assertBoundRunIdentity(boundRun, input.claimant, members.rows);
          if (
            boundRun.state !== input.runSettlement.fromState ||
            boundRun.revision !== input.runSettlement.expectedRunRevision
          ) {
            throw new OutboundSyncError("stale-fence", "The bound run transition fence did not match.");
          }
        }
        for (const row of members.rows) {
          const report = reports.get(row.operation_id);
          if (
            !report ||
            row.claimant_kind !== input.claimant.claimantKind ||
            row.claim_owner_id !== input.claimant.claimantId ||
            row.attempt_id !== report.attemptId ||
            Number(row.claim_generation) !== report.claimGeneration ||
            Number(row.source_desired_state_sequence) !== report.desiredStateSequence
          )
            membershipMismatch();
          if (!input.runSettlement && expired) {
            throw new OutboundSyncError("reservation-expired");
          }
        }
        for (const row of members.rows) {
          await settleClaimedMember(
            dependencies,
            db,
            mapOutboundOperationRow(row),
            reports.get(row.operation_id)!,
            currentInstant,
          );
        }
        if (boundRun && input.runSettlement) {
          await port!.settleBoundRun(db, {
            ...input.runSettlement,
            reservationId: input.reservationId,
            outcomes: input.outcomes,
          });
        }
        await writeSettlementReceipt(
          db,
          input.reservationId,
          input.claimant,
          input.outcomes,
          input.runSettlement,
          currentInstant,
        );
      });
    },

    recoverExpiredClaimedOperations: async (): Promise<number> => {
      const currentInstant = now();
      const recoveredInline = dependencies.recordOutcome
        ? await recoverExpiredInlineAttempts(dependencies, currentInstant)
        : 0;
      if (dependencies.claimedReservationRunSettlement) {
        if (!dependencies.recordOutcome) {
          throw new OutboundSyncError("invalid-input", "The canonical publication outcome writer is not bound.");
        }
        return recoveredInline + (await recoverExpiredReservationsWithBoundRuns(dependencies, currentInstant));
      }
      return (
        recoveredInline +
        (await withPgTransaction(dependencies.db, async (db) => {
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
            [currentInstant],
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
            [currentInstant],
          );
          return Number(superseded.rowCount ?? 0) + Number(result.rowCount ?? 0);
        }))
      );
    },

    clearOutboundOperationLane: async (input: {
      connectionId: string;
      channelListingId: string;
      expectedRevision: number;
    }): Promise<OutboundOperationLane> => {
      if (
        !input.connectionId ||
        !input.channelListingId ||
        !Number.isSafeInteger(input.expectedRevision) ||
        input.expectedRevision < 1
      ) {
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

async function recoverExpiredInlineAttempts(
  dependencies: OutboundSyncRuntimeDependencies,
  currentInstant: string,
): Promise<number> {
  return withPgTransaction(dependencies.db, async (db) => {
    const expired = await db.query<OperationRow>(
      `SELECT ${outboundOperationSqlColumns}
       FROM channel_outbound_operations
       WHERE status = 'in-flight' AND claimant_kind = 'inline' AND claimed_until <= $1
       ORDER BY claimed_until, operation_id
       LIMIT 64
       FOR UPDATE SKIP LOCKED`,
      [currentInstant],
    );
    for (const row of expired.rows) {
      const operation = mapOutboundOperationRow(row);
      const linkState = await dependencies.recordOutcome!(db, operation, { kind: "outcome-unknown" });
      await terminalize(db, operation, "failed", "outcome-unknown", null, linkState, currentInstant, true);
    }
    return expired.rows.length;
  });
}

async function recoverExpiredReservationsWithBoundRuns(
  dependencies: OutboundSyncRuntimeDependencies,
  currentInstant: string,
): Promise<number> {
  return withPgTransaction(dependencies.db, async (db) => {
    const candidates = await db.query<Pick<OperationRow, "reservation_id">>(
      `SELECT reservation_id
       FROM channel_outbound_operations
       WHERE status = 'in-flight' AND claimant_kind IN ('connector', 'manual')
         AND claimed_until <= $1 AND reservation_id IS NOT NULL
       ORDER BY claimed_until, operation_id
       LIMIT 100
       FOR UPDATE SKIP LOCKED`,
      [currentInstant],
    );
    const reservationIds = [...new Set(candidates.rows.map((row) => row.reservation_id).filter(isText))];
    let settled = 0;
    for (const reservationId of reservationIds) {
      const members = await db.query<OperationRow>(
        `SELECT ${outboundOperationSqlColumns}
         FROM channel_outbound_operations
         WHERE reservation_id = $1 AND status = 'in-flight'
         ORDER BY operation_id
         FOR UPDATE`,
        [reservationId],
      );
      if (members.rows.length === 0) continue;
      const boundRun = await dependencies.claimedReservationRunSettlement!.lockBoundRun(db, { reservationId });
      if (!boundRun) {
        for (const row of members.rows) await recoverUnboundExpiredMember(db, row, currentInstant);
        settled += members.rows.length;
        continue;
      }
      if (boundRun.state === "terminal") continue;
      const claimant = claimantFromRow(members.rows[0]!);
      assertExpiredBoundRunSettlement(boundRun, claimant, members.rows, currentInstant);
      const reports = new Map(boundRun.outcomes.map((outcome) => [outcome.operationId, outcome]));
      for (const row of members.rows) {
        await settleClaimedMember(
          dependencies,
          db,
          mapOutboundOperationRow(row),
          reports.get(row.operation_id)!,
          currentInstant,
        );
      }
      const runSettlement: ClaimedReservationRunSettlement = {
        runId: boundRun.runId,
        expectedRunRevision: boundRun.revision,
        fromState: nonTerminalRunState(boundRun),
        toState: boundRun.state === "awaiting-verification" ? "application-unknown" : "abandoned",
        verificationSnapshotId: null,
        verificationSnapshotGeneration: null,
        uploadAttemptedAt: null,
        uploadFileName: null,
        importSummary: null,
        context: null,
      };
      await dependencies.claimedReservationRunSettlement!.settleBoundRun(db, {
        ...runSettlement,
        reservationId,
        outcomes: boundRun.outcomes,
      });
      await writeSettlementReceipt(db, reservationId, claimant, boundRun.outcomes, runSettlement, currentInstant);
      settled += members.rows.length;
    }
    return settled;
  });
}

async function recoverUnboundExpiredMember(db: PgQueryable, row: OperationRow, currentInstant: string): Promise<void> {
  const newer = await db.query<{ operation_id: string }>(
    `SELECT operation_id FROM channel_outbound_operations
     WHERE connection_id = $1 AND channel_listing_id = $2 AND status = 'pending'
       AND source_desired_state_sequence > $3
     LIMIT 1 FOR UPDATE`,
    [row.connection_id, row.channel_listing_id, row.source_desired_state_sequence],
  );
  const result = newer.rows[0]
    ? await db.query(
        `DELETE FROM channel_outbound_operations
         WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2
           AND attempt_id = $3 AND claim_generation = $4 AND reservation_id = $5
           AND source_desired_state_sequence = $6`,
        [
          row.operation_id,
          row.revision,
          row.attempt_id,
          row.claim_generation,
          row.reservation_id,
          row.source_desired_state_sequence,
        ],
      )
    : await db.query(
        `UPDATE channel_outbound_operations
         SET status = 'pending', revision = revision + 1, attempt_id = NULL,
             claimant_kind = NULL, claim_owner_id = NULL, reservation_id = NULL,
             claimed_until = NULL, next_attempt_at = $7
         WHERE operation_id = $1 AND status = 'in-flight' AND revision = $2
           AND attempt_id = $3 AND claim_generation = $4 AND reservation_id = $5
           AND source_desired_state_sequence = $6`,
        [
          row.operation_id,
          row.revision,
          row.attempt_id,
          row.claim_generation,
          row.reservation_id,
          row.source_desired_state_sequence,
          currentInstant,
        ],
      );
  if (Number(result.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
}

async function claimNextInlineBatch(
  dependencies: OutboundSyncRuntimeDependencies,
  registry: ChannelProviderRegistry,
  claimOwnerId: string,
  policy: OutboundOperationBudgetPolicyValue,
  claimedAt: string,
) {
  if (!claimOwnerId || claimOwnerId.length > 512) throw new OutboundSyncError("invalid-input");
  return withPgTransaction(dependencies.db, async (db) => {
    const candidates = await db.query<OperationRow & ConnectionCandidateRow>(
      `WITH connection_load AS MATERIALIZED (
         SELECT active.connection_id, count(*)::integer AS active_claims
         FROM channel_outbound_operations AS active
         WHERE active.status = 'in-flight'
         GROUP BY active.connection_id
       ), candidate_ids AS MATERIALIZED (
         SELECT candidate.operation_id, COALESCE(connection_load.active_claims, 0) AS active_claims,
                candidate.enqueued_at
         FROM channel_connections AS eligible
         LEFT JOIN connection_load ON connection_load.connection_id = eligible.connection_id
         CROSS JOIN LATERAL (
           SELECT pending.operation_id, pending.enqueued_at
           FROM channel_outbound_operations AS pending
           JOIN channel_outbound_lanes AS pending_lane
             ON pending_lane.connection_id = pending.connection_id
            AND pending_lane.channel_listing_id = pending.channel_listing_id
           WHERE pending.connection_id = eligible.connection_id
             AND pending.status = 'pending' AND pending.next_attempt_at <= $1
             AND pending_lane.blocked_operation_id IS NULL
             AND pending.operation_id = (
               SELECT earliest.operation_id FROM channel_outbound_operations AS earliest
               WHERE earliest.connection_id=pending.connection_id
                 AND earliest.channel_listing_id=pending.channel_listing_id
                 AND earliest.status='pending'
               ORDER BY earliest.enqueued_at,earliest.operation_id LIMIT 1
             )
             AND NOT EXISTS (
               SELECT 1 FROM channel_outbound_operations AS sibling
               WHERE sibling.connection_id = pending.connection_id
                 AND sibling.channel_listing_id = pending.channel_listing_id
                 AND sibling.status = 'in-flight'
             )
           ORDER BY pending.enqueued_at, pending.operation_id
           LIMIT 64
         ) AS candidate
         WHERE eligible.status = 'active'
         ORDER BY active_claims, candidate.enqueued_at, candidate.operation_id
         LIMIT 4096
       )
       SELECT ${qualifiedOperationColumns()}, connection.provider_key, connection.environment,
              connection.status AS connection_status
       FROM candidate_ids AS candidate
       JOIN channel_outbound_operations AS operation ON operation.operation_id = candidate.operation_id
       JOIN channel_connections AS connection ON connection.connection_id = operation.connection_id
       JOIN channel_outbound_lanes AS lane
         ON lane.connection_id = operation.connection_id
        AND lane.channel_listing_id = operation.channel_listing_id
       WHERE operation.status = 'pending' AND operation.next_attempt_at <= $1
         AND connection.status = 'active' AND lane.blocked_operation_id IS NULL
       ORDER BY candidate.active_claims, candidate.enqueued_at, operation.operation_id
       FOR UPDATE OF operation SKIP LOCKED`,
      [claimedAt],
    );

    const claims: Array<{
      operation: OutboundOperationRecord;
      providerIdentity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>;
      publication: Extract<
        NonNullable<ReturnType<ChannelProviderRegistry["get"]>>["publication"],
        { execution: "inline" }
      >;
      budget: OutboundOperationBudget;
    }> = [];
    let configurationBlocked = 0;
    const providerClaims = new Map<
      string,
      {
        identity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>;
        rateState: ProviderRateRow;
        requestCount: number;
      }
    >();
    const connectionActiveClaims = new Map<string, number>();
    for (const candidate of candidates.rows) {
      if (claims.length + configurationBlocked >= 64) break;
      const connection: OutboundConnection = {
        connectionId: candidate.connection_id,
        providerKey: candidate.provider_key,
        environment: candidate.environment,
        status: candidate.connection_status,
      };
      const admission = resolveConnectionExecutionAdmission(registry, connection);
      if (admission.kind === "blocked") {
        await terminalConfigurationBlock(db, candidate, admission.reason, claimedAt);
        configurationBlocked += 1;
        continue;
      }
      if (admission.kind !== "inline") continue;
      const additionalHold = await dependencies.readAdditionalOutboundHold({
        connectionId: connection.connectionId,
        providerIdentity: admission.providerIdentity,
      });
      assertAdditionalOutboundHold(additionalHold);
      if (additionalHold.held) continue;
      const resolved = resolveOutboundOperationBudget(
        policy,
        admission.providerIdentity,
        dependencies.compiledProviderBudgets,
      );
      if (resolved.disabled) continue;
      const providerKey = `${admission.providerIdentity.providerKey}\0${admission.providerIdentity.environment}`;
      let providerClaim = providerClaims.get(providerKey);
      if (!providerClaim) {
        providerClaim = {
          identity: admission.providerIdentity,
          rateState: await lockRateState(db, admission.providerIdentity, resolved.budget, claimedAt),
          requestCount: 0,
        };
        providerClaims.set(providerKey, providerClaim);
      }
      const effectiveMax = Math.max(
        1,
        Math.floor(
          resolved.budget.maxRequestsPerWindow /
            (resolved.incidentMultiplier * Number(providerClaim.rateState.adaptive_divisor)),
        ),
      );
      const throttledUntil = timestamp(providerClaim.rateState.throttled_until);
      if (throttledUntil && Date.parse(throttledUntil) > Date.parse(claimedAt)) continue;
      if (Number(providerClaim.rateState.request_count) + providerClaim.requestCount >= effectiveMax) continue;
      let activeClaims = connectionActiveClaims.get(candidate.connection_id);
      if (activeClaims === undefined) {
        const active = await db.query<{ active: number | string }>(
          `SELECT count(*)::integer AS active FROM channel_outbound_operations
           WHERE connection_id = $1 AND status = 'in-flight' AND claimant_kind = 'inline'`,
          [candidate.connection_id],
        );
        activeClaims = Number(active.rows[0]?.active ?? 0);
        connectionActiveClaims.set(candidate.connection_id, activeClaims);
      }
      if (activeClaims >= resolved.budget.maxInFlightPerConnection) continue;
      if (Number(candidate.attempt_count) >= resolved.budget.maxAttempts) {
        await terminalConfigurationBlock(db, candidate, "attempts-exhausted", claimedAt);
        configurationBlocked += 1;
        continue;
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
      providerClaim.requestCount += 1;
      connectionActiveClaims.set(candidate.connection_id, activeClaims + 1);
      claims.push({
        operation: mapOutboundOperationRow(updated.rows[0]),
        providerIdentity: admission.providerIdentity,
        publication: admission.publication,
        budget: resolved.budget,
      });
    }
    for (const providerClaim of providerClaims.values()) {
      if (providerClaim.requestCount === 0) continue;
      const rateUpdated = await db.query(
        `UPDATE channel_provider_rate_state
         SET request_count = request_count + $4, revision = revision + 1
         WHERE provider_key = $1 AND environment = $2 AND revision = $3`,
        [
          providerClaim.identity.providerKey,
          providerClaim.identity.environment,
          providerClaim.rateState.revision,
          providerClaim.requestCount,
        ],
      );
      if (Number(rateUpdated.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
    }
    return { claims, configurationBlocked };
  });
}

function assertAdditionalOutboundHold(value: unknown): asserts value is Readonly<{
  held: boolean;
  sources: readonly ("health" | "operator-kill")[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OutboundSyncError("invalid-input");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "held" && key !== "sources") ||
    typeof record.held !== "boolean" ||
    !Array.isArray(record.sources) ||
    record.sources.some((source) => source !== "health" && source !== "operator-kill") ||
    new Set(record.sources).size !== record.sources.length ||
    record.held !== record.sources.length > 0
  ) {
    throw new OutboundSyncError("invalid-input", "Additional outbound hold result is invalid.");
  }
}

async function invokeInlineOperation(claim: {
  operation: OutboundOperationRecord;
  budget: OutboundOperationBudget;
  publication: Extract<NonNullable<ReturnType<ChannelProviderRegistry["get"]>>["publication"], { execution: "inline" }>;
}): Promise<ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>> {
  try {
    const operation = claim.operation;
    if (operation.operationKind === "publish") {
      if (operation.payload.kind !== "draft") throw new Error("publish payload mismatch");
      return await withinProviderAttemptLease(
        claim.publication.publishListing({
          operationId: operation.operationId,
          connectionId: operation.connectionId,
          draft: operation.payload.draft,
        }),
        claim.budget.maxBackoffMs,
      );
    }
    if (operation.operationKind === "update") {
      if (operation.payload.kind !== "draft") throw new Error("update payload mismatch");
      return await withinProviderAttemptLease(
        claim.publication.updatePriceQuantity({
          operationId: operation.operationId,
          connectionId: operation.connectionId,
          channelListingId: operation.payload.draft.channelListingId,
          listingRevision: operation.payload.draft.listingRevision,
          price: operation.payload.draft.price,
          quantity: operation.payload.draft.quantity,
        }),
        claim.budget.maxBackoffMs,
      );
    }
    return await withinProviderAttemptLease(
      claim.publication.delistListing({
        operationId: operation.operationId,
        connectionId: operation.connectionId,
        channelListingId: operation.channelListingId,
        listingRevision: operation.listingRevision,
      }),
      claim.budget.maxBackoffMs,
    );
  } catch {
    return { kind: "outcome-unknown" };
  }
}

async function withinProviderAttemptLease<T>(attempt: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      attempt,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("provider-attempt-timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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
  assertLockedProviderRateState(row);
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

function assertLockedProviderRateState(row: ProviderRateRow): void {
  if (
    !isText(row.provider_key) ||
    (row.environment !== "sandbox" && row.environment !== "production") ||
    !persistedInstant(row.window_started_at) ||
    !persistedInt4AtLeast(row.request_count, 0) ||
    !persistedInt4Between(row.adaptive_divisor, 1, 64) ||
    (row.throttled_until !== null && !persistedInstant(row.throttled_until)) ||
    !persistedInt4AtLeast(row.consecutive_successes, 0) ||
    (row.last_rate_limit_at !== null && !persistedInstant(row.last_rate_limit_at)) ||
    !persistedRevision(row.revision)
  ) {
    throw new OutboundSyncError("invalid-input", "Locked provider rate state is invalid.");
  }
}

function persistedInstant(value: Date | string): boolean {
  return value instanceof Date ? Number.isFinite(value.getTime()) : instant(value);
}

function persistedInt4AtLeast(value: number, minimum: number): boolean {
  return Number.isInteger(value) && value >= minimum && value <= 2_147_483_647;
}

function persistedInt4Between(value: number, minimum: number, maximum: number): boolean {
  return persistedInt4AtLeast(value, minimum) && value <= maximum;
}

function persistedRevision(value: string): boolean {
  return /^(?:[1-9]\d*)$/.test(value) && BigInt(value) <= 9_223_372_036_854_775_807n;
}

async function settleInlineOperationBatch(
  dependencies: OutboundSyncRuntimeDependencies,
  attempted: readonly {
    claim: Readonly<{
      operation: OutboundOperationRecord;
      providerIdentity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>;
      budget: OutboundOperationBudget;
    }>;
    result: ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>;
    terminalAt: string;
  }[],
): Promise<void> {
  await withPgTransaction(dependencies.db, async (db) => {
    const lockedAttempts = await lockOperationAttempts(
      db,
      attempted.map(({ claim }) => claim.operation),
    );
    if (attempted.every(({ result }) => result.kind === "succeeded")) {
      const admitted = [];
      for (const { claim, result, terminalAt } of attempted) {
        const locked = lockedAttempts.get(claim.operation.operationId)!;
        admitted.push({
          claim,
          operation: locked,
          result,
          terminalAt,
          linkState: await dependencies.recordOutcome!(db, locked, result),
        });
      }
      if (admitted.every(({ linkState }) => linkState === "applied")) {
        await terminalizeSuccessfulBatch(
          db,
          admitted.map(({ operation, terminalAt }) => ({ operation, terminalAt })),
        );
        await recordSuccessfulRateBatch(
          db,
          admitted.map(({ claim }) => ({ identity: claim.providerIdentity, budget: claim.budget })),
        );
        return;
      }
      for (const { claim, operation, result, terminalAt, linkState } of admitted) {
        await terminalize(
          db,
          operation,
          "succeeded",
          null,
          null,
          linkState,
          terminalAt,
          linkState === "link-write-refused",
        );
        await recordRateResult(db, claim.providerIdentity, result, claim.budget, terminalAt);
      }
      return;
    }
    for (const { claim, result, terminalAt } of attempted) {
      const operation = claim.operation;
      const budget = claim.budget;
      const locked = lockedAttempts.get(operation.operationId)!;
      if (result.kind === "rejected") {
        const disposition = resolveInlineRejectionDisposition(result.code, locked.attemptCount, budget);
        if (disposition.kind === "retry") {
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
              new Date(Date.parse(terminalAt) + disposition.delayMs).toISOString(),
            ],
          );
          if (Number(updated.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
          await recordRateResult(db, claim.providerIdentity, result, budget, terminalAt);
          continue;
        }
        if (disposition.reason === "attempts-exhausted") {
          const linkState = await dependencies.recordOutcome!(db, locked, result);
          await terminalize(db, locked, "failed", "attempts-exhausted", result.code, linkState, terminalAt, true);
          await recordRateResult(db, claim.providerIdentity, result, budget, terminalAt);
          continue;
        }
      }
      const linkState = await dependencies.recordOutcome!(db, locked, result);
      if (result.kind === "succeeded") {
        await terminalize(
          db,
          locked,
          "succeeded",
          null,
          null,
          linkState,
          terminalAt,
          linkState === "link-write-refused",
        );
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
      await recordRateResult(db, claim.providerIdentity, result, budget, terminalAt);
    }
  });
}

async function terminalizeSuccessfulBatch(
  db: PgQueryable,
  attempts: readonly Readonly<{ operation: OutboundOperationRecord; terminalAt: string }>[],
): Promise<void> {
  if (attempts.length === 0) return;
  const fences = attempts.map(({ operation, terminalAt }) => ({
    operationId: operation.operationId,
    revision: operation.revision,
    attemptId: operation.attemptId,
    claimGeneration: operation.claimGeneration,
    terminalAt,
  }));
  const result = await db.query(
    `UPDATE channel_outbound_operations AS operation
     SET status = 'succeeded', revision = operation.revision + 1, terminal_reason = NULL,
         last_rejection_code = NULL, link_write_state = 'applied', terminal_at = expected.terminal_at,
         claimed_until = NULL
     FROM jsonb_to_recordset($1::jsonb) AS expected(
       operation_id text, revision bigint, attempt_id text, claim_generation bigint, terminal_at timestamptz
     )
     WHERE operation.operation_id = expected.operation_id
       AND operation.status = 'in-flight'
       AND operation.revision = expected.revision
       AND operation.attempt_id = expected.attempt_id
       AND operation.claim_generation = expected.claim_generation`,
    [
      JSON.stringify(
        fences.map((fence) => ({
          operation_id: fence.operationId,
          revision: fence.revision,
          attempt_id: fence.attemptId,
          claim_generation: fence.claimGeneration,
          terminal_at: fence.terminalAt,
        })),
      ),
    ],
  );
  if (Number(result.rowCount ?? 0) !== attempts.length) throw new OutboundSyncError("stale-fence");
}

async function recordSuccessfulRateBatch(
  db: PgQueryable,
  successes: readonly {
    identity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>;
    budget: OutboundOperationBudget;
  }[],
): Promise<void> {
  const groups = new Map<
    string,
    { count: number; identity: (typeof successes)[number]["identity"]; threshold: number }
  >();
  for (const success of successes) {
    const key = `${success.identity.providerKey}\0${success.identity.environment}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else groups.set(key, { count: 1, identity: success.identity, threshold: success.budget.maxRequestsPerWindow });
  }
  for (const group of groups.values()) {
    const updated = await db.query(
      `UPDATE channel_provider_rate_state
       SET adaptive_divisor = GREATEST(
             1,
             floor(
               adaptive_divisor::numeric /
               power(2::numeric, floor((consecutive_successes + $3)::numeric / $4::numeric))
             )::integer
           ),
           consecutive_successes = (consecutive_successes + $3) % $4,
           revision = revision + 1
       WHERE provider_key = $1 AND environment = $2`,
      [group.identity.providerKey, group.identity.environment, group.count, group.threshold],
    );
    if (Number(updated.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
  }
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
        [
          operation.operationId,
          operation.revision,
          operation.attemptId,
          operation.claimGeneration,
          operation.sourceDesiredStateSequence,
        ],
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
      [
        operation.operationId,
        operation.revision,
        operation.attemptId,
        operation.claimGeneration,
        operation.sourceDesiredStateSequence,
        terminalAt,
      ],
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
    await terminalize(
      db,
      operation,
      "succeeded",
      null,
      null,
      linkState,
      terminalAt,
      linkState === "link-write-refused",
    );
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

async function lockOperationAttempts(
  db: PgQueryable,
  expected: readonly OutboundOperationRecord[],
): Promise<ReadonlyMap<string, OutboundOperationRecord>> {
  if (expected.length === 0) return new Map();
  const result = await db.query<OperationRow>(
    `SELECT ${outboundOperationSqlColumns} FROM channel_outbound_operations
     WHERE operation_id = ANY($1::text[]) FOR UPDATE`,
    [expected.map((operation) => operation.operationId)],
  );
  const locked = new Map(result.rows.map((row) => [row.operation_id, mapOutboundOperationRow(row)]));
  for (const operation of expected) {
    const row = locked.get(operation.operationId);
    if (
      !row ||
      row.status !== "in-flight" ||
      row.revision !== operation.revision ||
      row.attemptId !== operation.attemptId ||
      row.claimGeneration !== operation.claimGeneration
    ) {
      throw new OutboundSyncError("stale-fence");
    }
  }
  return locked;
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
    [
      operation.operationId,
      operation.revision,
      operation.attemptId,
      operation.claimGeneration,
      status,
      terminalReason,
      rejectionCode,
      linkWriteState,
      terminalAt,
    ],
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
  providerIdentity: Readonly<{ providerKey: string; environment: "sandbox" | "production" }>,
  result: ChannelPublicationResult | Readonly<{ kind: "outcome-unknown" }>,
  budget: OutboundOperationBudget,
  at: string,
) {
  if (result.kind === "rejected" && result.code === "rate-limited") {
    const throttledUntil = new Date(Date.parse(at) + budget.baseBackoffMs).toISOString();
    const updated = await db.query(
      `UPDATE channel_provider_rate_state
       SET adaptive_divisor = LEAST(64, adaptive_divisor * 2), throttled_until = $3,
           consecutive_successes = 0, last_rate_limit_at = $4, revision = revision + 1
       WHERE provider_key = $1 AND environment = $2`,
      [providerIdentity.providerKey, providerIdentity.environment, throttledUntil, at],
    );
    if (Number(updated.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
  } else if (result.kind === "succeeded") {
    const updated = await db.query(
      `UPDATE channel_provider_rate_state
       SET adaptive_divisor = CASE WHEN consecutive_successes + 1 >= $3 THEN GREATEST(1, adaptive_divisor / 2) ELSE adaptive_divisor END,
           consecutive_successes = CASE WHEN consecutive_successes + 1 >= $3 THEN 0 ELSE consecutive_successes + 1 END,
           revision = revision + 1
       WHERE provider_key = $1 AND environment = $2`,
      [providerIdentity.providerKey, providerIdentity.environment, budget.maxRequestsPerWindow],
    );
    if (Number(updated.rowCount ?? 0) !== 1) throw new OutboundSyncError("stale-fence");
  }
}

async function readConnection(db: PgQueryable, connectionId: string): Promise<OutboundConnection | null> {
  const result = await db.query<{
    connection_id: string;
    provider_key: string;
    environment: "sandbox" | "production";
    status: OutboundConnection["status"];
  }>("SELECT connection_id, provider_key, environment, status FROM channel_connections WHERE connection_id = $1", [
    connectionId,
  ]);
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
  const authoritativeTotal = cursor?.authoritativeTotal ?? totalCount;
  const emittedCount = (cursor?.emittedCount ?? 0) + page.length;
  const totalStable = Number.isSafeInteger(totalCount) && totalCount >= 0 && totalCount === authoritativeTotal;
  const pageReconciles = next !== null || emittedCount === authoritativeTotal;
  return {
    items: page,
    ...(next
      ? {
          nextCursor: encodeCursor({
            connectionId: input.connectionId,
            enqueuedAt: timestamp(next.enqueued_at)!,
            operationId: next.operation_id,
            authoritativeTotal,
            emittedCount,
          }),
        }
      : {}),
    completeness:
      totalStable && pageReconciles
        ? { kind: "complete", total: authoritativeTotal }
        : {
            kind: "bounded-incomplete",
            reason: totalStable ? "page-reconciliation-failed" : "authoritative-total-changed",
          },
  };
}

async function readOperationSummary(
  db: PgQueryable,
  input: { accountId: string; connectionId: string; window: { from: string; to: string } },
): Promise<OutboundOperationSummary> {
  if (
    !input.accountId ||
    !input.connectionId ||
    !instant(input.window.from) ||
    !instant(input.window.to) ||
    Date.parse(input.window.from) >= Date.parse(input.window.to)
  ) {
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
    completeness: Number.isSafeInteger(total)
      ? { kind: "complete", total }
      : { kind: "bounded-incomplete", reason: "authoritative-total-unavailable" },
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
  return outboundOperationSqlColumns
    .split(",")
    .map((column) => `operation.${column.trim()}`)
    .join(", ");
}

function membershipMismatch(): never {
  throw new OutboundSyncError("reservation-membership-mismatch");
}

function settlementReceiptRunIdentity(settlement: ClaimedReservationRunSettlement | undefined): unknown {
  if (!settlement) return null;
  const { context: _context, ...identity } = settlement;
  return identity;
}

function assertSettlementReceiptMatches(
  receipt: Readonly<{ claimant: unknown; outcomes: unknown; run_settlement: unknown }>,
  claimant: ClaimedOperationClaimant,
  outcomes: readonly ClaimedOperationOutcome[],
  runSettlement: ClaimedReservationRunSettlement | undefined,
): void {
  if (
    canonicalJson(receipt.claimant) !== canonicalJson(claimant) ||
    canonicalJson(receipt.outcomes) !== canonicalJson(outcomes) ||
    canonicalJson(receipt.run_settlement) !== canonicalJson(settlementReceiptRunIdentity(runSettlement))
  ) {
    membershipMismatch();
  }
}

async function writeSettlementReceipt(
  db: PgQueryable,
  reservationId: string,
  claimant: ClaimedOperationClaimant,
  outcomes: readonly ClaimedOperationOutcome[],
  runSettlement: ClaimedReservationRunSettlement | undefined,
  settledAt: string,
): Promise<void> {
  await db.query(
    `INSERT INTO channel_outbound_reservation_settlements
       (reservation_id,claimant,outcomes,run_settlement,settled_at)
     VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5)`,
    [
      reservationId,
      JSON.stringify(claimant),
      JSON.stringify(outcomes),
      JSON.stringify(settlementReceiptRunIdentity(runSettlement)),
      settledAt,
    ],
  );
}

function assertRunSettlement(value: ClaimedReservationRunSettlement | undefined): void {
  if (value === undefined) return;
  const keys = [
    "expectedRunRevision",
    "fromState",
    "context",
    "importSummary",
    "runId",
    "toState",
    "uploadAttemptedAt",
    "uploadFileName",
    "verificationSnapshotGeneration",
    "verificationSnapshotId",
  ];
  if (
    Object.keys(value).sort().join(",") !== keys.sort().join(",") ||
    !isText(value.runId) ||
    value.runId.length > 512 ||
    !Number.isSafeInteger(value.expectedRunRevision) ||
    value.expectedRunRevision < 0 ||
    !["composed", "claimed", "awaiting-verification"].includes(value.fromState) ||
    !["applied", "validation-rejected", "application-unknown", "superseded", "stale-basis", "abandoned"].includes(
      value.toState,
    ) ||
    (value.verificationSnapshotId !== null && !isText(value.verificationSnapshotId)) ||
    (value.verificationSnapshotGeneration !== null &&
      (!Number.isSafeInteger(value.verificationSnapshotGeneration) || value.verificationSnapshotGeneration < 1)) ||
    (value.uploadAttemptedAt !== null && !instant(value.uploadAttemptedAt)) ||
    (value.uploadFileName !== null && !isText(value.uploadFileName)) ||
    (value.context !== null &&
      (!isText(value.context.tenantId) ||
        !isText(value.context.audit?.performedByUserId) ||
        !isText(value.context.audit?.forAccountId))) ||
    (value.importSummary !== null &&
      (!isText(value.importSummary.fileName) ||
        !isText(value.importSummary.dateImportedText) ||
        !Number.isSafeInteger(value.importSummary.numberOfProducts) ||
        value.importSummary.numberOfProducts < 0 ||
        !instant(value.importSummary.recordedAt)))
  ) {
    throw new OutboundSyncError("invalid-input", "runSettlement is invalid.");
  }
}

function assertBoundRunIdentity(
  run: BoundClaimedReservationRun,
  claimant: ClaimedOperationClaimant,
  members: readonly OperationRow[],
): void {
  if (
    !isText(run.runId) ||
    !Number.isSafeInteger(run.revision) ||
    run.revision < 0 ||
    !isText(run.reservationId) ||
    run.reservationId !== members[0]?.reservation_id ||
    run.claimant.claimantKind !== claimant.claimantKind ||
    run.claimant.claimantId !== claimant.claimantId ||
    run.state === "terminal"
  ) {
    throw new OutboundSyncError("stale-fence", "The bound run is stale or terminal.");
  }
  if (run.outcomes.length !== members.length) membershipMismatch();
  const reports = new Map(run.outcomes.map((outcome) => [outcome.operationId, outcome]));
  if (reports.size !== run.outcomes.length) membershipMismatch();
  for (const member of members) {
    const report = reports.get(member.operation_id);
    if (
      !report ||
      report.attemptId !== member.attempt_id ||
      report.claimGeneration !== Number(member.claim_generation) ||
      report.desiredStateSequence !== Number(member.source_desired_state_sequence) ||
      member.claimant_kind !== claimant.claimantKind ||
      member.claim_owner_id !== claimant.claimantId
    ) {
      membershipMismatch();
    }
  }
}

function assertExpiredBoundRunSettlement(
  run: BoundClaimedReservationRun,
  claimant: ClaimedOperationClaimant,
  members: readonly OperationRow[],
  currentInstant: string,
): void {
  assertBoundRunIdentity(run, claimant, members);
  const leaseExpiresAt = Math.min(...members.map((member) => Date.parse(timestamp(member.claimed_until)!)));
  if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt > Date.parse(currentInstant)) {
    throw new OutboundSyncError("stale-fence", "The reservation lease is not expired.");
  }
  if (run.state === "awaiting-verification") {
    if (
      !run.submitMayHaveOccurred ||
      !run.uploadAttemptedAt ||
      !instant(run.uploadAttemptedAt) ||
      Date.parse(run.uploadAttemptedAt) > leaseExpiresAt ||
      run.outcomes.some((outcome) => outcome.outcome.kind === "abandoned")
    ) {
      throw new OutboundSyncError("stale-fence", "Awaiting-verification evidence is invalid.");
    }
  } else if (
    run.submitMayHaveOccurred ||
    run.uploadAttemptedAt !== null ||
    run.outcomes.some((outcome) => outcome.outcome.kind === "outcome-unknown")
  ) {
    throw new OutboundSyncError("stale-fence", "Pre-submit expiry evidence is invalid.");
  }
}

function nonTerminalRunState(
  run: BoundClaimedReservationRun,
): Exclude<BoundClaimedReservationRun["state"], "terminal"> {
  if (run.state === "terminal") throw new OutboundSyncError("stale-fence", "The bound run is terminal.");
  return run.state;
}

function claimantFromRow(row: OperationRow): ClaimedOperationClaimant {
  if ((row.claimant_kind !== "connector" && row.claimant_kind !== "manual") || !isText(row.claim_owner_id)) {
    throw new OutboundSyncError("stale-fence", "The claimed reservation owner is invalid.");
  }
  return { claimantKind: row.claimant_kind, claimantId: row.claim_owner_id };
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value === null ? null : new Date(value).toISOString();
}

function instant(value: string): boolean {
  return /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
}

function encodeCursor(value: {
  connectionId: string;
  enqueuedAt: string;
  operationId: string;
  authoritativeTotal: number;
  emittedCount: number;
}): string {
  return Buffer.from(JSON.stringify({ version: "channels-outbound-log/v2", ...value }), "utf8").toString("base64url");
}

function decodeCursor(
  value: string,
  connectionId: string,
): { enqueuedAt: string; operationId: string; authoritativeTotal: number; emittedCount: number } {
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      Object.keys(parsed).sort().join(",") !==
        "authoritativeTotal,connectionId,emittedCount,enqueuedAt,operationId,version" ||
      parsed.version !== "channels-outbound-log/v2" ||
      parsed.connectionId !== connectionId ||
      typeof parsed.operationId !== "string" ||
      typeof parsed.enqueuedAt !== "string" ||
      !instant(parsed.enqueuedAt) ||
      !Number.isSafeInteger(parsed.authoritativeTotal) ||
      Number(parsed.authoritativeTotal) < 0 ||
      !Number.isSafeInteger(parsed.emittedCount) ||
      Number(parsed.emittedCount) < 1 ||
      Number(parsed.emittedCount) > Number(parsed.authoritativeTotal)
    )
      throw new Error();
    return {
      enqueuedAt: parsed.enqueuedAt,
      operationId: parsed.operationId,
      authoritativeTotal: Number(parsed.authoritativeTotal),
      emittedCount: Number(parsed.emittedCount),
    };
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
    completeness: { kind: "complete", total: 0 },
    succeeded: 0,
    failed: 0,
    pending: 0,
    inFlight: 0,
    blocked: 0,
    inlineEventToProviderAckMs: { p50: null, p95: null, p99: null },
    claimedEventToProviderAckMs: { p50: null, p95: null, p99: null },
  };
}
