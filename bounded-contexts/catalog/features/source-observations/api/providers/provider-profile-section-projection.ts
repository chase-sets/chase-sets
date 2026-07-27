import { createHash } from "node:crypto";
import { toJsonValue, type JsonValue } from "@chase-sets/primitives/json";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type {
  CatalogProviderIntegrationProfileAuthoringAudit,
  CatalogProviderIntegrationProfileVersionRecord,
} from "../provider-integration-profiles";
import {
  assembleCatalogProviderIngestionUnitProfileSections,
  type CatalogProviderIngestionUnitProfileSections,
  type CatalogProviderProfileSectionDiagnostic,
  type CatalogProviderProfileSectionKey,
  type CatalogProviderProfileSectionValidation,
} from "./provider-profile-sections";

type CatalogProviderIngestionUnitProfileSection =
  CatalogProviderIngestionUnitProfileSections[keyof CatalogProviderIngestionUnitProfileSections];

export type CatalogProviderProfileVersionSectionProjection = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  sectionKey: CatalogProviderProfileSectionKey;
  ingestionUnitKey: CatalogIntegrationUnitKey;
  editable: boolean;
  validationStatus: CatalogProviderProfileSectionValidation["status"];
  sectionFingerprint: string;
  sectionJson: CatalogProviderIngestionUnitProfileSection;
  lastEditedAt: string | null;
  lastEditedByUserId: string | null;
  lastEditedForAccountId: string | null;
  diagnostics: readonly CatalogProviderProfileSectionDiagnostic[];
}>;

export type CatalogProviderProfileVersionSectionRow = Readonly<{
  provider_key: string;
  profile_key: string;
  profile_version: string;
  section_key: CatalogProviderProfileSectionKey;
  ingestion_unit_key: string;
  editable: boolean;
  validation_status: CatalogProviderProfileSectionValidation["status"];
  section_fingerprint: string;
  section_json: CatalogProviderIngestionUnitProfileSection | string;
  last_edited_at: string | null;
  last_edited_by_user_id: string | null;
  last_edited_for_account_id: string | null;
}>;

export type CatalogProviderProfileVersionSectionDiagnosticRow = Readonly<{
  provider_key: string;
  profile_key: string;
  profile_version: string;
  section_key: CatalogProviderProfileSectionKey;
  diagnostic_index: number;
  path: string;
  severity: CatalogProviderProfileSectionDiagnostic["severity"];
  code: string;
  diagnostic_text: string;
}>;

export class CatalogProviderProfileSectionConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogProviderProfileSectionConcurrencyError";
  }
}

export function projectCatalogProviderProfileVersionSections(
  version: CatalogProviderIntegrationProfileVersionRecord,
): readonly CatalogProviderProfileVersionSectionProjection[] {
  const sections = Object.values(
    assembleCatalogProviderIngestionUnitProfileSections(version),
  ) as CatalogProviderIngestionUnitProfileSection[];

  return sections.map((section) => ({
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    sectionKey: section.sectionKey,
    ingestionUnitKey: section.ingestionUnitKey,
    editable: section.editable,
    validationStatus: section.validation.status,
    sectionFingerprint: catalogProviderProfileSectionFingerprint(section),
    sectionJson: section,
    ...lastEditedMetadata(version.authoringAudit ?? null),
    diagnostics: section.validation.diagnostics,
  }));
}

