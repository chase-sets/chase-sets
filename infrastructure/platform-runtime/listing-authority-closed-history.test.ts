import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { StoredAggregateSnapshot } from "@chase-sets/event-core/aggregate-snapshot-store";
import { historyFixture } from "./listing-authority-history-test-support";
import { bindListingAuthorityHistories } from "./listing-authority-history-conformance";
import { authorityJournalStreams } from "./listing-authority-journal";
import {
  damageHistory,
  faultName,
  historyFaultSets,
  historyRecords,
  type HistoryFault,
} from "./listing-authority-history-faults";

const caches = [
  "absent",
  "valid-current",
  "stale-prefix",
  "malformed",
  "fabricated-empty",
  "fabricated-membership",
  "fabricated-closure",
] as const;
type Cache = (typeof caches)[number];
type Phase = "reserved" | "closure-unknown" | "abort-effective" | "commit-before-invalidation";

function changeCache(
  f: Awaited<ReturnType<typeof historyFixture>>,
  variant: Cache,
  retained: StoredAggregateSnapshot<unknown>,
  prefix: StoredAggregateSnapshot<unknown>,
) {
  f.snapshots.clear();
  if (variant === "absent") return;
  let snapshot = structuredClone(retained);
  if (variant === "stale-prefix") snapshot = structuredClone(prefix);
  if (variant === "malformed") snapshot = { ...snapshot, state: null, schemaVersion: -1 };
  if (variant === "fabricated-empty") snapshot = { ...snapshot, state: { grants: [], pending: null } };
  if (variant === "fabricated-membership")
    snapshot = { ...snapshot, state: { grants: [{ reservationId: "synthetic-inserted-grant" }], pending: null } };
  if (variant === "fabricated-closure")
    snapshot = { ...snapshot, state: { grants: [], pending: { mutationId: "synthetic-false-closure", command: {} } } };
  f.snapshots.set(snapshot.streamId, snapshot);
}

