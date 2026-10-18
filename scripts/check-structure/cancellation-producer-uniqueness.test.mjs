import { describe, expect, it } from "vitest";
import {
  cancellationMapperAuthor,
  cancellationMapperPath,
  evaluateCancellationProducerUniqueness,
  plantedCancellationSources,
  plantedCancelledAuthor,
  scan,
} from "./cancellation-producer-uniqueness.mjs";

const sourceEvents = "bounded-contexts/notifications/features/notification-center/integrations/source-events";
const projectorPath = `${sourceEvents}/notification-projector.ts`;
const mapperSource = `export function mapOrderCancelledToNotification(input) {
  const channels = input.buyerEmail
    ? [{ channel: "web" }, { channel: "email", to: [{ email: input.buyerEmail }] }]
    : [{ channel: "web" }];
  return { messageType: "ordering.order.cancelled", templateId: "order_cancelled", channels };
}`;
const projectorSource = `import { mapOrderCancelledToNotification } from "./notification-intents";
export async function project(outbox, event) {
  if (event.type === "ordering.order.cancelled") {
    const message = mapOrderCancelledToNotification(event.data);
    if (message) await outbox.enqueueNotification({ message });
  }
  await outbox.enqueueNotification({ message: { messageType: "ordering.order.created", channels: [{ channel: "web" }] } });
}`;
// Three tracked files: the mapper, its projector with a safe message and sink, and one excluded test.
const baseSources = new Map([
  [cancellationMapperPath, mapperSource],
  [projectorPath, projectorSource],
]);
const baseFiles = [cancellationMapperPath, projectorPath, `${sourceEvents}/notification-projector.test.ts`].sort();
const plantedPair = (directory) => [...plantedCancellationSources].filter(([file]) => file.includes(`/${directory}/`));
const cancelledPair = plantedPair("synthetic-cancellation-producer");
const createdPair = plantedPair("synthetic-cancellation-control");

function fixture(extra = []) {
  const files = [...baseFiles, ...extra.map(([file]) => file)].sort();
  return { files, sources: new Map([...baseSources, ...extra]) };
}

function expectCounts(result, total, scanned) {
  expect(result.total).toBe(total);
  expect(result.scanned).toBe(scanned);
  expect(result.total).toBe(result.scanned + result.excluded);
  expect(result.safeMessages).toBeGreaterThan(0);
  expect(result.sinks).toBeGreaterThan(0);
}

describe("cancellation producer uniqueness scan", () => {
  it("accepts the mapper as the one structural producer", () => {
    const { files, sources } = fixture();
    const result = scan(files, sources, files);
    expect(result.authors).toEqual([cancellationMapperAuthor]);
    expectCounts(result, 3, 2);
  });

  it("follows imported aliases and closure ownership to a second producer", () => {
    const { files, sources } = fixture(cancelledPair);
    const result = scan(files, sources, files);
    expect(result.authors).toEqual([cancellationMapperAuthor, plantedCancelledAuthor].sort());
    expectCounts(result, 5, 4);
  });

  it("keeps the created control to the mapper alone", () => {
    const { files, sources } = fixture(createdPair);
    const result = scan(files, sources, files);
    expect(result.authors).toEqual([cancellationMapperAuthor]);
    expectCounts(result, 5, 4);
  });

  it("requires the tracked source list", () => {
    const { files, sources } = fixture();
    expect(() => scan(files, sources)).toThrow("Expected tracked source list is required");
    expectCounts(scan(files, sources, files), 3, 2);
  });

  it("rejects omitted tracked source discovery", () => {
    const { files, sources } = fixture();
    expect(() =>
      scan(
        files.filter((file) => file !== projectorPath),
        sources,
        files,
      ),
    ).toThrow("Omitted tracked source discovery");
    expectCounts(scan(files, sources, files), 3, 2);
  });

  it("rejects an unreadable or omitted production source", () => {
    const { files, sources } = fixture();
    const unreadable = new Map(sources);
    unreadable.delete(cancellationMapperPath);
    expect(() => scan(files, unreadable, files)).toThrow("Unreadable or omitted production source partition");
    expectCounts(scan(files, sources, files), 3, 2);
  });

  it("rejects a source outside the workspace roots", () => {
    const { files, sources } = fixture([["scripts/outside.ts", "export {};"]]);
    expect(() => scan(files, sources, files)).toThrow("Source outside workspace roots: scripts/outside.ts");
    const { files: rooted, sources: rootedSources } = fixture([["packages/outside.ts", "export {};"]]);
    expectCounts(scan(rooted, rootedSources, rooted), 4, 3);
  });

  it("rejects a retired cancellation token", () => {
    const { files, sources } = fixture([[`${sourceEvents}/legacy.ts`, "export const reorderHref = '/';"]]);
    expect(() => scan(files, sources, files)).toThrow(
      `Retired cancellation token reorderHref in ${sourceEvents}/legacy.ts`,
    );
    const control = fixture([[`${sourceEvents}/legacy.ts`, "export const orderHref = '/';"]]);
    expectCounts(scan(control.files, control.sources, control.files), 4, 3);
  });
});

describe("cancellation producer uniqueness guard", () => {
  it("passes with the planted control beside the mapper", () => {
    const { files, sources } = fixture();
    const { violations, inventory } = evaluateCancellationProducerUniqueness(files, sources);
    expect(violations).toEqual([]);
    expect(inventory.authors).toEqual([cancellationMapperAuthor, plantedCancelledAuthor].sort());
    expectCounts(inventory, 7, 6);
  });

  it("reports a tracked second producer", () => {
    const second = cancelledPair.map(([file, source]) => [file.replace("pricing", "catalog"), source]);
    const { files, sources } = fixture(second);
    const { violations, inventory } = evaluateCancellationProducerUniqueness(files, sources);
    expect(violations).toEqual([
      expect.stringContaining(
        "bounded-contexts/catalog/features/synthetic-cancellation-producer/synthetic-composition.ts#compose",
      ),
    ]);
    expect(inventory.authors).toHaveLength(3);
    expectCounts(inventory, 9, 8);
  });

  it("reports a planted path present in the tracked list", () => {
    const [plantedPath] = cancelledPair[0];
    const { files, sources } = fixture([[plantedPath, "export {};"]]);
    expect(evaluateCancellationProducerUniqueness(files, sources)).toEqual({
      violations: [`${plantedPath}: cancellation producer uniqueness: planted control path is tracked`],
      inventory: null,
    });
    const control = fixture();
    expectCounts(evaluateCancellationProducerUniqueness(control.files, control.sources).inventory, 7, 6);
  });
});
