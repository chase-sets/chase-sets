import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { SettlementDomainError } from "../../../../support/runtime-support/common";

export const MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION = "marketplace-label-postage-v1";

export type MarketplaceLabelPostageActivation = Readonly<{
  policyVersion: typeof MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION;
  activatedAt: string;
}>;

export function validateMarketplaceLabelPostageActivation(raw: unknown): MarketplaceLabelPostageActivation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Marketplace label postage activation provenance must be an object.");
  }

  const record = raw as Record<string, unknown>;
  if (record.policyVersion !== MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION) {
    throw new SettlementDomainError("Marketplace label postage activation policy version is invalid.");
  }
  const activatedAt = typeof record.activatedAt === "string" ? record.activatedAt.trim() : "";
  if (activatedAt.length === 0 || Number.isNaN(Date.parse(activatedAt))) {
    throw new SettlementDomainError("Marketplace label postage activation timestamp is invalid.");
  }
  return {
    policyVersion: MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION,
    activatedAt: new Date(activatedAt).toISOString(),
  };
}

type MarketplaceLabelPostageActivationRow = Readonly<{
  policy_version: unknown;
  activated_at: unknown;
}>;

export function decodeMarketplaceLabelPostageActivation(raw: unknown): MarketplaceLabelPostageActivation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SettlementDomainError("Marketplace label postage activation provenance must be an object.");
  }

  const record = raw as Record<string, unknown>;
  if (record.policy_version !== MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION) {
    throw new SettlementDomainError("Marketplace label postage activation policy version is invalid.");
  }

  const activatedAt =
    record.activated_at instanceof Date
      ? record.activated_at.toISOString()
      : typeof record.activated_at === "string"
        ? record.activated_at.trim()
        : "";
  if (activatedAt.length === 0 || Number.isNaN(Date.parse(activatedAt))) {
    throw new SettlementDomainError("Marketplace label postage activation timestamp is invalid.");
  }

  return validateMarketplaceLabelPostageActivation({
    policyVersion: MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION,
    activatedAt,
  });
}

export async function readMarketplaceLabelPostageActivation(
  db: PgQueryable,
): Promise<MarketplaceLabelPostageActivation> {
  const result = await db.query<MarketplaceLabelPostageActivationRow>(
    `SELECT policy_version, activated_at
     FROM settlement_marketplace_label_postage_activation
     WHERE singleton = true`,
  );
  if (result.rows.length !== 1) {
    throw new SettlementDomainError("Marketplace label postage activation provenance is missing.");
  }
  return decodeMarketplaceLabelPostageActivation(result.rows[0]);
}

/**
 * The phase-2 worker is the sole caller. The database authors the immutable
 * instant, and racing workers converge by the singleton key without updating it.
 */
export async function activateMarketplaceLabelPostage(db: PgQueryable): Promise<MarketplaceLabelPostageActivation> {
  await db.query(
    `INSERT INTO settlement_marketplace_label_postage_activation (singleton, policy_version, activated_at)
     VALUES (true, $1, clock_timestamp())
     ON CONFLICT (singleton) DO NOTHING`,
    [MARKETPLACE_LABEL_POSTAGE_POLICY_VERSION],
  );
  return readMarketplaceLabelPostageActivation(db);
}
