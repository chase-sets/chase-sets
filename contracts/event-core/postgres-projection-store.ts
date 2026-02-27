import { nowIsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "../primitives/iso-utc-timestamp";
import type { PgQueryable } from "./postgres-types";
import type { ProjectionCheckpointStore } from "./projector";
import { assertSqlIdentifier } from "./sql-identifier";

type DbCheckpointRow = Readonly<{
  last_global_position: number | string;
}>;

export type PostgresProjectionStoreConfig = Readonly<{
  db: PgQueryable;
  tableName?: string;
  now?: () => IsoUtcTimestamp;
}>;

const DEFAULT_CHECKPOINTS_TABLE = "event_projection_checkpoints";

export function createPostgresProjectionStore(
  config: PostgresProjectionStoreConfig,
): ProjectionCheckpointStore {
  const tableName = assertSqlIdentifier(
    config.tableName ?? DEFAULT_CHECKPOINTS_TABLE,
  );
  const now = config.now ?? nowIsoUtcTimestamp;

  const readCheckpointSql = `
    SELECT last_global_position
    FROM ${tableName}
    WHERE projector_name = $1
  `;

  const upsertCheckpointSql = `
    INSERT INTO ${tableName} (projector_name, last_global_position, updated_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (projector_name)
    DO UPDATE SET
      last_global_position = GREATEST(
        ${tableName}.last_global_position,
        EXCLUDED.last_global_position
      ),
      updated_at = EXCLUDED.updated_at
  `;

  return {
    loadCheckpoint: async (projectorName) => {
      const result = await config.db.query<DbCheckpointRow>(readCheckpointSql, [
        projectorName,
      ]);

      if (result.rows.length === 0) {
        return 0;
      }

      return toNumber(result.rows[0].last_global_position);
    },

    saveCheckpoint: async (projectorName, globalPosition) => {
      const safeGlobalPosition = assertNonNegativeInteger(
        globalPosition,
        "globalPosition",
      );

      await config.db.query(upsertCheckpointSql, [
        projectorName,
        safeGlobalPosition,
        now(),
      ]);
    },
  };
}

function toNumber(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not convert "${String(value)}" to number.`);
  }

  return parsed;
}

function assertNonNegativeInteger(value: number, fieldName: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer.`);
  }

  return value;
}
