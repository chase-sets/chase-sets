import { existsSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GRANT_KINDS,
  WAKE_LISTENER_EVENT_STORE_TABLES,
  managedPostgresGrantUrl,
  quoteIdentifier,
  readGrants,
  runDatabaseGrantMain,
  statementsForGrant,
} from "./apply-digitalocean-database-grant.mjs";

const TEST_CERTIFICATE = "-----BEGIN CERTIFICATE-----\nY2EtbWFya2Vy\n-----END CERTIFICATE-----\n";
const SECRET_MARKERS = [
  "provider-secret-marker",
  "password-secret-marker",
  "grant-json-secret-marker",
  "ambient-secret-marker",
  "BEGIN CERTIFICATE",
  "postgresql://",
];

function grantEnvironment(overrides = {}) {
  return {
    DATABASE_GRANTS_JSON: JSON.stringify([
      { database: "database_a", user: "owner_a" },
      { database: "database_b", user: "listener_b", kind: "wake-listener" },
    ]),
    DIGITALOCEAN_ACCESS_TOKEN: "provider-secret-marker",
    DIGITALOCEAN_DATABASE_CLUSTER_ID: "cluster-exact-7312",
    PGHOST: "managed-db.example.test",
    PGPASSWORD: "password-secret-marker",
    PGPORT: "25060",
    PGUSER: "cluster_admin",
    PGHOSTADDR: "ambient-secret-marker",
    PGSERVICE: "ambient-secret-marker",
    PGDATABASE: "ambient-secret-marker",
    PGSSLMODE: "disable",
    PGSSLROOTCERT: "ambient-secret-marker",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    ...overrides,
  };
}

function providerCaResponse(payload = { ca: { certificate: Buffer.from(TEST_CERTIFICATE).toString("base64") } }) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function testTemporaryRoot() {
  return mkdtemp(join(tmpdir(), "grant-tls-unit-"));
}

function outputRecorder() {
  const stdout = [];
  const stderr = [];
  return {
    stdout,
    stderr,
    log: (value) => stdout.push(String(value)),
    error: (value) => stderr.push(String(value)),
    retained: () => JSON.stringify({ stdout, stderr }),
  };
}

function expectCredentialSafeOutput(output) {
  for (const marker of SECRET_MARKERS) {
    expect(output).not.toContain(marker);
  }
}

describe("database grant kinds", () => {
  it("keeps owner grants on the existing full-usage statements", () => {
    const statements = statementsForGrant({
      database: "chase_sets_staging_checkout",
      user: "cs_staging_checkout",
      kind: "owner",
    });

    expect(statements).toEqual([
      'GRANT CONNECT, CREATE, TEMPORARY ON DATABASE "chase_sets_staging_checkout" TO "cs_staging_checkout"',
      'GRANT USAGE, CREATE ON SCHEMA public TO "cs_staging_checkout"',
    ]);
  });

  it("grants wake-listener users CONNECT, schema USAGE, and event-store SELECT only", () => {
    const statements = statementsForGrant({
      database: "chase_sets_staging_checkout",
      user: "cs_staging_checkout_wake_listener",
      kind: "wake-listener",
    });

    expect(statements[0]).toBe(
      'GRANT CONNECT ON DATABASE "chase_sets_staging_checkout" TO "cs_staging_checkout_wake_listener"',
    );
    expect(statements[1]).toBe('GRANT USAGE ON SCHEMA public TO "cs_staging_checkout_wake_listener"');
    expect(statements).toHaveLength(2 + WAKE_LISTENER_EVENT_STORE_TABLES.length);

    for (const [index, tableName] of WAKE_LISTENER_EVENT_STORE_TABLES.entries()) {
      const statement = statements[2 + index];
      expect(statement).toContain(`to_regclass('public.${tableName}')`);
      expect(statement).toContain(`GRANT SELECT ON TABLE public."${tableName}" TO "cs_staging_checkout_wake_listener"`);
    }

    const serialized = statements.join("\n");
    expect(serialized).not.toContain("INSERT");
    expect(serialized).not.toContain("UPDATE");
    expect(serialized).not.toContain("DELETE");
    expect(serialized).not.toMatch(/GRANT [^\n]*CREATE/);
    expect(serialized).not.toContain("TEMPORARY");
    expect(WAKE_LISTENER_EVENT_STORE_TABLES).toEqual(["event_store_events", "event_store_streams"]);
  });

  it("escapes identifiers in generated statements", () => {
    expect(quoteIdentifier('weird"name')).toBe('"weird""name"');
    const [connect] = statementsForGrant({ database: 'data"base', user: 'user"name', kind: "wake-listener" });
    expect(connect).toBe('GRANT CONNECT ON DATABASE "data""base" TO "user""name"');
  });
});

