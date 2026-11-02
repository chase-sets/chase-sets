export const RELEVANCE_RESULT_LIMIT = 10;
export const RELEVANCE_CATEGORIES = ["exact", "lexical", "semantic", "negative"] as const;
export const RELEVANCE_MODES = ["lexical-only", "semantic-fallback", "hybrid"] as const;

export type RelevanceCategory = (typeof RELEVANCE_CATEGORIES)[number];
export type RelevanceMode = (typeof RELEVANCE_MODES)[number];
export type RelevanceSummary = Readonly<{
  price: string | null;
  currency: string | null;
  inStock: boolean;
  buy: boolean;
}>;
export type RankedRelevanceItem = Readonly<{ catalogItemId: string; summary?: RelevanceSummary | null }>;
export type GoldenQuery = Readonly<{
  id: string;
  query: string;
  effectiveQueries?: readonly string[];
  scenario?: "provider-failure";
  category: RelevanceCategory;
  coverage: readonly string[];
  request?: Readonly<{
    language?: string;
    inStock?: boolean;
    priceMin?: string;
    priceMax?: string;
    sort?: "relevance" | "title_asc" | "title_desc" | "newest" | "price_asc" | "price_desc";
    dimensionFilters?: readonly Readonly<{ dimensionId: string; optionId: string }>[];
  }>;
  expected:
    | Readonly<{
        kind: "items";
        itemIds: readonly string[];
        summaries?: Readonly<Record<string, RelevanceSummary | null>>;
      }>
    | Readonly<{ kind: "no-results" }>;
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
  request?: GoldenQuery["request"];
  requiresSummary?: boolean;
  resultItemIds: readonly string[];
  passed: boolean;
  recallAt10: number | null;
  reciprocalRank: number | null;
  exactTop1: boolean | null;
  summaryFailures?: readonly string[];
  acceptance?: "gate" | "delta";
  total?: number | null;
  interpretation?: unknown;
  summaries?: readonly RankedRelevanceItem[];
  live?: Readonly<{
    retrievalMode: string;
    interpretation: unknown;
    total: number | null;
    facets: unknown;
    categoryCounts: unknown;
    lexicalCount: number | null;
    providerCalls: number;
    resultItemIds: readonly string[];
  }>;
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
  schemaVersion: 2;
  generatedAt: string;
  fixture: Readonly<{
    sourceHash: string;
    embeddingModel: string;
    source: "deterministic" | "voyage" | "ranked-input";
    dimensions: number;
    catalogItemCount: number;
    goldenQueryCount: number;
    coverage: readonly string[];
  }>;
  modes: Readonly<Record<RelevanceMode, RelevanceModeReport>>;
  comparison: Readonly<{
    gateFailures: readonly string[];
    deltas: readonly string[];
    semanticPassRateGain: number;
    semanticRecallAt10Gain: number;
    semanticMrrGain: number;
    passed: boolean;
  }>;
}>;

