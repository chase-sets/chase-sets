import assert from "node:assert/strict";
import type { StoredEvent } from "@chase-sets/event-core/storage";
import type { ListingAuthorityConformanceFixture } from "./listing-authority-conformance";
import { authorityJournalStreams } from "./listing-authority-journal";
import type { ListingAuthorityOperation, ListingAuthorityReservation } from "@chase-sets/event-core/listing-authority";

export type ListingAuthorityHistoryFixture = ListingAuthorityConformanceFixture &
  Readonly<{
    sourceHistories: Map<string, StoredEvent[]>;
    consumerHistories: Map<string, StoredEvent[]>;
    blockInvalidation(blocked: boolean): void;
    /** Complete owner stream; creation/setup events are a retained baseline, not invalidation effects. */
    sourceEffectStream: string;
    restart(): ListingAuthorityHistoryFixture;
  }>;

export const LISTING_AUTHORITY_HISTORY_RECORDS = ["operation", "reservation", "resource", "mutation", "write"] as const;
export const LISTING_AUTHORITY_HISTORY_FAULTS = ["loss", "truncation", "recreation"] as const;
export const LISTING_AUTHORITY_HISTORY_COPIES = ["canonical", "integrity", "registration"] as const;

/** Bind by the tested durable identities, never by a first owner-prefix match.
 * Setup journals remain visible and are not candidates for the tested invalidation.
 */
export function bindListingAuthorityHistories(
  f: ListingAuthorityHistoryFixture,
  operation: ListingAuthorityOperation,
  grant: ListingAuthorityReservation,
  beforeInvalidation: ReadonlySet<string>,
) {
  const exact = (kind: string, candidates: string[]) => {
    assert.equal(candidates.length, 1, `exact tested ${kind} history`);
    return candidates[0]!;
  };
  const entries = [...f.sourceHistories];
  const member = (event: StoredEvent) =>
    (event.payload.reservation as unknown as ListingAuthorityReservation | undefined)?.reservationId ===
    grant.reservationId;
  const matching = (kind: string) =>
    entries
      .filter(
        ([id, events]) => id.startsWith(`${grant.participant.owner}.listing-authority-${kind}-`) && events.some(member),
      )
      .map(([id]) => id);
  const write = exact(
    "write",
    entries
      .filter(
        ([id, events]) =>
          !beforeInvalidation.has(id) &&
          id.startsWith(`${grant.participant.owner}.listing-authority-write-`) &&
          (events[0]?.payload.inputs as unknown as { streamId: string }[] | undefined)?.some(
            (input) => input.streamId === f.sourceEffectStream,
          ),
      )
      .map(([id]) => id),
  );
  const mutationId = f.sourceHistories.get(write)![0]!.payload.mutationId;
  const mutation = exact(
    "mutation",
    entries
      .filter(
        ([id, events]) =>
          !beforeInvalidation.has(id) &&
          id.startsWith(`${grant.participant.owner}.listing-authority-mutation-`) &&
          (events[0]?.payload.intent as { mutationId?: string } | undefined)?.mutationId === mutationId,
      )
      .map(([id]) => id),
  );
  return {
    operation: `${operation.committingOwner}.listing-authority-operation-${operation.operationId}`,
    reservation: exact("reservation", matching("reservation")),
    resource: exact("resource", matching("resource")),
    mutation,
    write,
  };
}

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
          const beforeInvalidation = new Set(f.sourceHistories.keys());
          const baseline = (await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length;
          const settledBefore = [...f.sourceHistories.values()]
            .flat()
            .filter((e) => e.eventType.endsWith(".settled")).length;
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
          const journals = bindListingAuthorityHistories(f, operation, grant, beforeInvalidation);
          for (const record of selected) {
            const histories = record.kind === "operation" ? f.consumerHistories : f.sourceHistories;
            const streamId = authorityJournalStreams(journals[record.kind])[record.index]!;
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
              settledBefore,
            );
          }
          await restarted.invalidate().catch(() => undefined);
          const sourceEffects = await f.sourceStore.readStream({ streamId: f.sourceEffectStream });
          const effectCount = sourceEffects.length - baseline;
          assert.ok(effectCount >= 0 && effectCount <= 1, "same-key recovery never repeats the source effect");
          const committed = await f.consumerStore.appendToStreams!([...terminal, ...effects]).then(
            () => true,
            () => false,
          );
          assert.equal(
            effectCount > 0 && committed,
            false,
            "effective mutation cannot coexist with stale consumer commit",
          );
          if (effectCount)
            for (const effect of effects)
              assert.equal((await f.consumerStore.readStream({ streamId: effect.streamId })).length, 0);
        });

  test("B-AUTH-03: lost resource/integrity pair retains independent registration before any mutation callback", async () => {
    const f = await create();
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
    const baseline = (await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length;
    const candidates = [...f.sourceHistories].filter(
      ([id, events]) =>
        id.startsWith(`${grant.participant.owner}.listing-authority-resource-`) &&
        events.some(
          (event) =>
            (event.payload.reservation as unknown as ListingAuthorityReservation | undefined)?.reservationId ===
            grant.reservationId,
        ),
    );
    assert.equal(candidates.length, 1, "exact tested resource history");
    const canonical = candidates[0]![0];
    const [resource, integrity, registration] = authorityJournalStreams(canonical);
    f.sourceHistories.delete(resource);
    f.sourceHistories.delete(integrity);
    assert.ok(f.sourceHistories.get(registration)?.length);
    await assert.rejects(f.restart().invalidate());
    assert.equal((await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length, baseline);
    assert.equal((await f.fence.inspect(operation)).status, "pending");
    await assert.rejects(f.restart().source.settle(operation));
    // The old executor may still commit only because source authority has NOT changed.
    await f.consumerStore.appendToStreams!(terminal);
    assert.equal((await f.fence.inspect(operation)).status, "committed");
  });
}
