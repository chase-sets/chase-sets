import { describe, expect, it } from "vitest";
import {
  collectPlanIndexNames,
  parseHybridRetrievalBenchmarkOptions,
  percentile,
} from "./benchmark-discovery-hybrid-retrieval.mjs";

describe("Discovery hybrid retrieval benchmark", () => {
  it("defaults to the acceptance-scale 100k-row sample", () => {
    expect(parseHybridRetrievalBenchmarkOptions([])).toEqual({ rowCount: 100_000, samples: 30, warmups: 5 });
    expect(parseHybridRetrievalBenchmarkOptions(["--rows=10", "--samples=3", "--warmups=1"])).toEqual({
      rowCount: 10,
      samples: 3,
      warmups: 1,
    });
  });

  it("calculates p95 and finds nested plan indexes", () => {
    expect(
      percentile(
        Array.from({ length: 100 }, (_, index) => index + 1),
        0.95,
      ),
    ).toBe(95);
    expect([
      ...collectPlanIndexNames([{ Plan: { "Index Name": "discovery_hybrid_benchmark_embedding_hnsw_idx" } }]),
    ]).toEqual(["discovery_hybrid_benchmark_embedding_hnsw_idx"]);
  });
});
