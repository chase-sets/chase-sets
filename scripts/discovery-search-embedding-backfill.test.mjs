import { describe, expect, it, vi } from "vitest";
import {
  parseDiscoveryEmbeddingBackfillOptions,
  runDiscoveryEmbeddingBackfill,
} from "./discovery-search-embedding-backfill.mjs";

const capabilities = {
  extensionVersion: "0.8.1",
  supportsHnsw: true,
  supportsHalfvec: true,
  supportsIterativeIndexScans: true,
};

describe("Discovery search embedding backfill", () => {
  it("defaults to a provider-free dry run with the pinned Voyage 4 Lite price", () => {
    expect(parseDiscoveryEmbeddingBackfillOptions([], {})).toEqual({
      apply: false,
      batchSize: 128,
      maxBatches: Number.POSITIVE_INFINITY,
      model: "voyage-4-lite",
      pricePerMillionTokensUsd: 0.02,
    });
  });

  it("reports item count, token estimate, and cost page-by-page", async () => {
    const estimateBackfillPage = vi
      .fn()
      .mockResolvedValueOnce({
        itemCount: 2,
        estimatedTokens: 1_000,
        estimatedCostUsd: 0.00002,
        lastCatalogItemId: "item-2",
      })
      .mockResolvedValueOnce({
        itemCount: 1,
        estimatedTokens: 500,
        estimatedCostUsd: 0.00001,
        lastCatalogItemId: "item-3",
      });

    const report = await runDiscoveryEmbeddingBackfill(
      {
        inspectVectorCapabilities: async () => capabilities,
        estimateBackfillPage,
      },
      {
        apply: false,
        batchSize: 2,
        maxBatches: Number.POSITIVE_INFINITY,
        model: "voyage-4-lite",
        pricePerMillionTokensUsd: 0.02,
      },
    );

    expect(report).toMatchObject({
      mode: "dry-run",
      itemCount: 3,
      estimatedTokens: 1_500,
      estimatedCostUsd: 0.00003,
    });
    expect(estimateBackfillPage).toHaveBeenNthCalledWith(2, expect.objectContaining({ afterCatalogItemId: "item-2" }));
  });

  it("stops at a bounded checkpoint and reports resumable remaining work", async () => {
    const processNextBatch = vi.fn().mockResolvedValue({ processed: 2, embedded: 2, totalTokens: 20 });
    const report = await runDiscoveryEmbeddingBackfill(
      {
        inspectVectorCapabilities: async () => capabilities,
        processNextBatch,
        estimateBackfillPage: async () => ({ itemCount: 1 }),
      },
      {
        apply: true,
        batchSize: 2,
        maxBatches: 1,
        model: "voyage-4-lite",
        pricePerMillionTokensUsd: 0.02,
      },
    );

    expect(report).toMatchObject({
      mode: "apply",
      batches: 1,
      embedded: 2,
      resumable: true,
      remaining: true,
    });
  });
});
