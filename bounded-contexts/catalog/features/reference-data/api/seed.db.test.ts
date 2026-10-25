import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { bootstrapContextDatabase, drainLocalProjectionHandlerSets } from "@chase-sets/bounded-context-runtime";
import {
  closeMultiContextTestPools,
  createMultiContextTestDatabaseUrls,
  createMultiContextTestPools,
  ensureMultiContextTestDatabases,
  resetMultiContextTestSchemas,
} from "@chase-sets/bounded-context-runtime/test-support";
import { createPostgresEventStore, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { module as catalogModule } from "../../../index";
import type { CatalogItemId, FieldId, ReferenceRecordId } from "../../../ids";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import { createCatalogServices, type CatalogServices } from "../../../support/authoring-support/services";
import { seedContext } from "../../../support/seed-support/context";
import { localizedTextMapFromEnglish } from "../../../support/runtime-support/common";
import { providerScopeMappingStreamId } from "../../provider-scope-mapping/domain/domain";
import { buildProviderScopeMappingCandidate } from "../../provider-scope-mapping/domain/mapping";
import enSets from "../../source-observations/api/__fixtures__/tcgdex/en-sets.json";
import { tcgdexPokemonTcgProviderProfile } from "../../source-observations/api/provider-integration-profiles";
import { capturedTcgdexSet, tcgdexSetObservation } from "../../source-observations/api/seeding/runtime-test-harness";
import {
  resolvePromotionReferenceHierarchy,
  resolvePromotionReferenceHierarchyReadOnly,
} from "../../source-observations/api/source-observation-promotion-reference-hierarchy";
import {
  evolveReferenceRecord,
  initialReferenceRecordState,
  type ReferenceRecordEvent,
  type ReferenceRecordState,
} from "../domain/domain";
import { seedReferenceData } from "./seed";

const databaseBaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseBaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for Reference Data seed database tests in CI.");
}
const describeDb = databaseBaseUrl ? describe : describe.skip;

const expansionIds = catalogSeedIds.referenceRecords.expansions;
const seededExpansions = {
  "base-set": expansionIds.baseSet,
  jungle: expansionIds.jungle,
  "neo-genesis": expansionIds.neoGenesis,
  "wizards-black-star-promos": expansionIds.wizardsBlackStarPromos,
  "prismatic-evolutions": expansionIds.prismaticEvolutions,
  "surging-sparks": expansionIds.surgingSparks,
  "twilight-masquerade": expansionIds.twilightMasquerade,
} as const satisfies Record<string, string>;
/** The exact English ids the TCGdex `/v2/en/sets` capture of 2026-10-18 lists for the seeded expansions. */
const englishTcgdexSetIds = {
  "base-set": "base1",
  jungle: "base2",
  "neo-genesis": "neo1",
  "wizards-black-star-promos": "basep",
  "prismatic-evolutions": "sv08.5",
  "surging-sparks": "sv08",
  "twilight-masquerade": "sv06",
} as const;
/** The ids the seed wrote before #10062; staging read them at 2026-10-18T18:58:27.675Z. */
const staleTcgdexSetIds: Readonly<Record<string, string>> = {
  [expansionIds.prismaticEvolutions]: "sv8.5",
  [expansionIds.surgingSparks]: "sv8",
  [expansionIds.twilightMasquerade]: "sv6",
};
/** Explicit expected attributes for every seeded expansion after reconciliation. */
const expectedAttributesBySeedKey = {
  "base-set": {
    abbreviation: "BS",
    "card-count": 102,
    "release-date": "1999-01-09",
    "tcgdex-set-id": "base1",
    "language-editions": ["en"],
  },
  jungle: {
    abbreviation: "JU",
    "card-count": 64,
    "release-date": "1999-06-16",
    "tcgdex-set-id": "base2",
    "language-editions": ["en"],
  },
  "neo-genesis": {
    abbreviation: "N1",
    "card-count": 111,
    "release-date": "2000-12-16",
    "tcgdex-set-id": "neo1",
    "language-editions": ["en"],
  },
  "wizards-black-star-promos": { abbreviation: "PR", "tcgdex-set-id": "basep", "language-editions": ["en"] },
  "prismatic-evolutions": {
    abbreviation: "PRE",
    "release-date": "2025-01-17",
    "tcgdex-set-id": "sv08.5",
    "language-editions": ["en"],
  },
  "surging-sparks": {
    abbreviation: "SSP",
    "release-date": "2024-11-08",
    "tcgdex-set-id": "sv08",
    "language-editions": ["en"],
  },
  "twilight-masquerade": {
    abbreviation: "TWM",
    "release-date": "2024-05-24",
    "tcgdex-set-id": "sv06",
    "language-editions": ["en"],
  },
} as const;
const correctedAttributeDigests = Object.fromEntries(
  Object.entries(expectedAttributesBySeedKey).map(([key, attributes]) => [key, attributeDigest(attributes)]),
) as Record<keyof typeof expectedAttributesBySeedKey, string>;
const duplicateId = "ref_tcgdex_expansion_sv08" as ReferenceRecordId;
const canonicalId = expansionIds.surgingSparks as ReferenceRecordId;
const surgingSparksIds = [canonicalId, duplicateId];
const recordStream = (id: string) => `catalog.reference-record-${id}`;

