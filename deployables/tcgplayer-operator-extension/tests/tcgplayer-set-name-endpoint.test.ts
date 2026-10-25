import { describe, expect, it, vi } from "vitest";
import { fetchTcgplayerSetNames, TCGPLAYER_SET_NAMES_URL } from "../src/tcgplayer-set-name-endpoint";

function response(body: string, init: ResponseInit = {}) {
  return new Response(body, { status: 200, headers: { "content-type": "application/json" }, ...init });
}

describe("tcgplayer set-name endpoint", () => {
  it("uses the exact read-only request posture", async () => {
    const fetcher = vi.fn(async () => response('{"errors":[],"results":[]}'));
    await fetchTcgplayerSetNames("3", fetcher);
    expect(fetcher).toHaveBeenCalledWith(`${TCGPLAYER_SET_NAMES_URL}?categoryId=3`, {
      method: "GET",
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
  });

  it("rejects non-digit product line ids without sending", async () => {
    const fetcher = vi.fn();
    await expect(fetchTcgplayerSetNames("3x", fetcher)).resolves.toMatchObject({ code: "invalid-product-line-id" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed when the streamed body reaches cap plus one", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
      },
    });
    const fetcher = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(fetchTcgplayerSetNames("3", fetcher)).resolves.toMatchObject({ code: "body-cap-exceeded" });
  });

  it("aborts an endless body at the fixed timeout", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([123]));
        },
      });
      const fetcher = vi.fn(
        async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
      const result = fetchTcgplayerSetNames("3", fetcher);
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(result).resolves.toMatchObject({ code: "timeout" });
    } finally {
      vi.useRealTimers();
    }
  });
});
