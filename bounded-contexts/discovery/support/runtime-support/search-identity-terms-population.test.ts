import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createPostgresPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { rebuildDiscoverySearchIndex } from "../../features/search/read-model/projection";
import {
  populateDiscoverySearchIdentityTerms,
  verifyDiscoverySearchIdentityTerms,
} from "./search-identity-terms-population";

vi.mock("../../features/search/read-model/projection", async (original) => ({
  ...(await original<typeof import("../../features/search/read-model/projection")>()),
  rebuildDiscoverySearchIndex: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(rebuildDiscoverySearchIndex).mockReset();
});

function fixture() {
  const sql: string[] = [];
  const query = vi.fn(async (text: string) => {
    sql.push(text);
    if (text.includes("current_user"))
      return {
        rows: [{ database_role: "discovery", extension_version: "1.6", migration_applied: true, index_valid: true }],
      };
    return { rows: [] };
  });
  const db: PgQueryable = { query: async <Row>(text: string) => ({ rows: (await query(text)).rows as Row[] }) };
  const release = vi.fn();
  const pool = { ...db, connect: vi.fn(async () => ({ ...db, release })) };
  const controlPlane = createPostgresPlatformControlPlane(pool);
  const acquire = vi
    .spyOn(controlPlane, "acquireLease")
    .mockImplementation(async (input) => ({ ...input, fencingToken: "17", expiresAt: "2099-01-01T00:00:00Z" }));
  const renew = vi.spyOn(controlPlane, "renewLease").mockResolvedValue(true);
  const relinquish = vi.spyOn(controlPlane, "releaseLease").mockResolvedValue();
  const input = {
    pool,
    controlPlane,
    ownerId: "population-test",
    writerSha: "a".repeat(40),
    environment: "local" as const,
    authorization: "synthetic-test",
  };
  return { input, db, sql, query, acquire, renew, relinquish, release };
}

describe("identity-term population transaction", () => {
  it("uses the scheduled writer's lease, commits before receipt and preserves checkpoints", async () => {
    const f = fixture();
    const receipt = await populateDiscoverySearchIdentityTerms(f.input);
    expect(f.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ leaseName: "projection-group:discovery.discovery-search-item-projection" }),
    );
    expect(f.sql.at(-1)).toBe("COMMIT");
    expect(f.renew).toHaveBeenCalledOnce();
    expect(f.relinquish).toHaveBeenCalledOnce();
    expect(receipt).toMatchObject({
      pairedCutover: true,
      checkpointsUnchanged: true,
      lease: { fencingToken: "17" },
      verification: { items: 0, terms: 0, setEquality: true },
    });
    expect(f.sql.filter((sql) => /UPDATE|DELETE|INSERT/.test(sql))).toEqual([]);
  });

  it("does not connect or build while a same-group writer holds the lease", async () => {
    const f = fixture();
    f.acquire.mockResolvedValue(null);
    await expect(populateDiscoverySearchIdentityTerms(f.input)).rejects.toThrow("did not execute");
    expect(f.input.pool.connect).not.toHaveBeenCalled();
    expect(rebuildDiscoverySearchIndex).not.toHaveBeenCalled();
  });

  it("rolls back a build interruption and a failed final fence instead of emitting a receipt", async () => {
    const f = fixture();
    vi.mocked(rebuildDiscoverySearchIndex).mockRejectedValueOnce(new Error("interrupted shadow"));
    await expect(populateDiscoverySearchIdentityTerms(f.input)).rejects.toThrow("interrupted shadow");
    expect(f.sql.at(-1)).toBe("ROLLBACK");
    f.renew.mockResolvedValue(false);
    await expect(populateDiscoverySearchIdentityTerms(f.input)).rejects.toThrow("before population commit");
    expect(f.sql).not.toContain("COMMIT");
    expect(f.relinquish).toHaveBeenCalledTimes(2);
  });

  it("checks lease loss during the build around database statements", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture();
      f.renew.mockResolvedValue(false);
      vi.mocked(rebuildDiscoverySearchIndex).mockImplementationOnce(async (db) => {
        await vi.advanceTimersByTimeAsync(5_000);
        await db.query("SELECT forbidden_after_lease_loss");
      });
      await expect(populateDiscoverySearchIdentityTerms(f.input)).rejects.toThrow("Lost lease");
      expect(f.sql).not.toContain("SELECT forbidden_after_lease_loss");
      expect(f.sql.at(-1)).toBe("ROLLBACK");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rolls back failed capability, set equality and checkpoint checks", async () => {
    for (const failure of ["capability", "terms", "checkpoints"]) {
      const f = fixture();
      const original = f.query.getMockImplementation()!;
      let reads = 0;
      f.query.mockImplementation(async (text) => {
        if (failure === "capability" && text.includes("current_user")) return { rows: [] };
        if (failure === "terms" && text.includes("ARRAY(SELECT term")) throw new Error("set equality failed");
        if (failure === "checkpoints" && text.includes("event_subscription_checkpoints") && ++reads === 2)
          throw new Error("checkpoint changed");
        return original(text);
      });
      await expect(populateDiscoverySearchIdentityTerms(f.input)).rejects.toThrow();
      expect(f.sql.at(-1)).toBe("ROLLBACK");
    }
  });
});

describe("complete identity-term set equality", () => {
  it.each([{ terms: ["charizard"] }, { terms: ["charizard", "unexpected"] }, { terms: [] }])(
    "rejects missing or extra terms: $terms",
    async ({ terms }) => {
      const db: PgQueryable = {
        query: async <Row>() => ({
          rows: [
            {
              catalog_item_id: "card",
              title: "Charizard Base",
              subtitle: null,
              status: "active",
              resolved_aliases: {},
              terms,
            },
          ] as Row[],
        }),
      };
      await expect(verifyDiscoverySearchIdentityTerms(db)).rejects.toThrow("set equality");
    },
  );
  it("checks empty sets and rejects orphaned terms", async () => {
    const db: PgQueryable = {
      query: async <Row>(sql: string) => ({
        rows: (sql.includes("ARRAY(SELECT term")
          ? [
              {
                catalog_item_id: "card",
                title: "東京",
                subtitle: null,
                status: "active",
                resolved_aliases: {},
                terms: [],
              },
            ]
          : [{ catalog_item_id: "orphan" }]) as Row[],
      }),
    };
    await expect(verifyDiscoverySearchIdentityTerms(db)).rejects.toThrow("orphaned");
  });
});