describe("grant input parsing", () => {
  it("defaults the grant kind to owner and accepts wake-listener", () => {
    const grants = readGrants({
      DATABASE_GRANTS_JSON: JSON.stringify([
        { database: "db_a", user: "user_a" },
        { database: "db_b", user: "user_b", kind: "wake-listener" },
      ]),
    });

    expect(grants).toEqual([
      { database: "db_a", user: "user_a", kind: "owner" },
      { database: "db_b", user: "user_b", kind: "wake-listener" },
    ]);
  });

  it("rejects unknown grant kinds and malformed entries", () => {
    expect(() =>
      readGrants({ DATABASE_GRANTS_JSON: JSON.stringify([{ database: "db", user: "u", kind: "superuser" }]) }),
    ).toThrow(GRANT_KINDS.join(", "));
    expect(() => readGrants({ DATABASE_GRANTS_JSON: JSON.stringify([{ database: "db" }]) })).toThrow(
      "must include database and user strings",
    );
    expect(() => readGrants({ DATABASE_GRANTS_JSON: "[]" })).toThrow("non-empty array");
  });

  it("falls back to the single-grant env contract as an owner grant", () => {
    expect(readGrants({ DATABASE_GRANT_NAME: "db_a", DATABASE_GRANT_USER: "user_a" })).toEqual([
      { database: "db_a", user: "user_a", kind: "owner" },
    ]);
  });
});

