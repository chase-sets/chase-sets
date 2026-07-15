import { foldSearchDiacritics } from "./normalization";

export const RELEVANCE_RESULT_LIMIT = 10;
export const RELEVANCE_CATEGORIES = ["exact", "lexical", "semantic", "negative"] as const;
export const RELEVANCE_MODES = ["lexical-only", "semantic-fallback", "hybrid"] as const;

export type RelevanceCategory = (typeof RELEVANCE_CATEGORIES)[number];
export type RelevanceMode = (typeof RELEVANCE_MODES)[number];
export type GoldenQuery = Readonly<{
  id: string;
  query: string;
  category: RelevanceCategory;
  coverage: readonly string[];
  expected: Readonly<{ kind: "items"; itemIds: readonly string[] }> | Readonly<{ kind: "no-results" }>;
}>;
export type RelevanceCandidate = Readonly<{
  catalogItemId: string;
  title: string;
  exactTitleMatch: boolean;
  lexicalRank: number | null;
  semanticRank: number | null;
  semanticSimilarity: number | null;
}>;
export type GoldenQueryResult = Readonly<{
  id: string;
  query: string;
  category: RelevanceCategory;
  coverage: readonly string[];
  expectedItemIds: readonly string[];
  resultItemIds: readonly string[];
  passed: boolean;
  recallAt10: number | null;
  reciprocalRank: number | null;
  exactTop1: boolean | null;
}>;
export type RelevanceMetrics = Readonly<{
  caseCount: number;
  passRate: number;
  recallAt10: number | null;
  meanReciprocalRank: number | null;
  exactTop1Rate: number | null;
}>;
export type RelevanceModeReport = Readonly<{
  mode: RelevanceMode;
  overall: RelevanceMetrics;
  categories: Readonly<Record<RelevanceCategory, RelevanceMetrics>>;
  cases: readonly GoldenQueryResult[];
}>;
export type RelevanceReport = Readonly<{
  schemaVersion: 1;
  generatedAt: string;
  fixture: Readonly<{
    sourceHash: string;
    embeddingModel: string;
    dimensions: number;
    catalogItemCount: number;
    goldenQueryCount: number;
    coverage: readonly string[];
  }>;
  modes: Readonly<Record<RelevanceMode, RelevanceModeReport>>;
  comparison: Readonly<{
    exactTop1Protected: boolean;
    exactAndLexicalRegressions: readonly string[];
    semanticPassRateGain: number;
    semanticRecallAt10Gain: number;
    semanticMrrGain: number;
    passed: boolean;
  }>;
}>;

export type InMemoryRelevanceCatalogItem = Readonly<{
  catalogItemId: string;
  title: string;
  subtitle: string;
  description: string;
  aliases: readonly string[];
  categories: readonly string[];
  tags: readonly string[];
}>;

export type InMemoryRelevanceEmbeddingFixture = Readonly<{
  model: string;
  dimensions: number;
  sourceHash: string;
  documents: Readonly<Record<string, readonly (readonly [number, number])[]>>;
  queries: Readonly<Record<string, readonly (readonly [number, number])[]>>;
}>;

export function composeRelevanceCandidates(
  mode: RelevanceMode,
  lexicalCandidates: readonly RelevanceCandidate[],
  semanticCandidates: readonly RelevanceCandidate[],
  limit = RELEVANCE_RESULT_LIMIT,
): RelevanceCandidate[] {
  if (mode === "lexical-only") return lexicalCandidates.slice(0, limit);
  if (mode === "semantic-fallback") {
    return (lexicalCandidates.length > 0 ? lexicalCandidates : semanticCandidates).slice(0, limit);
  }

  const combined = new Map<string, RelevanceCandidate>();
  for (const candidate of [...lexicalCandidates, ...semanticCandidates]) {
    const previous = combined.get(candidate.catalogItemId);
    combined.set(candidate.catalogItemId, {
      ...candidate,
      exactTitleMatch: candidate.exactTitleMatch || previous?.exactTitleMatch === true,
      lexicalRank: candidate.lexicalRank ?? previous?.lexicalRank ?? null,
      semanticRank: candidate.semanticRank ?? previous?.semanticRank ?? null,
      semanticSimilarity: candidate.semanticSimilarity ?? previous?.semanticSimilarity ?? null,
    });
  }

  return [...combined.values()]
    .sort((left, right) => {
      if (left.exactTitleMatch !== right.exactTitleMatch) return left.exactTitleMatch ? -1 : 1;
      const leftLexical = left.lexicalRank !== null;
      const rightLexical = right.lexicalRank !== null;
      if (leftLexical !== rightLexical) return leftLexical ? -1 : 1;
      const scoreDifference = reciprocalRankFusionScore(right) - reciprocalRankFusionScore(left);
      return (
        scoreDifference ||
        left.title.localeCompare(right.title, "en") ||
        left.catalogItemId.localeCompare(right.catalogItemId)
      );
    })
    .slice(0, limit);
}

