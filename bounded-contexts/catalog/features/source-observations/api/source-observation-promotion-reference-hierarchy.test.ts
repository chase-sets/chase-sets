import { createHash } from "node:crypto";
import { createInMemoryEventStore } from "@chase-sets/event-core/test-support";
import type { JsonValue } from "@chase-sets/primitives/json";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { describe, expect, it, vi } from "vitest";
import type { CatalogRuntimeDeps } from "../../../support/authoring-support/runtime-support";
import type { ReferenceRecordId, ReferenceTypeId } from "../../../ids";
import { createReferenceDataRuntime, type ReferenceDataServices } from "../../reference-data/api/runtime";
import { pokemonExpansionReferenceRecordSeeds } from "../../reference-data/api/seed";
import type { ReferenceRecordCommand, ReferenceTypeCommand } from "../../reference-data/domain/domain";
import type { SourceObservationPokemonCardNormalized } from "../domain/domain";
import enSets from "./__fixtures__/tcgdex/en-sets.json";
import jaSets from "./__fixtures__/tcgdex/ja-sets.json";
import {
  lorcanajsonLorcanaCardReferenceProviderProfile,
  tcgdexPokemonTcgProviderProfile,
  type CatalogProviderIntegrationProfile,
} from "./provider-integration-profiles";
import {
  capturedTcgdexSet,
  context,
  lorcanaCardPrintObservation,
  pokemonObservation,
  tcgdexSetObservation,
} from "./seeding/runtime-test-harness";
import {
  resolvePromotionReferenceHierarchy,
  resolvePromotionReferenceHierarchyReadOnly,
} from "./source-observation-promotion-reference-hierarchy";
import { requireCatalogProviderSourceObservation } from "./promotion/provider-source-observation-normalizer";
import {
  ygojsonYugiohSetReferenceProviderProfile,
  ygojsonYugiohSetReferenceSourceObservationMappingContract,
} from "./providers/ygojson/executable-mapping-contract";
import { buildCatalogScopeRegistryProjectionHandlers } from "../../scope-registry/read-model/projection";

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
  it("promotes the captured YGOJSON set through the seeded hierarchy and scope projection", async () => {
    const h = harness([
      {
        reference_record_id: "ref_seed_pokemon_trading_card_game",
        type_key: "product-line",
        key: "pokemon-trading-card-game",
        attributes: {},
      },
      {
        reference_record_id: "ref_seed_magic_the_gathering",
        type_key: "product-line",
        key: "magic-the-gathering",
        attributes: {},
      },
      {
        reference_record_id: "ref_seed_one_piece_card_game",
        type_key: "product-line",
        key: "one-piece-card-game",
        attributes: {},
      },
      {
        reference_record_id: "ref_seed_disney_lorcana",
        type_key: "product-line",
        key: "disney-lorcana",
        attributes: {},
      },
    ]);
    const fixture = JSON.parse(
      readFileSync(
        fileURLToPath(
          new URL("./__fixtures__/ygojson-yugioh-set-reference-data/beginners-edition-2.json", import.meta.url),
        ),
        "utf8",
      ),
    ) as JsonValue;
    const normalized = requireCatalogProviderSourceObservation({
      contract: ygojsonYugiohSetReferenceSourceObservationMappingContract,
      payload: fixture,
      observedAt: "2026-10-18T19:00:00.000Z",
    }).normalized;
    if (normalized.kind !== "yugioh-set-reference")
      throw new Error("fixture did not normalize as Yu-Gi-Oh set reference");

    const result = await resolvePromotionReferenceHierarchy({
      deps: h.deps,
      referenceData: h.referenceData,
      profile: ygojsonYugiohSetReferenceProviderProfile,
      normalized,
      context,
    });
    expect(result.referenceRecordIdsByTypeKey["product-line"]).toBe(
      catalogSeedIds.referenceRecords.productLines.yuGiOhOfficialCardGame,
    );
    const productLineStream = `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.yuGiOhOfficialCardGame}`;
    expect(await h.eventStore.readStream({ streamId: productLineStream })).toContainEqual(
      expect.objectContaining({
        eventType: "catalog.reference-record.created",
        payload: expect.objectContaining({ key: "yu-gi-oh-official-card-game", typeKey: "product-line" }),
      }),
    );
    expect(result.referenceRecordIdsByTypeKey["product-line"]).not.toBe("ref_seed_pokemon_trading_card_game");
    expect(result.referenceRecordIdsByTypeKey["product-line"]).not.toBe("ref_seed_magic_the_gathering");
    expect(result.referenceRecordIdsByTypeKey["product-line"]).not.toBe("ref_seed_one_piece_card_game");
    expect(result.referenceRecordIdsByTypeKey["product-line"]).not.toBe("ref_seed_disney_lorcana");
    expect(result.targetReferenceRecordId).toBe("ref_ygojson_set_000f0093_1847_4db7_a315_5bd07f055c7a");

    const setStream = `catalog.reference-record-${result.targetReferenceRecordId}`;
    const setCreate = (await h.eventStore.readStream({ streamId: setStream })).find(
      (event) => event.eventType === "catalog.reference-record.created",
    );
    expect(setCreate?.payload).toMatchObject({
      typeKey: "set",
      key: "000f0093-1847-4db7-a315-5bd07f055c7a",
      relationships: [
        {
          relationshipType: "part-of",
          referenceId: catalogSeedIds.referenceRecords.productLines.yuGiOhOfficialCardGame,
        },
      ],
    });
    expect(
      (await h.eventStore.readStream({ streamId: setStream })).filter((event) =>
        event.eventType.includes("product-line"),
      ),
    ).toEqual([]);
    expect(
      await h.eventStore.readStream({ streamId: "catalog.reference-record-ref_ygojson_product_line_yu_gi_oh" }),
    ).toEqual([]);

    const projectedRows = new Map<string, Record<string, unknown>>();
    const projectionQuery = vi.fn(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("reference_record_id = ANY")) {
        const ids = Array.isArray(params?.[0]) ? (params?.[0] as readonly string[]) : [];
        return {
          rows: ids
            .map((id) => projectedRows.get(id))
            .filter((row): row is Record<string, unknown> => row !== undefined),
        };
      }
      if (/INSERT\s+INTO\s+catalog_scope_records/.test(sql)) {
        const values = params ?? [];
        const row = {
          scope_record_id: values[0],
          product_domain: values[1],
          scope_kind: values[2],
          reference_type_key: values[3],
          reference_record_id: values[4],
          reference_record_key: values[5],
          parent_scope_record_id: values[8] ?? null,
          product_line_scope_record_id: values[9] ?? null,
          series_scope_record_id: values[10] ?? null,
          lifecycle_status: values[16] ?? "draft",
        };
        projectedRows.set(String(values[4]), row);
        return { rows: [] };
      }
      if (/UPDATE\s+catalog_scope_records/.test(sql)) {
        const row = projectedRows.get(String(params?.[0]));
        if (row) row.lifecycle_status = params?.[1];
        return { rows: [] };
      }
      return { rows: [] };
    });
    const handlers = buildCatalogScopeRegistryProjectionHandlers({ query: projectionQuery });
    for (const streamId of [productLineStream, setStream]) {
      for (const event of await h.eventStore.readStream({ streamId })) {
        const handler = handlers[event.eventType];
        if (!handler) continue;
        await handler({
          streamId,
          data: event.payload,
          timing: { recordedAt: "2026-10-18T19:00:00.000Z" },
        } as never);
      }
    }
    const setRow = projectedRows.get(result.targetReferenceRecordId);
    expect(setRow).toMatchObject({
      product_domain: "yugioh",
      scope_kind: "set",
      lifecycle_status: "active",
      parent_scope_record_id: catalogSeedIds.referenceRecords.productLines.yuGiOhOfficialCardGame,
    });
    expect(
      [...projectedRows.values()].filter((row) => row.product_domain === "yugioh" && row.scope_kind === "set"),
    ).toHaveLength(1);
  });

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

