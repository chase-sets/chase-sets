import { expect, it } from "vitest";
import {
  bindListingAuthorityHistories,
  expandListingAuthorityHistorySelection,
  listingAuthorityHistoryConformance,
} from "./listing-authority-history-conformance";
import { historyFixture } from "./listing-authority-history-test-support";
import { historyRecords } from "./listing-authority-history-faults";
import { authorityJournalStreams } from "./listing-authority-journal";
import { authorityHash } from "./listing-authority-state";

const resources = ["synthetic-product", "synthetic-account", "synthetic-user", "synthetic-key"];
const create = () => historyFixture({ setup: true, reservationResources: [...resources, resources[0]!] });

it("B-HISTORY-02 binds every deduplicated tested resource and retains unrelated setup histories", async () => {
  const f = await create();
  const setup = structuredClone([...f.sourceHistories]);
  const operation = await f.fence.open(f.input, f.context);
  const grant = await f.source.prepare(operation, f.context);
  const before = new Set(f.sourceHistories.keys());
  f.blockInvalidation(true);
  await expect(f.invalidate()).rejects.toThrow();
  const expected = resources
    .map((resource) => `catalog.listing-authority-resource-${authorityHash([operation.tenantId, resource])}`)
    .sort();
  const unrelated = "catalog.listing-authority-resource-synthetic-unrelated-reservation";
  const event = f.sourceHistories.get(expected[0]!)![0]!;
  f.sourceHistories.set(unrelated, [
    {
      ...event,
      streamId: unrelated,
      payload: { ...event.payload, reservation: { ...grant, reservationId: "synthetic-other-reservation" } },
    },
  ]);
  const retained = structuredClone([...f.sourceHistories]);
  const bound = bindListingAuthorityHistories(f, operation, grant, before);
  expect(bound.resource).toEqual(expected);
  expect(bound.operation).toBe(`marketplace.listing-authority-operation-${operation.operationId}`);
  expect(f.sourceHistories.get(bound.reservation)![0]!.payload.reservation).toEqual(grant);
  expect(before.has(bound.write)).toBe(false);
  expect(before.has(bound.mutation)).toBe(false);
  expect(f.sourceHistories.get(bound.mutation)![0]!.payload.intent).toMatchObject({
    mutationId: f.sourceHistories.get(bound.write)![0]!.payload.mutationId,
  });
  expect([...f.sourceHistories]).toEqual(retained);
  for (const [id, events] of setup) expect(f.sourceHistories.get(id)?.slice(0, events.length)).toEqual(events);
});

for (const resourceCount of [1, 4])
  it(`enumerates every distinct single and unordered pair once with ${resourceCount} resources`, () => {
    const buckets = historyRecords.flatMap((first, index) => [
      [first],
      ...historyRecords.slice(index + 1).map((second) => [first, second]),
    ]);
    const concrete = historyRecords.flatMap((record) =>
      Array.from(
        { length: record.kind === "resource" ? resourceCount : 1 },
        (_, resourceIndex) => `${record.kind}/${resourceIndex}/${record.copy}`,
      ),
    );
    const expected = concrete
      .flatMap((first, index) => [[first], ...concrete.slice(index + 1).map((second) => [first, second])])
      .map((pair) => pair.sort().join("+"));
    const actual = buckets
      .flatMap((bucket) => expandListingAuthorityHistorySelection(bucket, resourceCount))
      .map((pair) => {
        expect(pair.length).toBeLessThanOrEqual(2);
        const ids = pair.map((record) => `${record.kind}/${record.resourceIndex}/${record.copy}`);
        expect(new Set(ids).size).toBe(ids.length);
        return ids.sort().join("+");
      });
    expect(actual.sort()).toEqual(expected.sort());
    expect(new Set(actual).size).toBe(resourceCount === 1 ? 120 : 300);
    expect(actual.length * 6 + resourceCount).toBe(resourceCount === 1 ? 721 : 1804);
  });

for (const scenario of [
  { name: "history sweep pending/loss/resource.canonical", count: 10 },
  { name: "history sweep pending/loss/resource.canonical+resource.integrity", count: 16 },
  { name: "history sweep pending/loss/operation.canonical+resource.registration", count: 4 },
  {
    name: "B-AUTH-03: lost resource/integrity pair retains independent registration before any mutation callback",
    count: 4,
  },
])
  it(`isolates the global damage budget: ${scenario.name}`, async () => {
    const fixtures: { f: Awaited<ReturnType<typeof create>>; deleted: Set<string> }[] = [];
    const cases = new Map<string, () => Promise<void>>();
    listingAuthorityHistoryConformance(
      (name, run) => cases.set(name, run),
      async () => {
        const f = await create();
        const deleted = new Set<string>();
        for (const histories of [f.sourceHistories, f.consumerHistories]) {
          const remove = histories.delete.bind(histories);
          histories.delete = (id) => {
            deleted.add(id);
            return remove(id);
          };
        }
        fixtures.push({ f, deleted });
        return f;
      },
    );
    expect(cases.size).toBe(721);
    await cases.get(scenario.name)!();
    expect(fixtures).toHaveLength(scenario.count);
    const tuples = fixtures.map(({ deleted }) => {
      expect(deleted.size).toBeGreaterThan(0);
      expect(deleted.size).toBeLessThanOrEqual(2);
      return [...deleted].sort().join("+");
    });
    // Operation IDs differ per fixture, so the resource-only cases discriminate uniqueness.
    if (!scenario.name.includes("operation.")) expect(new Set(tuples).size).toBe(scenario.count);
    if (scenario.name.startsWith("B-AUTH-03"))
      for (const { f, deleted } of fixtures) {
        const canonical = [...deleted].find((id) => id.startsWith("catalog.listing-authority-resource-"))!;
        const [resource, integrity, registration] = authorityJournalStreams(canonical);
        expect(deleted).toEqual(new Set([resource, integrity]));
        expect(f.sourceHistories.get(registration)?.length).toBeGreaterThan(0);
      }
  });
