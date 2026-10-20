import { describe, expect, it } from "vitest";
import {
  buildScrydexCacheCaptureReceipt,
  classifyScrydexCacheCaptureRequest,
  decodeScrydexAcceptedMappings,
  decodeScrydexCacheCaptureOptionPage,
  decodeScrydexCacheCaptureScopePage,
  scrydexCacheCaptureContinuationPath,
  scrydexCacheCaptureCoordinate,
  scrydexCacheCaptureCoveragePath,
  scrydexCacheCaptureOrigin,
  scrydexCacheCaptureQueryHrefUnit,
  scrydexCacheCaptureScopePagePath,
  scrydexCacheCaptureUnits,
  validateScrydexCacheCaptureReceipt,
  type ScrydexCacheCaptureEvidence,
  type ScrydexCacheCaptureUnitKey,
} from "./scrydex-cache-capture";
import {
  fixtureExpansionId,
  registryProfileKey,
  syntheticCacheFetchedAt,
  syntheticCaptureStartedAt,
  syntheticCoverageJson,
  syntheticMappingRow,
  syntheticOptionCacheRecord,
  syntheticOptionPageJson,
  syntheticScopePageJson,
} from "../tests/scrydex-cache-capture-fixture";

const onePieceSet = "scrydex:one-piece:set:reference-data";
const onePieceCard = "scrydex:one-piece:single-card:source-observation-import";
const onePieceSealed = "scrydex:one-piece:sealed-product:source-observation-import";
const lorcanaSet = "scrydex:lorcana:set:reference-data";
const lorcanaCard = "scrydex:lorcana:single-card:source-observation-import";
const onePieceExpansion = fixtureExpansionId("scrydex-one-piece-set-reference");
const lorcanaExpansion = fixtureExpansionId("scrydex-lorcana-set-reference");
const hash = (character: string) => character.repeat(64);

function optionHref(unitKey: ScrydexCacheCaptureUnitKey, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({
    providerKey: "scrydex",
    queryKind: "sets",
    limit: "25",
    profileKey: registryProfileKey(unitKey),
    ingestionUnitKey: unitKey,
    languageCode: "en",
    cacheOnly: "true",
    ...extra,
  });
  return `/api/catalog/source-observations/integration-options?${params.toString()}`;
}

function classify(method: string, path: string, phase: "sign-in" | "capture", navigation = false) {
  return classifyScrydexCacheCaptureRequest({
    method,
    url: path.startsWith("http") ? path : `${scrydexCacheCaptureOrigin}${path}`,
    phase,
    navigation,
  });
}

// Tamper cases edit untrusted decoder and validator JSON by path and may write any value into it.
type JsonNode = Record<string, unknown>;

function asNode(value: unknown): JsonNode {
  if (typeof value !== "object" || value === null) throw new Error("Tamper path leaves the JSON document.");
  return value as JsonNode;
}

function nodeAt(json: unknown, ...path: readonly (string | number)[]): JsonNode {
  return path.reduce<JsonNode>((node, key) => asNode(node[key]), asNode(json));
}

function listAt(json: unknown, ...path: readonly (string | number)[]): unknown[] {
  const list = path.reduce<unknown>((node, key) => asNode(node)[key], json);
  if (!Array.isArray(list)) throw new Error("Tamper path does not end at a JSON array.");
  return list;
}

