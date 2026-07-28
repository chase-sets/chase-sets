import { describe, expect, it } from "vitest";

import { scrydexOnePieceSealedProductSourceObservationMappingContract } from "../scrydex-one-piece-executable-mapping-contract";
import { normalizeCatalogProviderSourceObservation } from "../promotion/provider-source-observation-normalizer";
import type { ProviderPayloadEnvelope } from "./provider-adapter";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  type ScrydexOnePieceProviderPayload,
} from "./scrydex-one-piece";

const fixtureBaseUrl = "https://fixture.chase-sets.local/scrydex/onepiece/v1";
const fixtureLorcanaBaseUrl = fixtureBaseUrl.replace("/onepiece/v1", "/lorcana/v1");
const fixtureAccountBaseUrl = fixtureBaseUrl.replace("/onepiece/v1", "/account/v1");
const fixtureCredentials = { apiKey: "api-key-fixture", teamId: "team-id-fixture" };
const fixtureNow = new Date("2026-06-22T00:00:00.000Z");

describe("Scrydex One Piece provider adapter", () => {
  it("exposes the expected One Piece provider-adapter units", async () => {
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: scrydexFixtureFetch().fetch,
      now: () => fixtureNow,
    });

    await expect(adapter.listIntegrationUnits()).resolves.toEqual([
      expect.objectContaining({
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "scrydex",
        productDomain: "one-piece",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
      expect.objectContaining({
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "scrydex",
        productDomain: "one-piece",
        productForm: "set",
        ingestionPurpose: "reference-data",
      }),
      expect.objectContaining({
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "scrydex",
        productDomain: "one-piece",
        productForm: "sealed-product",
        ingestionPurpose: "source-observation-import",
      }),
      expect.objectContaining({
        unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "scrydex",
        productDomain: "lorcana",
        productForm: "single-card",
        ingestionPurpose: "source-observation-import",
      }),
      expect.objectContaining({
        unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "scrydex",
        productDomain: "lorcana",
        productForm: "set",
        ingestionPurpose: "reference-data",
      }),
    ]);
  });

  it("reports missing credentials as import and option-query blocking", async () => {
    const adapter = createScrydexOnePieceProviderAdapter({
      baseUrl: fixtureBaseUrl,
      fetch: scrydexFixtureFetch().fetch,
      now: () => fixtureNow,
    });
    const plan = await adapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { expansionId: "op-01" },
    });

    await expect(
      adapter.listOptions({
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        optionKind: "expansions",
      }),
    ).rejects.toThrow("Shared Scrydex credentials are required");
    await expect(collectPayloads(adapter.fetchPayloads(plan))).rejects.toThrow(
      "Shared Scrydex credentials are required",
    );
    await expect(adapter.getCredentialReadiness()).resolves.toEqual([
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        requirement: "required",
        state: "missing",
        importBlocking: true,
        optionQueryBlocking: true,
        diagnosticCode: "credential-missing",
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        requirement: "required",
        state: "missing",
        importBlocking: true,
        optionQueryBlocking: true,
        diagnosticCode: "credential-missing",
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        requirement: "required",
        state: "missing",
        importBlocking: true,
        optionQueryBlocking: true,
        diagnosticCode: "credential-missing",
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        requirement: "required",
        state: "missing",
        importBlocking: true,
        optionQueryBlocking: true,
        diagnosticCode: "credential-missing",
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        requirement: "required",
        state: "missing",
        importBlocking: true,
        optionQueryBlocking: true,
        diagnosticCode: "credential-missing",
      }),
    ]);
  });

  it("reports configured credentials with redacted evidence and diagnostics", async () => {
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: scrydexFixtureFetch().fetch,
      now: () => fixtureNow,
    });
    const readiness = await adapter.getCredentialReadiness();
    const diagnostics = await adapter.getTransportDiagnostics();
    const serialized = JSON.stringify({ readiness, diagnostics });

    expect(readiness).toEqual([
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        state: "configured",
        importBlocking: false,
        optionQueryBlocking: false,
        evidence: expect.objectContaining({
          credentialRequirement: "required",
          credentialState: "configured",
          apiKeyConfigured: true,
          teamIdConfigured: true,
          requiredHeaders: {
            "X-Api-Key": "[redacted-provider-credential]",
            "X-Team-ID": "[redacted-provider-credential]",
          },
        }),
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        state: "configured",
        importBlocking: false,
        optionQueryBlocking: false,
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        state: "configured",
        importBlocking: false,
        optionQueryBlocking: false,
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        state: "configured",
        importBlocking: false,
        optionQueryBlocking: false,
      }),
      expect.objectContaining({
        providerKey: "scrydex",
        unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        state: "configured",
        importBlocking: false,
        optionQueryBlocking: false,
      }),
    ]);
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "scrydex-credentials-configured",
          severity: "info",
        }),
        expect.objectContaining({
          code: "scrydex-one-piece-bulk-first-transport-configured",
          unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        }),
        expect.objectContaining({
          code: "scrydex-lorcana-bulk-first-transport-configured",
          unitKey: SCRYDEX_LORCANA_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        }),
        expect.objectContaining({
          code: "scrydex-account-usage-checked",
          severity: "info",
        }),
        expect.objectContaining({
          code: "scrydex-account-usage-stale-window",
          severity: "info",
        }),
        expect.objectContaining({
          code: "scrydex-one-piece-price-history-source-authority-gated",
          severity: "info",
        }),
      ]),
    );
    expect(serialized).not.toContain(fixtureCredentials.apiKey);
    expect(serialized).not.toContain(fixtureCredentials.teamId);
    expect(serialized).toContain("[redacted-provider-credential]");
  });

  it("serves option queries through bulk/list endpoints with max page sizes", async () => {
    const fixture = scrydexFixtureFetch();
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });

    const expansions = await adapter.listOptions({
      unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      optionKind: "expansions",
    });
    const cards = await adapter.listOptions({
      unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      optionKind: "cards",
      parentValues: { expansionId: "op-01" },
    });
    const sealed = await adapter.listOptions({
      unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      optionKind: "sealed-products",
      parentValues: { expansionId: "op-01" },
    });

    expect(expansions.items).toEqual([
      {
        value: "op-01",
        label: "Romance Dawn",
        metadata: {
          expansionId: "op-01",
          code: "OP-01",
          total: "121",
          releaseDate: "2022-12-02",
          language: "English",
          languageCode: "en",
        },
      },
    ]);
    expect(cards.items.map((item) => item.value)).toEqual(["op01-001", "op01-002", "op01-003"]);
    expect(sealed.items).toEqual([
      expect.objectContaining({
        value: "op01-booster-box",
        label: "Romance Dawn Booster Box",
        parentValue: "op-01",
        metadata: expect.objectContaining({ expansionId: "op-01", type: "booster_box" }),
      }),
    ]);
    expect(fixture.calls.map((call) => endpoint(call.url))).toEqual([
      "/expansions",
      "/cards",
      "/cards",
      "/expansions/op-01/sealed",
    ]);
    expect(fixture.calls.map((call) => search(call.url, "page_size"))).toEqual(["100", "250", "250", "100"]);
    expect(fixture.calls.map((call) => search(call.url, "select"))).toEqual([
      "id,name,code,total,release_date,language,language_code",
      "id,name,number,printed_number,rarity,rarity_code,type,images,language,language_code,expansion,printings,variants",
      "id,name,number,printed_number,rarity,rarity_code,type,images,language,language_code,expansion,printings,variants",
      "id,name,type,images,language,language_code,expansion",
    ]);
    expect(fixture.calls.map((call) => search(call.url, "q"))).toEqual([
      null,
      "printings:op-01",
      "printings:op-01",
      null,
    ]);
    expect(fixture.calls.every((call) => call.apiKey === fixtureCredentials.apiKey)).toBe(true);
    expect(fixture.calls.every((call) => call.teamId === fixtureCredentials.teamId)).toBe(true);
    expect(fixture.calls.map((call) => endpoint(call.url))).not.toEqual(
      expect.arrayContaining(["/cards/op01-001", "/sealed/op01-booster-box", "/expansions/op-01"]),
    );
  });

  it("paginates set-scoped card and sealed fetches without per-item calls", async () => {
    const fixture = scrydexFixtureFetch();
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });
    const cardPlan = await adapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { expansionId: "op-01" },
    });
    const sealedPlan = await adapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { expansionId: "op-01" },
    });
    const progress: unknown[] = [];
    const payloads = [
      ...(await collectPayloads(
        adapter.fetchPayloads(cardPlan, {
          onProgress: (event) => {
            progress.push(event);
          },
        }),
      )),
      ...(await collectPayloads(adapter.fetchPayloads(sealedPlan))),
    ];

    expect(cardPlan).toMatchObject({
      planKey: "scrydex:one-piece:expansion:op-01:cards",
      transportSteps: [
        "Search Scrydex One Piece cards by printings set with max page size",
        "Sanitize card payloads",
        "Attach payload provenance",
      ],
      usageEstimate: {
        requestStrategy: "bulk-first",
        estimateState: "estimate-unavailable",
        estimatedRequestCount: null,
        estimateReason:
          "Card page count is available only after the first Scrydex paged search response; set imports use q=printings:<set> to include reprints.",
        pageSize: 250,
        selectedFields: [
          "id",
          "name",
          "number",
          "printed_number",
          "rarity",
          "rarity_code",
          "type",
          "images",
          "language",
          "language_code",
          "expansion",
          "printings",
          "variants",
        ],
        perRecordFallbackReason: null,
        usageCheckState: "checked",
      },
    });
    expect(sealedPlan).toMatchObject({
      planKey: "scrydex:one-piece:expansion:op-01:sealed",
      transportSteps: [
        "Fetch Scrydex One Piece expansion sealed products with max page size",
        "Sanitize sealed-product payloads",
        "Attach payload provenance",
      ],
      usageEstimate: {
        requestStrategy: "bulk-first",
        estimateState: "estimate-unavailable",
        estimatedRequestCount: null,
        estimateReason: "Sealed-product page count is available only after the first Scrydex paged response.",
        pageSize: 100,
        selectedFields: ["id", "name", "type", "images", "language", "language_code", "expansion"],
        perRecordFallbackReason: null,
        usageCheckState: "checked",
      },
    });
    expect(payloads.map((payload) => payload.externalKey)).toEqual([
      "card:op01-001",
      "card:op01-002",
      "card:op01-003",
      "sealed:op01-booster-box",
    ]);
    expect(progress).toEqual([
      { phase: "fetching", completed: 1, total: 3, currentLabel: "Monkey.D.Luffy" },
      { phase: "fetching", completed: 2, total: 3, currentLabel: "Trafalgar Law" },
      { phase: "fetching", completed: 3, total: 3, currentLabel: "Nami" },
    ]);
    expect(fixture.calls.map((call) => endpoint(call.url))).toEqual([
      "/scrydex/account/v1/usage",
      "/scrydex/account/v1/usage",
      "/cards",
      "/cards",
      "/expansions/op-01/sealed",
    ]);
    expect(fixture.calls.map((call) => endpoint(call.url))).not.toEqual(
      expect.arrayContaining(["/cards/op01-001", "/cards/op01-002", "/cards/op01-003", "/sealed/op01-booster-box"]),
    );
    expect(
      fixture.calls.filter((call) => endpoint(call.url) === "/cards").map((call) => search(call.url, "q")),
    ).toEqual(["printings:op-01", "printings:op-01"]);
  });

  it("fetches explicit set reference-data through the expansion single endpoint", async () => {
    const fixture = scrydexFixtureFetch();
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });
    const progress: unknown[] = [];
    const plan = await adapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-reference",
      values: { expansionId: "op-01" },
    });
    const payloads = await collectPayloads(
      adapter.fetchPayloads(plan, {
        onProgress: (event) => {
          progress.push(event);
        },
      }),
    );

    expect(plan).toMatchObject({
      unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      planKey: "scrydex:one-piece:set:op-01",
      estimatedPayloads: 1,
      transportSteps: [
        "Fetch Scrydex One Piece expansion by id",
        "Sanitize set reference payload",
        "Attach payload provenance",
      ],
      usageEstimate: {
        requestStrategy: "single-record",
        estimateState: "estimated",
        estimatedRequestCount: 1,
        perRecordFallbackReason: "Selected set-reference import uses the Scrydex expansion detail endpoint.",
        usageCheckState: "checked",
      },
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
        providerKey: "scrydex",
        externalKey: "set:op-01",
        payload: {
          kind: "one-piece-set-reference",
          expansion: scrydexExpansion,
          sourceUrl: "https://fixture.chase-sets.local/scrydex/onepiece/v1/expansions/op-01",
        },
        provenance: expect.objectContaining({
          sourceUrl: "https://fixture.chase-sets.local/scrydex/onepiece/v1/expansions/op-01",
          sourceUpdatedAt: "2022-12-02",
          fetchedAt: "2026-06-22T00:00:00.000Z",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(progress).toEqual([{ phase: "fetching", completed: 1, total: 1, currentLabel: "Romance Dawn" }]);
    expect(fixture.calls.map((call) => endpoint(call.url))).toEqual(["/scrydex/account/v1/usage", "/expansions/op-01"]);
    expect(JSON.stringify(payloads)).not.toMatch(/price|seller|api-key-fixture|team-id-fixture|X-Api-Key/i);
  });

  it("unwraps Scrydex Lorcana set-reference detail envelopes", async () => {
    const detailUrl = `${fixtureLorcanaBaseUrl}/expansions/TFC`;
    const fixture = scrydexResponseFixtureFetch({
      [`${fixtureAccountBaseUrl}/usage`]: scrydexUsageResponse,
      [detailUrl]: {
        data: {
          ...scrydexLorcanaExpansion,
          market_price: "199.99",
          seller: { account: "not-catalog-truth" },
        },
      },
    });
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });
    const plan = await adapter.planImport({
      unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-reference",
      values: { expansionId: "TFC" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));

    expect(plan).toMatchObject({
      unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      planKey: "scrydex:lorcana:set:tfc",
      usageEstimate: {
        requestStrategy: "single-record",
        estimatedRequestCount: 1,
        perRecordFallbackReason: "Selected set-reference import uses the Scrydex expansion detail endpoint.",
      },
    });
    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        externalKey: "set:TFC",
        payload: {
          kind: "lorcana-set-reference",
          expansion: scrydexLorcanaExpansion,
          sourceUrl: detailUrl,
        },
        provenance: expect.objectContaining({
          sourceUrl: detailUrl,
          sourceUpdatedAt: "2023-08-18",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
      }),
    ]);
    expect(fixture.calls.map((call) => call.url)).toEqual([`${fixtureAccountBaseUrl}/usage`, detailUrl]);
    expect(JSON.stringify(payloads)).not.toMatch(/price|seller|api-key-fixture|team-id-fixture|X-Api-Key/i);
  });

  it("resolves code-selected Scrydex Lorcana set-reference imports through the bulk expansion list", async () => {
    const detailUrl = `${fixtureLorcanaBaseUrl}/expansions/TFC`;
    const listUrl = `${fixtureLorcanaBaseUrl}/expansions?page=1&page_size=100&select=id%2Cname%2Ccode%2Ctotal%2Crelease_date%2Clanguage%2Clanguage_code`;
    const fixture = scrydexResponseFixtureFetch({
      [`${fixtureAccountBaseUrl}/usage`]: scrydexUsageResponse,
      [listUrl]: { data: [{ ...scrydexLorcanaExpansion, id: "1" }], total_pages: 1 },
    });
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });
    const plan = await adapter.planImport({
      unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
      scopeKey: "set-reference",
      values: { expansionId: "TFC" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));

    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: SCRYDEX_LORCANA_SET_REFERENCE_DATA_UNIT_KEY,
        externalKey: "set:1",
        payload: {
          kind: "lorcana-set-reference",
          expansion: { ...scrydexLorcanaExpansion, id: "1" },
          sourceUrl: listUrl,
        },
      }),
    ]);
    expect(fixture.calls.map((call) => call.url)).toEqual([`${fixtureAccountBaseUrl}/usage`, detailUrl, listUrl]);
  });

  it("resolves code-selected Scrydex Lorcana sealed imports through the bulk expansion list before paging sealed products", async () => {
    const selectedCodeSealedUrl = `${fixtureLorcanaBaseUrl}/expansions/TFC/sealed?page=1&page_size=100&select=id%2Cname%2Ctype%2Cimages%2Clanguage%2Clanguage_code%2Cexpansion`;
    const listUrl = `${fixtureLorcanaBaseUrl}/expansions?page=1&page_size=100&select=id%2Cname%2Ccode%2Ctotal%2Crelease_date%2Clanguage%2Clanguage_code`;
    const resolvedIdSealedUrl = `${fixtureLorcanaBaseUrl}/expansions/1/sealed?page=1&page_size=100&select=id%2Cname%2Ctype%2Cimages%2Clanguage%2Clanguage_code%2Cexpansion`;
    const fixture = scrydexResponseFixtureFetch({
      [`${fixtureAccountBaseUrl}/usage`]: scrydexUsageResponse,
      [listUrl]: { data: [{ ...scrydexLorcanaExpansion, id: "1" }], total_pages: 1 },
      [resolvedIdSealedUrl]: { data: [scrydexLorcanaSealedProduct], total_pages: 1 },
    });
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });
    const plan = await adapter.planImport({
      unitKey: SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { expansionId: "TFC" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));

    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: SCRYDEX_LORCANA_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "sealed:tfc-booster-box",
        payload: {
          kind: "lorcana-sealed-product",
          sealedProduct: scrydexLorcanaSealedProduct,
          sourceUrl: resolvedIdSealedUrl,
        },
      }),
    ]);
    expect(fixture.calls.map((call) => call.url)).toEqual([
      `${fixtureAccountBaseUrl}/usage`,
      selectedCodeSealedUrl,
      listUrl,
      resolvedIdSealedUrl,
    ]);
  });

  it("normalizes OP-code sealed rows when Scrydex wraps the product and omits a display name", async () => {
    const selectedCodeSealedUrl = `${fixtureBaseUrl}/expansions/OP16/sealed?page=1&page_size=100&select=id%2Cname%2Ctype%2Cimages%2Clanguage%2Clanguage_code%2Cexpansion`;
    const fixture = scrydexResponseFixtureFetch({
      [`${fixtureAccountBaseUrl}/usage`]: scrydexUsageResponse,
      [selectedCodeSealedUrl]: {
        status: "success",
        data: [
          {
            sealedProduct: {
              id: "OP16-s1",
              type: "Booster Box",
              images: ["https://images.scrydex.example/onepiece/OP16-s1/large"],
              expansion: {
                id: "OP16",
                name: "The Time Of Battle",
                code: "OP16",
                release_date: "2026/06/12",
                language: "English",
                language_code: "EN",
              },
              language: "English",
              languageCode: "EN",
            },
          },
        ],
        page: 1,
        pageSize: 100,
        totalCount: 1,
      },
    });
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });
    const plan = await adapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { expansionId: "OP16" },
    });
    const payloads = await collectPayloads(adapter.fetchPayloads(plan));
    const payload = payloads[0]?.payload;

    expect(payloads).toEqual([
      expect.objectContaining({
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "sealed:OP16-s1",
        payload: {
          kind: "one-piece-sealed-product",
          sealedProduct: expect.objectContaining({
            id: "OP16-s1",
            name: "The Time Of Battle Booster Box",
            type: "Booster Box",
            language_code: "EN",
            imageUrls: ["https://images.scrydex.example/onepiece/OP16-s1/large"],
            expansion: expect.objectContaining({
              id: "OP16",
              name: "The Time Of Battle",
            }),
          }),
          sourceUrl: selectedCodeSealedUrl,
        },
      }),
    ]);
    expect(fixture.calls.map((call) => call.url)).toEqual([`${fixtureAccountBaseUrl}/usage`, selectedCodeSealedUrl]);

    const normalized = normalizeCatalogProviderSourceObservation({
      contract: scrydexOnePieceSealedProductSourceObservationMappingContract,
      payload: payload ?? null,
      observedAt: fixtureNow.toISOString(),
    });

    expect(normalized.diagnostics).toEqual([]);
    expect(normalized.observation).toMatchObject({
      observationId: "scrydex_one_piece_sealed_EN_OP16-s1",
      externalKey: "sealed:OP16-s1",
      normalized: expect.objectContaining({
        kind: "one-piece-sealed-product",
        name: "The Time Of Battle Booster Box",
        tcg: "one-piece",
        sealedProductForm: "sealed-product",
      }),
    });
  });

  it("completes an OP-code sealed import with no payloads when Scrydex has the expansion but no sealed child page", async () => {
    const selectedCodeSealedUrl = `${fixtureBaseUrl}/expansions/OP16/sealed?page=1&page_size=100&select=id%2Cname%2Ctype%2Cimages%2Clanguage%2Clanguage_code%2Cexpansion`;
    const listUrl = `${fixtureBaseUrl}/expansions?page=1&page_size=100&select=id%2Cname%2Ccode%2Ctotal%2Crelease_date%2Clanguage%2Clanguage_code`;
    const fixture = scrydexResponseFixtureFetch({
      [`${fixtureAccountBaseUrl}/usage`]: scrydexUsageResponse,
      [listUrl]: {
        data: [
          {
            id: "OP16",
            name: "The Time Of Battle",
            code: "OP16",
            release_date: "2026/06/12",
            language: "English",
            language_code: "EN",
          },
        ],
        total_pages: 1,
      },
    });
    const adapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: fixture.fetch,
      now: () => fixtureNow,
    });
    const plan = await adapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "expansion",
      values: { expansionId: "OP16" },
    });

    await expect(collectPayloads(adapter.fetchPayloads(plan))).resolves.toEqual([]);
    expect(fixture.calls.map((call) => call.url)).toEqual([
      `${fixtureAccountBaseUrl}/usage`,
      selectedCodeSealedUrl,
      listUrl,
    ]);
  });

  it("emits deterministic external keys and content hashes with sanitized payloads", async () => {
    const firstFixture = scrydexFixtureFetch();
    const secondFixture = scrydexFixtureFetch();
    const firstAdapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: firstFixture.fetch,
      now: () => fixtureNow,
    });
    const secondAdapter = createScrydexOnePieceProviderAdapter({
      credentials: fixtureCredentials,
      baseUrl: fixtureBaseUrl,
      fetch: secondFixture.fetch,
      now: () => fixtureNow,
    });
    const plan = await firstAdapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "single-card",
      values: { cardId: "op01-001" },
    });
    const repeatPlan = await secondAdapter.planImport({
      unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      scopeKey: "single-card",
      values: { cardId: "op01-001" },
    });
    const payload = (await collectPayloads(firstAdapter.fetchPayloads(plan)))[0]!;
    const repeatPayload = (await collectPayloads(secondAdapter.fetchPayloads(repeatPlan)))[0]!;

    expect(payload).toEqual(
      expect.objectContaining({
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        providerKey: "scrydex",
        externalKey: "card:op01-001",
        provenance: expect.objectContaining({
          sourceUrl: "https://fixture.chase-sets.local/scrydex/onepiece/v1/cards/op01-001",
          sourceUpdatedAt: "2022-12-02",
          fetchedAt: "2026-06-22T00:00:00.000Z",
          contentHash: expect.stringMatching(/^sha256:/),
        }),
        payload: {
          kind: "one-piece-card",
          card: {
            id: "op01-001",
            name: "Monkey.D.Luffy",
            number: "001",
            printed_number: "OP01-001",
            rarity: "Leader",
            rarity_code: "L",
            type: "Leader",
            imageUrls: [
              "https://images.scrydex.example/op01-001/large",
              "https://images.scrydex.example/op01-001/medium",
              "https://images.scrydex.example/op01-001/small",
            ],
            language: "English",
            language_code: "en",
            expansion: {
              id: "op-01",
              name: "Romance Dawn",
              code: "OP-01",
              total: 121,
              release_date: "2022-12-02",
              language: "English",
              language_code: "en",
            },
            printings: ["OP-01", "PRB01"],
            variants: [
              { name: "normal", printings: ["OP-01"] },
              { name: "mangaAltArt", printings: ["PRB01"] },
            ],
          },
          sourceUrl: "https://fixture.chase-sets.local/scrydex/onepiece/v1/cards/op01-001",
        },
      }),
    );
    expect(payload.provenance.contentHash).toBe(repeatPayload.provenance.contentHash);
    expect(JSON.stringify(payload)).not.toMatch(/market_price|price|seller|api-key-fixture|team-id-fixture|X-Api-Key/i);
    expect(firstFixture.calls.map((call) => endpoint(call.url))).toEqual([
      "/scrydex/account/v1/usage",
      "/cards/op01-001",
    ]);
    expect(plan.usageEstimate).toMatchObject({
      requestStrategy: "single-record",
      estimateState: "estimated",
      estimatedRequestCount: 1,
      perRecordFallbackReason: "Operator selected one explicit Scrydex card id.",
      usageCheckState: "checked",
    });
  });

  it("maps Scrydex auth, rate, credit, and degraded failures into redacted diagnostics", async () => {
    const cases = [
      { status: 401, body: { error: "invalid" }, code: "credential-invalid", severity: "error" },
      { status: 403, body: { error: "forbidden" }, code: "adapter-authentication-failed", severity: "error" },
      { status: 429, body: { error: "slow down" }, code: "provider-rate-limited", severity: "warning" },
      { status: 402, body: { error: "credits exhausted" }, code: "scrydex-credit-exhausted", severity: "error" },
      { status: 503, body: { error: "maintenance" }, code: "provider-degraded", severity: "warning" },
    ] as const;

    for (const testCase of cases) {
      const adapter = createScrydexOnePieceProviderAdapter({
        credentials: fixtureCredentials,
        baseUrl: fixtureBaseUrl,
        fetch: async (input, init) => {
          const headers = new Headers(init?.headers);
          expect(headers.get("X-Api-Key")).toBe(fixtureCredentials.apiKey);
          expect(headers.get("X-Team-ID")).toBe(fixtureCredentials.teamId);
          expect(String(input)).toBe(`${fixtureBaseUrl.replace("/onepiece/v1", "/account/v1")}/usage`);
          return new Response(JSON.stringify(testCase.body), {
            status: testCase.status,
            headers: { "retry-after": "30" },
          });
        },
        now: () => fixtureNow,
      });

      const diagnostics = await adapter.getTransportDiagnostics();
      const serialized = JSON.stringify(diagnostics);

      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: testCase.code,
            severity: testCase.severity,
          }),
        ]),
      );
      expect(serialized).not.toContain(fixtureCredentials.apiKey);
      expect(serialized).not.toContain(fixtureCredentials.teamId);
      expect(serialized).not.toContain("credits exhausted");
      expect(serialized).not.toContain("maintenance");
    }
  });
});

