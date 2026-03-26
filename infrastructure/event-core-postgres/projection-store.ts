import { nowIsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { ProjectionCheckpointStore } from "@chase-sets/event-core/projector";
import type { GlobalPosition } from "@chase-sets/event-core/storage";
import {
  ZERO_GLOBAL_POSITION,
  globalPositionFromBigInt,
  parseGlobalPosition,
} from "@chase-sets/event-core/storage";
import type { PgQueryable } from "./types";
import { assertSqlIdentifier } from "./sql-identifier";

type DbCheckpointRow = Readonly<{
  last_global_position: string | number | bigint;
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
    VALUES ($1, $2::bigint, $3)
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
        return ZERO_GLOBAL_POSITION;
      }

      return coerceDbGlobalPosition(
        result.rows[0].last_global_position,
        "last_global_position",
      );
    },

    saveCheckpoint: async (projectorName, globalPosition) => {
      await config.db.query(upsertCheckpointSql, [
        projectorName,
        globalPosition,
        now(),
      ]);
    },
  };
}

function coerceDbGlobalPosition(
  value: string | number | bigint,
  fieldName: string,
): GlobalPosition {
  if (typeof value === "string") {
    try {
      return parseGlobalPosition(value);
    } catch {
      throw new Error(
        `Expected "${fieldName}" to be a canonical unsigned base-10 string.`,
      );
    }
  }

  if (typeof value === "bigint") {
    if (value < BigInt(0)) {
      throw new Error(`Expected "${fieldName}" to be non-negative.`);
    }

    return globalPositionFromBigInt(value);
  }

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Expected "${fieldName}" to be a non-negative safe integer when returned as a number.`,
    );
  }

  return globalPositionFromBigInt(BigInt(value));
}
