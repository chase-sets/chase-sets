import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { JsonValue } from "@chase-sets/primitives/json";
import { describe, expect, it } from "vitest";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import { createReferenceDataRuntime, type ReferenceDataServices } from "../../reference-data/api/runtime";
import type { ReferenceRecordCommand, ReferenceTypeCommand } from "../../reference-data/domain/domain";
import type { SourceObservationPokemonCardNormalized } from "../domain/domain";
import {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "./provider-integration-profiles";
import { context, lorcanaCardPrintObservation, pokemonObservation } from "./seeding/runtime-test-harness";
import {
  resolvePromotionReferenceHierarchy,
  resolvePromotionReferenceHierarchyReadOnly,
} from "./source-observation-promotion-reference-hierarchy";

/**
 * SYNTHETIC Reference Data only: an in-memory EventStore behind the real
 * Reference Data command handlers, and a hand-held projected lookup so the
 * projection can lag the authoritative streams on purpose. Every identity is
 * unmistakably synthetic.
 */
const typeId = "rft_synthetic_hierarchy_set" as ReferenceTypeId;
const recordId = "ref_synthetic_hierarchy_set" as ReferenceRecordId;
const reusedId = "ref_synthetic_hierarchy_reused" as ReferenceRecordId;
const typeStream = `catalog.reference-type-${typeId}`;
const recordStream = `catalog.reference-record-${recordId}`;
const reusedStream = `catalog.reference-record-${reusedId}`;
const providerAttributeKey = "tcgdex-set-id";
const providerAttributeValue = "synthetic-hierarchy-set";
const normalized = lorcanaCardPrintObservation({ setCode: "1", setName: "Synthetic Set" });
const invalidRecord = `promotion-reference-history-invalid:${recordStream}`;
const invalidReused = `promotion-reference-history-invalid:${reusedStream}`;
const invalidType = `promotion-reference-history-invalid:${typeStream}`;
const activeTypeHistory = ["catalog.reference-type.created", "catalog.reference-type.published"];
const activeRecordHistory = ["catalog.reference-record.created", "catalog.reference-record.published"];

type ProjectedReferenceRecord = Readonly<{
  reference_record_id: string;
  type_key: string;
  key: string;
  attributes: Readonly<Record<string, JsonValue>>;
}>;

type CreateReferenceRecordOverrides = Partial<
  Omit<Extract<ReferenceRecordCommand, { type: "CreateReferenceRecord" }>, "type" | "referenceRecordId">
>;

function syntheticProfile(
  input: { providerAttribute?: boolean; providerAttributeValue?: string } = {},
): CatalogProviderIntegrationProfile {
  return {
    ...lorcanajsonLorcanaCardReferenceProviderProfile,
    displayName: "Synthetic Hierarchy Profile",
    referenceHierarchyMapping: {
      providerReferenceIdPrefix: "ref_synthetic_hierarchy",
      providerAttributes: [],
      targetRecordRuleKey: "set",
      referenceTypes: [
        {
          referenceTypeId: typeId,
          typeKey: "set",
          name: "Set",
          descriptionText: "Synthetic Set type",
          attributeKeys: [],
        },
      ],
      referenceRecords: [
        {
          ruleKey: "set",
          typeKey: "set",
          recordId: { kind: "static", referenceRecordId: recordId },
          key: { kind: "static", value: "1" },
          name: { kind: "static", value: "Synthetic Set" },
          description: { kind: "static", value: "Synthetic Set" },
          ...(input.providerAttribute
            ? {
                attributes: [
                  {
                    attributeKey: providerAttributeKey,
                    value: { kind: "static" as const, value: input.providerAttributeValue ?? providerAttributeValue },
                  },
                ],
              }
            : {}),
        },
      ],
    },
  };
}

function harness(projected: readonly ProjectedReferenceRecord[] = []) {
  const { eventStore } = createInMemoryEventStore();
  const deps = {
    eventStore,
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        const rows = sql.includes("attributes ->> $2")
          ? projected.filter((row) => row.type_key === values[0] && row.attributes[String(values[1])] === values[2])
          : sql.includes("WHERE type_key = $1 AND key = $2")
            ? projected.filter((row) => row.type_key === values[0] && row.key === values[1])
            : [];
        return {
          rowCount: rows.length,
          rows: rows.map((row) => ({
            reference_record_id: row.reference_record_id,
            attributes: row.attributes,
          })) as T[],
        };
      },
    },
  } as object as CatalogRuntimeDeps;
  const referenceData = createReferenceDataRuntime(deps);
  const text = (en: string) => ({ defaultLocale: "en" as const, values: { en } });
  const typeCommand = (command: ReferenceTypeCommand) =>
    referenceData.referenceTypeCommandHandler({ streamId: typeStream, command, context });
  const recordCommand = (command: ReferenceRecordCommand, streamId = recordStream) =>
    referenceData.referenceRecordCommandHandler({ streamId, command, context });
  return {
    deps,
    eventStore,
    referenceData,
    text,
    typeCommand,
    recordCommand,
    publishType: async () => {
      await typeCommand({ type: "CreateReferenceType", referenceTypeId: typeId, key: "set", name: text("Set") });
      await typeCommand({ type: "PublishReferenceType" });
    },
    createRecord: (id: ReferenceRecordId = recordId, overrides: CreateReferenceRecordOverrides = {}) =>
      recordCommand(
        {
          type: "CreateReferenceRecord",
          referenceRecordId: id,
          typeKey: "set",
          key: "1",
          name: text("Synthetic Set"),
          ...overrides,
        },
        `catalog.reference-record-${id}`,
      ),
    types: async (streamId: string) => (await eventStore.readStream({ streamId })).map((event) => event.eventType),
    provision: (referenceData: ReferenceDataServices, profile = syntheticProfile()) =>
      resolvePromotionReferenceHierarchy({ deps, referenceData, profile, normalized, context }),
    preview: (profile = syntheticProfile()) =>
      resolvePromotionReferenceHierarchyReadOnly({ deps, profile, normalized }),
  };
}

