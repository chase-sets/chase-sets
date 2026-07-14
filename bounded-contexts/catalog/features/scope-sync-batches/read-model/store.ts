import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  providerConcurrencyAvailable,
  scopeSyncBatchStatusFromUnits,
  type ScopeSyncBatchBudget,
  type ScopeSyncBatchPlannedScope,
  type ScopeSyncBatchPreview,
  type ScopeSyncBatchSelection,
  type ScopeSyncBatchStatus,
  type ScopeSyncBatchUnitState,
} from "../domain/batch";
import type { ClaimedScopeSyncBatchUnit, ScopeSyncBatchWorkerRepository } from "../api/worker";

export type ScopeSyncBatchUnitSnapshot = Readonly<{
  scopeRecordId: string;
  state: ScopeSyncBatchUnitState;
  syncRunId: string | null;
  providerKeys: readonly string[];
  attemptCount: number;
  errorMessage: string | null;
  updatedAt: string;
}>;

export type ScopeSyncBatchSnapshot = Readonly<{
  batchId: string;
  selection: ScopeSyncBatchSelection;
  budget: ScopeSyncBatchBudget;
  planFingerprint: string;
  preview: ScopeSyncBatchPreview;
  status: ScopeSyncBatchStatus;
  fastNoOp: boolean;
  circuitOpenProviders: readonly string[];
  counts: Readonly<Record<ScopeSyncBatchUnitState, number>>;
  units: readonly ScopeSyncBatchUnitSnapshot[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}>;

type BatchRow = Readonly<{
  batch_id: string;
  selection: unknown;
  budget: unknown;
  plan_fingerprint: string;
  preview: unknown;
  status: ScopeSyncBatchStatus;
  event_context: unknown;
  fast_no_op: boolean;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
}>;

type UnitRow = Readonly<{
  batch_id: string;
  scope_record_id: string;
  ordinal: number;
  plan: unknown;
  provider_keys: readonly string[];
  state: ScopeSyncBatchUnitState;
  sync_run_id: string | null;
  attempt_count: number;
  error_message: string | null;
  updated_at: string | Date;
  budget?: unknown;
  event_context?: unknown;
}>;

export function createScopeSyncBatchStore(db: PgQueryable) {
  async function create(input: {
    batchId: string;
    preview: ScopeSyncBatchPreview;
    plans: readonly ScopeSyncBatchPlannedScope[];
    context: EventStoreContext;
  }): Promise<ScopeSyncBatchSnapshot> {
    await db.query(
      `INSERT INTO catalog_scope_sync_batches (
         batch_id, selection, budget, plan_fingerprint, preview, status, event_context
       ) VALUES ($1, $2::jsonb, $3::jsonb, $4, $5::jsonb, 'queued', $6::jsonb)`,
      [
        input.batchId,
        JSON.stringify(input.preview.selection),
        JSON.stringify(input.preview.budget),
        input.preview.planFingerprint,
        JSON.stringify(input.preview),
        JSON.stringify(input.context),
      ],
    );
    if (input.plans.length > 0) {
      await db.query(
        `INSERT INTO catalog_scope_sync_batch_units (
           batch_id, scope_record_id, ordinal, plan, provider_keys
         )
         SELECT $1,
                unit->>'scopeRecordId',
                (unit->>'ordinal')::integer,
                unit->'plan',
                ARRAY(SELECT jsonb_array_elements_text(unit->'providerKeys'))
         FROM jsonb_array_elements($2::jsonb) AS unit`,
        [
          input.batchId,
          JSON.stringify(
            input.plans.map((plan, ordinal) => ({
              scopeRecordId: plan.scopeRecordId,
              ordinal,
              plan,
              providerKeys: plan.providerKeys,
            })),
          ),
        ],
      );
    }
    return requireBatch(input.batchId);
  }

  async function get(batchId: string, context: EventStoreContext): Promise<ScopeSyncBatchSnapshot | null> {
    const result = await db.query<BatchRow>(
      `SELECT *
       FROM catalog_scope_sync_batches
       WHERE batch_id = $1
         AND event_context->'audit'->>'forAccountId' = $2
         AND event_context->'audit'->>'performedByUserId' = $3`,
      [batchId, context.audit.forAccountId, context.audit.performedByUserId],
    );
    const row = result.rows[0];
    return row ? hydrateBatch(row) : null;
  }

  async function findCompletedByFingerprint(
    fingerprint: string,
    context: EventStoreContext,
  ): Promise<ScopeSyncBatchSnapshot | null> {
    const result = await db.query<BatchRow>(
      `SELECT *
       FROM catalog_scope_sync_batches
       WHERE plan_fingerprint = $1
         AND status = 'completed'
         AND event_context->'audit'->>'forAccountId' = $2
         AND event_context->'audit'->>'performedByUserId' = $3
       ORDER BY completed_at DESC
       LIMIT 1`,
      [fingerprint, context.audit.forAccountId, context.audit.performedByUserId],
    );
    const row = result.rows[0];
    return row ? hydrateBatch({ ...row, fast_no_op: true }) : null;
  }

  async function listUnits(batchId: string): Promise<readonly ScopeSyncBatchUnitSnapshot[]> {
    const result = await db.query<UnitRow>(
      `SELECT * FROM catalog_scope_sync_batch_units WHERE batch_id = $1 ORDER BY ordinal ASC`,
      [batchId],
    );
    return result.rows.map(unitSnapshot);
  }

  async function hydrateBatch(row: BatchRow): Promise<ScopeSyncBatchSnapshot> {
    const units = await listUnits(row.batch_id);
    return {
      batchId: row.batch_id,
      selection: parseJson<ScopeSyncBatchSelection>(row.selection),
      budget: parseJson<ScopeSyncBatchBudget>(row.budget),
      planFingerprint: row.plan_fingerprint,
      preview: parseJson<ScopeSyncBatchPreview>(row.preview),
      status: row.status,
      fastNoOp: row.fast_no_op,
      circuitOpenProviders: circuitOpenProviders(
        units,
        parseJson<ScopeSyncBatchBudget>(row.budget).providerFailureThreshold,
      ),
      counts: countUnitStates(units),
      units,
      createdAt: timestamp(row.created_at),
      updatedAt: timestamp(row.updated_at),
      completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    };
  }

  async function requireBatch(batchId: string): Promise<ScopeSyncBatchSnapshot> {
    const result = await db.query<BatchRow>(`SELECT * FROM catalog_scope_sync_batches WHERE batch_id = $1`, [batchId]);
    const row = result.rows[0];
    if (!row) throw new Error("Scope Sync Batch was not found after persistence.");
    return hydrateBatch(row);
  }

  async function claimNext(input: {
    claimOwnerId: string;
    claimTtlMs: number;
  }): Promise<ClaimedScopeSyncBatchUnit | null> {
    const running = await claimCandidate(db, input, "running");
    if (running) return claimedUnit(running);

    const candidates = await db.query<UnitRow>(
      `SELECT u.*, b.budget, b.event_context
       FROM catalog_scope_sync_batch_units u
       JOIN catalog_scope_sync_batches b ON b.batch_id = u.batch_id
       WHERE u.state = 'queued'
         AND b.status IN ('queued', 'running')
         AND (u.claimed_until IS NULL OR u.claimed_until < now())
       ORDER BY b.created_at ASC, u.ordinal ASC
       LIMIT 100`,
    );
    const activeResult = await db.query<{ provider_key: string; active_count: number | string }>(
      `SELECT provider_key, count(*) AS active_count
       FROM catalog_scope_sync_batch_units u
       JOIN catalog_scope_sync_batches b ON b.batch_id = u.batch_id
       CROSS JOIN LATERAL unnest(u.provider_keys) AS provider_key
       WHERE u.state = 'running'
         AND b.status IN ('queued', 'running')
       GROUP BY provider_key`,
    );
    const activeByProvider = Object.fromEntries(
      activeResult.rows.map((row) => [row.provider_key, Number(row.active_count)]),
    );

    for (const candidate of candidates.rows) {
      const budget = parseJson<ScopeSyncBatchBudget>(candidate.budget);
      if (!providerConcurrencyAvailable({ providerKeys: candidate.provider_keys, activeByProvider, budget })) continue;
      const failureCounts = await db.query<{ provider_key: string; failed_count: number | string }>(
        `SELECT provider_key, count(*) AS failed_count
         FROM catalog_scope_sync_batch_units u
         CROSS JOIN LATERAL unnest(u.provider_keys) AS provider_key
         WHERE u.batch_id = $1 AND u.state = 'failed'
         GROUP BY provider_key`,
        [candidate.batch_id],
      );
      if (failureCounts.rows.some((row) => Number(row.failed_count) >= budget.providerFailureThreshold)) continue;
      const claimed = await db.query<UnitRow>(
        `UPDATE catalog_scope_sync_batch_units
         SET state = 'running',
             claim_owner_id = $3,
             claimed_until = now() + ($4::integer * interval '1 millisecond'),
             attempt_count = attempt_count + 1,
             updated_at = now()
         WHERE batch_id = $1 AND scope_record_id = $2 AND state = 'queued'
           AND (claimed_until IS NULL OR claimed_until < now())
         RETURNING *`,
        [candidate.batch_id, candidate.scope_record_id, input.claimOwnerId, input.claimTtlMs],
      );
      const row = claimed.rows[0];
      if (row) {
        await markBatchRunning(row.batch_id);
        return claimedUnit({ ...row, budget: candidate.budget, event_context: candidate.event_context });
      }
    }
    return null;
  }

  async function recordRunning(input: { claim: ClaimedScopeSyncBatchUnit; syncRunId: string }): Promise<void> {
    await db.query(
      `UPDATE catalog_scope_sync_batch_units
       SET sync_run_id = $3, claim_owner_id = NULL, claimed_until = NULL, updated_at = now()
       WHERE batch_id = $1 AND scope_record_id = $2 AND state = 'running'`,
      [input.claim.batchId, input.claim.scopeRecordId, input.syncRunId],
    );
  }

  async function recordTerminal(input: {
    claim: ClaimedScopeSyncBatchUnit;
    state: "completed" | "failed";
    errorMessage: string | null;
  }): Promise<void> {
    await db.query(
      `UPDATE catalog_scope_sync_batch_units
       SET state = $3, error_message = $4, claim_owner_id = NULL, claimed_until = NULL,
           completed_at = now(), updated_at = now()
       WHERE batch_id = $1 AND scope_record_id = $2 AND state = 'running'`,
      [input.claim.batchId, input.claim.scopeRecordId, input.state, input.errorMessage],
    );
    await refreshBatchStatus(input.claim.batchId);
  }

  async function cancel(batchId: string, context: EventStoreContext): Promise<ScopeSyncBatchSnapshot | null> {
    const batch = await get(batchId, context);
    if (!batch) return null;
    if (batch.status !== "queued" && batch.status !== "running") return batch;
    await db.query(
      `UPDATE catalog_scope_sync_batch_units
       SET state = 'cancelled', claim_owner_id = NULL, claimed_until = NULL, updated_at = now(), completed_at = now()
       WHERE batch_id = $1 AND state IN ('queued', 'running')`,
      [batchId],
    );
    await db.query(
      `UPDATE catalog_scope_sync_batches
       SET status = 'cancelled', updated_at = now(), completed_at = now()
       WHERE batch_id = $1`,
      [batchId],
    );
    return requireBatch(batchId);
  }

  async function resume(batchId: string, context: EventStoreContext): Promise<ScopeSyncBatchSnapshot | null> {
    const batch = await get(batchId, context);
    if (!batch) return null;
    if (batch.status !== "cancelled") return batch;
    await db.query(
      `UPDATE catalog_scope_sync_batch_units
       SET state = 'queued', sync_run_id = NULL, error_message = NULL, completed_at = NULL, updated_at = now()
       WHERE batch_id = $1 AND state = 'cancelled'`,
      [batchId],
    );
    await db.query(
      `UPDATE catalog_scope_sync_batches
       SET status = 'queued', completed_at = NULL, updated_at = now()
       WHERE batch_id = $1`,
      [batchId],
    );
    return requireBatch(batchId);
  }

  async function retryUnit(
    batchId: string,
    scopeRecordId: string,
    context: EventStoreContext,
  ): Promise<ScopeSyncBatchSnapshot | null> {
    const batch = await get(batchId, context);
    if (!batch) return null;
    const requeued = await db.query<{ scope_record_id: string }>(
      `UPDATE catalog_scope_sync_batch_units
       SET state = 'queued', sync_run_id = NULL, error_message = NULL, completed_at = NULL, updated_at = now()
       WHERE batch_id = $1 AND scope_record_id = $2 AND state IN ('failed', 'cancelled')
       RETURNING scope_record_id`,
      [batchId, scopeRecordId],
    );
    if (requeued.rows.length === 0) return batch;
    await db.query(
      `UPDATE catalog_scope_sync_batches SET status = 'queued', completed_at = NULL, updated_at = now() WHERE batch_id = $1`,
      [batchId],
    );
    return requireBatch(batchId);
  }

  async function markBatchRunning(batchId: string): Promise<void> {
    await db.query(
      `UPDATE catalog_scope_sync_batches SET status = 'running', updated_at = now() WHERE batch_id = $1 AND status = 'queued'`,
      [batchId],
    );
  }

  async function refreshBatchStatus(batchId: string): Promise<void> {
    const result = await db.query<{ state: ScopeSyncBatchUnitState }>(
      `SELECT state FROM catalog_scope_sync_batch_units WHERE batch_id = $1`,
      [batchId],
    );
    const status = scopeSyncBatchStatusFromUnits(result.rows.map((row) => row.state));
    const terminal = status === "completed" || status === "partial" || status === "failed" || status === "cancelled";
    await db.query(
      `UPDATE catalog_scope_sync_batches
       SET status = $2, updated_at = now(), completed_at = CASE WHEN $3 THEN now() ELSE NULL END
       WHERE batch_id = $1`,
      [batchId, status, terminal],
    );
  }

  const repository: ScopeSyncBatchWorkerRepository = { claimNext, recordRunning, recordTerminal };
  return { create, get, findCompletedByFingerprint, listUnits, cancel, resume, retryUnit, repository };
}

async function claimCandidate(
  db: PgQueryable,
  input: { claimOwnerId: string; claimTtlMs: number },
  state: "running",
): Promise<UnitRow | null> {
  const result = await db.query<UnitRow>(
    `WITH candidate AS (
       SELECT u.batch_id, u.scope_record_id
       FROM catalog_scope_sync_batch_units u
       JOIN catalog_scope_sync_batches b ON b.batch_id = u.batch_id
       WHERE u.state = $1 AND b.status IN ('queued', 'running')
         AND (u.claimed_until IS NULL OR u.claimed_until < now())
       ORDER BY b.created_at ASC, u.ordinal ASC
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     UPDATE catalog_scope_sync_batch_units u
     SET claim_owner_id = $2,
         claimed_until = now() + ($3::integer * interval '1 millisecond'),
         updated_at = now()
     FROM candidate, catalog_scope_sync_batches b
     WHERE u.batch_id = candidate.batch_id AND u.scope_record_id = candidate.scope_record_id
       AND b.batch_id = u.batch_id
     RETURNING u.*, b.budget, b.event_context`,
    [state, input.claimOwnerId, input.claimTtlMs],
  );
  return result.rows[0] ?? null;
}

function claimedUnit(row: UnitRow): ClaimedScopeSyncBatchUnit {
  return {
    batchId: row.batch_id,
    scopeRecordId: row.scope_record_id,
    state: row.state === "queued" ? "queued" : "running",
    plan: parseJson<ScopeSyncBatchPlannedScope>(row.plan),
    syncRunId: row.sync_run_id,
    budget: parseJson<ScopeSyncBatchBudget>(row.budget),
    context: parseJson<EventStoreContext>(row.event_context),
  };
}

function unitSnapshot(row: UnitRow): ScopeSyncBatchUnitSnapshot {
  return {
    scopeRecordId: row.scope_record_id,
    state: row.state,
    syncRunId: row.sync_run_id,
    providerKeys: row.provider_keys,
    attemptCount: Number(row.attempt_count),
    errorMessage: row.error_message,
    updatedAt: timestamp(row.updated_at),
  };
}

function countUnitStates(units: readonly ScopeSyncBatchUnitSnapshot[]): Record<ScopeSyncBatchUnitState, number> {
  const counts = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const unit of units) counts[unit.state] += 1;
  return counts;
}

function circuitOpenProviders(
  units: readonly ScopeSyncBatchUnitSnapshot[],
  providerFailureThreshold: number,
): readonly string[] {
  const failedByProvider: Record<string, number> = {};
  for (const unit of units.filter((candidate) => candidate.state === "failed")) {
    for (const providerKey of unit.providerKeys) {
      failedByProvider[providerKey] = (failedByProvider[providerKey] ?? 0) + 1;
    }
  }
  return Object.entries(failedByProvider)
    .filter(([, count]) => count >= providerFailureThreshold)
    .map(([providerKey]) => providerKey)
    .sort();
}

function parseJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function timestamp(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}
