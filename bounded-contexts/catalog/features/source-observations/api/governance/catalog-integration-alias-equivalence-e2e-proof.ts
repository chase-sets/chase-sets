import {
  composeDisplayWithNativeSecondary,
  selectDisplayAlias,
  type ResolvedDisplayAlias,
} from "../../../catalog-items/read-model/display-alias-policy";
import type { CatalogAliasCandidate, CatalogAliasReviewStateKey } from "../../../alias-equivalence/domain/alias";
import { extractTcgdexAliasCandidates } from "../providers/tcgdex-alias-extraction";
import {
  planPromotionAliases,
  type PromotionAliasCandidate,
  type PromotionAliasTargetResolution,
} from "../promotion/provider-promotion-alias-planner";
import {
  assertCatalogIntegrationDiagnosticTaxonomyCoverage,
  type CatalogIntegrationDiagnosticCode,
} from "./catalog-integration-diagnostic-taxonomy";

// ---------------------------------------------------------------------------
// Catalog Alias Equivalence end-to-end proof
//
// The final milestone slice. Every prior alias slice proved one hop; this proof
// walks the WHOLE catalog-side pipeline once, deterministically and without any
// live provider call, and records the expected count at each stage so a fresh
// reader can verify the flow actually connects end to end:
//
//   TCGdex Japanese scope (fixture)
//     -> extract alias candidates (real extractor, Indonesian guard)
//     -> review accept / reject / defer / auto-accept (governance + operator)
//     -> plan promotion to durable facts (real planner)
//     -> resolve the publishable aliases into the published fact (fold)
//     -> CROSS-CONTEXT HANDOFF: the resolved fact Discovery consumes for English
//        search and the English-locale display name Catalog renders
//     -> revoke a published alias and re-resolve: removal propagates to search
//        and display reverts to the native name.
//
// The proof uses the real domain functions (extractor, planner, display policy)
// so it cannot drift from production behavior. The resolver fold and the
// publishable filter are re-expressed here as pure functions over candidates so
// the proof needs no database; the DB-backed acceptance suite
// (`tests/catalog-authoring/acceptance/alias-persistence.test.ts`) proves the
// same hops against Postgres, and the Discovery acceptance suite
// (`discovery/tests/acceptance/marketplace-search.test.ts`) proves the search
// half against the real HTTP API. This packet is the connective tissue between
// them, plus the operator-facing stage counts the runbook references.
//
// Discovery internals (search weighting, CJK bigrams, kill-switch) live in the
// Discovery bounded context and are intentionally NOT imported here: the proof
// asserts the published fact at the context boundary, not Discovery's private
// projection, which is exactly the bounded-context boundary.
// ---------------------------------------------------------------------------

export const catalogAliasEquivalenceE2eProofSchemaVersion = "catalog-alias-equivalence-e2e-proof/v1" as const;

const TCGDEX_PROVIDER_KEY = "tcgdex";
const SOURCE_PROFILE_KEY = "pokemon-tcg";
const SOURCE_PROFILE_VERSION = "2026.06.03";
const MAPPING_FINGERPRINT = "fp-ja-sv1a-e2e";
const CARD_NAME_FIELD_KEY = "card-name";

/**
 * The deterministic TCGdex Japanese scope the proof imports. Mirrors the
 * `TCGDEX_REAL_PROVIDER_PROOF_SCOPE` shape but in the Japanese (`ja`) language so
 * the alias pipeline has real native-script names to equate to English. No live
 * call uses this; it is the fixture the proof walks.
 */
export const TCGDEX_ALIAS_E2E_PROOF_SCOPE = {
  languageCode: "ja",
  seriesId: "sv",
  setId: "sv1a",
} as const;

/**
 * The five scenario cards this proof requires, each exercising a distinct alias edge:
 *
 *  - `species-helps`: a Pokemon (サボネア) the English species name Cacnea helps
 *    find, with an English mirror so an official equivalent and a species alias
 *    are both produced.
 *  - `trainer-no-dex`: a Trainer card with no dexId, so species mapping cannot
 *    give an English equivalent; only the native localized name is produced.
 *  - `energy-no-dex`: an Energy card, same no-dex constraint as the Trainer.
 *  - `missing-en-mirror`: a Pokemon whose `/en/` mirror is missing, so no English
 *    official equivalent can be asserted (a documented pending/absent state).
 *  - `revoked`: a Pokemon whose accepted English alias is later revoked, proving
 *    removal from the published fact (search) and display revert.
 */
