import {
  catalogProviderTransportFailureConditions,
  catalogProviderTransportFirstSliceBudgets,
  catalogProviderTransportFirstSliceUnitKey,
  catalogProviderTransportSupplementalTcgplayerUnitKey,
} from "../api/catalog-integration-provider-transport-budgets";
import {
  catalogPrimaryWorkbenchBlockers,
  catalogPrimaryWorkbenchProviderTransportCategories,
  catalogPrimaryWorkbenchRetirementPolicy,
} from "../api/primary-workbench-admin-contracts";
import type { CatalogIntegrationUnitKey } from "../api/integration-unit";

export type CatalogProviderTransportProofCriterionKey =
  | "provider-scope-option-query-selection"
  | "provider-pagination-or-multi-step-retrieval"
  | "image-and-metadata-mapping"
  | "provider-transport-degraded-condition"
  | "source-observation-profile-metadata"
  | "promotion-preview-counts"
  | "redaction-safe-evidence";

export type CatalogProviderTransportCoverageStatus = "covered" | "covered-by-test" | "planned-proof";

export type CatalogProviderTransportProofCriterion = Readonly<{
  key: CatalogProviderTransportProofCriterionKey;
  requiredForFirstSlice: boolean;
  evidenceTarget: string;
}>;

export type CatalogProviderTransportProofProviderCoverage = Readonly<{
  criterion: CatalogProviderTransportProofCriterionKey;
  status: CatalogProviderTransportCoverageStatus;
  evidence: string;
}>;

export type CatalogProviderTransportProofProvider = Readonly<{
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  role: "primary-first-slice" | "supplemental-transport";
  selectedForFirstSlice: boolean;
  launchPromotionActive: boolean;
  rationale: string;
  coverage: readonly CatalogProviderTransportProofProviderCoverage[];
}>;

export const catalogProviderTransportProofCriteria = [
  proofCriterion(
    "provider-scope-option-query-selection",
    "Operator can choose provider, unit, language, Series, and Expansion through bounded option queries.",
  ),
  proofCriterion(
    "provider-pagination-or-multi-step-retrieval",
    "Proof traverses more than one provider transport step before Source Observations are produced.",
  ),
  proofCriterion(
    "image-and-metadata-mapping",
    "Provider payloads include image/provenance metadata and normalized Source Observation facts.",
  ),
  proofCriterion(
    "provider-transport-degraded-condition",
    "A provider transport failure maps to the canonical providerTransport and blocker categories.",
  ),
  proofCriterion(
    "source-observation-profile-metadata",
    "Created observations retain provider key, unit key, source profile version, external key, and provenance.",
  ),
  proofCriterion(
    "promotion-preview-counts",
    "The selected Source Observation scope can produce eligible, blocked, skipped, and conflict counts before write.",
  ),
  proofCriterion(
    "redaction-safe-evidence",
    "Operator evidence excludes credentials, raw payload bodies, secret URLs, and provider terms-sensitive material.",
  ),
] as const satisfies readonly CatalogProviderTransportProofCriterion[];

export const catalogProviderTransportFirstSliceProofProviders = [
  {
    providerKey: "tcgdex",
    unitKey: catalogProviderTransportFirstSliceUnitKey,
    role: "primary-first-slice",
    selectedForFirstSlice: true,
    launchPromotionActive: true,
    rationale:
      "TCGdex is the active profile-backed provider path that exercises option queries, expansion/card fetches, image and metadata mapping, Source Observation metadata, and promotion planning without provider-specific Admin branches.",
    coverage: [
      coverage(
        "provider-scope-option-query-selection",
        "covered",
        "TCGdex exposes language, Series, and Expansion option queries through the ProviderAdapter boundary.",
      ),
      coverage(
        "provider-pagination-or-multi-step-retrieval",
        "covered",
        "The TCGdex import plan fetches Expansion metadata, then card payloads, then attaches payload provenance.",
      ),
      coverage(
        "image-and-metadata-mapping",
        "covered-by-test",
        "The TCGdex dry-run proof maps card identity, rarity, variant label, source URL, source update time, and image evidence.",
      ),
      coverage(
        "provider-transport-degraded-condition",
        "covered-by-test",
        "The real-provider proof packet records a timeout condition against the canonical providerTransport and blocker vocabulary.",
      ),
      coverage(
        "source-observation-profile-metadata",
        "covered-by-test",
        "The dry-run proof carries provider key, selected unit key, profile version, external key, source URL, and source update time.",
      ),
      coverage(
        "promotion-preview-counts",
        "covered-by-test",
        "The real-provider proof packet captures promotion preview counts before any Catalog Item write.",
      ),
      coverage(
        "redaction-safe-evidence",
        "covered-by-test",
        "The proof packet is redacted by contract, with the security/privacy gate still owning launch signoff.",
      ),
    ],
  },
  {
    providerKey: "tcgplayer",
    unitKey: catalogProviderTransportSupplementalTcgplayerUnitKey,
    role: "supplemental-transport",
    selectedForFirstSlice: false,
    launchPromotionActive: false,
    rationale:
      "TCGplayer contributes supplemental credential, session, domain, retry, and rate-limit transport evidence until its promotion path is launch-active.",
    coverage: [
      coverage(
        "provider-scope-option-query-selection",
        "covered-by-test",
        "TCGplayer product-line, set-name, product, and SKU option queries exercise credentialed transport.",
      ),
      coverage(
        "provider-transport-degraded-condition",
        "covered-by-test",
        "TCGplayer diagnostics report unconfigured client and domain rate-limit policy without exposing credential material.",
      ),
    ],
  },
] as const satisfies readonly CatalogProviderTransportProofProvider[];

