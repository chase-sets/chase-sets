import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import { providerScopeMappingRoutes } from "../../provider-scope-mapping/api/route";
import type { ProviderScopeMappingServices } from "../../provider-scope-mapping/api/runtime";
import { buildScopeCoverageMatrix } from "../../provider-scope-mapping/api/scope-coverage-admin-contracts";
import type { ProviderScopeMappingRow } from "../../provider-scope-mapping/read-model/queries";
import { catalogScopeRegistryRoutes } from "../../scope-registry/api/route";
import type { CatalogScopeRecordListParams } from "../../scope-registry/read-model/queries";
import { providerOptionRoutes } from "../../source-observations/api/route-modules/provider-options-routes";
import { providerProfileRoutes } from "../../source-observations/api/route-modules/provider-profile-routes";
import { queryCatalogProviderIntegrationOptionsWithCache } from "../../source-observations/api/providers/provider-option-query-cache";
import { catalogProviderIntegrationProfileVersions } from "../../source-observations/api/providers/registry";
import { buildCatalogPrimaryWorkbenchSourceOptionRequests } from "../../source-observations/ui/primary-workbench-source-options";
import {
  classifyScrydexCacheCaptureRequest,
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureUnits,
  validateScrydexCacheCaptureReceipt,
  type ScrydexCacheCaptureDeployGeneration,
  type ScrydexCacheCaptureEvidence,
  type ScrydexCacheCaptureUnitKey,
} from "../domain/scrydex-cache-capture";
import {
  fixtureExpansionId,
  syntheticCacheFetchedAt,
  syntheticMappingRow,
  syntheticOptionCacheRecord,
  syntheticScopeRow,
} from "../tests/scrydex-cache-capture-fixture";
import { runScrydexCacheCapture } from "./scrydex-cache-capture-runner";

const onePieceSet = "scrydex:one-piece:set:reference-data";
const onePieceCard = "scrydex:one-piece:single-card:source-observation-import";
const onePieceSealed = "scrydex:one-piece:sealed-product:source-observation-import";
const lorcanaSet = "scrydex:lorcana:set:reference-data";
const lorcanaCard = "scrydex:lorcana:single-card:source-observation-import";
const onePieceExpansion = fixtureExpansionId("scrydex-one-piece-set-reference");
const lorcanaExpansion = fixtureExpansionId("scrydex-lorcana-set-reference");
// Thirty synthetic One Piece expansions push the cached list past the deployed
// 25-option first page, so every One Piece unit needs one continuation page.
const onePieceExpansions = [
  onePieceExpansion,
  ...Array.from({ length: 29 }, (_, index) => `synthetic-op-${String(index + 2).padStart(2, "0")}`),
];
const lorcanaExpansions = [lorcanaExpansion, "synthetic-l-02"];

const generation: ScrydexCacheCaptureDeployGeneration = {
  runId: "9000000001",
  runAttempt: 1,
  jobId: "9000000002",
  jobCompletedAt: "2026-10-20T15:00:00Z",
  deployedHead: "b".repeat(40),
  imageDigest: `sha256:${"c".repeat(64)}`,
};
const runner: ScrydexCacheCaptureEvidence["runner"] = {
  sha: "a".repeat(40),
  runId: "123456",
  runAttempt: "1",
  journeyScope: "scrydex-cache-capture",
  origin: "admin.staging.chasesets.com",
};

type World = Readonly<{
  scopes: Readonly<Record<"one-piece" | "lorcana", readonly string[]>>;
  mappingRows: readonly ProviderScopeMappingRow[];
  cachedUnits: readonly ScrydexCacheCaptureUnitKey[];
  legacyCoverage?: boolean;
  shrinkingInventory?: boolean;
}>;