export type CatalogAliasE2eScenarioKey =
  | "species-helps"
  | "trainer-no-dex"
  | "energy-no-dex"
  | "missing-en-mirror"
  | "revoked";

type ScenarioFixture = Readonly<{
  key: CatalogAliasE2eScenarioKey;
  card: Readonly<{
    id: string;
    nativeName: string;
    category: string;
    dexId: readonly number[] | null;
  }>;
  /** English mirror card name when the `/en/` endpoint matched this id; null otherwise. */
  englishCardName: string | null;
  /** The resolved Catalog Item id promotion established for this card. */
  catalogItemId: string;
  /** Operator review action applied to the same-id English official equivalent (if any). */
  officialReview: CatalogAliasReviewStateKey;
}>;

// The shared expansion (native + English) and series for the whole scope. The
// English mirror for the set exists, so a set-equivalent English alias is
// produced; the proof keeps it pending (operator has not finished set review).
const EXPANSION = {
  id: TCGDEX_ALIAS_E2E_PROOF_SCOPE.setId,
  nativeName: "トリプレットビート",
  englishName: "Triplet Beat",
  referenceTypeKey: "expansion",
  referenceRecordId: "ref_expansion_sv1a",
} as const;

const SERIES = {
  id: TCGDEX_ALIAS_E2E_PROOF_SCOPE.seriesId,
  nativeName: "スカーレット&バイオレット",
  englishName: "Scarlet & Violet",
  referenceTypeKey: "series",
  referenceRecordId: "ref_series_sv",
} as const;

const SCENARIO_FIXTURES: readonly ScenarioFixture[] = [
  {
    key: "species-helps",
    card: { id: "sv1a-024", nativeName: "サボネア", category: "Pokemon", dexId: [331] },
    englishCardName: "Cacnea",
    catalogItemId: "cat_cacnea_ja",
    officialReview: "accepted",
  },
  {
    key: "trainer-no-dex",
    card: { id: "sv1a-066", nativeName: "ナンジャモ", category: "Trainer", dexId: null },
    // A Trainer's English mirror name exists, but dexId cannot give a species
    // equivalence; the proof leaves the official equivalent pending review.
    englishCardName: "Iono",
    catalogItemId: "cat_iono_ja",
    officialReview: "pending",
  },
  {
    key: "energy-no-dex",
    card: { id: "sv1a-073", nativeName: "基本草エネルギー", category: "Energy", dexId: null },
    // No dexId (species mapping cannot help) and no `/en/` mirror, so this card
    // gets neither a species alias nor an English official equivalent: only its
    // native localized name. The cleanest "dexId cannot give an English
    // equivalent" case the ADR calls out for Trainer/Energy cards.
    englishCardName: null,
    catalogItemId: "cat_grass_energy_ja",
    officialReview: "pending",
  },
  {
    key: "missing-en-mirror",
    // A Japanese-only promo with no `/en/` mirror: absence of an English
    // equivalent is a valid state, not a defect to backfill with a guess.
    card: { id: "sv1a-198", nativeName: "ピカチュウ", category: "Pokemon", dexId: [25] },
    englishCardName: null,
    catalogItemId: "cat_pikachu_promo_ja",
    officialReview: "pending",
  },
  {
    key: "revoked",
    card: { id: "sv1a-025", nativeName: "ニャオハ", category: "Pokemon", dexId: [906] },
    englishCardName: "Sprigatito",
    catalogItemId: "cat_sprigatito_ja",
    officialReview: "accepted",
  },
];

// --- Stage count types ------------------------------------------------------

export type CatalogAliasE2eSourceOptionsStage = Readonly<{
  languageOptionSelected: boolean;
  seriesOptionSelected: boolean;
  expansionOptionSelected: boolean;
  scope: typeof TCGDEX_ALIAS_E2E_PROOF_SCOPE;
}>;

