import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import {
  DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  normalizeCommercialAccountId,
  normalizeCommercialAccountType,
  normalizeLabel,
  normalizeMoneyAmount,
  normalizePercentageBps,
  CommercialTermsDomainError,
  type CommercialAccountType,
} from "./common";

/**
 * Schedules and agreements converged onto the shared `definePolicy`
 * machinery: the agreement/schedule/default resolution hierarchy and the
 * account-type/account-id targeting dimensions stay commercial-terms domain
 * concepts, but they are expressed as ordinary policy values rather than a
 * bespoke aggregate/projection pair.
 *
 * Targeting decision: targeting stays context-side, encoded in the policy
 * key rather than added to the shared machinery as a capability. Schedules
 * target a closed, three-value enum (account type), so each account type
 * gets its own well-known policy key. Agreements target an open-ended
 * account id, so the policy key embeds a normalized (lowercase, hyphenated)
 * account id. The machinery itself never learns about targeting -- it only
 * ever sees a policy key plus an opaque value -- keeping the shared folder
 * tiny per the platform-policy machinery's design.
 */

export type CommercialTermsPolicyTermsBase = Readonly<{
  label: string;
  marketplaceSalesFeePercentageBps: number;
  marketplaceSalesFeeFixedAmount: string;
  shippingAllowancePercentageBps: number;
}>;

export type CommercialTermsSchedulePolicyValue = CommercialTermsPolicyTermsBase &
  Readonly<{ accountType: CommercialAccountType }>;

export type CommercialTermsAgreementPolicyValue = CommercialTermsPolicyTermsBase & Readonly<{ accountId: string }>;

const SCHEDULE_SCHEMA_SUMMARY =
  "{ label, accountType, marketplaceSalesFeePercentageBps, marketplaceSalesFeeFixedAmount, shippingAllowancePercentageBps }";
const AGREEMENT_SCHEMA_SUMMARY =
  "{ label, accountId, marketplaceSalesFeePercentageBps, marketplaceSalesFeeFixedAmount, shippingAllowancePercentageBps }";

export function commercialTermsSchedulePolicyKey(accountType: CommercialAccountType): string {
  return `commercial-terms.schedule.${accountType}`;
}

/**
 * Agreement policy keys must satisfy the shared machinery's dotted-lowercase
 * key pattern, but account ids are `acc_<ULID>` -- mixed case with an
 * underscore. The transform below is one-directional (only used to build
 * the key); the account id itself is always carried, untransformed, inside
 * the policy value.
 */
export function commercialTermsAgreementPolicyKey(accountId: string): string {
  const normalized = normalizeCommercialAccountId(accountId);
  return `commercial-terms.agreement.${normalized.toLowerCase().replace(/_/g, "-")}`;
}

function decodeTermsBase(record: Record<string, unknown>): CommercialTermsPolicyTermsBase {
  return {
    label: normalizeLabel(String(record.label ?? ""), "Label"),
    marketplaceSalesFeePercentageBps: normalizePercentageBps(
      Number(record.marketplaceSalesFeePercentageBps),
      "Marketplace sales fee percentage",
    ),
    marketplaceSalesFeeFixedAmount: normalizeMoneyAmount(String(record.marketplaceSalesFeeFixedAmount ?? ""), {
      fieldName: "Marketplace sales fee fixed amount",
      allowZero: true,
    }),
    shippingAllowancePercentageBps: normalizePercentageBps(
      Number(record.shippingAllowancePercentageBps ?? DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS),
      "Shipping allowance percentage",
    ),
  };
}

function asRecord(raw: JsonValue, fieldName: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CommercialTermsDomainError(`${fieldName} value must be an object.`);
  }
  return raw as Record<string, unknown>;
}

export function decodeCommercialTermsSchedulePolicyValue(raw: JsonValue): CommercialTermsSchedulePolicyValue {
  const record = asRecord(raw, "Schedule policy");
  return {
    ...decodeTermsBase(record),
    accountType: normalizeCommercialAccountType(String(record.accountType ?? "")),
  };
}

export function decodeCommercialTermsAgreementPolicyValue(raw: JsonValue): CommercialTermsAgreementPolicyValue {
  const record = asRecord(raw, "Agreement policy");
  return {
    ...decodeTermsBase(record),
    accountId: normalizeCommercialAccountId(record.accountId),
  };
}

/** Schema-declared defaults -- the migration's byte-identical seed and compiled fallback. */
export const COMMERCIAL_TERMS_SCHEDULE_LAUNCH_VALUES: Readonly<
  Record<CommercialAccountType, CommercialTermsSchedulePolicyValue>
> = {
  personal: {
    label: "Personal Default",
    accountType: "personal",
    marketplaceSalesFeePercentageBps: 900,
    marketplaceSalesFeeFixedAmount: "0.15",
    shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  },
  business: {
    label: "Business Default",
    accountType: "business",
    marketplaceSalesFeePercentageBps: 850,
    marketplaceSalesFeeFixedAmount: "0.10",
    shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  },
  enterprise: {
    label: "Enterprise Default",
    accountType: "enterprise",
    marketplaceSalesFeePercentageBps: 600,
    marketplaceSalesFeeFixedAmount: "0.00",
    shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
  },
};

export function commercialTermsSchedulePolicy(
  accountType: CommercialAccountType,
): PolicyDefinition<CommercialTermsSchedulePolicyValue> {
  return definePolicy({
    policyKey: commercialTermsSchedulePolicyKey(accountType),
    contextName: "commercial-terms",
    schemaSummary: SCHEDULE_SCHEMA_SUMMARY,
    defaultValue: COMMERCIAL_TERMS_SCHEDULE_LAUNCH_VALUES[accountType],
    decodeValue: decodeCommercialTermsSchedulePolicyValue,
  });
}

/**
 * Agreements have no schema-declared "launch value" (they are always
 * admin-created overrides, never seeded fallbacks) -- the default below only
 * satisfies `definePolicy`'s decode-at-declaration-time contract and is
 * never resolved onto a live agreement, since resolution reads the
 * documents table directly and fails closed when no active document exists.
 */
export function commercialTermsAgreementPolicy(
  accountId: string,
): PolicyDefinition<CommercialTermsAgreementPolicyValue> {
  const normalizedAccountId = normalizeCommercialAccountId(accountId);
  return definePolicy({
    policyKey: commercialTermsAgreementPolicyKey(normalizedAccountId),
    contextName: "commercial-terms",
    schemaSummary: AGREEMENT_SCHEMA_SUMMARY,
    defaultValue: {
      label: "Standard",
      accountId: normalizedAccountId,
      marketplaceSalesFeePercentageBps: 0,
      marketplaceSalesFeeFixedAmount: "0.00",
      shippingAllowancePercentageBps: DEFAULT_SHIPPING_ALLOWANCE_PERCENTAGE_BPS,
    },
    decodeValue: decodeCommercialTermsAgreementPolicyValue,
  });
}