export const catalogProviderTransportRetiredSurfaceRule = {
  policy: catalogPrimaryWorkbenchRetirementPolicy,
  appliesTo: [
    "retired Catalog admin page modules",
    "legacy provider selectors",
    "raw JSON authoring and broad patch escape hatches",
    "support-only route variants",
    "compatibility redirects, aliases, shims, and hidden feature flags",
    "API, client, and read-model compatibility behavior",
    "tests, fixtures, seeds, screenshots, documentation, runbooks, release notes, and operator instructions that teach retired behavior",
  ],
} as const;

export function getCatalogProviderTransportFirstSliceProofProvider(): CatalogProviderTransportProofProvider {
  const selected = catalogProviderTransportFirstSliceProofProviders.filter(
    (provider) => provider.selectedForFirstSlice,
  );
  if (selected.length !== 1) {
    throw new Error("Exactly one first-slice provider transport proof provider must be selected.");
  }

  return selected[0];
}

export function assertCatalogProviderTransportProofCoverage(): void {
  const blockerCategories = new Set(catalogPrimaryWorkbenchBlockers.map((blocker) => blocker.category));

  for (const category of catalogPrimaryWorkbenchProviderTransportCategories) {
    const condition = catalogProviderTransportFailureConditions.find(
      (entry) => entry.condition === category && entry.transportCategory === category,
    );
    if (!condition) {
      throw new Error(`Missing provider transport failure condition for '${category}'.`);
    }
    if (!blockerCategories.has(condition.blockerCategory)) {
      throw new Error(`Provider transport condition '${category}' maps to an unknown blocker.`);
    }
  }

  const selectedProvider = getCatalogProviderTransportFirstSliceProofProvider();
  const selectedCoverage = new Map(selectedProvider.coverage.map((entry) => [entry.criterion, entry]));
  for (const criterion of catalogProviderTransportProofCriteria) {
    const coverageEntry = selectedCoverage.get(criterion.key);
    if (!coverageEntry) {
      throw new Error(`Selected provider '${selectedProvider.providerKey}' does not cover '${criterion.key}'.`);
    }
  }

  for (const budget of catalogProviderTransportFirstSliceBudgets) {
    if (budget.p95Ms <= 0 || budget.timeoutMs < budget.p95Ms) {
      throw new Error(`Invalid provider transport latency budget for '${budget.surface}'.`);
    }
    if (
      budget.freshWithinSeconds > budget.staleAfterSeconds ||
      budget.staleAfterSeconds > budget.unavailableAfterSeconds
    ) {
      throw new Error(`Invalid provider transport freshness budget for '${budget.surface}'.`);
    }
  }

  for (const requiredSurface of ["runtime code", "product patterns", "documentation", "compatibility shims"] as const) {
    if (!catalogProviderTransportRetiredSurfaceRule.policy.surfaces.includes(requiredSurface)) {
      throw new Error(`Retired surface policy must remove ${requiredSurface}.`);
    }
  }
}

function proofCriterion(
  key: CatalogProviderTransportProofCriterionKey,
  evidenceTarget: string,
): CatalogProviderTransportProofCriterion {
  return {
    key,
    requiredForFirstSlice: true,
    evidenceTarget,
  };
}

function coverage(
  criterion: CatalogProviderTransportProofCriterionKey,
  status: CatalogProviderTransportCoverageStatus,
  evidence: string,
): CatalogProviderTransportProofProviderCoverage {
  return {
    criterion,
    status,
    evidence,
  };
}
