import type { PgQueryable, PgQueryResult } from "@chase-sets/event-core-postgres";
import type { ChannelConnectionStatus } from "../domain/contracts";
import { readOperatorHealthSummaries } from "../../connection-health/read-model/store";

type ConnectionRow = Readonly<{
  connection_id: string;
  account_id: string;
  provider_key: string;
  status: ChannelConnectionStatus;
}>;

const pageSize = 100;
const maxPages = 10;

export function createChannelConnectionsOperatorReadSourceFromReadModel(db: PgQueryable) {
  return async () => {
    const rows = [];
    let after: string | null = null;
    for (let page = 0; page < maxPages; page += 1) {
      const result: PgQueryResult<ConnectionRow> = await db.query<ConnectionRow>(
        `SELECT connection_id, account_id, provider_key, status
         FROM channel_connections
         WHERE ($1::text IS NULL OR connection_id > $1)
         ORDER BY connection_id LIMIT $2`,
        [after, pageSize],
      );
      const health = await readOperatorHealthSummaries(
        db,
        result.rows.map((row) => row.connection_id),
      );
      rows.push(
        ...result.rows.map((row) => ({
          id: row.connection_id,
          provider: row.provider_key,
          capability: "channel-connection" as const,
          owner: "channels" as const,
          accountId: row.account_id,
          status: row.status,
          credentialReadiness: "unknown" as const,
          health: health.get(row.connection_id)?.state ?? "unknown",
          observedAt: health.get(row.connection_id)?.observed_at ?? null,
          freshness: null,
          destination: null,
        })),
      );
      if (result.rows.length < pageSize) return { rows, complete: true };
      after = result.rows[result.rows.length - 1].connection_id;
    }
    const tail = await db.query<{ connection_id: string }>(
      `SELECT connection_id FROM channel_connections WHERE connection_id > $1 ORDER BY connection_id LIMIT 1`,
      [after],
    );
    return { rows, complete: tail.rows.length === 0 };
  };
}
