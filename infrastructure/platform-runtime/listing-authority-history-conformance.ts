import assert from "node:assert/strict";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import type { ListingAuthorityConformanceFixture } from "./listing-authority-conformance";
import { authorityJournalStreams } from "./listing-authority-journal";

export type ListingAuthorityHistoryFixture = ListingAuthorityConformanceFixture &
  Readonly<{
    sourceHistories: Map<string, StoredEvent[]>;
    consumerHistories: Map<string, StoredEvent[]>;
    blockInvalidation(blocked: boolean): void;
    sourceEffectStream: string;
  }>;

export const LISTING_AUTHORITY_HISTORY_RECORDS = ["operation", "reservation", "resource", "mutation", "write"] as const;
export const LISTING_AUTHORITY_HISTORY_FAULTS = ["loss", "truncation", "recreation"] as const;
export const LISTING_AUTHORITY_HISTORY_COPIES = ["canonical", "integrity", "registration"] as const;

/** Faults target authoritative retained histories, not missing projections or expired leases.
 * The complete pair sweep includes cross-record pairs, not just each journal's two witnesses.
 */
export function listingAuthorityHistoryConformance(
  test: (name: string, run: () => Promise<void>) => void,
  create: () => Promise<ListingAuthorityHistoryFixture>,
) {
  const records = LISTING_AUTHORITY_HISTORY_RECORDS.flatMap((kind) =>
    LISTING_AUTHORITY_HISTORY_COPIES.map((copy, index) => ({ kind, copy, index })),
  );
  const sets = records.flatMap((first, index) => [
    [first],
    ...records.slice(index + 1).map((second) => [first, second]),
  ]);
  for (const phase of ["pending", "effective"] as const)
    for (const fault of LISTING_AUTHORITY_HISTORY_FAULTS)
      for (const selected of sets)
        test(`history sweep ${phase}/${fault}/${selected.map((r) => `${r.kind}.${r.copy}`).join("+")}`, async () => {
          const f = await create();
          assert.notEqual(f.sourceStore, f.consumerStore);
          const operation = await f.fence.open(f.input, f.context);
          const grant = await f.source.prepare(operation, f.context);
          const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
          const effects = ["business", "request-result"].map((kind) => ({
            streamId: `${operation.committingOwner}.synthetic-history-${kind}`,
            expectedVersion: 0 as const,
            context: f.context,
            events: [{ eventType: `synthetic.${kind}`, payload: { accepted: true } }],
          }));
          if (phase === "pending") {
            f.blockInvalidation(true);
            await assert.rejects(f.invalidate());
            assert.equal((await f.fence.inspect(operation)).status, "pending");
            f.blockInvalidation(false);
          } else {
            await f.invalidate();
            assert.equal((await f.fence.inspect(operation)).status, "aborted");
            assert.equal((await f.source.inspect(operation))?.status, "released");
          }
          const knownStreams = [...f.consumerHistories.keys(), ...f.sourceHistories.keys()];
          for (const record of selected) {
            const histories = record.kind === "operation" ? f.consumerHistories : f.sourceHistories;
            const prefix = record.kind === "operation" ? operation.committingOwner : grant.participant.owner;
            const canonical = knownStreams.filter((id) => id.startsWith(`${prefix}.listing-authority-${record.kind}-`));
            assert.equal(canonical.length, 1, `exact ${record.kind} history`);
            const streamId = authorityJournalStreams(canonical[0]!)[record.index]!;
            const events = histories.get(streamId)!;
            assert.ok(events.length, `${record.kind}.${record.copy} exists before fault`);
            if (fault === "loss") histories.delete(streamId);
            else if (fault === "truncation") histories.set(streamId, events.slice(0, -1));
            else
              histories.set(streamId, [
                { ...events[0]!, eventId: `evt_synthetic-recreated-${record.kind}-${record.copy}` },
              ]);
          }
          const restarted = f.restart();
          await restarted.fence
            .open(f.input, f.context)
            .then((retained) => restarted.source.prepare(retained, f.context))
            .catch(() => undefined);
          if (phase === "pending") {
            // Loss itself must never become a terminal receipt or release permission.
            await assert.rejects(restarted.source.settle(operation));
            assert.equal(
              [...f.sourceHistories.values()].flat().filter((e) => e.eventType.endsWith(".settled")).length,
              0,
            );
          }
          await restarted.invalidate().catch(() => undefined);
          const sourceEffects = await f.sourceStore.readStream({ streamId: f.sourceEffectStream });
          assert.ok(sourceEffects.length <= 1, "same-key recovery never repeats the source effect");
          const committed = await f.consumerStore.appendToStreams!([...terminal, ...effects]).then(
            () => true,
            () => false,
          );
          assert.equal(
            sourceEffects.length > 0 && committed,
            false,
            "effective mutation cannot coexist with stale consumer commit",
          );
          if (sourceEffects.length)
            for (const effect of effects)
              assert.equal((await f.consumerStore.readStream({ streamId: effect.streamId })).length, 0);
        });

  test("B-AUTH-03: lost resource/integrity pair retains independent registration before any mutation callback", async () => {
    const f = await create();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
    const canonical = [...f.sourceHistories.keys()].find((id) =>
      id.startsWith(`${grant.participant.owner}.listing-authority-resource-`),
    )!;
    const [resource, integrity, registration] = authorityJournalStreams(canonical);
    f.sourceHistories.delete(resource);
    f.sourceHistories.delete(integrity);
    assert.ok(f.sourceHistories.get(registration)?.length);
    await assert.rejects(f.restart().invalidate());
    assert.equal((await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length, 0);
    assert.equal((await f.fence.inspect(operation)).status, "pending");
    await assert.rejects(f.restart().source.settle(operation));
    // The old executor may still commit only because source authority has NOT changed.
    await f.consumerStore.appendToStreams!(terminal);
    assert.equal((await f.fence.inspect(operation)).status, "committed");
  });
}
