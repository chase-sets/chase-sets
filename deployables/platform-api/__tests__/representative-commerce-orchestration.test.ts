import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainContextRuntime, syncProjectionGroup } from "@chase-sets/bounded-context-runtime";
import { representativeCommerceStateDataProfiles, seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { publishRepresentativeListings } from "@chase-sets/catalog-seed";
import {
  runRepresentativeCommerceState,
  type RepresentativeCommerceStateRunOptions,
} from "../src/representative-commerce-state";

vi.mock("@chase-sets/platform-runtime/control-plane", () => ({ bootstrapPlatformControlPlane: vi.fn() }));
vi.mock("@chase-sets/platform-runtime/api", async (original) => ({
  ...(await original<object>()),
  seedApiHostIfEmpty: vi.fn(),
}));
vi.mock("@chase-sets/bounded-context-runtime", async (original) => ({
  ...(await original<object>()),
  getProjectionGroup: (_runtime: unknown, context: string, projection: string) => `${context}.${projection}`,
  syncProjectionGroup: vi.fn(),
  drainContextRuntime: vi.fn(),
}));
vi.mock("@chase-sets/catalog/server", async (original) => ({
  ...(await original<object>()),
  reconcileRepresentativeProductContentsScenario: vi.fn(async () => true),
}));
vi.mock("@chase-sets/catalog-seed", async (original) => {
  const actual = await original<typeof import("@chase-sets/catalog-seed")>();
  const candidate = { catalogItemId: "synthetic-pokemon" };
  return {
    ...actual,
    prepareRepresentativeCatalogUsageCandidatesByIds: vi.fn(async () => [candidate]),
    prepareRepresentativeCatalogUsageCandidates: vi.fn(async () => [candidate]),
    prioritizeRepresentativeCatalogUsageCandidates: vi.fn(() => [candidate]),
    selectRepresentativeCatalogUsageCandidates: vi.fn(() => [candidate]),
    reconcileRepresentativeMarketplaceCatalogItems: vi.fn(async () => 1),
    reconcileRepresentativeInventoryCatalogItems: vi.fn(async () => 1),
    ensureRepresentativeInventoryStock: vi.fn(async () => [
      {
        catalogItemId: candidate.catalogItemId,
        accountId: "synthetic-seller",
        inventoryItemId: "synthetic-stock",
        selectedOptions: [],
        totalQuantity: 2,
      },
    ]),
    publishRepresentativeListings: vi.fn(actual.publishRepresentativeListings),
    submitRepresentativeOffers: vi.fn(async () => []),
    acceptRepresentativeOffers: vi.fn(async () => []),
    reconcileRepresentativeOrderingSupplyState: vi.fn(async () => ({})),
    observeRepresentativeDiscoveryMarketState: vi.fn(async () => ({})),
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(currency: string | null = null, version = 0, fresh = false) {
  let present = !fresh;
  const row = {
    listing_id: "",
    product_id: "synthetic-pokemon::",
    status: "active",
    price_amount: "9.99",
    price_currency_code: currency,
    listing_stream_version: version,
    visible_quantity: 2,
  };
  const query = vi.fn(async (sql: string, params?: readonly unknown[]) => {
    if (sql.includes("WHERE listing_id = $1")) {
      row.listing_id = String(params?.[0]);
      return { rows: present ? [row] : [] };
    }
    return { rows: [] };
  });
  const updateListingPrice = vi.fn(async () => {
    row.price_currency_code = "USD";
    row.listing_stream_version += 1;
  });
  const createListing = vi.fn(async (input: { listingIdOverride: string }) => {
    present = true;
    row.listing_id = input.listingIdOverride;
    row.price_currency_code = "USD";
    row.listing_stream_version = 1;
    return { listingId: row.listing_id, feeQuoteFingerprint: "synthetic-quote" };
  });
  const summary = { active_listing_count: 1, total_visible_quantity: 2 };
  const detail = vi.fn(async () => ({ market_summary: summary, market_listings: [row] }));
  const services = {
    catalog: {
      db: { query },
      productMeasures: { resolveCatalogItemMeasures: vi.fn() },
      productContents: {
        upsertContentType: vi.fn(),
        upsertInclusionPolicy: vi.fn(),
        replaceProductContents: vi.fn(),
      },
    },
    inventory: { db: { query }, catalogItems: {}, items: {} },
    marketplace: {
      db: { query },
      listings: {
        updateListingPrice,
        createListing,
        publishListing: vi.fn(),
        getSellerListing: vi.fn(async () => row),
        getMarketSummaryForItem: vi.fn(async () => summary),
        listItemListings: vi.fn(async () => [row]),
      },
    },
    discovery: { db: { query }, items: { detail: { getItemDetail: detail } } },
    identity: { db: { query } },
    settlement: { db: { query } },
    ordering: { db: { query } },
  };
  const completed: string[] = [];
  const options = {
    pools: {},
    runtime: { services, mountedContexts: [] },
    execution: { deploymentEnvironment: "staging", confirmation: "seed staging commerce" },
    evidenceOutPath: null,
    afterStepCompleted: (step: string) => {
      completed.push(step);
    },
  } as unknown as RepresentativeCommerceStateRunOptions;
  return { options, completed, row, detail, updateListingPrice, createListing };
}

function logged(type: string, method: "log" | "error" = "log") {
  return vi.mocked(console[method]).mock.calls.flatMap(([message]) => {
    try {
      const value = JSON.parse(String(message));
      return value.type === type ? [value] : [];
    } catch {
      return [];
    }
  });
}

describe("representative refresh phase isolation (synthetic runtime)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.mocked(drainContextRuntime).mockResolvedValue(undefined);
    vi.mocked(syncProjectionGroup).mockResolvedValue(undefined);
    vi.mocked(seedApiHostIfEmpty).mockImplementation(async (_registry, _host, runtime, options) => {
      if (!options?.seedContextDrain) await drainContextRuntime(runtime);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    [null, 0],
    ["USD", 0],
    ["USD", 2],
  ] as const)(
    "repairs or preserves retained %s/version %s before a pending unrelated full drain",
    async (currency, version) => {
      const state = harness(currency, version);
      const drain = deferred();
      vi.mocked(drainContextRuntime).mockReturnValue(drain.promise);
      const run = runRepresentativeCommerceState(state.options);
      const observed = run.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      try {
        expect(state.detail).toHaveBeenCalled();
        expect(state.updateListingPrice).toHaveBeenCalledTimes(currency === "USD" && version > 0 ? 0 : 1);
        expect(logged("representative-commerce-state.complete")).toEqual([]);
        expect(state.completed).toContain("verify repaired Pokemon canary buyer visibility");
      } finally {
        drain.resolve();
        await observed;
      }
      await expect(run).resolves.toBeUndefined();
      expect(logged("representative-commerce-state.complete")).toHaveLength(1);
    },
  );

  it("ensures every fresh data profile before creating the canary and preserves rerun idempotence", async () => {
    const state = harness(null, 0, true);
    await runRepresentativeCommerceState(state.options);
    expect(seedApiHostIfEmpty).toHaveBeenCalledWith(
      expect.anything(),
      "platform-api",
      expect.anything(),
      expect.objectContaining({ enabledDataProfiles: representativeCommerceStateDataProfiles }),
    );
    expect(state.completed.indexOf("seed data profiles")).toBeLessThan(
      state.completed.indexOf("publish representative listings"),
    );
    expect(state.createListing).toHaveBeenCalledWith(
      expect.objectContaining({ priceCurrencyCode: "USD", quantityCap: 2 }),
      expect.anything(),
    );
    await runRepresentativeCommerceState(state.options);
    expect(state.createListing).toHaveBeenCalledTimes(1);
    expect(state.updateListingPrice).not.toHaveBeenCalled();
  });

  it("reports the capped remaining-drain failure after repair, never complete, then resumes without another price event", async () => {
    const state = harness();
    const drain = deferred();
    vi.mocked(drainContextRuntime).mockReturnValue(drain.promise);
    const run = runRepresentativeCommerceState(state.options);
    const rejected = expect(run).rejects.toThrow("exceeded 600000ms");
    await vi.advanceTimersByTimeAsync(600_001);
    await rejected;
    expect(logged("representative-commerce-state.failed", "error")).toEqual([
      expect.objectContaining({
        failedStep: "drain remaining representative projections",
        lastCompletedStep: "verify repaired Pokemon canary buyer visibility",
      }),
    ]);
    expect(logged("representative-commerce-state.complete")).toEqual([]);
    drain.resolve();
    await runRepresentativeCommerceState(state.options);
    expect(state.updateListingPrice).toHaveBeenCalledTimes(1);
    expect(logged("representative-commerce-state.complete")).toHaveLength(1);
  });

  it.each([
    "seed data profiles",
    "sync discovery.discovery-market-projection",
    "verify repaired Pokemon canary buyer visibility",
  ])("names the first failed required phase %s without completion", async (step) => {
    const state = harness();
    if (step === "seed data profiles")
      vi.mocked(seedApiHostIfEmpty).mockRejectedValueOnce(new Error("synthetic prerequisite failure"));
    else if (step.startsWith("sync"))
      vi.mocked(syncProjectionGroup).mockImplementation(async (group) => {
        if (String(group) === "discovery.discovery-market-projection") throw new Error("synthetic projection failure");
      });
    else state.row.visible_quantity = 0;
    await expect(runRepresentativeCommerceState(state.options)).rejects.toThrow();
    expect(logged("representative-commerce-state.failed", "error")[0]).toMatchObject({ failedStep: step });
    expect(logged("representative-commerce-state.complete")).toEqual([]);
    expect(drainContextRuntime).not.toHaveBeenCalled();
  });

  it("rechecks buyer visibility after the remaining drain and offer side effects before completion", async () => {
    const state = harness();
    vi.mocked(drainContextRuntime).mockImplementation(async () => {
      state.row.visible_quantity = 0;
    });
    await expect(runRepresentativeCommerceState(state.options)).rejects.toThrow("must be buyer-visible");
    expect(state.completed).toContain("verify repaired Pokemon canary buyer visibility");
    expect(logged("representative-commerce-state.failed", "error")[0]).toMatchObject({
      failedStep: "verify representative Pokemon canary buyer visibility",
    });
    expect(logged("representative-commerce-state.complete")).toEqual([]);
  });

  it("refuses production before any seed or seller command", async () => {
    const state = harness();
    await expect(
      runRepresentativeCommerceState({
        ...state.options,
        execution: { deploymentEnvironment: "production", confirmation: "seed staging commerce" },
      }),
    ).rejects.toThrow("cannot run");
    expect(seedApiHostIfEmpty).not.toHaveBeenCalled();
    expect(publishRepresentativeListings).not.toHaveBeenCalled();
  });
});
