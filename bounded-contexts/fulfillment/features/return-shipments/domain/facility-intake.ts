import { assert, ensureIsoTimestamp, normalizeOptionalText, normalizeRequiredText } from "./common";

export const RETURN_INTAKE_EVIDENCE_RETENTION_DAYS = 365;

export const returnIntakeDiscrepancyTypes = [
  "expected",
  "missing",
  "extra",
  "substituted",
  "damaged",
  "empty-package",
  "unreadable",
] as const;

export type ReturnIntakeDiscrepancyType = (typeof returnIntakeDiscrepancyTypes)[number];

export const returnIntakePackageConditions = ["intact", "damaged", "opened", "empty", "unreadable"] as const;
export type ReturnIntakePackageCondition = (typeof returnIntakePackageConditions)[number];

export const returnIntakeSealConditions = ["intact", "broken", "missing", "not-applicable", "unreadable"] as const;
export type ReturnIntakeSealCondition = (typeof returnIntakeSealConditions)[number];

export const returnIntakeDispositions = ["completed", "quarantine", "manual-review"] as const;
export type ReturnIntakeDisposition = (typeof returnIntakeDispositions)[number];

export type ReturnIntakeEvidenceAttachment = Readonly<{
  attachmentId: string;
  storageKey: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  byteSize: number;
  sha256: string;
  uploadedAt: string;
  retentionUntil: string;
  securityScanStatus: "clean";
}>;

export type ReturnIntakeDiscrepancy = Readonly<{
  type: ReturnIntakeDiscrepancyType;
  expectedItemReference: string | null;
  observedItemReference: string | null;
  quantity: number;
  notes: string | null;
  evidenceAttachmentIds: readonly string[];
  owner: string;
  nextAction: string;
}>;

export type ReturnShipmentFacilityIntake = Readonly<{
  facilityId: string;
  stationId: string;
  operatorUserId: string;
  receivedAt: string;
  packageCondition: ReturnIntakePackageCondition;
  sealCondition: ReturnIntakeSealCondition;
  measuredWeightOunces: number | null;
  evidence: readonly ReturnIntakeEvidenceAttachment[];
  discrepancies: readonly ReturnIntakeDiscrepancy[];
  disposition: ReturnIntakeDisposition;
  custodyIdentifier: string;
  idempotencyKey: string;
}>;

export type ReturnShipmentIntakeCorrection = Readonly<{
  correctionId: string;
  reason: string;
  correctedByUserId: string;
  correctedAt: string;
  owner: string | null;
  nextAction: string | null;
  custodyIdentifier: string | null;
}>;

function oneOf<const T extends readonly string[]>(value: string, values: T, message: string): T[number] {
  const normalized = value.trim().toLowerCase();
  assert(values.includes(normalized), message);
  return normalized as T[number];
}

export function normalizeReturnIntakeEvidence(
  input: ReturnIntakeEvidenceAttachment,
  receivedAt: string,
): ReturnIntakeEvidenceAttachment {
  const uploadedAt = ensureIsoTimestamp(input.uploadedAt, "Evidence upload must record a timestamp.");
  const retentionUntil = ensureIsoTimestamp(input.retentionUntil, "Evidence must record its retention deadline.");
  assert(Date.parse(retentionUntil) > Date.parse(uploadedAt), "Evidence retention must extend beyond upload.");
  assert(
    Date.parse(retentionUntil) === Date.parse(uploadedAt) + RETURN_INTAKE_EVIDENCE_RETENTION_DAYS * 86_400_000,
    "Evidence retention must use the facility intake retention policy.",
  );
  assert(Date.parse(uploadedAt) <= Date.parse(receivedAt), "Evidence cannot be uploaded after intake completion.");
  assert(input.securityScanStatus === "clean", "Only evidence that passed the security scan can complete intake.");
  assert(
    input.contentType === "image/jpeg" || input.contentType === "image/png" || input.contentType === "image/webp",
    "Intake evidence must be a JPEG, PNG, or WebP image.",
  );
  assert(Number.isInteger(input.byteSize) && input.byteSize > 0, "Evidence byte size must be a positive integer.");
  assert(/^[a-f0-9]{64}$/.test(input.sha256), "Evidence must include a SHA-256 digest.");
  return {
    attachmentId: normalizeRequiredText(input.attachmentId, "Evidence attachment id is required."),
    storageKey: normalizeRequiredText(input.storageKey, "Evidence storage key is required."),
    contentType: input.contentType,
    byteSize: input.byteSize,
    sha256: input.sha256,
    uploadedAt,
    retentionUntil,
    securityScanStatus: "clean",
  };
}