type ScrydexFixtureCall = Readonly<{
  url: string;
  apiKey: string | null;
  teamId: string | null;
}>;

async function collectPayloads(
  payloads: AsyncIterable<ProviderPayloadEnvelope<ScrydexOnePieceProviderPayload>>,
): Promise<ProviderPayloadEnvelope<ScrydexOnePieceProviderPayload>[]> {
  const collected: ProviderPayloadEnvelope<ScrydexOnePieceProviderPayload>[] = [];

  for await (const payload of payloads) {
    collected.push(payload);
  }

  return collected;
}

function scrydexFixtureFetch(): Readonly<{
  calls: ScrydexFixtureCall[];
  fetch: typeof globalThis.fetch;
}> {
  const responses: Readonly<Record<string, unknown>> = {
    [`${fixtureAccountBaseUrl}/usage`]: scrydexUsageResponse,
    [`${fixtureBaseUrl}/expansions?page=1&page_size=100&select=id%2Cname%2Ccode%2Ctotal%2Crelease_date%2Clanguage%2Clanguage_code`]:
      {
        data: [scrydexExpansion],
        total_pages: 1,
      },
    [`${fixtureBaseUrl}/cards?page=1&page_size=250&q=printings%3Aop-01&select=id%2Cname%2Cnumber%2Cprinted_number%2Crarity%2Crarity_code%2Ctype%2Cimages%2Clanguage%2Clanguage_code%2Cexpansion%2Cprintings%2Cvariants`]:
      {
        data: [scrydexCards[0], scrydexCards[1]],
        total_pages: 2,
      },
    [`${fixtureBaseUrl}/cards?page=2&page_size=250&q=printings%3Aop-01&select=id%2Cname%2Cnumber%2Cprinted_number%2Crarity%2Crarity_code%2Ctype%2Cimages%2Clanguage%2Clanguage_code%2Cexpansion%2Cprintings%2Cvariants`]:
      {
        data: [scrydexCards[2]],
        total_pages: 2,
      },
    [`${fixtureBaseUrl}/expansions/op-01/sealed?page=1&page_size=100&select=id%2Cname%2Ctype%2Cimages%2Clanguage%2Clanguage_code%2Cexpansion`]:
      {
        data: [scrydexSealedProduct],
        total_pages: 1,
      },
    [`${fixtureBaseUrl}/expansions/op-01`]: {
      ...scrydexExpansion,
      market_price: "199.99",
      seller: { account: "not-catalog-truth" },
    },
    [`${fixtureBaseUrl}/cards/op01-001`]: {
      ...scrydexCards[0],
      market_price: "99.99",
      seller: { account: "not-catalog-truth" },
      secret: "must-not-survive-sanitization",
    },
  };

  return scrydexResponseFixtureFetch(responses);
}