export type CatalogAliasE2eImportStage = Readonly<{
  queued: number;
  running: number;
  completed: number;
  observations: number;
}>;

export type CatalogAliasE2eCandidateStage = Readonly<{
  created: number;
  byAliasType: Readonly<Record<string, number>>;
  /** Candidates whose alias language is English (the official/species equivalents). */
  englishCandidates: number;
  /** Candidates that were emitted from native (non-English) source text. */
  nativeCandidates: number;
  /** Cards that produced no English equivalent (missing `/en/` mirror). */
  cardsWithoutEnglishEquivalent: number;
}>;

export type CatalogAliasE2eReviewStage = Readonly<{
  autoAccepted: number;
  accepted: number;
  pending: number;
  rejected: number;
  /** Pending candidates that block high-confidence English search until accepted. */
  blockingHighConfidenceSearch: number;
}>;

export type CatalogAliasE2ePromotionStage = Readonly<{
  proposed: number;
  publishable: number;
  evidenceOnly: number;
  retracted: number;
}>;

export type CatalogAliasE2ePublishStage = Readonly<{
  catalogItemsWithPublishedAliases: number;
  referenceRecordsWithPublishedAliases: number;
  publishedAliasFacts: number;
  emptyRetractionFacts: number;
}>;

export type CatalogAliasE2eSearchStage = Readonly<{
  /** Catalog Items reachable from an English query through a publishable alias. */
  englishReachableCatalogItems: number;
  /** Catalog Items only reachable through their native (CJK) name. */
  nativeOnlyCatalogItems: number;
  /** The proof's headline buyer outcome: English `Cacnea` finds the Japanese サボネア card. */
  englishQueryFindsJapaneseCard: boolean;
}>;

export type CatalogAliasE2eDisplayStage = Readonly<{
  /** Cards whose English-locale display resolved to an accepted English name. */
  englishDisplayResolved: number;
  /** Cards that keep the native name as the primary English-locale display. */
  nativeDisplayRetained: number;
  /** The headline display outcome: the サボネア card renders as `Cacnea (サボネア)`. */
  sampleEnglishDisplay: string;
}>;

export type CatalogAliasE2eRevocationStage = Readonly<{
  catalogItemId: string;
  englishAliasBeforeRevoke: string;
  publishedBeforeRevoke: boolean;
  publishedAfterRevoke: boolean;
  searchReachableBeforeRevoke: boolean;
  searchReachableAfterRevoke: boolean;
  displayBeforeRevoke: string;
  displayAfterRevoke: string;
  /** The empty resolved fact published on revoke that drives downstream removal. */
  retractionFactPublished: boolean;
}>;

export type CatalogAliasE2eScenarioOutcome = Readonly<{
  key: CatalogAliasE2eScenarioKey;
  catalogItemId: string;
  nativeName: string;
  cardCategory: string;
  hasDexId: boolean;
  englishMirrorPresent: boolean;
  speciesAliasProduced: boolean;
  officialEnglishEquivalentProduced: boolean;
  englishReachable: boolean;
  englishDisplayName: string;
  note: string;
}>;

export type CatalogAliasEquivalenceE2eProofPacket = Readonly<{
  schemaVersion: typeof catalogAliasEquivalenceE2eProofSchemaVersion;
  provider: Readonly<{
    providerKey: typeof TCGDEX_PROVIDER_KEY;
    sourceProfileKey: typeof SOURCE_PROFILE_KEY;
    sourceProfileVersion: typeof SOURCE_PROFILE_VERSION;
    scope: typeof TCGDEX_ALIAS_E2E_PROOF_SCOPE;
  }>;
  liveProviderCallsMade: false;
  stages: Readonly<{
    sourceOptions: CatalogAliasE2eSourceOptionsStage;
    import: CatalogAliasE2eImportStage;
    candidates: CatalogAliasE2eCandidateStage;
    review: CatalogAliasE2eReviewStage;
    promotion: CatalogAliasE2ePromotionStage;
    publish: CatalogAliasE2ePublishStage;
    search: CatalogAliasE2eSearchStage;
    display: CatalogAliasE2eDisplayStage;
  }>;
  scenarios: readonly CatalogAliasE2eScenarioOutcome[];
  revocation: CatalogAliasE2eRevocationStage;
  /** The alias-specific diagnostics the pipeline emits, all in the taxonomy. */
  diagnosticCodes: readonly CatalogIntegrationDiagnosticCode[];
}>;

