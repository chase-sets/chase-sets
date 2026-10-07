import { expect } from "vitest";
import type { ResolvedActor } from "@chase-sets/auth-context";
import { module as catalogModule } from "@chase-sets/catalog";
import type { PgPoolClient, PgQueryable, PgQueryResult, PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { createApiHost } from "@chase-sets/platform-runtime/api";
import type { SecretEnvelopeKeyring } from "@chase-sets/platform-runtime/secret-envelope";
import { buildPlatformApiApp } from "../../src/app";

export const base = "https://admin.example";
export const adminPath = "/api/catalog/operator-session";
export const publicPath = "/api/public/catalog/operator-session";
export const deniedOrigins: readonly HeadersInit[] = [
  {},
  { origin: "null" },
  { origin: "https://foreign.example" },
  { origin: base, "sec-fetch-site": "cross-site" },
];
export const keyring = { activeKeyId: "synthetic-key", keys: new Map([["synthetic-key", new Uint8Array(32).fill(7)]]) };
export const session = (expectedRevision = 0, value = "synthetic-cookie") => ({
  expectedRevision,
  value,
  observedAt: "2026-10-01T00:00:00.000Z",
  browserExpiresAt: null,
});
export function operator(overrides: Partial<ResolvedActor> = {}): ResolvedActor {
  return {
    sessionId: "synthetic-session",
    tenantId: "00000000-0000-4000-8000-000000000001",
    userId: "00000000-0000-4000-8000-000000000002",
    accountId: "00000000-0000-4000-8000-000000000003",
    membershipId: "00000000-0000-4000-8000-000000000004",
    roleKey: "platform-admin",
    permissions: ["catalog.view", "catalog.manage"],
    authenticatedAt: new Date().toISOString(),
    ...overrides,
  };
}
export function mounted(
  catalogManifest: Parameters<typeof createApiHost>[0][number]["manifest"],
  pool: PgTransactionalPool,
  options: { actor?: ResolvedActor | null; keys?: SecretEnvelopeKeyring | null } = {},
) {
  const runtime = createApiHost(
    [{ contextName: "catalog", packageName: "@chase-sets/catalog", manifest: catalogManifest, module: catalogModule }],
    "platform-api",
    {
      pools: { catalog: pool },
      hostPorts: {
        catalogOperatorSessionConfiguration: {
          config: null,
          keyring: options.keys === undefined ? keyring : options.keys,
        },
      },
    },
  );
  const actor = options.actor === undefined ? operator() : options.actor;
  return buildPlatformApiApp(runtime, { runtimeProfile: "landing", resolveActor: async () => actor });
}
export type App = ReturnType<typeof mounted>;
export async function admin(
  app: App,
  method = "POST",
  path = adminPath + "/grant",
  headers: HeadersInit = { origin: base },
) {
  return app.request(base + path, { method, headers });
}
export async function push(app: App, bearer: string, input: unknown = session()) {
  return app.request(base + publicPath + "/tcgplayer", {
    method: "PUT",
    headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}
export async function unpair(app: App, bearer: string) {
  return app.request(base + publicPath + "/grant", {
    method: "DELETE",
    headers: { authorization: "Bearer " + bearer },
  });
}
export async function mint(app: App): Promise<string> {
  const response = await admin(app);
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("grant" in body) || typeof body.grant !== "string")
    throw new Error("mint failed");
  expect(body.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return body.grant;
}
export async function snapshot(db: PgQueryable) {
  return {
    grants: (await db.query("SELECT *, xmin::text AS row_version FROM catalog_operator_session_grants ORDER BY id"))
      .rows,
    custody: (await db.query("SELECT *, xmin::text AS row_version FROM catalog_tcgplayer_operator_sessions")).rows,
  };
}
export function barrier() {
  let reached!: () => void;
  let resume!: () => void;
  const arrival = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const release = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return {
    arrival,
    resume,
    pause: async () => {
      reached();
      await release;
    },
  };
}
type Hook = (sql: string, values: readonly unknown[], client: PgPoolClient) => Promise<void>;
export function transport(pool: PgTransactionalPool) {
  const controls: { before?: Hook; after?: Hook; now?: Date } = {};
  const statements: string[] = [];
  const live = new Set<PgPoolClient>();
  let destroyed = 0;
  let connects = 0;
  const bound: PgTransactionalPool = {
    query: pool.query.bind(pool),
    async connect() {
      const client = await pool.connect();
      connects++;
      live.add(client);
      return {
        async query<Row>(sql: string, values: readonly unknown[] = []): Promise<PgQueryResult<Row>> {
          statements.push(sql);
          await controls.before?.(sql, values, client);
          const controlled = controls.now
            ? sql.replaceAll("clock_timestamp()", "'" + controls.now.toISOString() + "'::timestamptz")
            : sql;
          const result = await client.query<Row>(controlled, values);
          await controls.after?.(sql, values, client);
          return result;
        },
        release(error) {
          if (error !== undefined) destroyed++;
          live.delete(client);
          client.release(error);
        },
      };
    },
  };
  return {
    pool: bound,
    controls,
    statements,
    get live() {
      return live.size;
    },
    get destroyed() {
      return destroyed;
    },
    get connects() {
      return connects;
    },
  };
}
