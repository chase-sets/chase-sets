import assert from "node:assert/strict";
import { readCompleteStream } from "@chase-sets/event-core/complete-stream";
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

export function bindListingAuthorityResources(f: ListingAuthorityHistoryFixture, grant: ListingAuthorityReservation) {
  const resources = [
    ...new Set(
      [...f.sourceHistories]
        .filter(
          ([id, events]) =>
            id.startsWith(`${grant.participant.owner}.listing-authority-resource-`) &&
            events.some(
              (event) =>
                (event.payload.reservation as unknown as ListingAuthorityReservation | undefined)?.reservationId ===
                grant.reservationId,
            ),
        )
        .map(([id]) => id),
    ),
  ].sort();
  assert.ok(resources.length, "tested reservation has resource histories");
  assert.equal(resources.length, new Set(grant.resources).size, "complete tested resource histories");
  return resources;
}

type HistoryRecord = Readonly<{
  kind: (typeof LISTING_AUTHORITY_HISTORY_RECORDS)[number];
  copy: (typeof LISTING_AUTHORITY_HISTORY_COPIES)[number];
  index: number;
}>;
type SelectedHistory = HistoryRecord & { resourceIndex: number };

/** Keep the original 120 named buckets, but expand them to distinct histories.
 * Same-copy resource pairs belong to that copy's singleton bucket. Every other
 * pair belongs to its original two-label bucket, so no pair is lost or repeated.
 */
export function expandListingAuthorityHistorySelection(
  selected: readonly HistoryRecord[],
  resourceCount: number,
): SelectedHistory[][] {
  assert.ok(Number.isInteger(resourceCount) && resourceCount > 0);
  assert.ok(selected.length === 1 || selected.length === 2);
  const expand = (record: HistoryRecord) =>
    Array.from({ length: record.kind === "resource" ? resourceCount : 1 }, (_, resourceIndex) => ({
      ...record,
      resourceIndex,
    }));
  const first = expand(selected[0]!);
  if (selected.length === 2) return first.flatMap((a) => expand(selected[1]!).map((b) => [a, b]));
  return first.flatMap((a, index) => [[a], ...first.slice(index + 1).map((b) => [a, b])]);
}

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
    resource: bindListingAuthorityResources(f, grant),
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
          let expanded: SelectedHistory[][] | undefined;
          for (let caseIndex = 0; !expanded || caseIndex < expanded.length; caseIndex++) {
            const f = await create();
            assert.notEqual(f.sourceStore, f.consumerStore);
            const operation = await f.fence.open(f.input, f.context);
            const grant = await f.source.prepare(operation, f.context);
            const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
            const beforeInvalidation = new Set(f.sourceHistories.keys());
            const baseline = (await readCompleteStream(f.sourceStore, { streamId: f.sourceEffectStream })).length;
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
            const cases = expandListingAuthorityHistorySelection(selected, journals.resource.length);
            if (expanded)
              assert.deepEqual(
                cases,
                expanded,
                "fixture retains the complete resource footprint across isolated cases",
              );
            else expanded = cases;
            const damaged = expanded[caseIndex]!;
            const selectedStreams = damaged.map((record) => {
              const canonical =
                record.kind === "resource" ? journals.resource[record.resourceIndex]! : journals[record.kind];
              return authorityJournalStreams(canonical)[record.index]!;
            });
            assert.equal(
              new Set(selectedStreams).size,
              damaged.length,
              "distinct histories in the global two-history budget",
            );
            assert.ok(damaged.length <= 2);
            for (const [index, record] of damaged.entries()) {
              const histories = record.kind === "operation" ? f.consumerHistories : f.sourceHistories;
              const streamId = selectedStreams[index]!;
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
            const sourceEffects = await readCompleteStream(f.sourceStore, { streamId: f.sourceEffectStream });
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
          }
        });

  test("B-AUTH-03: lost resource/integrity pair retains independent registration before any mutation callback", async () => {
    let resourceCount: number | undefined;
    for (let resourceIndex = 0; resourceCount === undefined || resourceIndex < resourceCount; resourceIndex++) {
      const f = await create();
      const operation = await f.fence.open(f.input, f.context);
      const grant = await f.source.prepare(operation, f.context);
      const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
      const baseline = (await readCompleteStream(f.sourceStore, { streamId: f.sourceEffectStream })).length;
      const candidates = bindListingAuthorityResources(f, grant);
      if (resourceCount !== undefined) assert.equal(candidates.length, resourceCount);
      resourceCount = candidates.length;
      const canonical = candidates[resourceIndex]!;
      const [resource, integrity, registration] = authorityJournalStreams(canonical);
      const retainedRegistration = structuredClone(f.sourceHistories.get(registration));
      const settledBefore = [...f.sourceHistories.values()]
        .flat()
        .filter((e) => e.eventType.endsWith(".settled")).length;
      f.sourceHistories.delete(resource);
      f.sourceHistories.delete(integrity);
      assert.ok(f.sourceHistories.get(registration)?.length);
      await assert.rejects(f.restart().invalidate());
      assert.equal((await readCompleteStream(f.sourceStore, { streamId: f.sourceEffectStream })).length, baseline);
      const outcome = await f.fence.inspect(operation);
      // With one resource, damage is necessarily on the writer's target. With
      // several, an intact target can abort the consumer before settlement reads
      // the damaged sibling. Both paths must still retain the source promise.
      if (resourceCount === 1) assert.equal(outcome.status, "pending");
      await assert.rejects(f.restart().source.settle(operation));
      await assert.rejects(f.source.inspect(operation));
      assert.equal(
        [...f.sourceHistories.values()].flat().filter((e) => e.eventType.endsWith(".settled")).length,
        settledBefore,
      );
      assert.deepEqual(f.sourceHistories.get(registration), retainedRegistration);
      const effects = ["business", "request-result"].map((kind) => ({
        streamId: `${operation.committingOwner}.synthetic-paired-history-${kind}`,
        expectedVersion: 0 as const,
        context: f.context,
        events: [{ eventType: `synthetic.${kind}`, payload: { accepted: true } }],
      }));
      if (outcome.status === "pending") {
        // The old executor may commit once only because source authority has NOT changed.
        await f.consumerStore.appendToStreams!([...terminal, ...effects]);
        assert.equal((await f.fence.inspect(operation)).status, "committed");
      } else {
        assert.equal(outcome.status, "aborted");
        assert.ok(outcome.terminalEventId, "abort must be an authoritative terminal");
        await assert.rejects(f.consumerStore.appendToStreams!([...terminal, ...effects]));
        assert.deepEqual(await f.fence.inspect(operation), outcome);
      }
      await assert.rejects(f.consumerStore.appendToStreams!([...terminal, ...effects]));
      for (const effect of effects)
        assert.equal(
          (await readCompleteStream(f.consumerStore, { streamId: effect.streamId })).length,
          outcome.status === "pending" ? 1 : 0,
        );
      assert.equal((await readCompleteStream(f.sourceStore, { streamId: f.sourceEffectStream })).length, baseline);
    }
  });
}