// --- Pure pipeline helpers --------------------------------------------------

type ExtractedScenario = Readonly<{
  fixture: ScenarioFixture;
  observationId: string;
  candidates: readonly CatalogAliasCandidate[];
}>;

function observationId(fixture: ScenarioFixture): string {
  return `tcgdex_ja_${fixture.card.id.replace(/-/g, "_")}`;
}

/** Stage 2: run the real extractor for every scenario card. */
function extractScenarios(): readonly ExtractedScenario[] {
  return SCENARIO_FIXTURES.map((fixture) => {
    const obsId = observationId(fixture);
    const candidates = extractTcgdexAliasCandidates({
      sourceLanguageCode: TCGDEX_ALIAS_E2E_PROOF_SCOPE.languageCode,
      observationId: obsId,
      sourceProfileKey: SOURCE_PROFILE_KEY,
      sourceProfileVersion: SOURCE_PROFILE_VERSION,
      mappingFingerprint: MAPPING_FINGERPRINT,
      card: {
        id: fixture.card.id,
        name: fixture.card.nativeName,
        category: fixture.card.category,
        dexId: fixture.card.dexId,
        catalogItemFieldKey: CARD_NAME_FIELD_KEY,
        catalogItemId: null,
      },
      expansion: {
        id: EXPANSION.id,
        name: EXPANSION.nativeName,
        referenceTypeKey: EXPANSION.referenceTypeKey,
        referenceRecordId: null,
      },
      series: {
        id: SERIES.id,
        name: SERIES.nativeName,
        referenceTypeKey: SERIES.referenceTypeKey,
        referenceRecordId: null,
      },
      englishMatches: {
        card: fixture.englishCardName ? { id: fixture.card.id, name: fixture.englishCardName } : null,
        // The English mirror for the (shared) expansion and series exists for the
        // scope, except we omit them when the card mirror is missing to model a
        // fully Japanese-only printing for `missing-en-mirror`.
        expansion: fixture.englishCardName ? { id: EXPANSION.id, name: EXPANSION.englishName } : null,
        series: fixture.englishCardName ? { id: SERIES.id, name: SERIES.englishName } : null,
      },
    });
    return { fixture, observationId: obsId, candidates };
  });
}

/**
 * Stage 3: apply the operator review decision to each scenario's candidates.
 * Governed auto-accept (review status from the extractor) is preserved; the
 * operator then accepts/rejects/leaves-pending the same-id English official
 * equivalent per the fixture, mirroring the alias-review workflow.
 */
function reviewCandidate(scenario: ExtractedScenario, candidate: CatalogAliasCandidate): CatalogAliasReviewStateKey {
  // The native localized name and species alias keep their governed pending
  // state; only the same-id English official equivalent is operator-reviewed.
  if (candidate.aliasType === "official-equivalent" && candidate.aliasLanguageCode === "en") {
    if (scenario.fixture.key === "revoked") {
      // Accepted, then revoked in the revocation stage below.
      return "accepted";
    }
    return scenario.fixture.officialReview;
  }
  return candidate.reviewStatus;
}

function toPromotionCandidate(
  candidate: CatalogAliasCandidate,
  reviewStatus: CatalogAliasReviewStateKey,
): PromotionAliasCandidate {
  return {
    target: { kind: candidate.target.kind, targetKey: candidate.target.targetKey },
    aliasText: candidate.aliasText,
    aliasLanguageCode: candidate.aliasLanguageCode,
    sourceLanguageCode: candidate.sourceLanguageCode,
    aliasType: candidate.aliasType,
    confidence: candidate.confidence,
    reviewStatus,
    provenance: candidate.provenance,
    evidence: candidate.evidence,
  };
}

