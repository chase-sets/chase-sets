import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogIntegrationGovernedDataClassKey } from "./catalog-integration-data-governance";
import {
  catalogIntegrationDataGovernancePoliciesByKey,
  redactCatalogIntegrationProviderData,
} from "./catalog-integration-data-governance";
import type { CatalogIntegrationDiagnosticInstance } from "./catalog-integration-diagnostic-taxonomy";
import type {
  CatalogIntegrationSchemaCompatibilitySurfaceKey,
  CatalogIntegrationWireSchemaVersion,
} from "./catalog-integration-schema-compatibility";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import type { CatalogProviderProfileSectionKey } from "../providers/provider-profile-sections";

export type CatalogIntegrationAuditEvidenceEventName =
  | "profile-created"
  | "profile-cloned"
  | "profile-section-edited"
  | "fixture-validation-run"
  | "dry-run-executed"
  | "activation-readiness-evaluated"
  | "profile-activated"
  | "profile-deprecated"
  | "profile-rolled-back"
  | "profile-retired"
  | "import-job-started"
  | "import-job-completed"
  | "import-job-failed"
  | "source-observation-recorded"
  | "source-observation-changed"
  | "source-observation-promoted"
  | "source-observation-rejected"
  | "source-observation-deferred"
  | "promotion-plan-generated"
  | "promotion-plan-executed"
  | "reapply-run-executed"
  | "adapter-readiness-changed"
  | "provider-credential-readiness-changed"
  | "diagnostics-present";

export type CatalogIntegrationAuditEvidenceCategory =
  | "profile"
  | "profile-section"
  | "fixture-validation"
  | "dry-run"
  | "activation"
  | "import-job"
  | "source-observation"
  | "promotion"
  | "reapply"
  | "adapter-readiness"
  | "diagnostic";

export type CatalogIntegrationAuditActorKind = "operator" | "system" | "job-worker" | "provider-adapter";

export type CatalogIntegrationAuditEvidenceRedactionState = "not-needed" | "redacted" | "excluded";

export type CatalogIntegrationAuditActor = Readonly<{
  actorKind: CatalogIntegrationAuditActorKind;
  userId: string | null;
  accountId: string | null;
  displayName?: string | null;
}>;

export type CatalogIntegrationAuditEvidenceProfilePointer = Readonly<{
  schemaVersion: Extract<CatalogIntegrationWireSchemaVersion, "catalog-provider-profile-version-v1">;
  compatibilityPolicy: Extract<CatalogIntegrationSchemaCompatibilitySurfaceKey, "provider-profile-version">;
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  lifecycle: "draft" | "test" | "active" | "deprecated" | "retired" | string;
  active: boolean;
  connectorKind: string | null;
  connectorSourceVersion: string | null;
  sourceMappingFingerprint: string | null;
}>;

export type CatalogIntegrationAuditEvidenceTarget = Readonly<{
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogIntegrationAuditEvidenceProfilePointer | null;
  sectionKey: CatalogProviderProfileSectionKey | null;
  jobId: string | null;
  jobKind: string | null;
  observationId: string | null;
  catalogItemId: string | null;
  promotionPlanId: string | null;
  reapplyRunId: string | null;
}>;

export type CatalogIntegrationAuditEvidenceEntry = Readonly<{
  dataClass: CatalogIntegrationGovernedDataClassKey;
  summary: string;
  redactionState: CatalogIntegrationAuditEvidenceRedactionState;
  path: string | null;
  owner: "catalog" | "provider-adapter" | "platform";
  value?: JsonValue;
}>;

export type CatalogIntegrationAuditEvidenceRecord = Readonly<{
  schemaVersion: Extract<CatalogIntegrationWireSchemaVersion, "catalog-audit-evidence-record-v1">;
  compatibilityPolicy: Extract<CatalogIntegrationSchemaCompatibilitySurfaceKey, "audit-evidence-record">;
  eventId: string;
  eventName: CatalogIntegrationAuditEvidenceEventName;
  category: CatalogIntegrationAuditEvidenceCategory;
  occurredAt: string;
  actor: CatalogIntegrationAuditActor;
  target: CatalogIntegrationAuditEvidenceTarget;
  evidence: readonly CatalogIntegrationAuditEvidenceEntry[];
  diagnostics: readonly CatalogIntegrationDiagnosticInstance[];
  note: string | null;
}>;

