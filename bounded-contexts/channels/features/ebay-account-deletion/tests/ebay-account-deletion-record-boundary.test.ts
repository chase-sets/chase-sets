import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createEbayAccountDeletionRuntime } from "../api/runtime";
import { createEbaySubjectCipher } from "../domain/subject";
import { keyring, notice } from "./fixtures";

describe("eBay notice admission boundary", () => {
  it("rejects changed existing topics as conflict, but never admits another topic for a new receipt", async () => {
    const sealed = createEbaySubjectCipher(keyring()).seal(notice.notificationId, notice.userId);
    const query = vi
      .fn<PgQueryable["query"]>()
      .mockResolvedValue({ rows: [{ ...sealed, topic: notice.topic, eventDate: "2026-10-11T00:00:00.000Z" }] });
    const db = { query };
    const store = createEbayAccountDeletionRuntime(db, keyring());
    await expect(store.recordEbayAccountDeletionReceipt(db, { ...notice, topic: "OTHER_TOPIC" })).resolves.toBe(
      "conflict",
    );
    query.mockResolvedValue({ rows: [] });
    await expect(store.recordEbayAccountDeletionReceipt(db, { ...notice, topic: "OTHER_TOPIC" })).rejects.toThrow(
      "invalid-notice",
    );
    expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
  });
  it("sanitizes secret-bearing storage errors without a raw cause or message", async () => {
    const marker = "synthetic-private-storage-error-marker";
    const query = vi.fn<PgQueryable["query"]>().mockRejectedValue(new Error(marker));
    const db = { query };
    const store = createEbayAccountDeletionRuntime(db, keyring());
    try {
      await store.recordEbayAccountDeletionReceipt(db, notice);
      throw new Error("expected-storage-failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "storage-unavailable", message: "storage-unavailable" });
      expect(String(error)).not.toContain(marker);
      expect(error).not.toHaveProperty("cause");
    }
  });
});
