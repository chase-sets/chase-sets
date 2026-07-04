import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { closeContextPools, createContextPools } from "./context-pools";

const testContextRegistry = {
  contextNames: ["auth", "catalog", "payments"] as const,
  getContextDatabaseEnvName: (contextName: "auth" | "catalog" | "payments") =>
    `DATABASE_URL_${contextName.toUpperCase()}`,
};

describe("context pools", () => {
  it("reuses one pool when every context falls back to DATABASE_URL", async () => {
    const pools = createContextPools(testContextRegistry, {
      sharedDatabaseUrl: "postgresql://localhost/chase_sets",
      controlDatabaseUrl: "postgresql://localhost/chase_sets",
      contextDatabaseUrls: {},
    });

    try {
      expect(pools.auth).toBe(pools.catalog);
      expect(pools.catalog).toBe(pools.payments);
      expect(pools.control).toBe(pools.auth);
      expect(pools.workSignal).toBe(pools.control);
      expect(pools.contextWaiters.auth).toBe(pools.auth);
      expect(pools.contextWaiters.catalog).toBe(pools.catalog);
    } finally {
      await closeContextPools(pools);
    }
  });

  it("supports mixed per-context pools and a shared control pool", async () => {
    const pools = createContextPools(testContextRegistry, {
      sharedDatabaseUrl: "postgresql://localhost/shared",
      controlDatabaseUrl: "postgresql://localhost/control",
      contextDatabaseUrls: {
        auth: "postgresql://localhost/auth",
        payments: "postgresql://localhost/payments",
      },
    });

    try {
      expect(pools.auth).not.toBe(pools.catalog);
      expect(pools.payments).not.toBe(pools.catalog);
      expect(pools.control).not.toBe(pools.catalog);
      expect(pools.workSignal).toBe(pools.control);
      expect(pools.contextWaiters.auth).toBe(pools.auth);
      expect(pools.contextWaiters.catalog).toBe(pools.catalog);
      expect(pools.auth).not.toBe(pools.payments);
    } finally {
      await closeContextPools(pools);
    }
  });

  it("merges runtime pool overrides over registry defaults", async () => {
    const pools = createContextPools(
      {
        ...testContextRegistry,
        defaultPool: {
          max: 10,
          idleTimeoutMillis: 30_000,
          idleInTransactionSessionTimeoutMillis: 15_000,
          connectionTimeoutMillis: 5_000,
        },
      },
      {
        sharedDatabaseUrl: "postgresql://localhost/shared",
        controlDatabaseUrl: "postgresql://localhost/control",
        contextDatabaseUrls: {},
        pool: {
          max: 3,
          idleInTransactionSessionTimeoutMillis: undefined,
        },
      },
    );

    try {
      const poolOptions = pools.auth as unknown as {
        emit: (event: string, client: unknown) => boolean;
        options: {
          max?: number;
          idleTimeoutMillis?: number;
          idle_in_transaction_session_timeout?: number;
          options?: string;
          connectionTimeoutMillis?: number;
        };
      };

      expect(poolOptions.options.max).toBe(3);
      expect(poolOptions.options.idleTimeoutMillis).toBe(30_000);
      expect(poolOptions.options.idle_in_transaction_session_timeout).toBeUndefined();
      expect(poolOptions.options.options).toBeUndefined();
      expect(poolOptions.options.connectionTimeoutMillis).toBe(5_000);

      const client = createFakeClient();
      poolOptions.emit("connect", client);
      await vi.waitFor(() =>
        expect(client.query).toHaveBeenCalledWith(
          "SELECT set_config('idle_in_transaction_session_timeout', $1, false)",
          ["15000ms"],
        ),
      );
    } finally {
      await closeContextPools(pools);
    }
  });

  it("uses a separate work-signal pool when a direct waiter URL is configured", async () => {
    const pools = createContextPools(testContextRegistry, {
      sharedDatabaseUrl: "postgresql://localhost/shared",
      controlDatabaseUrl: "postgresql://localhost/control-pooled",
      workSignalDatabaseUrl: "postgresql://localhost/control-direct",
      contextDatabaseUrls: {},
    });

    try {
      expect(pools.control).not.toBe(pools.workSignal);
      expect(pools.workSignal).not.toBe(pools.auth);
    } finally {
      await closeContextPools(pools);
    }
  });

  it("uses separate context waiter pools when direct waiter URLs are configured", async () => {
    const pools = createContextPools(testContextRegistry, {
      sharedDatabaseUrl: "postgresql://localhost/shared-pooled",
      controlDatabaseUrl: "postgresql://localhost/control-pooled",
      contextDatabaseUrls: {
        catalog: "postgresql://localhost/catalog-pooled",
      },
      contextWaiterDatabaseUrls: {
        catalog: "postgresql://localhost/catalog-direct",
      },
    });

    try {
      expect(pools.catalog).not.toBe(pools.contextWaiters.catalog);
      expect(pools.contextWaiters.auth).toBe(pools.auth);
      expect(pools.contextWaiters.payments).toBe(pools.payments);
    } finally {
      await closeContextPools(pools);
    }
  });

  it("supports deployable-specific control database fallback", async () => {
    const pools = createContextPools(
      {
        ...testContextRegistry,
        resolveControlDatabaseUrl: ({ contextNames, resolveContextDatabaseUrl }) =>
          resolveContextDatabaseUrl(contextNames[0]),
      },
      {
        sharedDatabaseUrl: null,
        contextDatabaseUrls: {
          auth: "postgresql://localhost/auth",
          catalog: "postgresql://localhost/catalog",
          payments: "postgresql://localhost/payments",
        },
      },
    );

    try {
      expect(pools.control).toBe(pools.auth);
      expect(pools.catalog).not.toBe(pools.auth);
    } finally {
      await closeContextPools(pools);
    }
  });

  it("reports the context-specific environment variable when a URL is missing", () => {
    expect(() =>
      createContextPools(testContextRegistry, {
        sharedDatabaseUrl: null,
        controlDatabaseUrl: "postgresql://localhost/control",
        contextDatabaseUrls: {
          auth: "postgresql://localhost/auth",
        },
      }),
    ).toThrow("Missing database URL for context 'catalog'. Set DATABASE_URL_CATALOG or DATABASE_URL.");
  });
});

function createFakeClient(): EventEmitter & { query: ReturnType<typeof vi.fn> } {
  const client = new EventEmitter() as EventEmitter & { query: ReturnType<typeof vi.fn> };
  client.query = vi.fn(async () => undefined);
  return client;
}
