import { definePolicy, type PolicyDefinition } from "@chase-sets/platform-policy/define-policy";
import type { JsonValue } from "@chase-sets/primitives/json";
import { SupportDomainError, type SupportFlowType } from "./common";
import { supportFlowCatalog } from "./flow-catalog";

/**
 * The support-flow deadline policy: per-flow-type overrides for the two
 * tunable SLA dials -- how many hours the seller has to respond, and how
 * many hours support has to review a `ready-for-support` case. The flow
 * catalog's structure (checklist, allowed responses/resolutions, and
 * whether a flow even HAS a seller-response phase) stays compiled behavior;
 * only the two NUMBERS move onto this policy. Platform Operations both owns
 * this policy's schema/admin routes (see `../api/deadline-policy-route.ts`)
 * and is its only consumer -- the `OpenSupportRequest` resolution in
 * `../api/runtime.ts`, which resolves the current value once and stamps the
 * hours onto the command -- so no cross-context host port is needed.
 *
 * Fairness invariant: `decideSupportRequest` never reads this policy live.
 * It only ever consumes the hours already resolved onto the
 * `OpenSupportRequest` command by the runtime at open time, so a revision
 * changes the deadlines for newly opened requests only -- every existing
 * request's stamped `sellerResponseDueAt`/`supportReviewDueAt` is untouched.
 */

export type SupportFlowDeadlineHours = Readonly<{
  /**
   * Hours the seller has to respond, or `null` for flows with no
   * seller-response phase at all (a structural property of the flow, not a
   * tunable dial -- see `SupportFlowDefinition.sellerResponseHours`).
   */
  sellerResponseHours: number | null;
  /** Hours support has to review the case once it is ready for support. */
  supportReviewHours: number;
}>;

export type SupportDeadlinePolicyValue = Readonly<Record<SupportFlowType, SupportFlowDeadlineHours>>;

/** Bounds validation at revise: a support window narrower than 4 hours gives sellers no realistic chance to act; wider than 14 days stalls buyer remedies indefinitely. */
export const MIN_SUPPORT_DEADLINE_HOURS = 4;
export const MAX_SUPPORT_DEADLINE_HOURS = 336;

/**
 * The launch values, single-sourced from the compiled flow catalog so the
 * migration's seed and compiled fallback agree with today's behavior
 * byte-for-byte.
 */
export const SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE: SupportDeadlinePolicyValue = Object.fromEntries(
  supportFlowCatalog.map((flow) => [
    flow.flowType,
    { sellerResponseHours: flow.sellerResponseHours, supportReviewHours: flow.supportReviewHours },
  ]),
) as SupportDeadlinePolicyValue;

function normalizeDeadlineHours(value: unknown, fieldName: string): number {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < MIN_SUPPORT_DEADLINE_HOURS || numeric > MAX_SUPPORT_DEADLINE_HOURS) {
    throw new SupportDomainError(
      `${fieldName} must be a whole number of hours between ${MIN_SUPPORT_DEADLINE_HOURS} and ${MAX_SUPPORT_DEADLINE_HOURS}.`,
    );
  }
  return numeric;
}

function normalizeStructuralNullSellerResponseHours(value: unknown, flowType: SupportFlowType): null {
  if (value !== null) {
    throw new SupportDomainError(
      `'${flowType}' has no seller-response phase; its seller response hours must stay null (a structural property of the flow, not a tunable dial).`,
    );
  }
  return null;
}

export function decodeSupportDeadlinePolicyValue(raw: JsonValue): SupportDeadlinePolicyValue {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new SupportDomainError("Support deadline policy value must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const result: Record<string, SupportFlowDeadlineHours> = {};

  for (const flow of supportFlowCatalog) {
    const entry = record[flow.flowType];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new SupportDomainError(`Support deadline policy value is missing an entry for '${flow.flowType}'.`);
    }
    const entryRecord = entry as Record<string, unknown>;

    const sellerResponseHours =
      flow.sellerResponseHours === null
        ? normalizeStructuralNullSellerResponseHours(entryRecord.sellerResponseHours ?? null, flow.flowType)
        : normalizeDeadlineHours(entryRecord.sellerResponseHours, `'${flow.flowType}' seller response hours`);
    const supportReviewHours = normalizeDeadlineHours(
      entryRecord.supportReviewHours,
      `'${flow.flowType}' support review hours`,
    );

    result[flow.flowType] = { sellerResponseHours, supportReviewHours };
  }

  return result as SupportDeadlinePolicyValue;
}

export const supportDeadlinePolicy: PolicyDefinition<SupportDeadlinePolicyValue> = definePolicy({
  policyKey: "platform-operations.support-deadlines",
  contextName: "platform-operations",
  schemaSummary:
    "{ [flowType]: { sellerResponseHours: integer 4-336 or null (structural), supportReviewHours: integer 4-336 } } for every support flow type",
  defaultValue: SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
  decodeValue: decodeSupportDeadlinePolicyValue,
});

/**
 * Resolves the tunable hours for one flow type from a policy value, falling
 * back to the compiled launch default when the value has no entry for it
 * (defensive; a value that passed `decodeSupportDeadlinePolicyValue` always
 * has full coverage, but callers may pass an untrusted or partial value).
 */
export function resolveSupportFlowDeadlineHours(
  flowType: SupportFlowType,
  value: SupportDeadlinePolicyValue = SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE,
): SupportFlowDeadlineHours {
  return value[flowType] ?? SUPPORT_DEADLINE_LAUNCH_POLICY_VALUE[flowType];
}
