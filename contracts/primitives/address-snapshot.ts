export type AddressSnapshot = Readonly<{
  name: string;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone?: string | null;
  email?: string | null;
}>;

export type AddressSnapshotSide = "sender" | "recipient";

function normalizeRequiredText(value: unknown, fieldName: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.length > 0 ? normalized : null;
}

export function normalizeAddressSnapshot(
  address: AddressSnapshot | null | undefined,
  fieldPrefix = "Address",
): AddressSnapshot {
  const fields = typeof address === "object" && address !== null ? address : ({} as Partial<AddressSnapshot>);

  return {
    name: normalizeRequiredText(fields.name, `${fieldPrefix} name`),
    company: normalizeOptionalText(fields.company),
    line1: normalizeRequiredText(fields.line1, `${fieldPrefix} line 1`),
    line2: normalizeOptionalText(fields.line2),
    city: normalizeRequiredText(fields.city, `${fieldPrefix} city`),
    state: normalizeRequiredText(fields.state, `${fieldPrefix} state`),
    postalCode: normalizeRequiredText(fields.postalCode, `${fieldPrefix} postal code`),
    country: normalizeRequiredText(fields.country, `${fieldPrefix} country`).toUpperCase(),
    phone: normalizeOptionalText(fields.phone),
    email: normalizeOptionalText(fields.email),
  };
}

export function addressSnapshotsEqual(left: AddressSnapshot, right: AddressSnapshot) {
  const normalizedLeft = normalizeAddressSnapshot(left);
  const normalizedRight = normalizeAddressSnapshot(right);

  return (
    normalizedLeft.name === normalizedRight.name &&
    normalizedLeft.company === normalizedRight.company &&
    normalizedLeft.line1 === normalizedRight.line1 &&
    normalizedLeft.line2 === normalizedRight.line2 &&
    normalizedLeft.city === normalizedRight.city &&
    normalizedLeft.state === normalizedRight.state &&
    normalizedLeft.postalCode === normalizedRight.postalCode &&
    normalizedLeft.country === normalizedRight.country &&
    normalizedLeft.phone === normalizedRight.phone &&
    normalizedLeft.email === normalizedRight.email
  );
}

export function changedAddressSnapshotSide(senderChanged: boolean, recipientChanged: boolean) {
  if (senderChanged && recipientChanged) {
    return "both" as const;
  }
  if (senderChanged) {
    return "sender" as const;
  }
  if (recipientChanged) {
    return "recipient" as const;
  }
  return null;
}
