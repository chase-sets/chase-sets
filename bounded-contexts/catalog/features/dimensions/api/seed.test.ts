import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedDimensions } from "./seed";

const conditionStream = `catalog.dimension-${catalogSeedIds.dimensions.condition.dimensionId}`;
const gradeStream = `catalog.dimension-${catalogSeedIds.dimensions.grade.dimensionId}`;

type StoredEvent = Readonly<{ event_type: string; payload: Record<string, unknown> }>;
type SentCommand = Readonly<{ streamId: string; type: string; valueKind?: string; optionMatching?: string }>;

describe("dimension seed", () => {
  it("creates Condition and Grade as or-better and Form and Grading Company as exact", async () => {
    const harness = createSeedDimensionsHarness(new Map());

    await seedDimensions(harness.services);

    expect(
      harness.commands
        .filter((command) => command.type === "CreateDimension")
        .map((command) => [command.streamId, command.valueKind, command.optionMatching]),
    ).toEqual([
      [`catalog.dimension-${catalogSeedIds.dimensions.form.dimensionId}`, "unordered", "exact"],
      [conditionStream, "ordered", "or-better"],
      [`catalog.dimension-${catalogSeedIds.dimensions.gradingCompany.dimensionId}`, "unordered", "exact"],
      [gradeStream, "numeric", "or-better"],
    ]);
    expect(harness.commands.filter((command) => command.type === "ReviseDimension")).toEqual([]);
  });

  it("gives Dimensions seeded before option matching existed their seeded choice once", async () => {
    const harness = createSeedDimensionsHarness(retainedDimensions());

    await seedDimensions(harness.services);

    expect(harness.commands).toEqual([
      { streamId: conditionStream, type: "ReviseDimension", valueKind: "ordered", optionMatching: "or-better" },
      { streamId: gradeStream, type: "ReviseDimension", valueKind: "numeric", optionMatching: "or-better" },
    ]);
    expect(harness.revisedNames).toEqual(["Card Condition", "Grade"]);

    harness.commands.length = 0;
    await seedDimensions(harness.services);

    expect(harness.commands).toEqual([]);
  });

  it("leaves a retained Dimension whose stream already records an option matching choice", async () => {
    const retained = retainedDimensions();
    retained.get(conditionStream)?.push({
      event_type: "catalog.dimension.revised",
      payload: {
        key: "condition",
        name: localizedTextMapFromEnglish("Condition"),
        description: localizedTextMapFromEnglish(""),
        valueKind: "ordered",
        optionMatching: "exact",
      },
    });
    const harness = createSeedDimensionsHarness(retained);

    await seedDimensions(harness.services);

    expect(harness.commands.map((command) => command.streamId)).toEqual([gradeStream]);
  });

  it("leaves a retained Dimension an operator made unordered", async () => {
    const retained = retainedDimensions();
    retained.get(conditionStream)?.push({
      event_type: "catalog.dimension.revised",
      payload: {
        key: "condition",
        name: localizedTextMapFromEnglish("Condition"),
        description: localizedTextMapFromEnglish(""),
        valueKind: "unordered",
      },
    });
    const harness = createSeedDimensionsHarness(retained);

    await seedDimensions(harness.services);

    expect(harness.commands.map((command) => command.streamId)).toEqual([gradeStream]);
  });
});

function retainedDimensions(): Map<string, StoredEvent[]> {
  const retained = (dimensionId: string, key: string, name: string, valueKind: string): [string, StoredEvent[]] => [
    `catalog.dimension-${dimensionId}`,
    [
      {
        event_type: "catalog.dimension.created",
        payload: {
          dimensionId,
          key,
          name: localizedTextMapFromEnglish(name),
          description: localizedTextMapFromEnglish(""),
          valueKind,
        },
      },
      { event_type: "catalog.dimension.activated", payload: {} },
    ],
  ];

  return new Map([
    retained(catalogSeedIds.dimensions.form.dimensionId, "form", "Form", "unordered"),
    retained(catalogSeedIds.dimensions.condition.dimensionId, "condition", "Card Condition", "ordered"),
    retained(catalogSeedIds.dimensions.gradingCompany.dimensionId, "grading-company", "Grading Company", "unordered"),
    retained(catalogSeedIds.dimensions.grade.dimensionId, "grade", "Grade", "numeric"),
  ]);
}

function createSeedDimensionsHarness(streams: Map<string, StoredEvent[]>) {
  const commands: SentCommand[] = [];
  const revisedNames: string[] = [];
  const services = {
    db: {
      query: async <T>(_sql: string, values: readonly unknown[]) => {
        const streamId = String(values[0]);
        const rows = (streams.get(streamId) ?? []).map((event, index) => ({
          stream_id: streamId,
          stream_version: index + 1,
          ...event,
        }));

        return { rowCount: rows.length, rows: rows as T[] };
      },
    },
    dimensions: {
      commandHandler: async ({
        streamId,
        command,
      }: {
        streamId: string;
        command: {
          type: string;
          name?: { values: Record<string, string> };
          valueKind?: string;
          optionMatching?: string;
        };
      }) => {
        if (command.type === "CreateDimension" || command.type === "ReviseDimension") {
          commands.push({
            streamId,
            type: command.type,
            valueKind: command.valueKind,
            optionMatching: command.optionMatching,
          });
        }
        if (command.type === "ReviseDimension") {
          revisedNames.push(command.name?.values.en ?? "");
          streams.get(streamId)?.push({
            event_type: "catalog.dimension.revised",
            payload: { ...command, type: undefined },
          });
        }
      },
    },
  } as unknown as CatalogServices;

  return { commands, revisedNames, services };
}
