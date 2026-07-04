import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
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
        pools.control as unknown as {
          emit: (event: string, client: unknown) => boolean;
          options: { idle_in_transaction_session_timeout?: number; options?: string };
        }
      ).options;

      expect(options.idle_in_transaction_session_timeout).toBeUndefined();
      expect(options.options).toBeUndefined();
      const client = createFakeClient();
      (pools.control as unknown as { emit: (event: string, client: unknown) => boolean }).emit("connect", client);
      await vi.waitFor(() =>
        expect(client.query).toHaveBeenCalledWith(
          "SELECT set_config('idle_in_transaction_session_timeout', $1, false)",
          ["15000ms"],
        ),
      );
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