describe("Scope Coverage acceptedMappings decoder", () => {
  const scopeRecordId = "synthetic-op-scope-1";
  const rows = [
    syntheticMappingRow({
      scopeRecordId,
      unitKey: onePieceSet,
      mappingId: "synthetic-map-set",
      setName: onePieceExpansion,
    }),
    syntheticMappingRow({
      scopeRecordId,
      unitKey: onePieceCard,
      mappingId: "synthetic-map-card",
      setName: onePieceExpansion,
      reviewStatus: "auto-accepted",
      updatedAt: "2026-10-04T00:00:00.000Z",
    }),
    syntheticMappingRow({
      scopeRecordId,
      unitKey: onePieceSealed,
      mappingId: "synthetic-map-sealed",
      setName: "synthetic-sealed-coordinate",
      setId: "synthetic-sealed-set-id",
      updatedAt: "2026-10-05T00:00:00.000Z",
    }),
    syntheticMappingRow({
      scopeRecordId,
      unitKey: onePieceSet,
      mappingId: "synthetic-map-proposed",
      setName: "synthetic-proposed",
      reviewStatus: "proposed",
    }),
    syntheticMappingRow({
      scopeRecordId,
      unitKey: "tcgplayer:one-piece:single-card:source-observation-import",
      mappingId: "synthetic-map-other-provider",
      setName: "synthetic-other",
      providerKey: "tcgplayer",
    }),
  ];
  const expected = { scopeRecordId, productDomain: "one-piece" } as const;

  it("returns every accepted Scrydex unit mapping on one Scope Record from the real builder JSON", async () => {
    const decoded = decodeScrydexAcceptedMappings(await syntheticCoverageJson({ ...expected, rows }), expected);
    expect(decoded).toEqual({
      ok: true,
      mappings: [
        {
          mappingId: "synthetic-map-sealed",
          unitKey: onePieceSealed,
          reviewStatus: "accepted",
          version: "2026-10-05T00:00:00.000Z",
          setId: "synthetic-sealed-set-id",
          setName: "synthetic-sealed-coordinate",
        },
        {
          mappingId: "synthetic-map-set",
          unitKey: onePieceSet,
          reviewStatus: "accepted",
          version: "2026-10-03T00:00:00.000Z",
          setId: null,
          setName: onePieceExpansion,
        },
        {
          mappingId: "synthetic-map-card",
          unitKey: onePieceCard,
          reviewStatus: "auto-accepted",
          version: "2026-10-04T00:00:00.000Z",
          setId: null,
          setName: onePieceExpansion,
        },
      ],
    });
  });

  it("refuses an old deployment without acceptedMappings instead of falling back to the representative mapping", async () => {
    const json = (await syntheticCoverageJson({ ...expected, rows })) as { providers: Record<string, unknown>[] };
    const scrydex = json.providers.find((row) => row.providerKey === "scrydex")!;
    expect(scrydex.mapping).toMatchObject({ reviewStatus: "accepted" });
    delete scrydex.acceptedMappings;
    expect(decodeScrydexAcceptedMappings(json, expected)).toEqual({
      ok: false,
      reason: "coverage-accepted-mappings-missing",
    });
  });

  it("treats a Scope Record without Scrydex mapping history as zero mappings, never an error", async () => {
    const otherOnly = rows.filter((row) => row.provider_key !== "scrydex");
    expect(
      decodeScrydexAcceptedMappings(await syntheticCoverageJson({ ...expected, rows: otherOnly }), expected),
    ).toEqual({ ok: true, mappings: [] });
  });

  it.each<[string, (json: unknown) => void, string]>([
    ["schema version", (json) => (nodeAt(json).schemaVersion = "catalog-scope-coverage-v2"), "coverage-malformed"],
    ["scope identity", (json) => (nodeAt(json).scopeRecordId = "synthetic-other-scope"), "coverage-scope-mismatch"],
    ["product domain", (json) => (nodeAt(json).productDomain = "lorcana"), "coverage-scope-mismatch"],
    [
      "duplicate provider rows",
      (json) => listAt(json, "providers").push(scrydexRow(json)),
      "coverage-provider-duplicate",
    ],
    [
      "non-accepted status inside acceptedMappings",
      (json) => (scrydexMapping(json, 0).reviewStatus = "proposed"),
      "coverage-mapping-malformed",
    ],
    [
      "mapping version that is not an instant",
      (json) => (scrydexMapping(json, 0).updatedAt = "yesterday"),
      "coverage-mapping-malformed",
    ],
    ["mapping without coordinates", (json) => delete scrydexMapping(json, 0).coordinates, "coverage-mapping-malformed"],
    [
      "mapping for another Scope Record",
      (json) => (scrydexMapping(json, 0).scopeRecordId = "synthetic-other-scope"),
      "coverage-mapping-malformed",
    ],
    [
      "mapping for another provider",
      (json) => (scrydexMapping(json, 0).providerKey = "tcgplayer"),
      "coverage-mapping-malformed",
    ],
    [
      "two mappings for one unit",
      (json) => (scrydexMapping(json, 1).unitKey = scrydexMapping(json, 0).unitKey),
      "coverage-mapping-duplicate",
    ],
    [
      "one mapping id twice",
      (json) => (scrydexMapping(json, 1).mappingId = scrydexMapping(json, 0).mappingId),
      "coverage-mapping-duplicate",
    ],
  ])("refuses %s", async (_name, mutate, reason) => {
    const json = await syntheticCoverageJson({ ...expected, rows });
    expect(decodeScrydexAcceptedMappings(json, expected).ok).toBe(true);
    mutate(json);
    expect(decodeScrydexAcceptedMappings(json, expected)).toEqual({ ok: false, reason });
  });
});

