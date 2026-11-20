import type { AccountId } from "../primitives/typed-ids";

/** Settlement-owned payout review hold facts. Actor identity is carried by the event audit envelope. */
export const payoutReviewHoldFactTypes = {
  placed: "settlement.payout-review-hold.placed",
  released: "settlement.payout-review-hold.released",
} as const;

export type PayoutReviewHoldPayload = Readonly<{
  factSchemaVersion: 1;
  accountId: AccountId;
  reason: string;
  source: "operator" | "risk-alert" | "badge-migration";
  sourceReference: string | null;
}>;

export function normalizePayoutReviewHoldPayload(input: unknown): PayoutReviewHoldPayload {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Payout review hold payload is required.");
  const value = input as Record<string, unknown>;
  const accountId = typeof value.accountId === "string" ? value.accountId.trim() : "";
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  const source = value.source;
  const sourceReference =
    value.sourceReference === null || value.sourceReference === undefined
      ? null
      : typeof value.sourceReference === "string"
        ? value.sourceReference.trim()
        : "";
  if (!accountId) throw new Error("Payout review hold accountId is required.");
  if (reason.length < 1 || reason.length > 500) throw new Error("Payout review hold reason must be 1–500 characters.");
  if (source !== "operator" && source !== "risk-alert" && source !== "badge-migration")
    throw new Error("Payout review hold source is invalid.");
  if (sourceReference === "") throw new Error("Payout review hold sourceReference is invalid.");
  return { factSchemaVersion: 1, accountId: accountId as AccountId, reason, source, sourceReference };
}