async function scenario(
  selected: readonly HistoryFault[],
  phase: Phase,
  cacheEnabled: boolean,
  restart: boolean,
  cache?: Cache,
  tail = false,
) {
  const f = await historyFixture({ cache: cacheEnabled });
  const operation = await f.fence.open(f.input, f.context);
  const grant = await f.source.prepare(operation, f.context);
  const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
  const effects = ["business", "request-success"].map((kind) => ({
    streamId: `marketplace.synthetic-closed-history-${kind}`,
    expectedVersion: 0 as const,
    context: f.context,
    events: [{ eventType: `synthetic.${kind}`, payload: { accepted: true } }],
  }));
  const before = new Set(f.sourceHistories.keys());
  const resource = [...f.sourceHistories.keys()].filter((id) => id.startsWith("catalog.listing-authority-resource-"));
  assert.equal(resource.length, 1);
  const prefixSnapshot = f.snapshots.get(resource[0]!)!;
  if (phase === "commit-before-invalidation") await f.consumerStore.appendToStreams!([...terminal, ...effects]);
  if (phase === "abort-effective") await f.invalidate();
  else if (phase !== "reserved") {
    f.blockInvalidation(true);
    await assert.rejects(f.invalidate());
    f.blockInvalidation(false);
  }
  const journals =
    phase === "reserved"
      ? {
          operation: terminal[0]!.streamId,
          reservation: [...f.sourceHistories.keys()].filter((id) =>
            id.startsWith("catalog.listing-authority-reservation-"),
          )[0]!,
          resource: resource[0]!,
          mutation: "not-created",
          write: "not-created",
        }
      : bindListingAuthorityHistories(f, operation, grant, before);
  if (cache) changeCache(f, cache, tail ? prefixSnapshot : f.snapshots.get(resource[0]!)!, prefixSnapshot);
  // A tip snapshot and a retained prefix plus canonical closure tail are distinct boundaries.
  if (cache && tail) assert.ok(f.sourceHistories.get(resource[0]!)!.length > prefixSnapshot.streamVersion);
  for (const fault of selected)
    damageHistory(
      fault.kind === "operation" ? f.consumerHistories : f.sourceHistories,
      authorityJournalStreams(journals[fault.kind])[fault.index]!,
      fault,
    );
  const current = restart ? f.restart() : f;
  await current.fence
    .open(f.input, f.context)
    .then((opened) => current.source.prepare(opened, f.context))
    .catch(() => undefined);
  if (phase === "reserved" || phase === "closure-unknown") await assert.rejects(current.source.settle(operation));
  await current.invalidate().catch(() => undefined);
  await current.invalidate().catch(() => undefined);
  const sourceEffects = (await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length;
  assert.ok(sourceEffects <= 1, "same mutation replay must not duplicate invalidation");
  if (!selected.length) assert.equal(sourceEffects, 1, "cache-only damage preserves nominal availability");
  const committed = await f.consumerStore.appendToStreams!([...terminal, ...effects]).then(
    () => true,
    () => false,
  );
  if (phase !== "commit-before-invalidation")
    assert.equal(
      sourceEffects > 0 && committed,
      false,
      "effective source before stale terminal/business/request success",
    );
  else assert.equal(committed, false, "prior commitment cannot append twice");
  for (const effect of effects)
    assert.equal(
      (await f.consumerStore.readStream({ streamId: effect.streamId })).length,
      phase === "commit-before-invalidation" || committed ? 1 : 0,
      "business and exact request result are atomic with terminal",
    );
}

describe("closed history model: independently selected modes", () => {
  for (const phase of ["reserved", "closure-unknown", "abort-effective", "commit-before-invalidation"] as const) {
    const applicable =
      phase === "reserved"
        ? historyRecords.filter((r) => ["operation", "reservation", "resource"].includes(r.kind))
        : historyRecords;
    for (const [index, selected] of historyFaultSets(applicable).entries())
      for (const cacheEnabled of [false, true]) {
        const restart = index % 2 === 0;
        it(`${phase}/${faultName(selected)}/cache-${cacheEnabled}/${restart ? "restart" : "same-process"}`, () =>
          scenario(selected, phase, cacheEnabled, restart));
      }
  }
});

describe("resource-history faults crossed with disposable snapshots", () => {
  for (const cache of caches)
    for (const tail of [false, true])
      it(`cache-only/${cache}/${tail ? "prefix-plus-tail" : "tip"}/nominal-availability`, () =>
        scenario([], "closure-unknown", true, true, cache, tail));
  for (const [index, selected] of historyFaultSets()
    .filter((set) => set.some((r) => r.kind === "resource"))
    .entries())
    for (const cache of caches)
      for (const tail of [false, true])
        it(`closure-unknown/${faultName(selected)}/${cache}/${tail ? "prefix-plus-tail" : "tip"}`, () =>
          scenario(selected, "closure-unknown", true, index % 2 === 0, cache, tail));
});

describe("before reservation: only already-existing operation/resource histories can be damaged", () => {
  const applicable = historyRecords.filter((r) => r.kind === "operation" || r.kind === "resource");
  for (const selected of historyFaultSets(applicable))
    it(`before-reserve/${faultName(selected)}`, async () => {
      const f = await historyFixture({ setup: true });
      const operation = await f.fence.open(f.input, f.context);
      const resource = [...f.sourceHistories.keys()].filter((id) =>
        id.startsWith("catalog.listing-authority-resource-"),
      );
      assert.equal(resource.length, 1);
      for (const fault of selected) {
        const canonical =
          fault.kind === "operation"
            ? `marketplace.listing-authority-operation-${operation.operationId}`
            : resource[0]!;
        damageHistory(
          fault.kind === "operation" ? f.consumerHistories : f.sourceHistories,
          authorityJournalStreams(canonical)[fault.index]!,
          fault,
        );
      }
      const current = f.restart();
      await current.fence
        .open(f.input, f.context)
        .then((opened) => current.source.prepare(opened, f.context))
        .catch(() => undefined);
      // No reservation/business effect may be manufactured from damaged authority.
      const grant = await current.source.inspect(operation).catch(() => null);
      if (grant) {
        const terminal = await current.fence.prepareCommit(operation, [grant], { accepted: true });
        await current.invalidate().catch(() => undefined);
        const committed = await f.consumerStore.appendToStreams!(terminal).then(
          () => true,
          () => false,
        );
        assert.equal(
          (await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length > 1 && committed,
          false,
        );
      }
    });
});
