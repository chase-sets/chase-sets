import { describe, expect, it, vi } from "vitest";
import { consumerFixture, owner, context, signal } from "./consumer-db-support";
import { withConfigurationEpochTransaction } from "@chase-sets/event-core-postgres";
import { createConnectionEpochs, type ConnectionEpochs } from "../../connections/api/owner-epochs";
import { hashOAuthState } from "../../ebay-connection/domain/oauth";
import { createEbayReceiptExpiryRunner } from "../api/expiry-runner";
import { createEbayReceiptExpiryStore } from "../read-model/expiry";

describe("ebay-account-deletion-consumer-races", () => {
  const f = consumerFixture("races");
  async function expireReceipt(sweep: boolean) {
    await f.db().query(
      `UPDATE channels_ebay_account_deletion_receipts
      SET received_at=statement_timestamp()-interval '31 days',expires_at=statement_timestamp()-interval '1 day'`,
    );
    if (sweep) {
      const runner = createEbayReceiptExpiryRunner(createEbayReceiptExpiryStore(f.db()), {
        info: vi.fn(),
        warn: vi.fn(),
      });
      expect((await runner.runOnce()).processed).toBe(1);
      expect(await f.completions()).toEqual([]);
      expect((await f.db().query("SELECT notification_id FROM channels_ebay_account_deletion_receipts")).rows).toEqual(
        [],
      );
    }
  }
  it.each([
    [owner, "unexpired"],
    [owner, "expired"],
    [owner, "swept"],
    ["acc_second", "unexpired"],
    ["acc_second", "expired"],
    ["acc_second", "swept"],
  ])(
    "invalidates a consumed first-connect attempt across completion/expiry (Account=%s, receipt=%s)",
    async (accountId, retention) => {
      const r = f.runtime();
      await f.connect(r);
      const state = await f.authorize(r, accountId);
      const attempt = (
        await f.db().query<{
          candidate_connection_id: string;
        }>("SELECT candidate_connection_id FROM channels_ebay_oauth_attempts WHERE state_hash=$1", [hashOAuthState(state)])
      ).rows[0]!;
      await f.record();
      const entered = signal(),
        release = signal();
      vi.mocked(r.provider.identity).mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return "synthetic-subject";
      });
      const callback = r.service.callback(accountId, state, "code", context(accountId));
      const rejection = expect(callback).rejects.toMatchObject({ code: "stale-authorization" });
      await entered.promise;
      try {
        expect(
          (
            await f
              .db()
              .query("SELECT consumed_at FROM channels_ebay_oauth_attempts WHERE state_hash=$1", [
                hashOAuthState(state),
              ])
          ).rows[0]!.consumed_at,
        ).not.toBeNull();
        expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
        expect((await f.db().query("SELECT state_hash FROM channels_ebay_oauth_attempts")).rows).toEqual([]);
        if (retention !== "unexpired") await expireReceipt(retention === "swept");
      } finally {
        release.resolve();
      }
      await rejection;
      expect(await f.envelopes()).toEqual([]);
      expect(
        (await f.identities()).every((row) =>
          [
            row.subject_fingerprint,
            row.subject_key_id,
            row.iv,
            row.ciphertext,
            row.tag,
            row.current_connection_id,
          ].every((value) => value === null),
        ),
      ).toBe(true);
      expect(
        await r.eventStore.readStream({ streamId: `channels.connection-${attempt.candidate_connection_id}` }),
      ).toEqual([]);
    },
  );
  it("admits genuinely fresh consent after expiry cleanup without restoring the terminal connection or affecting an unrelated seller", async () => {
    const r = f.runtime();
    const old = await f.connect(r);
    vi.mocked(r.provider.identity).mockResolvedValue("synthetic-unrelated-subject");
    const unrelated = await f.connect(r, "acc_unrelated");
    const unrelatedEnvelope = (await f.envelopes()).filter((row) => row.connection_id === unrelated.connectionId);
    const unrelatedEvents = await r.eventStore.readStream({
      streamId: `channels.connection-${unrelated.connectionId}`,
    });
    const oldState = await f.authorize(r, "acc_second");
    await f.record();
    expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
    await expireReceipt(true);
    await expect(r.service.callback("acc_second", oldState, "code", context("acc_second"))).rejects.toMatchObject({
      code: "invalid-state",
    });
    vi.mocked(r.provider.identity).mockResolvedValue("synthetic-subject");
    const fresh = await f.connect(r, "acc_second");
    expect(fresh.connectionId).not.toBe(old.connectionId);
    expect((await f.envelopes()).filter((row) => row.connection_id === old.connectionId)).toEqual([]);
    expect((await f.envelopes()).filter((row) => row.connection_id === unrelated.connectionId)).toEqual(
      unrelatedEnvelope,
    );
    expect(await r.eventStore.readStream({ streamId: `channels.connection-${unrelated.connectionId}` })).toEqual(
      unrelatedEvents,
    );
    expect(await r.eventStore.readStream({ streamId: `channels.connection-${fresh.connectionId}` })).toMatchObject([
      { eventType: "channels.connection.connected" },
    ]);
    expect(
      (await r.eventStore.readStream({ streamId: `channels.connection-${old.connectionId}` })).at(-1)?.eventType,
    ).toBe("channels.connection.disconnected");
  });
  it.each([false, true])(
    "epoch closure refuses stale terminals; REMOVE_DELETION_ENROLLMENT mutant=%s",
    async (omitClosure) => {
      const r = f.runtime(),
        target = await f.connect(r);
      const key = `connection/${target.connectionId}`;
      await createConnectionEpochs(f.db()).source();
      const identity = (
        await f.db().query<{
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
