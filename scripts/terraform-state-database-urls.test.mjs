import { describe, expect, it } from "vitest";
import {
  databaseUrlsFromTerraformState,
  exportTerraformStateDatabaseUrls,
  githubEnvLinesForDatabaseUrls,
  parseTerraformStateDatabaseUrlArgs,
} from "./terraform-state-database-urls.mjs";

function terraformState() {
  return {
    resources: [
      {
        type: "digitalocean_database_cluster",
        name: "postgres",
        instances: [{ attributes: { host: "db.example.internal", port: 25060 } }],
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
    const urls = databaseUrlsFromTerraformState(terraformState(), { environmentName: "staging" });

    expect(githubEnvLinesForDatabaseUrls(urls)).toEqual([
      "DATABASE_URL_CHECKOUT=postgresql://checkout-user:pass%20word@db.example.internal:25060/checkout-db?sslmode=require",
      "PLATFORM_CONTROL_DATABASE_URL=postgresql://control-user:control%2Fpass@db.example.internal:25060/control-db?sslmode=require",
      "DATABASE_URL_FULFILLMENT=postgresql://fulfillment-user:fulfillment-pass@db.example.internal:25060/fulfillment-db?sslmode=require",
    ]);
  });

  it("supports a required-context subset for provider proof workflows", () => {
    const urls = databaseUrlsFromTerraformState(terraformState(), {
      contexts: ["fulfillment", "checkout"],
      environmentName: "production",
    });

    expect(urls.map(({ envName }) => envName)).toEqual(["DATABASE_URL_FULFILLMENT", "DATABASE_URL_CHECKOUT"]);
  });

  it("derives DOKS query URLs from transaction pool state when requested", () => {
    const urls = databaseUrlsFromTerraformState(pooledTerraformState(), {
      connectionMode: "pooled",
      environmentName: "staging",
    });

    expect(githubEnvLinesForDatabaseUrls(urls)).toEqual([
      "DATABASE_URL_CHECKOUT=postgresql://checkout-user:pass%20word@pool.example.internal:25061/checkout-runtime?sslmode=require",
      "PLATFORM_CONTROL_DATABASE_URL=postgresql://control-user:control%2Fpass@pool.example.internal:25061/control-runtime?sslmode=require",
      "DATABASE_URL_FULFILLMENT=postgresql://fulfillment-user:fulfillment-pass@pool.example.internal:25061/fulfillment-runtime?sslmode=require",
    ]);
  });

  it("fails closed when required state is missing", () => {
    expect(() => databaseUrlsFromTerraformState({ resources: [] }, { environmentName: "staging" })).toThrow(
      "Staging Terraform state does not contain a usable DigitalOcean database cluster.",
    );
    expect(() =>
      databaseUrlsFromTerraformState(terraformState(), {
        contexts: ["settlement"],
      }),
    ).toThrow("Terraform state is missing database/user data for 'settlement'.");
  });

  it("parses CLI and environment options", () => {
    const options = parseTerraformStateDatabaseUrlArgs(
      ["--state", "state.json", "--contexts", "payments, settlement"],
      {
        GITHUB_ENV: "github.env",
        DEPLOYMENT_ENVIRONMENT: "production",
      },
    );

    expect(options).toEqual({
      statePath: "state.json",
      githubEnvPath: "github.env",
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
        contexts: ["checkout"],
        environmentName: "staging",
      },
      {
        readFile: async () => JSON.stringify(terraformState()),
        appendFile: async (path, value) => appended.push({ path, value }),
        log: (line) => logs.push(line),
      },
    );

    expect(urls).toHaveLength(1);
    expect(logs).toEqual([
      "::add-mask::postgresql://checkout-user:pass%20word@db.example.internal:25060/checkout-db?sslmode=require",
    ]);
    expect(appended).toEqual([
      {
        path: "github.env",
        value:
          "DATABASE_URL_CHECKOUT=postgresql://checkout-user:pass%20word@db.example.internal:25060/checkout-db?sslmode=require\n",
      },
    ]);
  });
});
