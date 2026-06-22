import { describe, expect, it } from "vitest";

import {
  assertCatalogRedactedProviderUsageProofSummaryIsSafe,
  assertCatalogRealProviderProofPacketIsRedactionSafe,
  catalogRealProviderProofSchemaVersion,
  runCatalogTcgdexRealProviderProof,
  type CatalogRedactedProviderUsageProofSummary,
  type CatalogRealProviderProofPacket,
} from "./catalog-integration-real-provider-proof";
import { getActiveCatalogProviderIntegrationProfileVersion } from "../api/provider-integration-profiles";
import {
  createTcgdexProviderAdapter,
  TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
} from "../api/provider-adapters/tcgdex";

describe("Catalog real-provider proof", () => {
  it("builds a TCGdex import-to-promotion evidence packet through the ProviderAdapter boundary", async () => {
    const packet = await runProof();

    expect(packet).toMatchObject({
      schemaVersion: catalogRealProviderProofSchemaVersion,
      environment: "test",
      checkedAt: "2026-06-10T00:00:00.000Z",
      provider: {
        providerKey: "tcgdex",
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        profileKey: "pokemon-tcg",
        profileVersion: "2026.06.03",
        connectorKind: "tcgdex-json",
        transportMode: "deterministic-adapter-test",
        scope: {
          languageCode: "en",
          seriesId: "swsh",
          setId: "swsh3",
        },
      },
      importRun: {
        planKey: "tcgdex:en:swsh3",
        transportSteps: ["Fetch TCGdex expansion metadata", "Fetch TCGdex card payloads", "Attach payload provenance"],
        progressEventCount: 2,
        payloadCount: 1,
        completionState: "completed",
        diagnosticCounts: { info: 0, warning: 0, error: 0 },
      },
      sourceObservationReview: {
        reviewSurface: "primary-import-to-promotion-workbench",
        counts: {
          reviewable: 1,
          sampledRows: 1,
          blocked: 0,
          changedOrObserved: 1,
        },
      },
      promotionPreview: {
        beforeCatalogWrite: true,
        writeExecuted: false,
        matched: 1,
        eligible: 1,
        blocked: 0,
        skipped: 0,
        conflicting: 0,
        failed: 0,
        terminal: 0,
        confirmationRequired: true,
      },
      degradedTransport: {
        condition: "timeout",
        transportCategory: "timeout",
        blockerCategory: "provider-transport-timeout",
        actionState: "degraded",
        rawProviderErrorBodyRetained: false,
      },
      securityPrivacy: {
        redactionApplied: true,
        rawProviderPayloadRetained: false,
        credentialsOrCookiesRetained: false,
        fullProviderUrlsRetained: false,
        providerControlledLabelsRetained: false,
      },
      retiredSurfacePolicy: {
        requiredDisposition: "complete-removal",
        retainedOldTwoPageMigration: false,
        retainedRawJsonEscapeHatch: false,
        retainedCompatibilityRoute: false,
        retainedLegacyDocumentation: false,
      },
    });
    expect(packet.optionQueries).toEqual([
      expect.objectContaining({
        scope: "language",
        optionKind: "languages",
        itemCount: expect.any(Number),
        selectedValue: "en",
        selectedPresent: true,
        labelsAndMetadataRedacted: true,
      }),
      expect.objectContaining({
        scope: "series",
        optionKind: "series",
        itemCount: 1,
        selectedValue: "swsh",
        selectedPresent: true,
        labelsAndMetadataRedacted: true,
      }),
      expect.objectContaining({
        scope: "expansion",
        optionKind: "expansions",
        itemCount: 1,
        selectedValue: "swsh3",
        selectedPresent: true,
        labelsAndMetadataRedacted: true,
      }),
    ]);
    expect(packet.providerCriteria.map((criterion) => criterion.key)).toEqual([
      "provider-scope-option-query-selection",
      "provider-pagination-or-multi-step-retrieval",
      "image-and-metadata-mapping",
      "provider-transport-degraded-condition",
      "source-observation-profile-metadata",
      "promotion-preview-counts",
      "redaction-safe-evidence",
    ]);
    expect(packet.providerCriteria.find((criterion) => criterion.key === "redaction-safe-evidence")).toMatchObject({
      status: "covered-by-linked-gate",
    });
  });

  it("redacts provider payload bodies, labels, full URLs, and retired-surface patterns from proof output", async () => {
    const packet = await runProof();
    const serialized = JSON.stringify(packet);

    expect(packet.sourceObservationReview.rows).toEqual([
      {
        providerKey: "tcgdex",
        unitKey: TCGDEX_POKEMON_SINGLE_CARD_SOURCE_OBSERVATION_IMPORT_UNIT_KEY,
        externalKey: "swsh3-136",
        sourceProfileVersion: "2026.06.03",
        sourceUrlHost: "api.tcgdex.net",
        sourceUrlPathRedacted: true,
        sourceUpdatedAtPresent: true,
        sourceHashPresent: false,
        normalizedFactKeys: ["cardNumber", "cardVariantLabel", "expansionName", "name", "rarity"],
        redactionSummary:
          "Raw provider payload withheld; only identity, profile metadata, host, and normalized fact keys remain.",
      },
    ]);
    expect(serialized).not.toContain("Furret");
    expect(serialized).not.toContain("Darkness Ablaze");
    expect(serialized).not.toContain("https://api.tcgdex.net/v2/en/cards/swsh3-136");
    expect(serialized).not.toContain("https://assets.tcgdex.net/en/swsh/swsh3/136");
    expect(serialized).not.toContain("sourcePayload");
    expect(serialized).not.toMatch(/raw JSON broad patch|support-only route|compatibility redirect/i);
  });

  it("fails closed when proof evidence tries to retain retired or unsafe surfaces", async () => {
    const packet = await runProof();
    const unsafePacket = {
      ...packet,
      securityPrivacy: {
        ...packet.securityPrivacy,
        rawProviderPayloadRetained: true,
      },
    } as unknown as CatalogRealProviderProofPacket;

    expect(() => assertCatalogRealProviderProofPacketIsRedactionSafe(unsafePacket)).toThrow(
      "Real-provider proof evidence must not retain raw provider payloads.",
    );

    expect(() =>
      assertCatalogRealProviderProofPacketIsRedactionSafe({
        ...packet,
        securityPrivacy: {
          ...packet.securityPrivacy,
          forbiddenEvidence: ["https://api.tcgdex.net/v2/en/cards/swsh3-136"],
        },
      }),
    ).toThrow("Real-provider proof evidence must not retain full provider URLs.");

    expect(() =>
      assertCatalogRealProviderProofPacketIsRedactionSafe({
        ...packet,
        retiredSurfacePolicy: {
          ...packet.retiredSurfacePolicy,
          retainedLegacyDocumentation: true,
        },
      } as unknown as CatalogRealProviderProofPacket),
    ).toThrow("Real-provider proof evidence must not retain retired control-plane surfaces.");
  });

  it("accepts Scrydex request counts only as a redacted provider usage summary", () => {
    const summary: CatalogRedactedProviderUsageProofSummary = {
      dataClass: "provider-usage-summary",
      providerKey: "scrydex",
      unitKey: "scrydex:one-piece:single-card:source-observation-import",
      sourceScopeRedacted: true,
      estimatedRequestCount: 3,
      actualRequestCount: 2,
      pageCount: 2,
      cacheHitCount: 1,
      cacheMissCount: 1,
      usageCheckState: "passed",
      creditState: "available",
      bulkFirstConfirmed: true,
      perRecordFallbackReasonRedacted: null,
      diagnosticsRedacted: true,
      rawProviderUsageRetained: false,
      accountOrTeamIdentifiersRetained: false,
      fullProviderUrlsRetained: false,
    };

    expect(() => assertCatalogRedactedProviderUsageProofSummaryIsSafe(summary)).not.toThrow();
  });

  it("fails closed when Scrydex usage evidence retains unsafe provider details", () => {
    const summary: CatalogRedactedProviderUsageProofSummary = {
      dataClass: "provider-usage-summary",
      providerKey: "scrydex",
      unitKey: "scrydex:one-piece:single-card:source-observation-import",
      sourceScopeRedacted: true,
      estimatedRequestCount: "estimate-unavailable",
      actualRequestCount: 2,
      pageCount: 2,
      cacheHitCount: 0,
      cacheMissCount: 2,
      usageCheckState: "degraded",
      creditState: "unknown",
      bulkFirstConfirmed: false,
      perRecordFallbackReasonRedacted: "fallback reason retained as redacted operator summary",
      diagnosticsRedacted: true,
      rawProviderUsageRetained: false,
      accountOrTeamIdentifiersRetained: false,
      fullProviderUrlsRetained: false,
    };

    expect(() =>
      assertCatalogRedactedProviderUsageProofSummaryIsSafe({
        ...summary,
        accountOrTeamIdentifiersRetained: true,
      } as unknown as CatalogRedactedProviderUsageProofSummary),
    ).toThrow("Provider usage proof must not retain account or team identifiers.");
    expect(() =>
      assertCatalogRedactedProviderUsageProofSummaryIsSafe({
        ...summary,
        rawProviderUsageRetained: true,
      } as unknown as CatalogRedactedProviderUsageProofSummary),
    ).toThrow("Provider usage proof must not retain raw provider usage responses.");
    expect(() =>
      assertCatalogRedactedProviderUsageProofSummaryIsSafe({
        ...summary,
        estimatedRequestCount: -1,
      }),
    ).toThrow("Provider usage proof estimated request count must be a non-negative integer or unavailable.");
    expect(() =>
      assertCatalogRedactedProviderUsageProofSummaryIsSafe({
        ...summary,
        cacheMissCount: -1,
      }),
    ).toThrow("Provider usage proof cache miss count must be a non-negative integer.");
  });
});