export type CatalogIntegrationAuditEvidenceTimelineEntry = Readonly<{
  schemaVersion: Extract<CatalogIntegrationWireSchemaVersion, "catalog-audit-evidence-record-v1">;
  compatibilityPolicy: Extract<CatalogIntegrationSchemaCompatibilitySurfaceKey, "audit-evidence-record">;
  eventId: string;
  occurredAt: string;
  eventName: CatalogIntegrationAuditEvidenceEventName;
  category: CatalogIntegrationAuditEvidenceCategory;
  actorUserId: string | null;
  accountId: string | null;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  profile: CatalogIntegrationAuditEvidenceProfilePointer | null;
  sectionKey: CatalogProviderProfileSectionKey | null;
  evidenceSummary: string;
  evidence: readonly CatalogIntegrationAuditEvidenceEntry[];
  diagnosticCodes: readonly string[];
  relatedJobId: string | null;
  relatedObservationId: string | null;
  relatedCatalogItemId: string | null;
  promotionPlanId: string | null;
  reapplyRunId: string | null;
}>;

export const catalogIntegrationAuditEvidenceEventNames = [
  "profile-created",
  "profile-cloned",
  "profile-section-edited",
  "fixture-validation-run",
  "dry-run-executed",
  "activation-readiness-evaluated",
  "profile-activated",
  "profile-deprecated",
  "profile-rolled-back",
  "profile-retired",
  "import-job-started",
  "import-job-completed",
  "import-job-failed",
  "source-observation-recorded",
  "source-observation-changed",
  "source-observation-promoted",
  "source-observation-rejected",
  "source-observation-deferred",
  "promotion-plan-generated",
  "promotion-plan-executed",
  "reapply-run-executed",
  "adapter-readiness-changed",
  "provider-credential-readiness-changed",
  "diagnostics-present",
] as const satisfies readonly CatalogIntegrationAuditEvidenceEventName[];

const auditEventCategories = {
  "profile-created": "profile",
  "profile-cloned": "profile",
  "profile-section-edited": "profile-section",
  "fixture-validation-run": "fixture-validation",
  "dry-run-executed": "dry-run",
  "activation-readiness-evaluated": "activation",
  "profile-activated": "activation",
  "profile-deprecated": "activation",
  "profile-rolled-back": "activation",
  "profile-retired": "activation",
  "import-job-started": "import-job",
  "import-job-completed": "import-job",
  "import-job-failed": "import-job",
  "source-observation-recorded": "source-observation",
  "source-observation-changed": "source-observation",
  "source-observation-promoted": "source-observation",
  "source-observation-rejected": "source-observation",
  "source-observation-deferred": "source-observation",
  "promotion-plan-generated": "promotion",
  "promotion-plan-executed": "promotion",
  "reapply-run-executed": "reapply",
  "adapter-readiness-changed": "adapter-readiness",
  "provider-credential-readiness-changed": "adapter-readiness",
  "diagnostics-present": "diagnostic",
} as const satisfies Readonly<
  Record<CatalogIntegrationAuditEvidenceEventName, CatalogIntegrationAuditEvidenceCategory>
>;

const auditSensitivePathPattern =
  /authorization|bearer|cookie|password|secret|session|seller|email|phone|tcgauthticket|token|price|marketprice|inventory|quantity|listing/i;
const auditSensitiveTextPattern =
  /\b(Bearer\s+[a-z0-9._~+/=-]+|TCGAuthTicket(?:_Production)?=[^;\s]+|authorization\s*[:=]\s*(?:Bearer\s+)?[^,\s]+|cookie\s*[:=]\s*[^,\s]+|password\s*=\s*[^,\s]+|secret\s*=\s*[^,\s]+|token\s*=\s*[^,\s]+|seller(?:Id|Name|Email)?\s*=\s*[^,\s]+|price\s*=\s*[^,\s]+|inventory\s*=\s*[^,\s]+|quantity\s*=\s*[^,\s]+|listing\s*=\s*[^,\s]+)/gi;

