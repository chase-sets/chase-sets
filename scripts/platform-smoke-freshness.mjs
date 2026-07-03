function isSourceCommitPosition(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  return (
    typeof value.sourceContextName === "string" &&
    value.sourceContextName.length > 0 &&
    typeof value.maxGlobalPosition === "string" &&
    /^(0|[1-9]\d*)$/.test(value.maxGlobalPosition) &&
    Array.isArray(value.eventIds) &&
    value.eventIds.every((eventId) => typeof eventId === "string" && eventId.length > 0)
  );
}

export function decodeCommitReceipt(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed) ? parsed.filter(isSourceCommitPosition) : [];
  } catch {
    return [];
  }
}

export function createReadAfterWriteReceiptFromCommitReceipt(value, nowMs = Date.now()) {
  const sources = decodeCommitReceipt(value);
  if (sources.length === 0) {
    return null;
  }

  return encodeURIComponent(
    JSON.stringify({
      observedAtMs: nowMs,
      sources,
    }),
  );
}
