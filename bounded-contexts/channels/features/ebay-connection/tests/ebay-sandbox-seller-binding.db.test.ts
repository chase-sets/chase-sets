import { describe, expect, it } from "vitest";
import { createEbayAccountDeletionRuntime } from "../../ebay-account-deletion/api/runtime";
import { createEbaySubjectCipher } from "../../ebay-account-deletion/domain/subject";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { fixture, owner, context, keys, config } from "./db-support";

describe("ebay-sandbox-seller-binding", () => {
  const f = fixture("binding");
  it("atomically commits one pending-setup event, generation-1 envelope and encrypted binding", async () => {
    const r = f.runtime(),
      connected = await f.connect(r);
    expect(await f.envelopes()).toEqual([
      { row_id: expect.any(String), token_generation: "1", connection_id: connected.connectionId },
    ]);
    const binding = (await f.db().query("SELECT * FROM channels_ebay_seller_bindings")).rows[0];
    expect(binding).toMatchObject({
      account_id: owner,
      subject_key_id: "old",
      current_connection_id: connected.connectionId,
      capabilities: ["connection", "sellerSetup"],
    });
    expect(binding.subject_fingerprint).toMatch(/^v1:ebay-subject-root-v1:[a-f0-9]{64}$/);
    const events = await r.eventStore.readStream({ streamId: `channels.connection-${connected.connectionId}` });
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("channels.connection.connected");
    expect(JSON.stringify(events)).not.toContain("synthetic-subject");
    expect(JSON.stringify(binding)).not.toContain("synthetic-subject");
    expect(await r.service.detail({ accountId: "acc_other", connectionId: connected.connectionId })).toBeNull();
  });
  it("admits one owner across concurrent callbacks spanning seal rotation", async () => {
    const a = f.runtime(),
      b = f.runtime({ keyring: keys("new") });
    const states = await Promise.all([f.authorize(a), f.authorize(b, "acc_other")]);
    const results = await Promise.allSettled([
      a.service.callback(owner, states[0], "code-a", context()),
      b.service.callback("acc_other", states[1], "code-b", context("acc_other")),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "seller-conflict" }) },
    ]);
    expect((await f.db().query("SELECT binding_id FROM channels_ebay_seller_bindings")).rows).toHaveLength(1);
    expect(await f.envelopes()).toHaveLength(1);
  });
  it("retains root and seal keys after disconnect, with environment-qualified identity controls", async () => {
    const r = f.runtime(),
      connected = await f.connect(r);
    await r.feed.disconnectChannelConnection({ accountId: owner, connectionId: connected.connectionId }, context());
    await expect(f.connect(r, "acc_other")).rejects.toMatchObject({ code: "seller-conflict" });
    const continuity = createEbayAccountDeletionRuntime(f.db(), keys());
    const withoutRoot = {
      activeKeyId: "new",
      keys: new Map([...keys().keys].filter(([id]) => id !== "ebay-subject-root-v1")),
    };
    await expect(continuity.assertKeyringContinuity(withoutRoot)).rejects.toMatchObject({ code: "unavailable" });
    await expect(
      continuity.assertKeyringContinuity({
        activeKeyId: "new",
        keys: new Map([...keys().keys].filter(([id]) => id !== "old")),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    const retirement = createChannelCredentialRuntime(keys("new"));
    expect(await retirement.retirementPreflight(f.db(), "old", true)).toBe("referenced");
    expect(await retirement.retirementPreflight(f.db(), "ebay-subject-root-v1", true)).toBe("referenced");
    const cipher = createEbaySubjectCipher(keys("new")),
      sealed = cipher.seal("production-control", "synthetic-subject");
    await f.db().query(
      `INSERT INTO channels_ebay_seller_bindings (binding_id,account_id,environment,subject_fingerprint,subject_key_id,iv,ciphertext,tag,capabilities)
      VALUES ('production-control','acc_other','production',$1,$2,$3,$4,$5,'[]')`,
      [sealed.fingerprint, sealed.keyId, sealed.iv, sealed.ciphertext, sealed.tag],
    );
    expect(
      (await f.db().query("SELECT environment FROM channels_ebay_seller_bindings ORDER BY environment")).rows,
    ).toEqual([{ environment: "production" }, { environment: "sandbox" }]);
  });
  it("rolls back binding and envelope when the initial ConnectChannel event cannot commit", async () => {
    const r = f.runtime();
    const failing = f.runtime({
      eventStore: {
        ...r.eventStore,
        appendToStreamInTransaction: async () => {
          throw new Error("synthetic-event-failure");
        },
      },
    });
    await expect(f.connect(failing)).rejects.toThrow("synthetic-event-failure");
    expect(await f.envelopes()).toHaveLength(0);
    expect((await f.db().query("SELECT binding_id FROM channels_ebay_seller_bindings")).rows).toHaveLength(0);
    expect((await f.db().query("SELECT event_id FROM event_store_events")).rows).toHaveLength(0);
  });
  it("rejects cross-Account, expired, RuName/environment mismatch and replay before provider calls", async () => {
    const r = f.runtime(),
      state = await f.authorize(r);
    await expect(r.service.callback("acc_other", state, "code", context("acc_other"))).rejects.toMatchObject({
      code: "invalid-state",
    });
    const wrongRuName = f.runtime({ configuration: { ...config, ruName: "different" } });
    await expect(wrongRuName.service.callback(owner, state, "code", context())).rejects.toMatchObject({
      code: "invalid-state",
    });
    await f.db().query("UPDATE channels_ebay_oauth_attempts SET environment='production'");
    await expect(r.service.callback(owner, state, "code", context())).rejects.toMatchObject({ code: "invalid-state" });
    await f
      .db()
      .query("UPDATE channels_ebay_oauth_attempts SET environment='sandbox',expires_at=now()-interval '1 second'");
    await expect(r.service.callback(owner, state, "code", context())).rejects.toMatchObject({ code: "invalid-state" });
    expect(r.provider.exchange).not.toHaveBeenCalled();
    expect(await f.envelopes()).toHaveLength(0);
    const fresh = await f.authorize(r);
    await r.service.callback(owner, fresh, "code", context());
    await expect(r.service.callback(owner, fresh, "code", context())).rejects.toMatchObject({ code: "invalid-state" });
    expect(r.provider.exchange).toHaveBeenCalledTimes(1);
  });
});
