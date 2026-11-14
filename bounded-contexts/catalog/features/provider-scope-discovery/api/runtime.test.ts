import { describe, expect, it } from "vitest";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { createMtgjsonProviderAdapter } from "../../source-observations/api/provider-adapters/mtgjson";
import { ProviderAdapterRegistry } from "../../source-observations/api/provider-adapters/registry";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/provider-integration-profiles";
import type { CatalogProviderIntegrationOption } from "../../source-observations/api/providers/provider-option-query-resolver";
import { queryProviderIntegrationOptions } from "../../source-observations/api/providers/provider-option-queries";
import { listProviderScopeDiscoveryTargets } from "./discovery-targets";
import { createProviderScopeDiscoveryRuntime, type ProviderScopeDiscoveryPorts } from "./runtime";
import { classifyProviderScopeDiscoveryTarget } from "./scope-observation-matcher";

const TIMEOUT_REASON = "MTGJSON request did not finish within 1 ms.";
const HOUR_MS = 60 * 60 * 1000;
const TEST_CONTEXT = {
  tenantId: "tnt_identity",
  audit: { performedByUserId: "usr_identity_system", forAccountId: "acc_identity_system" },
} as unknown as EventStoreContext;
const mtgjsonProfileVersions = catalogProviderIntegrationProfileVersions.filter(
  (version) => version.providerKey === "mtgjson",
);

describe("provider scope discovery refresh with a stalled MTGJSON transport", () => {
  it("records a failed run with the timeout instead of succeeding from a usable cached page", async () => {
    const harness = stalledMtgjsonHarness({ cachedOptions: [cachedSet("TSP")] });

    const result = await harness.runtime.runProviderRefreshNow({ providerKey: "mtgjson", context: TEST_CONTEXT });

    expect(harness.transportCalls()).toBeGreaterThan(0);
    expect(result).toMatchObject({ status: "failed", observationCount: 0, errorMessage: TIMEOUT_REASON });
    expect(harness.completionWrites).toEqual([{ status: "failed", error: TIMEOUT_REASON }]);
    expect(harness.observationWrites).toBe(0);
  });

  it("records a failed run with the timeout when no cached page exists", async () => {
    const harness = stalledMtgjsonHarness({ cachedOptions: null });

    const result = await harness.runtime.runProviderRefreshNow({ providerKey: "mtgjson", context: TEST_CONTEXT });

    expect(result).toMatchObject({ status: "failed", observationCount: 0, errorMessage: TIMEOUT_REASON });
    expect(harness.completionWrites).toEqual([{ status: "failed", error: TIMEOUT_REASON }]);
    expect(harness.observationWrites).toBe(0);
  });

  it("still serves the usable cached page to an ordinary option query", async () => {
    const harness = stalledMtgjsonHarness({ cachedOptions: [cachedSet("TSP")] });
    const target = listProviderScopeDiscoveryTargets(mtgjsonProfileVersions, classifyProviderScopeDiscoveryTarget).find(
      (candidate) => !candidate.parentRequired,
    );
    expect(target).toBeDefined();

    const page = await harness.queryIntegrationOptions({
      providerKey: target!.providerKey,
      profileKey: target!.profileKey,
      ingestionUnitKey: target!.ingestionUnitKey,
      queryKind: target!.queryKind,
      languageCode: target!.languageCode,
    });

    expect(harness.transportCalls()).toBeGreaterThan(0);
    expect(page.items.map((item) => item.value)).toEqual(["TSP"]);
    expect(page.cache).toMatchObject({ status: "stale", source: "cache", degraded: true, forceRefresh: false });
    expect(page.cache.diagnostics[0]?.message).toBe(TIMEOUT_REASON);
  });
});

function stalledMtgjsonHarness(input: { cachedOptions: readonly CatalogProviderIntegrationOption[] | null }) {
  let transportCalls = 0;
  const completionWrites: Array<{ status: unknown; error: unknown }> = [];
  let observationWrites = 0;

  const db = {
    async query(sql: string, params: readonly unknown[] = []) {
      if (sql.includes("FROM catalog_provider_option_query_cache")) {
        return { rows: input.cachedOptions ? [usableCacheRow(String(params[0]), input.cachedOptions)] : [] };
      }
      if (sql.includes("INSERT INTO catalog_provider_scope_observations")) {
        observationWrites += 1;
      }
      if (sql.includes("SET last_run_completed_at")) {
        completionWrites.push({ status: params[2], error: params[4] });
      }
      return { rows: [] };
    },
  } as unknown as PgQueryable;

  const fetch = ((_url: RequestInfo | URL, init?: RequestInit) => {
    transportCalls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  }) as typeof globalThis.fetch;
  const registry = new ProviderAdapterRegistry([createMtgjsonProviderAdapter({ fetch, fetchTimeoutMs: 1 })]);
  const queryIntegrationOptions: ProviderScopeDiscoveryPorts["queryIntegrationOptions"] = (query) =>
    queryProviderIntegrationOptions(query, db, null, undefined, registry);

  const runtime = createProviderScopeDiscoveryRuntime({ db } as unknown as CatalogRuntimeDeps, {
    listProfileVersions: async () => mtgjsonProfileVersions,
    queryIntegrationOptions,
    providerScopeMappingCommandHandler: async () => {
      throw new Error("unexpected provider scope mapping proposal");
    },
    referenceRecordCommandHandler: async () => {
      throw new Error("unexpected Reference Record command");
    },
  });

  return {
    runtime,
    queryIntegrationOptions,
    completionWrites,
    get observationWrites() {
      return observationWrites;
    },
    transportCalls: () => transportCalls,
  };
}

function usableCacheRow(cacheKey: string, items: readonly CatalogProviderIntegrationOption[]) {
  const now = Date.now();
  return {
    cache_key: cacheKey,
    provider_key: "mtgjson",
    profile_key: "",
    profile_version: "",
    ingestion_unit_key: "",
    query_kind: "",
    language_code: "en",
    parent_value: "",
    items_json: items,
    item_count: items.length,
    total_count: null,
    page_size: null,
    fetched_at: new Date(now - 2 * HOUR_MS).toISOString(),
    expires_at: new Date(now - HOUR_MS).toISOString(),
    stale_until: new Date(now + HOUR_MS).toISOString(),
    diagnostic_code: null,
    diagnostic_text: null,
  };
}

function cachedSet(setCode: string): CatalogProviderIntegrationOption {
  return {
    providerKey: "mtgjson",
    queryKind: "sets",
    value: setCode,
    label: setCode,
    description: null,
    parentValue: null,
    imageUrl: null,
    aliases: [],
    metadata: {},
  };
}
