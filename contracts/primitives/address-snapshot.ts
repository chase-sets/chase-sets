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
  verification?: AddressVerificationSnapshot | null;
}>;

export type AddressVerificationSnapshot = Readonly<{
  status: "verified" | "corrected" | "unverified" | "undeliverable";
  source: string;
  checkedAt: string;
  buyerDecision?: "accepted-suggested" | "kept-original" | "provider-unavailable" | null;
  suggestedAddress?: Omit<AddressSnapshot, "verification"> | null;
  messages?: readonly string[];
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

function normalizeAddressVerification(value: unknown): AddressVerificationSnapshot | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const fields = value as Partial<AddressVerificationSnapshot>;
  const status =
    fields.status === "verified" ||
    fields.status === "corrected" ||
    fields.status === "unverified" ||
    fields.status === "undeliverable"
      ? fields.status
      : null;
  if (!status) {
    return null;
  }

  const source = normalizeOptionalText(fields.source) ?? "unknown";
  const checkedAt = normalizeOptionalText(fields.checkedAt) ?? new Date(0).toISOString();
  const buyerDecision =
    fields.buyerDecision === "accepted-suggested" ||
    fields.buyerDecision === "kept-original" ||
    fields.buyerDecision === "provider-unavailable"
      ? fields.buyerDecision
      : null;
  const suggestedAddress =
    typeof fields.suggestedAddress === "object" && fields.suggestedAddress !== null
      ? addressWithoutVerification(normalizeAddressSnapshot(fields.suggestedAddress, "Suggested address"))
      : null;
  const messages = Array.isArray(fields.messages)
    ? fields.messages.flatMap((message) => {
        const normalized = normalizeOptionalText(message);
        return normalized ? [normalized] : [];
      })
    : [];

  return {
    status,
    source,
    checkedAt,
    ...(buyerDecision ? { buyerDecision } : {}),
    ...(suggestedAddress ? { suggestedAddress } : {}),
    ...(messages.length > 0 ? { messages } : {}),
  };
}

function addressWithoutVerification(address: AddressSnapshot): Omit<AddressSnapshot, "verification"> {
  return {
    name: address.name,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
    phone: address.phone,
    email: address.email,
  };
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
    verification: normalizeAddressVerification(fields.verification),
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
