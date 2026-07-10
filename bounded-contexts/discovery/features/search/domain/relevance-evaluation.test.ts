import { describe, expect, it } from "vitest";
import {
  assertRelevanceGate,
  buildRelevanceReport,
  composeRelevanceCandidates,
  evaluateGoldenQuery,
  renderRelevanceMarkdown,
  summarizeRelevanceMode,
  type GoldenQueryResult,
  type RelevanceCandidate,
  type RelevanceMode,
} from "./relevance-evaluation";

const lexicalExpected: RelevanceCandidate = {
  catalogItemId: "expected",
  title: "Expected",
  exactTitleMatch: false,
  lexicalRank: 1,
  semanticRank: null,
  semanticSimilarity: null,
};
const semanticDistractor: RelevanceCandidate = {
  catalogItemId: "distractor",
  title: "Distractor",
  exactTitleMatch: false,
  lexicalRank: null,
  semanticRank: 1,
  semanticSimilarity: 0.99,
};

describe("Discovery relevance evaluation", () => {
  it("keeps lexical candidates ahead of semantic-only candidates in hybrid mode", () => {
    const result = composeRelevanceCandidates("hybrid", [lexicalExpected], [semanticDistractor]);
    expect(result.map((item) => item.catalogItemId)).toEqual(["expected", "distractor"]);
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

  it("fails the comparison gate when hybrid exact top-1 falls below 100%", () => {
    const lexical = mode("lexical-only", [queryResult({ exactTop1: true })]);
    const fallback = mode("semantic-fallback", [queryResult({ exactTop1: true })]);
    const hybrid = mode("hybrid", [queryResult({ exactTop1: false, passed: false })]);
    const report = buildRelevanceReport({
      generatedAt: "2026-07-10T00:00:00.000Z",
      sourceHash: "hash",
      embeddingModel: "deterministic",
      dimensions: 1_024,
      catalogItemCount: 1,
      goldenQueries: [],
      modes: { "lexical-only": lexical, "semantic-fallback": fallback, hybrid },
    });
    expect(() => assertRelevanceGate(report)).toThrow(/exact-match top-1/u);
  });

  it("renders a paste-ready before/after table and semantic gain", () => {
    const lexical = mode("lexical-only", [
      queryResult({ category: "exact", exactTop1: true }),
      queryResult({ id: "semantic", category: "semantic", passed: false, recallAt10: 0, reciprocalRank: 0 }),
    ]);
    const hybrid = mode("hybrid", [
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
      modes: { "lexical-only": lexical, "semantic-fallback": lexical, hybrid },
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
