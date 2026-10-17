import { describe, expect, it, vi } from "vitest";
import { bootstrapContextDatabase } from "@chase-sets/bounded-context-runtime";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { module as channels } from "../../../index";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { createEbaySubjectCipher } from "../domain/subject";
import { ebayReceiptSchemaMigrations, ebayReceiptSchemaSql } from "../read-model/schema";
import { receiptDatabase } from "./db-support";
import { keyring, notice } from "./fixtures";

describe("ebay-account-deletion-receipt-store", () => {
  const fresh = receiptDatabase("fresh", false);
  const upgrade = receiptDatabase("upgrade", false);
  it("converges fresh/upgrade/boot-twice with exactly the closed columns and encrypted custody", async () => {
    await bootstrapContextDatabase(
      {
        ...channels,
        schemaSql: channels.schemaSql.replace(ebayReceiptSchemaSql, ""),
        schemaMigrations: channels.schemaMigrations?.filter(
          (m) => !ebayReceiptSchemaMigrations.some((next) => next.migrationId === m.migrationId),
        ),
      },
      upgrade(),
    );
    expect(
      (await upgrade().query("SELECT to_regclass('channels_ebay_account_deletion_receipts') AS name")).rows[0],
    ).toEqual({ name: null });
    await bootstrapContextDatabase(channels, fresh());
    await bootstrapContextDatabase(channels, upgrade());
    const columns = (db: ReturnType<typeof fresh>) =>
      db.query(
        "SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='channels_ebay_account_deletion_receipts' ORDER BY ordinal_position",
      );
    const beforeColumns = (await columns(fresh())).rows;
    expect((await columns(upgrade())).rows).toEqual(beforeColumns);
    for (const sql of [
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='channels_ebay_account_deletion_receipts'::regclass ORDER BY definition",
      "SELECT indexdef FROM pg_indexes WHERE tablename='channels_ebay_account_deletion_receipts' ORDER BY indexdef",
    ])
      expect((await fresh().query(sql)).rows).toEqual((await upgrade().query(sql)).rows);
    expect(beforeColumns.map((c) => c.column_name)).toEqual([
      "notification_id",
      "topic",
      "event_date",
      "publish_date",
      "publish_attempt_count",
      "subject_key_id",
      "subject_fingerprint",
      "subject_iv",
      "subject_ciphertext",
      "subject_tag",
      "received_at",
      "expires_at",
    ]);
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    try {
      const store = createEbayAccountDeletionRuntime(upgrade(), keyring());
      await withPgTransaction(upgrade(), (tx) => store.recordEbayAccountDeletionReceipt(tx, notice));
      const snapshot = async () =>
        (await upgrade().query("SELECT * FROM channels_ebay_account_deletion_receipts")).rows;
      const before = await snapshot();
      expect(JSON.stringify(before)).not.toContain(notice.userId);
      const row = before[0]!;
      expect(
        createEbaySubjectCipher(keyring("new-seal")).open(notice.notificationId, {
          keyId: row.subject_key_id as string,
          fingerprint: row.subject_fingerprint as string,
          iv: row.subject_iv as Uint8Array,
          ciphertext: row.subject_ciphertext as Uint8Array,
          tag: row.subject_tag as Uint8Array,
        }),
      ).toBe(notice.userId);
      await bootstrapContextDatabase(channels, upgrade());
      await bootstrapContextDatabase(channels, upgrade());
      expect(await snapshot()).toEqual(before);
      expect(JSON.stringify(logs.flatMap((spy) => spy.mock.calls))).not.toContain(notice.userId);
    } finally {
      logs.forEach((spy) => spy.mockRestore());
    }
  });
});
