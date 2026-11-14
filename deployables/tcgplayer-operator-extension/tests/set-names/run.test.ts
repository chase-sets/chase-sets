import { describe, expect, it, vi } from "vitest";
import {
  fetchTcgplayerSetNames,
  TCGPLAYER_SET_NAMES_BODY_CAP_BYTES,
  TCGPLAYER_SET_NAMES_TIMEOUT_MS,
  TCGPLAYER_SET_NAMES_URL,
} from "../../src/tcgplayer-set-name-endpoint";

const entry = (categoryId = 3) => ({
  setNameId: 1,
  categoryId,
  name: "Synthetic Pokemon",
  cleanSetName: "Synthetic Pokemon",
  urlName: "synthetic-pokemon",
  abbreviation: null,
  releaseDate: "2024-02-29T00:00:00",
  isSupplemental: false,
  active: true,
});

describe("SetNames Run endpoint adapter", () => {
  it.each([1, 2, 3, 68])(
    "makes one unchanged credential-free request for selected bound line %s",
    async (productLineId) => {
      const body = { errors: [], results: [entry(productLineId)] };
      const fetcher = vi.fn(
        async () => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
      );
      expect(await fetchTcgplayerSetNames(String(productLineId), fetcher)).toMatchObject({ ok: true, body });
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${TCGPLAYER_SET_NAMES_URL}?categoryId=${productLineId}`, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      });
      expect(TCGPLAYER_SET_NAMES_TIMEOUT_MS).toBe(15_000);
      expect(TCGPLAYER_SET_NAMES_BODY_CAP_BYTES).toBe(4 * 1024 * 1024);
    },
  );
  it("accepts an encoded response exactly at the 4 MiB cap without truncation", async () => {
    const body = { errors: [], results: [entry()] };
    const text = JSON.stringify(body);
    const atCap = text + " ".repeat(TCGPLAYER_SET_NAMES_BODY_CAP_BYTES - new TextEncoder().encode(text).length);
    const fetcher = vi.fn(async () => new Response(atCap, { headers: { "content-type": "application/json" } }));
    expect(await fetchTcgplayerSetNames("3", fetcher)).toMatchObject({
      ok: true,
      bytes: TCGPLAYER_SET_NAMES_BODY_CAP_BYTES,
      body,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("refuses cap plus one and cancels the stream", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(TCGPLAYER_SET_NAMES_BODY_CAP_BYTES + 1));
      },
      cancel,
    });
    const fetcher = vi.fn(async () => new Response(stream, { headers: { "content-type": "application/json" } }));
    expect(await fetchTcgplayerSetNames("3", fetcher)).toMatchObject({
      ok: false,
      code: "body-cap-exceeded",
      body: null,
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("refuses an endless response at the unchanged deadline", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([123]));
        },
      });
      const fetcher = vi.fn(async () => new Response(stream, { headers: { "content-type": "application/json" } }));
      const result = fetchTcgplayerSetNames("3", fetcher);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ ok: false, code: "timeout", body: null });
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
