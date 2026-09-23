import { describe, expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { createChannelCredentialRuntime } from "../api/runtime";
import { assertKeyringContinuity, decodeTokenSet } from "../domain/codecs";
import { credentialDatabase, credentialReadBarrier } from "./db-support";
import { at, later, binding, payload, keyring, capability } from "./fixtures";

describe("Channel credential key rotation", () => {
  const db = credentialDatabase("rotation");
  const store = (active = "old", ids = ["old", "new"]) =>
    createChannelCredentialRuntime(keyring(active, ids), [{ capability, binding }]);
  it("uses only persisted key IDs, retains missing/corrupt rows, and forbids ID reassignment", async () => {
    const old = await store().create(db(), binding, payload, at);
    const expected = { ...binding, reference: old.rowId, tokenGeneration: 1 };
    await expect(store("new", ["new"]).resolve(db(), capability, expected)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await store().readMetadata(db(), old.rowId)).toEqual(old);
    const changed = keyring();
    expect(() =>
      assertKeyringContinuity(changed, { activeKeyId: "old", keys: new Map([["old", Buffer.alloc(32, 9)]]) }),
    ).toThrow("invalid-keyring");
    await db().query("UPDATE channels_connection_credentials SET tag = $2 WHERE row_id = $1", [
      old.rowId,
      Buffer.alloc(16),
    ]);
    await expect(store().resolve(db(), capability, expected)).rejects.toThrow("unavailable");
    expect(await store().readMetadata(db(), old.rowId)).toEqual(old);
  });
  it("rewraps with separate counters, survives rollback/restart and does nothing the day after", async () => {
    const old = await store().create(db(), binding, payload, at);
    await expect(
      withPgTransaction(db(), async (tx) => {
        await store("new").rewrap(tx, old, later);
        throw new Error("crash-before-commit");
      }),
    ).rejects.toThrow("crash-before-commit");
    expect(await store("new").readMetadata(db(), old.rowId)).toEqual(old);
    const next = await store("new").rewrap(db(), old, later);
    expect(next).toMatchObject({ keyId: "new", tokenGeneration: 1, envelopeRevision: 2 });
    expect(
      decodeTokenSet(
        await store("new").resolve(db(), capability, { ...binding, reference: next.rowId, tokenGeneration: 1 }),
      ),
    ).toEqual(payload);
    expect(await store("new").rewrap(db(), next, later)).toEqual(next);
    await expect(store("new").rewrap(db(), old, later)).rejects.toThrow("conflict");
  });
  it("races rewrap against token replacement without losing refreshed tokens", async () => {
    const old = await store().create(db(), binding, payload, at);
    const interleave = credentialReadBarrier();
    const results = await Promise.allSettled([
      withPgTransaction(db(), (tx) => store("new").rewrap(interleave(tx), old, later)),
      withPgTransaction(db(), (tx) =>
        store("new").replace(interleave(tx), old, { ...payload, accessToken: "synthetic-new-token" }, later),
      ),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "conflict" }) },
    ]);
  });
  it("refuses undrained writers and detects a legacy row beyond page one with indexed EXISTS", async () => {
    // This isolated key keeps other rotation failure fixtures out of the retirement proof.
    const ring = keyring("legacy", ["legacy", "new"]);
    const oldWriter = createChannelCredentialRuntime(ring);
    const next = createChannelCredentialRuntime({ ...ring, activeKeyId: "new" });
    for (let i = 0; i < 101; i++) await oldWriter.create(db(), { ...binding, connectionId: `page-${i}` }, payload, at);
    expect(await next.retirementPreflight(db(), "legacy", false)).toBe("writers-not-drained");
    const page = await next.rotationPage(db(), "legacy");
    expect(page).toHaveLength(100);
    expect(await next.rotationPage(db(), "legacy", page[99].rowId)).toHaveLength(1);
    for (const row of page) await next.rewrap(db(), row, later);
    expect(await next.retirementPreflight(db(), "legacy", true)).toBe("referenced");
    const last = await next.rotationPage(db(), "legacy");
    expect(last).toHaveLength(1);
    await next.rewrap(db(), last[0], later);
    expect(await next.retirementPreflight(db(), "legacy", true)).toBe("zero-references");
    expect(await next.retirementPreflight(db(), "new", true)).toBe("active-key");
    const indexes = await db().query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = 'channels_connection_credentials'",
    );
    expect(indexes.rows.some((row) => row.indexdef.includes("(key_id, row_id)"))).toBe(true);
  });
});