function scrydexResponseFixtureFetch(responses: Readonly<Record<string, unknown>>): Readonly<{
  calls: ScrydexFixtureCall[];
  fetch: typeof globalThis.fetch;
}> {
  const calls: ScrydexFixtureCall[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      const url = String(input);
      calls.push({
        url,
        apiKey: headers.get("X-Api-Key"),
        teamId: headers.get("X-Team-ID"),
      });
      const response = responses[url];
      return response
        ? new Response(JSON.stringify(response), { status: 200 })
        : new Response(JSON.stringify({ error: "not found", url }), { status: 404 });
    },
  };
}

const scrydexUsageResponse = {
  total_credits: 1000,
  remaining_credits: 875,
  used_credits: 125,
  overage_credit_rate: "0.01",
  updated_at: "2026-06-22T00:00:00.000Z",
};

function endpoint(url: string): string {
  return new URL(url).pathname.replace("/scrydex/onepiece/v1", "");
}

function search(url: string, key: string): string | null {
  return new URL(url).searchParams.get(key);
}

const scrydexExpansion = {
  id: "op-01",
  name: "Romance Dawn",
  code: "OP-01",
  total: 121,
  release_date: "2022-12-02",
  language: "English",
  language_code: "en",
};

const scrydexLorcanaExpansion = {
  id: "TFC",
  name: "The First Chapter",
  code: "TFC",
  total: 204,
  release_date: "2023-08-18",
  language: "English",
  language_code: "en",
};

