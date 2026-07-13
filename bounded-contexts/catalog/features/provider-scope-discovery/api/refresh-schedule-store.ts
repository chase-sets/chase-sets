import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { JsonObject } from "@chase-sets/primitives/json";
import type { ProviderRefreshCadenceConfig } from "./provider-refresh-cadence";

export type ProviderRefreshRunStatus = "succeeded" | "failed" | "skipped-no-targets";

export type ProviderRefreshScheduleRecord = Readonly<{
  providerKey: string;
  scheduleEnabled: boolean;
  manualOnly: boolean;
  creditAware: boolean;
  intervalMs: number;
  paused: boolean;
  pausedBy: string | null;
  pausedReason: string | null;
  pausedAt: string | null;
  nextRunAt: string | null;
  lastRunStartedAt: string | null;
  lastRunCompletedAt: string | null;
  lastRunStatus: ProviderRefreshRunStatus | null;
  lastRunObservationCount: number | null;
  lastRunError: string | null;
  lastRunTriggeredBy: string | null;
}>;

export type ProviderScopeObservationInput = Readonly<{
  providerKey: string;
  queryKind: string;
  languageCode: string;
  optionExternalKey: string;
  displayName: string;
  parentValue: string | null;
  imageUrl: string | null;
  metadata: JsonObject;
}>;

export type ProviderScopeObservationRecord = ProviderScopeObservationInput &
  Readonly<{
    scanId: string;
    scannedAt: string;
    firstObservedAt: string;
    /** True when this scan was the first time the option was ever observed. */
    newlyObserved: boolean;
  }>;

type ScheduleRow = Readonly<{
  provider_key: string;
  schedule_enabled: boolean;
  manual_only: boolean;
  credit_aware: boolean;
  interval_ms: string | number;
  paused: boolean;
  paused_by: string | null;
  paused_reason: string | null;
  paused_at: string | Date | null;
  next_run_at: string | Date | null;
  last_run_started_at: string | Date | null;
  last_run_completed_at: string | Date | null;
  last_run_status: ProviderRefreshRunStatus | null;
  last_run_observation_count: number | null;
  last_run_error: string | null;
  last_run_triggered_by: string | null;
}>;

// Reconcile the schedule table with the code-reviewed cadence config. Policy
// columns (enabled/manual-only/credit-aware/interval) always follow config so a
// config change lands on deploy; operator pause state and run bookkeeping are
// preserved across reconciles.
export async function reconcileProviderRefreshSchedules(
  db: PgQueryable,
  cadences: readonly ProviderRefreshCadenceConfig[],
): Promise<void> {
  for (const cadence of cadences) {
    await db.query(
      `INSERT INTO catalog_provider_refresh_schedule (
         provider_key, schedule_enabled, manual_only, credit_aware, interval_ms, paused, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, false, now())
       ON CONFLICT (provider_key) DO UPDATE SET
         schedule_enabled = EXCLUDED.schedule_enabled,
         manual_only = EXCLUDED.manual_only,
         credit_aware = EXCLUDED.credit_aware,
         interval_ms = EXCLUDED.interval_ms,
         updated_at = now()`,
      [cadence.providerKey, cadence.scheduleEnabled, cadence.manualOnly, cadence.creditAware, cadence.intervalMs],
    );
  }
}

export async function listProviderRefreshSchedules(db: PgQueryable): Promise<readonly ProviderRefreshScheduleRecord[]> {
  const result = await db.query<ScheduleRow>(
    `SELECT *
     FROM catalog_provider_refresh_schedule
     ORDER BY provider_key ASC`,
  );
  return result.rows.map(toScheduleRecord);
}

export async function getProviderRefreshSchedule(
  db: PgQueryable,
  providerKey: string,
): Promise<ProviderRefreshScheduleRecord | null> {
  const result = await db.query<ScheduleRow>(
    `SELECT * FROM catalog_provider_refresh_schedule WHERE provider_key = $1`,
    [providerKey.trim().toLowerCase()],
  );
  const row = result.rows[0];
  return row ? toScheduleRecord(row) : null;
}

