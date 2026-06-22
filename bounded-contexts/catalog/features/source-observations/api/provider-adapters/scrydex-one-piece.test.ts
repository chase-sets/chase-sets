import { describe, expect, it } from "vitest";

import type { ProviderPayloadEnvelope } from "./provider-adapter";
import {
  createScrydexOnePieceProviderAdapter,
  SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
  SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
  type ScrydexOnePieceProviderPayload,
} from "./scrydex-one-piece";

const fixtureBaseUrl = "https://fixture.chase-sets.local/scrydex/onepiece/v1";
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
    ).rejects.toThrow("Scrydex One Piece credentials are required");
    await expect(collectPayloads(adapter.fetchPayloads(plan))).rejects.toThrow(
      "Scrydex One Piece credentials are required",
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
    ]);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "scrydex-one-piece-credentials-configured",
        severity: "info",
      }),
      expect.objectContaining({
        code: "scrydex-one-piece-bulk-first-transport-configured",
        unitKey: SCRYDEX_ONE_PIECE_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      }),
      expect.objectContaining({
        code: "scrydex-one-piece-bulk-first-transport-configured",
        unitKey: SCRYDEX_ONE_PIECE_SET_REFERENCE_DATA_UNIT_KEY,
      }),
      expect.objectContaining({
        code: "scrydex-one-piece-bulk-first-transport-configured",
        unitKey: SCRYDEX_ONE_PIECE_SEALED_PRODUCT_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
      }),
    ]);
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
      "/expansions/op-01/cards",
      "/expansions/op-01/cards",
      "/expansions/op-01/sealed",
    ]);
    expect(fixture.calls.map((call) => search(call.url, "page_size"))).toEqual(["100", "250", "250", "100"]);
    expect(fixture.calls.map((call) => search(call.url, "select"))).toEqual([
      "id,name,code,total,release_date,language,language_code",
      "id,name,number,printed_number,rarity,rarity_code,type,language,language_code,expansion",
      "id,name,number,printed_number,rarity,rarity_code,type,language,language_code,expansion",
      "id,name,type,language,language_code,expansion",
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
        "Fetch Scrydex One Piece expansion cards with max page size",
        "Sanitize card payloads",
        "Attach payload provenance",
      ],
    });
    expect(sealedPlan).toMatchObject({
      planKey: "scrydex:one-piece:expansion:op-01:sealed",
      transportSteps: [
        "Fetch Scrydex One Piece expansion sealed products with max page size",
        "Sanitize sealed-product payloads",
        "Attach payload provenance",
      ],
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
      "/expansions/op-01/cards",
      "/expansions/op-01/cards",
      "/expansions/op-01/sealed",
    ]);
    expect(fixture.calls.map((call) => endpoint(call.url))).not.toEqual(
      expect.arrayContaining(["/cards/op01-001", "/cards/op01-002", "/cards/op01-003", "/sealed/op01-booster-box"]),
    );
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
    expect(fixture.calls.map((call) => endpoint(call.url))).toEqual(["/expansions/op-01"]);
    expect(JSON.stringify(payloads)).not.toMatch(/price|seller|api-key-fixture|team-id-fixture|X-Api-Key/i);
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
          },
          sourceUrl: "https://fixture.chase-sets.local/scrydex/onepiece/v1/cards/op01-001",
        },
      }),
    );
    expect(payload.provenance.contentHash).toBe(repeatPayload.provenance.contentHash);
    expect(JSON.stringify(payload)).not.toMatch(/market_price|price|seller|api-key-fixture|team-id-fixture|X-Api-Key/i);
    expect(firstFixture.calls.map((call) => endpoint(call.url))).toEqual(["/cards/op01-001"]);
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
  const calls: ScrydexFixtureCall[] = [];
  const responses: Readonly<Record<string, unknown>> = {
    [`${fixtureBaseUrl}/expansions?page=1&page_size=100&select=id%2Cname%2Ccode%2Ctotal%2Crelease_date%2Clanguage%2Clanguage_code`]:
      {
        data: [scrydexExpansion],
        total_pages: 1,
      },
    [`${fixtureBaseUrl}/expansions/op-01/cards?page=1&page_size=250&select=id%2Cname%2Cnumber%2Cprinted_number%2Crarity%2Crarity_code%2Ctype%2Clanguage%2Clanguage_code%2Cexpansion`]:
      {
        data: [scrydexCards[0], scrydexCards[1]],
        total_pages: 2,
      },
    [`${fixtureBaseUrl}/expansions/op-01/cards?page=2&page_size=250&select=id%2Cname%2Cnumber%2Cprinted_number%2Crarity%2Crarity_code%2Ctype%2Clanguage%2Clanguage_code%2Cexpansion`]:
      {
        data: [scrydexCards[2]],
        total_pages: 2,
      },
    [`${fixtureBaseUrl}/expansions/op-01/sealed?page=1&page_size=100&select=id%2Cname%2Ctype%2Clanguage%2Clanguage_code%2Cexpansion`]:
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

const scrydexCards = [
  {
    id: "op01-001",
    name: "Monkey.D.Luffy",
    number: "001",
    printed_number: "OP01-001",
    rarity: "Leader",
    rarity_code: "L",
    type: "Leader",
    language: "English",
    language_code: "en",
    expansion: scrydexExpansion,
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
  },
];

const scrydexSealedProduct = {
  id: "op01-booster-box",
  name: "Romance Dawn Booster Box",
  type: "booster_box",
  language: "English",
  language_code: "en",
  expansion: scrydexExpansion,
};
