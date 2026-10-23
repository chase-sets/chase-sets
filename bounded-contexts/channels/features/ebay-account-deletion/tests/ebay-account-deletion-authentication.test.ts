import { afterEach, describe, expect, it, vi } from "vitest";
import { config, keyFetcher, path, payload, post, signedApp, signedHeader, syntheticKey } from "./signed-fixtures";

afterEach(() => vi.useRealTimers());
describe("ebay-account-deletion-authentication", () => {
  it("verifies the SDK representation, drops username/eiasToken and acknowledges only after recording completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const recordReceipt = vi.fn(async () => {
      await gate;
      return "recorded" as const;
    });
    const { app } = signedApp({ recordReceipt });
    let acknowledged = false;
    const response = Promise.resolve(
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ebay-signature": signedHeader() },
        body: JSON.stringify(payload, null, 2),
      }),
    ).then((r) => {
      acknowledged = true;
      return r;
    });
    await vi.waitFor(() => expect(recordReceipt).toHaveBeenCalledTimes(1));
    expect(acknowledged).toBe(false);
    expect(recordReceipt.mock.calls[0]).toEqual([
      expect.objectContaining({ userId: payload.notification.data.userId }),
    ]);
    expect(JSON.stringify(recordReceipt.mock.calls)).not.toMatch(/synthetic-username-marker|synthetic-eias-marker/);
    release();
    expect((await response).status).toBe(200);
  });
  it.each([
    "unsigned",
    "malformed",
    "unknown-field",
    "oversize-header",
    "body-byte",
    "signature-byte",
    "digest",
    "algorithm",
    "wrong-key",
    "kid-dot-segment",
  ])("rejects %s before any receipt write", async (mutation) => {
    const fixture = signedApp(
      {},
      keyFetcher(mutation === "wrong-key" ? syntheticKey(2).publicKey : syntheticKey().publicKey),
    );
    let header = signedHeader();
    const value = structuredClone(payload);
    if (mutation === "unsigned") header = "";
    if (mutation === "malformed") header = "not-base64";
    if (mutation === "oversize-header") header = "A".repeat(8193);
    if (mutation === "body-byte") value.notification.data.userId += "x";
    if (["signature-byte", "digest", "algorithm", "unknown-field", "kid-dot-segment"].includes(mutation)) {
      const decoded = JSON.parse(Buffer.from(header, "base64").toString());
      if (mutation === "signature-byte") {
        const bytes = Buffer.from(decoded.signature, "base64");
        bytes[10]! ^= 1;
        decoded.signature = bytes.toString("base64");
      } else if (mutation === "digest") decoded.digest = "sha1";
      else if (mutation === "algorithm") decoded.alg = "RSA";
      else if (mutation === "kid-dot-segment") decoded.kid = "..";
      else decoded.extra = true;
      header = Buffer.from(JSON.stringify(decoded)).toString("base64");
    }
    expect((await post(fixture.app, value, header)).status).toBe(412);
    expect(fixture.recordReceipt).not.toHaveBeenCalled();
  });
  it.each([
    ["lowercase algorithm", "ecdsa", "sha256"],
    ["EC algorithm", "EC", "sha256"],
    ["uppercase digest", "ECDSA", "SHA256"],
    ["hyphenated digest", "ECDSA", "SHA-256"],
  ])("accepts %s identifiers", async (_label, alg, digest) => {
    const fixture = signedApp();
    const decoded = JSON.parse(Buffer.from(signedHeader(), "base64").toString());
    decoded.alg = alg;
    decoded.digest = digest;
    const response = await post(fixture.app, payload, Buffer.from(JSON.stringify(decoded)).toString("base64"));
    expect(response.status).toBe(200);
    expect(fixture.recordReceipt).toHaveBeenCalledOnce();
  });
  it.each([
    "top",
    "metadata",
    "notification",
    "data",
    "date-only",
    "invalid-date",
    "empty-id",
    "negative-count",
    "unsafe-count",
    "bad-schema",
    "bad-deprecated",
  ])("rejects signed bad payload %s", async (mutation) => {
    const value = structuredClone(payload);
    if (mutation === "top") Object.assign(value, { extra: 1 });
    if (mutation === "metadata") Object.assign(value.metadata, { extra: 1 });
    if (mutation === "notification") Object.assign(value.notification, { extra: 1 });
    if (mutation === "data") Object.assign(value.notification.data, { extra: 1 });
    if (mutation === "date-only") value.notification.eventDate = "2026-10-11";
    if (mutation === "invalid-date") value.notification.publishDate = "2026-02-30T00:00:00Z";
    if (mutation === "empty-id") value.notification.notificationId = "";
    if (mutation === "negative-count") value.notification.publishAttemptCount = -1;
    if (mutation === "unsafe-count") value.notification.publishAttemptCount = Number.MAX_SAFE_INTEGER + 1;
    if (mutation === "bad-schema") value.metadata.schemaVersion = "";
    if (mutation === "bad-deprecated") Object.assign(value.metadata, { deprecated: "false" });
    const fixture = signedApp();
    expect((await post(fixture.app, value)).status).toBe(400);
    expect(fixture.recordReceipt).not.toHaveBeenCalled();
  });
  it("bounds body bytes, rejects non-JSON media and never writes them", async () => {
    const { app, recordReceipt } = signedApp();
    for (const [body, type, status] of [
      ["x".repeat(65537), "application/json", 413],
      ["{}", "text/plain", 415],
      ["{", "application/json", 400],
    ] as const) {
      expect(
        (
          await app.request(path, {
            method: "POST",
            headers: { "content-type": type, "x-ebay-signature": signedHeader() },
            body,
          })
        ).status,
      ).toBe(status);
    }
    expect(recordReceipt).not.toHaveBeenCalled();
    const body = JSON.stringify(payload).padEnd(65536, " ");
    expect(
      (
        await app.request(path, {
          method: "POST",
          headers: { "content-type": "application/json", "x-ebay-signature": signedHeader() },
          body,
        })
      ).status,
    ).toBe(200);
  });
  it("ends a never-completing inbound body at the unchanged five-second deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("{"));
      },
      cancel,
    });
    const fixture = signedApp();
    const response = fixture.app.request(
      new Request("http://localhost" + path, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ebay-signature": signedHeader() },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect((await response).status).toBe(408);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.recordReceipt).not.toHaveBeenCalled();
  });
  it.each(["unavailable", "commit-failure"])("does not acknowledge %s", async (failure) => {
    const { app } = signedApp({
      recordReceipt: async () => {
        if (failure === "commit-failure") throw new Error("synthetic-secret-marker");
        return "unavailable";
      },
    });
    const response = await post(app);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("synthetic-secret-marker");
  });
  it("fails closed for absent deletion or application authority", async () => {
    for (const [configuration, code] of [
      [null, "ebay_account_deletion_not_configured"],
      [
        { endpoint: config.endpoint, verificationToken: config.verificationToken },
        "ebay_account_deletion_key_authority_unavailable",
      ],
    ] as const) {
      const fixture = signedApp({ config: configuration });
      const response = await post(fixture.app);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code } });
      expect(fixture.fetcher).not.toHaveBeenCalled();
      expect(fixture.recordReceipt).not.toHaveBeenCalled();
    }
  });
});
