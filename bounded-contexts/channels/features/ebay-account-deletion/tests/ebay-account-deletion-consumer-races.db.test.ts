import { describe, expect, it, vi } from "vitest";
import { consumerFixture, owner, context, signal } from "./consumer-db-support";
import { withConfigurationEpochTransaction } from "@chase-sets/event-core-postgres";
import { createConnectionEpochs, type ConnectionEpochs } from "../../connections/api/owner-epochs";

describe("ebay-account-deletion-consumer-races", () => {
  const f = consumerFixture("races");
  it.each([false, true])(
    "epoch closure refuses stale terminals; REMOVE_DELETION_ENROLLMENT mutant=%s",
    async (omitClosure) => {
      const r = f.runtime(),
        target = await f.connect(r);
      const key = `connection/${target.connectionId}`;
      await createConnectionEpochs(f.db()).source();
      const identity = (
        await f
          .db()
          .query<{
            store_id: string;
            incarnation: string;
          }>("SELECT store_id,incarnation FROM event_configuration_store_identity WHERE singleton=true")
      ).rows[0]!;
      const consumer = { storeId: identity.store_id, incarnation: identity.incarnation };
      const epochs = createConnectionEpochs(f.db(), [{ identity: consumer, pool: f.db() }]);
      const source = await epochs.source();
      await source.registerConsumer(key, consumer);
      const grant = await source.captureGrant(key, consumer);
      await f.record();
      const active: ConnectionEpochs = omitClosure
        ? { ...epochs, transaction: (_keys, work) => withConfigurationEpochTransaction(f.db(), work) }
        : epochs;
      expect(await f.consumer(r, active).consume("synthetic-notice")).toBe(1);
      const refused = await r.eventStore.appendToStreams!([
        {
          streamId: `synthetic.deletion-terminal-${target.connectionId}`,
          expectedVersion: "no_stream",
          context: context(),
          configurationGrants: [grant],
          events: [{ eventType: "synthetic.deletion-terminal", payload: {} }],
        },
      ]).then(
        () => false,
        () => true,
      );
      expect(refused).toBe(!omitClosure);
      expect(await f.completions()).toHaveLength(1);
    },
  );
  it("concurrent runners and a restarted consumer act once", async () => {
    const r = f.runtime();
    await f.connect(r);
    await f.record();
    const entered = signal(),
      release = signal();
    vi.mocked(r.provider.revoke).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return 200;
    });
    const first = f.consumer(r).consume("synthetic-notice");
    await entered.promise;
    try {
      expect(await f.consumer(r).consume("synthetic-notice")).toBe(0);
    } finally {
      release.resolve();
    }
    expect(await first).toBe(1);
    expect(await f.consumer(f.runtime()).consume("synthetic-notice")).toBe(0);
    expect(await f.completions()).toHaveLength(1);
    expect(r.provider.revoke).toHaveBeenCalledTimes(1);
  });
  it("rechecks unmatched receipts and catches a later seller before expiry", async () => {
    const r = f.runtime();
    await f.record();
    expect(await f.consumer(r).consume("synthetic-notice")).toBe(0);
    expect(await f.completions()).toEqual([]);
    await f.connect(r);
    expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
  });
  it.each([false, true])(
    "a connect/reauthorization racing deletion cannot restore custody (reauthorize=%s)",
    async (reauthorize) => {
      const r = f.runtime();
      const target = await f.connect(r);
      const state = await f.authorize(r, owner, reauthorize ? target.connectionId : null);
      await f.record();
      const entered = signal(),
        release = signal();
      vi.mocked(r.provider.identity).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return "synthetic-subject";
      });
      const callback = r.service.callback(owner, state, "code", context());
      const rejection = expect(callback).rejects.toMatchObject({ code: "stale-authorization" });
      await entered.promise;
      try {
        expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
      } finally {
        release.resolve();
      }
      await rejection;
      expect(await f.envelopes()).toEqual([]);
      expect(await f.completions()).toHaveLength(1);
      expect((await f.identities()).every((row) => row.subject_fingerprint === null)).toBe(true);
    },
  );
  it("reauthorization during remote work is removed by the locked local disconnect", async () => {
    const r = f.runtime();
    const target = await f.connect(r);
    const state = await f.authorize(r, owner, target.connectionId);
    await f.record();
    const entered = signal(),
      release = signal();
    vi.mocked(r.provider.revoke).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return 200;
    });
    const deletion = f.consumer(r).consume("synthetic-notice");
    await entered.promise;
    try {
      await r.service.callback(owner, state, "code", context());
    } finally {
      release.resolve();
    }
    expect(await deletion).toBe(1);
    expect(await f.envelopes()).toEqual([]);
    expect(await f.completions()).toHaveLength(1);
  });
});
