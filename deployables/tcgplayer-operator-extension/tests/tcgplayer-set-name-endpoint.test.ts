import { describe, expect, it, vi } from "vitest";
import {
  createTcgplayerSealedFetch,
  fetchTcgplayerSetNames,
  TCGPLAYER_SET_NAMES_URL,
} from "../src/tcgplayer-set-name-endpoint";

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

  it("caps a continuously producing body before the timeout", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const fetcher = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    );
    await expect(fetchTcgplayerSetNames("3", fetcher)).resolves.toMatchObject({ code: "body-cap-exceeded" });
  });
});

describe("sealed search and detail endpoints", () => {
  const search = {
    endpoint: "search" as const,
    productLineId: 1,
    setName: "Synthetic set",
    from: 24,
    includeProductLine: true,
  };
  it("returns only a fixed code when the search fetch rejects, without retrying", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("private diagnostic"));
    await expect(createTcgplayerSealedFetch(fetcher)(search)).resolves.toEqual({
      ok: false,
      status: null,
      contentClass: "unknown",
      bytes: 0,
      body: null,
      code: "network-error",
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://mp-search-api.tcgplayer.com/v1/search/request",
      expect.anything(),
    );
  });

  it("pins exact search body and detail URL, serializes calls and spaces them by at least 1,000 ms", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (response: Response) => void;
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        )
        .mockImplementation(async () => response("{}"));
      const request = createTcgplayerSealedFetch(fetcher);
      const first = request(search);
      const second = request({ endpoint: "detail", productId: 123 });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(fetcher.mock.calls[0]).toEqual([
        "https://mp-search-api.tcgplayer.com/v1/search/request",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: 24,
            size: 24,
            filters: { term: { productLineName: ["Magic"], setName: ["Synthetic set"] } },
            sort: { field: "product-sorting-name", order: "asc" },
          }),
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: expect.any(AbortSignal),
        },
      ]);
      finish(response("{}"));
      await first;
      await vi.advanceTimersByTimeAsync(999);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(fetcher.mock.calls[1]).toEqual([
        "https://mp-search-api.tcgplayer.com/v2/product/123/details",
        { method: "GET", credentials: "omit", redirect: "error", cache: "no-store", signal: expect.any(AbortSignal) },
      ]);
      const fallback = request({ ...search, includeProductLine: false });
      await vi.advanceTimersByTimeAsync(1_000);
      await fallback;
      expect(JSON.parse(String(fetcher.mock.calls[2]![1]!.body)).filters).toEqual({
        term: { setName: ["Synthetic set"] },
      });
      expect(fetcher).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["search", "detail"] as const)("caps and cancels %s cap+1 bodies with one attempt", async (endpoint) => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
        },
        cancel,
      });
      const fetcher = vi.fn(async () => new Response(body, { headers: { "content-type": "application/json" } }));
      const result = await createTcgplayerSealedFetch(fetcher)(
        endpoint === "search" ? search : { endpoint, productId: 1 },
      );
      expect(result).toMatchObject({ ok: false, code: "body-cap-exceeded", bytes: 4 * 1024 * 1024 + 1 });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["search", "detail"] as const)(
    "ends stalled %s bodies at exactly 15,000 ms, never retries",
    async (endpoint) => {
      vi.useFakeTimers();
      try {
        const cancel = vi.fn();
        const fetcher = vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                start(controller) {
                  controller.enqueue(new Uint8Array([123]));
                },
                cancel,
              }),
              { headers: { "content-type": "application/json" } },
            ),
        );
        const pending = createTcgplayerSealedFetch(fetcher)(
          endpoint === "search" ? search : { endpoint, productId: 1 },
        );
        await vi.advanceTimersByTimeAsync(14_999);
        expect(cancel).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toMatchObject({ ok: false, code: "timeout" });
        expect(cancel).toHaveBeenCalledOnce();
        expect(fetcher).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it.each(["search", "detail"] as const)(
    "caps continuously producing %s bodies without waiting for EOF",
    async (endpoint) => {
      const fetcher = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new Uint8Array(1024 * 1024));
              },
            }),
            { headers: { "content-type": "application/json" } },
          ),
      );
      expect(
        await createTcgplayerSealedFetch(fetcher)(endpoint === "search" ? search : { endpoint, productId: 1 }),
      ).toMatchObject({ ok: false, code: "body-cap-exceeded" });
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );
  it("fetches bound Lorcana 71 with a credential-free Disney Lorcana filter", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => response("{}"));
    await expect(createTcgplayerSealedFetch(fetcher)({ ...search, productLineId: 71 })).resolves.toMatchObject({
      ok: true,
    });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://mp-search-api.tcgplayer.com/v1/search/request",
      expect.objectContaining({ method: "POST", credentials: "omit", redirect: "error", cache: "no-store" }),
    );
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body)).filters.term).toEqual({
      productLineName: ["Disney Lorcana"],
      setName: [search.setName],
    });
  });
  it.each([
    { ...search, productLineId: 82 },
    { ...search, from: -1 },
    { ...search, from: 12_000 },
    { ...search, setName: "" },
    { endpoint: "detail", productId: 0 },
    { endpoint: "detail", productId: 2_147_483_648 },
  ])("refuses invalid request %j without fetch", async (request) => {
    const fetcher = vi.fn();
    await createTcgplayerSealedFetch(fetcher)(request as Parameters<ReturnType<typeof createTcgplayerSealedFetch>>[0]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    response("{}", { status: 403 }),
    response("{}", { headers: { "content-type": "text/html" } }),
    response("{}", { headers: { "content-type": "text/notjson" } }),
    response("{}", { headers: { "content-type": "application/notjson" } }),
    response("not-json"),
  ])("rejects HTTP, content-type and JSON bypass mutants", async (body) => {
    const fetcher = vi.fn(async () => body);
    expect((await createTcgplayerSealedFetch(fetcher)(search)).ok).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