function attributeDigest(attributes: Readonly<Record<string, unknown>>): string {
  const sorted = Object.fromEntries(Object.entries(attributes).sort(([left], [right]) => left.localeCompare(right)));
  return createHash("sha256").update(JSON.stringify(sorted)).digest("hex");
}

describeDb("English Pokemon reference data seed against the TCGdex English set list (#10062)", () => {
  let pool: PgTransactionalPool;
  let services: CatalogServices;

  beforeAll(async () => {
    const urls = createMultiContextTestDatabaseUrls(databaseBaseUrl!, ["catalog"], "catalog_reference_data_seed");
    await ensureMultiContextTestDatabases(databaseBaseUrl!, urls);
    pool = createMultiContextTestPools(urls).catalog;
  });

  beforeEach(async () => {
    await resetMultiContextTestSchemas({ catalog: pool });
    await bootstrapContextDatabase(catalogModule, pool);
    services = createCatalogServices(pool);
  });

  afterAll(async () => closeMultiContextTestPools({ catalog: pool }));

  const drain = () => drainLocalProjectionHandlerSets("catalog", pool, services.projectors);
  const promotionDeps = () =>
    ({ eventStore: createPostgresEventStore({ pool }), db: pool }) as object as CatalogRuntimeDeps;

  async function runSeed(): Promise<void> {
    await seedReferenceData(services);
    await drain();
  }

  async function folded(id: string): Promise<ReferenceRecordState> {
    const rows = await pool.query<{ event_type: ReferenceRecordEvent["type"]; payload: ReferenceRecordEvent["data"] }>(
      "SELECT event_type, payload FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
      [recordStream(id)],
    );
    return rows.rows
      .map((row) => ({ type: row.event_type, data: row.payload }) as ReferenceRecordEvent)
      .reduce(evolveReferenceRecord, initialReferenceRecordState);
  }

  async function seededTcgdexSetIds(): Promise<Record<string, unknown>> {
    const ids: Record<string, unknown> = {};
    for (const [key, id] of Object.entries(seededExpansions)) {
      ids[key] = (await folded(id)).attributes["tcgdex-set-id"];
    }
    return ids;
  }

  async function seededAttributeDigests(): Promise<Record<string, string>> {
    const digests: Record<string, string> = {};
    for (const [key, id] of Object.entries(seededExpansions)) {
      digests[key] = attributeDigest((await folded(id)).attributes);
    }
    return digests;
  }

  async function eventTypes(id: string): Promise<string[]> {
    const rows = await pool.query<{ event_type: string }>(
      "SELECT event_type FROM event_store_events WHERE stream_id = $1 ORDER BY stream_version",
      [recordStream(id)],
    );
    return rows.rows.map((row) => row.event_type);
  }

  async function streamEventCounts(): Promise<Record<string, number>> {
    const rows = await pool.query<{ stream_id: string; count: number }>(
      "SELECT stream_id, count(*)::int AS count FROM event_store_events GROUP BY stream_id ORDER BY stream_id",
    );
    return Object.fromEntries(rows.rows.map((row) => [row.stream_id, row.count]));
  }

  async function activeSurgingSparksRecords(): Promise<string[]> {
    const rows = await pool.query<{ reference_record_id: string }>(
      `SELECT reference_record_id FROM catalog_reference_records
       WHERE type_key = 'expansion' AND name = 'Surging Sparks' AND status = 'active'
       ORDER BY reference_record_id`,
    );
    return rows.rows.map((row) => row.reference_record_id);
  }

  async function catalogItemCounts(): Promise<Record<string, number>> {
    const rows = await pool.query<{ reference_id: string; count: number }>(
      `SELECT field_value->'value'->>'referenceId' AS reference_id, count(DISTINCT item.catalog_item_id)::int AS count
       FROM catalog_items AS item
       CROSS JOIN LATERAL jsonb_array_elements(item.field_values) AS field_value
       WHERE field_value->'value'->>'referenceId' = ANY($1::text[])
       GROUP BY 1 ORDER BY 1`,
      [surgingSparksIds],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.reference_id, row.count]));
  }

  async function mappingCounts(): Promise<Record<string, number>> {
    const rows = await pool.query<{ scope: string; count: number }>(
      `SELECT scope_record_id || ':' || review_status AS scope, count(*)::int AS count
       FROM catalog_provider_scope_mappings
       WHERE scope_record_id = ANY($1::text[])
       GROUP BY 1 ORDER BY 1`,
      [surgingSparksIds],
    );
    return Object.fromEntries(rows.rows.map((row) => [row.scope, row.count]));
  }

  const englishSurgingSparks = () => tcgdexSetObservation("en", capturedTcgdexSet(enSets, "sv08"));
  const provision = async (normalized = englishSurgingSparks()) =>
    (
      await resolvePromotionReferenceHierarchy({
        deps: promotionDeps(),
        referenceData: services.referenceData,
        profile: tcgdexPokemonTcgProviderProfile,
        normalized,
        context: seedContext,
      })
    ).targetReferenceRecordId;
  const preview = async (normalized = englishSurgingSparks()) =>
    (
      await resolvePromotionReferenceHierarchyReadOnly({
        deps: promotionDeps(),
        profile: tcgdexPokemonTcgProviderProfile,
        normalized,
      })
    ).targetReferenceRecordId;

  /** SYNTHETIC draft Catalog Item whose expansion field references `referenceId`. */
  async function createCatalogItem(itemId: string, referenceId: string): Promise<void> {
    const streamId = `catalog.item-${itemId}`;
    await services.items.commandHandler({
      streamId,
      command: {
        type: "CreateCatalogItem",
        itemId: itemId as CatalogItemId,
        languageCode: "en",
        title: localizedTextMapFromEnglish("Synthetic Surging Sparks item"),
      },
      context: seedContext,
    });
    await services.items.commandHandler({
      streamId,
      command: {
        type: "SetCatalogItemFieldValue",
        fieldId: catalogSeedIds.fields.expansion as FieldId,
        value: { referenceId },
      },
      context: seedContext,
    });
  }

  /** SYNTHETIC Provider Scope Mapping from `scopeRecordId` to TCGdex English `sv08`. */
  async function mapToSurgingSparks(scopeRecordId: string, accept: boolean, autoAccept = false): Promise<void> {
    const candidate = buildProviderScopeMappingCandidate({
      scopeRecordId,
      providerKey: "tcgdex",
      unitKey: "synthetic-10062-cards",
      coordinates: { setId: "sv08", setName: "Surging Sparks", language: { languageCode: "en" } },
      confidence: "exact",
      reviewStatus: autoAccept ? "auto-accepted" : "proposed",
      provenance: { source: "synthetic-10062" },
    });
    const streamId = providerScopeMappingStreamId(candidate);
    await services.providerScopeMappings.commandHandler({
      streamId,
      command: { type: "ProposeProviderScopeMapping", candidate, actor: "synthetic-10062" },
      context: seedContext,
    });
    if (accept) {
      await services.providerScopeMappings.commandHandler({
        streamId,
        command: { type: "AcceptProviderScopeMapping", actor: "synthetic-10062" },
        context: seedContext,
      });
    }
  }

  /**
   * The staging-shaped state before #10062: the seed wrote `sv8.5`, `sv8` and
   * `sv6`, so TCGdex promotion of English `sv08` missed the seeded Surging
   * Sparks and provisioned `ref_tcgdex_expansion_sv08` beside it. Each record
   * carries a SYNTHETIC Catalog Item; the duplicate also carries a proposed
   * mapping, and the canonical record an accepted one unless stated otherwise.
   */
  async function stagingShapedPreChangeState(
    input: { acceptedMappingOn?: string; omitCanonicalAttribute?: string } = {},
  ): Promise<void> {
    const recordHandler = services.referenceData.referenceRecordCommandHandler;
    await seedReferenceData({
      ...services,
      referenceData: {
        ...services.referenceData,
        referenceRecordCommandHandler: (command) => {
          const stale =
            command.command.type === "CreateReferenceRecord"
              ? staleTcgdexSetIds[command.command.referenceRecordId]
              : undefined;
          return recordHandler(
            stale && command.command.type === "CreateReferenceRecord"
              ? {
                  ...command,
                  command: {
                    ...command.command,
                    attributes: {
                      ...command.command.attributes,
                      "tcgdex-set-id": stale,
                      ...(command.command.referenceRecordId === canonicalId && input.omitCanonicalAttribute
                        ? Object.fromEntries(
                            Object.entries(command.command.attributes ?? {}).filter(
                              ([key]) => key !== input.omitCanonicalAttribute,
                            ),
                          )
                        : {}),
                    },
                  },
                }
              : command,
          );
        },
      },
    });
    await drain();

    // Bootstrap may already have reconciled the canonical record before this
    // fixture is shaped. Re-fence that retained record into the historical
    // staging state explicitly so the duplicate-provisioning assertion below
    // discriminates the fixture from the retirement mapping.
    const canonicalState = await folded(canonicalId);
    const canonicalEventCount = (await eventTypes(canonicalId)).length;
    const stagingAttributes = Object.fromEntries(
      Object.entries({
        ...canonicalState.attributes,
        "tcgdex-set-id": staleTcgdexSetIds[canonicalId],
      }).filter(([key]) => key !== input.omitCanonicalAttribute),
    );
    await recordHandler({
      streamId: recordStream(canonicalId),
      command: {
        type: "ReviseReferenceRecord",
        typeKey: canonicalState.typeKey!,
        key: canonicalState.key!,
        name: canonicalState.name!,
        description: canonicalState.description!,
        attributes: stagingAttributes,
        relationships: canonicalState.relationships,
      },
      context: seedContext,
      expectedVersion: canonicalEventCount,
    });
    await drain();
    expect(await provision()).toBe(duplicateId);
    await createCatalogItem("itm_synthetic_10062_canonical", canonicalId);
    await createCatalogItem("itm_synthetic_10062_duplicate", duplicateId);
    const acceptedMappingOn = input.acceptedMappingOn ?? canonicalId;
    await mapToSurgingSparks(acceptedMappingOn, true);
    if (acceptedMappingOn !== duplicateId) {
      await mapToSurgingSparks(duplicateId, false);
    }
    await drain();
  }

  it("seeds every Pokemon expansion with its exact English TCGdex id from /v2/en/sets", async () => {
    await runSeed();

    const ids = await seededTcgdexSetIds();
    const englishIds = new Set(enSets.map((set) => set.id));
    expect(ids).toEqual(englishTcgdexSetIds);
    expect(Object.values(ids).filter((id) => !englishIds.has(String(id)))).toEqual([]);
    expect(await seededAttributeDigests()).toEqual(correctedAttributeDigests);
    expect(await activeSurgingSparksRecords()).toEqual([canonicalId]);
    expect(await preview()).toBe(canonicalId);
    expect(await provision()).toBe(canonicalId);
  });

  it("seed-idempotence corrects the three stale ids and retires the Surging Sparks duplicate once, keeping items, mappings and history", async () => {
    await stagingShapedPreChangeState();
    expect(await seededTcgdexSetIds()).toEqual({
      ...englishTcgdexSetIds,
      "prismatic-evolutions": "sv8.5",
      "surging-sparks": "sv8",
      "twilight-masquerade": "sv6",
    });
    expect(await activeSurgingSparksRecords()).toEqual([canonicalId, duplicateId].sort());
    const itemsBefore = await catalogItemCounts();
    const mappingsBefore = await mappingCounts();
    const countsBefore = await streamEventCounts();
    const duplicateHistoryBefore = await eventTypes(duplicateId);
    expect(itemsBefore).toEqual({ [canonicalId]: 1, [duplicateId]: 1 });
    expect(mappingsBefore).toEqual({ [`${canonicalId}:accepted`]: 1, [`${duplicateId}:proposed`]: 1 });

    await runSeed();

    const countsAfterRun1 = await streamEventCounts();
    const appended = Object.fromEntries(
      Object.entries(countsAfterRun1)
        .filter(([streamId, count]) => count !== (countsBefore[streamId] ?? 0))
        .map(([streamId, count]) => [streamId, count - (countsBefore[streamId] ?? 0)]),
    );
    expect(appended).toEqual({
      [recordStream(expansionIds.prismaticEvolutions)]: 1,
      [recordStream(expansionIds.surgingSparks)]: 1,
      [recordStream(expansionIds.twilightMasquerade)]: 1,
      [recordStream(duplicateId)]: 1,
    });
    expect((await eventTypes(expansionIds.surgingSparks)).at(-1)).toBe("catalog.reference-record.revised");
    expect(await eventTypes(duplicateId)).toEqual([...duplicateHistoryBefore, "catalog.reference-record.deprecated"]);
    expect(await seededTcgdexSetIds()).toEqual(englishTcgdexSetIds);
    expect(await seededAttributeDigests()).toEqual(correctedAttributeDigests);
    expect(await activeSurgingSparksRecords()).toEqual([canonicalId]);
    expect(await catalogItemCounts()).toEqual(itemsBefore);
    expect(await mappingCounts()).toEqual(mappingsBefore);
    expect(await preview()).toBe(canonicalId);
    expect(await provision()).toBe(canonicalId);
    expect(await streamEventCounts()).toEqual(countsAfterRun1);

    await runSeed();

    expect(await streamEventCounts()).toEqual(countsAfterRun1);
    expect(await seededAttributeDigests()).toEqual(correctedAttributeDigests);
    expect(await activeSurgingSparksRecords()).toEqual([canonicalId]);
    expect((await folded(duplicateId)).status).toBe("deprecated");
  });

  it("merges a missing and corrected attribute in one fenced revision", async () => {
    await stagingShapedPreChangeState({ omitCanonicalAttribute: "language-editions" });
    const before = await eventTypes(canonicalId);
    await runSeed();
    expect(await eventTypes(canonicalId)).toEqual([...before, "catalog.reference-record.revised"]);
    expect((await folded(canonicalId)).attributes).toEqual(expectedAttributesBySeedKey["surging-sparks"]);
  });

  it("refuses to retire a Surging Sparks duplicate that still owns an accepted mapping", async () => {
    await stagingShapedPreChangeState({ acceptedMappingOn: duplicateId });
    const duplicateHistoryBefore = await eventTypes(duplicateId);

    await expect(seedReferenceData(services)).rejects.toThrow(
      `Catalog integration bootstrap cannot retire duplicate Reference Record '${duplicateId}': it still owns 1 accepted Provider Scope Mapping(s).`,
    );

    expect(await eventTypes(duplicateId)).toEqual(duplicateHistoryBefore);
    expect((await folded(duplicateId)).status).toBe("active");
  });

  it("preserves the canonical record through Catalog bootstrap, provider promotion and read-only preview", async () => {
    if (!catalogModule.seed) throw new Error("Catalog bootstrap seed must be registered");
    await stagingShapedPreChangeState();
    await catalogModule.seed(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    await drain();
    expect(await activeSurgingSparksRecords()).toEqual([canonicalId]);
    expect(await seededTcgdexSetIds()).toEqual(englishTcgdexSetIds);
    expect(await preview()).toBe(canonicalId);
    expect(await provision()).toBe(canonicalId);
    const before = await streamEventCounts();
    await catalogModule.seed(pool, undefined, { enabledDataProfiles: ["catalog-integration-bootstrap"] });
    await drain();
    expect(await streamEventCounts()).toEqual(before);
  });

  it.each([
    ["accepted", false],
    ["accepted", true],
    ["auto-accepted", false],
    ["auto-accepted", true],
  ] as const)(
    "refuses a %s mapping with projection lag=%s, preserving authoritative histories",
    async (status, lag) => {
      await stagingShapedPreChangeState();
      await mapToSurgingSparks(duplicateId, status === "accepted", status === "auto-accepted");
      await drain();
      if (lag) {
        await pool.query("DELETE FROM catalog_provider_scope_mappings WHERE scope_record_id = $1", [duplicateId]);
      }
      const before = await streamEventCounts();
      const itemsBefore = await catalogItemCounts();
      await expect(seedReferenceData(services)).rejects.toThrow("it still owns 1 accepted Provider Scope Mapping(s)");
      const after = await streamEventCounts();
      expect(after[recordStream(duplicateId)]).toBe(before[recordStream(duplicateId)]);
      for (const [streamId, count] of Object.entries(before)) {
        if (streamId.startsWith("catalog.provider-scope-mapping-") || streamId.startsWith("catalog.item-")) {
          expect(after[streamId]).toBe(count);
        }
      }
      expect(await catalogItemCounts()).toEqual(itemsBefore);
      expect((await folded(duplicateId)).status).toBe("active");
    },
  );

  it.each(["unrelated attribute", "provider id"])(
    "fences correction against an intervening %s revision",
    async (edit) => {
      await stagingShapedPreChangeState();
      const handler = services.referenceData.referenceRecordCommandHandler;
      let interleaved = false;
      const racingServices: CatalogServices = {
        ...services,
        referenceData: {
          ...services.referenceData,
          referenceRecordCommandHandler: async (input) => {
            if (
              !interleaved &&
              input.streamId === recordStream(canonicalId) &&
              input.command.type === "ReviseReferenceRecord"
            ) {
              interleaved = true;
              const state = await folded(canonicalId);
              await handler({
                streamId: input.streamId,
                command: {
                  type: "ReviseReferenceRecord",
                  typeKey: state.typeKey!,
                  key: state.key!,
                  name: state.name!,
                  description: state.description,
                  relationships: state.relationships,
                  attributes: {
                    ...state.attributes,
                    "tcgdex-set-id": edit === "provider id" ? "synthetic-custom-id" : "sv8",
                    "synthetic-operator-note": "concurrent-update",
                  },
                },
                context: seedContext,
              });
            }
            return handler(input);
          },
        },
      };
      const before = await eventTypes(canonicalId);
      await expect(seedReferenceData(racingServices)).rejects.toThrow(/concurr|version/i);
      expect(await eventTypes(canonicalId)).toEqual([...before, "catalog.reference-record.revised"]);
      expect((await folded(canonicalId)).attributes).toMatchObject({
        "tcgdex-set-id": edit === "provider id" ? "synthetic-custom-id" : "sv8",
        "synthetic-operator-note": "concurrent-update",
      });
      expect((await folded(duplicateId)).status).toBe("active");
    },
  );

  it.each(["duplicate", "canonical"] as const)(
    "rejects poisoned %s retained lifecycle without another event",
    async (target) => {
      await stagingShapedPreChangeState();
      const id = target === "duplicate" ? duplicateId : canonicalId;
      const handler = services.referenceData.referenceRecordCommandHandler;
      await handler({
        streamId: recordStream(id),
        command: { type: "DeprecateReferenceRecord" },
        context: seedContext,
      });
      await handler({ streamId: recordStream(id), command: { type: "ArchiveReferenceRecord" }, context: seedContext });
      await expect(
        handler({ streamId: recordStream(id), command: { type: "PublishReferenceRecord" }, context: seedContext }),
      ).rejects.toThrow("Only draft reference records");
      // SYNTHETIC illegal event; no real external evidence identity is changed.
      await createPostgresEventStore({ pool }).appendToStream({
        streamId: recordStream(id),
        expectedVersion: (await eventTypes(id)).length,
        events: [{ eventType: "catalog.reference-record.published", payload: {} }],
        context: seedContext,
      });
      const before = await eventTypes(id);
      await expect(seedReferenceData(services)).rejects.toThrow("illegal retained Reference Record history");
      expect(await eventTypes(id)).toEqual(before);
    },
  );
});
