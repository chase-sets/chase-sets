import { describe, expect, it } from "vitest";
import { withPgTransaction, type PgQueryable } from "@chase-sets/event-core-postgres";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { ebaySubjectRootKeyId } from "../domain/subject";
import { receiptDatabase } from "./db-support";
import { keyring, notice } from "./fixtures";

describe("ebay-account-deletion-receipt-idempotency", () => {
  const db = receiptDatabase("idempotency");
  it("preserves the entire row on rotated retries, distinguishes conflict and unavailable, and rolls back caller work", async () => {
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    expect(await withPgTransaction(db(), (tx) => store.recordEbayAccountDeletionReceipt(tx, notice))).toBe("recorded");
    const snapshot = async () =>
      (await db().query("SELECT * FROM channels_ebay_account_deletion_receipts ORDER BY notification_id")).rows;
    const before = await snapshot();
    for (const changed of ["old-seal", ebaySubjectRootKeyId]) {
      const changedRing = keyring("new-seal");
      changedRing.keys.set(changed, Buffer.alloc(32, 9));
      expect(
        await withPgTransaction(db(), (tx) =>
          createEbayAccountDeletionRuntime(db(), changedRing).recordEbayAccountDeletionReceipt(tx, notice),
        ),
      ).toBe("unavailable");
    }
    const rotated = createEbayAccountDeletionRuntime(db(), keyring("new-seal"));
    const retry = { ...notice, publishDate: "2026-10-12T00:00:00Z", publishAttemptCount: 2 };
    expect(await withPgTransaction(db(), (tx) => rotated.recordEbayAccountDeletionReceipt(tx, retry))).toBe(
      "duplicate",
    );
    for (const delta of [
      { userId: "different-subject" },
      { topic: "OTHER_TOPIC" },
      { eventDate: "2026-10-12T00:00:00Z" },
      { eventDate: "2026-10-11T00:00:00.000001Z" },
    ])
      expect(
        await withPgTransaction(db(), (tx) => rotated.recordEbayAccountDeletionReceipt(tx, { ...retry, ...delta })),
      ).toBe("conflict");
    for (const missing of ["old-seal", ebaySubjectRootKeyId]) {
      const ring = keyring("new-seal");
      ring.keys.delete(missing);
      expect(
        await withPgTransaction(db(), (tx) =>
          createEbayAccountDeletionRuntime(db(), ring).recordEbayAccountDeletionReceipt(tx, retry),
        ),
      ).toBe("unavailable");
      await expect(store.assertKeyringContinuity(ring)).rejects.toThrow("unavailable");
    }
    await expect(
      withPgTransaction(db(), async (tx) => {
        await rotated.recordEbayAccountDeletionReceipt(tx, { ...notice, notificationId: "rollback" });
        throw new Error("caller-rollback");
      }),
    ).rejects.toThrow("caller-rollback");
    expect(await snapshot()).toEqual(before);
  });
  it.each([false, true])("rereads the concurrent losing insert (different subject=%s)", async (different) => {
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    let arrived = 0;
    let release = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interleave = (tx: PgQueryable): PgQueryable => ({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const result = await tx.query<Row>(sql, values);
        if (sql.startsWith("SELECT subject_fingerprint") && arrived < 2) {
          arrived++;
          if (arrived === 2) release();
          await barrier;
        }
        return result;
      },
    });
    const results = await Promise.all(
      [0, 1].map((i) =>
        withPgTransaction(db(), (tx) =>
          store.recordEbayAccountDeletionReceipt(interleave(tx), {
            ...notice,
            notificationId: `race-${different}`,
            userId: different && i === 1 ? "other-subject" : notice.userId,
          }),
        ),
      ),
    );
    expect(results.sort()).toEqual([different ? "conflict" : "duplicate", "recorded"]);
    expect(
      (
        await db().query(
          "SELECT count(*)::int AS count FROM channels_ebay_account_deletion_receipts WHERE notification_id=$1",
          [`race-${different}`],
        )
      ).rows[0],
    ).toEqual({ count: 1 });
  });
});
