import type { PgQueryable, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { platformUcpRuntimeSchemaSql } from "./ucp";

export const platformControlPlaneSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_control_leases (
  lease_name text PRIMARY KEY,
  owner_id text NOT NULL,
  fencing_token bigint NOT NULL CHECK (fencing_token >= 1),
  expires_at timestamptz NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  acquired_at timestamptz NOT NULL,
  renewed_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_control_leases_expires_at_idx
  ON platform_control_leases (expires_at);

CREATE TABLE IF NOT EXISTS platform_worker_heartbeats (
  worker_id text PRIMARY KEY,
  worker_kind text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL,
  heartbeat_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_runner_statuses (
  runner_name text PRIMARY KEY,
  runner_kind text NOT NULL,
  owner_id text,
  fencing_token bigint,
  state text NOT NULL,
  last_processed integer NOT NULL DEFAULT 0,
  last_error text,
  last_ran_at timestamptz,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS platform_realtime_stream_leases (
  lease_id text PRIMARY KEY,
  connection_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  acquired_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_realtime_stream_leases_connection_key_idx
  ON platform_realtime_stream_leases (connection_key);

CREATE INDEX IF NOT EXISTS platform_realtime_stream_leases_expires_at_idx
  ON platform_realtime_stream_leases (expires_at);

${platformUcpRuntimeSchemaSql}
`;

export type PlatformLease = Readonly<{
  leaseName: string;
  ownerId: string;
  fencingToken: string;
  expiresAt: string;
}>;

export type PlatformControlPlane = Readonly<{
  bootstrap: () => Promise<void>;
  acquireLease: (
    input: Readonly<{
      leaseName: string;
      ownerId: string;
      ttlMs: number;
      metadata?: Record<string, unknown>;
    }>,
  ) => Promise<PlatformLease | null>;
  renewLease: (lease: PlatformLease, ttlMs: number) => Promise<boolean>;
  releaseLease: (lease: PlatformLease) => Promise<void>;
  heartbeatWorker: (
    input: Readonly<{
      workerId: string;
      workerKind: string;
      metadata?: Record<string, unknown>;
    }>,
  ) => Promise<void>;
  recordRunnerStatus: (
    input: Readonly<{
      runnerName: string;
      runnerKind: string;
      state: "idle" | "running" | "caught-up" | "degraded" | "error" | "skipped";
      ownerId?: string;
      fencingToken?: string;
      lastProcessed?: number;
      lastError?: string | null;
    }>,
  ) => Promise<void>;
  listWorkerHeartbeats: () => Promise<readonly Record<string, unknown>[]>;
  listRunnerStatuses: () => Promise<readonly Record<string, unknown>[]>;
  listLeases: () => Promise<readonly Record<string, unknown>[]>;
}>;

type LeaseRow = Readonly<{
  lease_name: string;
  owner_id: string;
  fencing_token: string | number | bigint;
  expires_at: Date | string;
}>;

export async function bootstrapPlatformControlPlane(db: PgQueryable): Promise<void> {
  await db.query(platformControlPlaneSchemaSql);
}

export function createPostgresPlatformControlPlane(db: PgTransactionalPool): PlatformControlPlane {
  return {
    bootstrap: () => bootstrapPlatformControlPlane(db),
    acquireLease: async (input) => {
      const result = await db.query<LeaseRow>(
        `INSERT INTO platform_control_leases (
           lease_name,
           owner_id,
           fencing_token,
           expires_at,
           metadata,
           acquired_at,
           renewed_at
         ) VALUES (
           $1,
           $2,
           1,
           now() + ($3::text || ' milliseconds')::interval,
           $4::jsonb,
           now(),
           now()
         )
         ON CONFLICT (lease_name)
         DO UPDATE SET
           owner_id = EXCLUDED.owner_id,
           fencing_token = platform_control_leases.fencing_token + 1,
           expires_at = EXCLUDED.expires_at,
           metadata = EXCLUDED.metadata,
           acquired_at = now(),
           renewed_at = now()
         WHERE platform_control_leases.expires_at <= now()
            OR platform_control_leases.owner_id = EXCLUDED.owner_id
         RETURNING lease_name, owner_id, fencing_token, expires_at`,
        [input.leaseName, input.ownerId, input.ttlMs, JSON.stringify(input.metadata ?? {})],
      );

      return result.rows[0] ? mapLeaseRow(result.rows[0]) : null;
    },
    renewLease: async (lease, ttlMs) => {
      const result = await db.query(
        `UPDATE platform_control_leases
         SET expires_at = now() + ($4::text || ' milliseconds')::interval,
             renewed_at = now()
         WHERE lease_name = $1
           AND owner_id = $2
           AND fencing_token = $3::bigint
           AND expires_at > now()`,
        [lease.leaseName, lease.ownerId, lease.fencingToken, ttlMs],
      );
      return (result.rowCount ?? 0) > 0;
    },
    releaseLease: async (lease) => {
      await db.query(
        `DELETE FROM platform_control_leases
         WHERE lease_name = $1
           AND owner_id = $2
           AND fencing_token = $3::bigint`,
        [lease.leaseName, lease.ownerId, lease.fencingToken],
      );
    },
    heartbeatWorker: async (input) => {
      await db.query(
        `INSERT INTO platform_worker_heartbeats (
           worker_id,
           worker_kind,
           metadata,
           started_at,
           heartbeat_at
         ) VALUES ($1, $2, $3::jsonb, now(), now())
         ON CONFLICT (worker_id)
         DO UPDATE SET
           worker_kind = EXCLUDED.worker_kind,
           metadata = EXCLUDED.metadata,
           heartbeat_at = EXCLUDED.heartbeat_at`,
        [input.workerId, input.workerKind, JSON.stringify(input.metadata ?? {})],
      );
    },
    recordRunnerStatus: async (input) => {
      await db.query(
        `INSERT INTO platform_runner_statuses (
           runner_name,
           runner_kind,
           owner_id,
           fencing_token,
           state,
           last_processed,
           last_error,
           last_ran_at,
           updated_at
         ) VALUES ($1, $2, $3, $4::bigint, $5, $6, $7, now(), now())
         ON CONFLICT (runner_name)
         DO UPDATE SET
           runner_kind = EXCLUDED.runner_kind,
           owner_id = EXCLUDED.owner_id,
           fencing_token = EXCLUDED.fencing_token,
           state = EXCLUDED.state,
           last_processed = EXCLUDED.last_processed,
           last_error = EXCLUDED.last_error,
           last_ran_at = EXCLUDED.last_ran_at,
           updated_at = EXCLUDED.updated_at`,
        [
          input.runnerName,
          input.runnerKind,
          input.ownerId ?? null,
          input.fencingToken ?? null,
          input.state,
          input.lastProcessed ?? 0,
          input.lastError ?? null,
        ],
      );
    },
    listWorkerHeartbeats: async () =>
      (
        await db.query(
          `SELECT worker_id, worker_kind, metadata, started_at, heartbeat_at
         FROM platform_worker_heartbeats
         ORDER BY worker_id`,
        )
      ).rows,
    listRunnerStatuses: async () =>
      (
        await db.query(
          `SELECT runner_name, runner_kind, owner_id, fencing_token, state,
                last_processed, last_error, last_ran_at, updated_at
         FROM platform_runner_statuses
         ORDER BY runner_name`,
        )
      ).rows,
    listLeases: async () =>
      (
        await db.query(
          `SELECT lease_name, owner_id, fencing_token, expires_at, metadata,
                acquired_at, renewed_at
         FROM platform_control_leases
         ORDER BY lease_name`,
        )
      ).rows,
  };
}

function mapLeaseRow(row: LeaseRow): PlatformLease {
  return {
    leaseName: row.lease_name,
    ownerId: row.owner_id,
    fencingToken: String(row.fencing_token),
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
  };
}
