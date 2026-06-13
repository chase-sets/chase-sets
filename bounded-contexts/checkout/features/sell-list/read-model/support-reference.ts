const SELL_LIST_CONFIRMATION_SUPPORT_PREFIX = "CS-SL-";

function supportReferencePart(value: string) {
  return (
    value
      .replace(/[^A-Za-z0-9_-]/g, "_")
      .slice(0, 80)
      .toUpperCase() || "UNKNOWN"
  );
}

export function sellListConfirmationSupportReference(confirmationId: string) {
  const confirmationPart = confirmationId.trim().replace(/^slc[_-]?/i, "");
  return `${SELL_LIST_CONFIRMATION_SUPPORT_PREFIX}${supportReferencePart(confirmationPart)}`;
}

export function confirmationIdFromSellListSupportReference(supportReference: string) {
  const normalized = supportReference.trim();
  if (!normalized.toUpperCase().startsWith(SELL_LIST_CONFIRMATION_SUPPORT_PREFIX)) {
    return null;
  }

  const suffix = normalized.slice(SELL_LIST_CONFIRMATION_SUPPORT_PREFIX.length).trim();
  if (!suffix) {
    return null;
  }
  const normalizedSuffix = supportReferencePart(suffix);
  if (normalizedSuffix !== suffix.toUpperCase()) {
    return null;
  }

  return `slc_${normalizedSuffix.toLowerCase()}`;
}