export const CATALOG_INTEGRATION_AUDIT_REDACTED_VALUE = "<redacted-audit-evidence>";

export function createCatalogIntegrationAuditEvidenceRecord(
  input: Readonly<{
    eventId: string;
    eventName: CatalogIntegrationAuditEvidenceEventName;
    occurredAt: string;
    actor: Partial<CatalogIntegrationAuditActor> & Pick<CatalogIntegrationAuditActor, "actorKind">;
    target: Readonly<{
      providerKey: string;
      unitKey: CatalogIntegrationUnitKey;
      profile?: CatalogIntegrationAuditEvidenceProfilePointer | null;
      sectionKey?: CatalogProviderProfileSectionKey | null;
      jobId?: string | null;
      jobKind?: string | null;
      observationId?: string | null;
      catalogItemId?: string | null;
      promotionPlanId?: string | null;
      reapplyRunId?: string | null;
    }>;
    evidence?: readonly Readonly<{
      dataClass: CatalogIntegrationGovernedDataClassKey;
      summary: string;
      path?: string | null;
      owner?: "catalog" | "provider-adapter" | "platform";
      value?: JsonValue;
      redactionState?: CatalogIntegrationAuditEvidenceRedactionState;
    }>[];
    diagnostics?: readonly CatalogIntegrationDiagnosticInstance[];
    note?: string | null;
  }>,
): CatalogIntegrationAuditEvidenceRecord {
  const providerKey = normalizeProviderKey(input.target.providerKey);

  return {
    schemaVersion: "catalog-audit-evidence-record-v1",
    compatibilityPolicy: "audit-evidence-record",
    eventId: normalizeRequiredKey(input.eventId, "eventId"),
    eventName: input.eventName,
    category: auditEventCategories[input.eventName],
    occurredAt: normalizeRequiredKey(input.occurredAt, "occurredAt"),
    actor: normalizeActor(input.actor),
    target: {
      providerKey,
      unitKey: input.target.unitKey,
      profile: input.target.profile ?? null,
      sectionKey: input.target.sectionKey ?? null,
      jobId: normalizeOptionalString(input.target.jobId),
      jobKind: normalizeOptionalString(input.target.jobKind),
      observationId: normalizeOptionalString(input.target.observationId),
      catalogItemId: normalizeOptionalString(input.target.catalogItemId),
      promotionPlanId: normalizeOptionalString(input.target.promotionPlanId),
      reapplyRunId: normalizeOptionalString(input.target.reapplyRunId),
    },
    evidence: (input.evidence ?? []).map(normalizeEvidenceEntry),
    diagnostics: input.diagnostics ?? [],
    note: input.note ? redactAuditEvidenceText(input.note) : null,
  };
}

export function catalogIntegrationAuditEvidenceRecordToTimelineEntry(
  record: CatalogIntegrationAuditEvidenceRecord,
): CatalogIntegrationAuditEvidenceTimelineEntry {
  return {
    schemaVersion: record.schemaVersion,
    compatibilityPolicy: record.compatibilityPolicy,
    eventId: record.eventId,
    occurredAt: record.occurredAt,
    eventName: record.eventName,
    category: record.category,
    actorUserId: record.actor.userId,
    accountId: record.actor.accountId,
    providerKey: record.target.providerKey,
    unitKey: record.target.unitKey,
    profile: record.target.profile,
    sectionKey: record.target.sectionKey,
    evidenceSummary: summarizeAuditEvidence(record),
    evidence: record.evidence,
    diagnosticCodes: record.diagnostics.map((diagnostic) => diagnostic.code),
    relatedJobId: record.target.jobId,
    relatedObservationId: record.target.observationId,
    relatedCatalogItemId: record.target.catalogItemId,
    promotionPlanId: record.target.promotionPlanId,
    reapplyRunId: record.target.reapplyRunId,
  };
}

