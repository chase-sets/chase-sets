import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPoolClient, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createOperatorSessionGrants } from "../api/grants";
import { operatorSessionPublicRoutes } from "../api/route";
import {
  createInMemoryObservationStore,
  grantBearer,
  routePath,
  setNameEntry,
  setNamePost,
} from "./set-name-observation-fixture";

const cookieMarker = "TCGAuthTicket=hostile-ticket-value";
const forwardedBearer = "Bearer hostile-forwarded-bearer";
const markers = [
  cookieMarker,
  "hostile-ticket-value",
  "hostile-session-value",
  "hostile-forwarded-bearer",
  grantBearer,
];
const hostileHeaders = {
  cookie: `${cookieMarker}; session=hostile-session-value`,
  "x-tcgplayer-cookie": cookieMarker,
  "x-forwarded-authorization": forwardedBearer,
};

function grantPool(store: ReturnType<typeof createInMemoryObservationStore>) {
  const params: unknown[] = [];
  let observationWrite = false;
  const client: PgPoolClient = {
    async query<Row>(sql: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> {
      params.push(...values);
      if (sql.startsWith("SELECT pg_try_advisory_lock")) {
        observationWrite = values[0] === "84518451";
        return { rows: [{ locked: true } as Row] };
      }
      if (sql.startsWith("SELECT pg_advisory_unlock")) return { rows: [{ unlocked: true } as Row] };
      if (sql.includes("SELECT id, creator_user_id, creator_membership_id"))
        return {
          rows: [{ id: "grant_privacy", creator_user_id: "usr_creator", creator_membership_id: "mbr_creator" } as Row],
        };
      if (sql.includes("SET last_used_at")) return { rows: [{ id: "grant_privacy" } as Row] };
      return observationWrite ? store.db.query<Row>(sql, values) : { rows: [] };
    },
    release() {},
  };
  const value: PgTransactionalPool = { query: client.query, connect: async () => client };
  return { value, params };
}

function compose() {
  const store = createInMemoryObservationStore();
  const pool = grantPool(store);
  const services = createOperatorSessionGrants(
    pool.value,
    {
      forActor: vi.fn(),
      forGrantCreator: async () => ({
        kind: "granted" as const,
        membershipId: "mbr_creator",
        roleKey: "platform-admin" as const,
        rolePermissions: ["catalog.manage"],
      }),
    },
    { tcgplayerSetNames: store.runtime.recordExtensionScopeObservations },
  );
  return { app: operatorSessionPublicRoutes(services), pool, store };
}

const logs: unknown[][] = [];
beforeEach(() => {
  logs.length = 0;
  for (const method of ["log", "info", "warn", "error", "debug"] as const)
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args);
    });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function expectNoMarkers(label: string, value: unknown) {
  const text =
    typeof value === "string"
      ? value
      : JSON.stringify(value, (_key, item) => (Buffer.isBuffer(item) ? "[bytes]" : item));
  for (const marker of markers) expect(text, `${label} contains ${marker}`).not.toContain(marker);
}

function post(app: ReturnType<typeof compose>["app"], body: string, headers: Record<string, string> = {}) {
  return app.request(routePath, {
    method: "POST",
    headers: {
      authorization: `Bearer ${grantBearer}`,
      "content-type": "application/json",
      ...hostileHeaders,
      ...headers,
    },
    body,
  });
}

describe("operator-extension set-name post privacy boundary", () => {
  it("keeps hostile cookie, ticket and bearer header markers out of responses, logs, rows and events", async () => {
    const { app, pool, store } = compose();
    const response = await post(app, JSON.stringify(setNamePost(3, [setNameEntry(3, 1), setNameEntry(3, 2)])));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expectNoMarkers("response", await response.text());
    expect(store.observations()).toHaveLength(2);
    expect(store.observations()[0]!.metadata).toMatchObject({
      grantId: "grant_privacy",
      creatorUserId: "usr_creator",
      creatorMembershipId: "mbr_creator",
    });
    expectNoMarkers("rows", store.statements);
    expectNoMarkers("events", store.commands);
    expectNoMarkers("runs", store.runs);
    expectNoMarkers("grant store parameters", pool.params);
    expectNoMarkers("logs", logs);
  });

  it.each([
    ["a top-level cookie key", { ...setNamePost(3, [setNameEntry(3, 1)]), cookie: cookieMarker }],
    [
      "a nested authorization key",
      { ...setNamePost(3, []), sets: [{ ...setNameEntry(3, 1), authorization: `Bearer ${grantBearer}` }] },
    ],
    ["a nested ticket key", { ...setNamePost(3, []), sets: [{ ...setNameEntry(3, 1), TCGAuthTicket: cookieMarker }] }],
  ])("refuses %s in the body with a fixed code and writes nothing", async (_label, body) => {
    const { app, store } = compose();
    const response = await post(app, JSON.stringify(body));
    expect(response.status).toBe(400);
    expect(await response.text()).toBe('{"code":"invalid-body"}');
    expect(store.statements).toEqual([]);
    expectNoMarkers("logs", logs);
  });

  it("refuses a hostile authorization header without echoing it", async () => {
    const { app, store } = compose();
    const response = await post(app, JSON.stringify(setNamePost(3, [setNameEntry(3, 1)])), {
      authorization: `Bearer ${cookieMarker}`,
    });
    expect(response.status).toBe(401);
    expect(await response.text()).toBe('{"code":"grant-invalid"}');
    expect(store.statements).toEqual([]);
    expectNoMarkers("logs", logs);
  });

  it("returns a fixed code when the store fails with provider or credential text in the raw error", async () => {
    const { app, store } = compose();
    const query = store.db.query.bind(store.db);
    (store.db as { query: unknown }).query = async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("INSERT INTO catalog_provider_scope_observations")) throw new Error(`driver: ${cookieMarker}`);
      return query(sql, params as unknown[]);
    };
    const response = await post(app, JSON.stringify(setNamePost(3, [setNameEntry(3, 1)])));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('{"code":"scope-observations-unavailable"}');
    expect(store.runs).toEqual([
      expect.objectContaining({ status: "failed", error: "scope-observations-unavailable" }),
    ]);
    expectNoMarkers("runs", store.runs);
    expectNoMarkers("logs", logs);
  });
});
