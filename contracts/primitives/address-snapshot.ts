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

function normalizeRequiredText(value: string, fieldName: string) {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

function normalizeOptionalText(value?: string | null) {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function normalizeAddressSnapshot(
  address: AddressSnapshot,
  fieldPrefix = "Address",
): AddressSnapshot {
  return {
    name: normalizeRequiredText(address.name, `${fieldPrefix} name`),
    company: normalizeOptionalText(address.company),
    line1: normalizeRequiredText(address.line1, `${fieldPrefix} line 1`),
    line2: normalizeOptionalText(address.line2),
    city: normalizeRequiredText(address.city, `${fieldPrefix} city`),
    state: normalizeRequiredText(address.state, `${fieldPrefix} state`),
    postalCode: normalizeRequiredText(address.postalCode, `${fieldPrefix} postal code`),
    country: normalizeRequiredText(address.country, `${fieldPrefix} country`).toUpperCase(),
    phone: normalizeOptionalText(address.phone),
    email: normalizeOptionalText(address.email),
  };
}

export function addressSnapshotsEqual(
  left: AddressSnapshot,
  right: AddressSnapshot,
) {
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

export function changedAddressSnapshotSide(
  senderChanged: boolean,
  recipientChanged: boolean,
) {
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
