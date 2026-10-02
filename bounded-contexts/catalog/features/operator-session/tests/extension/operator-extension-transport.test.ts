import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createOperatorTransport,
  operatorRequestDeadlineMs,
  operatorResponseByteLimit,
} from "../../domain/extension/transport";
import { syntheticCookie, syntheticGrant } from "./fixture";
const push = {
  expectedRevision: 0,
  value: syntheticCookie,
  observedAt: "2026-10-02T12:00:00.000Z",
  browserExpiresAt: null,
};
afterEach(() => vi.useRealTimers());

describe("operator-extension fixed-origin transport", () => {
  it("omits ambient credentials, rejects redirects, uses exact bearer/path/body and bodyless revoke", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ outcome: "stored", revision: 1 }))
      .mockResolvedValueOnce(Response.json({ outcome: "revoked" }));
    const transport = createOperatorTransport(fetcher);
    expect(await transport.push("production", syntheticGrant, push)).toEqual({ outcome: "stored", revision: 1 });
    await transport.revoke("staging", syntheticGrant);
    expect(fetcher.mock.calls[0]).toEqual([
      "https://admin.chasesets.com/api/public/catalog/operator-session/tcgplayer",
      {
        method: "PUT",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
        headers: { Authorization: `Bearer ${syntheticGrant}`, "Content-Type": "application/json" },
        body: JSON.stringify(push),
      },
    ]);
    expect(fetcher.mock.calls[1]![0]).toBe(
      "https://admin.staging.chasesets.com/api/public/catalog/operator-session/grant",
    );
    expect(fetcher.mock.calls[1]![1]).not.toHaveProperty("body");
  });
  it.each([
    { outcome: "stored", revision: 1.2 },
    { outcome: "stored", revision: "1" },
    { outcome: "stored", revision: -1 },
    { outcome: "stored", revision: Number.MAX_SAFE_INTEGER + 1 },
    { outcome: "stored", revision: 1, cookie: syntheticCookie },
    { outcome: "stored", revision: null },
    { code: "SYNTHETIC_HOSTILE_ERROR" },
  ])("rejects hostile/nonclosed envelopes without echoes: %j", async (body) => {
    const client = createOperatorTransport(async () => Response.json(body));
    expect(await client.push("staging", syntheticGrant, push)).toEqual({ outcome: "invalid-response" });
  });
  it("accepts measured largest-valid envelope with whitespace headroom, refuses cap+1", async () => {
    const largest = JSON.stringify({ outcome: "stale-revision", revision: Number.MAX_SAFE_INTEGER });
    expect(new TextEncoder().encode(largest).byteLength).toBe(56);
    const client = createOperatorTransport(
      async () => new Response(largest.padEnd(operatorResponseByteLimit), { status: 409 }),
    );
    expect(await client.push("staging", syntheticGrant, push)).toEqual({
      outcome: "stale-revision",
      revision: Number.MAX_SAFE_INTEGER,
    });
    const oversized = createOperatorTransport(
      async () => new Response(largest.padEnd(operatorResponseByteLimit + 1), { status: 409 }),
    );
    expect(await oversized.push("staging", syntheticGrant, push)).toEqual({ outcome: "invalid-response" });
  });
  it.each(["fetch", "body"])("bounds endless %s including ignored abort/cancel", async (stage) => {
    vi.useFakeTimers();
    const client = createOperatorTransport(async () =>
      stage === "fetch"
        ? new Promise<Response>(() => undefined)
        : new Response(
            new ReadableStream<Uint8Array>({
              pull: () => new Promise(() => undefined),
              cancel: () => new Promise(() => undefined),
            }),
          ),
    );
    const result = client.push("staging", syntheticGrant, push);
    await vi.advanceTimersByTimeAsync(operatorRequestDeadlineMs);
    expect(await result).toEqual({ outcome: "unavailable" });
  });
  it("never echoes malformed bodies or exception messages", async () => {
    for (const fetcher of [
      async () => new Response("SYNTHETIC_HOSTILE_BODY"),
      async () => {
        throw new Error(syntheticCookie);
      },
    ]) {
      expect(
        JSON.stringify(await createOperatorTransport(fetcher).push("staging", syntheticGrant, push)),
      ).not.toContain("SYNTHETIC");
    }
  });
});
