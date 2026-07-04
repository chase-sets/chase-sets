import { describe, expect, it } from "vitest";
import { closePlatformWorkerPools, createPlatformWorkerPools } from "../src/database-pools";
import type { PlatformWorkerConfig } from "../src/config";

describe("platform worker database pools", () => {
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
        pools.control as unknown as { options: { idle_in_transaction_session_timeout?: number; options?: string } }
      ).options;

      expect(options.idle_in_transaction_session_timeout).toBeUndefined();
      expect(options.options).toBe("-c idle_in_transaction_session_timeout=15000");
    } finally {
      await closePlatformWorkerPools(pools);
    }
  });
});