export async function setProviderRefreshPaused(
  db: PgQueryable,
  input: Readonly<{ providerKey: string; paused: boolean; actor: string; reason?: string | null }>,
): Promise<ProviderRefreshScheduleRecord | null> {
  const result = await db.query<ScheduleRow>(
    `UPDATE catalog_provider_refresh_schedule
     SET paused = $2,
         paused_by = CASE WHEN $2 THEN $3 ELSE NULL END,
         paused_reason = CASE WHEN $2 THEN $4 ELSE NULL END,
         paused_at = CASE WHEN $2 THEN now() ELSE NULL END,
         updated_at = now()
     WHERE provider_key = $1
     RETURNING *`,
    [input.providerKey.trim().toLowerCase(), input.paused, input.actor, input.reason?.trim() || null],
  );
  const row = result.rows[0];
  return row ? toScheduleRecord(row) : null;
}

// Atomically claim providers that are due for a scheduled scan. Advancing
// next_run_at inside the claim keeps concurrent worker replicas from double
// scanning the same provider even without an external lock: only the UPDATE
// that wins the row advances the clock, and every later claimant sees the
// pushed-out next_run_at.
export async function claimDueProviderRefreshes(
  db: PgQueryable,
  input: Readonly<{ now?: Date }> = {},
): Promise<readonly ProviderRefreshScheduleRecord[]> {
  const now = input.now ?? new Date();
  const result = await db.query<ScheduleRow>(
    `UPDATE catalog_provider_refresh_schedule
     SET next_run_at = $1::timestamptz + make_interval(secs => interval_ms / 1000.0),
         last_run_started_at = $1::timestamptz,
         updated_at = now()
     WHERE schedule_enabled = true
       AND manual_only = false
       AND paused = false
       AND (next_run_at IS NULL OR next_run_at <= $1::timestamptz)
     RETURNING *`,
    [now.toISOString()],
  );
  return result.rows.map(toScheduleRecord);
}

export async function recordProviderRefreshRun(
  db: PgQueryable,
  input: Readonly<{
    providerKey: string;
    status: ProviderRefreshRunStatus;
    observationCount: number;
    errorMessage?: string | null;
    triggeredBy: string;
    completedAt?: Date;
  }>,
): Promise<void> {
  await db.query(
    `UPDATE catalog_provider_refresh_schedule
     SET last_run_completed_at = $2,
         last_run_status = $3,
         last_run_observation_count = $4,
         last_run_error = $5,
         last_run_triggered_by = $6,
         updated_at = now()
     WHERE provider_key = $1`,
    [
      input.providerKey.trim().toLowerCase(),
      (input.completedAt ?? new Date()).toISOString(),
      input.status,
      input.observationCount,
      input.errorMessage?.trim() || null,
      input.triggeredBy,
    ],
  );
}

