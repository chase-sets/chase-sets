import { parseIsoUtcTimestamp, type IsoUtcTimestamp } from "@chase-sets/primitives/iso-utc-timestamp";
import type { AccountId } from "@chase-sets/primitives/typed-ids";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  sellerCheckoutRiskPolicyRevision,
  parseSellerCheckoutRiskResult,
  type SellerCheckoutRiskOwner,
  type SellerCheckoutRiskReader,
  type SellerCheckoutRiskResult,
} from "../domain/contract";
import { evaluateSellerCheckoutRisk } from "../domain/policy";

type RiskSourceRow = Readonly<{ account_id: string; revision: unknown; updated_at: unknown }>;
export type SellerCheckoutRiskFactSource = (accountId: AccountId) => Promise<unknown | null>;

const absent: SellerCheckoutRiskResult = {
  schemaVersion: "settlement.seller-checkout-risk.v1",
  status: "clear",
  reasonCode: null,
  policyRevision: sellerCheckoutRiskPolicyRevision,
  sourceRevision: 0,
  sourceTimestamp: null,
  rowState: "absent",
};

const unavailable: SellerCheckoutRiskResult = {
  schemaVersion: "settlement.seller-checkout-risk.v1",
  status: "not-clear",
  reasonCode: "risk-not-clear",
  policyRevision: sellerCheckoutRiskPolicyRevision,
  sourceRevision: null,
  sourceTimestamp: null,
  rowState: "unavailable",
};

function hasExactKeys(value: object, keys: readonly string[]) {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function ownerOf(value: unknown): SellerCheckoutRiskOwner | null {
  if (!value || typeof value !== "object" || !hasExactKeys(value, ["accountId", "kind"])) {
    if (!value || typeof value !== "object" || !hasExactKeys(value, ["anonymousSellListId", "kind"])) return null;
  }
  const owner = value as Record<string, unknown>;
  if (
    owner.kind === "account" &&
    typeof owner.accountId === "string" &&
    /^acc_[A-Za-z0-9_]+$/.test(owner.accountId) &&
    owner.accountId.trim() === owner.accountId &&
    owner.accountId !== "acc_anonymous_sell_list"
  ) {
    return { kind: "account", accountId: owner.accountId as AccountId };
  }
  if (
    owner.kind === "anonymous" &&
    typeof owner.anonymousSellListId === "string" &&
    /^anon_[A-Za-z0-9_]+$/.test(owner.anonymousSellListId) &&
    owner.anonymousSellListId.trim() === owner.anonymousSellListId
  ) {
    return { kind: "anonymous", anonymousSellListId: owner.anonymousSellListId as `anon_${string}` };
  }
  return null;
}

function revisionOf(value: unknown): number | null {
  const numeric =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function timestampOf(value: unknown): IsoUtcTimestamp | null {
  try {
    if (value instanceof Date) value = value.toISOString();
    if (typeof value !== "string") return null;
    return parseIsoUtcTimestamp(value);
  } catch {
    return null;
  }
}

function present(row: unknown, accountId: AccountId): SellerCheckoutRiskResult | null {
  if (!row || typeof row !== "object" || !hasExactKeys(row, ["account_id", "revision", "updated_at"])) return null;
  const value = row as RiskSourceRow;
  const revision = revisionOf(value.revision);
  if (value.account_id !== accountId || revision === null) return null;
  const sourceTimestamp = timestampOf(value.updated_at);
  if (!sourceTimestamp) return null;
  return parseSellerCheckoutRiskResult({
    schemaVersion: "settlement.seller-checkout-risk.v1",
    ...evaluateSellerCheckoutRisk(),
    policyRevision: sellerCheckoutRiskPolicyRevision,
    sourceRevision: revision,
    sourceTimestamp,
    rowState: "present",
  });
}

/** Reads exactly one Settlement row for an authenticated owner. Anonymous owners have no Settlement row. */
export async function readSellerCheckoutRisk(
  source: SellerCheckoutRiskFactSource,
  owner: SellerCheckoutRiskOwner,
): Promise<SellerCheckoutRiskResult> {
  const owned = ownerOf(owner);
  if (!owned) return unavailable;
  if (owned.kind === "anonymous") return absent;
  try {
    const row = await source(owned.accountId);
    if (row === null) return absent;
    return present(row, owned.accountId) ?? unavailable;
  } catch {
    return unavailable;
  }
}

export function createSellerCheckoutRiskReader(db: PgQueryable): SellerCheckoutRiskReader {
  return (owner) =>
    readSellerCheckoutRisk(async (accountId) => {
      const result = await db.query(
        `SELECT account_id, revision, updated_at
           FROM settlement_account_risk_sources
           WHERE account_id = $1`,
        [accountId],
      );
      return result.rows[0] ?? null;
    }, owner);
}
