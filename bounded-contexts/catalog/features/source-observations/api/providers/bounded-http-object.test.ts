import { afterEach, describe, expect, it, vi } from "vitest";

import { BoundedHttpObjectError, readBoundedHttpObject } from "./bounded-http-object";

afterEach(() => {
  vi.useRealTimers();
});

describe("readBoundedHttpObject", () => {
  it("consumes the largest valid streamed response completely", async () => {
    const fetcher = vi.fn(async () =>
      responseFromChunks(
        [
          [1, 2],
          [3, 4],
        ],
        { "content-length": "4" },
      ),
    );

    await expect(read(fetcher, 4)).resolves.toMatchObject({
      body: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
    });
  });

  it.each([
    ["declared", async () => new Response(new Uint8Array([1]), { headers: { "content-length": "5" } })],
    [
      "streamed",
      async () =>
        responseFromChunks([
          [1, 2, 3],
          [4, 5],
        ]),
    ],
  ])("rejects a %s cap-plus-one response with a safe code", async (_label, fetcher) => {
    await expect(read(fetcher, 4)).rejects.toMatchObject({
      name: "BoundedHttpObjectError",
      code: "response-too-large",
      message: "response-too-large",
    });
  });

  it("actively times out a partial response whose body never completes", async () => {
    vi.useFakeTimers();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
    });
    const result = read(async () => new Response(body), 4, 25);
    const expectation = expect(result).rejects.toMatchObject({
      name: "BoundedHttpObjectError",
      code: "deadline-exceeded",
    });
    await vi.advanceTimersByTimeAsync(26);

    await expectation;
  });

  it("never copies a secret-bearing URL or provider exception into its error", async () => {
    const secret = "token-super-secret-value";
    const result = read(
      async () => {
        throw new Error(`provider body and credential ${secret}`);
      },
      4,
      25,
      `https://user:${secret}@objects.example.invalid/manifest.json?token=${secret}`,
    );

    await expect(result).rejects.toEqual(new BoundedHttpObjectError("transport-failed"));
    await expect(result.catch((error: unknown) => String(error))).resolves.not.toContain(secret);
  });
});

function read(
  fetcher: typeof globalThis.fetch,
  maxBytes: number,
  deadlineMs = 1_000,
  url = "https://objects.example.invalid/object",
) {
  return readBoundedHttpObject({
    fetch: fetcher,
    url,
    maxBytes,
    deadlineMs,
    accept: "image/*",
  });
}

function responseFromChunks(chunks: readonly (readonly number[])[], headers: HeadersInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(new Uint8Array(chunk));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "image/png", ...headers } },
  );
}
