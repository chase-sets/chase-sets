import { expect, it } from "vitest";
import { historyFixture } from "./listing-authority-history-test-support";
import { authorityHash } from "./listing-authority-state";
import { authorityJournalStreams } from "./listing-authority-journal";

// C's bdc94e9f three-case scenario, using a synthetic neutral owner and adding
// request-success atomicity. Canonical history and the COMPLETE terminal survive.
for (const scenario of [
  { name: "corrupt disposable snapshot alone", corruptCache: true, corruptWitnesses: false },
  { name: "two corrupt fold witnesses without a cached fold", corruptCache: false, corruptWitnesses: true },
  { name: "two corrupt fold witnesses plus a corrupt disposable snapshot", corruptCache: true, corruptWitnesses: true },
])
  it(`C-PROTOCOL-04: retains canonical grants with ${scenario.name}`, async () => {
    const f = await historyFixture();
    const operation = await f.fence.open(f.input, f.context);
    const reservation = await f.source.prepare(operation, f.context);
    const delayedCommit = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
    expect(delayedCommit).toHaveLength(3);
    const resources = [...f.sourceHistories.keys()].filter((id) => id.startsWith("catalog.listing-authority-resource-"));
    expect(resources).toHaveLength(1);
    const resource = resources[0]!;
    const canonicalBefore = structuredClone(f.sourceHistories.get(resource)!);
    expect(canonicalBefore).toHaveLength(1);
    expect(canonicalBefore[0]!.payload.reservation).toMatchObject({ reservationId: reservation.reservationId });
    const snapshot = f.snapshots.get(resource)!;
    expect(snapshot.state).toMatchObject({ grants: [{ reservationId: reservation.reservationId }], pending: null });
    const emptyState = { grants: [], pending: null };
    if (scenario.corruptCache) f.snapshots.set(resource, { ...snapshot, state: emptyState });
    else f.snapshots.clear();
    for (const witness of scenario.corruptWitnesses ? authorityJournalStreams(resource).slice(1) : []) {
      const history = f.sourceHistories.get(witness)!;
      expect(history).toHaveLength(1);
      f.sourceHistories.set(witness, history.map((event) => ({
        ...event, payload: { ...event.payload, stateHash: authorityHash(emptyState) },
      })));
    }
    expect(f.sourceHistories.get(resource)).toEqual(canonicalBefore);
    const restarted = f.restart();
    expect((await restarted.fence.inspect(operation)).status).toBe("pending");
    const mutationId = "synthetic-corrupt-fold-revoke";
    try {
      await restarted.source.mutate({
        resources: reservation.resources, mutationId, command: { revoke: true }, context: f.context,
        prepare: async () => [{
          streamId: f.sourceEffectStream, expectedVersion: 0, context: f.context,
          events: [{ eventType: "catalog.synthetic-product-revoked", payload: { revoked: true } }],
        }],
      });
    } catch {
      expect(await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).toHaveLength(0);
      expect((await restarted.source.inspectInvalidation(f.context.tenantId, mutationId))?.status).not.toBe("completed");
      expect((await restarted.fence.inspect(operation)).status).toBe("pending");
      await expect(restarted.source.settle(operation)).rejects.toThrow();
      return;
    }
    expect((await restarted.source.inspectInvalidation(f.context.tenantId, mutationId))?.status).toBe("completed");
    expect(await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).toHaveLength(1);
    const effects = ["business", "request-success"].map((kind) => ({
      streamId: `marketplace.synthetic-corrupt-fold-${kind}`, expectedVersion: 0 as const, context: f.context,
      events: [{ eventType: `synthetic.${kind}`, payload: { accepted: true } }],
    }));
    await expect(f.consumerStore.appendToStreams!([...delayedCommit, ...effects])).rejects.toThrow();
    for (const effect of effects) expect(await f.consumerStore.readStream({ streamId: effect.streamId })).toHaveLength(0);
    expect((await restarted.fence.inspect(operation)).status).toBe("aborted");
  });
