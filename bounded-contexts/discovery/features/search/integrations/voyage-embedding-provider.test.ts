import { describe, expect, it, vi } from "vitest";
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

    await expect(provider.embed(["Pikachu"], "query")).resolves.toMatchObject({ totalTokens: 3 });
    expect(sleeps).toEqual([2_000]);
    expect(JSON.parse(String(fetchRequest.mock.calls[1]?.[1]?.body))).toMatchObject({ input_type: "query" });
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