export function runInMemoryDiscoveryRelevanceEvaluation(
  input: Readonly<{
    catalogItems: readonly InMemoryRelevanceCatalogItem[];
    goldenQueries: readonly GoldenQuery[];
    embeddingFixture: InMemoryRelevanceEmbeddingFixture;
    generatedAt: string;
  }>,
): RelevanceReport {
  const cases = Object.fromEntries(RELEVANCE_MODES.map((mode) => [mode, [] as GoldenQueryResult[]])) as Record<
    RelevanceMode,
    GoldenQueryResult[]
  >;

  for (const goldenQuery of input.goldenQueries) {
    const queryEmbedding = input.embeddingFixture.queries[goldenQuery.id];
    if (!queryEmbedding) throw new Error(`Missing query embedding for '${goldenQuery.id}'.`);
    const lexical = input.catalogItems
      .filter((item) => inMemoryLexicalMatch(goldenQuery.query, item))
      .sort((left, right) => {
        const leftExact = exactTitle(left.title, goldenQuery.query);
        const rightExact = exactTitle(right.title, goldenQuery.query);
        return Number(rightExact) - Number(leftExact) || left.title.localeCompare(right.title, "en");
      })
      .map(
        (item, index): RelevanceCandidate => ({
          catalogItemId: item.catalogItemId,
          title: item.title,
          exactTitleMatch: exactTitle(item.title, goldenQuery.query),
          lexicalRank: index + 1,
          semanticRank: null,
          semanticSimilarity: null,
        }),
      );
    const semantic = input.catalogItems
      .map((item) => ({
        item,
        similarity: sparseDotProduct(input.embeddingFixture.documents[item.catalogItemId] ?? [], queryEmbedding),
      }))
      .filter((candidate) => candidate.similarity >= 0.52)
      .sort(
        (left, right) => right.similarity - left.similarity || left.item.title.localeCompare(right.item.title, "en"),
      )
      .map(
        (candidate, index): RelevanceCandidate => ({
          catalogItemId: candidate.item.catalogItemId,
          title: candidate.item.title,
          exactTitleMatch: exactTitle(candidate.item.title, goldenQuery.query),
          lexicalRank: null,
          semanticRank: index + 1,
          semanticSimilarity: candidate.similarity,
        }),
      );

    for (const mode of RELEVANCE_MODES) {
      cases[mode].push(evaluateGoldenQuery(goldenQuery, composeRelevanceCandidates(mode, lexical, semantic)));
    }
  }

  const modes = Object.fromEntries(
    RELEVANCE_MODES.map((mode) => [mode, summarizeRelevanceMode(mode, cases[mode])]),
  ) as Record<RelevanceMode, RelevanceModeReport>;
  return buildRelevanceReport({
    generatedAt: input.generatedAt,
    sourceHash: input.embeddingFixture.sourceHash,
    embeddingModel: input.embeddingFixture.model,
    dimensions: input.embeddingFixture.dimensions,
    catalogItemCount: input.catalogItems.length,
    goldenQueries: input.goldenQueries,
    modes,
  });
}

