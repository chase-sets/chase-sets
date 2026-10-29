import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelsApiEnv } from "../../../api";
import { createEbayReceiptStaffRoutes } from "../api/staff-route";
import type { EbayAccountDeletionServices } from "../api/runtime";
import { lookupEbayReceiptsAsService } from "../api/receipt-actor-client";
import { decodeEbayReceiptMatches, ebayReceiptLookupLimits, serializeEbayReceiptMatches } from "../domain/responses";
import { EbayReceiptError } from "../domain/subject";

const largest: unknown = JSON.parse(
  readFileSync(new URL("./fixtures/largest-valid-receipt-lookup.json", import.meta.url), "utf8"),
);
const row = {
  notificationId: "synthetic-notice",
  eventDate: "2026-10-11T00:00:00.000Z",
  expiresAt: "2099-01-01T00:00:00.000Z",
};
const path = "/api/channels/staff/ebay-account-deletion/lookup";
const credential = {
  version: 1,
  token: "synthetic_receipt_actor_01234567890123456789",
  expiresAt: "2099-01-01T00:00:00Z",
} as const;
afterEach(() => vi.useRealTimers());

function routes(value: unknown) {
  const lookup = vi
    .fn<EbayAccountDeletionServices["lookup"]>()
    .mockResolvedValue(value as Awaited<ReturnType<EbayAccountDeletionServices["lookup"]>>);
  const countSubjectData = vi
    .fn<EbayAccountDeletionServices["countSubjectData"]>()
    .mockResolvedValue({ connections: 0, credentialEnvelopes: 0 });
  const services: EbayAccountDeletionServices = {
    lookup,
    countSubjectData,
    recordEbayAccountDeletionReceipt: vi.fn(),
    assertKeyringContinuity: vi.fn(),
  };
  const app = new Hono<ChannelsApiEnv>();
  app.use("*", async (c, next) => {
    c.set("receiptLookupServiceActor", {
      kind: "service",
      serviceId: "staging-ebay-receipt-lookup",
      permissions: ["channels.receipt.lookup"],
    });
    await next();
  });
  app.route("/api/channels", createEbayReceiptStaffRoutes(services));
  const request = (body = JSON.stringify({ userId: "synthetic-subject" })) =>
    app.request(path, { method: "POST", body });
  return { app, lookup, countSubjectData, request };
}