function defaultWorld(): World {
  const row = (scopeRecordId: string, unitKey: string, setName: string) =>
    syntheticMappingRow({
      scopeRecordId,
      unitKey,
      mappingId: `synthetic-map-${scopeRecordId}-${unitKey.split(":")[2]}`,
      setName,
    });
  return {
    scopes: { "one-piece": ["synthetic-op-1", "synthetic-op-2"], lorcana: ["synthetic-l-1"] },
    mappingRows: [
      row("synthetic-op-1", onePieceSet, onePieceExpansion),
      row("synthetic-op-1", onePieceCard, onePieceExpansion),
      row("synthetic-op-1", onePieceSealed, onePieceExpansion),
      row("synthetic-op-2", onePieceSet, "synthetic-op-02"),
      row("synthetic-op-2", onePieceCard, "synthetic-op-02"),
      row("synthetic-op-2", onePieceSealed, "synthetic-op-not-cached"),
      row("synthetic-l-1", lorcanaSet, lorcanaExpansion),
      row("synthetic-l-1", lorcanaCard, lorcanaExpansion),
      syntheticMappingRow({
        scopeRecordId: "synthetic-l-1",
        unitKey: "tcgplayer:lorcana:sealed-product:source-observation-import",
        mappingId: "synthetic-map-l-1-tcgplayer",
        setName: "synthetic-tcgplayer-set",
        providerKey: "tcgplayer",
      }),
    ],
    cachedUnits: scrydexCacheCaptureUnits.map(({ unitKey }) => unitKey),
  };
}

// A synthetic deployed Admin made of the shipped route modules: Scope Coverage
// over the real builder, the Scope Record list over the real mapper, the
// deployed profile roster from the registry, and the cache-only option route
// over the shipped cache query with every live load and cache write denied.
async function deployedAdmin(world: World, serverNow: () => string) {
  const loadLive = vi.fn(async () => {
    throw new Error("Live provider option loads are denied in Scrydex cache capture runner tests.");
  });
  const records = new Map(
    await Promise.all(
      world.cachedUnits.map(async (unitKey) => {
        const expansionIds = unitKey.includes(":one-piece:") ? onePieceExpansions : lorcanaExpansions;
        return [unitKey, await syntheticOptionCacheRecord({ unitKey, expansionIds })] as const;
      }),
    ),
  );
  const coverage: ProviderScopeMappingServices["getScopeCoverageMatrix"] = async (scopeRecordId) => {
    const productDomain = world.scopes["one-piece"].includes(scopeRecordId) ? "one-piece" : "lorcana";
    const matrix = await buildScopeCoverageMatrix({
      generatedAt: serverNow(),
      scope: { ...syntheticScopeRow(scopeRecordId, productDomain), name: scopeRecordId },
      mappingRows: world.mappingRows.filter((row) => row.scope_record_id === scopeRecordId),
      loadSyncStatus: async () => ({ totalObservations: 0, promotedObservations: 0 }),
    });
    if (!world.legacyCoverage) return matrix;
    return {
      ...matrix,
      providers: matrix.providers.map(({ acceptedMappings: _acceptedMappings, ...row }) => row),
    } as unknown as typeof matrix;
  };
  let scopeListCalls = 0;
  const app = new Hono<CatalogAuthoringEnv>();
  app.use("/api/catalog/*", async (c, next) => {
    c.set("actor", { permissions: ["catalog.view"] });
    await next();
  });
  app.route(
    "/api/catalog/provider-scope-mappings",
    providerScopeMappingRoutes({ getScopeCoverageMatrix: coverage } as unknown as ProviderScopeMappingServices),
  );
  app.route(
    "/api/catalog/scope-records",
    catalogScopeRegistryRoutes({
      getScopeRecord: async () => null,
      listScopeRecords: async (params?: CatalogScopeRecordListParams) => {
        scopeListCalls += 1;
        const domain = params?.productDomain as "one-piece" | "lorcana";
        const ids = world.scopes[domain] ?? [];
        const visible = world.shrinkingInventory && scopeListCalls > 1 ? [] : ids;
        const offset = Number(params?.offset ?? 0);
        const limit = Number(params?.limit ?? 50);
        return {
          items: visible.slice(offset, offset + limit).map((id) => syntheticScopeRow(id, domain)),
          total: ids.length,
        };
      },
    }),
  );
  app.route(
    "/api/catalog/source-observations",
    providerProfileRoutes(
      {} as never,
      {
        listProfileVersions: async () => catalogProviderIntegrationProfileVersions,
        countProfileVersionReferences: async () => 0,
      } as never,
    ),
  );
  app.route(
    "/api/catalog/source-observations",
    providerOptionRoutes({
      queryIntegrationOptions: (
        request: Parameters<typeof queryCatalogProviderIntegrationOptionsWithCache>[0]["request"],
      ) =>
        queryCatalogProviderIntegrationOptionsWithCache({
          request: { ...request, profileVersion: "synthetic-profile-version" },
          cacheStore: {
            read: async (cacheRequest) =>
              records.get(cacheRequest.ingestionUnitKey as ScrydexCacheCaptureUnitKey) ?? null,
            write: async () => {
              throw new Error("Cache writes are denied in Scrydex cache capture runner tests.");
            },
          },
          loadLive,
          now: new Date(serverNow()),
        }),
    } as never),
  );
  return { app, loadLive };
}

