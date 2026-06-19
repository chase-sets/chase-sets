import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { seedMagicReferenceData } from "./seed";

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
});

function createReferenceSeedHarness(input: Readonly<{ existingReferenceTypeKeys?: ReadonlySet<string> }> = {}) {
  const existingReferenceTypeKeys =
    input.existingReferenceTypeKeys ?? new Set(["manufacturer", "product-line", "series", "expansion"]);
  type ReferenceTypeRow = { reference_type_id: string; key: string; status: string };
  const referenceTypeEntries: [string, ReferenceTypeRow][] = [
    [
      "manufacturer",
      { reference_type_id: catalogSeedIds.referenceTypes.manufacturer, key: "manufacturer", status: "active" },
    ],
    [
      "product-line",
      { reference_type_id: catalogSeedIds.referenceTypes.productLine, key: "product-line", status: "active" },
    ],
    ["series", { reference_type_id: catalogSeedIds.referenceTypes.series, key: "series", status: "active" }],
    ["expansion", { reference_type_id: catalogSeedIds.referenceTypes.expansion, key: "expansion", status: "active" }],
    ["set", { reference_type_id: catalogSeedIds.referenceTypes.set, key: "set", status: "active" }],
  ];
  const referenceTypes = new Map<string, { reference_type_id: string; key: string; status: string }>(
    referenceTypeEntries.filter(([key]) => existingReferenceTypeKeys.has(key)),
  );
  const referenceRecords = new Map<
    string,
    { reference_record_id: string; type_key: string; key: string; status: string }
  >();
  const commands: { streamId: string; type: string; key: string | undefined }[] = [];

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

        return { rows: [] as T[] };
      },
    },
    referenceData: {
      referenceTypeCommandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: { type: string; referenceTypeId?: string; key?: string };
      }) => {
        commands.push({ streamId, type: command.type, key: command.key });
        if (command.type === "CreateReferenceType" && command.referenceTypeId && command.key) {
          referenceTypes.set(command.key, {
            reference_type_id: command.referenceTypeId,
            key: command.key,
            status: "draft",
          });
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
        command: { type: string; referenceRecordId?: string; typeKey?: string; key?: string };
      }) => {
        commands.push({ streamId, type: command.type, key: command.key });
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
  };

  return { commands, services };
}