function scrydexRow(json: unknown): JsonNode {
  return asNode(listAt(json, "providers").find((row) => asNode(row).providerKey === "scrydex"));
}

function scrydexMapping(json: unknown, index: number): JsonNode {
  return nodeAt(scrydexRow(json), "acceptedMappings", index);
}

describe("Scope Record inventory page decoder", () => {
  it("reads the real Scope Record list JSON and its total", () => {
    const json = syntheticScopePageJson({
      productDomain: "lorcana",
      scopeRecordIds: ["synthetic-l-1", "synthetic-l-2"],
      total: 3,
    });
    expect(decodeScrydexCacheCaptureScopePage(json, { productDomain: "lorcana" })).toEqual({
      ok: true,
      total: 3,
      scopeRecordIds: ["synthetic-l-1", "synthetic-l-2"],
    });
  });

  it.each<[string, (json: unknown) => void]>([
    ["another product domain", (json) => (nodeAt(json, "items", 0).productDomain = "one-piece")],
    ["a non-set Scope Record", (json) => (nodeAt(json, "items", 0).scopeKind = "expansion")],
    ["an inactive Scope Record", (json) => (nodeAt(json, "items", 0).lifecycleStatus = "retired")],
    ["a count that disagrees with the items", (json) => (nodeAt(json).count = 5)],
    ["a missing total", (json) => delete nodeAt(json).total],
  ])("refuses %s", (_name, mutate) => {
    const json = syntheticScopePageJson({ productDomain: "lorcana", scopeRecordIds: ["synthetic-l-1"] });
    mutate(json);
    expect(decodeScrydexCacheCaptureScopePage(json, { productDomain: "lorcana" })).toEqual({
      ok: false,
      reason: "scope-page-malformed",
    });
  });
});