function normalizeDiscrepancy(
  input: ReturnIntakeDiscrepancy,
  availableAttachmentIds: ReadonlySet<string>,
): ReturnIntakeDiscrepancy {
  const type = oneOf(
    input.type,
    returnIntakeDiscrepancyTypes,
    "Intake state must be expected, missing, extra, substituted, damaged, empty-package, or unreadable.",
  );
  const evidenceAttachmentIds = [...new Set(input.evidenceAttachmentIds.map((id) => id.trim()).filter(Boolean))];
  assert(
    evidenceAttachmentIds.every((id) => availableAttachmentIds.has(id)),
    "Every discrepancy evidence reference must belong to this intake.",
  );
  if (type !== "expected") {
    assert(evidenceAttachmentIds.length > 0, "A discrepancy requires at least one evidence attachment.");
  }
  return {
    type,
    expectedItemReference: normalizeOptionalText(input.expectedItemReference),
    observedItemReference: normalizeOptionalText(input.observedItemReference),
    quantity: Math.max(1, Math.floor(input.quantity)),
    notes: normalizeOptionalText(input.notes),
    evidenceAttachmentIds,
    owner: normalizeRequiredText(input.owner, "Every intake state requires an owner."),
    nextAction: normalizeRequiredText(input.nextAction, "Every intake state requires a next action."),
  };
}

export function normalizeReturnShipmentFacilityIntake(
  input: ReturnShipmentFacilityIntake,
): ReturnShipmentFacilityIntake {
  const receivedAt = ensureIsoTimestamp(input.receivedAt, "Facility intake must record a receipt timestamp.");
  const evidence = input.evidence.map((attachment) => normalizeReturnIntakeEvidence(attachment, receivedAt));
  assert(evidence.length > 0, "Facility intake requires at least one custody evidence attachment.");
  const attachmentIds = new Set(evidence.map((attachment) => attachment.attachmentId));
  assert(attachmentIds.size === evidence.length, "Evidence attachment ids must be unique within an intake.");
  assert(input.discrepancies.length > 0, "Intake must record at least one expected or discrepancy state.");
  const discrepancies = input.discrepancies.map((entry) => normalizeDiscrepancy(entry, attachmentIds));
  const disposition = oneOf(
    input.disposition,
    returnIntakeDispositions,
    "Intake disposition must be completed, quarantine, or manual-review.",
  );
  const hasDiscrepancy = discrepancies.some((entry) => entry.type !== "expected");
  if (hasDiscrepancy) {
    assert(disposition !== "completed", "A discrepancy must route to quarantine or manual review.");
  }
  const measuredWeightOunces = input.measuredWeightOunces;
  assert(
    measuredWeightOunces === null || (Number.isFinite(measuredWeightOunces) && measuredWeightOunces > 0),
    "Measured weight must be a positive number when recorded.",
  );
  return {
    facilityId: normalizeRequiredText(input.facilityId, "Intake facility is required."),
    stationId: normalizeRequiredText(input.stationId, "Intake station is required."),
    operatorUserId: normalizeRequiredText(input.operatorUserId, "Intake operator is required."),
    receivedAt,
    packageCondition: oneOf(
      input.packageCondition,
      returnIntakePackageConditions,
      "Package condition must be intact, damaged, opened, empty, or unreadable.",
    ),
    sealCondition: oneOf(
      input.sealCondition,
      returnIntakeSealConditions,
      "Seal condition must be intact, broken, missing, not-applicable, or unreadable.",
    ),
    measuredWeightOunces,
    evidence,
    discrepancies,
    disposition,
    custodyIdentifier: normalizeRequiredText(input.custodyIdentifier, "A custody identifier is required."),
    idempotencyKey: normalizeRequiredText(input.idempotencyKey, "Intake requires an idempotency key."),
  };
}

export function normalizeReturnShipmentIntakeCorrection(
  input: ReturnShipmentIntakeCorrection,
): ReturnShipmentIntakeCorrection {
  const owner = normalizeOptionalText(input.owner);
  const nextAction = normalizeOptionalText(input.nextAction);
  const custodyIdentifier = normalizeOptionalText(input.custodyIdentifier);
  assert(
    owner !== null || nextAction !== null || custodyIdentifier !== null,
    "A correction must change at least one field.",
  );
  return {
    correctionId: normalizeRequiredText(input.correctionId, "Correction id is required."),
    reason: normalizeRequiredText(input.reason, "A correction reason is required."),
    correctedByUserId: normalizeRequiredText(input.correctedByUserId, "Correction operator is required."),
    correctedAt: ensureIsoTimestamp(input.correctedAt, "Correction must record a timestamp."),
    owner,
    nextAction,
    custodyIdentifier,
  };
}
