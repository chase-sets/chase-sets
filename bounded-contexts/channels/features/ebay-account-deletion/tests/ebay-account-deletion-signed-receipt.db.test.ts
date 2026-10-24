import { describe, expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { receiptDatabase } from "./db-support";
import { keyring } from "./fixtures";
import { payload, post, signedApp } from "./signed-fixtures";

describe("ebay-account-deletion-signed-receipt", () => {
  const db = receiptDatabase("signed");
  it("verifies synthetic signatures through the real public parser/verifier and commits one immutable receipt across replay/conflict", async () => {
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    const fixture = signedApp({
      recordReceipt: (notice) => withPgTransaction(db(), (tx) => store.recordEbayAccountDeletionReceipt(tx, notice)),
    });
    const snapshot = async () => (await db().query("SELECT * FROM channels_ebay_account_deletion_receipts")).rows;
    expect((await post(fixture.app)).status).toBe(200);
    const original = await snapshot();
    expect(original).toHaveLength(1);
    expect((await post(fixture.app)).status).toBe(200);
    expect(await snapshot()).toEqual(original);
    const changed = structuredClone(payload);
    changed.notification.data.userId = "synthetic-other-subject";
    expect((await post(fixture.app, changed)).status).toBe(409);
    expect(await snapshot()).toEqual(original);
    const stored = JSON.stringify(original);
    for (const marker of Object.values(payload.notification.data)) expect(stored).not.toContain(marker);
    expect(await store.lookup(payload.notification.data.userId)).toHaveLength(1);
  });
});
