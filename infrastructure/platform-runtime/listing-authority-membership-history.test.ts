import { expect, it, vi } from "vitest";
import { historyFixture, bindSingleResourceHistories } from "./listing-authority-history-test-support";
import { authorityHash } from "./listing-authority-state";
import { authorityJournalStreams } from "./listing-authority-journal";
import { historyRecords } from "./listing-authority-history-faults";

for (const [index, first] of historyRecords.entries())
  for (const selected of [[first], ...historyRecords.slice(index + 1).map((second) => [first, second])])
    it(`unreadable retained histories/${selected.map((r) => `${r.kind}.${r.copy}`).join("+")}`, async () => {
      const f = await historyFixture();
      const operation = await f.fence.open(f.input, f.context);
      const grant = await f.source.prepare(operation, f.context);
      const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
      const before = new Set(f.sourceHistories.keys());
      f.blockInvalidation(true);
      await expect(f.invalidate()).rejects.toThrow();
      f.blockInvalidation(false);
      const journals = bindSingleResourceHistories(f, operation, grant, before);
      const unavailable = new Set(selected.map((r) => authorityJournalStreams(journals[r.kind])[r.index]));
      const spies = [f.sourceStore, f.consumerStore].map((store) => {
        const read = store.readStream;
        return vi.spyOn(store, "readStream").mockImplementation((input) => {
          if (unavailable.has(input.streamId))
            return Promise.reject(new Error("synthetic authoritative read unavailable"));
          return read(input);
        });
      });
      let committed = false;
      try {
        await expect(f.restart().source.settle(operation)).rejects.toThrow();
        await expect(f.restart().invalidate()).rejects.toThrow();
        expect(await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).toHaveLength(0);
        // Retained append may win only while the source effect remains absent.
        committed = await f.consumerStore.appendToStreams!(terminal).then(
          () => true,
          () => false,
        );
      } finally {
        for (const spy of spies) spy.mockRestore();
      }
      expect((await f.fence.inspect(operation)).status).toBe(committed ? "committed" : "aborted");
    });

for (const commitFirst of [false, true])
  it(`unavailable snapshot port preserves nominal ${commitFirst ? "commit" : "abort"}-first operation`, async () => {
    const f = await historyFixture({ cacheUnavailable: true });
    const operation = await f.fence.open(f.input, f.context);
    const grant = await f.source.prepare(operation, f.context);
    const terminal = await f.fence.prepareCommit(operation, [grant], { accepted: true });
    if (commitFirst) await f.consumerStore.appendToStreams!(terminal);
    await f.restart().invalidate();
    expect(await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).toHaveLength(1);
    expect((await f.fence.inspect(operation)).status).toBe(commitFirst ? "committed" : "aborted");
    await expect(f.consumerStore.appendToStreams!(terminal)).rejects.toThrow();
  });

