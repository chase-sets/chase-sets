import { createHash } from "node:crypto";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import { stableJsonStringify } from "../source-observation-job-serialization";
import {
  catalogProviderProfileEditableSectionKeys,
  CatalogProviderProfileSectionValidationError,
  getCatalogProviderProfileSectionDefinition,
  type CatalogProviderProfileEditableSectionKey,
} from "./provider-profile-section-registry";

export class CatalogProviderProfileEditableSectionChangedError extends Error {
  readonly code = "profile_section_changed";

  constructor(section: CatalogProviderProfileEditableSectionKey) {
    super(`Catalog provider profile section '${section}' has changed; reload before saving.`);
    this.name = "CatalogProviderProfileEditableSectionChangedError";
  }
}

/**
 * A section's revision as an operator saw it: a hash of the stored values its command composes over.
 * Another section's change leaves it as it was, so editing one section never conflicts with another.
 */
export function catalogProviderProfileEditableSectionFingerprint(
  version: CatalogProviderIntegrationProfileVersionRecord,
  section: CatalogProviderProfileEditableSectionKey,
): string {
  const definition = getCatalogProviderProfileSectionDefinition(section);
  if (!definition) {
    throw new CatalogProviderProfileSectionValidationError("Unsupported profile section update command.");
  }
  return `sha256:${createHash("sha256")
    .update(stableJsonStringify(definition.readState(version)))
    .digest("hex")}`;
}

export function catalogProviderProfileEditableSectionFingerprints(
  version: CatalogProviderIntegrationProfileVersionRecord,
): Readonly<Record<CatalogProviderProfileEditableSectionKey, string>> {
  return Object.fromEntries(
    catalogProviderProfileEditableSectionKeys.map((section) => [
      section,
      catalogProviderProfileEditableSectionFingerprint(version, section),
    ]),
  ) as Record<CatalogProviderProfileEditableSectionKey, string>;
}

export function assertCatalogProviderProfileEditableSectionFingerprint(
  version: CatalogProviderIntegrationProfileVersionRecord,
  section: CatalogProviderProfileEditableSectionKey,
  expectedFingerprint: string,
): void {
  if (catalogProviderProfileEditableSectionFingerprint(version, section) !== expectedFingerprint) {
    throw new CatalogProviderProfileEditableSectionChangedError(section);
  }
}