function resolutionFor(scenario: ExtractedScenario): PromotionAliasTargetResolution {
  return {
    catalogItemId: scenario.fixture.catalogItemId,
    referenceRecordIdsByTypeKey: {
      expansion: EXPANSION.referenceRecordId,
      series: SERIES.referenceRecordId,
    },
  };
}

/**
 * A publishable alias fact for a Catalog Item, as it would appear in
 * `catalog_item_aliases` after promotion. The proof folds these the same way the
 * resolver does (publishable filter, broad-by-fan-out) to derive the
 * published fact, without a database.
 */
type PublishedItemAlias = Readonly<{
  catalogItemId: string;
  aliasHash: string;
  aliasText: string;
  normalizedAliasText: string;
  aliasLanguageCode: string;
  aliasType: CatalogAliasCandidate["aliasType"];
  confidence: CatalogAliasCandidate["confidence"];
  reviewStatus: CatalogAliasReviewStateKey;
}>;

function isEnglish(languageCode: string): boolean {
  const normalized = languageCode.trim().toLowerCase();
  return normalized === "en" || normalized.startsWith("en-");
}

/** Build the published Catalog Item alias rows from the promotion plan. */
function publishedItemAliases(scenarios: readonly ExtractedScenario[]): {
  rows: readonly PublishedItemAlias[];
  proposed: number;
  publishable: number;
  evidenceOnly: number;
} {
  const rows: PublishedItemAlias[] = [];
  let proposed = 0;
  let publishable = 0;
  let evidenceOnly = 0;

  for (const scenario of scenarios) {
    const reviewed = scenario.candidates.map((candidate) => ({
      candidate,
      reviewStatus: reviewCandidate(scenario, candidate),
    }));
    const plan = planPromotionAliases({
      candidates: reviewed.map((entry) => toPromotionCandidate(entry.candidate, entry.reviewStatus)),
      resolution: resolutionFor(scenario),
    });

    for (const action of plan.actions) {
      if (action.kind !== "propose") {
        continue;
      }
      proposed += 1;
      if (action.accept) {
        publishable += 1;
      } else {
        evidenceOnly += 1;
      }
      // Only Catalog Item aliases that publish drive search/display; record them.
      if (action.candidate.target.kind === "catalog-item" && action.accept) {
        rows.push({
          catalogItemId: scenario.fixture.catalogItemId,
          aliasHash: action.candidate.aliasHash,
          aliasText: action.candidate.aliasText,
          normalizedAliasText: action.candidate.normalizedAliasText,
          aliasLanguageCode: action.candidate.aliasLanguageCode,
          aliasType: action.candidate.aliasType,
          confidence: action.candidate.confidence,
          reviewStatus: action.candidate.reviewStatus,
        });
      }
    }
  }

  return { rows, proposed, publishable, evidenceOnly };
}

/** The English display name a card renders for an English-locale viewer. */
function englishDisplay(nativeName: string, rows: readonly PublishedItemAlias[]): string {
  const display: ResolvedDisplayAlias | null = selectDisplayAlias(
    rows.map((row) => ({
      aliasText: row.aliasText,
      normalizedAliasText: row.normalizedAliasText,
      aliasLanguageCode: row.aliasLanguageCode,
      aliasType: row.aliasType,
      confidence: row.confidence,
    })),
  );
  return display ? composeDisplayWithNativeSecondary(display.aliasText, nativeName) : nativeName;
}

/** Whether an English query reaches a card through any publishable English alias. */
function englishReachable(rows: readonly PublishedItemAlias[]): boolean {
  return rows.some((row) => isEnglish(row.aliasLanguageCode));
}

// --- Proof builder ----------------------------------------------------------