for (const mode of ["omission", "insertion", "cross-binding", "false-closure"] as const)
  for (const tail of [false, true])
    for (const witnesses of ["healthy", "matching", "mismatched"] as const)
      it(`multiple grants/targets/resources/${mode}/${tail ? "tail" : "tip"}/${witnesses}`, async () => {
        const f = await historyFixture({ multipleResources: true });
        const first = await f.fence.open(f.input, f.context);
        const firstGrant = await f.source.prepare(first, f.context);
        const firstTerminal = await f.fence.prepareCommit(first, [firstGrant], { accepted: true });
        const originalCache = structuredClone([...f.snapshots.values()][0]!);
        const second = await f.fence.open(
          {
            ...f.input,
            requestId: "synthetic-second",
            target: { kind: "channel-connection", connectionId: "con_synthetic_second" },
          },
          f.context,
        );
        const secondGrant = await f.source.prepare(second, f.context);
        const secondTerminal = await f.fence.prepareCommit(second, [secondGrant], { accepted: true });
        const unrelated = await f.fence.open(
          {
            ...f.input,
            requestId: "synthetic-unrelated",
            subject: { ...f.input.subject, catalogItemId: "cat_synthetic_unrelated" },
          },
          f.context,
        );
        const unrelatedGrant = await f.source.prepare(unrelated, f.context);
        const resource = originalCache.streamId;
        const snapshot = tail ? originalCache : f.snapshots.get(resource)!;
        const state = {
          grants:
            mode === "omission"
              ? [secondGrant]
              : mode === "insertion"
                ? [firstGrant, secondGrant, unrelatedGrant]
                : mode === "cross-binding"
                  ? [{ ...firstGrant, operation: unrelated }, secondGrant]
                  : [firstGrant, secondGrant],
          pending: mode === "false-closure" ? { mutationId: "synthetic-forged-completed", command: {} } : null,
        };
        f.snapshots.set(resource, { ...snapshot, state });
        const canonicalBefore = structuredClone(f.sourceHistories.get(resource));
        if (witnesses !== "healthy")
          for (const [index, witness] of authorityJournalStreams(resource).slice(1).entries()) {
            f.sourceHistories.set(
              witness,
              f.sourceHistories.get(witness)!.map((event) => ({
                ...event,
                payload: {
                  ...event.payload,
                  stateHash: authorityHash({
                    ...state,
                    grants: [...state.grants].sort((a, b) => a.reservationId.localeCompare(b.reservationId)),
                    ...(witnesses === "mismatched" && index === 1
                      ? { pending: { mutationId: "synthetic-other", command: {} } }
                      : {}),
                  }),
                },
              })),
            );
          }
        expect(f.sourceHistories.get(resource)).toEqual(canonicalBefore);
        await f
          .restart()
          .invalidate()
          .catch(() => undefined);
        const effective = (await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).length;
        if (witnesses === "healthy") expect(effective).toBe(1);
        for (const [index, terminal] of [firstTerminal, secondTerminal].entries()) {
          const effects = ["business", "request-success"].map((kind) => ({
            streamId: `marketplace.synthetic-multi-${index}-${kind}`,
            expectedVersion: 0 as const,
            context: f.context,
            events: [{ eventType: `synthetic.${kind}`, payload: {} }],
          }));
          const committed = await f.consumerStore.appendToStreams!([...terminal, ...effects]).then(
            () => true,
            () => false,
          );
          expect(effective > 0 && committed).toBe(false);
          for (const effect of effects)
            expect(await f.consumerStore.readStream({ streamId: effect.streamId })).toHaveLength(committed ? 1 : 0);
        }
        // Damage to the selected predicate never freezes a different resource.
        await f.consumerStore.appendToStreams!(
          await f.fence.prepareCommit(unrelated, [unrelatedGrant], { accepted: true }),
        );
        expect((await f.fence.inspect(unrelated)).status).toBe("committed");
      });

it("C-PROTOCOL-03: paired resource and integrity loss cannot precede a retained consumer effect", async () => {
  const f = await historyFixture();
  const operation = await f.fence.open(f.input, f.context);
  const reservation = await f.source.prepare(operation, f.context);
  const terminal = await f.fence.prepareCommit(operation, [reservation], { accepted: true });
  const [resource] = f.snapshots.keys();
  const [, integrity, registration] = authorityJournalStreams(resource!);
  f.sourceHistories.delete(resource!);
  f.sourceHistories.delete(integrity);
  expect(f.sourceHistories.get(registration)?.length).toBeGreaterThan(0);
  await expect(f.restart().source.inspect(operation)).rejects.toThrow();
  await expect(f.restart().invalidate()).rejects.toThrow();
  expect(await f.sourceStore.readStream({ streamId: f.sourceEffectStream })).toHaveLength(0);
  expect((await f.fence.inspect(operation)).status).toBe("pending");
  // Retained terminal remains executable only while the source has NOT changed.
  await f.consumerStore.appendToStreams!(terminal);
});
