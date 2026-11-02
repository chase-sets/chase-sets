import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManagedPostgresAuthorityFailure,
  databaseUrlsFromTerraformState,
  exportTerraformStateDatabaseUrls,
  fetchDigitalOceanManagedPostgresCa,
  githubEnvLinesForDatabaseUrls,
  managedPostgresClusterIdFromTerraformState,
  main,
  parseTerraformStateDatabaseUrlArgs,
  reconcileManagedPostgresCaSecret,
  writeManagedPostgresCa,
} from "./terraform-state-database-urls.mjs";
import { parse as parseYaml } from "yaml";

const caPath = "/runner/temp/digitalocean-managed-postgres-ca.pem";
const certificate = "-----BEGIN CERTIFICATE-----\nZmFrZS1jYQ==\n-----END CERTIFICATE-----\n";
const tempDirectories = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function terraformState() {
  return {
    resources: [
      {
        type: "digitalocean_database_cluster",
        name: "postgres",
        instances: [{ attributes: { id: "cluster-123", host: "db.example.internal", port: 25060 } }],
      },
      {
        type: "digitalocean_database_db",
        name: "contexts",
        instances: [
          { index_key: "checkout", attributes: { name: "checkout-db" } },
          { index_key: "control", attributes: { name: "control-db" } },
          { index_key: "fulfillment", attributes: { name: "fulfillment-db" } },
        ],
      },
      {
        type: "digitalocean_database_user",
        name: "contexts",
        instances: [
          { index_key: "checkout", attributes: { name: "checkout-user", password: "pass word" } },
          { index_key: "control", attributes: { name: "control-user", password: "control/pass" } },
          { index_key: "fulfillment", attributes: { name: "fulfillment-user", password: "fulfillment-pass" } },
        ],
      },
    ],
  };
}

function pooledTerraformState() {
  const state = terraformState();
  state.resources.push({
    type: "digitalocean_database_connection_pool",
    name: "contexts",
    instances: [
      {
        index_key: "checkout",
        attributes: {
          name: "checkout-runtime",
          mode: "transaction",
          host: "pool.example.internal",
          port: 25061,
          user: "checkout-user",
          password: "",
        },
      },
      {
        index_key: "control",
        attributes: {
          name: "control-runtime",
          mode: "transaction",
          host: "pool.example.internal",
          port: 25061,
          user: "control-user",
          password: "",
        },
      },
      {
        index_key: "fulfillment",
        attributes: {
          name: "fulfillment-runtime",
          mode: "transaction",
          host: "pool.example.internal",
          port: 25061,
          user: "fulfillment-user",
          password: "",
        },
      },
    ],
  });
  return state;
}

function mixedPooledTerraformState() {
  const state = pooledTerraformState();
  const databases = state.resources.find((resource) => resource.type === "digitalocean_database_db");
  const users = state.resources.find((resource) => resource.type === "digitalocean_database_user");
  const pools = state.resources.find((resource) => resource.type === "digitalocean_database_connection_pool");
  databases.instances.push({ index_key: "reputation", attributes: { name: "reputation-db" } });
  users.instances.push({
    index_key: "reputation",
    attributes: { name: "reputation-user", password: "reputation-pass" },
  });
  pools.instances.push({
    index_key: "search",
    attributes: {
      name: "search-runtime",
      mode: "session",
      host: "pool.example.internal",
      port: 25061,
      user: "search-user",
      password: "search-pass",
    },
  });
  return state;
}