async function runProof(): Promise<CatalogRealProviderProofPacket> {
  const profileVersion = requireTcgdexProfileVersion();
  const loadActiveProfileVersion = async () => profileVersion;
  const adapter = createTcgdexProviderAdapter({
    loadActiveProfileVersion,
    fetch: tcgdexFetch({
      "https://api.tcgdex.net/v2/en/series": [
        { id: "swsh", name: "Sword & Shield", logo: "https://assets.tcgdex.net/en/swsh/logo" },
      ],
      "https://api.tcgdex.net/v2/en/series/swsh": {
        id: "swsh",
        name: "Sword & Shield",
        sets: [
          {
            id: "swsh3",
            name: "Darkness Ablaze",
            logo: "https://assets.tcgdex.net/en/swsh/swsh3/logo",
            symbol: "https://assets.tcgdex.net/univ/swsh/swsh3/symbol",
            cardCount: { total: 201, official: 189 },
          },
        ],
      },
      "https://api.tcgdex.net/v2/en/sets/swsh3": {
        id: "swsh3",
        name: "Darkness Ablaze",
        releaseDate: "2020-08-14",
        serie: {
          id: "swsh",
          name: "Sword & Shield",
        },
        cardCount: {
          total: 201,
          official: 189,
          reverse: 155,
        },
        cards: [{ id: "swsh3-136", localId: "136", name: "Furret" }],
      },
      "https://api.tcgdex.net/v2/en/cards/swsh3-136": {
        id: "swsh3-136",
        localId: "136",
        name: "Furret",
        category: "Pokemon",
        illustrator: "tetsuya koizumi",
        rarity: "Uncommon",
        updated: "2026-05-15T00:00:00.000Z",
        image: "https://assets.tcgdex.net/en/swsh/swsh3/136",
        set: {
          id: "swsh3",
          name: "Darkness Ablaze",
        },
      },
    }),
  });

  return runCatalogTcgdexRealProviderProof({
    adapter,
    loadActiveProfileVersion,
    environment: "test",
    checkedAt: "2026-06-10T00:00:00.000Z",
    transportMode: "deterministic-adapter-test",
  });
}

function requireTcgdexProfileVersion() {
  const version = getActiveCatalogProviderIntegrationProfileVersion("tcgdex");
  if (!version) {
    throw new Error("Expected active TCGdex profile version.");
  }
  return version;
}

function tcgdexFetch(responses: Readonly<Record<string, unknown>>): typeof globalThis.fetch {
  return async (input) => {
    const response = responses[String(input)];
    if (!response) {
      return new Response(null, { status: 404 });
    }

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}