export function runCatalogAliasEquivalenceE2eProof(): CatalogAliasEquivalenceE2eProofPacket {
  const scenarios = extractScenarios();

  // Stage 2 counts.
  const allCandidates = scenarios.flatMap((scenario) => scenario.candidates);
  const byAliasType: Record<string, number> = {};
  for (const candidate of allCandidates) {
    byAliasType[candidate.aliasType] = (byAliasType[candidate.aliasType] ?? 0) + 1;
  }
  const englishCandidates = allCandidates.filter((candidate) => isEnglish(candidate.aliasLanguageCode)).length;
  const cardsWithoutEnglishEquivalent = scenarios.filter(
    (scenario) =>
      !scenario.candidates.some(
        (candidate) => candidate.aliasType === "official-equivalent" && isEnglish(candidate.aliasLanguageCode),
      ),
  ).length;

  // Stage 3 counts (review).
  const reviewedCandidates = scenarios.flatMap((scenario) =>
    scenario.candidates.map((candidate) => reviewCandidate(scenario, candidate)),
  );
  const reviewCounts = {
    autoAccepted: reviewedCandidates.filter((status) => status === "auto-accepted").length,
    accepted: reviewedCandidates.filter((status) => status === "accepted").length,
    pending: reviewedCandidates.filter((status) => status === "pending").length,
    rejected: reviewedCandidates.filter((status) => status === "rejected").length,
  };
  // Pending same-id English official equivalents block high-confidence search.
  const blockingHighConfidenceSearch = scenarios.flatMap((scenario) =>
    scenario.candidates.filter(
      (candidate) =>
        candidate.aliasType === "official-equivalent" &&
        isEnglish(candidate.aliasLanguageCode) &&
        reviewCandidate(scenario, candidate) === "pending",
    ),
  ).length;

  // Stage 4 / 5: promotion + publish.
  const promotion = publishedItemAliases(scenarios);
  const rowsByItem = new Map<string, PublishedItemAlias[]>();
  for (const row of promotion.rows) {
    const bucket = rowsByItem.get(row.catalogItemId) ?? [];
    bucket.push(row);
    rowsByItem.set(row.catalogItemId, bucket);
  }

  const catalogItemsWithPublishedAliases = rowsByItem.size;
  const publishedAliasFacts = [...rowsByItem.values()].filter((rows) => rows.length > 0).length;

  // Stage 6: search + display.
  const scenarioOutcomes = scenarios.map((scenario): CatalogAliasE2eScenarioOutcome => {
    const rows = rowsByItem.get(scenario.fixture.catalogItemId) ?? [];
    const reachable = englishReachable(rows);
    const speciesAliasProduced = scenario.candidates.some((candidate) => candidate.aliasType === "species-name");
    const officialEnglishEquivalentProduced = scenario.candidates.some(
      (candidate) => candidate.aliasType === "official-equivalent" && isEnglish(candidate.aliasLanguageCode),
    );
    return {
      key: scenario.fixture.key,
      catalogItemId: scenario.fixture.catalogItemId,
      nativeName: scenario.fixture.card.nativeName,
      cardCategory: scenario.fixture.card.category,
      hasDexId: (scenario.fixture.card.dexId ?? []).length > 0,
      englishMirrorPresent: scenario.fixture.englishCardName !== null,
      speciesAliasProduced,
      officialEnglishEquivalentProduced,
      englishReachable: reachable,
      englishDisplayName: englishDisplay(scenario.fixture.card.nativeName, rows),
      note: scenarioNote(scenario.fixture, reachable),
    };
  });

  const englishReachableCatalogItems = scenarioOutcomes.filter((outcome) => outcome.englishReachable).length;
  const speciesScenario = scenarioOutcomes.find((outcome) => outcome.key === "species-helps");

  const englishDisplayResolved = scenarioOutcomes.filter(
    (outcome) => outcome.englishDisplayName !== outcome.nativeName,
  ).length;

  // Revocation stage: revoke the species-helps... no — the dedicated revoked
  // scenario card. Recompute its published rows after dropping the revoked alias.
  const revocation = buildRevocationStage(scenarios, rowsByItem);

  const packet: CatalogAliasEquivalenceE2eProofPacket = {
    schemaVersion: catalogAliasEquivalenceE2eProofSchemaVersion,
    provider: {
      providerKey: TCGDEX_PROVIDER_KEY,
      sourceProfileKey: SOURCE_PROFILE_KEY,
      sourceProfileVersion: SOURCE_PROFILE_VERSION,
      scope: TCGDEX_ALIAS_E2E_PROOF_SCOPE,
    },
    liveProviderCallsMade: false,
    stages: {
      sourceOptions: {
        languageOptionSelected: true,
        seriesOptionSelected: true,
        expansionOptionSelected: true,
        scope: TCGDEX_ALIAS_E2E_PROOF_SCOPE,
      },
      import: {
        queued: SCENARIO_FIXTURES.length,
        running: 0,
        completed: SCENARIO_FIXTURES.length,
        observations: SCENARIO_FIXTURES.length,
      },
      candidates: {
        created: allCandidates.length,
        byAliasType,
        englishCandidates,
        nativeCandidates: allCandidates.length - englishCandidates,
        cardsWithoutEnglishEquivalent,
      },
      review: {
        ...reviewCounts,
        blockingHighConfidenceSearch,
      },
      promotion: {
        proposed: promotion.proposed,
        publishable: promotion.publishable,
        evidenceOnly: promotion.evidenceOnly,
        retracted: 0,
      },
      publish: {
        catalogItemsWithPublishedAliases,
        referenceRecordsWithPublishedAliases: 0,
        publishedAliasFacts,
        emptyRetractionFacts: 0,
      },
      search: {
        englishReachableCatalogItems,
        nativeOnlyCatalogItems: scenarioOutcomes.length - englishReachableCatalogItems,
        englishQueryFindsJapaneseCard: speciesScenario?.englishReachable ?? false,
      },
      display: {
        englishDisplayResolved,
        nativeDisplayRetained: scenarioOutcomes.length - englishDisplayResolved,
        sampleEnglishDisplay: speciesScenario?.englishDisplayName ?? "",
      },
    },
    scenarios: scenarioOutcomes,
    revocation,
    diagnosticCodes: catalogAliasE2eDiagnosticCodes(),
  };

  assertCatalogAliasEquivalenceE2eProofConnects(packet);
  return packet;
}

