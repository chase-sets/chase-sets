import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { afterEach, describe, expect, it } from "vitest";
import {
  GRANT_KINDS,
  WAKE_LISTENER_EVENT_STORE_TABLES,
  connectionUrlForGrant,
  main,
  quoteIdentifier,
  readGrants,
  statementsForGrant,
} from "./apply-digitalocean-database-grant.mjs";

const TEST_CA = "-----BEGIN CERTIFICATE-----\nsynthetic-ca\n-----END CERTIFICATE-----\n";
const SECRET_MARKERS = [
  "provider-token-secret-marker",
  "admin-password-secret-marker",
  "ambient-password-secret-marker",
  "provider-body-secret-marker",
  "postgres-error-secret-marker",
  "sentinel-host-secret-marker",
];
const temporaryRoots = [];
const { Client } = pg;

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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
    expect(
      readGrants({
        DATABASE_GRANTS_JSON: JSON.stringify([
          { database: "db_a", user: "user_a" },
          { database: "db_b", user: "user_b", kind: "wake-listener" },
        ]),
      }),
    ).toEqual([
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

describe("managed Postgres trust boundary", () => {
  it("fetches one cluster CA and creates one verified client for each grant database despite hostile ambient selectors", async () => {
    const root = await createTemporaryRoot();
    const observed = { fetches: [], clients: [], modes: null };
    const result = await withNodeTlsRejectUnauthorized("0", () =>
      runScript(
        trustedEnvironment({
          PGHOSTADDR: "sentinel-host-secret-marker",
          PGSERVICE: "hostile-service",
          PGDATABASE: "hostile-database",
          PGSSLMODE: "disable",
          PGSSLROOTCERT: "hostile-ca-path",
        }),
        root,
        {
          fetch: async (url, init) => {
            observed.fetches.push({ url, init });
            return providerResponse(TEST_CA);
          },
          createClient: (config) => {
            const pgClient = new Client(config);
            observed.clients.push({ config: pgClient.connectionParameters, statements: [] });
            const current = observed.clients.at(-1);
            return {
              connect: async () => {
                const [directory] = await readdir(root);
                const directoryPath = join(root, directory);
                observed.modes = {
                  directory: (await stat(directoryPath)).mode,
                  ca: (await stat(join(directoryPath, "ca.pem"))).mode,
                };
              },
              query: async (statement) => current.statements.push(statement),
              end: async () => undefined,
            };
          },
        },
      ),
    );

    expect(result.code).toBe(0);
    expect(observed.fetches).toHaveLength(1);
    expect(observed.fetches[0].url).toBe("http://127.0.0.1:41731/v2/databases/cluster-id/ca");
    expect(observed.fetches[0].init.headers.Authorization).toBe("Bearer provider-token-secret-marker");
    expect(observed.clients).toHaveLength(2);
    for (const { config, statements } of observed.clients) {
      expect(config.host).toBe("localhost");
      expect(config.port).toBe(5432);
      expect(config.database).toMatch(/^db_[ab]$/);
      expect(config.user).toBe("admin");
      expect(config.password).toBe("admin-password-secret-marker");
      expect(config.connectionString).toBeUndefined();
      expect(config.ssl).toEqual({ rejectUnauthorized: true, ca: TEST_CA });
      expect(Object.hasOwn(config.ssl, "rejectUnauthorized")).toBe(true);
      expect(statements.length).toBeGreaterThan(0);
    }
    if (process.platform !== "win32") {
      expect(observed.modes.directory & 0o777).toBe(0o700);
      expect(observed.modes.ca & 0o777).toBe(0o600);
    }
    expect(await readdir(root)).toEqual([]);
    expect(result.stdout).toEqual(['{"status":"database-grants-applied","grantCount":2}']);
    expect(result.stderr).toEqual([]);
    expectSafeOutput(result);
  });

  it("fails closed with bounded classifications and removes the process-owned path on every named failure", async () => {
    const cases = [
      {
        name: "withheld token",
        env: { ...trustedEnvironment(), DIGITALOCEAN_ACCESS_TOKEN: "" },
        expected: "missing-digitalocean-token",
      },
      {
        name: "withheld CA",
        overrides: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ ca: {} }) }) },
        expected: "digitalocean-ca-response-invalid",
        status: 200,
      },
      {
        name: "malformed provider payload",
        overrides: {
          fetch: async () => ({ ok: true, status: 200, json: async () => ({ ca: { certificate: "%%%" } }) }),
        },
        expected: "digitalocean-ca-response-invalid",
        status: 200,
      },
      {
        name: "rejected provider response",
        overrides: {
          fetch: async () => ({
            ok: false,
            status: 403,
            json: async () => ({ message: "provider-body-secret-marker" }),
          }),
        },
        expected: "digitalocean-ca-request-rejected",
        status: 403,
      },
      {
        name: "CA write failure",
        overrides: { writeCa: async () => Promise.reject(new Error("provider-body-secret-marker")) },
        expected: "managed-postgres-ca-write-failed",
      },
      {
        name: "absent CA file",
        overrides: { writeCa: async () => undefined },
        expected: "certificate-authority-file-unavailable",
        code: "ENOENT",
      },
      {
        name: "connect failure",
        overrides: {
          createClient: () => ({
            connect: async () => Promise.reject(new Error("postgres-error-secret-marker")),
            query: async () => undefined,
            end: async () => undefined,
          }),
        },
        expected: "postgres-connect-failed",
      },
      {
        name: "grant query failure",
        overrides: {
          createClient: () => ({
            connect: async () => undefined,
            query: async () => Promise.reject(new Error("postgres-error-secret-marker")),
            end: async () => undefined,
          }),
        },
        expected: "postgres-grant-query-failed",
      },
      {
        name: "missing sslmode",
        overrides: { connectionUrlForGrant: unverifiedConnectionUrl },
        expected: "managed-postgres-connection-url-invalid",
      },
      {
        name: "downgraded sslmode",
        overrides: {
          connectionUrlForGrant: (options, grant, caPath) => {
            const url = new URL(connectionUrlForGrant(options, grant, caPath));
            url.searchParams.set("sslmode", "require");
            return url.toString();
          },
        },
        expected: "managed-postgres-connection-url-invalid",
      },
    ];

    for (const testCase of cases) {
      const root = await createTemporaryRoot();
      const result = await runScript(testCase.env ?? trustedEnvironment(), root, testCase.overrides);
      expect(result.code, testCase.name).toBe(1);
      expect(result.stdout, testCase.name).toEqual([]);
      expect(result.stderr, testCase.name).toHaveLength(1);
      expect(JSON.parse(result.stderr[0]), testCase.name).toEqual({
        classification: testCase.expected,
        ...(testCase.status ? { status: testCase.status } : {}),
        ...(testCase.code ? { code: testCase.code } : {}),
      });
      expect(await readdir(root), testCase.name).toEqual([]);
      expectSafeOutput(result);
    }
  });

  it("classifies TLS trust and hostname refusals through the shared Postgres failure helper", async () => {
    for (const [code, classification] of [
      ["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "certificate-authority-untrusted"],
      ["ERR_TLS_CERT_ALTNAME_INVALID", "certificate-hostname-mismatch"],
    ]) {
      const root = await createTemporaryRoot();
      const result = await runScript(trustedEnvironment(), root, {
        createClient: () => ({
          connect: async () => Promise.reject(Object.assign(new Error("postgres-error-secret-marker"), { code })),
          query: async () => undefined,
          end: async () => undefined,
        }),
      });
      expect(JSON.parse(result.stderr[0])).toEqual({ classification, code });
      expect(await readdir(root)).toEqual([]);
      expectSafeOutput(result);
    }
  });

  it("makes cleanup failure explicit and proves the no-finally mutant leaves its owned path", async () => {
    const cleanupFailureRoot = await createTemporaryRoot();
    const cleanupFailure = await runScript(trustedEnvironment(), cleanupFailureRoot, {
      rm: async () => Promise.reject(new Error("provider-body-secret-marker")),
    });
    expect(JSON.parse(cleanupFailure.stderr[0])).toEqual({ classification: "managed-postgres-ca-cleanup-failed" });
    expect((await readdir(cleanupFailureRoot)).length).toBe(1);
    expectSafeOutput(cleanupFailure);

    const candidateRoot = await createTemporaryRoot();
    const candidate = await runScript(trustedEnvironment(), candidateRoot);
    expect(candidate.code).toBe(0);
    expect(await readdir(candidateRoot)).toEqual([]);

    const noFinallyMutantRoot = await createTemporaryRoot();
    const noFinallyMutant = await runScript(trustedEnvironment(), noFinallyMutantRoot, { rm: async () => undefined });
    expect(noFinallyMutant.code).toBe(0);
    expect((await readdir(noFinallyMutantRoot)).length).toBe(1);
  });
});

