import { describe, expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { createEbayReceiptExpiryStore } from "../read-model/expiry";
import { createEbayReceiptExpiryRunner } from "../api/expiry-runner";
import { receiptDatabase } from "./db-support";
import { keyring, notice } from "./fixtures";

describe("ebay-account-deletion-receipt-expiry", () => {
  const db = receiptDatabase("expiry");
  it("drains 1001 expired-at-start rows, retains unexpired controls, resumes after interruption and stays idle", async () => {
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    await withPgTransaction(db(), (tx) => store.recordEbayAccountDeletionReceipt(tx, notice));
    await db().query(
      `INSERT INTO channels_ebay_account_deletion_receipts
      SELECT 'expired-' || n, topic,event_date,publish_date,publish_attempt_count,subject_key_id,subject_fingerprint,
        subject_iv,subject_ciphertext,subject_tag,statement_timestamp()-interval '31 days',statement_timestamp()-interval '1 day'
      FROM channels_ebay_account_deletion_receipts CROSS JOIN generate_series(1,1001) n WHERE notification_id=$1`,
      [notice.notificationId],
    );
    const expiry = createEbayReceiptExpiryStore(db());
    const cutoff = await expiry.cutoff();
    const first = await expiry.batch(cutoff);
    expect(first).toEqual({ deleted: 500, remaining: true });
    const observations: unknown[] = [];
    const logger = {
      info: (_: string, fields?: unknown) => {
        observations.push(fields);
      },
      warn: (_: string, fields?: unknown) => {
        observations.push(fields);
      },
    };
    const stopped = createEbayReceiptExpiryRunner(expiry, logger);
    await expect(stopped.runOnce({ signal: AbortSignal.abort() })).rejects.toThrow("incomplete:interrupted");
    const restarted = createEbayReceiptExpiryRunner(expiry, logger);
    const measuredStart = performance.now();
    let result;
    do {
      result = await restarted.runOnce();
    } while (restarted.rescheduleOnCompletion?.(result));
    expect(performance.now() - measuredStart).toBeLessThan(1800000);
    expect((await db().query("SELECT notification_id FROM channels_ebay_account_deletion_receipts")).rows).toEqual([
      { notification_id: notice.notificationId },
    ]);
    expect(await restarted.runOnce()).toMatchObject({ processed: 0 });
    expect(observations).toContainEqual(
      expect.objectContaining({ type: "channels.ebay-receipts.cleanup-incomplete", reason: "interrupted" }),
    );
    expect(observations).toContainEqual(
      expect.objectContaining({ type: "channels.ebay-receipts.cleanup", deleted: 501 }),
    );
  });
  it("never mistakes a locked short batch for empty completion", async () => {
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    await withPgTransaction(db(), (tx) =>
      store.recordEbayAccountDeletionReceipt(tx, { ...notice, notificationId: "locked" }),
    );
    await db().query(
      "UPDATE channels_ebay_account_deletion_receipts SET received_at=statement_timestamp()-interval '31 days', expires_at=statement_timestamp()-interval '1 day' WHERE notification_id='locked'",
    );
    const client = await db().connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT notification_id FROM channels_ebay_account_deletion_receipts WHERE notification_id='locked' FOR UPDATE",
      );
      const expiry = createEbayReceiptExpiryStore(db());
      const cutoff = await expiry.cutoff();
      expect(await expiry.batch(cutoff)).toEqual({ deleted: 0, remaining: true });
      await client.query("COMMIT");
      expect(await expiry.batch(cutoff)).toEqual({ deleted: 1, remaining: false });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("serializes a retry with purge, and an old cutoff cannot erase a reinserted unexpired receipt", async () => {
    const input = { ...notice, notificationId: "purge-race" };
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    await withPgTransaction(db(), (tx) => store.recordEbayAccountDeletionReceipt(tx, input));
    await db().query(
      "UPDATE channels_ebay_account_deletion_receipts SET received_at=statement_timestamp()-interval '31 days', expires_at=statement_timestamp()-interval '1 day' WHERE notification_id='purge-race'",
    );
    const expiry = createEbayReceiptExpiryStore(db());
    const cutoff = await expiry.cutoff();
    const retry = await db().connect();
    try {
      await retry.query("BEGIN");
      expect(await store.recordEbayAccountDeletionReceipt(retry, input)).toBe("duplicate");
      expect(await expiry.batch(cutoff)).toEqual({ deleted: 0, remaining: true });
      await retry.query("COMMIT");
      expect(await expiry.batch(cutoff)).toEqual({ deleted: 1, remaining: false });
      expect(await withPgTransaction(db(), (tx) => store.recordEbayAccountDeletionReceipt(tx, input))).toBe("recorded");
      expect(await expiry.batch(cutoff)).toEqual({ deleted: 0, remaining: false });
      expect(await store.lookup(notice.userId)).toContainEqual(
        expect.objectContaining({ notificationId: input.notificationId }),
      );
    } finally {
      await retry.query("ROLLBACK");
      retry.release();
    }
  });
});