describe("managed Postgres grant TLS main", () => {
  it("fetches the exact cluster CA once and creates one canonical verified client per ordered grant", async () => {
    const root = await testTemporaryRoot();
    const output = outputRecorder();
    const providerRequests = [];
    const clientConfigs = [];
    const queries = [];
    const modes = [];
    let ended = 0;

    class RecordingClient {
      constructor(config) {
        clientConfigs.push(config);
        const caPath = new URL(config.connectionString).searchParams.get("sslrootcert");
        modes.push({
          directory: statSync(dirname(caPath)).mode & 0o777,
          file: statSync(caPath).mode & 0o777,
        });
      }

      async connect() {}

      async query(statement) {
        queries.push(statement);
      }

      async end() {
        ended += 1;
      }
    }

    try {
      const result = await runDatabaseGrantMain(grantEnvironment(), {
        ...output,
        Client: RecordingClient,
        tmpdir: () => root,
        fetch: async (url, options) => {
          providerRequests.push({ url, options });
          return providerCaResponse();
        },
      });

      expect(result).toBe(0);
      expect(providerRequests).toEqual([
        {
          url: "https://api.digitalocean.com/v2/databases/cluster-exact-7312/ca",
          options: {
            headers: {
              Accept: "application/json",
              Authorization: "Bearer provider-secret-marker",
            },
          },
        },
      ]);
      expect(clientConfigs).toHaveLength(2);
      expect(
        clientConfigs.map(({ connectionString }) => {
          const url = new URL(connectionString);
          return {
            host: url.hostname,
            port: url.port,
            database: decodeURIComponent(url.pathname.slice(1)),
            sslmode: url.searchParams.get("sslmode"),
            sslrootcert: url.searchParams.get("sslrootcert"),
            uselibpqcompat: url.searchParams.get("uselibpqcompat"),
          };
        }),
      ).toEqual([
        {
          host: "managed-db.example.test",
          port: "25060",
          database: "database_a",
          sslmode: "verify-full",
          sslrootcert: expect.stringMatching(/ca\.crt$/),
          uselibpqcompat: "true",
        },
        {
          host: "managed-db.example.test",
          port: "25060",
          database: "database_b",
          sslmode: "verify-full",
          sslrootcert: expect.stringMatching(/ca\.crt$/),
          uselibpqcompat: "true",
        },
      ]);
      for (const config of clientConfigs) {
        expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: TEST_CERTIFICATE });
        expect(config.connectionString).not.toContain("ambient-secret-marker");
      }
      if (process.platform !== "win32") {
        expect(modes).toEqual([
          { directory: 0o700, file: 0o600 },
          { directory: 0o700, file: 0o600 },
        ]);
      }
      expect(queries).toEqual([
        ...statementsForGrant({ database: "database_a", user: "owner_a", kind: "owner" }),
        ...statementsForGrant({ database: "database_b", user: "listener_b", kind: "wake-listener" }),
      ]);
      expect(ended).toBe(2);
      expect(readdirSync(root)).toEqual([]);
      expect(output.stderr).toEqual([]);
      expect(output.stdout).toEqual([
        JSON.stringify({ classification: "managed-postgres-grants-applied", grantCount: 2 }),
      ]);
      expectCredentialSafeOutput(output.retained());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "withheld cluster identity",
      env: { DIGITALOCEAN_DATABASE_CLUSTER_ID: "" },
      fetch: async () => {
        throw new Error("fetch must not run");
      },
      classification: "managed-postgres-grant-input-invalid",
    },
    {
      name: "withheld token",
      env: { DIGITALOCEAN_ACCESS_TOKEN: "" },
      fetch: async () => {
        throw new Error("fetch must not run");
      },
      classification: "missing-digitalocean-token",
    },
    {
      name: "withheld CA",
      fetch: async () => providerCaResponse({ ca: {} }),
      classification: "digitalocean-ca-response-invalid",
      status: 200,
    },
    {
      name: "malformed provider payload",
      fetch: async () =>
        new Response("provider-secret-marker malformed", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      classification: "digitalocean-ca-response-invalid",
      status: 200,
    },
    {
      name: "rejected provider response",
      fetch: async () =>
        new Response("provider-secret-marker rejected", {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      classification: "digitalocean-ca-request-rejected",
      status: 403,
    },
    {
      name: "provider request failure",
      fetch: async () => {
        throw new Error("provider-secret-marker request");
      },
      classification: "digitalocean-ca-request-failed",
    },
  ])("fails closed for $name without creating or retaining a trust path", async (testCase) => {
    const root = await testTemporaryRoot();
    const output = outputRecorder();
    try {
      const result = await runDatabaseGrantMain(grantEnvironment(testCase.env), {
        ...output,
        tmpdir: () => root,
        fetch: testCase.fetch,
        Client: class RefusedClient {
          constructor() {
            throw new Error("client must not be constructed");
          }
        },
      });

      expect(result).toBe(1);
      expect(output.stdout).toEqual([]);
      expect(JSON.parse(output.stderr.at(-1))).toEqual({
        classification: testCase.classification,
        ...(testCase.status ? { status: testCase.status } : {}),
      });
      expect(readdirSync(root)).toEqual([]);
      expectCredentialSafeOutput(output.retained());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    {
      name: "missing sslmode",
      mutate: (url) => url.searchParams.delete("sslmode"),
      classification: "managed-postgres-grant-trust-invalid",
    },
    {
      name: "downgraded sslmode",
      mutate: (url) => url.searchParams.set("sslmode", "require"),
      classification: "managed-postgres-grant-trust-invalid",
    },
    {
      name: "missing CA path",
      mutate: (url) => url.searchParams.delete("sslrootcert"),
      classification: "managed-postgres-grant-trust-invalid",
    },
    {
      name: "wrong CA path",
      mutate: (url) => url.searchParams.set("sslrootcert", "wrong-ca-secret-marker"),
      classification: "managed-postgres-grant-trust-invalid",
    },
    {
      name: "missing libpq compatibility",
      mutate: (url) => url.searchParams.delete("uselibpqcompat"),
      classification: "managed-postgres-grant-trust-invalid",
    },
    {
      name: "ambient hostaddr escape",
      mutate: (url) => url.searchParams.set("hostaddr", "ambient-secret-marker"),
      classification: "managed-postgres-grant-trust-invalid",
    },
    {
      name: "wrong hostname",
      mutate: (url) => {
        url.hostname = "wrong-host.example.test";
      },
      classification: "managed-postgres-grant-authority-mismatch",
    },
    {
      name: "first database pinned",
      mutate: (url) => {
        url.pathname = "/database_a";
      },
      classification: "managed-postgres-grant-authority-mismatch",
    },
  ])("rejects the $name bypass mutant at the exact URL/client boundary", async ({ name, mutate, classification }) => {
    const root = await testTemporaryRoot();
    const output = outputRecorder();
    let constructed = 0;
    try {
      const result = await runDatabaseGrantMain(grantEnvironment(), {
        ...output,
        tmpdir: () => root,
        fetch: async () => providerCaResponse(),
        managedPostgresGrantUrl: (grant, env, caPath) => {
          const url = new URL(managedPostgresGrantUrl(grant, env, caPath));
          if (grant.database === "database_b" || !["first database pinned"].includes(name)) mutate(url);
          return url.toString();
        },
        Client: class RefusedClient {
          constructor() {
            constructed += 1;
          }

          async connect() {}

          async query() {}

          async end() {}
        },
      });

      expect(result).toBe(1);
      expect(constructed).toBe(name === "first database pinned" ? 1 : 0);
      expect(JSON.parse(output.stderr.at(-1))).toEqual({ classification });
      expect(readdirSync(root)).toEqual([]);
      expectCredentialSafeOutput(output.retained());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { stage: "CA write", classification: "managed-postgres-grant-ca-write-failed" },
    { stage: "missing CA file", classification: "certificate-authority-file-unavailable" },
    { stage: "connect", classification: "postgres-connect-failed" },
    { stage: "grant query", classification: "postgres-grant-query-failed" },
  ])("removes the whole process-owned trust path after $stage failure", async ({ stage, classification }) => {
    const root = await testTemporaryRoot();
    const output = outputRecorder();
    let ownedPath;
    class FailingClient {
      constructor(config) {
        ownedPath = dirname(new URL(config.connectionString).searchParams.get("sslrootcert"));
      }

      async connect() {
        if (stage === "connect") throw new Error("password-secret-marker connect");
      }

      async query() {
        if (stage === "grant query") throw new Error("grant-json-secret-marker query");
      }

      async end() {}
    }

    try {
      const result = await runDatabaseGrantMain(grantEnvironment(), {
        ...output,
        tmpdir: () => root,
        fetch: async () => providerCaResponse(),
        Client: FailingClient,
        ...(stage === "CA write"
          ? {
              writeManagedPostgresCa: async (caPath) => {
                ownedPath = dirname(caPath);
                throw new Error("provider-secret-marker write");
              },
            }
          : {}),
        ...(stage === "missing CA file" ? { writeManagedPostgresCa: async () => undefined } : {}),
      });

      expect(result).toBe(1);
      expect(JSON.parse(output.stderr.at(-1))).toMatchObject({ classification });
      expect(ownedPath ? existsSync(ownedPath) : false).toBe(false);
      expect(readdirSync(root)).toEqual([]);
      expectCredentialSafeOutput(output.retained());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects the no-finally cleanup bypass mutant after an injected connect failure", async () => {
    const root = await testTemporaryRoot();
    const output = outputRecorder();
    let ownedPath;
    class FailingClient {
      constructor(config) {
        ownedPath = dirname(new URL(config.connectionString).searchParams.get("sslrootcert"));
      }

      async connect() {
        throw new Error("password-secret-marker connect");
      }

      async end() {}
    }

    try {
      const result = await runDatabaseGrantMain(grantEnvironment(), {
        ...output,
        tmpdir: () => root,
        fetch: async () => providerCaResponse(),
        Client: FailingClient,
        rm: async () => undefined,
      });

      expect(result).toBe(1);
      expect(ownedPath && existsSync(ownedPath)).toBe(true);
      expect(JSON.parse(output.stderr.at(-1))).toMatchObject({ classification: "postgres-connect-failed" });
      expectCredentialSafeOutput(output.retained());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
