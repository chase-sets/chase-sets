import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  databaseUrlsFromTerraformState,
  exportTerraformStateDatabaseUrls,
  fetchDigitalOceanManagedPostgresCa,
  githubEnvLinesForDatabaseUrls,
  managedPostgresClusterIdFromTerraformState,
  parseTerraformStateDatabaseUrlArgs,
  writeManagedPostgresCa,
} from "./terraform-state-database-urls.mjs";

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
      ["--state", "state.json", "--contexts", "payments, settlement"],
      {
        GITHUB_ENV: "github.env",
        RUNNER_TEMP: "/runner/temp",
        DIGITALOCEAN_ACCESS_TOKEN: "token-value",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
    );

    expect(options).toEqual({
      statePath: "state.json",
      githubEnvPath: "github.env",
      caPath: join("/runner/temp", "digitalocean-managed-postgres-ca.pem"),
      digitalOceanToken: "token-value",
      environmentName: "production",
      contexts: ["payments", "settlement"],
      connectionMode: "direct",
    });
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
            json: async () => ({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
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

  it("retrieves only the authoritative CA and reports bounded provider failures", async () => {
    await expect(
      fetchDigitalOceanManagedPostgresCa(
        { clusterId: "cluster-123", digitalOceanToken: "token-value" },
        {
          fetch: async () => ({
            ok: false,
            status: 403,
            json: async () => ({ secret: "provider-body-must-not-surface" }),
          }),
        },
      ),
    ).rejects.toMatchObject({ classification: "digitalocean-ca-request-rejected", status: 403 });
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

  it("removes CA material when the environment export cannot complete", async () => {
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
            json: async () => ({ ca: { certificate: Buffer.from(certificate).toString("base64") } }),
          }),
          log: () => undefined,
        },
      ),
    ).rejects.toThrow();

    expect(removals).toEqual([{ path: caPath, options: { force: true } }]);
  });

  it("keeps all eight workflow consumers on the explicit trust contract", async () => {
    const expectedConsumers = [
      "catalog-integration-staging-reset.yml",
      "catalog-provider-refresh-watch.yml",
      "marketplace-provider-proof-status.yml",
      "platform-postgres-growth-evidence.yml",
      "platform-postgres-slow-query-digest.yml",
      "platform-staging-admin-qa-actor-fixtures.yml",
      "platform-staging-representative-commerce-state.yml",
      "platform-staging-wake-drills.yml",
    ];
    const workflowDirectory = new URL("../.github/workflows/", import.meta.url);
    const workflowNames = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
    const workflows = await Promise.all(
      workflowNames.map(async (name) => ({ name, source: await readFile(new URL(name, workflowDirectory), "utf8") })),
    );
    const consumers = workflows
      .filter(({ source }) => source.includes("scripts/terraform-state-database-urls.mjs"))
      .sort((left, right) => left.name.localeCompare(right.name));

    expect(consumers.map(({ name }) => name)).toEqual(expectedConsumers);
    for (const { source } of consumers) {
      expect(source).toContain("DIGITALOCEAN_ACCESS_TOKEN: ${{ secrets.DIGITALOCEAN_ACCESS_TOKEN }}");
      expect(source).toContain("MANAGED_POSTGRES_CA_PATH: ${{ runner.temp }}/digitalocean-managed-postgres-ca.pem");
      expect(source).toContain('--ca-path "$MANAGED_POSTGRES_CA_PATH"');
      expect(source).toContain("Remove managed Postgres CA");
      expect(source).not.toContain("rejectUnauthorized: false");
      expect(source).not.toContain("NODE_TLS_REJECT_UNAUTHORIZED");
    }
  });
});