// The script's derivation: the shipped Integrations builder over the deployed
// roster, asked for the unit's set-name page exactly as a unit route renders it.
function resolveQueryHref(profiles: readonly Record<string, unknown>[], unitKey: ScrydexCacheCaptureUnitKey) {
  const requests = buildCatalogPrimaryWorkbenchSourceOptionRequests({
    requestUrl: `${scrydexCacheCaptureOrigin}/catalog/integrations?providerKey=scrydex&unitKey=${encodeURIComponent(unitKey)}`,
    scopes: [],
    profiles: profiles as never,
    cacheOnly: true,
  }).filter((request) => request.scope === "set-name" && request.parentScope === null);
  return requests.length === 1 ? requests[0]!.queryHref : null;
}

async function capture(
  input: Partial<Parameters<typeof runScrydexCacheCapture>[0]> & { world?: World; clock?: string } = {},
) {
  let clock = Date.parse(input.clock ?? "2026-10-20T16:00:00.000Z");
  const now = () => new Date(clock).toISOString();
  const { app, loadLive } = await deployedAdmin(input.world ?? defaultWorld(), now);
  const paths: string[] = [];
  const requests = {
    signIn: 0,
    profileReads: 0,
    scopeInventoryReads: 0,
    coverageReads: 0,
    cacheOptionReads: 0,
    ambientReadsBlocked: 0,
    fenceRefusals: 0,
  };
  const fence: { method: string; path: string; reason: string }[] = [];
  const counter = {
    "profile-read": "profileReads",
    "scope-inventory-read": "scopeInventoryReads",
    "coverage-read": "coverageReads",
    "cache-option-read": "cacheOptionReads",
  } as const;
  // Every read crosses the same request fence the browser applies.
  const read = vi.fn(async (path: string) => {
    clock += 100;
    paths.push(path);
    const verdict = classifyScrydexCacheCaptureRequest({
      method: "GET",
      url: `${scrydexCacheCaptureOrigin}${path}`,
      phase: "capture",
      navigation: false,
    });
    if (!verdict.allowed) {
      requests.fenceRefusals += 1;
      fence.push({ method: "GET", path: new URL(path, scrydexCacheCaptureOrigin).pathname, reason: verdict.reason });
      throw new Error("blockedbyclient");
    }
    requests[counter[verdict.requestClass as keyof typeof counter]] += 1;
    const response = await app.request(path);
    return { status: response.status, text: await response.text() };
  });
  const selectDeployment = input.selectDeployment ?? vi.fn(async () => ({ generation, stop: null }));
  const signIn = input.signIn ?? vi.fn(async () => undefined);
  const receipt = await runScrydexCacheCapture({
    runner,
    credentialsPresent: input.credentialsPresent ?? true,
    selectDeployment,
    signIn,
    read,
    resolveQueryHref: input.resolveQueryHref ?? resolveQueryHref,
    tally: () => ({ requests: { ...requests }, fence: [...fence] }),
    now,
  });
  return { receipt, read, paths, loadLive, selectDeployment, signIn };
}