describe("promotion reference hierarchy provisioning against authoritative Reference Data histories", () => {
  it.each<[string, readonly ("create" | "publish")[]]>([
    ["empty", []],
    ["draft", ["create"]],
    ["active", ["create", "publish"]],
  ])("provisions a %s Set record to exactly one publication", async (_state, steps) => {
    const h = harness();
    if (steps.includes("create")) await h.createRecord();
    if (steps.includes("publish")) await h.recordCommand({ type: "PublishReferenceRecord" });

    const first = await h.provision(h.referenceData);
    const second = await h.provision(h.referenceData);

    expect(first.targetReferenceRecordId).toBe(recordId);
    expect(second).toEqual(first);
    expect(await h.types(recordStream)).toEqual(activeRecordHistory);
    expect(await h.types(typeStream)).toEqual(activeTypeHistory);
  });

  it.each(["deprecated", "archived"] as const)("refuses a %s Set record without authoring", async (state) => {
    const h = harness();
    await h.publishType();
    await h.createRecord();
    await h.recordCommand({ type: "PublishReferenceRecord" });
    await h.recordCommand({ type: "DeprecateReferenceRecord" });
    if (state === "archived") await h.recordCommand({ type: "ArchiveReferenceRecord" });
    const before = await h.types(recordStream);

    await expect(h.provision(h.referenceData)).rejects.toThrow(invalidRecord);
    await expect(h.preview()).rejects.toThrow(invalidRecord);
    expect(await h.types(recordStream)).toEqual(before);
    expect(await h.types(typeStream)).toEqual(activeTypeHistory);
  });

  describe("publication is fenced to the validated history (F1)", () => {
    // A real revision lands on the aggregate after provisioning validated it and
    // before it publishes; the publish must refuse rather than publish a record
    // or type the validation never saw.
    function revisingRecordHandlers(h: ReturnType<typeof harness>): ReferenceDataServices {
      const real = h.referenceData.referenceRecordCommandHandler;
      return {
        ...h.referenceData,
        referenceRecordCommandHandler: async (input) => {
          if (input.command.type === "PublishReferenceRecord") {
            await real({
              streamId: input.streamId,
              command: {
                type: "ReviseReferenceRecord",
                typeKey: "series",
                key: "other",
                name: h.text("Synthetic Other Series"),
              },
              context,
            });
          }
          return real(input);
        },
      };
    }

    function revisingTypeHandlers(h: ReturnType<typeof harness>): ReferenceDataServices {
      const real = h.referenceData.referenceTypeCommandHandler;
      return {
        ...h.referenceData,
        referenceTypeCommandHandler: async (input) => {
          if (input.command.type === "PublishReferenceType") {
            await real({
              streamId: input.streamId,
              command: { type: "ReviseReferenceType", key: "series", name: h.text("Synthetic Series") },
              context,
            });
          }
          return real(input);
        },
      };
    }

    it.each(["draft", "empty"] as const)(
      "refuses to publish a %s Set record revised between validation and publication",
      async (state) => {
        const h = harness();
        await h.publishType();
        if (state === "draft") await h.createRecord();

        await expect(h.provision(revisingRecordHandlers(h))).rejects.toMatchObject({ code: "concurrency_conflict" });

        expect(await h.types(recordStream)).toEqual([
          "catalog.reference-record.created",
          "catalog.reference-record.revised",
        ]);
        expect(await h.types(typeStream)).toEqual(activeTypeHistory);
      },
    );

    it.each(["draft", "empty"] as const)(
      "refuses to publish a %s Set type revised between validation and publication",
      async (state) => {
        const h = harness();
        if (state === "draft") {
          await h.typeCommand({
            type: "CreateReferenceType",
            referenceTypeId: typeId,
            key: "set",
            name: h.text("Set"),
          });
        }

        await expect(h.provision(revisingTypeHandlers(h))).rejects.toMatchObject({ code: "concurrency_conflict" });

        expect(await h.types(typeStream)).toEqual(["catalog.reference-type.created", "catalog.reference-type.revised"]);
        expect(await h.types(recordStream)).toEqual([]);
      },
    );
  });

  describe("reuse candidates are proven by their discovering selector (F2)", () => {
    const projectedByKey: ProjectedReferenceRecord = {
      reference_record_id: reusedId,
      type_key: "set",
      key: "1",
      attributes: {},
    };
    const projectedByAttribute: ProjectedReferenceRecord = {
      reference_record_id: reusedId,
      type_key: "set",
      key: "legacy-key",
      attributes: { [providerAttributeKey]: providerAttributeValue },
    };

    it("refuses a type/key candidate whose authoritative key was renamed away", async () => {
      const h = harness([projectedByKey]);
      await h.publishType();
      await h.createRecord(reusedId);
      await h.recordCommand({ type: "PublishReferenceRecord" }, reusedStream);
      await h.recordCommand(
        { type: "ReviseReferenceRecord", typeKey: "set", key: "renamed-away", name: h.text("Synthetic Other Set") },
        reusedStream,
      );
      const before = await h.types(reusedStream);

      await expect(h.provision(h.referenceData)).rejects.toThrow(invalidReused);
      await expect(h.preview()).rejects.toThrow(invalidReused);
      expect(await h.types(reusedStream)).toEqual(before);
      expect(await h.types(recordStream)).toEqual([]);
    });

    it("refuses a provider-attribute candidate whose authoritative attribute moved away", async () => {
      const h = harness([projectedByAttribute]);
      await h.publishType();
      await h.createRecord(reusedId, {
        key: "legacy-key",
        attributes: { [providerAttributeKey]: providerAttributeValue },
      });
      await h.recordCommand({ type: "PublishReferenceRecord" }, reusedStream);
      await h.recordCommand(
        {
          type: "ReviseReferenceRecord",
          typeKey: "set",
          key: "legacy-key",
          name: h.text("Synthetic Other Set"),
          attributes: { [providerAttributeKey]: "moved-away" },
        },
        reusedStream,
      );
      const before = await h.types(reusedStream);
      const profile = syntheticProfile({ providerAttribute: true });

      await expect(h.provision(h.referenceData, profile)).rejects.toThrow(invalidReused);
      await expect(h.preview(profile)).rejects.toThrow(invalidReused);
      expect(await h.types(reusedStream)).toEqual(before);
      expect(await h.types(recordStream)).toEqual([]);
    });

    it("reuses a provider-attribute candidate with a different canonical key while its attribute still holds", async () => {
      const h = harness([projectedByAttribute]);
      await h.publishType();
      await h.createRecord(reusedId, {
        key: "legacy-key",
        attributes: { [providerAttributeKey]: providerAttributeValue },
      });
      await h.recordCommand({ type: "PublishReferenceRecord" }, reusedStream);
      const before = await h.types(reusedStream);
      const profile = syntheticProfile({ providerAttribute: true });

      const provisioned = await h.provision(h.referenceData, profile);
      const previewed = await h.preview(profile);

      expect(provisioned.targetReferenceRecordId).toBe(reusedId);
      expect(previewed.targetReferenceRecordId).toBe(reusedId);
      expect(await h.types(reusedStream)).toEqual(before);
      expect(await h.types(recordStream)).toEqual([]);
    });

    it("proves a provider attribute by the text the discovery query compares, not its JSON type", async () => {
      // The projection matches `attributes ->> key` as text, so a stored JSON
      // number is the same selector as its requested text form.
      for (const [projectedText, requested, outcome] of [
        ["7", "7", "reused"],
        ["8", "8", "refused"],
      ] as const) {
        const h = harness([{ ...projectedByAttribute, attributes: { [providerAttributeKey]: projectedText } }]);
        await h.publishType();
        await h.createRecord(reusedId, { key: "legacy-key", attributes: { [providerAttributeKey]: 7 } });
        await h.recordCommand({ type: "PublishReferenceRecord" }, reusedStream);
        const before = await h.types(reusedStream);
        const profile = syntheticProfile({ providerAttribute: true, providerAttributeValue: requested });

        if (outcome === "reused") {
          expect((await h.provision(h.referenceData, profile)).targetReferenceRecordId).toBe(reusedId);
        } else {
          await expect(h.provision(h.referenceData, profile)).rejects.toThrow(invalidReused);
        }
        expect(await h.types(reusedStream)).toEqual(before);
        expect(await h.types(recordStream)).toEqual([]);
      }
    });

    it("selects the deterministic Set when the caught-up projection no longer offers the candidate", async () => {
      const h = harness();
      await h.createRecord(reusedId);
      await h.recordCommand({ type: "PublishReferenceRecord" }, reusedStream);
      await h.recordCommand(
        { type: "ReviseReferenceRecord", typeKey: "set", key: "renamed-away", name: h.text("Synthetic Other Set") },
        reusedStream,
      );

      expect((await h.preview()).targetReferenceRecordId).toBe(recordId);
      expect(await h.types(recordStream)).toEqual([]);
      expect((await h.provision(h.referenceData)).targetReferenceRecordId).toBe(recordId);
      expect(await h.types(recordStream)).toEqual(activeRecordHistory);
    });
  });

  describe("every history transition is validated while folding (F3)", () => {
    const published = { eventType: "catalog.reference-record.published", payload: {} };
    const deprecated = { eventType: "catalog.reference-record.deprecated", payload: {} };
    const createdAs = (referenceRecordId: string) => ({
      eventType: "catalog.reference-record.created",
      payload: {
        referenceRecordId,
        typeKey: "set",
        key: "1",
        name: { defaultLocale: "en", values: { en: "Synthetic Set" } },
        description: { defaultLocale: "en", values: { en: "" } },
        attributes: {},
        relationships: [],
      },
    });
    const aliasesFor = (referenceRecordId: string) => ({
      eventType: "catalog.reference-record.aliases-resolved",
      payload: {
        referenceRecordId,
        aliasLanguageCode: "en",
        aliases: [],
        resolvedAliasHash: "synthetic-resolved",
        resolverVersion: 1,
        resolvedAt: "2026-10-02T00:00:00.000Z",
      },
    });

    // SYNTHETIC poison appended through the raw store: contiguous histories the
    // decider could never have produced, some of which still fold to an
    // apparently valid draft/active state.
    it.each([
      ["a repeated publish", [createdAs(recordId), published, published]],
      ["a deprecation before publication", [createdAs(recordId), deprecated, published]],
      ["a second create", [createdAs(recordId), createdAs(recordId)]],
      ["a create naming another record", [createdAs(reusedId), published]],
      ["resolved aliases naming another record", [createdAs(recordId), aliasesFor(reusedId), published]],
    ])("refuses a Set record history with %s without authoring", async (_label, events) => {
      const h = harness();
      await h.publishType();
      await h.eventStore.appendToStream({ streamId: recordStream, expectedVersion: 0, context, events });
      const before = await h.types(recordStream);

      await expect(h.provision(h.referenceData)).rejects.toThrow(invalidRecord);
      await expect(h.preview()).rejects.toThrow(invalidRecord);
      expect(await h.types(recordStream)).toEqual(before);
      expect(await h.types(typeStream)).toEqual(activeTypeHistory);
    });

    it("accepts a record whose own resolved aliases follow its creation", async () => {
      const h = harness();
      await h.createRecord();
      await h.recordCommand({ type: "PublishReferenceRecord" });
      await h.recordCommand({
        type: "RecordReferenceRecordAliases",
        referenceRecordId: recordId,
        aliasLanguageCode: "en",
        aliases: [],
        resolvedAliasHash: "synthetic-resolved",
        resolverVersion: 1,
        resolvedAt: "2026-10-02T00:00:00.000Z",
      });
      const before = await h.types(recordStream);

      expect((await h.provision(h.referenceData)).targetReferenceRecordId).toBe(recordId);
      expect((await h.preview()).targetReferenceRecordId).toBe(recordId);
      expect(await h.types(recordStream)).toEqual(before);
    });

    it.each<[string, string, readonly string[]]>([
      ["a repeated publish", typeId, ["catalog.reference-type.published"]],
      ["a create naming another type", "rft_synthetic_hierarchy_other", []],
    ])("refuses a Set type history with %s without authoring", async (_label, createdTypeId, extra) => {
      const h = harness();
      await h.eventStore.appendToStream({
        streamId: typeStream,
        expectedVersion: 0,
        context,
        events: [
          {
            eventType: "catalog.reference-type.created",
            payload: {
              referenceTypeId: createdTypeId,
              key: "set",
              name: { defaultLocale: "en", values: { en: "Set" } },
              description: { defaultLocale: "en", values: { en: "" } },
              attributeKeys: [],
            },
          },
          { eventType: "catalog.reference-type.published", payload: {} },
          ...extra.map((eventType) => ({ eventType, payload: {} })),
        ],
      });
      const before = await h.types(typeStream);

      await expect(h.provision(h.referenceData)).rejects.toThrow(invalidType);
      expect(await h.types(typeStream)).toEqual(before);
      expect(await h.types(recordStream)).toEqual([]);
    });

    it("keeps the complete-stream continuity refusal ahead of any transition check", async () => {
      const h = harness();
      await h.publishType();
      await h.createRecord();
      await h.recordCommand({ type: "PublishReferenceRecord" });
      const gapped = {
        ...h.deps,
        eventStore: {
          readStream: async (input: Parameters<typeof h.eventStore.readStream>[0]) =>
            (await h.eventStore.readStream(input)).filter(
              (event) => event.streamId !== recordStream || event.streamVersion !== 1,
            ),
        },
      } as object as CatalogRuntimeDeps;

      await expect(
        resolvePromotionReferenceHierarchy({
          deps: gapped,
          referenceData: h.referenceData,
          profile: syntheticProfile(),
          normalized,
          context,
        }),
      ).rejects.toThrow(/inclusive read expected 1/);
      expect(await h.types(recordStream)).toEqual(activeRecordHistory);
    });
  });
});

