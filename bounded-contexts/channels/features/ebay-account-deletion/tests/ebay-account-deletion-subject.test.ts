import { describe, expect, it } from "vitest";
import { assertEbaySubjectKeyringContinuity, createEbaySubjectCipher, ebaySubjectRootKeyId } from "../domain/subject";
import { parseEbayAccountDeletionNotice } from "../domain/notice";
import { ebayReceiptRetentionPolicy } from "../domain/policy";
import { keyring, notice } from "./fixtures";

describe("eBay stable subject identity", () => {
  it("matches and opens across seal rotation, but binds the notification and historical keys", () => {
    const old = createEbaySubjectCipher(keyring());
    const next = createEbaySubjectCipher(keyring("new-seal"));
    const sealed = old.seal(notice.notificationId, notice.userId);
    expect(next.fingerprint(notice.userId)).toBe(sealed.fingerprint);
    expect(sealed.keyId).toBe("old-seal");
    expect(next.open(notice.notificationId, sealed)).toBe(notice.userId);
    expect(() => next.open("another-notification", sealed)).toThrow("unavailable");
    for (const missing of ["old-seal", ebaySubjectRootKeyId]) {
      const ring = keyring("new-seal");
      ring.keys.delete(missing);
      expect(() => createEbaySubjectCipher(ring).assertAvailable(sealed)).toThrow("unavailable");
      expect(() => assertEbaySubjectKeyringContinuity(keyring(), ring, [sealed])).toThrow("unavailable");
    }
    const changed = keyring();
    changed.keys.set(ebaySubjectRootKeyId, Buffer.alloc(32, 8));
    expect(() => assertEbaySubjectKeyringContinuity(keyring(), changed, [sealed])).toThrow("unavailable");
    expect(() => assertEbaySubjectKeyringContinuity(keyring(), keyring("new-seal"), [sealed])).not.toThrow();
    expect(JSON.stringify(sealed)).not.toContain(notice.userId);
    expect(() =>
      createEbaySubjectCipher(keyring(ebaySubjectRootKeyId)).seal(notice.notificationId, notice.userId),
    ).toThrow("unavailable");
  });
  it.each([
    { extra: {} },
    { eventDate: "2026-10-11" },
    { eventDate: "2026-02-30T00:00:00Z" },
    { publishDate: {} },
    { userId: { nested: true } },
    { userId: "x".repeat(1025) },
    { notificationId: "" },
    { publishAttemptCount: 0 },
    { publishAttemptCount: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects closed-input violations without subject disclosure (%j)", (delta) => {
    expect(() => parseEbayAccountDeletionNotice({ ...notice, ...delta })).toThrow("invalid-notice");
  });
  it("normalizes instants and refuses changing the registered retention law", () => {
    expect(parseEbayAccountDeletionNotice(notice).eventDate).toBe("2026-10-11T00:00:00.000Z");
    expect(parseEbayAccountDeletionNotice({ ...notice, eventDate: "2026-10-11T01:00:00.123456+01:00" }).eventDate).toBe(
      "2026-10-11T00:00:00.123456Z",
    );
    expect(parseEbayAccountDeletionNotice({ ...notice, eventDate: "2026-10-11T00:00:00.000001Z" }).eventDate).not.toBe(
      parseEbayAccountDeletionNotice(notice).eventDate,
    );
    expect(() =>
      ebayReceiptRetentionPolicy.decodeValue({ retentionSeconds: 1, sweepSeconds: 3600, batchSize: 500 }),
    ).toThrow();
    expect(() =>
      ebayReceiptRetentionPolicy.decodeValue({ ...ebayReceiptRetentionPolicy.defaultValue, nested: {} }),
    ).toThrow();
  });
});