/** The exact English TCGdex id each seeded Pokemon expansion must hold (`/v2/en/sets`, 2026-10-18). */
const englishTcgdexSetIdBySeedKey: Readonly<Record<string, string>> = {
  "base-set": "base1",
  jungle: "base2",
  "neo-genesis": "neo1",
  "wizards-black-star-promos": "basep",
  "prismatic-evolutions": "sv08.5",
  "surging-sparks": "sv08",
  "twilight-masquerade": "sv06",
};
const surgingSparks = pokemonExpansionReferenceRecordSeeds.find((def) => def.key === "surging-sparks")!;
const provisionedSurgingSparksDuplicateId = "ref_tcgdex_expansion_sv08" as ReferenceRecordId;

/**
 * The seeded Pokemon expansions behind the real Reference Data command handlers,
 * with a projection that follows each command the way the read model does, so
 * the discovery queries see each record's projected lifecycle status.
 */
function seededExpansionHarness() {
  const { eventStore } = createInMemoryEventStore();
  const projected = new Map<string, ProjectedReferenceRecord & { status: string }>();
  const deps = {
    eventStore,
    db: {
      query: async <T>(sql: string, values: readonly unknown[] = []) => {
        const discoverable = [...projected.values()].filter(
          (row) => !sql.includes("status IN ('draft', 'active')") || row.status === "draft" || row.status === "active",
        );
        const rows = sql.includes("attributes ->> $2")
          ? discoverable.filter((row) => row.type_key === values[0] && row.attributes[String(values[1])] === values[2])
          : sql.includes("WHERE type_key = $1 AND key = $2")
            ? discoverable.filter((row) => row.type_key === values[0] && row.key === values[1])
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
  const runtime = createReferenceDataRuntime(deps);
  const projectedStatus: Partial<Record<ReferenceRecordCommand["type"], string>> = {
    PublishReferenceRecord: "active",
    DeprecateReferenceRecord: "deprecated",
    ArchiveReferenceRecord: "archived",
  };
  const referenceData: ReferenceDataServices = {
    ...runtime,
    referenceRecordCommandHandler: async (input) => {
      const result = await runtime.referenceRecordCommandHandler(input);
      const id = input.streamId.slice("catalog.reference-record-".length);
      const { command } = input;
      if (command.type === "CreateReferenceRecord") {
        projected.set(id, {
          reference_record_id: id,
          type_key: command.typeKey,
          key: command.key,
          attributes: command.attributes ?? {},
          status: "draft",
        });
      }
      const row = projected.get(id);
      const status = projectedStatus[command.type];
      if (row && status) row.status = status;
      return result;
    },
  };
  const text = (en: string) => ({ defaultLocale: "en" as const, values: { en } });
  const recordCommand = (id: ReferenceRecordId, command: ReferenceRecordCommand) =>
    referenceData.referenceRecordCommandHandler({ streamId: `catalog.reference-record-${id}`, command, context });
  const types = async (id: ReferenceRecordId) =>
    (await eventStore.readStream({ streamId: `catalog.reference-record-${id}` })).map((event) => event.eventType);
  return {
    recordCommand,
    text,
    types,
    seededHistories: () => Promise.all(pokemonExpansionReferenceRecordSeeds.map((def) => types(def.referenceRecordId))),
    seedExpansions: async () => {
      for (const def of pokemonExpansionReferenceRecordSeeds) {
        await recordCommand(def.referenceRecordId, {
          type: "CreateReferenceRecord",
          referenceRecordId: def.referenceRecordId,
          typeKey: def.typeKey,
          key: def.key,
          name: text(def.name),
          description: text(def.description),
          attributes: def.attributes ?? {},
          relationships: def.relationships ?? [],
        });
        await recordCommand(def.referenceRecordId, { type: "PublishReferenceRecord" });
      }
    },
    provision: async (normalized: SourceObservationPokemonCardNormalized) =>
      (
        await resolvePromotionReferenceHierarchy({
          deps,
          referenceData,
          profile: tcgdexPokemonTcgProviderProfile,
          normalized,
          context,
        })
      ).targetReferenceRecordId,
    preview: async (normalized: SourceObservationPokemonCardNormalized) =>
      (
        await resolvePromotionReferenceHierarchyReadOnly({
          deps,
          profile: tcgdexPokemonTcgProviderProfile,
          normalized,
        })
      ).targetReferenceRecordId,
  };
}

describe("TCGdex English and Japanese set ids against the seeded Pokemon expansions (#10062)", () => {
  it("pins the set-list fixtures to the captured /v2/en/sets and /v2/ja/sets responses", () => {
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

    expect(digest(enSets)).toBe("5d1d49cc20ff35b5b93bd14226d80e9298b6ab33ce086ab128fbb6bd8cb5c79a");
    expect(digest(jaSets)).toBe("7f6a4c31dfd3344523f9565796a39fe01f98033acfd5dfb1b7498255131b0770");
  });

  it("reuses each seeded expansion for its English TCGdex set and none of them for Japanese SV8, SV9 and SV1a", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const h = seededExpansionHarness();
    await h.seedExpansions();
    const seededHistories = await h.seededHistories();

    const englishTargets: Record<string, { preview: string; provision: string }> = {};
    for (const def of pokemonExpansionReferenceRecordSeeds) {
      const normalized = tcgdexSetObservation("en", capturedTcgdexSet(enSets, englishTcgdexSetIdBySeedKey[def.key]!));
      englishTargets[def.key] = { preview: await h.preview(normalized), provision: await h.provision(normalized) };
    }
    const japaneseTargets: Record<string, string> = {};
    for (const setId of ["SV8", "SV9", "SV1a", "neo1"]) {
      japaneseTargets[setId] = await h.provision(tcgdexSetObservation("ja", capturedTcgdexSet(jaSets, setId)));
    }

    expect(englishTargets).toEqual(
      Object.fromEntries(
        pokemonExpansionReferenceRecordSeeds.map((def) => [
          def.key,
          { preview: def.referenceRecordId, provision: def.referenceRecordId },
        ]),
      ),
    );
    expect(japaneseTargets).toEqual({
      SV8: "ref_tcgdex_expansion_ja_sv8",
      SV9: "ref_tcgdex_expansion_ja_sv9",
      SV1a: "ref_tcgdex_expansion_ja_sv1a",
      neo1: "ref_tcgdex_expansion_ja_neo1",
    });
    expect(await h.seededHistories()).toEqual(seededHistories);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("reuses the seeded Surging Sparks for English sv08 once the provisioned duplicate is retired", async () => {
    const h = seededExpansionHarness();
    await h.seedExpansions();
    // The record TCGdex promotion provisioned beside the seeded Surging Sparks
    // while the seed held `sv8`, after the seed retired it.
    await h.recordCommand(provisionedSurgingSparksDuplicateId, {
      type: "CreateReferenceRecord",
      referenceRecordId: provisionedSurgingSparksDuplicateId,
      typeKey: "expansion",
      key: "sv08",
      name: h.text("Surging Sparks"),
      description: h.text("Surging Sparks Pokemon TCG expansion."),
      attributes: { abbreviation: "SSP", "tcgdex-set-id": "sv08" },
    });
    await h.recordCommand(provisionedSurgingSparksDuplicateId, { type: "PublishReferenceRecord" });
    await h.recordCommand(provisionedSurgingSparksDuplicateId, { type: "DeprecateReferenceRecord" });
    const duplicateHistory = await h.types(provisionedSurgingSparksDuplicateId);
    const normalized = tcgdexSetObservation("en", capturedTcgdexSet(enSets, "sv08"));

    expect(await h.preview(normalized)).toBe(surgingSparks.referenceRecordId);
    expect(await h.provision(normalized)).toBe(surgingSparks.referenceRecordId);
    expect(await h.types(provisionedSurgingSparksDuplicateId)).toEqual(duplicateHistory);
    expect(await h.types(surgingSparks.referenceRecordId)).toEqual(activeRecordHistory);
  });

  it("still refuses a retired seeded expansion instead of provisioning a new record beside it", async () => {
    const h = seededExpansionHarness();
    await h.seedExpansions();
    await h.recordCommand(surgingSparks.referenceRecordId, { type: "DeprecateReferenceRecord" });
    const retiredHistory = await h.types(surgingSparks.referenceRecordId);
    const normalized = tcgdexSetObservation("en", capturedTcgdexSet(enSets, "sv08"));
    const refused = `promotion-reference-history-invalid:catalog.reference-record-${surgingSparks.referenceRecordId}`;

    await expect(h.preview(normalized)).rejects.toThrow(refused);
    await expect(h.provision(normalized)).rejects.toThrow(refused);
    expect(await h.types(surgingSparks.referenceRecordId)).toEqual(retiredHistory);
    expect(await h.types(provisionedSurgingSparksDuplicateId)).toEqual([]);
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
