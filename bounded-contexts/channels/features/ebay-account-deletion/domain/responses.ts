export type EbayReceiptMatch = Readonly<{ notificationId: string; eventDate: string; expiresAt: string }>;
export type EbaySubjectDataCount = Readonly<{ connections: number; credentialEnvelopes: number }>;
export const ebayReceiptLookupLimits = Object.freeze({
  maxMatches: 32,
  maxSerializedUtf8ResponseBytes: 65536,
  completeBodyDeadlineMs: 5000,
});
export class EbayReceiptResponseTooLarge extends Error {
  constructor() {
    super("ebay-receipt-response-too-large");
  }
}

function closed(value: unknown, names: readonly string[]): asserts value is Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== names.length ||
    names.some((name) => !Object.hasOwn(value, name))
  )
    throw new Error("invalid-ebay-receipt-response");
}
function instant(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    value.startsWith("0000-") ||
    new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    throw new Error("invalid-ebay-receipt-response");
}
export function decodeEbayReceiptMatches(value: unknown): readonly EbayReceiptMatch[] {
  closed(value, ["matches"]);
  if (!Array.isArray(value.matches)) throw new Error("invalid-ebay-receipt-response");
  if (
    value.matches.length > ebayReceiptLookupLimits.maxMatches ||
    new TextEncoder().encode(JSON.stringify(value)).byteLength > ebayReceiptLookupLimits.maxSerializedUtf8ResponseBytes
  )
    throw new EbayReceiptResponseTooLarge();
  return value.matches.map((row: unknown) => {
    closed(row, ["notificationId", "eventDate", "expiresAt"]);
    if (typeof row.notificationId !== "string" || row.notificationId.length === 0 || row.notificationId.length > 1024)
      throw new Error("invalid-ebay-receipt-response");
    instant(row.eventDate);
    instant(row.expiresAt);
    return { notificationId: row.notificationId, eventDate: row.eventDate, expiresAt: row.expiresAt };
  });
}
export function serializeEbayReceiptMatches(value: unknown, now = Date.now()): string {
  if (
    !Array.isArray(value) ||
    value.length > ebayReceiptLookupLimits.maxMatches ||
    new TextEncoder().encode(JSON.stringify({ matches: value })).byteLength >
      ebayReceiptLookupLimits.maxSerializedUtf8ResponseBytes
  )
    throw new EbayReceiptResponseTooLarge();
  const matches = decodeEbayReceiptMatches({ matches: value });
  return JSON.stringify({ matches: matches.filter((row) => Date.parse(row.expiresAt) > now) });
}
export function decodeEbaySubjectDataCount(value: unknown): EbaySubjectDataCount {
  closed(value, ["connections", "credentialEnvelopes"]);
  if (
    typeof value.connections !== "number" ||
    !Number.isSafeInteger(value.connections) ||
    value.connections < 0 ||
    typeof value.credentialEnvelopes !== "number" ||
    !Number.isSafeInteger(value.credentialEnvelopes) ||
    value.credentialEnvelopes < 0
  )
    throw new Error("invalid-ebay-receipt-response");
  return { connections: value.connections, credentialEnvelopes: value.credentialEnvelopes };
}