export function evaluateGoldenQuery(
  goldenQuery: GoldenQuery,
  candidates: readonly Pick<RelevanceCandidate, "catalogItemId">[],
): GoldenQueryResult {
  const resultItemIds = candidates.slice(0, RELEVANCE_RESULT_LIMIT).map((candidate) => candidate.catalogItemId);
  if (goldenQuery.expected.kind === "no-results") {
    return {
      id: goldenQuery.id,
      query: goldenQuery.query,
      category: goldenQuery.category,
      coverage: goldenQuery.coverage,
      expectedItemIds: [],
      resultItemIds,
      passed: resultItemIds.length === 0,
      recallAt10: null,
      reciprocalRank: null,
      exactTop1: null,
    };
  }

  const expected = goldenQuery.expected.itemIds;
  const found = expected.filter((itemId) => resultItemIds.includes(itemId));
  const firstRelevantRank = resultItemIds.findIndex((itemId) => expected.includes(itemId));
  const exactTop1 = goldenQuery.category === "exact" ? resultItemIds[0] === expected[0] : null;
  return {
    id: goldenQuery.id,
    query: goldenQuery.query,
    category: goldenQuery.category,
    coverage: goldenQuery.coverage,
    expectedItemIds: expected,
    resultItemIds,
    passed: found.length === expected.length && exactTop1 !== false,
    recallAt10: expected.length === 0 ? null : found.length / expected.length,
    reciprocalRank: firstRelevantRank === -1 ? 0 : 1 / (firstRelevantRank + 1),
    exactTop1,
  };
}

export function summarizeRelevanceMode(mode: RelevanceMode, cases: readonly GoldenQueryResult[]): RelevanceModeReport {
  const categories = Object.fromEntries(
    RELEVANCE_CATEGORIES.map((category) => [
      category,
      calculateMetrics(cases.filter((item) => item.category === category)),
    ]),
  ) as Record<RelevanceCategory, RelevanceMetrics>;
  return { mode, overall: calculateMetrics(cases), categories, cases };
}

export function buildRelevanceReport(
  input: Readonly<{
    generatedAt: string;
    sourceHash: string;
    embeddingModel: string;
    dimensions: number;
    catalogItemCount: number;
    goldenQueries: readonly GoldenQuery[];
    modes: Readonly<Record<RelevanceMode, RelevanceModeReport>>;
  }>,
): RelevanceReport {
  const baseline = input.modes["lexical-only"];
  const hybrid = input.modes.hybrid;
  const regressions: string[] = [];
  for (const category of ["exact", "lexical"] as const) {
    compareMetric(
      regressions,
      category,
      "passRate",
      baseline.categories[category].passRate,
      hybrid.categories[category].passRate,
    );
    compareMetric(
      regressions,
      category,
      "recallAt10",
      baseline.categories[category].recallAt10,
      hybrid.categories[category].recallAt10,
    );
    compareMetric(
      regressions,
      category,
      "meanReciprocalRank",
      baseline.categories[category].meanReciprocalRank,
      hybrid.categories[category].meanReciprocalRank,
    );
  }
  const exactTop1Protected = hybrid.categories.exact.exactTop1Rate === 1;
  const semanticBaseline = baseline.categories.semantic;
  const semanticHybrid = hybrid.categories.semantic;
  const comparison = {
    exactTop1Protected,
    exactAndLexicalRegressions: regressions,
    semanticPassRateGain: semanticHybrid.passRate - semanticBaseline.passRate,
    semanticRecallAt10Gain: nullableDifference(semanticHybrid.recallAt10, semanticBaseline.recallAt10),
    semanticMrrGain: nullableDifference(semanticHybrid.meanReciprocalRank, semanticBaseline.meanReciprocalRank),
    passed: exactTop1Protected && regressions.length === 0,
  };
  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    fixture: {
      sourceHash: input.sourceHash,
      embeddingModel: input.embeddingModel,
      dimensions: input.dimensions,
      catalogItemCount: input.catalogItemCount,
      goldenQueryCount: input.goldenQueries.length,
      coverage: [...new Set(input.goldenQueries.flatMap((item) => item.coverage))].sort(),
    },
    modes: input.modes,
    comparison,
  };
}

export function assertRelevanceGate(report: RelevanceReport): void {
  if (!report.comparison.passed) {
    const violations = [
      ...(report.comparison.exactTop1Protected ? [] : ["hybrid exact-match top-1 was below 100%"]),
      ...report.comparison.exactAndLexicalRegressions,
    ];
    throw new Error(`Discovery relevance gate failed: ${violations.join("; ")}.`);
  }
}