function trustedEnvironment(overrides = {}) {
  return {
    DATABASE_CLUSTER_ID: "cluster-id",
    DIGITALOCEAN_ACCESS_TOKEN: "provider-token-secret-marker",
    DATABASE_GRANTS_JSON: JSON.stringify([
      { database: "db_a", user: "owner_a" },
      { database: "db_b", user: "wake_b", kind: "wake-listener" },
    ]),
    PGHOST: "localhost",
    PGPORT: "5432",
    PGUSER: "admin",
    PGPASSWORD: "admin-password-secret-marker",
    ...overrides,
  };
}

async function createTemporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), "database-grant-test-"));
  temporaryRoots.push(root);
  return root;
}

async function runScript(env, root, overrides = {}) {
  const stdout = [];
  const stderr = [];
  const defaultClient = {
    connect: async () => undefined,
    query: async () => undefined,
    end: async () => undefined,
  };
  const code = await main(env, {
    apiBaseUrl: "http://127.0.0.1:41731/v2",
    temporaryDirectoryParent: root,
    fetch: async () => providerResponse(TEST_CA),
    createClient: () => defaultClient,
    log: (line) => stdout.push(line),
    error: (line) => stderr.push(line),
    ...overrides,
  });
  return { code, stdout, stderr };
}

async function withNodeTlsRejectUnauthorized(value, callback) {
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (value === undefined) {
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  } else {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = value;
  }
  try {
    return await callback();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    } else {
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  }
}

function providerResponse(certificate) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
  };
}

function unverifiedConnectionUrl(options, grant) {
  const url = new URL("postgresql://localhost");
  url.hostname = options.host;
  url.port = String(options.port);
  url.username = options.user;
  url.password = options.password;
  url.pathname = `/${grant.database}`;
  return url.toString();
}

function expectSafeOutput(result) {
  const output = [...result.stdout, ...result.stderr].join("\n");
  for (const marker of SECRET_MARKERS) {
    expect(output).not.toContain(marker);
  }
  expect(output).not.toContain("DATABASE_GRANTS_JSON");
  expect(output).not.toContain("BEGIN CERTIFICATE");
}
