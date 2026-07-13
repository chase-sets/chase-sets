import { describe, expect, it, vi } from "vitest";
import {
  listCatalogScopeSyncState,
  readCatalogScopeSyncUnitState,
  upsertCatalogScopeSyncUnitState,
  type CatalogScopeSyncUnitStateUpsertInput,
} from "./queries";

function upsertInput(
  overrides: Partial<CatalogScopeSyncUnitStateUpsertInput> = {},
): CatalogScopeSyncUnitStateUpsertInput {
  return {
    scopeKey: "scope_1",
    providerKey: "tcgdex",
    unitKey: "tcgdex:trading-card:single-card:pokemon-card-import",
    productDomain: "trading-card",
    productForm: "single-card",
    languageCode: "en",
    referenceKind: "expansion",
    referenceId: "sv4-5",
    referenceName: "Paldean Fates",
    displayName: "tcgdex Pokemon card import",
    role: "primary-source-observation",
    requirement: "required",
    childExecutionScope: { provider: "tcgdex", setId: "sv4-5" },
    status: "queued",
    syncRunId: "job_run_1",
    jobId: "job_child_1",
    operatorStatus: "queued",
    errorMessage: null,
    updatedAt: "2026-07-13T00:00:00.000Z",
    ...overrides,
  };
}

describe("upsertCatalogScopeSyncUnitState", () => {
  it("derives state from the observed status and upserts by (scope, provider, unit)", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));

    await upsertCatalogScopeSyncUnitState({ query }, upsertInput({ status: "completed" }));

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain("INSERT INTO catalog_scope_sync_state");
    expect(sql).toContain("ON CONFLICT (scope_key, provider_key, unit_key) DO UPDATE");
    expect(params?.[0]).toBe("scope_1");
    expect(params?.[1]).toBe("tcgdex");
    expect(params?.[13]).toBe("settled");
  });

  it("maps a failed provider unit to the failed state", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));

    await upsertCatalogScopeSyncUnitState({ query }, upsertInput({ status: "failed", errorMessage: "boom" }));

    const params = query.mock.calls[0]?.[1];
    expect(params?.[13]).toBe("failed");
    expect(params?.[21]).toBe("boom");
  });

  it("passes null for omitted counters so the SQL COALESCE preserves prior values", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));

    await upsertCatalogScopeSyncUnitState({ query }, upsertInput({ status: "running" }));

    const params = query.mock.calls[0]?.[1];
    expect(params?.[17]).toBeNull();
    expect(params?.[18]).toBeNull();
  });
});

describe("listCatalogScopeSyncState", () => {
  it("lists every provider unit's durable state for a scope, ordered by provider/unit", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ scope_key: "scope_1", provider_key: "tcgdex", unit_key: "unit_1", state: "settled" }],
    }));

    const rows = await listCatalogScopeSyncState({ query }, "scope_1");

    expect(rows).toHaveLength(1);
    expect(String(query.mock.calls[0]?.[0])).toContain("WHERE scope_key = $1");
    expect(query.mock.calls[0]?.[1]).toEqual(["scope_1"]);
  });
});

describe("readCatalogScopeSyncUnitState", () => {
  it("reads a single provider unit's durable state", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [{ scope_key: "scope_1", provider_key: "tcgdex", unit_key: "unit_1", state: "settled" }],
    }));

    const row = await readCatalogScopeSyncUnitState(
      { query },
      { scopeKey: "scope_1", providerKey: "tcgdex", unitKey: "unit_1" },
    );

    expect(row?.state).toBe("settled");
    expect(query.mock.calls[0]?.[1]).toEqual(["scope_1", "tcgdex", "unit_1"]);
  });

  it("returns null when no durable state exists yet (never-synced)", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));

    const row = await readCatalogScopeSyncUnitState(
      { query },
      { scopeKey: "scope_1", providerKey: "tcgdex", unitKey: "unit_1" },
    );

    expect(row).toBeNull();
  });
});
