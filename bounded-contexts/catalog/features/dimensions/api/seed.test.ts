import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import type { CatalogServices } from "../../../support/authoring-support/services";
import { seedDimensions } from "./seed";

const streamOf = (dimensionId: string) => `catalog.dimension-${dimensionId}`;

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
      [streamOf(catalogSeedIds.dimensions.form.dimensionId), "unordered", "exact"],
      [streamOf(catalogSeedIds.dimensions.condition.dimensionId), "ordered", "or-better"],
      [streamOf(catalogSeedIds.dimensions.gradingCompany.dimensionId), "unordered", "exact"],
      [streamOf(catalogSeedIds.dimensions.grade.dimensionId), "numeric", "or-better"],
    ]);
  });

  it("sends nothing to Dimensions that were seeded before option matching existed", async () => {
    const harness = createSeedDimensionsHarness(retainedDimensions());

    await seedDimensions(harness.services);

    expect(harness.commands).toEqual([]);
  });
});

function retainedDimensions(): Map<string, StoredEvent[]> {
  const retained = (dimensionId: string, key: string, name: string, valueKind: string): [string, StoredEvent[]] => [
    streamOf(dimensionId),
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
    retained(catalogSeedIds.dimensions.condition.dimensionId, "condition", "Condition", "ordered"),
    retained(catalogSeedIds.dimensions.gradingCompany.dimensionId, "grading-company", "Grading Company", "unordered"),
    retained(catalogSeedIds.dimensions.grade.dimensionId, "grade", "Grade", "numeric"),
  ]);
}

function createSeedDimensionsHarness(streams: Map<string, StoredEvent[]>) {
  const commands: SentCommand[] = [];
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
        command: { type: string; valueKind?: string; optionMatching?: string };
      }) => {
        commands.push({
          streamId,
          type: command.type,
          valueKind: command.valueKind,
          optionMatching: command.optionMatching,
        });
      },
    },
  } as unknown as CatalogServices;

  return { commands, services };
}
