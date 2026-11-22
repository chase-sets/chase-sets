import { describe, expect, it } from "vitest";
import {
  assertRelevanceGate,
  buildRelevanceReport,
  evaluateGoldenQuery,
  renderRelevanceMarkdown,
  summarizeRelevanceMode,
  type GoldenQueryResult,
  type RelevanceMode,
} from "./relevance-evaluation";
import * as relevance from "./relevance-evaluation";

describe("Discovery relevance evaluation", () => {
  it("per-mode acceptance matrix", () => {
    const exact = {
      id: "subtitle",
      query: "Title Subtitle",
      category: "exact" as const,
      coverage: ["title-subtitle"],
      expected: { kind: "items" as const, itemIds: ["expected"] },
    };
    const negative = {
      ...exact,
      id: "extra",
      category: "negative" as const,
      coverage: ["unprotected-extra-term"],
      expected: { kind: "no-results" as const },
    };
    const identifier = { ...exact, coverage: ["protected-identifier"] };
    expect(relevance.relevanceAcceptance("lexical-only", exact)).toBe("gate");
    expect(relevance.relevanceAcceptance("semantic-fallback", exact)).toBe("gate");
    expect(relevance.relevanceAcceptance("lexical-only", negative)).toBe("gate");
    expect(relevance.relevanceAcceptance("semantic-fallback", negative)).toBe("delta");
    expect(relevance.relevanceAcceptance("semantic-fallback", identifier)).toBe("gate");
    const filtered = { ...exact, coverage: ["explicit-filters", "variant-summary"] };
    expect(relevance.relevanceAcceptance("lexical-only", filtered)).toBe("gate");
    expect(relevance.relevanceAcceptance("semantic-fallback", filtered)).toBe("gate");
  });

  it("right IDs wrong summary fails", () => {
    const query = {
      id: "price",
      query: "Expected",
      category: "lexical" as const,
      coverage: ["variant-summary"],
      expected: {
        kind: "items" as const,
        itemIds: ["expected"],
        summaries: { expected: { price: "2.00", currency: "USD", inStock: true, buy: true } },
      },
    };
    expect(
      evaluateGoldenQuery(query, [
        { catalogItemId: "expected", summary: { price: "20.00", currency: "USD", inStock: false, buy: false } },
      ]).passed,
    ).toBe(false);
    expect(
      evaluateGoldenQuery(query, [
        { catalogItemId: "expected", summary: { price: "2.00", currency: "USD", inStock: true, buy: true } },
      ]).passed,
    ).toBe(true);
  });

  it("independent policy removed", () => {
    expect("runInMemoryDiscoveryRelevanceEvaluation" in relevance).toBe(false);
    expect(() =>
      relevance.scoreRankedRelevanceInputs({
        generatedAt: "now",
        sourceHash: "hash",
        embeddingModel: "synthetic",
        dimensions: 1024,
        catalogItemCount: 1,
        goldenQueries: [],
        rankedInputs: {},
      }),
    ).not.toThrow();
  });
  it("requires an exact golden query to return its expected item first", () => {
    const result = evaluateGoldenQuery(
      {
        id: "exact",
        query: "Expected",
        category: "exact",
        coverage: ["en"],
        expected: { kind: "items", itemIds: ["expected"] },
      },
      [{ catalogItemId: "other" }, { catalogItemId: "expected" }],
    );
    expect(result).toMatchObject({ passed: false, exactTop1: false, recallAt10: 1, reciprocalRank: 0.5 });
  });

  it("fails the comparison gate when a lexical baseline gate fails", () => {
    const lexical = mode("lexical-only", [queryResult({ exactTop1: false, passed: false })]);
    const fallback = mode("semantic-fallback", [queryResult({ exactTop1: true })]);
    const report = buildRelevanceReport({
      generatedAt: "2026-07-10T00:00:00.000Z",
      sourceHash: "hash",
      embeddingModel: "deterministic",
      dimensions: 1_024,
      catalogItemCount: 1,
      goldenQueries: [],
      modes: { "lexical-only": lexical, "semantic-fallback": fallback },
    });
    expect(() => assertRelevanceGate(report)).toThrow(/lexical-only\/exact/u);
  });

  it("renders a paste-ready before/after table and semantic gain", () => {
    const lexical = mode("lexical-only", [
      queryResult({ category: "exact", exactTop1: true }),
      queryResult({ id: "semantic", category: "semantic", passed: false, recallAt10: 0, reciprocalRank: 0 }),
    ]);
    const fallback = mode("semantic-fallback", [
      queryResult({ category: "exact", exactTop1: true }),
      queryResult({ id: "semantic", category: "semantic" }),
    ]);
    const report = buildRelevanceReport({
      generatedAt: "2026-07-10T00:00:00.000Z",
      sourceHash: "hash",
      embeddingModel: "deterministic",
      dimensions: 1_024,
      catalogItemCount: 1,
      goldenQueries: [],
      modes: { "lexical-only": lexical, "semantic-fallback": fallback },
    });
    expect(renderRelevanceMarkdown(report)).toContain("| lexical-only |");
    expect(renderRelevanceMarkdown(report)).toContain("Semantic pass-rate gain: +100.0 pp");
  });
});

function queryResult(overrides: Partial<GoldenQueryResult> = {}): GoldenQueryResult {
  return {
    id: "exact",
    query: "Expected",
    category: "exact",
    coverage: ["en"],
    expectedItemIds: ["expected"],
    resultItemIds: ["expected"],
    passed: true,
    recallAt10: 1,
    reciprocalRank: 1,
    exactTop1: true,
    ...overrides,
  };
}

function mode(modeName: RelevanceMode, cases: readonly GoldenQueryResult[]) {
  return summarizeRelevanceMode(modeName, cases);
}
