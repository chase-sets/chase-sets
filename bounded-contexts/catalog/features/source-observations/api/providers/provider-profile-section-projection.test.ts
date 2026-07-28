import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  catalogProviderIntegrationProfileVersions,
  type CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import {
  assertCatalogProviderProfileSectionEtag,
  CatalogProviderProfileSectionConcurrencyError,
  listCatalogProviderProfileVersionSectionProjections,
  projectCatalogProviderProfileVersionSections,
  refreshCatalogProviderProfileVersionSectionProjections,
  type CatalogProviderProfileVersionSectionDiagnosticRow,
  type CatalogProviderProfileVersionSectionRow,
} from "./provider-profile-section-projection";

describe("Catalog provider profile section projection", () => {
  it("projects seeded profile versions into deterministic section rows with fingerprints", () => {
    const version = requireSeededVersion("tcgplayer", "pokemon-single-card-product-sku");
    const firstProjection = projectCatalogProviderProfileVersionSections(version);
    const secondProjection = projectCatalogProviderProfileVersionSections(version);

    expect(firstProjection.map((section) => section.sectionKey)).toEqual([
      "ingestion-unit-identity",
      "profile-identity",
      "profile-lifecycle",
      "source-contract",
      "fixture-contract",
      "provider-options",
      "connector-binding",
      "normalized-observation",
      "condition-certification-mapping",
      "external-references",
      "selected-options",
      "reference-hierarchy",
      "duplicate-prevention",
      "promotion-plan",
      "migration-evidence",
      "retirement-plan",
    ]);
    expect(firstProjection.map((section) => section.sectionFingerprint)).toEqual(
      secondProjection.map((section) => section.sectionFingerprint),
    );
    expect(firstProjection[0].sectionFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(
      firstProjection.every(
        (section) => section.ingestionUnitKey === "tcgplayer:pokemon:single-card:source-observation-import",
      ),
    ).toBe(true);
  });

  it("refreshes section and diagnostic rows from a canonical snapshot", async () => {
    const version = withoutUnknownOptionFixture(requireSeededVersion("tcgplayer", "pokemon-single-card-product-sku"));
    const db = recordingDb();

    const projections = await refreshCatalogProviderProfileVersionSectionProjections(db, version);

    expect(projections.find((section) => section.sectionKey === "fixture-contract")?.validationStatus).toBe("invalid");
    expect(db.statements[0]).toContain("DELETE FROM catalog_provider_profile_version_section_diagnostics");
    expect(db.statements[1]).toContain("DELETE FROM catalog_provider_profile_version_sections");
    expect(db.sectionRows).toHaveLength(16);
    expect(db.diagnosticRows).toContainEqual(
      expect.objectContaining({
        section_key: "fixture-contract",
        code: "fixture-missing-flow",
        path: "fixtures.coveredFlows.unknown-option",
      }),
    );
  });

  it("loads section metadata and diagnostics without parsing the full profile snapshot", async () => {
    const version = withoutUnknownOptionFixture(requireSeededVersion("tcgplayer", "pokemon-single-card-product-sku"));
    const db = recordingDb();
    await refreshCatalogProviderProfileVersionSectionProjections(db, version);

    const sections = await listCatalogProviderProfileVersionSectionProjections(db, {
      providerKey: "TCGPLAYER",
      profileVersion: version.profileVersion,
      profileKey: version.profileKey,
    });

    expect(sections).toHaveLength(16);
    expect(sections.find((section) => section.sectionKey === "fixture-contract")).toMatchObject({
      validationStatus: "invalid",
      diagnostics: [
        expect.objectContaining({
          code: "fixture-missing-flow",
          severity: "error",
        }),
      ],
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("FROM catalog_provider_profile_version_sections"), [
      "tcgplayer",
      "2026.06.05",
      "pokemon-single-card-product-sku",
    ]);
  });

  it("detects stale section edits through etag fingerprints", () => {
    const section = projectCatalogProviderProfileVersionSections(requireSeededVersion("tcgdex")).find(
      (candidate) => candidate.sectionKey === "source-contract",
    )!;

    expect(() => assertCatalogProviderProfileSectionEtag(section, section.sectionFingerprint)).not.toThrow();
    expect(() => assertCatalogProviderProfileSectionEtag(section, "sha256:stale")).toThrow(
      CatalogProviderProfileSectionConcurrencyError,
    );
  });
});

function requireSeededVersion(
  providerKey: string,
  profileKey?: string,
): CatalogProviderIntegrationProfileVersionRecord {
  const version = catalogProviderIntegrationProfileVersions.find(
    (candidate) => candidate.providerKey === providerKey && (!profileKey || candidate.profileKey === profileKey),
  );
  if (!version) {
    throw new Error(`Expected seeded ${providerKey} provider profile version.`);
  }
  return version;
}

function withoutUnknownOptionFixture(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIntegrationProfileVersionRecord {
  return {
    ...version,
    fixtures: {
      ...version.fixtures,
      coveredFlows: version.fixtures.coveredFlows.filter((flow) => flow !== "unknown-option"),
    },
    executableMappingContract: version.executableMappingContract
      ? {
          ...version.executableMappingContract,
          fixtures: {
            ...version.executableMappingContract.fixtures,
            coveredFlows: version.executableMappingContract.fixtures.coveredFlows.filter(
              (flow) => flow !== "unknown-option",
            ),
          },
        }
      : undefined,
  };
}

function recordingDb(): PgQueryable & {
  query: ReturnType<typeof vi.fn>;
  statements: string[];
  sectionRows: CatalogProviderProfileVersionSectionRow[];
  diagnosticRows: CatalogProviderProfileVersionSectionDiagnosticRow[];
} {
  const statements: string[] = [];
  const sectionRows: CatalogProviderProfileVersionSectionRow[] = [];
  const diagnosticRows: CatalogProviderProfileVersionSectionDiagnosticRow[] = [];

  return {
    statements,
    sectionRows,
    diagnosticRows,
    query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      statements.push(sql);

      if (sql.includes("DELETE FROM catalog_provider_profile_version_sections")) {
        sectionRows.length = 0;
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("DELETE FROM catalog_provider_profile_version_section_diagnostics")) {
        diagnosticRows.length = 0;
        return { rows: [], rowCount: 0 };
      }

      if (sql.includes("INSERT INTO catalog_provider_profile_version_sections")) {
        sectionRows.push({
          provider_key: String(params[0]),
          profile_key: String(params[1]),
          profile_version: String(params[2]),
          section_key: params[3] as CatalogProviderProfileVersionSectionRow["section_key"],
          ingestion_unit_key: String(params[4]),
          editable: Boolean(params[5]),
          validation_status: params[6] as CatalogProviderProfileVersionSectionRow["validation_status"],
          section_fingerprint: String(params[7]),
          section_json: String(params[8]),
          last_edited_at: typeof params[9] === "string" ? params[9] : null,
          last_edited_by_user_id: typeof params[10] === "string" ? params[10] : null,
          last_edited_for_account_id: typeof params[11] === "string" ? params[11] : null,
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("INSERT INTO catalog_provider_profile_version_section_diagnostics")) {
        diagnosticRows.push({
          provider_key: String(params[0]),
          profile_key: String(params[1]),
          profile_version: String(params[2]),
          section_key: params[3] as CatalogProviderProfileVersionSectionDiagnosticRow["section_key"],
          diagnostic_index: Number(params[4]),
          path: String(params[5]),
          severity: params[6] as CatalogProviderProfileVersionSectionDiagnosticRow["severity"],
          code: String(params[7]),
          diagnostic_text: String(params[8]),
        });
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes("FROM catalog_provider_profile_version_sections")) {
        return { rows: [...sectionRows], rowCount: sectionRows.length };
      }

      if (sql.includes("FROM catalog_provider_profile_version_section_diagnostics")) {
        return { rows: [...diagnosticRows], rowCount: diagnosticRows.length };
      }

      return { rows: [], rowCount: 0 };
    }),
  };
}