describe("Terraform state database URL export", () => {
  it("derives masked GitHub env lines for every context by default", () => {
    const urls = databaseUrlsFromTerraformState(terraformState(), { environmentName: "staging", caPath });

    expect(githubEnvLinesForDatabaseUrls(urls, caPath)).toEqual([
      `PGSSLROOTCERT=${caPath}`,
      "DATABASE_URL_CHECKOUT=postgresql://checkout-user:pass%20word@db.example.internal:25060/checkout-db?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true",
      "PLATFORM_CONTROL_DATABASE_URL=postgresql://control-user:control%2Fpass@db.example.internal:25060/control-db?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true",
      "DATABASE_URL_FULFILLMENT=postgresql://fulfillment-user:fulfillment-pass@db.example.internal:25060/fulfillment-db?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true",
    ]);
  });

  it("supports a required-context subset for provider proof workflows", () => {
    const urls = databaseUrlsFromTerraformState(terraformState(), {
      contexts: ["fulfillment", "checkout"],
      environmentName: "production",
      caPath,
    });

    expect(urls.map(({ envName }) => envName)).toEqual(["DATABASE_URL_FULFILLMENT", "DATABASE_URL_CHECKOUT"]);
  });

  it("derives DOKS query URLs from transaction pool state when requested", () => {
    const urls = databaseUrlsFromTerraformState(pooledTerraformState(), {
      connectionMode: "pooled",
      environmentName: "staging",
      caPath,
    });

    expect(githubEnvLinesForDatabaseUrls(urls, caPath)).toEqual([
      `PGSSLROOTCERT=${caPath}`,
      "DATABASE_URL_CHECKOUT=postgresql://checkout-user:pass%20word@pool.example.internal:25061/checkout-runtime?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true",
      "PLATFORM_CONTROL_DATABASE_URL=postgresql://control-user:control%2Fpass@pool.example.internal:25061/control-runtime?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true",
      "DATABASE_URL_FULFILLMENT=postgresql://fulfillment-user:fulfillment-pass@pool.example.internal:25061/fulfillment-runtime?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true",
    ]);
  });

  it("pooled context selection selects only transaction pools and rejects explicit unpooled contexts", () => {
    const urls = databaseUrlsFromTerraformState(mixedPooledTerraformState(), {
      connectionMode: "pooled",
      selectionMode: "pooled-only",
      environmentName: "production",
      caPath,
    });
    expect(urls.map(({ contextName }) => contextName)).toEqual(["checkout", "control", "fulfillment"]);
    expect(() =>
      databaseUrlsFromTerraformState(mixedPooledTerraformState(), {
        contexts: ["reputation"],
        connectionMode: "pooled",
        selectionMode: "pooled-only",
        caPath,
      }),
    ).toThrow("transaction pool");
  });

  it("preserves mode-less pools for all selection and rejects them for pooled-only", () => {
    const state = pooledTerraformState();
    const pool = state.resources.find((resource) => resource.type === "digitalocean_database_connection_pool");
    delete pool.instances[0].attributes.mode;
    expect(databaseUrlsFromTerraformState(state, { connectionMode: "pooled", caPath })).toHaveLength(3);
    expect(
      databaseUrlsFromTerraformState(state, {
        connectionMode: "pooled",
        selectionMode: "pooled-only",
        caPath,
      }).map(({ contextName }) => contextName),
    ).toEqual(["control", "fulfillment"]);
  });

  it("fails closed when required state is missing", () => {
    expect(() => databaseUrlsFromTerraformState({ resources: [] }, { environmentName: "staging", caPath })).toThrow(
      "Staging Terraform state does not contain a usable DigitalOcean database cluster.",
    );
    expect(() =>
      databaseUrlsFromTerraformState(terraformState(), {
        contexts: ["settlement"],
        caPath,
      }),
    ).toThrow("Terraform state is missing database/user data for 'settlement'.");
    expect(() => managedPostgresClusterIdFromTerraformState({ resources: [] }, "staging")).toThrow(
      "Staging Terraform state does not contain a DigitalOcean database cluster ID.",
    );
  });

  it("parses CLI and environment options", () => {
    const options = parseTerraformStateDatabaseUrlArgs(
      [
        "--state",
        "state.json",
        "--contexts",
        "payments, settlement",
        "--selection-mode",
        "pooled-only",
        "--retry-attempts",
        "3",
        "--retry-backoff-ms",
        "250",
        "--failure-output",
        "failure.json",
      ],
      {
        GITHUB_ENV: "github.env",
        RUNNER_TEMP: "/runner/temp",
        DIGITALOCEAN_ACCESS_TOKEN: "token-value",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
    );

    expect(options).toMatchObject({
      mode: "url-export",
      statePath: "state.json",
      githubEnvPath: "github.env",
      caPath: join("/runner/temp", "digitalocean-managed-postgres-ca.pem"),
      digitalOceanToken: "token-value",
      environmentName: "production",
      contexts: ["payments", "settlement"],
      connectionMode: "direct",
      selectionMode: "pooled-only",
      selectionModeSpecified: true,
      retryAttempts: 3,
      retryBackoffMs: 250,
      failureOutputPath: "failure.json",
    });
    expect(parseTerraformStateDatabaseUrlArgs([], {}).selectionMode).toBe("all");
    expect(parseTerraformStateDatabaseUrlArgs(["--retry-attempts", "6"], {}).retryAttempts).toBe(1);
  });

  it("writes GitHub env output and masks every derived URL", async () => {
    const appended = [];
    const logs = [];
    const urls = await exportTerraformStateDatabaseUrls(
      {
        statePath: "state.json",
        githubEnvPath: "github.env",
        caPath,
        digitalOceanToken: "token-value",
        contexts: ["checkout"],
        environmentName: "staging",
      },
      {
        readFile: async () => JSON.stringify(terraformState()),
        appendFile: async (path, value) => appended.push({ path, value }),
        writeCa: async (path, value) => appended.push({ path, value }),
        fetch: async (url, options) => {
          expect(url).toBe("https://api.digitalocean.com/v2/databases/cluster-123/ca");
          expect(options.headers.Authorization).toBe("Bearer token-value");
          return {
            ok: true,
            status: 200,
            headers: { get: () => "application/json; charset=utf-8" },
            text: async () => JSON.stringify({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
          };
        },
        log: (line) => logs.push(line),
      },
    );

    expect(urls).toHaveLength(1);
    expect(logs).toEqual([
      "::add-mask::postgresql://checkout-user:pass%20word@db.example.internal:25060/checkout-db?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true",
    ]);
    expect(appended).toEqual([
      { path: caPath, value: certificate },
      {
        path: "github.env",
        value:
          `PGSSLROOTCERT=${caPath}\n` +
          "DATABASE_URL_CHECKOUT=postgresql://checkout-user:pass%20word@db.example.internal:25060/checkout-db?sslmode=verify-full&sslrootcert=%2Frunner%2Ftemp%2Fdigitalocean-managed-postgres-ca.pem&uselibpqcompat=true\n",
      },
    ]);
  });

  it("pooled context selection writes a bounded inventory before invalid selection and CA retrieval", async () => {
    const writes = [];
    let fetched = 0;
    await expect(
      exportTerraformStateDatabaseUrls(
        {
          statePath: "state.json",
          githubEnvPath: "github.env",
          caPath,
          digitalOceanToken: "token-value",
          contexts: ["reputation"],
          connectionMode: "pooled",
          selectionMode: "pooled-only",
          inventoryOutputPath: "inventory.json",
        },
        {
          readFile: async () => JSON.stringify(mixedPooledTerraformState()),
          writeFile: async (path, value) => writes.push({ path, value }),
          fetch: async () => {
            fetched += 1;
            throw new Error("must not fetch");
          },
          rm: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ classification: "managed-postgres-state-invalid", context: "reputation" });
    expect(fetched).toBe(0);
    const inventory = JSON.parse(writes[0].value);
    expect(inventory.contexts).toEqual(
      expect.arrayContaining([
        { context: "reputation", database: true, user: true, pool: false, poolMode: null },
        { context: "search", database: false, user: false, pool: true, poolMode: "session" },
      ]),
    );
    expect(writes[0].value).not.toContain("db.example.internal");
    expect(writes[0].value).not.toContain("pass word");
  });

  it("pooled invalid state no retry writes a bounded failure, inventory, and cleans up CA", async () => {
    const directory = await mkdtemp(join(tmpdir(), "managed-postgres-pooled-invalid-"));
    tempDirectories.push(directory);
    const statePath = join(directory, "state.json");
    const githubEnvPath = join(directory, "github.env");
    const caPathForTest = join(directory, "ca.pem");
    const failurePath = join(directory, "failure.json");
    const inventoryPath = join(directory, "inventory.json");
    await writeFile(statePath, JSON.stringify(mixedPooledTerraformState()));
    await writeFile(caPathForTest, "synthetic-ca");
    const stderr = [];
    const removals = [];
    let fetched = 0;

    await expect(
      main(
        [
          "--state",
          statePath,
          "--github-env",
          githubEnvPath,
          "--ca-path",
          caPathForTest,
          "--contexts",
          "reputation",
          "--connection-mode",
          "pooled",
          "--selection-mode",
          "pooled-only",
          "--retry-attempts",
          "3",
          "--failure-output",
          failurePath,
          "--inventory-output",
          inventoryPath,
        ],
        {
          DIGITALOCEAN_ACCESS_TOKEN: "synthetic-token",
          DEPLOYMENT_ENVIRONMENT: "production",
        },
        {
          fetch: async () => {
            fetched += 1;
            throw new Error("must not fetch");
          },
          rm: async (path, options) => {
            removals.push({ path, options });
            await rm(path, options);
          },
          errorLog: (line) => stderr.push(line),
        },
      ),
    ).resolves.toBe(1);

    expect(fetched).toBe(0);
    expect(stderr).toEqual(['{"classification":"managed-postgres-state-invalid","context":"reputation"}']);
    expect(JSON.parse(await readFile(failurePath, "utf8"))).toEqual({
      result: "failure",
      mode: "url-export",
      environment: "production",
      class: "managed-postgres-state-invalid",
      attempts: 0,
      context: "reputation",
    });
    expect(JSON.parse(await readFile(inventoryPath, "utf8"))).toEqual(
      expect.objectContaining({
        contexts: expect.arrayContaining([
          { context: "reputation", database: true, user: true, pool: false, poolMode: null },
          { context: "search", database: false, user: false, pool: true, poolMode: "session" },
        ]),
      }),
    );
    expect(removals).toEqual([{ path: caPathForTest, options: { force: true } }]);
    await expect(stat(githubEnvPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(caPathForTest)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retrieves only the authoritative CA and reports bounded provider failures", async () => {
    const networkError = await fetchDigitalOceanManagedPostgresCa(
      {
        clusterId: "cluster-123",
        digitalOceanToken: "token-value",
        retryAttempts: 2,
      },
      {
        fetch: async () => {
          const error = Object.assign(new TypeError("fetch failed"), {
            cause: Object.assign(new Error("connect"), { code: "ECONNRESET" }),
          });
          throw error;
        },
        sleep: async () => undefined,
      },
    ).catch((error) => error);
    expect(
      buildManagedPostgresAuthorityFailure({ mode: "url-export", environmentName: "production" }, networkError),
    ).toMatchObject({
      attempts: 2,
      code: "ECONNRESET",
    });

    await expect(
      fetchDigitalOceanManagedPostgresCa(
        { clusterId: "cluster-123", digitalOceanToken: "token-value" },
        {
          fetch: async () => ({
            ok: false,
            status: 403,
            text: async () => JSON.stringify({ secret: "provider-body-must-not-surface" }),
          }),
        },
      ),
    ).rejects.toMatchObject({ classification: "digitalocean-ca-request-rejected", status: 403 });

    await expect(
      fetchDigitalOceanManagedPostgresCa(
        { clusterId: "synthetic-cluster", digitalOceanToken: "synthetic-token" },
        {
          fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => "text/plain" },
            text: async () => JSON.stringify({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
          }),
        },
      ),
    ).rejects.toMatchObject({ classification: "digitalocean-ca-response-invalid", status: 200 });
  });

  it("fetch retry backoff retries transient CA failures with a fixed bound", async () => {
    const responses = [
      { ok: false, status: 429, text: async () => "{}" },
      { ok: false, status: 503, text: async () => "{}" },
      {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: async () => JSON.stringify({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
      },
    ];
    const delays = [];
    const result = await fetchDigitalOceanManagedPostgresCa(
      { clusterId: "cluster-123", digitalOceanToken: "token-value", retryAttempts: 3, retryBackoffMs: 250 },
      {
        fetch: async () => responses.shift(),
        sleep: async (delay) => delays.push(delay),
      },
    );

    expect(result).toBe(certificate);
    expect(delays).toEqual([250, 500]);
    expect(responses).toHaveLength(0);
  });

  it("provider failure classes retry only transient requests and never expose response data", async () => {
    const attempts = [];
    await expect(
      fetchDigitalOceanManagedPostgresCa(
        { clusterId: "cluster-123", digitalOceanToken: "token-value", retryAttempts: 2, retryBackoffMs: 1 },
        {
          fetch: async () => {
            attempts.push("network");
            const error = Object.assign(new TypeError("fetch failed"), {
              cause: Object.assign(new Error("connect"), { code: "ECONNRESET" }),
            });
            throw error;
          },
          sleep: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      classification: "digitalocean-ca-request-failed",
      failureClass: "transient",
      attempts: 2,
      code: "ECONNRESET",
    });
    expect(attempts).toHaveLength(2);

    let invalidAttempts = 0;
    await expect(
      fetchDigitalOceanManagedPostgresCa(
        { clusterId: "cluster-123", digitalOceanToken: "token-value", retryAttempts: 3 },
        {
          fetch: async () => {
            invalidAttempts += 1;
            return {
              ok: true,
              status: 200,
              headers: { get: () => "application/json" },
              text: async () => JSON.stringify({ secret: "token-and-certificate-must-not-surface" }),
            };
          },
        },
      ),
    ).rejects.toMatchObject({ classification: "digitalocean-ca-response-invalid", attempts: 1 });
    expect(invalidAttempts).toBe(1);

    let rejectedAttempts = 0;
    await expect(
      fetchDigitalOceanManagedPostgresCa(
        { clusterId: "cluster-123", digitalOceanToken: "token-value", retryAttempts: 3 },
        {
          fetch: async () => {
            rejectedAttempts += 1;
            return { ok: false, status: 403, text: async () => "secret body" };
          },
        },
      ),
    ).rejects.toMatchObject({ classification: "digitalocean-ca-request-rejected", status: 403, attempts: 1 });
    expect(rejectedAttempts).toBe(1);
  });

  it("failure artifact schema is support-safe and non-counting", () => {
    const error = Object.assign(new Error("url token body certificate"), {
      classification: "digitalocean-ca-request-transient",
      attempts: 3,
      status: 503,
      code: "EHOSTUNREACH",
      url: "https://secret.example",
    });
    const artifact = buildManagedPostgresAuthorityFailure(
      { mode: "url-export", environmentName: "production", retryAttempts: 3 },
      error,
    );

    expect(artifact).toEqual({
      result: "failure",
      mode: "url-export",
      environment: "production",
      class: "digitalocean-ca-request-transient",
      attempts: 3,
      status: 503,
      code: "EHOSTUNREACH",
    });
    expect(Object.keys(artifact)).not.toEqual(
      expect.arrayContaining(["count", "success", "url", "token", "body", "pem", "certificate"]),
    );
  });

  it("writes CA material with restrictive permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "managed-postgres-ca-"));
    tempDirectories.push(directory);
    const path = join(directory, "ca.pem");

    await writeManagedPostgresCa(path, certificate);

    expect(await readFile(path, "utf8")).toBe(certificate);
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("pooled failure cleanup and safe fields remove CA material when export cannot complete", async () => {
    const removals = [];

    await expect(
      exportTerraformStateDatabaseUrls(
        {
          statePath: "state.json",
          githubEnvPath: "github.env",
          caPath,
          digitalOceanToken: "token-value",
          contexts: ["checkout"],
          environmentName: "staging",
        },
        {
          readFile: async () => JSON.stringify(terraformState()),
          writeCa: async () => undefined,
          appendFile: async () => {
            throw new Error("provider-body-secret -----BEGIN CERTIFICATE-----");
          },
          rm: async (path, options) => removals.push({ path, options }),
          fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: async () => JSON.stringify({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
          }),
          log: () => undefined,
        },
      ),
    ).rejects.toThrow();

    expect(removals).toEqual([{ path: caPath, options: { force: true } }]);
  });

  it("cleans up and skips URL writes when CA export is exhausted", async () => {
    const removals = [];
    const writes = [];
    await expect(
      exportTerraformStateDatabaseUrls(
        {
          statePath: "state.json",
          githubEnvPath: "github.env",
          caPath,
          digitalOceanToken: "token-value",
          contexts: ["checkout"],
          environmentName: "staging",
          retryAttempts: 2,
          retryBackoffMs: 1,
        },
        {
          readFile: async () => JSON.stringify(terraformState()),
          writeCa: async () => writes.push("ca"),
          appendFile: async () => writes.push("env"),
          rm: async (path, options) => removals.push({ path, options }),
          fetch: async () => ({ ok: false, status: 503, text: async () => "provider body" }),
          sleep: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({
      classification: "digitalocean-ca-request-rejected",
      failureClass: "transient",
      attempts: 2,
      status: 503,
    });
    expect(writes).toEqual([]);
    expect(removals).toEqual([{ path: caPath, options: { force: true } }]);
  });

  it("reports actual CA request counts for no-request and downstream failures", async () => {
    const directory = await mkdtemp(join(tmpdir(), "managed-postgres-failure-"));
    tempDirectories.push(directory);
    const statePath = join(directory, "state.json");
    const envPath = join(directory, "github.env");
    const caPathForTest = join(directory, "ca.pem");
    const failurePath = join(directory, "failure.json");
    await writeFile(statePath, JSON.stringify({ resources: [] }));

    const noRequestExit = await main(
      [
        "--state",
        statePath,
        "--github-env",
        envPath,
        "--ca-path",
        caPathForTest,
        "--failure-output",
        failurePath,
        "--retry-attempts",
        "3",
      ],
      { DIGITALOCEAN_ACCESS_TOKEN: "synthetic-token" },
      { errorLog: () => undefined },
    );
    expect(noRequestExit).toBe(1);
    expect(JSON.parse(await readFile(failurePath, "utf8"))).toMatchObject({ attempts: 0 });

    await writeFile(
      statePath,
      JSON.stringify({
        resources: [
          {
            type: "digitalocean_database_cluster",
            name: "postgres",
            instances: [{ attributes: { id: "cluster-123" } }],
          },
        ],
      }),
    );
    let exhaustedRequests = 0;
    const exhaustedExit = await main(
      [
        "--state",
        statePath,
        "--github-env",
        envPath,
        "--ca-path",
        caPathForTest,
        "--failure-output",
        failurePath,
        "--retry-attempts",
        "3",
      ],
      { DIGITALOCEAN_ACCESS_TOKEN: "synthetic-token" },
      {
        fetch: async () => {
          exhaustedRequests += 1;
          return { ok: false, status: 503, text: async () => "provider body" };
        },
        sleep: async () => undefined,
        errorLog: () => undefined,
      },
    );
    expect(exhaustedExit).toBe(1);
    expect(exhaustedRequests).toBe(3);
    expect(JSON.parse(await readFile(failurePath, "utf8"))).toMatchObject({ attempts: 3, status: 503 });

    await writeFile(
      statePath,
      JSON.stringify({
        resources: [
          {
            type: "digitalocean_database_cluster",
            name: "postgres",
            instances: [{ attributes: { id: "cluster-123" } }],
          },
        ],
      }),
    );
    let requests = 0;
    await expect(
      exportTerraformStateDatabaseUrls(
        {
          statePath,
          githubEnvPath: envPath,
          caPath: caPathForTest,
          digitalOceanToken: "synthetic-token",
          retryAttempts: 3,
        },
        {
          readFile: async (path) => (path === statePath ? readFile(path, "utf8") : certificate),
          fetch: async () => {
            requests += 1;
            return {
              ok: true,
              status: 200,
              headers: { get: () => "application/json" },
              text: async () => JSON.stringify({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
            };
          },
          rm: async () => undefined,
        },
      ),
    ).rejects.toMatchObject({ classification: "managed-postgres-state-invalid", attempts: 1 });
    expect(requests).toBe(1);
  });

  it("serializes main failures to the artifact and redacts error messages from stderr", async () => {
    const directory = await mkdtemp(join(tmpdir(), "managed-postgres-main-"));
    tempDirectories.push(directory);
    const statePath = join(directory, "state.json");
    const failurePath = join(directory, "failure.json");
    await writeFile(statePath, JSON.stringify({ resources: [] }));
    const stderr = [];

    await expect(
      main(
        [
          "--state",
          statePath,
          "--github-env",
          join(directory, "github.env"),
          "--ca-path",
          join(directory, "ca.pem"),
          "--failure-output",
          failurePath,
        ],
        { DIGITALOCEAN_ACCESS_TOKEN: "synthetic-token" },
        { errorLog: (line) => stderr.push(line) },
      ),
    ).resolves.toBe(1);

    expect(JSON.parse(await readFile(failurePath, "utf8"))).toEqual({
      result: "failure",
      mode: "url-export",
      environment: "staging",
      class: "terraform-state-missing-cluster-id",
      attempts: 0,
    });
    expect(stderr).toEqual(['{"classification":"terraform-state-missing-cluster-id"}']);
  });

  it("keeps every shared-exporter workflow consumer behind the canonical byte-equivalent trust action", async () => {
    const expectedConsumers = [
      "catalog-completion-report.yml",
      "catalog-integration-staging-reset.yml",
      "catalog-provider-refresh-watch.yml",
      "checkout-order-readiness-trace.yml",
      "collections-anonymous-owner-redaction.yml",
      "collections-cutover-authority-capture.yml",
      "marketplace-provider-proof-status.yml",
      "platform-postgres-growth-evidence.yml",
      "platform-postgres-slow-query-digest.yml",
      "platform-production.yml",
      "platform-staging-admin-qa-actor-fixtures.yml",
      "platform-staging-evidence-window-cleanup.yml",
      "platform-staging-evidence-window.yml",
      "platform-staging-representative-commerce-state.yml",
      "platform-staging-wake-drills.yml",
    ];
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
    const workflows = await Promise.all(
      workflowNames.map(async (name) => ({ name, source: await readFile(new URL(name, workflowDirectory), "utf8") })),
    );
    const actionSource = await readFile(
      new URL("../.github/actions/export-managed-postgres-authority/action.yml", import.meta.url),
      "utf8",
    );
    const action = parseYaml(actionSource);
    const consumers = workflows
      .filter(({ source }) => source.includes("uses: ./.github/actions/export-managed-postgres-authority"))
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(consumers.map(({ name }) => name)).toEqual(expectedConsumers);
    const invocationCount = consumers.reduce(
      (count, { source }) =>
        count + (source.match(/uses: \.\/\.github\/actions\/export-managed-postgres-authority/g) ?? []).length,
      0,
    );
    expect(invocationCount).toBe(19);
    const expectedAuthorityCalls = [
      [
        "catalog-completion-report.yml",
        "completion-report",
        "Export catalog database URL and TLS trust",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "catalog-integration-staging-reset.yml",
        "catalog-integration-reset",
        "Export staging Catalog database URL and TLS trust",
        "url-export",
        "pooled",
        undefined,
      ],
      [
        "catalog-provider-refresh-watch.yml",
        "provider-refresh-watch",
        "Export catalog database URL and TLS trust",
        "url-export",
        "pooled",
        undefined,
      ],
      [
        "checkout-order-readiness-trace.yml",
        "staging-order-readiness-trace",
        "Export staging database URLs",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "collections-anonymous-owner-redaction.yml",
        "cutover",
        "Export Collections database authority",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "collections-cutover-authority-capture.yml",
        "capture",
        "Export Collections database authority",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "marketplace-provider-proof-status.yml",
        "provider-proof-status",
        "Export provider proof database URLs and TLS trust",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "platform-postgres-growth-evidence.yml",
        "growth-evidence",
        "Export database URLs and TLS trust",
        "url-export",
        "pooled",
        "pooled-only",
      ],
      [
        "platform-postgres-slow-query-digest.yml",
        "slow-query-digest",
        "Export database URLs and TLS trust",
        "url-export",
        "pooled",
        undefined,
      ],
      [
        "platform-production.yml",
        "reconcile-managed-postgres-ca-staging",
        "Reconcile day-after managed Postgres CA trust",
        "trust-only-kubernetes-secret",
        "direct",
        undefined,
      ],
      [
        "platform-production.yml",
        "reconcile-managed-postgres-ca-production",
        "Reconcile day-after managed Postgres CA trust",
        "trust-only-kubernetes-secret",
        "direct",
        undefined,
      ],
      [
        "platform-production.yml",
        "deploy-staging",
        "Reconcile staging managed Postgres CA trust",
        "trust-only-kubernetes-secret",
        "direct",
        undefined,
      ],
      [
        "platform-production.yml",
        "deploy-production",
        "Reconcile production managed Postgres CA trust",
        "trust-only-kubernetes-secret",
        "direct",
        undefined,
      ],
      [
        "platform-production.yml",
        "deploy-production",
        "Export production readiness database URLs",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "platform-staging-admin-qa-actor-fixtures.yml",
        "provision-admin-qa-actor-fixtures",
        "Export staging database URLs and TLS trust",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "platform-staging-evidence-window-cleanup.yml",
        "evidence-window-cleanup",
        "Export staging control database authority and TLS trust",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "platform-staging-evidence-window.yml",
        "staging-evidence-window",
        "Export staging control database authority and TLS trust",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "platform-staging-representative-commerce-state.yml",
        "refresh-representative-commerce-state",
        "Export staging database URLs and TLS trust",
        "url-export",
        "direct",
        undefined,
      ],
      [
        "platform-staging-wake-drills.yml",
        "staging-wake-drill",
        "Export staging database URLs and TLS trust",
        "url-export",
        "direct",
        undefined,
      ],
    ];
    const authorityCalls = consumers.flatMap(({ name, source }) => {
      const workflow = parseYaml(source);
      return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) =>
        (job.steps ?? [])
          .filter(({ uses }) => uses === "./.github/actions/export-managed-postgres-authority")
          .map((step) => ({ name, jobName, step, key: [name, jobName, step.name ?? step.id].join("|") })),
      );
    });
    expect(authorityCalls).toHaveLength(19);
    expect(authorityCalls.map(({ key }) => key).sort()).toEqual(
      expectedAuthorityCalls.map(([name, jobName, stepName]) => [name, jobName, stepName].join("|")).sort(),
    );
    for (const [
      name,
      jobName,
      stepName,
      expectedMode,
      expectedConnectionMode,
      expectedSelectionMode,
    ] of expectedAuthorityCalls) {
      const call = authorityCalls.find(({ key }) => key === [name, jobName, stepName].join("|"));
      expect(call.step.with?.mode ?? "url-export").toBe(expectedMode);
      expect(call.step.with?.["connection-mode"] ?? "direct").toBe(expectedConnectionMode);
      expect(call.step.with?.["selection-mode"]).toBe(expectedSelectionMode);
    }
    const growthSource = consumers.find(({ name }) => name === "platform-postgres-growth-evidence.yml").source;
    expect(growthSource).toContain('retry-attempts: "3"');
    expect(growthSource).toContain("connection-mode: pooled");
    for (const { name, source } of consumers) {
      if (name !== "platform-postgres-growth-evidence.yml") {
        expect(source).not.toContain("retry-attempts:");
        expect(source).not.toContain("retry-backoff-ms:");
      }
    }
    for (const { source } of consumers) {
      expect(source).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
      expect(source).toContain("Remove managed Postgres CA");
      expect(source).not.toContain("scripts/terraform-state-database-urls.mjs");
      expect(source).not.toContain("rejectUnauthorized: false");
      expect(source).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    }
    expect(actionSource).toContain("terraform state pull");
    expect(actionSource).toContain("node ../../../scripts/terraform-state-database-urls.mjs");
    expect(actionSource).toContain('--ca-path "$MANAGED_POSTGRES_CA_PATH"');
    expect(actionSource).toContain('--github-env "$GITHUB_ENV"');
    expect(actionSource).toContain("MANAGED_POSTGRES_CA_PATH: ${{ runner.temp }}/digitalocean-managed-postgres-ca.pem");
    expect(actionSource).toContain('--retry-attempts "$AUTHORITY_RETRY_ATTEMPTS"');
    expect(actionSource).toContain('--retry-backoff-ms "$AUTHORITY_RETRY_BACKOFF_MS"');
    expect(action.inputs["retry-attempts"].default).toBe("1");
    expect(action.inputs["retry-backoff-ms"].default).toBe("0");
    expect(action.inputs["failure-output-path"].default).toBe("");
    expect(action.inputs["inventory-output-path"].default).toBe("");
    expect(actionSource).toContain("AUTHORITY_SELECTION_MODE: ${{ inputs.selection-mode || 'all' }}");
    expect(actionSource).toContain('[ -n "$AUTHORITY_SELECTION_MODE" ]');
    expect(actionSource).toContain('--inventory-output "$AUTHORITY_INVENTORY_OUTPUT"');
    const growth = parseYaml(growthSource).jobs["growth-evidence"].steps.find(({ id }) => id === "export-authority");
    expect(growth.with["selection-mode"]).toBe("pooled-only");
    expect(growth.with["connection-mode"]).toBe("pooled");
    for (const { name, source } of consumers) {
      if (name !== "platform-postgres-growth-evidence.yml") {
        expect(source).not.toContain("selection-mode: pooled-only");
      }
    }
  });

  it("pre-query failure artifact flow opts only growth evidence into CA retry and retention", async () => {
    const growthSource = await readFile(
      new URL("../.github/workflows/platform-postgres-growth-evidence.yml", import.meta.url),
      "utf8",
    );
    const actionSource = await readFile(
      new URL("../.github/actions/export-managed-postgres-authority/action.yml", import.meta.url),
      "utf8",
    );
    expect(actionSource).toContain("retry-attempts:");
    expect(actionSource).toContain("retry-backoff-ms:");
    expect(actionSource).toContain("failure-output-path:");
    expect(growthSource).toContain("id: export-authority");
    expect(growthSource).toContain("continue-on-error: true");
    expect(growthSource).toContain('retry-attempts: "3"');
    expect(growthSource).toContain('retry-backoff-ms: "250"');
    expect(growthSource).toContain("postgres-growth-authority-export-failure.json");
    expect(growthSource).toContain("Gate Postgres growth on authority export");
    expect(growthSource).toContain("if: ${{ always() }}");
    const workflow = parseYaml(growthSource);
    const job = workflow.jobs["growth-evidence"];
    const steps = job.steps;
    const exportIndex = steps.findIndex(({ id }) => id === "export-authority");
    const gate = steps.find(({ name }) => name === "Gate Postgres growth on authority export");
    const growth = steps.find(({ id }) => id === "growth");
    const summary = steps.find(({ name }) => name === "Summarize Postgres growth evidence");
    const uploads = steps.filter(({ name }) => name?.startsWith("Upload Postgres growth"));
    expect(gate.if).toBe("${{ always() }}");
    expect(steps.indexOf(gate)).toBeGreaterThan(exportIndex);
    expect(gate.run).toMatch(/if \[ "\$EXPORT_OUTCOME" = "failure" \]; then[\s\S]*exit 1/);
    expect(gate.run).toContain('"attempts":0');
    expect(growth.if).toBeUndefined();
    expect(summary.if).toBe("${{ always() }}");
    expect(summary.run).toContain(
      "if (record.status !== undefined) console.log(`- Provider status: ${record.status}`);",
    );
    expect(summary.run).toContain("if (record.code !== undefined) console.log(`- Provider code: ${record.code}`);");
    expect(summary.run).toContain("if (record.context !== undefined) console.log(`- Context: ${record.context}`);");
    expect(uploads).toHaveLength(2);
    expect(uploads.every(({ if: condition }) => condition === "${{ always() }}")).toBe(true);
    expect(growthSource).toContain("if-no-files-found: ignore");
  });

  it("reconciles exact CA bytes once and removes the process-owned temporary file", async () => {
    const writes = [];
    const removals = [];
    const applications = [];
    const certificateBytes = Buffer.from(certificate, "utf8");
    const result = await reconcileManagedPostgresCaSecret(
      {
        mode: "trust-only-kubernetes-secret",
        statePath: "state.json",
        githubOutputPath: "github.output",
        caPath,
        digitalOceanToken: "synthetic-token",
        environmentName: "staging",
        namespace: "chase-sets-platform",
        kubectlPath: "C:/synthetic/kubectl-double.exe",
      },
      {
        readFile: async (path) => (path === "state.json" ? JSON.stringify(terraformState()) : certificateBytes),
        writeCa: async (_path, value) => expect(value).toBe(certificate),
        appendFile: async (path, value) => writes.push({ path, value }),
        rm: async (path, options) => removals.push({ path, options }),
        applyManagedPostgresCaSecret: async (options) => applications.push(options),
        fetch: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: async () => JSON.stringify({ ca: { certificate: certificateBytes.toString("base64") } }),
        }),
      },
    );
    const digest = createHash("sha256").update(certificateBytes).digest("hex");

    expect(result).toEqual({ digest });
    expect(applications).toEqual([
      {
        namespace: "chase-sets-platform",
        certificate: certificateBytes,
        kubectlPath: "C:/synthetic/kubectl-double.exe",
        spawn: undefined,
      },
    ]);
    expect(writes).toEqual([{ path: "github.output", value: `managed-postgres-ca-sha256=${digest}\n` }]);
    expect(removals).toEqual([{ path: caPath, options: { force: true } }]);
  });

  it("refuses URL-export inputs in trust-only mode before provider or Secret mutation", async () => {
    let fetched = 0;
    let applied = 0;
    await expect(
      reconcileManagedPostgresCaSecret(
        {
          mode: "trust-only-kubernetes-secret",
          contextsSpecified: true,
          connectionModeSpecified: false,
          statePath: "state.json",
          githubOutputPath: "github.output",
          caPath,
          digitalOceanToken: "synthetic-token",
          environmentName: "staging",
          namespace: "chase-sets-platform",
          kubectlPath: "C:/synthetic/kubectl-double.exe",
        },
        {
          fetch: async () => {
            fetched += 1;
          },
          applyManagedPostgresCaSecret: async () => {
            applied += 1;
          },
        },
      ),
    ).rejects.toMatchObject({ classification: "managed-postgres-trust-only-input-invalid" });
    expect({ fetched, applied }).toEqual({ fetched: 0, applied: 0 });
  });

  it("fails closed when trust-only cleanup cannot remove its process-owned CA file", async () => {
    const certificateBytes = Buffer.from(certificate, "utf8");
    await expect(
      reconcileManagedPostgresCaSecret(
        {
          mode: "trust-only-kubernetes-secret",
          statePath: "state.json",
          githubOutputPath: "github.output",
          caPath,
          digitalOceanToken: "synthetic-token",
          environmentName: "production",
          namespace: "chase-sets-platform",
          kubectlPath: "C:/synthetic/kubectl-double.exe",
        },
        {
          readFile: async (path) => (path === "state.json" ? JSON.stringify(terraformState()) : certificateBytes),
          writeCa: async () => undefined,
          appendFile: async () => undefined,
          applyManagedPostgresCaSecret: async () => undefined,
          rm: async () => {
            throw Object.assign(new Error("synthetic cleanup refusal"), { code: "EPERM" });
          },
          fetch: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => "application/json" },
            text: async () => JSON.stringify({ ca: { certificate: certificateBytes.toString("base64") } }),
          }),
        },
      ),
    ).rejects.toMatchObject({ classification: "managed-postgres-ca-cleanup-failed", code: "EPERM" });
  });
});
