import { createHash } from "node:crypto";
import { vi } from "vitest";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import type { TcgplayerMarketObservationRequest } from "@chase-sets/tcgplayer-market-observations";
import { createOperatorSessionGrants } from "../api/grants";
import { operatorSessionPublicRoutes } from "../api/route";
import { current, provenance, partPath, completePath, streamId } from "./market-observation-fixture";
const grantBearer = "S".repeat(43);

export async function composeMarketObservations(pool: PgTransactionalPool, initial = current) {
  let grantLookups = 0;
  const backend = pool;
  pool = {
    query: backend.query.bind(backend),
    async connect() {
      const client = await backend.connect();
      return {
        async query<Row>(sql: string, values?: readonly unknown[]) {
          if (sql.includes("SELECT id, creator_user_id")) grantLookups++;
          return client.query<Row>(sql, values);
        },
        release: client.release.bind(client),
      };
    },
  };
  await pool.query(
    `INSERT INTO catalog_operator_session_grants
       (id, token_hash, creator_user_id, creator_membership_id, created_at, last_used_at, idle_expires_at)
     VALUES ($1, $2, $3, $4, clock_timestamp(), clock_timestamp(), clock_timestamp() + interval '30 days')`,
    [
      provenance.grantId,
      createHash("sha256").update(grantBearer, "ascii").digest(),
      provenance.creatorUserId,
      provenance.creatorMembershipId,
    ],
  );
  let request: TcgplayerMarketObservationRequest | null = initial;
  let authorized = true;
  const store = createPostgresEventStore({ pool });
  const currentRequest = vi.fn(async () => request);
  const market = {
    requestSource: { currentRequest },
    store,
    databaseNow: async () =>
      (await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.toISOString(),
  };
  const services = createOperatorSessionGrants(
    pool,
    {
      forActor: async () => ({
        kind: "granted",
        membershipId: provenance.creatorMembershipId,
        roleKey: "platform-admin",
        rolePermissions: ["catalog.manage"],
      }),
      forGrantCreator: async () =>
        authorized
          ? {
              kind: "granted",
              membershipId: provenance.creatorMembershipId,
              roleKey: "platform-admin",
              rolePermissions: ["catalog.manage"],
            }
          : { kind: "denied", reason: "authority-unavailable" },
    },
    {},
    market,
  );
  const app = operatorSessionPublicRoutes(services);
  const send = (path: string, body: unknown, method: string, bearer = grantBearer) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${bearer}` },
      body: JSON.stringify(body),
    });
  return {
    store,
    services,
    currentRequest,
    grantLookups: () => grantLookups,
    deps: { ...market, authorizeObservationGrant: services.authorizeObservationGrant },
    setRequest: (next: TcgplayerMarketObservationRequest | null) => {
      request = next;
    },
    loseAuthority: () => {
      authorized = false;
    },
    part: (body: unknown, index: string | number = 0, id?: string, bearer?: string) =>
      send(partPath(id, index), body, "PUT", bearer),
    complete: (body: unknown, id?: string, bearer?: string) => send(completePath(id), body, "POST", bearer),
    events: async () => {
      const rows = await pool.query<{ event_type: string; payload: Record<string, unknown>; stream_version: number }>(
        "SELECT event_type, payload, stream_version FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
        [streamId],
      );
      return rows.rows;
    },
  };
}