export function redactCatalogIntegrationAuditEvidenceValue(value: JsonValue): JsonValue {
  return redactAuditEvidenceValue(redactCatalogIntegrationProviderData(value), []);
}

export function redactCatalogIntegrationAuditEvidenceText(value: string): string {
  return redactAuditEvidenceText(value);
}

function normalizeEvidenceEntry(
  input: Readonly<{
    dataClass: CatalogIntegrationGovernedDataClassKey;
    summary: string;
    path?: string | null;
    owner?: "catalog" | "provider-adapter" | "platform";
    value?: JsonValue;
    redactionState?: CatalogIntegrationAuditEvidenceRedactionState;
  }>,
): CatalogIntegrationAuditEvidenceEntry {
  const policy = catalogIntegrationDataGovernancePoliciesByKey[input.dataClass];
  const redactedValue =
    input.value === undefined || policy.rawBodyPolicy === "forbidden"
      ? undefined
      : redactCatalogIntegrationAuditEvidenceValue(input.value);
  const valueWasRedacted = input.value !== undefined && JSON.stringify(input.value) !== JSON.stringify(redactedValue);
  const redactionState =
    policy.rawBodyPolicy === "forbidden"
      ? "excluded"
      : (input.redactionState ?? (valueWasRedacted ? "redacted" : "not-needed"));

  return {
    dataClass: input.dataClass,
    summary: redactAuditEvidenceText(input.summary),
    redactionState,
    path: normalizeOptionalString(input.path),
    owner: input.owner ?? ownerFromDataClass(input.dataClass),
    ...(redactionState === "excluded" || redactedValue === undefined ? {} : { value: redactedValue }),
  };
}

function summarizeAuditEvidence(record: CatalogIntegrationAuditEvidenceRecord): string {
  if (record.evidence.length === 0) {
    return record.note ?? record.eventName;
  }

  return record.evidence.map((entry) => entry.summary).join("; ");
}

function normalizeActor(
  actor: Partial<CatalogIntegrationAuditActor> & Pick<CatalogIntegrationAuditActor, "actorKind">,
): CatalogIntegrationAuditActor {
  return {
    actorKind: actor.actorKind,
    userId: normalizeOptionalString(actor.userId),
    accountId: normalizeOptionalString(actor.accountId),
    ...(actor.displayName ? { displayName: redactAuditEvidenceText(actor.displayName) } : {}),
  };
}

function ownerFromDataClass(
  dataClass: CatalogIntegrationGovernedDataClassKey,
): "catalog" | "provider-adapter" | "platform" {
  const policy = catalogIntegrationDataGovernancePoliciesByKey[dataClass];
  if (policy.owner === "provider-adapter") {
    return "provider-adapter";
  }

  return dataClass === "job-progress-summary" ? "platform" : "catalog";
}

function redactAuditEvidenceValue(value: JsonValue, path: readonly string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactAuditEvidenceValue(entry, [...path, String(index)]));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const nextPath = [...path, key];
        return [
          key,
          auditSensitivePathPattern.test(nextPath.join("."))
            ? entry === "<redacted>"
              ? entry
              : CATALOG_INTEGRATION_AUDIT_REDACTED_VALUE
            : redactAuditEvidenceValue(entry as JsonValue, nextPath),
        ];
      }),
    ) as JsonValue;
  }

  if (typeof value === "string") {
    return redactAuditEvidenceText(value);
  }

  return value;
}

function redactAuditEvidenceText(value: string): string {
  return value.replace(auditSensitiveTextPattern, CATALOG_INTEGRATION_AUDIT_REDACTED_VALUE);
}

function normalizeRequiredKey(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Catalog audit/evidence ${field} is required.`);
  }

  return normalized;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}

function normalizeProviderKey(providerKey: string): string {
  return normalizeRequiredKey(providerKey, "target.providerKey").toLowerCase();
}
