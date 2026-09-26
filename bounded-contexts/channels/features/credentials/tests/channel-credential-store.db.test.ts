import { describe, expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { createChannelCredentialRuntime } from "../api/runtime";
import { decodeTokenSet, encodeEnvelopeAad, encodeTokenSet } from "../domain/codecs";
import { sealSecretEnvelope } from "../../../support/runtime-support/secret-envelope";
import { credentialDatabase, credentialReadBarrier } from "./db-support";
import { at, later, binding, payload, keyring, capability } from "./fixtures";

describe("Channel credential transactional custody", () => {
  const db = credentialDatabase("store");
  const runtime = () => createChannelCredentialRuntime(keyring(), [{ capability, binding }]);
  it("creates unique insert-only references and exposes only metadata", async () => {
    const store = runtime();
    const first = await store.create(db(), binding, payload, at);
    const second = await store.create(db(), binding, payload, at);
    expect(first.rowId).not.toBe(second.rowId);
    expect(first).toMatchObject({ tokenGeneration: 1, envelopeRevision: 1 });
    expect(JSON.stringify(first)).not.toContain(payload.accessToken);
    expect(first).not.toHaveProperty("ciphertext");
    expect(await store.readMetadata(db(), first.rowId)).toEqual(first);
    const bytes = await store.resolve(db(), capability, { ...binding, reference: first.rowId, tokenGeneration: 1 });
    expect(decodeTokenSet(bytes)).toEqual(payload);
    bytes.fill(0);
  });
  it("permits exactly one concurrent CAS winner without stale retry", async () => {
    const store = runtime();
    const before = await store.create(db(), binding, payload, at);
    const interleave = credentialReadBarrier();
    const results = await Promise.allSettled(
      ["winner-a", "winner-b"].map((accessToken) =>
        withPgTransaction(db(), (tx) => store.replace(interleave(tx), before, { ...payload, accessToken }, later)),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      { status: "rejected", reason: expect.objectContaining({ code: "conflict" }) },
    ]);
    expect(await store.readMetadata(db(), before.rowId)).toMatchObject({ tokenGeneration: 2, envelopeRevision: 2 });
  });
  it("cannot rebind any immutable member or read a foreign identity/generation", async () => {
    const store = runtime();
    const before = await store.create(db(), binding, payload, at);
    for (const field of ["rowId", "accountId", "connectionId", "providerKey", "createdAt"] as const) {
      await expect(
        store.replace(
          db(),
          { ...before, [field]: field === "createdAt" ? later : before[field] + "-foreign" },
          payload,
          later,
        ),
      ).rejects.toMatchObject({ code: "conflict" });
    }
    await expect(store.replace(db(), { ...before, environment: "production" }, payload, later)).rejects.toMatchObject({
      code: "conflict",
    });
    for (const expected of [
      { ...binding, reference: before.rowId, tokenGeneration: 2 },
      { ...binding, reference: "credential-missing", tokenGeneration: 1 },
    ]) {
      await expect(store.resolve(db(), capability, expected)).rejects.toMatchObject({ code: "forbidden" });
    }
    expect(await store.readMetadata(db(), before.rowId)).toEqual(before);
  });
  it("shares caller rollback with adjacent event work, for both create and replacement", async () => {
    const store = runtime();
    const before = await store.create(db(), binding, payload, at);
    await db().query("CREATE TABLE IF NOT EXISTS synthetic_credential_event (id text PRIMARY KEY)");
    let rolledBackReference = "";
    await expect(
      withPgTransaction(db(), async (tx) => {
        rolledBackReference = (await store.create(tx, binding, payload, at)).rowId;
        await store.replace(tx, before, { ...payload, accessToken: "rolled-back" }, later);
        await tx.query("INSERT INTO synthetic_credential_event (id) VALUES ($1)", [before.rowId]);
        throw new Error("synthetic-rollback");
      }),
    ).rejects.toThrow("synthetic-rollback");
    expect(await store.readMetadata(db(), rolledBackReference)).toBeNull();
    expect(await runtime().readMetadata(db(), before.rowId)).toEqual(before);
    expect((await db().query("SELECT id FROM synthetic_credential_event WHERE id = $1", [before.rowId])).rows).toEqual(
      [],
    );
  });
  it("increments token generation only for token material; exact day-after replacement is inert", async () => {
    const store = runtime();
    const before = await store.create(db(), binding, payload, at);
    expect(await store.replace(db(), before, payload, later)).toEqual(before);
    const expiryOnly = { ...payload, accessExpiresAt: later };
    const metadataOnly = await store.replace(db(), before, expiryOnly, later);
    expect(metadataOnly).toMatchObject({ tokenGeneration: 1, envelopeRevision: 2 });
    const changed = await store.replace(db(), metadataOnly, { ...expiryOnly, refresh: { kind: "absent" } }, later);
    expect(changed).toMatchObject({ tokenGeneration: 2, envelopeRevision: 3 });
    const persisted = (
      await db().query("SELECT * FROM channels_connection_credentials WHERE row_id = $1", [changed.rowId])
    ).rows;
    expect(await runtime().rewrap(db(), changed, later)).toEqual(changed);
    expect(
      (await db().query("SELECT * FROM channels_connection_credentials WHERE row_id = $1", [changed.rowId])).rows,
    ).toEqual(persisted);
  });
  it("rejects overflow before writing and retains the authenticated row", async () => {
    const store = runtime();
    const before = await store.create(db(), binding, payload, at);
    for (const field of ["tokenGeneration", "envelopeRevision"] as const) {
      const maximum = { ...before, [field]: Number.MAX_SAFE_INTEGER };
      const sealed = sealSecretEnvelope(
        keyring().keys.get("old")!,
        encodeEnvelopeAad(maximum),
        encodeTokenSet(payload),
      );
      await db().query(
        "UPDATE channels_connection_credentials SET token_generation=$2, envelope_revision=$3, iv=$4, ciphertext=$5, tag=$6 WHERE row_id=$1",
        [before.rowId, maximum.tokenGeneration, maximum.envelopeRevision, sealed.iv, sealed.ciphertext, sealed.tag],
      );
      await expect(store.replace(db(), maximum, { ...payload, accessToken: "different" }, later)).rejects.toMatchObject(
        { code: "counter-overflow" },
      );
      expect(await store.readMetadata(db(), before.rowId)).toEqual(maximum);
    }
  });
});