/**
 * The real TCGdex profile over normalized Pokemon card payloads. Record ids,
 * keys and attributes are the staging Reference Records read at
 * 2026-10-18T18:58:27.675Z; expansion ids and names are the TCGdex
 * `/v2/{en,ja,zh-tw}` captures of 2026-10-18 (#10038).
 */
describe("TCGdex expansion reuse holds the payload language edition (#10059)", () => {
  type ExistingExpansion = Readonly<{ id: string; key: string; attributes: Readonly<Record<string, JsonValue>> }>;

  const seededBaseSet: ExistingExpansion = {
    id: "ref_seed_expansion_base_set",
    key: "base-set",
    attributes: {
      abbreviation: "BS",
      "card-count": 102,
      "release-date": "1999-01-09",
      "tcgdex-set-id": "base1",
      "language-editions": ["en"],
    },
  };
  const seededNeoGenesis: ExistingExpansion = {
    id: "ref_seed_expansion_neo_genesis",
    key: "neo-genesis",
    attributes: {
      abbreviation: "N1",
      "card-count": 111,
      "release-date": "2000-12-16",
      "tcgdex-set-id": "neo1",
      "language-editions": ["en"],
    },
  };
  // Provisioned before language editions were recorded, so it records none.
  const provisionedSurgingSparks: ExistingExpansion = {
    id: "ref_tcgdex_expansion_sv08",
    key: "sv08",
    attributes: {
      abbreviation: "SSP",
      "card-count": 191,
      "parallel-set-card-count": 165,
      "release-date": "2024-11-08",
      "tcgdex-set-id": "sv08",
    },
  };
  const englishFlashfire: ExistingExpansion = {
    id: "ref_tcgdex_expansion_xy2",
    key: "xy2",
    attributes: { "tcgdex-set-id": "xy2", "language-editions": ["en"] },
  };
  const japaneseSv8: ExistingExpansion = {
    id: "ref_tcgdex_expansion_sv8",
    key: "sv8",
    attributes: {
      "card-count": 106,
      "release-date": "2024-10-18",
      "tcgdex-set-id": "SV8",
      "language-editions": ["ja"],
    },
  };
  const traditionalChineseSv8: ExistingExpansion = {
    id: "ref_tcgdex_expansion_zh_tw_sv8",
    key: "zh-tw-sv8",
    attributes: {
      "card-count": 106,
      "release-date": "2024-10-25",
      "tcgdex-set-id": "SV8",
      "language-editions": ["zh-tw"],
    },
  };

  function tcgdexCard(
    languageCode: string,
    expansionId: string,
    expansionName: string,
    seriesId: string,
  ): SourceObservationPokemonCardNormalized {
    return {
      ...pokemonObservation({ expansionName, seriesName: seriesId.toUpperCase() }),
      languageCode,
      setId: expansionId,
      expansionId,
      seriesId,
    };
  }

  /** Active expansions in the authoritative store, offered by the projection in `projectedOrder`. */
  async function withExpansions(expansions: readonly ExistingExpansion[], projectedOrder = expansions) {
    const h = harness(
      projectedOrder.map(({ id, key, attributes }) => ({
        reference_record_id: id,
        type_key: "expansion",
        key,
        attributes,
      })),
    );
    for (const { id, key, attributes } of expansions) {
      const streamId = `catalog.reference-record-${id}`;
      await h.recordCommand(
        {
          type: "CreateReferenceRecord",
          referenceRecordId: id as ReferenceRecordId,
          typeKey: "expansion",
          key,
          name: h.text(key),
          attributes,
        },
        streamId,
      );
      await h.recordCommand({ type: "PublishReferenceRecord" }, streamId);
    }
    const preview = (normalized: SourceObservationPokemonCardNormalized) =>
      resolvePromotionReferenceHierarchyReadOnly({
        deps: h.deps,
        profile: tcgdexPokemonTcgProviderProfile,
        normalized,
      });
    const provision = (normalized: SourceObservationPokemonCardNormalized) =>
      resolvePromotionReferenceHierarchy({
        deps: h.deps,
        referenceData: h.referenceData,
        profile: tcgdexPokemonTcgProviderProfile,
        normalized,
        context,
      });
    return {
      preview,
      provision,
      /** Executing promotion and its read-only preview must name the same expansion. */
      resolve: async (normalized: SourceObservationPokemonCardNormalized) => {
        const previewed = (await preview(normalized)).targetReferenceRecordId;
        const provisioned = (await provision(normalized)).targetReferenceRecordId;
        expect(provisioned).toBe(previewed);
        return provisioned;
      },
      histories: async () => Promise.all(expansions.map(({ id }) => h.types(`catalog.reference-record-${id}`))),
      createdAttributes: async (id: string) =>
        (await h.eventStore.readStream({ streamId: `catalog.reference-record-${id}` }))[0]?.payload.attributes,
    };
  }

  it("refuses the English xy2 record by key for a Japanese XY2 and still reuses it for English xy2", async () => {
    const existing = await withExpansions([englishFlashfire]);
    const before = await existing.histories();

    expect(await existing.resolve(tcgdexCard("ja", "XY2", "ワイルドブレイズ", "XY"))).toBe(
      "ref_tcgdex_expansion_ja_xy2",
    );
    expect(await existing.resolve(tcgdexCard("en", "xy2", "Flashfire", "xy"))).toBe("ref_tcgdex_expansion_xy2");

    expect(await existing.createdAttributes("ref_tcgdex_expansion_ja_xy2")).toMatchObject({
      "tcgdex-set-id": "XY2",
      "language-editions": ["ja"],
    });
    expect(await existing.histories()).toEqual(before);
  });

  it("reuses only its own language's record when Japanese and Traditional Chinese SV8 share the TCGdex id", async () => {
    // The projection offers the other language's record first for Japanese.
    const existing = await withExpansions([japaneseSv8, traditionalChineseSv8], [traditionalChineseSv8, japaneseSv8]);
    const before = await existing.histories();

    expect(await existing.resolve(tcgdexCard("ja", "SV8", "超電ブレイカー", "SV"))).toBe("ref_tcgdex_expansion_sv8");
    // BCP 47 tags compare case-insensitively: the record holds `zh-tw`, the payload `zh-TW`.
    expect(await existing.resolve(tcgdexCard("zh-TW", "SV8", "超電突圍", "SV"))).toBe("ref_tcgdex_expansion_zh_tw_sv8");

    expect(await existing.histories()).toEqual(before);
  });

  it("refuses the seeded English Neo Genesis for the Japanese neo1 that shares its exact TCGdex id", async () => {
    const existing = await withExpansions([seededNeoGenesis]);
    const before = await existing.histories();

    expect(await existing.resolve(tcgdexCard("ja", "neo1", "金、銀、新世界へ...", "neo"))).toBe(
      "ref_tcgdex_expansion_ja_neo1",
    );
    expect(await existing.resolve(tcgdexCard("en", "neo1", "Neo Genesis", "neo"))).toBe(
      "ref_seed_expansion_neo_genesis",
    );

    expect(await existing.histories()).toEqual(before);
  });

  it("refuses a record of another language that holds the requested key instead of duplicating the key", async () => {
    // Key `sv8` belongs to Japanese 超電ブレイカー; the seed once named English Surging Sparks `sv8`.
    const existing = await withExpansions([japaneseSv8]);
    const before = await existing.histories();
    const englishSv8 = tcgdexCard("en", "sv8", "Surging Sparks", "sv");
    const conflict = "promotion-reference-language-edition-conflict:catalog.reference-record-ref_tcgdex_expansion_sv8";

    await expect(existing.preview(englishSv8)).rejects.toThrow(conflict);
    await expect(existing.provision(englishSv8)).rejects.toThrow(conflict);

    expect(await existing.histories()).toEqual(before);
  });

  it("reuses the seeded base1 and the provisioned sv08 records for English promotions", async () => {
    const existing = await withExpansions([seededBaseSet, provisionedSurgingSparks]);
    const before = await existing.histories();

    expect(await existing.resolve(tcgdexCard("en", "base1", "Base Set", "base"))).toBe("ref_seed_expansion_base_set");
    expect(await existing.resolve(tcgdexCard("en", "sv08", "Surging Sparks", "sv"))).toBe("ref_tcgdex_expansion_sv08");

    expect(await existing.histories()).toEqual(before);
  });
});