// Upsert one scan's worth of option evidence for a provider. Returns every
// written record with `newlyObserved` marking options this scan saw for the
// first time — the delta the mapping matcher consumes.
export async function upsertProviderScopeObservations(
  db: PgQueryable,
  input: Readonly<{
    scanId: string;
    scannedAt?: Date;
    observations: readonly ProviderScopeObservationInput[];
  }>,
): Promise<readonly ProviderScopeObservationRecord[]> {
  const scannedAt = (input.scannedAt ?? new Date()).toISOString();
  const written: ProviderScopeObservationRecord[] = [];

  for (const observation of input.observations) {
    const result = await db.query<{
      first_observed_at: string | Date;
      inserted: boolean;
    }>(
      `INSERT INTO catalog_provider_scope_observations (
         provider_key, query_kind, language_code, option_external_key,
         display_name, parent_value, image_url, metadata,
         scan_id, scanned_at, first_observed_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::timestamptz, $10::timestamptz, now())
       ON CONFLICT (provider_key, query_kind, language_code, option_external_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         parent_value = EXCLUDED.parent_value,
         image_url = EXCLUDED.image_url,
         metadata = EXCLUDED.metadata,
         scan_id = EXCLUDED.scan_id,
         scanned_at = EXCLUDED.scanned_at,
         updated_at = now()
       RETURNING first_observed_at, (xmax = 0) AS inserted`,
      [
        observation.providerKey.trim().toLowerCase(),
        observation.queryKind,
        observation.languageCode,
        observation.optionExternalKey,
        observation.displayName,
        observation.parentValue,
        observation.imageUrl,
        JSON.stringify(observation.metadata),
        input.scanId,
        scannedAt,
      ],
    );

    const row = result.rows[0];
    written.push({
      ...observation,
      providerKey: observation.providerKey.trim().toLowerCase(),
      scanId: input.scanId,
      scannedAt,
      firstObservedAt: toIsoString(row?.first_observed_at ?? scannedAt),
      newlyObserved: Boolean(row?.inserted),
    });
  }

  return written;
}

export async function listProviderScopeObservations(
  db: PgQueryable,
  input: Readonly<{ providerKey?: string | null; queryKind?: string | null; limit?: number }> = {},
): Promise<readonly ProviderScopeObservationRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (input.providerKey?.trim()) {
    params.push(input.providerKey.trim().toLowerCase());
    conditions.push(`provider_key = $${params.length}`);
  }
  if (input.queryKind?.trim()) {
    params.push(input.queryKind.trim());
    conditions.push(`query_kind = $${params.length}`);
  }
  params.push(Math.min(Math.max(input.limit ?? 500, 1), 2_000));

  const result = await db.query<{
    provider_key: string;
    query_kind: string;
    language_code: string;
    option_external_key: string;
    display_name: string;
    parent_value: string | null;
    image_url: string | null;
    metadata: JsonObject;
    scan_id: string;
    scanned_at: string | Date;
    first_observed_at: string | Date;
  }>(
    `SELECT provider_key, query_kind, language_code, option_external_key,
            display_name, parent_value, image_url, metadata,
            scan_id, scanned_at, first_observed_at
     FROM catalog_provider_scope_observations
     ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""}
     ORDER BY first_observed_at DESC, provider_key ASC, option_external_key ASC
     LIMIT $${params.length}`,
    params,
  );

  return result.rows.map((row) => ({
    providerKey: row.provider_key,
    queryKind: row.query_kind,
    languageCode: row.language_code,
    optionExternalKey: row.option_external_key,
    displayName: row.display_name,
    parentValue: row.parent_value,
    imageUrl: row.image_url,
    metadata: row.metadata,
    scanId: row.scan_id,
    scannedAt: toIsoString(row.scanned_at),
    firstObservedAt: toIsoString(row.first_observed_at),
    newlyObserved: false,
  }));
}

function toScheduleRecord(row: ScheduleRow): ProviderRefreshScheduleRecord {
  return {
    providerKey: row.provider_key,
    scheduleEnabled: row.schedule_enabled,
    manualOnly: row.manual_only,
    creditAware: row.credit_aware,
    intervalMs: Number(row.interval_ms),
    paused: row.paused,
    pausedBy: row.paused_by,
    pausedReason: row.paused_reason,
    pausedAt: toIsoStringOrNull(row.paused_at),
    nextRunAt: toIsoStringOrNull(row.next_run_at),
    lastRunStartedAt: toIsoStringOrNull(row.last_run_started_at),
    lastRunCompletedAt: toIsoStringOrNull(row.last_run_completed_at),
    lastRunStatus: row.last_run_status,
    lastRunObservationCount: row.last_run_observation_count,
    lastRunError: row.last_run_error,
    lastRunTriggeredBy: row.last_run_triggered_by,
  };
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoStringOrNull(value: string | Date | null): string | null {
  return value === null ? null : toIsoString(value);
}