describe("ebay receipt response envelope AC3", () => {
  it("derives the largest-valid fixture fit including the closed envelope", async () => {
    const matches = decodeEbayReceiptMatches(largest);
    expect(matches).toHaveLength(ebayReceiptLookupLimits.maxMatches);
    expect(Buffer.byteLength(JSON.stringify(largest))).toBe(ebayReceiptLookupLimits.maxSerializedUtf8ResponseBytes);
    const response = await routes(matches).request();
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(await response.text())).toBe(65536);
  });
  it.each([
    Array.from({ length: 33 }, () => row),
    Array.from({ length: 32 }, () => ({ ...row, notificationId: '"'.repeat(1024) })),
  ])("rejects cap+1 and UTF-8 serialized oversize before any body emission %#", async (matches) => {
    const response = await routes(matches).request();
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "receipt_response_too_large" });
  });
  it("omits expired receipts without subject/credential markers and rejects recursive closure violations", async () => {
    const expired = { ...row, notificationId: "expired", expiresAt: "2000-01-01T00:00:00Z" };
    expect(JSON.parse(serializeEbayReceiptMatches([expired, row]))).toEqual({ matches: [row] });
    const response = await routes([expired, row]).request();
    expect(await response.json()).toEqual({ matches: [row] });
    const marker = "synthetic-secret-marker";
    for (const value of [
      [{ ...row, token: marker }],
      [{ ...row, notificationId: { nested: marker } }],
      [{ ...row, eventDate: "2026-10-11" }],
      [{ ...row, expiresAt: "2099-02-30T00:00:00Z" }],
    ]) {
      const refusal = await routes(value).request();
      expect(refusal.status).toBe(400);
      expect(await refusal.text()).not.toContain(marker);
    }
  });
  it.each([
    "malformed",
    JSON.stringify({ userId: { nested: "synthetic-secret-marker" } }),
    JSON.stringify({ userId: "synthetic", accountId: "other" }),
  ])("rejects malformed/nested/request-account input without storage %#", async (body) => {
    const h = routes([]);
    h.lookup.mockImplementation(async (userId) => {
      if (typeof userId !== "string") throw new EbayReceiptError("invalid-notice");
      return [];
    });
    const response = await h.request(body);
    expect(response.status).toBe(400);
  });
  it("bounds an unresolved lookup before response emission", async () => {
    vi.useFakeTimers();
    const h = routes([]);
    h.lookup.mockImplementation(() => new Promise(() => {}));
    const pending = h.request();
    await vi.runAllTimersAsync();
    const response = await pending;
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "receipt_lookup_deadline_exceeded" });
  });
  it("denies a service identity without the exact permission and all sibling operations", async () => {
    for (const permissions of [["support.manage"], [], ["channels.receipt.lookup"]]) {
      const h = routes([]);
      const root = new Hono<ChannelsApiEnv>();
      root.use("*", async (c, next) => {
        c.set("receiptLookupServiceActor", { kind: "service", serviceId: "staging-ebay-receipt-lookup", permissions });
        await next();
      });
      // Mount the real route rather than the helper's actor-setting middleware.
      root.route(
        "/api/channels",
        createEbayReceiptStaffRoutes({
          lookup: h.lookup,
          countSubjectData: h.countSubjectData,
          recordEbayAccountDeletionReceipt: vi.fn(),
          assertKeyringContinuity: vi.fn(),
        }),
      );
      const lookup = await root.request(path, { method: "POST", body: JSON.stringify({ userId: "synthetic" }) });
      expect(lookup.status).toBe(permissions.includes("channels.receipt.lookup") ? 200 : 403);
      expect((await root.request("/api/channels/staff/ebay-account-deletion/subject-data-count")).status).toBe(403);
      expect(h.countSubjectData).not.toHaveBeenCalled();
    }
  });
});

describe("receipt actor non-Playwright complete-body client", () => {
  async function realClient(body: string | null) {
    let responseReady: () => void = () => {};
    const ready = new Promise<void>((resolve) => {
      responseReady = resolve;
    });
    const server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.headers.authorization).toBe(`Bearer ${credential.token}`);
      expect(request.headers.cookie).toBeUndefined();
      response.writeHead(200, { "content-type": "application/json" });
      if (body === null) response.write('{"matches":[');
      else response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("loopback-listen-failed");
    const fetcher: typeof fetch = async (_url, init) => {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, init);
      responseReady();
      return response;
    };
    return {
      fetcher,
      ready,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }
  it("reads the real largest-valid body to completion and rejects cap+1 and malformed bodies", async () => {
    for (const [body, status] of [
      [JSON.stringify(largest), 200],
      [" ".repeat(65537), 413],
      [JSON.stringify({ matches: Array.from({ length: 33 }, () => row) }), 413],
      [JSON.stringify({ matches: [{ ...row, expiresAt: "2099-01-01" }] }), 400],
      [JSON.stringify({ matches: [{ ...row, token: { nested: "synthetic-secret-marker" } }] }), 400],
    ] as const) {
      const h = await realClient(body);
      try {
        const result = lookupEbayReceiptsAsService({ credential, userId: "synthetic-subject", fetch: h.fetcher });
        if (status === 200) expect(await result).toHaveLength(32);
        else await expect(result).rejects.toMatchObject({ status });
      } finally {
        await h.close();
      }
    }
  });
  it("aborts an endless real HTTP response after headers, through full-body completion", async () => {
    const h = await realClient(null);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const pending = lookupEbayReceiptsAsService({ credential, userId: "synthetic-subject", fetch: h.fetcher });
      const assertion = expect(pending).rejects.toMatchObject({ status: 408 });
      await h.ready;
      await vi.advanceTimersByTimeAsync(5000);
      await assertion;
    } finally {
      vi.useRealTimers();
      await h.close();
    }
  });
});
