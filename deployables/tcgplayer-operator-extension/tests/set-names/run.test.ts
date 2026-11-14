import { describe, expect, it, vi } from "vitest";
import { runTcgplayerSetNames } from "@chase-sets/catalog/client";
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
const counts = { outcome: "recorded" as const, observationCount: 1, newObservationCount: 1, mappingsProposed: 0 };

describe("SetNames Run uses the unchanged endpoint", () => {
  it.each([1, 2, 3, 68])(
    "makes one credential-free bounded request and one post for bound line %s",
    async (productLineId) => {
      const fetcher = vi.fn(
        async () =>
          new Response(JSON.stringify({ errors: [], results: [entry(productLineId)] }), {
            headers: { "content-type": "application/json" },
          }),
      );
      const post = vi.fn(async () => counts);
      expect(
        await runTcgplayerSetNames({
          productLineId,
          environment: "staging",
          request: (id) => fetchTcgplayerSetNames(id, fetcher),
          post,
        }),
      ).toEqual(counts);
      expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${TCGPLAYER_SET_NAMES_URL}?categoryId=${productLineId}`, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      });
      expect(TCGPLAYER_SET_NAMES_TIMEOUT_MS).toBe(15_000);
      expect(TCGPLAYER_SET_NAMES_BODY_CAP_BYTES).toBe(4 * 1024 * 1024);
      expect(post).toHaveBeenCalledOnce();
    },
  );
  it.each([71, 82, 0, NaN])("never requests or posts unbound line %s", async (productLineId) => {
    const request = vi.fn();
    const post = vi.fn();
    expect(await runTcgplayerSetNames({ productLineId, environment: "staging", request, post })).toEqual({
      outcome: "refused",
    });
    expect(request).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
  it("accepts an encoded response exactly at the 4 MiB cap without truncation", async () => {
    const body = JSON.stringify({ errors: [], results: [entry()] });
    const atCap = body + " ".repeat(TCGPLAYER_SET_NAMES_BODY_CAP_BYTES - new TextEncoder().encode(body).length);
    const fetcher = vi.fn(async () => new Response(atCap, { headers: { "content-type": "application/json" } }));
    const post = vi.fn(async () => counts);
    expect(
      await runTcgplayerSetNames({
        productLineId: 3,
        environment: "staging",
        request: (id) => fetchTcgplayerSetNames(id, fetcher),
        post,
      }),
    ).toEqual(counts);
    expect(post).toHaveBeenCalledOnce();
  });
  it("cap plus one is unqualified and never posts", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(TCGPLAYER_SET_NAMES_BODY_CAP_BYTES + 1));
      },
      cancel,
    });
    const fetcher = vi.fn(async () => new Response(stream, { headers: { "content-type": "application/json" } }));
    const post = vi.fn();
    expect(
      await runTcgplayerSetNames({
        productLineId: 3,
        environment: "staging",
        request: (id) => fetchTcgplayerSetNames(id, fetcher),
        post,
      }),
    ).toMatchObject({ outcome: "unqualified" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("an endless response hits the unchanged deadline, is unqualified and never posts", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([123]));
        },
      });
      const fetcher = vi.fn(async () => new Response(stream, { headers: { "content-type": "application/json" } }));
      const post = vi.fn();
      const result = runTcgplayerSetNames({
        productLineId: 3,
        environment: "staging",
        request: (id) => fetchTcgplayerSetNames(id, fetcher),
        post,
      });
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await result).toMatchObject({ outcome: "unqualified" });
      expect(fetcher).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