describe("cache-only option page decoder", () => {
  it("reads fresh and stale cached pages from the real cache-only path with live loads denied", async () => {
    const record = await syntheticOptionCacheRecord({
      unitKey: onePieceSet,
      expansionIds: [onePieceExpansion, "synthetic-op-02"],
    });
    const fresh = await syntheticOptionPageJson({
      record,
      unitKey: onePieceSet,
      cursor: null,
      limit: 25,
      now: "2026-10-20T06:05:00.000Z",
    });
    expect(decodeScrydexCacheCaptureOptionPage(fresh, { cursor: null })).toEqual({
      ok: true,
      page: {
        cursor: null,
        nextCursor: null,
        hasMore: false,
        total: 2,
        count: 2,
        values: [onePieceExpansion, "synthetic-op-02"],
        cache: {
          status: "fresh",
          cacheKey: record.cacheKey,
          fetchedAt: record.fetchedAt,
          expiresAt: record.expiresAt,
          staleUntil: record.staleUntil,
        },
      },
    });
    const stale = await syntheticOptionPageJson({
      record,
      unitKey: onePieceSet,
      cursor: null,
      limit: 25,
      now: syntheticCaptureStartedAt,
    });
    expect(decodeScrydexCacheCaptureOptionPage(stale, { cursor: null })).toMatchObject({
      ok: true,
      page: { cache: { status: "stale" } },
    });
    await expect(
      syntheticOptionPageJson({
        record,
        unitKey: onePieceSet,
        cursor: null,
        limit: 25,
        now: "2026-10-21T06:00:01.000Z",
      }),
    ).rejects.toThrow(/cache is empty for cache-only mode/);
  });

  it.each<[string, (json: unknown) => void, string]>([
    ["a live provider read", (json) => (nodeAt(json, "cache").source = "live"), "option-live-read"],
    ["a forced refresh", (json) => (nodeAt(json, "cache").forceRefresh = true), "option-not-cache-only"],
    ["a page that was not cache-only", (json) => (nodeAt(json, "cache").cacheOnly = false), "option-not-cache-only"],
    ["a cache miss", (json) => (nodeAt(json, "cache").status = "miss"), "option-cache-status"],
    ["a bypass", (json) => (nodeAt(json, "cache").status = "bypass"), "option-cache-status"],
    ["an unexpected cursor", (json) => (nodeAt(json, "page").cursor = "offset:25"), "option-page-malformed"],
    [
      "an item from another provider",
      (json) => (nodeAt(json, "items", 0).providerKey = "tcgplayer"),
      "option-page-malformed",
    ],
    ["an item from another query", (json) => (nodeAt(json, "items", 0).queryKind = "cards"), "option-page-malformed"],
    ["a count that disagrees with the items", (json) => (nodeAt(json).count = 7), "option-page-malformed"],
    ["hasMore without a next cursor", (json) => (nodeAt(json, "page").hasMore = true), "option-page-malformed"],
    [
      "freshness out of order",
      (json) => {
        const cache = nodeAt(json, "cache");
        cache.staleUntil = String(cache.fetchedAt).replace("06:00", "05:00");
      },
      "option-page-malformed",
    ],
    ["a missing cache key", (json) => (nodeAt(json, "cache").cacheKey = ""), "option-page-malformed"],
  ])("refuses %s", async (_name, mutate, reason) => {
    const record = await syntheticOptionCacheRecord({ unitKey: lorcanaSet, expansionIds: [lorcanaExpansion] });
    const json = await syntheticOptionPageJson({
      record,
      unitKey: lorcanaSet,
      cursor: null,
      limit: 25,
      now: syntheticCaptureStartedAt,
    });
    expect(decodeScrydexCacheCaptureOptionPage(json, { cursor: null }).ok).toBe(true);
    mutate(json);
    expect(decodeScrydexCacheCaptureOptionPage(json, { cursor: null })).toEqual({ ok: false, reason });
  });
});