export function renderRelevanceMarkdown(report: RelevanceReport): string {
  const rows = RELEVANCE_MODES.map((mode) => {
    const current = report.modes[mode];
    return `| ${mode} | ${percent(current.overall.passRate)} | ${metric(current.overall.recallAt10)} | ${metric(current.overall.meanReciprocalRank)} | ${percent(current.categories.exact.exactTop1Rate)} | ${percent(current.categories.lexical.passRate)} | ${percent(current.categories.semantic.passRate)} | ${percent(current.categories.negative.passRate)} |`;
  });
  return [
    "# Discovery Search Relevance",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Fixture: ${report.fixture.catalogItemCount} catalog items, ${report.fixture.goldenQueryCount} golden queries, \`${report.fixture.embeddingModel}\` deterministic embeddings.`,
    "",
    "## Lexical baseline vs candidate modes",
    "",
    "| Mode | Overall pass | Recall@10 | MRR | Exact top-1 | Lexical pass | Semantic pass | Negative pass |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "## Rollout gate",
    "",
    `- Result: **${report.comparison.passed ? "PASS" : "FAIL"}**`,
    `- Hybrid exact-title top-1 protected: ${report.comparison.exactTop1Protected ? "yes (100%)" : "no"}`,
    `- Exact/lexical regressions: ${report.comparison.exactAndLexicalRegressions.length === 0 ? "none" : report.comparison.exactAndLexicalRegressions.join("; ")}`,
    `- Semantic pass-rate gain: ${signedPercent(report.comparison.semanticPassRateGain)}`,
    `- Semantic recall@10 gain: ${signedMetric(report.comparison.semanticRecallAt10Gain)}`,
    `- Semantic MRR gain: ${signedMetric(report.comparison.semanticMrrGain)}`,
    "",
  ].join("\n");
}

function reciprocalRankFusionScore(candidate: RelevanceCandidate): number {
  return (
    (candidate.lexicalRank === null ? 0 : 0.7 / (60 + candidate.lexicalRank)) +
    (candidate.semanticRank === null ? 0 : 0.3 / (60 + candidate.semanticRank))
  );
}

function inMemoryLexicalMatch(query: string, item: InMemoryRelevanceCatalogItem): boolean {
  const normalizedQuery = normalizeLexicalText(query);
  const searchable = normalizeLexicalText(
    [item.title, item.subtitle, ...item.aliases, ...item.categories, ...item.tags, item.description].join(" "),
  );
  const tokens = normalizedQuery.split(" ").filter(Boolean);
  return (
    Boolean(normalizedQuery) &&
    (searchable.includes(normalizedQuery) || tokens.every((token) => searchable.includes(token)))
  );
}

function normalizeLexicalText(value: string): string {
  return foldSearchDiacritics(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function exactTitle(title: string, query: string): boolean {
  return foldSearchDiacritics(title.trim()).toLowerCase() === foldSearchDiacritics(query.trim()).toLowerCase();
}

function sparseDotProduct(
  left: readonly (readonly [number, number])[],
  right: readonly (readonly [number, number])[],
): number {
  const leftValues = new Map(left);
  return right.reduce((sum, [index, value]) => sum + (leftValues.get(index) ?? 0) * value, 0);
}

function calculateMetrics(cases: readonly GoldenQueryResult[]): RelevanceMetrics {
  const positive = cases.filter((item) => item.recallAt10 !== null);
  const exact = cases.filter((item) => item.exactTop1 !== null);
  return {
    caseCount: cases.length,
    passRate: cases.length === 0 ? 0 : cases.filter((item) => item.passed).length / cases.length,
    recallAt10: average(positive.map((item) => item.recallAt10 as number)),
    meanReciprocalRank: average(positive.map((item) => item.reciprocalRank as number)),
    exactTop1Rate: average(exact.map((item) => (item.exactTop1 ? 1 : 0))),
  };
}

function average(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareMetric(
  regressions: string[],
  category: "exact" | "lexical",
  metricName: string,
  baseline: number | null,
  candidate: number | null,
): void {
  if (baseline !== null && (candidate === null || candidate + Number.EPSILON < baseline)) {
    regressions.push(
      `hybrid ${category} ${metricName} regressed from ${baseline.toFixed(4)} to ${candidate?.toFixed(4) ?? "n/a"}`,
    );
  }
}

function nullableDifference(value: number | null, baseline: number | null): number {
  return (value ?? 0) - (baseline ?? 0);
}

function percent(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function metric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(3);
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)} pp`;
}

function signedMetric(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(3)}`;
}