describe("Scrydex cache capture runner", () => {
  it("captures complete per-unit membership through the deployed routes without a live load or refresh", async () => {
    const { receipt, paths, loadLive } = await capture();
    expect(receipt.reasons).toEqual([]);
    expect(receipt.captureStatus).toBe("complete");
    expect(validateScrydexCacheCaptureReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual([]);
    expect(loadLive).not.toHaveBeenCalled();
    expect(paths.some((path) => /forceRefresh|tcgplayer|parentValue/i.test(path))).toBe(false);
    expect(receipt.units.map(({ unitKey, pages }) => [unitKey, pages.map((page) => page.cursor)])).toEqual([
      [onePieceSet, [null, "offset:25"]],
      [onePieceCard, [null, "offset:25"]],
      [onePieceSealed, [null, "offset:25"]],
      [lorcanaSet, [null]],
      [lorcanaCard, [null]],
    ]);
    expect(receipt.units[0]!.values).toEqual(onePieceExpansions);
    expect(
      receipt.scopes.map(({ scopeRecordId, mappings }) => [
        scopeRecordId,
        mappings.map(({ unitKey, mappingId, version, membership }) => [unitKey, mappingId, version, membership]),
      ]),
    ).toEqual([
      [
        "synthetic-op-1",
        [
          [onePieceSealed, "synthetic-map-synthetic-op-1-sealed-product", "2026-10-03T00:00:00.000Z", "member"],
          [onePieceSet, "synthetic-map-synthetic-op-1-set", "2026-10-03T00:00:00.000Z", "member"],
          [onePieceCard, "synthetic-map-synthetic-op-1-single-card", "2026-10-03T00:00:00.000Z", "member"],
        ],
      ],
      [
        "synthetic-op-2",
        [
          [onePieceSealed, "synthetic-map-synthetic-op-2-sealed-product", "2026-10-03T00:00:00.000Z", "non-member"],
          [onePieceSet, "synthetic-map-synthetic-op-2-set", "2026-10-03T00:00:00.000Z", "member"],
          [onePieceCard, "synthetic-map-synthetic-op-2-single-card", "2026-10-03T00:00:00.000Z", "member"],
        ],
      ],
      [
        "synthetic-l-1",
        [
          [lorcanaSet, "synthetic-map-synthetic-l-1-set", "2026-10-03T00:00:00.000Z", "member"],
          [lorcanaCard, "synthetic-map-synthetic-l-1-single-card", "2026-10-03T00:00:00.000Z", "member"],
        ],
      ],
    ]);
    expect(receipt.units[0]!.cache).toMatchObject({ status: "stale", fetchedAt: syntheticCacheFetchedAt });
    expect(receipt.reads).toEqual({ profileReads: 1, scopeInventoryReads: 2, coverageReads: 3, cacheOptionReads: 8 });
  });

  it("refuses an old deployment without acceptedMappings instead of reading the representative mapping", async () => {
    const { receipt } = await capture({ world: { ...defaultWorld(), legacyCoverage: true } });
    expect(receipt.captureStatus).toBe("governed-unknown");
    expect(receipt.reasons).toEqual(
      expect.arrayContaining([
        "coverage-accepted-mappings-missing:synthetic-op-1",
        "coverage-incomplete:one-piece",
        `required-unit-unmapped:${onePieceSet}`,
      ]),
    );
    expect(receipt.scopes).toEqual([]);
  });

  it("keeps a swept cache row unreadable with live loads denied", async () => {
    const world = { ...defaultWorld(), cachedUnits: defaultWorld().cachedUnits.filter((unit) => unit !== lorcanaCard) };
    const { receipt, loadLive } = await capture({ world });
    expect(loadLive).not.toHaveBeenCalled();
    expect(receipt.reasons).toEqual(
      expect.arrayContaining([`option-cache-unavailable:${lorcanaCard}`, `option-list-missing:${lorcanaCard}`]),
    );
    expect(receipt.scopes.find((scope) => scope.scopeRecordId === "synthetic-l-1")!.mappings[1]).toMatchObject({
      unitKey: lorcanaCard,
      membership: "unreadable",
    });
  });

  it("treats a read completing inside the skew window before staleUntil as late, never membership", async () => {
    const { receipt } = await capture({ clock: "2026-10-21T05:59:20.000Z" });
    expect(receipt.captureStatus).toBe("governed-unknown");
    expect(receipt.reasons).toContain(`option-list-late:${onePieceSet}`);
    expect(receipt.scopes[0]!.mappings.every((mapping) => mapping.membership === "unreadable")).toBe(true);
  });

  it("refuses a Scope Record inventory that stops short of its total", async () => {
    const world = {
      ...defaultWorld(),
      scopes: { "one-piece": Array.from({ length: 201 }, (_, i) => `synthetic-op-${i}`), lorcana: ["synthetic-l-1"] },
      shrinkingInventory: true,
    };
    const { receipt } = await capture({ world });
    expect(receipt.reasons).toEqual(
      expect.arrayContaining(["scope-inventory-truncated:one-piece", "scope-inventory-incomplete:one-piece"]),
    );
  });

  it("keeps a deployment that changed between the bracketing reads governed unknown", async () => {
    const selectDeployment = vi
      .fn()
      .mockResolvedValueOnce({ generation, stop: null })
      .mockResolvedValueOnce({ generation: { ...generation, deployedHead: "d".repeat(40) }, stop: null });
    const { receipt } = await capture({ selectDeployment });
    expect(receipt.reasons).toEqual(["deployment-changed"]);
  });

  it("signs in and reads nothing when the deployed revision cannot be bound", async () => {
    const selectDeployment = vi.fn(async () => ({ generation: null, stop: "deploy-in-progress" }));
    const { receipt, read, signIn } = await capture({ selectDeployment });
    expect(signIn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(selectDeployment).toHaveBeenCalledTimes(1);
    expect(receipt.reasons).toContain("deployment-unbound:before:deploy-in-progress");
    expect(validateScrydexCacheCaptureReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual([]);
  });

  it("makes no GitHub, sign-in or Admin call when a credential is withheld", async () => {
    const { receipt, read, signIn, selectDeployment } = await capture({ credentialsPresent: false });
    expect(selectDeployment).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(receipt.reasons).toContain("credentials-missing");
    expect(validateScrydexCacheCaptureReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual([]);
  });

  it("reads nothing after a failed sign-in", async () => {
    const { receipt, read } = await capture({ signIn: vi.fn(async () => Promise.reject(new Error("synthetic"))) });
    expect(read).not.toHaveBeenCalled();
    expect(receipt.reasons).toContain("sign-in-failed");
  });

  it("never follows a derived href that is not a cache-only Scrydex sets read", async () => {
    const { receipt, paths } = await capture({
      resolveQueryHref: (profiles, unitKey) => {
        const href = resolveQueryHref(profiles, unitKey);
        return unitKey === onePieceCard && href ? `${href}&forceRefresh=true` : href;
      },
    });
    expect(paths.some((path) => path.includes("forceRefresh"))).toBe(false);
    expect(receipt.reasons).toEqual(
      expect.arrayContaining([`query-href-unresolved:${onePieceCard}`, `option-list-missing:${onePieceCard}`]),
    );
  });

  it("refuses two accepted mappings for one unit on one Scope Record", async () => {
    const world = defaultWorld();
    const duplicate = syntheticMappingRow({
      scopeRecordId: "synthetic-l-1",
      unitKey: lorcanaSet,
      mappingId: "synthetic-map-l-1-set-duplicate",
      setName: lorcanaExpansion,
    });
    const { receipt } = await capture({ world: { ...world, mappingRows: [...world.mappingRows, duplicate] } });
    expect(receipt.reasons).toContain("coverage-mapping-duplicate:synthetic-l-1");
  });
});