describe("request fence", () => {
  it("admits only the sign-in exchange before the capture starts", () => {
    expect(
      classify("GET", "/access/sign-in?returnTo=%2Fcatalog%2Fscopes%2Fsync-batches", "sign-in", true),
    ).toMatchObject({
      allowed: true,
      requestClass: "sign-in",
    });
    expect(classify("POST", "/access/sign-in", "sign-in")).toMatchObject({ allowed: true, requestClass: "sign-in" });
    expect(classify("GET", "/catalog/scopes/sync-batches", "sign-in", true)).toMatchObject({ allowed: true });
    expect(classify("GET", "/assets/entry.client-abc.js", "sign-in")).toMatchObject({ allowed: true });
    for (const [method, path, navigation] of [
      ["GET", "/catalog/integrations?providerKey=scrydex", true],
      ["GET", "/catalog/providers/scrydex", true],
      ["GET", "/api/catalog/scope-records", false],
      ["GET", "/assets/entry.js?forceRefresh=true", false],
      ["GET", "/catalog/scopes/sync-batches.data?intent=run-provider-refresh", false],
      ["POST", "/catalog/providers/scrydex", false],
      ["PUT", "/access/sign-in", false],
    ] as const) {
      expect(classify(method, path, "sign-in", navigation), `${method} ${path}`).toMatchObject({
        allowed: false,
        requestClass: "fence-refused",
      });
    }
  });

  it("admits exactly the cache-only capture reads after sign-in and refuses auth-shaped mutations", () => {
    expect(classify("GET", "/api/catalog/source-observations/provider-profiles", "capture")).toMatchObject({
      allowed: true,
      requestClass: "profile-read",
    });
    expect(classify("GET", scrydexCacheCaptureScopePagePath("one-piece", 200), "capture")).toMatchObject({
      allowed: true,
      requestClass: "scope-inventory-read",
    });
    expect(classify("GET", scrydexCacheCaptureCoveragePath("synthetic-op-scope-1"), "capture")).toMatchObject({
      allowed: true,
      requestClass: "coverage-read",
    });
    expect(classify("GET", optionHref(onePieceSealed), "capture")).toMatchObject({
      allowed: true,
      requestClass: "cache-option-read",
    });
    expect(
      classify("GET", scrydexCacheCaptureContinuationPath(optionHref(lorcanaCard), "offset:25"), "capture"),
    ).toMatchObject({
      allowed: true,
      requestClass: "cache-option-read",
    });
    expect(classify("GET", "/catalog/scopes/sync-batches.data", "capture")).toMatchObject({
      allowed: false,
      requestClass: "ambient-read-blocked",
    });
    for (const [method, path] of [
      ["POST", "/access/sign-out"],
      ["POST", "/access/sign-in"],
      ["POST", "/api/catalog/scope-sync-batches/preview"],
      ["GET", optionHref(onePieceSet, { forceRefresh: "true" })],
      ["GET", optionHref(onePieceSet).replace("&cacheOnly=true", "")],
      ["GET", optionHref(onePieceSet, { parentValue: onePieceExpansion })],
      ["GET", optionHref(onePieceSet, { queryKind: "cards" })],
      ["GET", optionHref(onePieceSet).replace("providerKey=scrydex", "providerKey=tcgplayer")],
      [
        "GET",
        optionHref(onePieceSet, { ingestionUnitKey: "scrydex:lorcana:sealed-product:source-observation-import" }),
      ],
      ["GET", `${optionHref(onePieceSet)}&cacheOnly=true`],
      ["GET", optionHref(onePieceSet, { cursor: "page-2" })],
      ["GET", `${scrydexCacheCaptureScopePagePath("one-piece", 0)}&search=romance`],
      ["GET", scrydexCacheCaptureScopePagePath("pokemon" as never, 0)],
      ["GET", "/api/catalog/provider-scope-mappings/inbox"],
      ["GET", "/api/catalog/source-observations/provider-profiles?providerKey=scrydex"],
      ["GET", "https://www.tcgplayer.com/"],
      ["GET", "/catalog/providers/tcgplayer"],
      ["GET", "https://api.scrydex.com/onepiece/v1/expansions"],
    ] as const) {
      expect(classify(method, path, "capture"), `${method} ${path}`).toMatchObject({
        allowed: false,
        requestClass: "fence-refused",
      });
    }
  });

  it("accepts only a first-page cache-only Scrydex sets href for a declared unit", () => {
    expect(scrydexCacheCaptureQueryHrefUnit(optionHref(lorcanaSet))).toBe(lorcanaSet);
    expect(scrydexCacheCaptureQueryHrefUnit(optionHref(lorcanaSet, { cursor: "offset:25" }))).toBeNull();
    expect(scrydexCacheCaptureQueryHrefUnit(optionHref(lorcanaSet, { forceRefresh: "true" }))).toBeNull();
    expect(scrydexCacheCaptureQueryHrefUnit(`https://elsewhere.invalid${optionHref(lorcanaSet)}`)).toBeNull();
  });

  it("continues from the deployed href exactly as the Integrations loader does", () => {
    const next = new URL(
      scrydexCacheCaptureContinuationPath(optionHref(onePieceSet), "offset:25"),
      scrydexCacheCaptureOrigin,
    );
    expect(Object.fromEntries(next.searchParams)).toEqual({
      providerKey: "scrydex",
      queryKind: "sets",
      limit: "200",
      profileKey: registryProfileKey(onePieceSet),
      ingestionUnitKey: onePieceSet,
      languageCode: "en",
      cacheOnly: "true",
      cursor: "offset:25",
    });
  });
});

