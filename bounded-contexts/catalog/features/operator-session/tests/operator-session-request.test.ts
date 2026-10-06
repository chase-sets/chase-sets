import { afterEach, describe, expect, it, vi } from "vitest";
import { readGrantBearer, readPushRequest, requireEmptyBody } from "../api/request";

const input = {
  expectedRevision: 0,
  value: "synthetic-cookie",
  observedAt: "2026-10-01T00:00:00.000Z",
  browserExpiresAt: null,
};
const request = (body: unknown) =>
  new Request("https://admin.example/tcgplayer", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
afterEach(() => vi.useRealTimers());

describe("operator session closed requests", () => {
  it("accepts the maximum cookie and revision without coercion", async () => {
    const largest = { ...input, value: "x".repeat(4096), expectedRevision: Number.MAX_SAFE_INTEGER };
    expect(await readPushRequest(request(largest))).toEqual(largest);
  });
  it.each([
    null,
    [],
    {},
    { ...input, token: "hostile-bearer" },
    { ...input, expectedRevision: "0" },
    { ...input, expectedRevision: -1 },
    { ...input, expectedRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...input, observedAt: "2026-02-30T00:00:00Z" },
    { ...input, observedAt: "2026-10-01T00:00:00+00:00" },
    { ...input, browserExpiresAt: 0 },
    { ...input, value: 12 },
  ])("rejects malformed input %#", async (body) => {
    await expect(readPushRequest(request(body))).rejects.toMatchObject({ code: "invalid-request", status: 400 });
  });
  it.each(["", "x".repeat(4097), "cookie;secret", "a b", "a\nb", "é"])(
    "rejects invalid cookie octets %#",
    async (value) => {
      await expect(readPushRequest(request({ ...input, value }))).rejects.toMatchObject({
        code: "invalid-session-value",
        status: 422,
      });
    },
  );
  it("requires JSON and a canonical bearer, not cookie/query credentials", async () => {
    await expect(
      readPushRequest(new Request("https://admin.example", { method: "PUT", body: "{}" })),
    ).rejects.toMatchObject({ code: "unsupported-media-type", status: 415 });
    for (const authorization of [
      "",
      "bearer " + "x".repeat(43),
      "Bearer short",
      "Bearer " + "x".repeat(44),
      "Bearer " + "x".repeat(42) + "=",
    ]) {
      expect(() =>
        readGrantBearer(
          new Request("https://admin.example?token=ignored", { headers: { authorization, cookie: "token=ignored" } }),
        ),
      ).toThrow("grant-invalid");
    }
    expect(
      readGrantBearer(new Request("https://admin.example", { headers: { authorization: "Bearer " + "x".repeat(43) } })),
    ).toBe("x".repeat(43));
  });
  it("cancels a chunked cap+1 body despite an understated Content-Length", async () => {
    const cancel = vi.fn();
    let chunks = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(++chunks === 1 ? 8192 : 1).fill(32));
      },
      cancel,
    });
    const init = {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": "1" },
      body,
      duplex: "half",
    };
    const req = new Request("https://admin.example", init);
    await expect(readPushRequest(req)).rejects.toMatchObject({ code: "request-too-large", status: 413 });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it.each(["push", "empty"])("cancels an endless %s body at five seconds", async (kind) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const init = { method: "PUT", headers: { "content-type": "application/json" }, body, duplex: "half" };
    const req = new Request("https://admin.example", init);
    const result = expect(kind === "push" ? readPushRequest(req) : requireEmptyBody(req)).rejects.toMatchObject({
      code: "request-timeout",
      status: 408,
    });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it("refuses nonempty mutation bodies and accepts absent bodies", async () => {
    await expect(
      requireEmptyBody(new Request("https://admin.example", { method: "DELETE", body: "{}" })),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await expect(requireEmptyBody(new Request("https://admin.example", { method: "DELETE" }))).resolves.toBeUndefined();
  });
  it("releases the reader after success and invalid UTF-8, even when cancellation never settles", async () => {
    const success = request(input);
    expect(await readPushRequest(success)).toEqual(input);
    expect(success.body!.locked).toBe(false);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array([255]));
        c.close();
      },
    });
    const init = { method: "PUT", headers: { "content-type": "application/json" }, body, duplex: "half" };
    await expect(readPushRequest(new Request("https://admin.example", init))).rejects.toMatchObject({
      code: "invalid-request",
    });
    expect(body.locked).toBe(false);
    vi.useFakeTimers();
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const endless = new ReadableStream<Uint8Array>({ cancel });
    const pending = expect(
      readPushRequest(new Request("https://admin.example", { ...init, body: endless })),
    ).rejects.toMatchObject({ code: "request-timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(endless.locked).toBe(false);
  });
});
