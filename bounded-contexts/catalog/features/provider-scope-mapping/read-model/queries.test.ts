import { describe, expect, it, vi } from "vitest";
import {
  getProviderScopeMapping,
  listAcceptedProviderScopeMappingsByProviderUnit,
  listAcceptedProviderScopeMappingsByScopeRecord,
  listProviderScopeMappingsByScopeRecord,
} from "./queries";

describe("Provider Scope Mapping queries", () => {
  it("lists accepted mappings by scope record", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({
      rows: [
        {
          mapping_id: "map_1",
          scope_record_id: "ref_expansion_paldean_fates",
          provider_key: "tcgdex",
          unit_key: "pokemon-card-import",
          set_id: "sv4-5",
          set_name: "Paldean Fates",
          review_status: "accepted",
        },
      ],
    }));

    const result = await listAcceptedProviderScopeMappingsByScopeRecord({ query }, "ref_expansion_paldean_fates");

    expect(result).toHaveLength(1);
    expect(result[0]?.set_id).toBe("sv4-5");
    expect(String(query.mock.calls[0]?.[0])).toContain("review_status IN ('accepted', 'auto-accepted')");
    expect(query.mock.calls[0]?.[1]).toEqual(["ref_expansion_paldean_fates"]);
  });

  it("lists accepted mappings by provider unit with normalized provider keys", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));

    await listAcceptedProviderScopeMappingsByProviderUnit(
      { query },
      { providerKey: " TCGdex ", unitKey: " Pokemon-Card-Import " },
    );

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("provider_key = $1");
    expect(sql).toContain("unit_key = $2");
    expect(sql).toContain("review_status IN ('accepted', 'auto-accepted')");
    expect(query.mock.calls[0]?.[1]).toEqual(["tcgdex", "pokemon-card-import"]);
  });

  it("lists every mapping for a scope record regardless of review status", async () => {
    const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [] }));
    await listProviderScopeMappingsByScopeRecord({ query }, "ref_expansion_paldean_fates");
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("WHERE scope_record_id = $1");
    expect(sql).not.toContain("review_status IN");
    expect(query.mock.calls[0]?.[1]).toEqual(["ref_expansion_paldean_fates"]);
  });

  it("gets a single mapping by id, or null when missing", async () => {
    const query = vi.fn(async () => ({ rows: [{ mapping_id: "map_1" }] }));
    const result = await getProviderScopeMapping({ query }, "map_1");
    expect(result).toEqual({ mapping_id: "map_1" });

    const emptyQuery = vi.fn(async () => ({ rows: [] }));
    expect(await getProviderScopeMapping({ query: emptyQuery }, "map_missing")).toBeNull();
    expect(await getProviderScopeMapping({ query: emptyQuery }, "  ")).toBeNull();
  });
});