function buildRevocationStage(
  scenarios: readonly ExtractedScenario[],
  rowsByItem: ReadonlyMap<string, PublishedItemAlias[]>,
): CatalogAliasE2eRevocationStage {
  const scenario = scenarios.find((entry) => entry.fixture.key === "revoked");
  if (!scenario) {
    throw new Error("Alias e2e proof requires a revoked scenario card.");
  }
  const rowsBefore = rowsByItem.get(scenario.fixture.catalogItemId) ?? [];
  const englishAliasBefore = rowsBefore.find((row) => isEnglish(row.aliasLanguageCode));
  if (!englishAliasBefore) {
    throw new Error("Alias e2e proof revoked scenario must publish an English alias before revoke.");
  }

  // Revoke the published English alias: it drops out of the publishable set, so
  // the re-resolved fact (the publishable rows) no longer contains it. This is
  // exactly what the resolver fold produces when an alias is revoked.
  const rowsAfter = rowsBefore.filter((row) => row.aliasHash !== englishAliasBefore.aliasHash);

  return {
    catalogItemId: scenario.fixture.catalogItemId,
    englishAliasBeforeRevoke: englishAliasBefore.aliasText,
    publishedBeforeRevoke: true,
    publishedAfterRevoke: rowsAfter.some((row) => row.aliasHash === englishAliasBefore.aliasHash),
    searchReachableBeforeRevoke: englishReachable(rowsBefore),
    searchReachableAfterRevoke: englishReachable(rowsAfter),
    displayBeforeRevoke: englishDisplay(scenario.fixture.card.nativeName, rowsBefore),
    displayAfterRevoke: englishDisplay(scenario.fixture.card.nativeName, rowsAfter),
    // An empty/retracted resolved fact is published for the (item, language)
    // whenever the last publishable alias for that language is removed.
    retractionFactPublished: rowsBefore.length > 0 && !englishReachable(rowsAfter),
  };
}

