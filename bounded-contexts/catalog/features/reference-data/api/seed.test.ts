import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedLorcanaReferenceData, seedMagicReferenceData, seedOnePieceReferenceData } from "./seed";

describe("reference data seed", () => {
  it("reconciles Magic reference roots and Time Spiral without recreating Pokemon reference data", async () => {
    const harness = createReferenceSeedHarness();

    const ids = await seedMagicReferenceData(harness.services as never);

    expect(ids.sets["time-spiral"]).toBe(catalogSeedIds.referenceRecords.sets.timeSpiral);
    expect(harness.commands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "CreateReferenceType",
        key: "set",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "CreateReferenceRecord",
        key: "wizards-of-the-coast",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "CreateReferenceRecord",
        key: "magic-the-gathering",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "CreateReferenceRecord",
        key: "time-spiral",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
  });

  it("creates supporting reference types before Magic reference records when bootstrap data is partial", async () => {
    const harness = createReferenceSeedHarness({
      existingReferenceTypeKeys: new Set(["set"]),
    });

    await seedMagicReferenceData(harness.services as never);

    expect(harness.commands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.manufacturer}`,
        type: "CreateReferenceType",
        key: "manufacturer",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.manufacturer}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.productLine}`,
        type: "CreateReferenceType",
        key: "product-line",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.productLine}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "CreateReferenceRecord",
        key: "wizards-of-the-coast",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.wizardsOfTheCoast}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "CreateReferenceRecord",
        key: "magic-the-gathering",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.magicTheGathering}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "CreateReferenceRecord",
        key: "time-spiral",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.timeSpiral}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
  });

  it("seeds One Piece reference taxonomy idempotently with stable product-line naming", async () => {
    const harness = createReferenceSeedHarness({
      existingReferenceTypeKeys: new Set(["manufacturer", "product-line"]),
    });

    const ids = await seedOnePieceReferenceData(harness.services as never);
    const firstRunCommands = [...harness.commands];
    harness.commands.length = 0;
    const firstRunAliasCommands = [...harness.aliasCommands];
    harness.aliasCommands.length = 0;

    const rerunIds = await seedOnePieceReferenceData(harness.services as never);

    expect(ids.sets["romance-dawn"]).toBe(catalogSeedIds.referenceRecords.sets.romanceDawn);
    expect(rerunIds).toEqual(ids);
    expect(harness.commands).toEqual([]);
    expect(harness.aliasCommands).toEqual([]);
    expect(firstRunCommands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "CreateReferenceType",
        key: "set",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.bandai}`,
        type: "CreateReferenceRecord",
        key: "bandai",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.bandai}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.onePieceCardGame}`,
        type: "CreateReferenceRecord",
        key: "one-piece-card-game",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.onePieceCardGame}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.romanceDawn}`,
        type: "CreateReferenceRecord",
        key: "romance-dawn",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.romanceDawn}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "one-piece-card-game",
        name: "One Piece Card Game",
        attributes: { "official-name": "One Piece Card Game", "short-name": "One Piece" },
      }),
    );
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "romance-dawn",
        attributes: expect.objectContaining({
          "set-code": "OP-01",
          "scrydex-set-id": "op-01",
          "tcgplayer-set-name": "Romance Dawn",
        }),
        relationships: [
          { relationshipType: "part-of", referenceId: catalogSeedIds.referenceRecords.productLines.onePieceCardGame },
        ],
      }),
    );
    expect(firstRunAliasCommands).toEqual([
      expect.objectContaining({
        streamId: expect.stringMatching(/^catalog\.alias-/),
        type: "ProposeCatalogAlias",
        aliasText: "OP-01",
        targetId: catalogSeedIds.referenceRecords.sets.romanceDawn,
        targetKey: "set",
        reviewStatus: "auto-accepted",
      }),
    ]);
  });

  it("seeds Lorcana main chapter and promo/special set identity as reference data", async () => {
    const harness = createReferenceSeedHarness({
      existingReferenceTypeKeys: new Set(["manufacturer", "product-line"]),
    });

    const ids = await seedLorcanaReferenceData(harness.services as never);

    expect(ids.sets["the-first-chapter"]).toBe(catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter);
    expect(ids.sets["d23-collection"]).toBe(catalogSeedIds.referenceRecords.sets.lorcanaD23Collection);
    expect(harness.commands).toEqual([
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "CreateReferenceType",
        key: "set",
      },
      {
        streamId: `catalog.reference-type-${catalogSeedIds.referenceTypes.set}`,
        type: "PublishReferenceType",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.ravensburger}`,
        type: "CreateReferenceRecord",
        key: "ravensburger",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.manufacturers.ravensburger}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.disneyLorcana}`,
        type: "CreateReferenceRecord",
        key: "disney-lorcana",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.productLines.disneyLorcana}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter}`,
        type: "CreateReferenceRecord",
        key: "the-first-chapter",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaD23Collection}`,
        type: "CreateReferenceRecord",
        key: "d23-collection",
      },
      {
        streamId: `catalog.reference-record-${catalogSeedIds.referenceRecords.sets.lorcanaD23Collection}`,
        type: "PublishReferenceRecord",
        key: undefined,
      },
    ]);
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "the-first-chapter",
        attributes: expect.objectContaining({
          "set-code": "1",
          "chapter-number": 1,
          "set-kind": "chapter",
          "lorcanajson-set-code": "1",
          "lorcast-set-code": "1",
        }),
        relationships: [
          { relationshipType: "part-of", referenceId: catalogSeedIds.referenceRecords.productLines.disneyLorcana },
        ],
      }),
    );
    expect(harness.details).toContainEqual(
      expect.objectContaining({
        key: "d23-collection",
        attributes: expect.objectContaining({
          "set-code": "D23",
          "set-kind": "promo-special",
          "lorcast-set-code": "D23",
          "tcgplayer-set-name": "D23 Promos",
        }),
      }),
    );
    expect(harness.aliasCommands).toEqual([
      expect.objectContaining({
        streamId: expect.stringMatching(/^catalog\.alias-/),
        type: "ProposeCatalogAlias",
        aliasText: "1",
        targetId: catalogSeedIds.referenceRecords.sets.lorcanaTheFirstChapter,
        targetKey: "set",
        reviewStatus: "auto-accepted",
      }),
      expect.objectContaining({
        streamId: expect.stringMatching(/^catalog\.alias-/),
        type: "ProposeCatalogAlias",
        aliasText: "D23",
        targetId: catalogSeedIds.referenceRecords.sets.lorcanaD23Collection,
        targetKey: "set",
        reviewStatus: "auto-accepted",
      }),
    ]);
  });
});

function createReferenceSeedHarness(input: Readonly<{ existingReferenceTypeKeys?: ReadonlySet<string> }> = {}) {
  const existingReferenceTypeKeys =
    input.existingReferenceTypeKeys ?? new Set(["manufacturer", "product-line", "series", "expansion"]);
  const attributeKeysByType = {
    manufacturer: ["homepage-url"],
    "product-line": ["official-name", "short-name"],
    series: ["tcgdex-series-id"],
    expansion: [
      "abbreviation",
      "card-count",
      "parallel-set-card-count",
      "printed-card-count",
      "release-date",
      "tcgdex-set-id",
    ],
    set: [
      "set-code",
      "printed-card-count",
      "release-date",
      "mtgjson-set-code",
      "scryfall-set-code",
      "scrydex-set-id",
      "chapter-number",
      "set-kind",
      "lorcanajson-set-code",
      "lorcanajson-set-name",
      "lorcast-set-code",
      "lorcast-set-name",
      "tcgplayer-set-name",
    ],
  } as const;
  type ReferenceTypeRow = {
    reference_type_id: string;
    key: keyof typeof attributeKeysByType;
    name_i18n: { defaultLocale: "en"; values: { en: string } };
    description_i18n: { defaultLocale: "en"; values: Record<string, string> };
    attribute_keys: string[];
    status: string;
  };
  const referenceTypeRow = (referenceTypeId: string, key: keyof typeof attributeKeysByType): ReferenceTypeRow => ({
    reference_type_id: referenceTypeId,
    key,
    name_i18n: { defaultLocale: "en", values: { en: key } },
    description_i18n: { defaultLocale: "en", values: {} },
    attribute_keys: [...attributeKeysByType[key]],
    status: "active",
  });
  const referenceTypeEntries: [string, ReferenceTypeRow][] = [
    ["manufacturer", referenceTypeRow(catalogSeedIds.referenceTypes.manufacturer, "manufacturer")],
    ["product-line", referenceTypeRow(catalogSeedIds.referenceTypes.productLine, "product-line")],
    ["series", referenceTypeRow(catalogSeedIds.referenceTypes.series, "series")],
    ["expansion", referenceTypeRow(catalogSeedIds.referenceTypes.expansion, "expansion")],
    ["set", referenceTypeRow(catalogSeedIds.referenceTypes.set, "set")],
  ];
  const referenceTypes = new Map<string, ReferenceTypeRow>(
    referenceTypeEntries.filter(([key]) => existingReferenceTypeKeys.has(key)),
  );
  const referenceRecords = new Map<
    string,
    { reference_record_id: string; type_key: string; key: string; status: string }
  >();
  const referenceAliases = new Set<string>();
  const commands: { streamId: string; type: string; key: string | undefined }[] = [];
  const aliasCommands: {
    streamId: string;
    type: string;
    aliasText: string | undefined;
    targetId: string | null | undefined;
    targetKey: string | undefined;
    reviewStatus: string | undefined;
  }[] = [];
  const details: {
    key: string | undefined;
    name?: string;
    attributes?: unknown;
    relationships?: unknown;
  }[] = [];

  const services = {
    db: {
      query: async <T>(sql: string, values: readonly unknown[]) => {
        if (sql.includes("FROM catalog_reference_types")) {
          const referenceTypeId = String(values[0]);
          const key = String(values[1]);
          const row =
            referenceTypes.get(key) ??
            Array.from(referenceTypes.values()).find((candidate) => candidate.reference_type_id === referenceTypeId);
          return { rows: (row ? [row] : []) as T[] };
        }

        if (sql.includes("FROM catalog_reference_records")) {
          const referenceRecordId = String(values[0]);
          const typeKey = String(values[1]);
          const key = String(values[2]);
          const row =
            referenceRecords.get(`${typeKey}:${key}`) ??
            Array.from(referenceRecords.values()).find(
              (candidate) => candidate.reference_record_id === referenceRecordId,
            );
          return { rows: (row ? [row] : []) as T[] };
        }

        if (sql.includes("FROM catalog_reference_record_aliases")) {
          const aliasHash = String(values[0]);
          return { rows: (referenceAliases.has(aliasHash) ? [{ alias_hash: aliasHash }] : []) as T[] };
        }

        return { rows: [] as T[] };
      },
    },
    referenceData: {
      referenceTypeCommandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: {
          type: string;
          referenceTypeId?: string;
          key?: keyof typeof attributeKeysByType;
          attributeKeys?: readonly string[];
        };
      }) => {
        commands.push({ streamId, type: command.type, key: command.key });
        details.push({ key: command.key });
        if (command.type === "CreateReferenceType" && command.referenceTypeId && command.key) {
          referenceTypes.set(command.key, {
            ...referenceTypeRow(command.referenceTypeId, command.key),
            attribute_keys: [...(command.attributeKeys ?? [])],
            status: "draft",
          });
        }
        if (command.type === "ReviseReferenceType" && command.key) {
          const row = referenceTypes.get(command.key);
          if (row) {
            row.attribute_keys = [...(command.attributeKeys ?? row.attribute_keys)];
          }
        }
        if (command.type === "PublishReferenceType") {
          const row = Array.from(referenceTypes.values()).find((candidate) =>
            streamId.endsWith(candidate.reference_type_id),
          );
          if (row) {
            row.status = "active";
          }
        }
      },
      referenceRecordCommandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: {
          type: string;
          referenceRecordId?: string;
          typeKey?: string;
          key?: string;
          name?: { values?: { en?: string } };
          attributes?: unknown;
          relationships?: unknown;
        };
      }) => {
        commands.push({ streamId, type: command.type, key: command.key });
        details.push({
          key: command.key,
          name: command.name?.values?.en,
          attributes: command.attributes,
          relationships: command.relationships,
        });
        if (command.type === "CreateReferenceRecord" && command.referenceRecordId && command.typeKey && command.key) {
          referenceRecords.set(`${command.typeKey}:${command.key}`, {
            reference_record_id: command.referenceRecordId,
            type_key: command.typeKey,
            key: command.key,
            status: "draft",
          });
        }
        if (command.type === "PublishReferenceRecord") {
          const row = Array.from(referenceRecords.values()).find((candidate) =>
            streamId.endsWith(candidate.reference_record_id),
          );
          if (row) {
            row.status = "active";
          }
        }
      },
    },
    catalogAliases: {
      catalogAliasCommandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: {
          type: string;
          candidate?: {
            aliasHash: string;
            aliasText: string;
            target: { targetId: string | null; targetKey: string };
            reviewStatus: string;
          };
        };
      }) => {
        aliasCommands.push({
          streamId,
          type: command.type,
          aliasText: command.candidate?.aliasText,
          targetId: command.candidate?.target.targetId,
          targetKey: command.candidate?.target.targetKey,
          reviewStatus: command.candidate?.reviewStatus,
        });
        if (command.type === "ProposeCatalogAlias" && command.candidate) {
          referenceAliases.add(command.candidate.aliasHash);
        }
      },
    },
  };

  return { aliasCommands, commands, details, services };
}
