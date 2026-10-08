import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VOYAGE_EMBEDDING_DIMENSIONS,
  VoyageEmbeddingProviderError,
  createVoyageEmbeddingProvider,
} from "./voyage-embedding-provider";

function vector(first = 1, second = 0): number[] {
  return [first, second, ...Array.from({ length: VOYAGE_EMBEDDING_DIMENSIONS - 2 }, () => 0)];
}

function successResponse(count: number, embedding = vector()): Response {
  return Response.json({
    data: Array.from({ length: count }, (_, index) => ({ index, embedding })),
    usage: { total_tokens: count * 3 },
  });
}

describe("Voyage embedding provider", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["fetch", "body"])("online deadline aborts fetch/body without retry: pending %s", async (phase) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchRequest = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal ?? undefined;
      if (phase === "fetch") return new Promise<Response>(() => {});
      const response = successResponse(1);
      vi.spyOn(response, "json").mockImplementation(() => new Promise(() => {}));
      return response;
    });
    const sleep = vi.fn();
    const provider = createVoyageEmbeddingProvider({
      apiKey: "fake-key",
      fetch: fetchRequest,
      sleep,
      timeoutMs: 1,
      maxAttempts: 9,
    });
    const result = provider
      .embed(["query"], "query", { timeoutMs: 800, maxAttempts: 1 })
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(799);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ kind: "timeout" });
    expect(signal?.aborted).toBe(true);
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("online one-attempt policy never sleeps on a long Retry-After", async () => {
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
    const sleep = vi.fn();
    const provider = createVoyageEmbeddingProvider({ apiKey: "fake-key", fetch: fetchRequest, sleep });
    await expect(provider.embed(["query"], "query", { timeoutMs: 800, maxAttempts: 1 })).rejects.toMatchObject({
      kind: "rate-limit",
    });
    expect(fetchRequest).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    await expect(provider.embed(["document"], "document")).rejects.toMatchObject({ kind: "rate-limit" });
    expect(fetchRequest).toHaveBeenCalledTimes(5);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(3_600_000, undefined);
  });

  it("does not fetch or retry a pre-aborted request", async () => {
    const fetchRequest = vi.fn<typeof fetch>();
    const provider = createVoyageEmbeddingProvider({ apiKey: "fake-key", fetch: fetchRequest });
    await expect(provider.embed(["query"], "query", { signal: AbortSignal.abort() })).rejects.toMatchObject({
      kind: "timeout",
      retryable: false,
    });
    expect(fetchRequest).not.toHaveBeenCalled();
  });
  it("batches at 128, always sends input_type, and normalizes vectors", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchRequest = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return successResponse((body.input as string[]).length, vector(3, 4));
    });
    const provider = createVoyageEmbeddingProvider({ apiKey: "voyage-test", fetch: fetchRequest });

    const result = await provider.embed(
      Array.from({ length: 129 }, (_, index) => `item-${index}`),
      "document",
    );

    expect(fetchRequest).toHaveBeenCalledTimes(2);
    expect(bodies.map((body) => (body.input as string[]).length)).toEqual([128, 1]);
    expect(bodies.every((body) => body.input_type === "document")).toBe(true);
    expect(bodies.every((body) => body.output_dimension === 1_024)).toBe(true);
    expect(result.vectors[0]?.[0]).toBeCloseTo(0.6);
    expect(result.vectors[0]?.[1]).toBeCloseTo(0.8);
    expect(result.totalTokens).toBe(387);
  });

  it("honors Retry-After for rate limits before retrying", async () => {
    const sleeps: number[] = [];
    const fetchRequest = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { "retry-after": "2" } }))
      .mockResolvedValueOnce(successResponse(1));
    const provider = createVoyageEmbeddingProvider({
      apiKey: "voyage-test",
      fetch: fetchRequest,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });

    await expect(provider.embed(["Pikachu"], "document")).resolves.toMatchObject({ totalTokens: 3 });
    expect(sleeps).toEqual([2_000]);
    expect(JSON.parse(String(fetchRequest.mock.calls[1]?.[1]?.body))).toMatchObject({ input_type: "document" });
  });

  it("returns a typed non-retryable authentication error", async () => {
    const provider = createVoyageEmbeddingProvider({
      apiKey: "bad",
      fetch: async () => new Response(null, { status: 401 }),
    });

    const error = await provider.embed(["Pikachu"], "document").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VoyageEmbeddingProviderError);
    expect(error).toMatchObject({ kind: "authentication", retryable: false, status: 401 });
  });
});
