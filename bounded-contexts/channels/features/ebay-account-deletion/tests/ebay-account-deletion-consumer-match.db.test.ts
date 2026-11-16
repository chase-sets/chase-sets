import { describe, expect, it, vi } from "vitest";
import { loadOwned } from "../../connections/api/runtime";
import { createEbayReceiptExpiryStore } from "../read-model/expiry";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { consumerFixture, context, keys, owner } from "./consumer-db-support";

describe("ebay-account-deletion-consumer-match", () => {
  const f = consumerFixture("match");
  it("disconnects exactly the matching connection, removes custody, and writes one subject-free completion", async () => {
    const r = f.runtime();
    const target = await f.connect(r);
    vi.mocked(r.provider.identity).mockResolvedValue("unrelated-synthetic-subject");
    const other = await f.connect(r, "acc_other");
    await f.record("unmatched", "absent-synthetic-subject");
    expect(await f.consumer(r).consume("unmatched")).toBe(0);
    expect(await f.completions()).toEqual([]);
    expect(await f.record()).toBe("recorded");
    expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
    expect((await loadOwned(r.eventStore, owner, target.connectionId)).state.status).toBe("disconnected");
    expect((await loadOwned(r.eventStore, "acc_other", other.connectionId)).state.status).toBe("pending-setup");
    expect(await f.envelopes()).toMatchObject([{ connection_id: other.connectionId }]);
    expect(await f.identities()).toContainEqual({
      subject_fingerprint: null,
      subject_key_id: null,
      iv: null,
      ciphertext: null,
      tag: null,
      current_connection_id: null,
    });
    expect(await f.completions()).toEqual([
      {
        notification_id: "synthetic-notice",
        connection_id: target.connectionId,
        acted_at: expect.any(Date),
        remote_revocation: "unconfirmed",
      },
    ]);
    await createEbayAccountDeletionRuntime(f.db(), keys()).assertKeyringContinuity(keys("new"));
    expect(r.provider.revoke).toHaveBeenCalledTimes(1);
    vi.mocked(r.provider.identity).mockResolvedValue("synthetic-subject");
    await expect(r.service.callback(owner, await f.authorize(r), "code", context())).rejects.toMatchObject({
      code: "stale-authorization",
    });
  });
  it("removes identity on an already-disconnected binding without another event or revoke", async () => {
    const r = f.runtime(),
      target = { accountId: owner, ...(await f.connect(r)) };
    await r.feed.disconnectChannelConnection(target, context());
    await f.record();
    expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
    expect((await f.identities())[0]!.subject_fingerprint).toBeNull();
    expect(r.provider.revoke).toHaveBeenCalledTimes(1);
    expect(
      (await loadOwned(r.eventStore, owner, target.connectionId)).events.filter(
        (event) => event.type === "channels.connection.disconnected",
      ),
    ).toHaveLength(1);
  });
  it("expires completion with the receipt and never acts on an expired receipt", async () => {
    const r = f.runtime();
    await f.connect(r);
    await f.record();
    await f.consumer(r).consume("synthetic-notice");
    await f.record("expired", "unrelated-subject");
    await f
      .db()
      .query(
        "UPDATE channels_ebay_account_deletion_receipts SET received_at=statement_timestamp()-interval '31 days',expires_at=statement_timestamp()-interval '1 day'",
      );
    expect(await f.consumer(r).consume("expired")).toBe(0);
    const expiry = createEbayReceiptExpiryStore(f.db());
    expect((await expiry.batch(await expiry.cutoff())).deleted).toBe(2);
    expect(await f.completions()).toEqual([]);
  });
  it("kills the omitted-disconnect mutant rather than recording completion with live custody", async () => {
    const r = f.runtime();
    const target = await f.connect(r);
    await f.record();
    const omission = vi.spyOn(r.feed, "disconnectChannelConnectionInTransaction").mockImplementation(async () => {
      const { state, version } = await loadOwned(r.eventStore, owner, target.connectionId);
      return { state, version, newEvents: [], storedEvents: [] };
    });
    try {
      await expect(f.consumer(r).consume("synthetic-notice")).rejects.toThrow("storage-unavailable");
      expect(await f.envelopes()).toHaveLength(1);
      expect(await f.completions()).toEqual([]);
    } finally {
      omission.mockRestore();
    }
    expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
  });
  it("rolls disconnect, envelope and identity removal back when completion insertion fails, then retries", async () => {
    const r = f.runtime();
    const target = await f.connect(r);
    await f.record();
    await f.db()
      .query(`CREATE FUNCTION reject_deletion_completion() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic-private-error'; END $$;
      CREATE TRIGGER reject_deletion_completion BEFORE INSERT ON channels_ebay_account_deletion_completions FOR EACH ROW EXECUTE FUNCTION reject_deletion_completion()`);
    try {
      await expect(f.consumer(r).consume("synthetic-notice")).rejects.toThrow("storage-unavailable");
      expect(await f.envelopes()).toHaveLength(1);
      expect((await f.identities())[0]!.subject_fingerprint).not.toBeNull();
      expect(await f.completions()).toEqual([]);
      expect((await loadOwned(r.eventStore, owner, target.connectionId)).state.status).toBe("pending-setup");
    } finally {
      await f
        .db()
        .query(
          "DROP TRIGGER reject_deletion_completion ON channels_ebay_account_deletion_completions; DROP FUNCTION reject_deletion_completion()",
        );
    }
    expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
  });
});
