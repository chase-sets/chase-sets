export const PLACEHOLDER_EVIDENCE_REFERENCE_PATTERN =
  /^(?:tbd|todo|none|null|n\/a|na|placeholder|example|sample|test|ticket|record|launch-000)$/i;

export function validateEvidenceReference(label, value, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} is required.`);
    return;
  }

  const normalized = value.trim();
  if (!isValidEvidenceReference(normalized)) {
    errors.push(`${label} must point to a real external evidence record, not a placeholder.`);
  }
}

export function validateEvidenceIdentifier(label, value, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${label} is required.`);
    return;
  }

  const normalized = value.trim();
  if (!isValidEvidenceReference(normalized)) {
    errors.push(`${label} must be a concrete identifier, not a placeholder.`);
  }
}

export function isValidEvidenceReference(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }
  const normalized = value.trim();
  return normalized.length >= 6 && !PLACEHOLDER_EVIDENCE_REFERENCE_PATTERN.test(normalized);
}

export function validateEvidenceReferences(label, record, fields, errors) {
  for (const field of fields) {
    const value = record[field];
    if (isNonEmptyString(value)) {
      validateEvidenceReference(`${label} ${field}`, value, errors);
    }
  }
}

export function isIsoTimestamp(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}
