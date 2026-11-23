import { describe, expect, it } from "vitest";
import { catalogSeedIds } from "@chase-sets/catalog-seed";
import { localizedTextMapFromEnglish } from "@chase-sets/localization";
import type { CatalogServices } from "../../../support/authoring-support/services";
import {
  decideDimension,
  evolveDimension,
  initialDimensionState,
  type DimensionCommand,
  type DimensionEvent,
} from "../domain/domain";
import { seedDimensions } from "./seed";

const streamOf = (dimensionId: string) => `catalog.dimension-${dimensionId}`;
const formStream = streamOf(catalogSeedIds.dimensions.form.dimensionId);
const conditionStream = streamOf(catalogSeedIds.dimensions.condition.dimensionId);
const gradingCompanyStream = streamOf(catalogSeedIds.dimensions.gradingCompany.dimensionId);
const gradeStream = streamOf(catalogSeedIds.dimensions.grade.dimensionId);

type StoredEvent = Readonly<{ event_type: string; payload: Record<string, unknown> }>;
type SentCommand = Readonly<{ streamId: string; command: DimensionCommand }>;

describe("dimension seed", () => {
  it("creates Condition and Grade as or-better and Form and Grading Company as exact, with no revision", async () => {
    const harness = createSeedDimensionsHarness(new Map());

    await seedDimensions(harness.services);

    expect(
      harness.sent
        .filter(({ command }) => command.type === "CreateDimension")
        .map(({ streamId, command }) => [streamId, valueKindOf(command), optionMatchingOf(command)]),
    ).toEqual([
      [formStream, "unordered", "exact"],
      [conditionStream, "ordered", "or-better"],
      [gradingCompanyStream, "unordered", "exact"],
      [gradeStream, "numeric", "or-better"],
    ]);
    expect(harness.sent.filter(({ command }) => command.type === "ReviseDimension")).toEqual([]);

    harness.sent.length = 0;
    await seedDimensions(harness.services);

    expect(harness.sent).toEqual([]);
  });

  it("gives active Dimensions seeded before option matching existed their seeded choice once", async () => {
    const harness = createSeedDimensionsHarness(retainedDimensions());

    await seedDimensions(harness.services);

    expect(harness.sent).toEqual([
      {
        streamId: conditionStream,
        command: {
          type: "ReviseDimension",
          key: "condition",
          name: localizedTextMapFromEnglish("Card Condition"),
          description: localizedTextMapFromEnglish("Operator wording"),
          valueKind: "ordered",
          optionMatching: "or-better",
        },
      },
      {
        streamId: gradeStream,
        command: {
          type: "ReviseDimension",
          key: "grade",
          name: localizedTextMapFromEnglish("Grade"),
          description: localizedTextMapFromEnglish("Operator wording"),
          valueKind: "numeric",
          optionMatching: "or-better",
        },
      },
    ]);
    expect(harness.fold(conditionStream)).toMatchObject({ status: "active", optionMatching: "or-better" });
    expect(harness.fold(gradeStream)).toMatchObject({ status: "active", optionMatching: "or-better" });
    expect(harness.fold(formStream).optionMatching).toBe("exact");

    harness.sent.length = 0;
    await seedDimensions(harness.services);

    expect(harness.sent).toEqual([]);
  });

  it("keeps every seeded Option, in order, when it reconciles fully seeded streams", async () => {
    const streams = new Map<string, StoredEvent[]>();
    await seedDimensions(createSeedDimensionsHarness(streams).services);
    // The same streams as an environment seeded before option matching existed holds them.
    for (const [streamId, events] of streams) {
      streams.set(
        streamId,
        events.map((event) =>
          event.event_type === "catalog.dimension.created"
            ? { ...event, payload: { ...event.payload, optionMatching: undefined } }
            : event,
        ),
      );
    }
    const harness = createSeedDimensionsHarness(streams);
    const before = [conditionStream, gradeStream].map((streamId) => harness.fold(streamId));
    expect(before.map((state) => state.optionMatching)).toEqual(["exact", "exact"]);
    expect(before.every((state) => state.options.length > 1)).toBe(true);

    await seedDimensions(harness.services);

    expect(harness.sent.map(({ streamId, command }) => [streamId, command.type])).toEqual([
      [conditionStream, "ReviseDimension"],
      [gradeStream, "ReviseDimension"],
    ]);
    for (const [index, streamId] of [conditionStream, gradeStream].entries()) {
      expect(harness.fold(streamId)).toEqual({ ...before[index]!, optionMatching: "or-better" });
    }
  });

  it("keeps a retained value kind that differs from the seeded one", async () => {
    const retained = retainedDimensions();
    retained.set(gradeStream, [
      {
        event_type: "catalog.dimension.created",
        payload: {
          dimensionId: catalogSeedIds.dimensions.grade.dimensionId,
          key: "grade",
          name: localizedTextMapFromEnglish("Grade"),
          description: localizedTextMapFromEnglish(""),
          valueKind: "ordered",
        },
      },
      { event_type: "catalog.dimension.activated", payload: {} },
    ]);
    const harness = createSeedDimensionsHarness(retained);

    await seedDimensions(harness.services);

    expect(harness.sent.find(({ streamId }) => streamId === gradeStream)?.command).toMatchObject({
      type: "ReviseDimension",
      valueKind: "ordered",
      optionMatching: "or-better",
    });
    expect(harness.fold(gradeStream)).toMatchObject({ valueKind: "ordered", optionMatching: "or-better" });
  });

  it("leaves a retained Dimension that was created with an option matching choice", async () => {
    const retained = retainedDimensions();
    const [created, activated] = retained.get(conditionStream)!;
    retained.set(conditionStream, [
      { ...created!, payload: { ...created!.payload, optionMatching: "exact" } },
      activated!,
    ]);
    const harness = createSeedDimensionsHarness(retained);

    await seedDimensions(harness.services);

    expect(harness.sent.map(({ streamId }) => streamId)).toEqual([gradeStream]);
    expect(harness.fold(conditionStream).optionMatching).toBe("exact");
  });

  it("fails instead of overwriting a revision that lands after the seed read the stream", async () => {
    const retained = retainedDimensions();
    const harness = createSeedDimensionsHarness(retained, (streamId) => {
      if (streamId === conditionStream) {
        retained.get(conditionStream)!.push({
          event_type: "catalog.dimension.revised",
          payload: {
            key: "condition",
            name: localizedTextMapFromEnglish("Renamed by an operator"),
            description: localizedTextMapFromEnglish(""),
            valueKind: "ordered",
            optionMatching: "exact",
          },
        });
      }
    });

    await expect(seedDimensions(harness.services)).rejects.toThrow("concurrency_conflict");

    expect(harness.fold(conditionStream)).toMatchObject({
      name: localizedTextMapFromEnglish("Renamed by an operator"),
      optionMatching: "exact",
    });

    harness.sent.length = 0;
    await seedDimensions(harness.services);

    expect(harness.sent.map(({ streamId }) => streamId)).toEqual([gradeStream]);
  });

  it("reconciles a draft Dimension seeded before option matching existed, then finishes it", async () => {
    const retained = retainedDimensions();
    retained.set(conditionStream, retained.get(conditionStream)!.slice(0, 1));
    const harness = createSeedDimensionsHarness(retained);

    await seedDimensions(harness.services);

    const condition = harness.sent.filter(({ streamId }) => streamId === conditionStream);
    expect(condition.map(({ command }) => command.type).filter((type) => type !== "AddOption")).toEqual([
      "ReviseDimension",
      "ActivateDimension",
    ]);
    expect(condition[0]!.command).toMatchObject({
      key: "condition",
      valueKind: "ordered",
      optionMatching: "or-better",
    });
    expect(harness.fold(conditionStream)).toMatchObject({ status: "active", optionMatching: "or-better" });

    harness.sent.length = 0;
    await seedDimensions(harness.services);

    expect(harness.sent).toEqual([]);
  });

  it("leaves a retained Dimension whose stream already records an option matching choice", async () => {
    const retained = retainedDimensions();
    retained.get(conditionStream)!.push({
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

    expect(harness.sent.map(({ streamId }) => streamId)).toEqual([gradeStream]);
    expect(harness.fold(conditionStream).optionMatching).toBe("exact");
  });

  it("leaves a retained Dimension an operator made unordered", async () => {
    const retained = retainedDimensions();
    retained.get(conditionStream)!.push({
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

    expect(harness.sent.map(({ streamId }) => streamId)).toEqual([gradeStream]);
    expect(harness.fold(conditionStream)).toMatchObject({ valueKind: "unordered", optionMatching: "exact" });
  });

  it("reconciles a retained Dimension whose name and description were recorded as plain strings", async () => {
    const retained = retainedDimensions();
    retained.set(conditionStream, [
      {
        event_type: "catalog.dimension.created",
        payload: {
          dimensionId: catalogSeedIds.dimensions.condition.dimensionId,
          key: "condition",
          name: "Condition",
          description: "",
          valueKind: "ordered",
        },
      },
      { event_type: "catalog.dimension.activated", payload: {} },
    ]);
    const harness = createSeedDimensionsHarness(retained);

    await seedDimensions(harness.services);

    expect(harness.sent.map(({ streamId }) => streamId)).toEqual([conditionStream, gradeStream]);
    expect(harness.fold(conditionStream)).toMatchObject({
      name: localizedTextMapFromEnglish("Condition"),
      description: { defaultLocale: "en", values: {} },
      valueKind: "ordered",
      optionMatching: "or-better",
    });
  });
});

function valueKindOf(command: DimensionCommand) {
  return command.type === "CreateDimension" ? command.valueKind : undefined;
}

function optionMatchingOf(command: DimensionCommand) {
  return command.type === "CreateDimension" ? command.optionMatching : undefined;
}

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
          description: localizedTextMapFromEnglish("Operator wording"),
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

/** Commands go through the real decider and their events are stored, so a second run reads what the first one wrote. */
function createSeedDimensionsHarness(
  streams: Map<string, StoredEvent[]>,
  /** Runs after the seed has read a stream and before its command is handled, as a concurrent writer would. */
  beforeHandle: (streamId: string) => void = () => {},
) {
  const sent: SentCommand[] = [];
  const fold = (streamId: string) =>
    (streams.get(streamId) ?? [])
      .map((stored) => ({ type: stored.event_type, data: stored.payload }) as unknown as DimensionEvent)
      .reduce(evolveDimension, initialDimensionState);
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
        expectedVersion,
      }: {
        streamId: string;
        command: DimensionCommand;
        expectedVersion?: number;
      }) => {
        beforeHandle(streamId);
        const stored = streams.get(streamId) ?? [];
        streams.set(streamId, stored);
        const events = decideDimension(fold(streamId), command);
        if (expectedVersion !== undefined && expectedVersion !== stored.length) {
          throw new Error("concurrency_conflict");
        }
        sent.push({ streamId, command });
        for (const event of events) {
          stored.push({ event_type: event.type, payload: event.data as Record<string, unknown> });
        }
      },
    },
  } as unknown as CatalogServices;

  return { sent, fold, services };
}
