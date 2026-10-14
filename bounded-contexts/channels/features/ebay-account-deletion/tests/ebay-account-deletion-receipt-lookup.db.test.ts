import { describe, expect, it } from "vitest";
import { withPgTransaction } from "@chase-sets/event-core-postgres";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { createChannelCredentialRuntime } from "../../credentials/api/runtime";
import { receiptDatabase } from "./db-support";
import { keyring, notice } from "./fixtures";

describe("ebay-account-deletion-receipt-lookup and ebay-subject-data-count", () => {
  const db = receiptDatabase("lookup");
  it("uses stable exact matching across rotation, omits expired subjects, and never decrypts nonmatches", async () => {
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    for (const [notificationId, userId] of [
      ["match", notice.userId],
      ["other", "another-subject"],
      ["expired", notice.userId],
    ])
      await withPgTransaction(db(), (tx) =>
        store.recordEbayAccountDeletionReceipt(tx, { ...notice, notificationId, userId }),
      );
    await db().query(
      "UPDATE channels_ebay_account_deletion_receipts SET subject_tag=$1 WHERE notification_id='other'",
      [Buffer.alloc(16)],
    );
    await db().query(
      "UPDATE channels_ebay_account_deletion_receipts SET received_at=statement_timestamp()-interval '31 days', expires_at=statement_timestamp()-interval '1 day' WHERE notification_id='expired'",
    );
    const matches = await createEbayAccountDeletionRuntime(db(), keyring("new-seal")).lookup(notice.userId);
    expect(matches).toEqual([
      { notificationId: "match", eventDate: "2026-10-11T00:00:00.000Z", expiresAt: expect.any(String) },
    ]);
    expect(JSON.stringify(matches)).not.toContain(notice.userId);
    expect(await store.lookup("absent-subject")).toEqual([]);
    expect(
      (await db().query("SELECT indexdef FROM pg_indexes WHERE tablename='channels_ebay_account_deletion_receipts'"))
        .rows,
    ).toContainEqual({ indexdef: expect.stringContaining("(subject_fingerprint, expires_at)") });
  });
  it("counts only non-disconnected Production eBay connections and their credential envelopes", async () => {
    const store = createEbayAccountDeletionRuntime(db(), keyring());
    expect(await store.countSubjectData()).toEqual({ connections: 0, credentialEnvelopes: 0 });
    const credentials = createChannelCredentialRuntime(keyring());
    const cases = [
      ["active", "ebay", "production"],
      ["paused", "ebay", "production"],
      ["pending-setup", "ebay", "production"],
      ["disconnected", "ebay", "production"],
      ["active", "ebay", "sandbox"],
      ["active", "tcgplayer", "production"],
    ] as const;
    for (const [i, [status, providerKey, environment]] of cases.entries()) {
      const connectionId = `connection-${i}`;
      await db().query(
        `INSERT INTO channel_connections
        (connection_id,account_id,provider_key,environment,status,created_at,created_at_instant,projection_updated_at,last_stream_version)
        VALUES ($1,'account', $2,$3,$4,'2026-10-11T00:00:00Z',statement_timestamp(),statement_timestamp(),1)`,
        [connectionId, providerKey, environment, status],
      );
      await credentials.create(
        db(),
        { accountId: "account", connectionId, providerKey, environment },
        {
          format: "ChannelOAuthTokenSet/v1",
          accessToken: "synthetic-token",
          refresh: { kind: "absent" },
          accessExpiresAt: null,
          issuedAt: notice.eventDate,
        },
        notice.eventDate,
      );
    }
    expect(await store.countSubjectData()).toEqual({ connections: 3, credentialEnvelopes: 3 });
  });
});