const scrydexCards = [
  {
    id: "op01-001",
    name: "Monkey.D.Luffy",
    number: "001",
    printed_number: "OP01-001",
    rarity: "Leader",
    rarity_code: "L",
    type: "Leader",
    images: [
      {
        type: "front",
        small: "https://images.scrydex.example/op01-001/small",
        medium: "https://images.scrydex.example/op01-001/medium",
        large: "https://images.scrydex.example/op01-001/large",
      },
    ],
    language: "English",
    language_code: "en",
    expansion: scrydexExpansion,
    printings: ["OP-01", "PRB01"],
    variants: [
      {
        name: "normal",
        printings: ["OP-01"],
        images: [{ large: "https://images.scrydex.example/op01-001/large" }],
        prices: [{ market: 20 }],
      },
      {
        name: "mangaAltArt",
        printings: ["PRB01"],
        images: [{ large: "https://images.scrydex.example/op01-001-manga/large" }],
        prices: [{ market: 2000 }],
      },
    ],
  },
  {
    id: "op01-002",
    name: "Trafalgar Law",
    number: "002",
    printed_number: "OP01-002",
    rarity: "Super Rare",
    rarity_code: "SR",
    type: "Character",
    language: "English",
    language_code: "en",
    expansion: scrydexExpansion,
    printings: ["OP-01"],
    variants: [{ name: "normal", printings: ["OP-01"] }],
  },
  {
    id: "op01-003",
    name: "Nami",
    number: "003",
    printed_number: "OP01-003",
    rarity: "Rare",
    rarity_code: "R",
    type: "Character",
    language: "English",
    language_code: "en",
    expansion: scrydexExpansion,
    printings: ["OP-01"],
    variants: [{ name: "normal", printings: ["OP-01"] }],
  },
];

const scrydexSealedProduct = {
  id: "op01-booster-box",
  name: "Romance Dawn Booster Box",
  type: "booster_box",
  images: [
    {
      type: "front",
      small: "https://images.scrydex.example/op01-booster-box/small",
      medium: "https://images.scrydex.example/op01-booster-box/medium",
      large: "https://images.scrydex.example/op01-booster-box/large",
    },
  ],
  language: "English",
  language_code: "en",
  expansion: scrydexExpansion,
};

const scrydexLorcanaSealedProduct = {
  id: "tfc-booster-box",
  name: "The First Chapter Booster Box",
  type: "booster_box",
  language: "English",
  language_code: "en",
  expansion: { ...scrydexLorcanaExpansion, id: "1" },
};