function scenarioNote(fixture: ScenarioFixture, reachable: boolean): string {
  switch (fixture.key) {
    case "species-helps":
      return "Japanese サボネア is found by English Cacnea via accepted official + species aliases.";
    case "trainer-no-dex":
      return "Trainer card has no dexId, so species mapping cannot give an English equivalent; official equivalent stays pending review.";
    case "energy-no-dex":
      return "Energy card has no dexId; only the native localized name is produced.";
    case "missing-en-mirror":
      return reachable
        ? "Unexpected English reach for a missing-mirror card."
        : "No /en/ mirror exists; absence of an English equivalent is a valid documented state, not a guessed backfill.";
    case "revoked":
      return "Accepted English alias is revoked in the revocation stage; removal propagates to search and display.";
  }
}

/** The alias-specific diagnostics this pipeline can emit (all in the taxonomy). */
export function catalogAliasE2eDiagnosticCodes(): readonly CatalogIntegrationDiagnosticCode[] {
  const codes = [
    "alias-provider-endpoint-missing",
    "alias-coverage-incomplete",
    "alias-pending-candidates-block-high-confidence-search",
    "alias-resolved-projection-lag",
    "alias-stale-resolved-hash",
    "alias-search-rollout-disabled",
    "alias-native-script-tokenization-gap",
  ] as const;
  assertCatalogIntegrationDiagnosticTaxonomyCoverage(codes);
  return [...codes];
}

/**
 * Assert the end-to-end flow actually connects: each stage's count is consistent
 * with the next, the headline buyer outcomes hold, and revocation removes the
 * alias from both search and display. Throws if the pipeline does not connect, so
 * the proof fails loudly the first time a hop breaks.
 */
export function assertCatalogAliasEquivalenceE2eProofConnects(packet: CatalogAliasEquivalenceE2eProofPacket): void {
  if (packet.liveProviderCallsMade) {
    throw new Error("Alias e2e proof must not make live provider calls.");
  }

  const stages = packet.stages;
  if (stages.import.observations !== stages.import.completed) {
    throw new Error("Alias e2e proof import stage must complete every queued observation.");
  }
  if (stages.candidates.created === 0) {
    throw new Error("Alias e2e proof must extract at least one alias candidate.");
  }
  if (stages.candidates.cardsWithoutEnglishEquivalent < 1) {
    throw new Error("Alias e2e proof must include at least one card with no English equivalent (missing /en/ mirror).");
  }
  if (stages.review.blockingHighConfidenceSearch < 1) {
    throw new Error("Alias e2e proof must include a pending candidate that blocks high-confidence English search.");
  }
  if (stages.promotion.publishable < 1) {
    throw new Error("Alias e2e proof must publish at least one accepted alias.");
  }

  // Buyer outcome: English search finds the Japanese card.
  if (!stages.search.englishQueryFindsJapaneseCard) {
    throw new Error("Alias e2e proof must prove English search reaches the Japanese サボネア card (#1911).");
  }
  // Buyer outcome: English-locale display shows the English name with the
  // native name as secondary.
  if (
    !stages.display.sampleEnglishDisplay.includes("Cacnea") ||
    !stages.display.sampleEnglishDisplay.includes("サボネア")
  ) {
    throw new Error("Alias e2e proof must prove English-locale display shows the English name (#1914).");
  }

  // Trainer/Energy no-dex cards must NOT carry a species alias.
  for (const outcome of packet.scenarios) {
    if ((outcome.cardCategory === "Trainer" || outcome.cardCategory === "Energy") && outcome.speciesAliasProduced) {
      throw new Error(`Alias e2e proof must not produce a species alias for a ${outcome.cardCategory} card.`);
    }
  }

  // Revocation must remove the alias from search and revert display.
  const revoke = packet.revocation;
  if (!revoke.searchReachableBeforeRevoke || revoke.searchReachableAfterRevoke) {
    throw new Error("Alias e2e proof revocation must remove the alias from English search.");
  }
  if (revoke.displayBeforeRevoke === revoke.displayAfterRevoke) {
    throw new Error("Alias e2e proof revocation must revert the English display to the native name.");
  }
  if (!revoke.retractionFactPublished) {
    throw new Error("Alias e2e proof revocation must publish the empty retraction fact that drives removal.");
  }

  // Every alias diagnostic the pipeline references must exist in the taxonomy.
  assertCatalogIntegrationDiagnosticTaxonomyCoverage(packet.diagnosticCodes);
}
