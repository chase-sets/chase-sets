import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createEbayAccountDeletionConsumerRunner } from "../api/consumer-runner";
import { EbayReceiptError } from "../domain/subject";
import { ebayDeletionConsumerSchemaSql } from "../read-model/consumer-schema";

describe("ebay-account-deletion-consumer-secret-scan", () => {
  it("never emits subject, fingerprint, envelope, notification or exception material in runner observations", async () => {
    const marker = "synthetic-private-subject-marker";
    const logger = { info: vi.fn(), warn: vi.fn() };
    const consumer = {
      batch: vi.fn(async () => [marker]),
      consume: vi.fn(async () => {
        throw new Error(marker);
      }),
    };
    const runner = createEbayAccountDeletionConsumerRunner(consumer, logger);
    await expect(runner.runOnce()).rejects.toThrow("ebay-deletion-consumer-incomplete");
    consumer.consume.mockRejectedValue(new EbayReceiptError("unavailable"));
    await runner.runOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      type: "channels.ebay-deletion.unavailable",
      count: 1,
    });
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toContain(marker);
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls])).not.toMatch(
      /fingerprint|ciphertext|notificationId|userId/,
    );
  });
  it("has a closed subject-free completion schema and a metadata-only match path", () => {
    const table = ebayDeletionConsumerSchemaSql.split("DO $$")[0]!;
    for (const column of ["notification_id", "connection_id", "acted_at", "remote_revocation"])
      expect(table).toContain(column);
    expect(table).not.toMatch(/subject|user_?id|fingerprint|ciphertext|token/i);
    const source = readFileSync(new URL("../api/consumer.ts", import.meta.url), "utf8");
    expect(source).toContain("parseEbaySubjectFingerprint");
    expect(source).not.toMatch(/\.open\(|decrypt|SELECT \*|subject_key_id\s*=\s*\$/);
    expect(source).toContain("subject_fingerprint=$1");
    expect(source.indexOf("if (!targets.length) return 0")).toBeLessThan(
      source.indexOf("await deps.ebayConnection.prepareAccountDeletionDisconnect"),
    );
  });
});
