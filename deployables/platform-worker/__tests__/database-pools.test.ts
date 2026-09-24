import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import {
  closePlatformWorkerPools,
  createPlatformWorkerPools,
  selectSettlementBootstrapDatabaseUrl,
} from "../src/database-pools";
import type { PlatformWorkerConfig } from "../src/config";

describe("platform worker database pools", () => {
  it.each([
    ["staging", "postgresql://localhost:25061/pooled", "postgresql://localhost:25060/direct"],
    ["production", "postgresql://localhost:25061/pooled", "postgresql://localhost:25060/direct"],
    ["preview", "postgresql://localhost:25061/pooled", "postgresql://localhost:5432/direct"],
    ["dev", "postgresql://localhost:5432/local", "postgresql://localhost:5432/direct"],
  ])(
    "selects the direct Settlement bootstrap URL in %s without changing the query URL",
    (environment, queryUrl, directUrl) => {
      const config = {
        contextDatabaseUrls: { settlement: queryUrl },
        sharedDatabaseUrl: null,
      } as unknown as PlatformWorkerConfig;
      expect(
        selectSettlementBootstrapDatabaseUrl(config, {
          DEPLOYMENT_ENVIRONMENT: environment,
          BOOTSTRAP_DATABASE_URL_SETTLEMENT: directUrl,
        }),
      ).toBe(directUrl);
      expect(config.contextDatabaseUrls.settlement).toBe(queryUrl);
    },
  );

  it.each([
    ["staging", "postgresql://localhost:25061/pooled"],
    ["production", "postgresql://localhost:25062/unknown"],
    ["preview", "postgresql://localhost:25061/pooled"],
    ["dev", "not a URL"],
    ["dev", "https://localhost:5432/not-postgres"],
  ])("refuses a non-direct Settlement bootstrap URL in %s without exposing it", (environment, queryUrl) => {
    const config = {
      contextDatabaseUrls: { settlement: queryUrl },
      sharedDatabaseUrl: null,
    } as unknown as PlatformWorkerConfig;
    try {
      selectSettlementBootstrapDatabaseUrl(config, { DEPLOYMENT_ENVIRONMENT: environment });
      throw new Error("Expected a direct-URL rejection.");
    } catch (error) {
      expect(error).toMatchObject({ code: "WORKER_SETTLEMENT_DIRECT_DATABASE_URL_REQUIRED" });
      expect(String(error)).not.toContain(queryUrl);
    }
  });

  it("refuses a missing Settlement URL before opening a pool", () => {
    expect(() =>
      selectSettlementBootstrapDatabaseUrl(
        {
          contextDatabaseUrls: {},
          sharedDatabaseUrl: null,
        } as unknown as PlatformWorkerConfig,
        { DEPLOYMENT_ENVIRONMENT: "dev" },
      ),
    ).toThrow("WORKER_SETTLEMENT_DIRECT_DATABASE_URL_REQUIRED");
  });

  it("sets an idle-in-transaction guardrail on context pools", async () => {
    const pools = createPlatformWorkerPools({
      runtimeProfile: "landing",
      sharedDatabaseUrl: "postgresql://localhost/shared",
      controlDatabaseUrl: "postgresql://localhost/control",
      workSignalDatabaseUrl: "postgresql://localhost/work-signal",
      contextDatabaseUrls: {},
      pool: {
        max: 3,
        idleTimeoutMillis: 30_000,
        connectionTimeoutMillis: 5_000,
      },
    } as unknown as PlatformWorkerConfig);

    try {
      const options = (
        pools.control as unknown as {
          options: {
            idle_in_transaction_session_timeout?: number;
            options?: string;
            onConnect: (client: unknown) => Promise<void>;
          };
        }
      ).options;

      expect(options.idle_in_transaction_session_timeout).toBeUndefined();
      expect(options.options).toBeUndefined();
      const client = createFakeClient();
      await options.onConnect(client);
      expect(client.query).toHaveBeenCalledWith("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
        "15000ms",
      ]);
    } finally {
      await closePlatformWorkerPools(pools);
    }
  });
});

function createFakeClient(): EventEmitter & { query: ReturnType<typeof vi.fn> } {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn> };
  client.query = vi.fn(async () => undefined);
  return client;
}
