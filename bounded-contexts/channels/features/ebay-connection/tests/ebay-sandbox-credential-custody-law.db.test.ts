import { describe, expect, it, vi } from "vitest";
import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { payload } from "../../credentials/tests/fixtures";
import { fixture, owner, context, keys, signal } from "./db-support";

describe("ebay-sandbox-credential-custody-law", () => {
  const f = fixture("custody");
  it("keeps same-bytes replace inert but supersession installs g+1 in the same row without revoke", async () => {
    const r = f.runtime(),
      target = { accountId: owner, ...(await f.connect(r)) },
      store = createChannelCredentialRuntime(keys());
    await r.service.withCurrentCredential(target, 1, async (db, before, material) => {
      expect(await store.replace(db, before, material, new Date().toISOString())).toEqual(before);
      // Negative control: ordinary replace cannot satisfy accepted reauthorization's generation law.
      expect((await store.replace(db, before, material, new Date().toISOString())).tokenGeneration).not.toBe(2);
    });
    await expect(
      r.service.withCurrentCredential(target, 1, (db, before, material) =>
        store.create(db, before, material, new Date().toISOString()),
      ),
    ).rejects.toMatchObject({ code: "storage-unavailable" });
    const before = await f.envelopes();
    await r.service.callback(owner, await f.authorize(r, owner, target.connectionId), "code", context());
    expect(await f.envelopes()).toEqual([{ ...before[0], token_generation: "2" }]);
    expect(r.provider.revoke).not.toHaveBeenCalled();
    await expect(r.service.withCurrentCredential(target, 1, async () => {})).rejects.toMatchObject({
      code: "stale-authorization",
    });
  });
  it.each(["pending-setup", "active", "paused"] as const)("preserves %s through supersession", async (status) => {
    const r = f.runtime(),
      target = { accountId: owner, ...(await f.connect(r)) };
    if (status !== "pending-setup") {
      const row = (await f.envelopes())[0];
      await r.eventStore.appendToStream({
        streamId: `channels.connection-${target.connectionId}`,
        expectedVersion: 1,
        events: [
          {
            eventType: "channels.connection.activated",
            payload: {
              connectionId: target.connectionId,
              credentialReference: row.row_id,
              bindings: [{ storageLocationId: "synthetic-location", revision: 1 }],
            },
          },
        ],
        context: context(),
      });
      if (status === "paused")
        await r.eventStore.appendToStream({
          streamId: `channels.connection-${target.connectionId}`,
          expectedVersion: 2,
          events: [{ eventType: "channels.connection.paused", payload: { connectionId: target.connectionId } }],
          context: context(),
        });
    }
    const before = await r.eventStore.readStream({ streamId: `channels.connection-${target.connectionId}` });
    await r.service.callback(owner, await f.authorize(r, owner, target.connectionId), "code", context());
    expect(await r.eventStore.readStream({ streamId: `channels.connection-${target.connectionId}` })).toEqual(before);
  });
  it("rejects mismatched identity without transfer or candidate revoke", async () => {
    const r = f.runtime(),
      target = await f.connect(r),
      before = await f.envelopes();
    vi.mocked(r.provider.identity).mockResolvedValue("different-synthetic-subject");
    await expect(
      r.service.callback(owner, await f.authorize(r, owner, target.connectionId), "code", context()),
    ).rejects.toMatchObject({ code: "stale-authorization" });
    expect(await f.envelopes()).toEqual(before);
    expect((await f.db().query("SELECT binding_id FROM channels_ebay_seller_bindings")).rows).toHaveLength(1);
    expect(r.provider.revoke).not.toHaveBeenCalled();
  });
  it.each([200, 400, 401, 404, 429, 500, 503])(
    "records S1 and ambiguous response %s only as unconfirmed",
    async (status) => {
      const r = f.runtime(),
        target = { accountId: owner, ...(await f.connect(r)) };
      vi.mocked(r.provider.revoke).mockResolvedValue(status);
      const result = await r.feed.disconnectChannelConnection(target, context());
      expect(result.state).toMatchObject({ status: "disconnected", credentialReference: null });
      expect(await f.envelopes()).toHaveLength(0);
      expect(await r.service.detail(target)).toEqual({
        capabilities: [],
        remoteRevocation: "unconfirmed",
        status: "disconnected",
      });
      expect(r.provider.revoke).toHaveBeenCalledTimes(status === 429 || status >= 500 ? 3 : 1);
      expect((await r.feed.disconnectChannelConnection(target, context())).newEvents).toHaveLength(0);
      expect(r.provider.revoke).toHaveBeenCalledTimes(status === 429 || status >= 500 ? 3 : 1);
      const fresh = await f.connect(r);
      expect(fresh.connectionId).not.toBe(target.connectionId);
      expect((await f.envelopes())[0]).toMatchObject({ connection_id: fresh.connectionId, token_generation: "1" });
      await expect(r.service.withCurrentCredential(target, 1, async () => {})).rejects.toMatchObject({
        code: "stale-authorization",
      });
    },
  );
  it("callback vs disconnect cannot install a delayed generation or revoke a successor", async () => {
    const r = f.runtime(),
      target = { accountId: owner, ...(await f.connect(r)) };
    const state = await f.authorize(r, owner, target.connectionId),
      entered = signal(),
      release = signal();
    vi.mocked(r.provider.revoke).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return 200;
    });
    const disconnect = r.feed.disconnectChannelConnection(target, context());
    await entered.promise;
    const callback = r.service.callback(owner, state, "code", context());
    const rejection = expect(callback).rejects.toMatchObject({ code: "stale-authorization" });
    try {
      await vi.waitFor(async () =>
        expect(
          (
            await f
              .db()
              .query(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%channels_ebay_seller_bindings%' AND pid<>pg_backend_pid()",
              )
          ).rows.length,
        ).toBeGreaterThan(0),
      );
    } finally {
      release.resolve();
    }
    await disconnect;
    await rejection;
    expect(await f.envelopes()).toHaveLength(0);
  });
  it("refresh work drains before supersession; stale refresh cannot write after supersession or disconnect", async () => {
    const r = f.runtime(),
      target = { accountId: owner, ...(await f.connect(r)) },
      store = createChannelCredentialRuntime(keys());
    const state = await f.authorize(r, owner, target.connectionId),
      entered = signal(),
      release = signal();
    let old: Awaited<ReturnType<typeof store.readMetadata>> = null;
    const refresh = r.service.withCurrentCredential(target, 1, async (db, envelope, material) => {
      old = envelope;
      entered.resolve();
      await release.promise;
      return store.replace(db, envelope, material, new Date().toISOString());
    });
    await entered.promise;
    const callback = r.service.callback(owner, state, "code", context());
    try {
      await vi.waitFor(async () =>
        expect(
          (
            await f
              .db()
              .query(
                "SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%channels_ebay_seller_bindings%' AND pid<>pg_backend_pid()",
              )
          ).rows.length,
        ).toBeGreaterThan(0),
      );
    } finally {
      release.resolve();
    }
    await refresh;
    await callback;
    await expect(
      withPgTransaction(f.db(), (db) => store.replace(db, old!, payload, new Date().toISOString())),
    ).rejects.toMatchObject({ code: "conflict" });
    await r.feed.disconnectChannelConnection(target, context());
    await expect(
      withPgTransaction(f.db(), (db) => store.replace(db, old!, payload, new Date().toISOString())),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(await f.envelopes()).toHaveLength(0);
  });
  it("failed local commit acknowledges no disconnect and rolls custody and terminal record back", async () => {
    const r = f.runtime(),
      target = { accountId: owner, ...(await f.connect(r)) },
      before = await f.envelopes();
    const failing = f.runtime({
      retireWork: async () => {
        throw new Error("synthetic-local-failure");
      },
    });
    await expect(failing.feed.disconnectChannelConnection(target, context())).rejects.toThrow(
      "synthetic-local-failure",
    );
    expect(await f.envelopes()).toEqual(before);
    expect(await r.service.detail(target)).toEqual({
      capabilities: ["connection", "sellerSetup"],
      remoteRevocation: null,
      status: "pending-setup",
    });
    expect(
      (await r.eventStore.readStream({ streamId: `channels.connection-${target.connectionId}` })).at(-1)?.eventType,
    ).toBe("channels.connection.connected");
    await r.service.callback(owner, await f.authorize(r, owner, target.connectionId), "code", context());
    expect((await f.envelopes())[0].token_generation).toBe("2");
  });
  it("removes unusable custody even when deployment credentials and encryption keys are unavailable", async () => {
    const r = f.runtime(),
      target = { accountId: owner, ...(await f.connect(r)) };
    const unavailable = f.runtime({ keyring: null, configuration: null });
    const result = await unavailable.feed.disconnectChannelConnection(target, context());
    expect(result.state.status).toBe("disconnected");
    expect(await f.envelopes()).toHaveLength(0);
    expect(unavailable.provider.revoke).not.toHaveBeenCalled();
    expect(await r.service.detail(target)).toMatchObject({ remoteRevocation: "unconfirmed", status: "disconnected" });
  });
  it("records only consented capabilities and retires prior work during supersession and disconnect", async () => {
    const retireWork = vi.fn(async (_db: PgQueryable, _connectionId: string) => {}),
      r = f.runtime({ retireWork });
    const target = { accountId: owner, ...(await f.connect(r)) };
    const { authorizationUrl } = await r.service.start(owner, true, target.connectionId);
    await r.service.callback(owner, new URL(authorizationUrl).searchParams.get("state")!, "code", context());
    expect(await r.service.detail(target)).toMatchObject({
      capabilities: ["connection", "sellerSetup", "inventoryPublication"],
    });
    await r.service.callback(owner, await f.authorize(r, owner, target.connectionId), "code", context());
    expect(await r.service.detail(target)).toMatchObject({ capabilities: ["connection", "sellerSetup"] });
    await r.feed.disconnectChannelConnection(target, context());
    expect(retireWork).toHaveBeenCalledTimes(3);
    expect(retireWork.mock.calls.every((call) => call[1] === target.connectionId)).toBe(true);
  });
});
