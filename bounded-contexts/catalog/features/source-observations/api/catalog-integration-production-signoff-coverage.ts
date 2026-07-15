import type { CatalogProviderIngestionUnitProductDomain } from "./provider-integration-mapping-contract";
import {
  catalogProviderIntegrationProfileVersions,
  catalogProviderProfileVersionIngestionUnitKey,
  catalogProviderProfileVersionProductDomain,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import { classifyProviderProductionClass } from "../../completion-report/read-model/query";

// Structural readiness guard for production signoff coverage. The active
// provider profile/unit registry is the executable source of truth for which
// product domains and provider units can participate in the complete production
// Catalog synchronization. This guard reconciles that registry against the
// production signoff and provider-sync runbook documents so that adding a
// future production-capable domain or provider unit without matching signoff
// coverage fails visibly instead of relying on a hardcoded issue table.

export const CATALOG_PRODUCTION_SIGNOFF_DOCUMENT =
  "bounded-contexts/catalog/docs/catalog-integration-production-signoff.md";
export const CATALOG_PROVIDER_SYNC_RUNBOOK = "docs/runbooks/catalog-game-provider-sync-operations.md";

// The natural-language section title each product domain uses in both the
// signoff document and the provider-sync runbook. A domain that resolves from
// the registry but is absent here is an unmapped-domain diagnostic, so a new
// product domain cannot be added without a signoff title.
export const catalogProductDomainSignoffTitles: Readonly<Record<CatalogProviderIngestionUnitProductDomain, string>> = {
  mtg: "Magic",
  pokemon: "Pokemon",
  yugioh: "Yu-Gi-Oh!",
  "one-piece": "One Piece",
  lorcana: "Lorcana",
};

export type CatalogProductionSignoffCoverageDiagnosticCode =
  | "unmapped-product-domain"
  | "missing-signoff-section"
  | "missing-signoff-table-row"
  | "missing-runbook-section"
  | "missing-provider-authority";

export type CatalogProductionSignoffCoverageDiagnostic = Readonly<{
  code: CatalogProductionSignoffCoverageDiagnosticCode;
  productDomain: CatalogProviderIngestionUnitProductDomain;
  providerKey?: string;
  unitKey?: string;
  diagnosticText: string;
}>;

export type CatalogProductionSignoffCoverageInput = Readonly<{
  signoffDocument: string;
  runbookDocument: string;
  versions?: readonly CatalogProviderIntegrationProfileVersionRecord[];
}>;

// A profile version requires signoff coverage only when it is the active,
// production lifecycle. Validation-only, comparison-only, test, gated,
// deprecated, and retired units classify out of required coverage and are
// therefore excluded from the launch manifest and this guard.
export function catalogProviderProfileVersionRequiresSignoffCoverage(
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return classifyProviderProductionClass({ lifecycle: version.lifecycle, active: version.active }) === "production";
}

export function listCatalogProductionSignoffRequiredUnits(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): readonly CatalogProviderIntegrationProfileVersionRecord[] {
  return versions.filter(catalogProviderProfileVersionRequiresSignoffCoverage);
}

export function listCatalogProductionSignoffRequiredDomains(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[] = catalogProviderIntegrationProfileVersions,
): readonly CatalogProviderIngestionUnitProductDomain[] {
  const domains = new Set<CatalogProviderIngestionUnitProductDomain>();
  for (const version of listCatalogProductionSignoffRequiredUnits(versions)) {
    domains.add(catalogProviderProfileVersionProductDomain(version));
  }
  return [...domains];
}

function hasSectionHeading(document: string, title: string): boolean {
  return document.includes(`## ${title}\n`) || document.endsWith(`## ${title}`);
}

// Reconcile the active production-capable registry against the signoff and
// runbook documents. Returns one diagnostic per uncovered domain or provider
// authority so the guard reports every gap at once.
export function evaluateCatalogProductionSignoffCoverage(
  input: CatalogProductionSignoffCoverageInput,
): readonly CatalogProductionSignoffCoverageDiagnostic[] {
  const versions = input.versions ?? catalogProviderIntegrationProfileVersions;
  const requiredUnits = listCatalogProductionSignoffRequiredUnits(versions);
  const diagnostics: CatalogProductionSignoffCoverageDiagnostic[] = [];

  const domains = new Set<CatalogProviderIngestionUnitProductDomain>();
  for (const version of requiredUnits) {
    domains.add(catalogProviderProfileVersionProductDomain(version));
  }

  for (const productDomain of domains) {
    const title = catalogProductDomainSignoffTitles[productDomain];
    if (!title) {
      diagnostics.push({
        code: "unmapped-product-domain",
        productDomain,
        diagnosticText: `Product domain '${productDomain}' has active production-capable provider units but no signoff title. Add a catalogProductDomainSignoffTitles entry and signoff coverage.`,
      });
      continue;
    }

    if (!hasSectionHeading(input.signoffDocument, title)) {
      diagnostics.push({
        code: "missing-signoff-section",
        productDomain,
        diagnosticText: `The production signoff document is missing a '## ${title}' section for product domain '${productDomain}'.`,
      });
    }

    if (!input.signoffDocument.includes(`[${title}](#`)) {
      diagnostics.push({
        code: "missing-signoff-table-row",
        productDomain,
        diagnosticText: `The production signoff 'Product-domain signoffs' table is missing a row linking to the '${title}' section for product domain '${productDomain}'.`,
      });
    }

    if (!hasSectionHeading(input.runbookDocument, title)) {
      diagnostics.push({
        code: "missing-runbook-section",
        productDomain,
        diagnosticText: `The provider-sync runbook is missing a '## ${title}' section for product domain '${productDomain}'.`,
      });
    }
  }

  // Every active production-capable provider unit must be named as a provider
  // authority within its domain's signoff section. This keeps shared providers
  // (TCGplayer, Scrydex) unit-scoped: each domain's section must name the
  // provider rather than relying on broad provider enablement.
  const seenProviderDomain = new Set<string>();
  for (const version of requiredUnits) {
    const productDomain = catalogProviderProfileVersionProductDomain(version);
    const title = catalogProductDomainSignoffTitles[productDomain];
    if (!title || !hasSectionHeading(input.signoffDocument, title)) {
      continue;
    }
    const domainSection = extractSection(input.signoffDocument, title);
    const providerKey = version.providerKey.trim().toLowerCase();
    const seenKey = `${productDomain}:${providerKey}`;
    if (seenProviderDomain.has(seenKey)) {
      continue;
    }
    seenProviderDomain.add(seenKey);
    if (!domainSection.toLowerCase().includes(providerKey)) {
      diagnostics.push({
        code: "missing-provider-authority",
        productDomain,
        providerKey: version.providerKey,
        unitKey: catalogProviderProfileVersionIngestionUnitKey(version),
        diagnosticText: `The '${title}' signoff section does not name provider '${version.providerKey}', which has an active production-capable unit. Shared-provider authority must be stated per product domain.`,
      });
    }
  }

  return diagnostics;
}

// Return the body of a `## <title>` section up to the next `## ` heading so
// provider-authority checks stay scoped to a single domain's section.
function extractSection(document: string, title: string): string {
  const heading = `## ${title}`;
  const start = document.indexOf(heading);
  if (start < 0) {
    return "";
  }
  const rest = document.slice(start + heading.length);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}
