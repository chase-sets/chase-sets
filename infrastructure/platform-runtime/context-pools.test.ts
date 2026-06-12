import { describe, expect, it } from "vitest";
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
      expect(pools.auth).not.toBe(pools.payments);
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