export function composeRelevanceCandidates(
  mode: "hybrid",
  lexicalCandidates: readonly RelevanceCandidate[],
  semanticCandidates: readonly RelevanceCandidate[],
  limit = RELEVANCE_RESULT_LIMIT,
): RelevanceCandidate[] {
  void mode;

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

export function scoreRankedRelevanceInputs(
  input: Readonly<{
    goldenQueries: readonly GoldenQuery[];
    sourceHash: string;
    embeddingModel: string;
    dimensions: number;
    catalogItemCount: number;
    generatedAt: string;
    rankedInputs: Readonly<Partial<Record<RelevanceMode, Readonly<Record<string, readonly RankedRelevanceItem[]>>>>>;
  }>,
): RelevanceReport {
  const cases = Object.fromEntries(RELEVANCE_MODES.map((mode) => [mode, [] as GoldenQueryResult[]])) as Record<
    RelevanceMode,
    GoldenQueryResult[]
  >;

  for (const goldenQuery of input.goldenQueries) {
    validateGoldenQuery(goldenQuery);
    for (const mode of RELEVANCE_MODES) {
      const ranked = input.rankedInputs[mode]?.[goldenQuery.id];
      if (!ranked) throw new Error(`Missing ranked input '${mode}/${goldenQuery.id}'.`);
      cases[mode].push(evaluateGoldenQuery(goldenQuery, ranked));
    }
  }

  const modes = Object.fromEntries(
    RELEVANCE_MODES.map((mode) => [mode, summarizeRelevanceMode(mode, cases[mode])]),
  ) as Record<RelevanceMode, RelevanceModeReport>;
  return buildRelevanceReport({
    generatedAt: input.generatedAt,
    sourceHash: input.sourceHash,
    embeddingModel: input.embeddingModel,
    dimensions: input.dimensions,
    catalogItemCount: input.catalogItemCount,
    goldenQueries: input.goldenQueries,
    modes,
  });
}

export function evaluateGoldenQuery(
  goldenQuery: GoldenQuery,
  candidates: readonly RankedRelevanceItem[],
): GoldenQueryResult {
  const resultItemIds = candidates.slice(0, RELEVANCE_RESULT_LIMIT).map((candidate) => candidate.catalogItemId);
  const summaryFailures =
    goldenQuery.expected.kind === "items"
      ? Object.entries(goldenQuery.expected.summaries ?? {}).flatMap(([id, expected]) => {
          const actual = candidates.find((candidate) => candidate.catalogItemId === id)?.summary;
          return (
            expected === null
              ? actual === null
              : actual &&
                (expected.price === null || actual.price === null
                  ? expected.price === actual.price
                  : Number(expected.price) === Number(actual.price)) &&
                expected.currency === actual.currency &&
                expected.inStock === actual.inStock &&
                expected.buy === actual.buy
          )
            ? []
            : [id];
        })
      : [];
  if (goldenQuery.expected.kind === "no-results") {
    return {
      id: goldenQuery.id,
      query: goldenQuery.query,
      category: goldenQuery.category,
      coverage: goldenQuery.coverage,
      request: goldenQuery.request,
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
    request: goldenQuery.request,
    requiresSummary: Object.keys(goldenQuery.expected.summaries ?? {}).length > 0,
    expectedItemIds: expected,
    resultItemIds,
    passed: found.length === expected.length && exactTop1 !== false && summaryFailures.length === 0,
    summaryFailures,
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
  return {
    mode,
    overall: calculateMetrics(cases),
    categories,
    cases: cases.map((item) => ({ ...item, acceptance: relevanceAcceptance(mode, item) })),
  };
}

export function relevanceAcceptance(
  mode: RelevanceMode,
  query: Pick<GoldenQuery, "category" | "coverage" | "request"> & Readonly<{ requiresSummary?: boolean }>,
): "gate" | "delta" {
  const coverage = new Set(query.coverage);
  const request = query.request;
  const explicitFilters =
    request &&
    (request.language !== undefined ||
      request.inStock !== undefined ||
      request.priceMin !== undefined ||
      request.priceMax !== undefined ||
      (request.dimensionFilters?.length ?? 0) > 0 ||
      request.sort === "price_asc" ||
      request.sort === "price_desc");
  if (mode === "hybrid")
    return coverage.has("protected-identifier") ||
      coverage.has("collector-number") ||
      coverage.has("explicit-filters") ||
      coverage.has("variant-summary") ||
      explicitFilters ||
      query.requiresSummary
      ? "gate"
      : "delta";
  if (mode === "semantic-fallback" && coverage.has("unprotected-extra-term")) return "delta";
  return query.category === "semantic" ? "delta" : "gate";
}

export function validateGoldenQuery(query: GoldenQuery): void {
  const rejectUnknown = (value: object, keys: readonly string[], label: string) => {
    if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error(`Unknown ${label} input.`);
  };
  const boundedText = (value: unknown, max: number) =>
    typeof value === "string" && value.length > 0 && [...value].length <= max;
  rejectUnknown(
    query,
    ["id", "query", "category", "coverage", "request", "expected", "effectiveQueries", "scenario"],
    "GoldenQuery",
  );
  if (!boundedText(query.id, 100) || !boundedText(query.query, 256) || !RELEVANCE_CATEGORIES.includes(query.category))
    throw new Error("Invalid GoldenQuery identity/text/category.");
  if (
    !Array.isArray(query.coverage) ||
    query.coverage.length > 20 ||
    query.coverage.some((value) => !boundedText(value, 64))
  )
    throw new Error("Invalid GoldenQuery coverage.");
  if (query.scenario !== undefined && query.scenario !== "provider-failure")
    throw new Error("Unknown GoldenQuery scenario.");
  if (
    query.effectiveQueries &&
    (query.effectiveQueries.length > 10 || query.effectiveQueries.some((value) => !boundedText(value, 256)))
  )
    throw new Error("Invalid effective queries.");
  const request = query.request;
  if (request) {
    rejectUnknown(request, ["language", "inStock", "priceMin", "priceMax", "sort", "dimensionFilters"], "request");
    if (request.language !== undefined && !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(request.language))
      throw new Error("Invalid request language.");
    if (request.inStock !== undefined && typeof request.inStock !== "boolean")
      throw new Error("Invalid request inStock.");
    if (
      request.sort !== undefined &&
      !["relevance", "title_asc", "title_desc", "newest", "price_asc", "price_desc"].includes(request.sort)
    )
      throw new Error("Invalid request sort.");
    for (const price of [request.priceMin, request.priceMax])
      if (price !== undefined && (typeof price !== "string" || !/^\d{1,7}(?:\.\d{1,2})?$/.test(price)))
        throw new Error("Invalid request price bound.");
    if (
      request.priceMin !== undefined &&
      request.priceMax !== undefined &&
      Number(request.priceMin) > Number(request.priceMax)
    )
      throw new Error("Inverted request price bounds.");
    if (request.dimensionFilters) {
      if (!Array.isArray(request.dimensionFilters) || request.dimensionFilters.length > 10)
        throw new Error("Too many dimension filters.");
      const groups = new Map<string, number>();
      for (const filter of request.dimensionFilters) {
        rejectUnknown(filter, ["dimensionId", "optionId"], "dimension filter");
        if (!boundedText(filter.dimensionId, 100) || !boundedText(filter.optionId, 100))
          throw new Error("Invalid dimension filter.");
        groups.set(filter.dimensionId, (groups.get(filter.dimensionId) ?? 0) + 1);
      }
      if ([...groups.values()].some((count) => count > 5)) throw new Error("Too many options per dimension group.");
    }
  }
  const expected = query.expected;
  rejectUnknown(expected, ["kind", "itemIds", "summaries"], "expected");
  if (expected.kind === "no-results") {
    if (Object.keys(expected).length !== 1) throw new Error("No-results cannot carry items/summaries.");
  } else if (expected.kind === "items") {
    if (
      !Array.isArray(expected.itemIds) ||
      expected.itemIds.length < 1 ||
      expected.itemIds.length > 10 ||
      new Set(expected.itemIds).size !== expected.itemIds.length ||
      expected.itemIds.some((id) => !boundedText(id, 100))
    )
      throw new Error("Invalid expected item IDs.");
    for (const [id, summary] of Object.entries(expected.summaries ?? {})) {
      if (!expected.itemIds.includes(id)) throw new Error("Summary names an unexpected item.");
      if (summary === null) continue;
      rejectUnknown(summary, ["price", "currency", "inStock", "buy"], "summary");
      if (
        (summary.price !== null &&
          (typeof summary.price !== "string" || !/^\d{1,7}(?:\.\d{1,2})?$/.test(summary.price))) ||
        (summary.currency !== null && !/^[A-Z]{3}$/.test(summary.currency)) ||
        typeof summary.inStock !== "boolean" ||
        typeof summary.buy !== "boolean"
      )
        throw new Error("Invalid expected summary.");
    }
  } else throw new Error("Invalid expected kind.");
}

export function buildRelevanceReport(
  input: Readonly<{
    generatedAt: string;
    sourceHash: string;
    embeddingModel: string;
    embeddingSource?: "deterministic" | "voyage" | "ranked-input";
    dimensions: number;
    catalogItemCount: number;
    goldenQueries: readonly GoldenQuery[];
    modes: Readonly<Record<RelevanceMode, RelevanceModeReport>>;
  }>,
): RelevanceReport {
  const baseline = input.modes["lexical-only"];
  const hybrid = input.modes.hybrid;
  const semanticBaseline = baseline.categories.semantic;
  const semanticHybrid = hybrid.categories.semantic;
  const gateFailures: string[] = [];
  const deltas: string[] = [];
  for (const mode of RELEVANCE_MODES) {
    for (const item of input.modes[mode].cases) {
      if (!item.passed)
        (relevanceAcceptance(mode, item) === "gate" ? gateFailures : deltas).push(
          `${mode}/${item.id}: ${(item.summaryFailures?.length ?? 0) > 0 ? "summary mismatch" : "expected results not satisfied"}`,
        );
      const before = baseline.cases.find((other) => other.id === item.id);
      if (
        mode !== "lexical-only" &&
        before &&
        JSON.stringify(before.resultItemIds) !== JSON.stringify(item.resultItemIds)
      )
        deltas.push(
          `${mode}/${item.id}: order ${JSON.stringify(before.resultItemIds)} -> ${JSON.stringify(item.resultItemIds)}`,
        );
    }
  }
  const comparison = {
    gateFailures,
    deltas,
    semanticPassRateGain: semanticHybrid.passRate - semanticBaseline.passRate,
    semanticRecallAt10Gain: nullableDifference(semanticHybrid.recallAt10, semanticBaseline.recallAt10),
    semanticMrrGain: nullableDifference(semanticHybrid.meanReciprocalRank, semanticBaseline.meanReciprocalRank),
    passed: gateFailures.length === 0,
  };
  return {
    schemaVersion: 2,
    generatedAt: input.generatedAt,
    fixture: {
      sourceHash: input.sourceHash,
      embeddingModel: input.embeddingModel,
      source: input.embeddingSource ?? "ranked-input",
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
    const violations = report.comparison.gateFailures;
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
    `Fixture: ${report.fixture.catalogItemCount} catalog items, ${report.fixture.goldenQueryCount} golden queries, \`${report.fixture.embeddingModel}\` (${report.fixture.source}).`,
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
    ...report.comparison.gateFailures.map((failure) => `- GATE FAIL: ${failure}`),
    "",
    "## Report-only mode deltas",
    "",
    ...report.comparison.deltas.map((delta) => `- DELTA: ${delta}`),
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
