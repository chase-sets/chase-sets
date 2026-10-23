import { afterEach, describe, expect, it, vi } from "vitest";
import { createEbayDeletionKeyAuthority } from "../api/signature";
import { config, keyFetcher, path, payload, post, signedApp, signedHeader, syntheticKey } from "./signed-fixtures";

afterEach(() => vi.useRealTimers());
describe("ebay-account-deletion-key-bootstrap", () => {
  it.each(["sandbox", "production"] as const)(
    "is lazy, single-flight and uses only the %s deployment host",
    async (environment) => {
      const fetcher = keyFetcher();
      const authority = { ...config.applicationAuthority, environment };
      const { app, recordReceipt } = signedApp({
        config: { ...config, applicationAuthority: authority },
        keyAuthority: createEbayDeletionKeyAuthority(authority, fetcher),
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect((await app.request(path + "?challenge_code=synthetic")).status).toBe(200);
      expect(fetcher).not.toHaveBeenCalled();
      const responses = await Promise.all(Array.from({ length: 8 }, () => post(app)));
      expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
      expect(recordReceipt).toHaveBeenCalledTimes(8);
      expect(fetcher).toHaveBeenCalledTimes(2);
      const host = environment === "production" ? "https://api.ebay.com" : "https://api.sandbox.ebay.com";
      expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
        host + "/identity/v1/oauth2/token",
        host + "/commerce/notification/v1/public_key/synthetic-kid",
      ]);
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        redirect: "error",
        body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
      });
      expect((await post(app)).status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it.each(["mint", "key"])(
    "fails %s closed, emits bounded failure classes and does not cache failure",
    async (stage) => {
      const successful = keyFetcher();
      let fail = true;
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        if (fail && String(url).includes("/oauth2/token") === (stage === "mint"))
          return new Response("synthetic-secret-marker", { status: 403 });
        return successful(url, init);
      });
      const fixture = signedApp({}, fetcher);
      expect((await post(fixture.app)).status).toBe(503);
      expect(fixture.recordReceipt).not.toHaveBeenCalled();
      expect(fixture.record.mock.lastCall?.[0]).toMatchObject({
        tokenMint: stage === "mint" ? "refused" : "succeeded",
        keyFetch: stage === "mint" ? "not-attempted" : "refused",
      });
      fail = false;
      expect((await post(fixture.app)).status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(fixture.record.mock.calls)).not.toMatch(
        /synthetic-(secret|username|eias|notification|access-token)/,
      );
    },
  );
  it("reuses tokens until the refresh margin and expires/evicts bounded keys", async () => {
    const fetcher = keyFetcher();
    let now = 0;
    const { app } = signedApp({
      keyAuthority: createEbayDeletionKeyAuthority(config.applicationAuthority, fetcher, () => now),
    });
    const send = (kid: string) => post(app, payload, signedHeader(payload, 1, kid));
    expect((await send("synthetic-0")).status).toBe(200);
    now = 3_600_000;
    expect((await send("synthetic-0")).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    now = 6_900_000;
    expect((await send("synthetic-1")).status).toBe(200);
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("/oauth2/token"))).toHaveLength(2);
    for (let i = 2; i <= 129; i++) expect((await send(`synthetic-${i}`)).status).toBe(200);
    const before = fetcher.mock.calls.length;
    await send("synthetic-1");
    expect(fetcher).toHaveBeenCalledTimes(before + 1);
  });
  it.each(["mint", "key"])("bounds the complete %s response including stalled bodies", async (stage) => {
    vi.useFakeTimers();
    const good = keyFetcher();
    const cancel = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async (url, init) =>
      String(url).includes("/oauth2/token") === (stage === "mint")
        ? new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("{"));
              },
              cancel,
            }),
          )
        : good(url, init),
    );
    const fixture = signedApp({}, fetcher);
    const response = post(fixture.app);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await response).status).toBe(503);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fixture.recordReceipt).not.toHaveBeenCalled();
  });
  it("bounds a stalled header response without relying on fetch honoring abort", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const fixture = signedApp({}, fetcher);
    const response = post(fixture.app);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await response).status).toBe(503);
    expect(fixture.recordReceipt).not.toHaveBeenCalled();
  });
  it.each(["mint-oversize", "key-oversize", "key-algorithm", "key-digest", "key-invalid", "mint-expiry"])(
    "rejects %s without receipts",
    async (failure) => {
      const good = keyFetcher();
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        const mint = String(url).includes("/oauth2/token");
        if ((failure === "mint-oversize" && mint) || (failure === "key-oversize" && !mint))
          return new Response("x".repeat(65537));
        if (failure === "mint-expiry" && mint)
          return Response.json({ access_token: "synthetic-token", expires_in: -1 });
        if (!mint && failure.startsWith("key-"))
          return Response.json({
            algorithm: failure === "key-algorithm" ? "RSA" : "ECDSA",
            digest: failure === "key-digest" ? "sha1" : "sha256",
            key: failure === "key-invalid" ? "bad" : syntheticKey().publicKey,
          });
        return good(url, init);
      });
      const fixture = signedApp({}, fetcher);
      expect((await post(fixture.app)).status).toBe(503);
      expect(fixture.recordReceipt).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["lowercase algorithm", "ecdsa", "sha256"],
    ["EC algorithm", "EC", "sha256"],
    ["uppercase digest", "ECDSA", "SHA256"],
    ["hyphenated digest", "ECDSA", "SHA-256"],
  ])("accepts %s key identifiers", async (_label, algorithm, digest) => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).includes("/oauth2/token"))
        return Response.json({ access_token: "synthetic-token", expires_in: 7200 });
      return Response.json({ algorithm, digest, key: syntheticKey().publicKey });
    });
    const fixture = signedApp({}, fetcher);
    expect((await post(fixture.app)).status).toBe(200);
    expect(fixture.recordReceipt).toHaveBeenCalledOnce();
  });
});