describe("planner coordinate", () => {
  it("uses the accepted mapping's setId, then setName, through the planner's own normalization", () => {
    const mapping = {
      mappingId: "synthetic-map",
      unitKey: onePieceSet,
      reviewStatus: "accepted" as const,
      version: "2026-10-03T00:00:00.000Z",
    };
    expect(
      scrydexCacheCaptureCoordinate({ ...mapping, setId: null, setName: ` ${onePieceExpansion} ` }, "synthetic-scope"),
    ).toBe(onePieceExpansion);
    expect(
      scrydexCacheCaptureCoordinate({ ...mapping, setId: " ", setName: onePieceExpansion }, "synthetic-scope"),
    ).toBe(onePieceExpansion);
    expect(
      scrydexCacheCaptureCoordinate(
        { ...mapping, setId: "synthetic-set-id", setName: onePieceExpansion },
        "synthetic-scope",
      ),
    ).toBe("synthetic-set-id");
    expect(scrydexCacheCaptureCoordinate({ ...mapping, setId: null, setName: "  " }, "synthetic-scope")).toBeNull();
  });
});

// --- Receipt ----------------------------------------------------------------

const generation = {
  runId: "9000000001",
  runAttempt: 1,
  jobId: "9000000002",
  jobCompletedAt: "2026-10-20T15:00:00Z",
  deployedHead: "b".repeat(40),
  imageDigest: `sha256:${hash("c")}`,
};

function completeEvidence(): ScrydexCacheCaptureEvidence {
  const values = {
    "one-piece": [onePieceExpansion, "synthetic-op-02"],
    lorcana: [lorcanaExpansion],
  } as const;
  const units = scrydexCacheCaptureUnits.map(({ productDomain, unitKey }, index) => ({
    productDomain,
    unitKey,
    profileKey: registryProfileKey(unitKey),
    queryHref: optionHref(unitKey),
    cache: {
      status: "stale" as const,
      cacheKey: `sha256:${hash(String(index))}`,
      fetchedAt: syntheticCacheFetchedAt,
      expiresAt: "2026-10-20T06:15:00.000Z",
      staleUntil: "2026-10-21T06:00:00.000Z",
    },
    pages: [
      {
        cursor: null,
        nextCursor: null,
        count: values[productDomain].length,
        total: values[productDomain].length,
        completedAt: "2026-10-20T16:00:01.000Z",
        responseSha256: hash("d"),
      },
    ],
    values: [...values[productDomain]],
  }));
  const mapping = (unitKey: string, mappingId: string, setName: string) => ({
    mappingId,
    unitKey,
    reviewStatus: "accepted" as const,
    version: "2026-10-03T00:00:00.000Z",
    setId: null,
    setName,
  });
  return {
    runner: {
      sha: "a".repeat(40),
      runId: "123456",
      runAttempt: "1",
      journeyScope: "scrydex-cache-capture",
      origin: "admin.staging.chasesets.com",
    },
    deployment: { before: generation, after: generation, beforeStop: null, afterStop: null },
    startedAt: syntheticCaptureStartedAt,
    finishedAt: "2026-10-20T16:00:30.000Z",
    requests: {
      signIn: 4,
      profileReads: 1,
      scopeInventoryReads: 2,
      coverageReads: 2,
      cacheOptionReads: 5,
      ambientReadsBlocked: 1,
      fenceRefusals: 0,
    },
    reads: { profileReads: 1, scopeInventoryReads: 2, coverageReads: 2, cacheOptionReads: 5 },
    fence: [],
    profileRead: { completedAt: "2026-10-20T16:00:00.500Z", responseSha256: hash("e") },
    scopeInventories: [
      {
        productDomain: "one-piece",
        total: 1,
        scopeRecordIds: ["synthetic-op-scope-1"],
        pages: [{ offset: 0, count: 1, completedAt: "2026-10-20T16:00:05.000Z", responseSha256: hash("f") }],
      },
      {
        productDomain: "lorcana",
        total: 1,
        scopeRecordIds: ["synthetic-l-scope-1"],
        pages: [{ offset: 0, count: 1, completedAt: "2026-10-20T16:00:06.000Z", responseSha256: hash("f") }],
      },
    ],
    scopes: [
      {
        scopeRecordId: "synthetic-op-scope-1",
        productDomain: "one-piece",
        completedAt: "2026-10-20T16:00:07.000Z",
        responseSha256: hash("1"),
        mappings: [
          mapping(onePieceSet, "synthetic-map-op-set", onePieceExpansion),
          mapping(onePieceCard, "synthetic-map-op-card", onePieceExpansion),
          mapping(onePieceSealed, "synthetic-map-op-sealed", "synthetic-not-in-cache"),
        ],
      },
      {
        scopeRecordId: "synthetic-l-scope-1",
        productDomain: "lorcana",
        completedAt: "2026-10-20T16:00:08.000Z",
        responseSha256: hash("2"),
        mappings: [
          mapping(lorcanaSet, "synthetic-map-l-set", lorcanaExpansion),
          mapping(lorcanaCard, "synthetic-map-l-card", lorcanaExpansion),
        ],
      },
    ],
    units,
    failures: [],
  };
}