export async function refreshCatalogProviderProfileVersionSectionProjections(
  db: PgQueryable,
  version: CatalogProviderIntegrationProfileVersionRecord,
): Promise<readonly CatalogProviderProfileVersionSectionProjection[]> {
  const projections = projectCatalogProviderProfileVersionSections(version);

  await db.query(
    `DELETE FROM catalog_provider_profile_version_section_diagnostics
     WHERE provider_key = $1 AND profile_key = $2 AND profile_version = $3`,
    [version.providerKey, version.profileKey, version.profileVersion],
  );
  await db.query(
    `DELETE FROM catalog_provider_profile_version_sections
     WHERE provider_key = $1 AND profile_key = $2 AND profile_version = $3`,
    [version.providerKey, version.profileKey, version.profileVersion],
  );

  for (const projection of projections) {
    await db.query(
      `INSERT INTO catalog_provider_profile_version_sections (
         provider_key,
         profile_key,
         profile_version,
         section_key,
         ingestion_unit_key,
         editable,
         validation_status,
         section_fingerprint,
         section_json,
         last_edited_at,
         last_edited_by_user_id,
         last_edited_for_account_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)`,
      [
        projection.providerKey,
        projection.profileKey,
        projection.profileVersion,
        projection.sectionKey,
        projection.ingestionUnitKey,
        projection.editable,
        projection.validationStatus,
        projection.sectionFingerprint,
        JSON.stringify(projection.sectionJson),
        projection.lastEditedAt,
        projection.lastEditedByUserId,
        projection.lastEditedForAccountId,
      ],
    );

    for (const [index, diagnostic] of projection.diagnostics.entries()) {
      await db.query(
        `INSERT INTO catalog_provider_profile_version_section_diagnostics (
           provider_key,
           profile_key,
           profile_version,
           section_key,
           diagnostic_index,
           path,
           severity,
           code,
           diagnostic_text
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          projection.providerKey,
          projection.profileKey,
          projection.profileVersion,
          projection.sectionKey,
          index,
          diagnostic.path,
          diagnostic.severity,
          diagnostic.code,
          diagnostic.diagnosticText,
        ],
      );
    }
  }

  return projections;
}

export async function listCatalogProviderProfileVersionSectionProjections(
  db: PgQueryable,
  input: Readonly<{ providerKey: string; profileVersion: string; profileKey?: string | null }>,
): Promise<readonly CatalogProviderProfileVersionSectionProjection[]> {
  const profileKey = input.profileKey?.trim() ?? "";
  const sectionResult =
    profileKey.length > 0
      ? await db.query<CatalogProviderProfileVersionSectionRow>(
          `SELECT *
           FROM catalog_provider_profile_version_sections
           WHERE provider_key = $1 AND profile_version = $2 AND profile_key = $3
           ORDER BY section_key ASC`,
          [input.providerKey.trim().toLowerCase(), input.profileVersion.trim(), profileKey],
        )
      : await db.query<CatalogProviderProfileVersionSectionRow>(
          `SELECT *
           FROM catalog_provider_profile_version_sections
           WHERE provider_key = $1 AND profile_version = $2
           ORDER BY profile_key ASC, section_key ASC`,
          [input.providerKey.trim().toLowerCase(), input.profileVersion.trim()],
        );

  const diagnosticResult =
    profileKey.length > 0
      ? await db.query<CatalogProviderProfileVersionSectionDiagnosticRow>(
          `SELECT *
           FROM catalog_provider_profile_version_section_diagnostics
           WHERE provider_key = $1 AND profile_version = $2 AND profile_key = $3
           ORDER BY section_key ASC, diagnostic_index ASC`,
          [input.providerKey.trim().toLowerCase(), input.profileVersion.trim(), profileKey],
        )
      : await db.query<CatalogProviderProfileVersionSectionDiagnosticRow>(
          `SELECT *
           FROM catalog_provider_profile_version_section_diagnostics
           WHERE provider_key = $1 AND profile_version = $2
           ORDER BY profile_key ASC, section_key ASC, diagnostic_index ASC`,
          [input.providerKey.trim().toLowerCase(), input.profileVersion.trim()],
        );

  return sectionResult.rows.map((row) =>
    sectionProjectionFromRows(
      row,
      diagnosticResult.rows.filter(
        (diagnostic) =>
          diagnostic.provider_key === row.provider_key &&
          diagnostic.profile_key === row.profile_key &&
          diagnostic.profile_version === row.profile_version &&
          diagnostic.section_key === row.section_key,
      ),
    ),
  );
}

export async function getCatalogProviderProfileVersionSectionProjection(
  db: PgQueryable,
  input: Readonly<{
    providerKey: string;
    profileVersion: string;
    sectionKey: CatalogProviderProfileSectionKey;
    profileKey?: string | null;
  }>,
): Promise<CatalogProviderProfileVersionSectionProjection | null> {
  return (
    (await listCatalogProviderProfileVersionSectionProjections(db, input)).find(
      (section) => section.sectionKey === input.sectionKey,
    ) ?? null
  );
}

export function assertCatalogProviderProfileSectionEtag(
  section: Pick<CatalogProviderProfileVersionSectionProjection, "sectionKey" | "sectionFingerprint">,
  expectedFingerprint: string,
): void {
  if (section.sectionFingerprint !== expectedFingerprint) {
    throw new CatalogProviderProfileSectionConcurrencyError(
      `Catalog provider profile section '${section.sectionKey}' has changed; reload before saving.`,
    );
  }
}

export function catalogProviderProfileSectionFingerprint(section: CatalogProviderIngestionUnitProfileSection): string {
  return `sha256:${createHash("sha256")
    .update(stableJsonStringify(toJsonValue(section)))
    .digest("hex")}`;
}

function sectionProjectionFromRows(
  row: CatalogProviderProfileVersionSectionRow,
  diagnostics: readonly CatalogProviderProfileVersionSectionDiagnosticRow[],
): CatalogProviderProfileVersionSectionProjection {
  return {
    providerKey: row.provider_key,
    profileKey: row.profile_key,
    profileVersion: row.profile_version,
    sectionKey: row.section_key,
    ingestionUnitKey: row.ingestion_unit_key,
    editable: row.editable,
    validationStatus: row.validation_status,
    sectionFingerprint: row.section_fingerprint,
    sectionJson: parseJsonField<CatalogProviderIngestionUnitProfileSection>(row.section_json),
    lastEditedAt: row.last_edited_at,
    lastEditedByUserId: row.last_edited_by_user_id,
    lastEditedForAccountId: row.last_edited_for_account_id,
    diagnostics: diagnostics.map((diagnostic) => ({
      path: diagnostic.path,
      severity: diagnostic.severity,
      code: diagnostic.code,
      diagnosticText: diagnostic.diagnostic_text,
    })),
  };
}

function lastEditedMetadata(
  audit: CatalogProviderIntegrationProfileAuthoringAudit | null,
): Pick<
  CatalogProviderProfileVersionSectionProjection,
  "lastEditedAt" | "lastEditedByUserId" | "lastEditedForAccountId"
> {
  return {
    lastEditedAt: audit?.updatedAt ?? audit?.createdAt ?? null,
    lastEditedByUserId: audit?.updatedByUserId ?? audit?.createdByUserId ?? null,
    lastEditedForAccountId: audit?.updatedForAccountId ?? audit?.createdForAccountId ?? null,
  };
}

function stableJsonStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const objectValue = value as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(objectValue)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(objectValue[key] as JsonValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function parseJsonField<T>(value: T | string): T {
  return typeof value === "string" ? (JSON.parse(value) as T) : value;
}
