import { describe, expect, it } from "vitest";
import { consumerFixture, keys } from "./consumer-db-support";

describe("ebay-account-deletion-consumer-rotation", () => {
  const f = consumerFixture("rotation");
  it.each([
    ["old", "new"],
    ["new", "old"],
  ])(
    "matches receipt sealed with %s to binding sealed with %s without opening either subject",
    async (receiptKey, bindingKey) => {
      await f.record("synthetic-notice", "synthetic-subject", receiptKey);
      const r = f.runtime({ keyring: keys(bindingKey) });
      await f.connect(r);
      // A per-seal-id join is the negative control in both rotation orders.
      expect(
        (
          await f
            .db()
            .query(
              "SELECT 1 FROM channels_ebay_account_deletion_receipts receipt JOIN channels_ebay_seller_bindings binding ON receipt.subject_key_id=binding.subject_key_id",
            )
        ).rows,
      ).toEqual([]);
      await f.record("nonmatching", "different-subject", receiptKey);
      // Mutant control: neither matching nor nonmatching subject ciphertext is usable.
      await f
        .db()
        .query(
          "UPDATE channels_ebay_account_deletion_receipts SET subject_ciphertext=decode('00','hex'); UPDATE channels_ebay_seller_bindings SET ciphertext=decode('00','hex')",
        );
      expect(await f.consumer(r).consume("nonmatching")).toBe(0);
      expect(await f.consumer(r).consume("synthetic-notice")).toBe(1);
      expect(await f.completions()).toHaveLength(1);
    },
  );
  it("treats an unparseable pinned-root fingerprint as unavailable, never unmatched or acted", async () => {
    const r = f.runtime();
    await f.connect(r);
    await f.record();
    await f.db().query(
      `DO $$ DECLARE constraint_name text; BEGIN
          SELECT conname INTO STRICT constraint_name FROM pg_constraint
          WHERE conrelid='channels_ebay_account_deletion_receipts'::regclass AND contype='c'
            AND pg_get_constraintdef(oid) LIKE '%subject_fingerprint%';
          EXECUTE format('ALTER TABLE channels_ebay_account_deletion_receipts DROP CONSTRAINT %I', constraint_name);
        END $$`,
    );
    try {
      await f
        .db()
        .query("UPDATE channels_ebay_account_deletion_receipts SET subject_fingerprint='v1:unknown-root:invalid'");
      await expect(f.consumer(r).consume("synthetic-notice")).rejects.toMatchObject({ code: "unavailable" });
      expect(await f.envelopes()).toHaveLength(1);
      expect(await f.completions()).toEqual([]);
    } finally {
      await f
        .db()
        .query(
          "DELETE FROM channels_ebay_account_deletion_receipts; ALTER TABLE channels_ebay_account_deletion_receipts ADD CONSTRAINT synthetic_receipt_fingerprint_check CHECK (subject_fingerprint ~ '^v1:ebay-subject-root-v1:[a-f0-9]{64}$')",
        );
    }
  });
});