describe("Scrydex cache capture receipt", () => {
  it("derives a complete capture, with member and non-member mappings, only from complete evidence", () => {
    const receipt = buildScrydexCacheCaptureReceipt(completeEvidence());
    expect(receipt.captureStatus).toBe("complete");
    expect(receipt.reasons).toEqual([]);
    expect(receipt.scopes[0]!.mappings.map(({ coordinate, membership }) => [coordinate, membership])).toEqual([
      [onePieceExpansion, "member"],
      [onePieceExpansion, "member"],
      ["synthetic-not-in-cache", "non-member"],
    ]);
    expect(validateScrydexCacheCaptureReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual([]);
  });

  it.each<[string, (evidence: ScrydexCacheCaptureEvidence) => void, string]>([
    [
      "a response completing within the skew window before staleUntil",
      (e) => (e.units[0]!.pages[0]!.completedAt = "2026-10-21T05:59:30.000Z"),
      `option-list-late:${onePieceSet}`,
    ],
    [
      "a truncated continuation",
      (e) => (e.units[1]!.pages[0]!.nextCursor = "offset:2"),
      `option-list-incomplete:${onePieceCard}`,
    ],
    [
      "values short of the cached total",
      (e) => (e.units[2]!.pages[0]!.total = 3),
      `option-list-incomplete:${onePieceSealed}`,
    ],
    [
      "a skipped continuation page",
      (e) => e.units[3]!.pages.push({ ...e.units[3]!.pages[0]!, cursor: "offset:5" }),
      `option-list-incomplete:${lorcanaSet}`,
    ],
    ["a missing unit option list", (e) => e.units.splice(4, 1), `option-list-missing:${lorcanaCard}`],
    [
      "a declared unit without any accepted mapping",
      (e) => e.scopes[1]!.mappings.splice(1, 1),
      `required-unit-unmapped:${lorcanaCard}`,
    ],
    [
      "an accepted mapping for an undeclared unit",
      (e) => (e.scopes[1]!.mappings[1]!.unitKey = "scrydex:lorcana:sealed-product:source-observation-import"),
      "undeclared-unit:scrydex:lorcana:sealed-product:source-observation-import",
    ],
    [
      "two mappings for one unit on one Scope Record",
      (e) => e.scopes[1]!.mappings.push({ ...e.scopes[1]!.mappings[0]!, mappingId: "synthetic-map-l-set-2" }),
      "mapping-duplicate:synthetic-l-scope-1",
    ],
    [
      "a deployment that changed during capture",
      (e) => (e.deployment.after = { ...generation, deployedHead: "e".repeat(40) }),
      "deployment-changed",
    ],
    [
      "an unbound closing deployment",
      (e) => ((e.deployment.after = null), (e.deployment.afterStop = "deploy-in-progress")),
      "deployment-unbound:after:deploy-in-progress",
    ],
    [
      "a deployment completing after the capture started",
      (e) => (
        (e.deployment.before = { ...generation, jobCompletedAt: "2026-10-20T16:00:10Z" }),
        (e.deployment.after = e.deployment.before)
      ),
      "deployment-not-settled",
    ],
    [
      "a refused request",
      (e) => (
        (e.requests.fenceRefusals = 1),
        e.fence.push({ method: "POST", path: "/access/sign-out", reason: "mutation" })
      ),
      "fence-refused",
    ],
    [
      "an option read the browser never observed",
      (e) => (e.requests.cacheOptionReads = 4),
      "request-accounting-mismatch:cache-option-read",
    ],
    [
      "an incomplete Scope Record inventory",
      (e) => (e.scopeInventories[0]!.total = 2),
      "scope-inventory-incomplete:one-piece",
    ],
    ["an inventoried Scope Record without coverage", (e) => e.scopes.splice(1, 1), "coverage-incomplete:lorcana"],
    ["a runtime failure", (e) => e.failures.push("sign-in-failed"), "sign-in-failed"],
  ])("keeps %s governed unknown", (_name, mutate, reason) => {
    const evidence = completeEvidence();
    mutate(evidence);
    const receipt = buildScrydexCacheCaptureReceipt(evidence);
    expect(receipt.captureStatus).toBe("governed-unknown");
    expect(receipt.reasons).toContain(reason);
    expect(validateScrydexCacheCaptureReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual([]);
  });

  it("marks membership unreadable, never member, when the unit's option list is incomplete", () => {
    const evidence = completeEvidence();
    evidence.units[0]!.pages[0] = { ...evidence.units[0]!.pages[0]!, completedAt: "2026-10-21T06:00:00.000Z" };
    const receipt = buildScrydexCacheCaptureReceipt(evidence);
    expect(receipt.scopes[0]!.mappings[0]).toMatchObject({ unitKey: onePieceSet, membership: "unreadable" });
  });

  it.each<[string, (receipt: unknown) => void]>([
    [
      "a hand-set complete status over governed-unknown evidence",
      (r) => (
        (nodeAt(r, "units", 0, "pages", 0).completedAt = "2026-10-21T06:00:00.000Z"),
        (nodeAt(r).captureStatus = "complete")
      ),
    ],
    ["reasons that differ from the evidence", (r) => listAt(r, "reasons").push("synthetic-reason")],
    ["a hand-set membership", (r) => (nodeAt(r, "scopes", 0, "mappings", 2).membership = "member")],
    ["a hand-set coordinate", (r) => (nodeAt(r, "scopes", 0, "mappings", 0).coordinate = "synthetic-other")],
    ["an unknown field", (r) => (nodeAt(r, "units", 0).rawPayload = {})],
    ["an unknown nested field", (r) => (nodeAt(r, "deployment", "before").extra = true)],
    ["a timestamp without a zone", (r) => (nodeAt(r).startedAt = "2026-10-20T16:00:00")],
    ["a negative request count", (r) => (nodeAt(r, "requests").coverageReads = -1)],
    ["a malformed response digest", (r) => (nodeAt(r, "units", 0, "pages", 0).responseSha256 = "not-a-digest")],
    ["another schema version", (r) => (nodeAt(r).schemaVersion = "scrydex-cache-capture/v0")],
    ["a stop without an unbound deployment", (r) => (nodeAt(r, "deployment").beforeStop = "deploy-in-progress")],
    ["a non-array scope list", (r) => (nodeAt(r).scopes = {})],
  ])("validation refuses %s", (_name, mutate) => {
    const receipt = JSON.parse(JSON.stringify(buildScrydexCacheCaptureReceipt(completeEvidence())));
    mutate(receipt);
    expect(validateScrydexCacheCaptureReceipt(receipt).length).toBeGreaterThan(0);
  });
});
