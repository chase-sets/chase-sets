import { describe, expect, it } from "vitest";
import {
  normalizeSupportRequestRemedyAuthorizedV1,
  type LiabilityAllocationFactV1,
  type SupportRequestRemedyAuthorizedV1Payload,
} from "@chase-sets/event-core/platform-coverage-facts";
import { moneyToCents, sumMoneyAmounts } from "@chase-sets/primitives/money";
import type { BuyerRemedyKind, RefundTrigger, ReturnDirective } from "@chase-sets/primitives/platform-coverage";
import type { AccountId, RemedyId } from "@chase-sets/primitives/typed-ids";
import { platformRemedyCapabilities } from "../features/support-requests/domain/platform-remedy-policy";
import {
  applyRemedyEffectFact,
  applyRemedyLifecycleEvent,
  canCompleteRemedy,
  canReleaseRemedyRefund,
  createRefundReleasedEvent,
  createRemedyCompletedEvent,
  createRemedyEffectWaiver,
  createRemedyExecution,
  normalizeRemedyEffectFact,
  remedyClosureBlockingReasons,
  type RemedyEffectFact,
  type RemedyEffectKind,
  type RemedyExecution,
} from "../features/support-requests/domain/remedy";

/**
 * Platform-covered remedy execution-lifecycle proof (ADR 0022, Wave 3 go-live evidence).
 *
 * The Support half of the exact-once platform-funded resolution proof. It drives the REAL
 * Support remedy deciders (`bounded-contexts/platform-operations/.../domain/remedy.ts`) against
 * the REAL published-fact contract, proving the case-closure invariants that keep money and
 * physical effects honest: a refund releases only when its coverage reservation and refund
 * trigger are satisfied, a case cannot be represented as complete while any required effect is
 * still pending, effect facts are idempotent under duplicate/out-of-order delivery, and the
 * financial effects cannot be waived away. The Settlement financial-truth reconciliation is
 * proven in the sibling settlement proof; the operator packet composes both.
 */

const REMEDY_ID = "rmd_01JZ6DKP7S7Z4AZ5N5E6K7M8NA";
const SUPPORT_REQUEST_ID = "sup_01JZ6DKP7S7Z4AZ5N5E6K7M8NB";
const COVERAGE_ID = "cov_01JZ6DKP7S7Z4AZ5N5E6K7M8N9";
const AUTHORIZED_AT = "2026-07-14T00:00:00.000Z";

type AllocationSpec = Readonly<{ seller: string; platform: string }>;

function allocationFact(spec: AllocationSpec): LiabilityAllocationFactV1 {
  const fundingKind =
    moneyToCents(spec.platform) === 0n
      ? "seller-funded"
      : moneyToCents(spec.seller) === 0n
        ? "platform-funded"
        : "split";
  return { sellerFundedAmount: spec.seller, platformFundedAmount: spec.platform, currencyCode: "usd", fundingKind };
}

function authorize(params: {
  allocation: AllocationSpec;
  returnDirective?: ReturnDirective;
  refundTrigger?: RefundTrigger;
  remedyKind?: BuyerRemedyKind;
  coverageId?: string | null;
}): SupportRequestRemedyAuthorizedV1Payload {
  return normalizeSupportRequestRemedyAuthorizedV1({
    factSchemaVersion: 1,
    supportRequestId: SUPPORT_REQUEST_ID,
    remedyId: REMEDY_ID,
    idempotencyKey: `remedy-authorized:${REMEDY_ID}`,
    causationId: null,
    policyVersion: "coverage-policy-2026-07",
    occurredAt: AUTHORIZED_AT,
    coverageId: params.coverageId === undefined ? COVERAGE_ID : params.coverageId,
    remedy: {
      kind: params.remedyKind ?? "full-refund",
      amount: sumMoneyAmounts([params.allocation.seller, params.allocation.platform]),
      currencyCode: "usd",
    },
    allocation: allocationFact(params.allocation),
    returnDirective: params.returnDirective ?? "no-return",
    refundTrigger: params.refundTrigger ?? "immediate",
    reasonCode: "fault-indeterminate",
  });
}

function effectFact(effect: RemedyEffectKind, idempotencyKey: string, occurredAt: string): RemedyEffectFact {
  return normalizeRemedyEffectFact({
    type: "RecordSupportRemedyEffect",
    remedyId: REMEDY_ID as RemedyId,
    effect,
    outcome: "satisfied",
    sourceFactType: `source.${effect}`,
    sourceFactId: `evt_${idempotencyKey}`,
    idempotencyKey,
    occurredAt,
    reasonCode: `${effect}-observed`,
  });
}

function satisfy(remedy: RemedyExecution, effect: RemedyEffectKind, key: string, at: string): RemedyExecution {
  return applyRemedyEffectFact(remedy, effectFact(effect, key, at));
}

describe("platform-covered remedy lifecycle — golden closure gate", () => {
  it("cannot complete a fully platform-funded case until every required effect reconciles", () => {
    let remedy = createRemedyExecution(authorize({ allocation: { seller: "0.00", platform: "40.00" } }));
    // Required effects for a platform-funded, immediate, no-return remedy.
    expect(remedy.effects.map((effect) => effect.effect)).toEqual([
      "coverage-reservation",
      "refund-completion",
      "settlement-reconciliation",
    ]);

    // Nothing is satisfied: refund cannot release, case cannot close, and the block is visible.
    expect(canReleaseRemedyRefund(remedy)).toBe(false);
    expect(canCompleteRemedy(remedy)).toBe(false);
    expect(remedyClosureBlockingReasons(remedy)).toContain("coverage-reservation:pending");

    // Settlement reserves the coverage → the refund trigger (immediate) is already satisfied → release.
    remedy = satisfy(remedy, "coverage-reservation", "cov-reserved", "2026-07-14T00:10:00.000Z");
    expect(canReleaseRemedyRefund(remedy)).toBe(true);

    remedy = applyRemedyLifecycleEvent(
      remedy,
      createRefundReleasedEvent(remedy, "2026-07-14T00:20:00.000Z", remedy.authorizationIdempotencyKey),
      [],
    )!;
    expect(remedy.refundReleasedAt).not.toBeNull();

    // Refund completed, but Settlement reconciliation is still pending — the case must NOT close.
    remedy = satisfy(remedy, "refund-completion", "refund-done", "2026-07-14T00:30:00.000Z");
    expect(canCompleteRemedy(remedy)).toBe(false);
    expect(remedyClosureBlockingReasons(remedy)).toEqual(["settlement-reconciliation:pending"]);

    // Settlement reconciliation lands → all required effects satisfied → close.
    remedy = satisfy(remedy, "settlement-reconciliation", "settle-done", "2026-07-14T00:40:00.000Z");
    expect(canCompleteRemedy(remedy)).toBe(true);
    expect(remedyClosureBlockingReasons(remedy)).toEqual([]);

    remedy = applyRemedyLifecycleEvent(
      remedy,
      createRemedyCompletedEvent(remedy, "2026-07-14T00:41:00.000Z", "cause"),
      [],
    )!;
    expect(remedy.status).toBe("completed");
    expect(remedyClosureBlockingReasons(remedy)).toEqual([]);
  });
});

describe("platform-covered remedy lifecycle — refund-release gating", () => {
  it("a seller-funded remedy needs no coverage reservation and releases on its trigger", () => {
    const remedy = createRemedyExecution(
      authorize({ allocation: { seller: "40.00", platform: "0.00" }, coverageId: null }),
    );
    expect(remedy.effects.map((effect) => effect.effect)).not.toContain("coverage-reservation");
    expect(canReleaseRemedyRefund(remedy)).toBe(true);
  });

  it("a return-gated refund releases only once its return trigger effect is satisfied (pending auto-wiring seam)", () => {
    // The carrier-accepted / return-delivered auto-triggers (fulfillment reverse-tracking scan →
    // remedy effect) are not yet wired; facility-intake and operator-release are. This asserts the
    // stable merged seam the pending integration must land on: canReleaseRemedyRefund flips true once
    // BOTH coverage-reservation and the trigger effect are recorded satisfied.
    let remedy = createRemedyExecution(
      authorize({
        allocation: { seller: "0.00", platform: "40.00" },
        returnDirective: "return-to-platform",
        refundTrigger: "carrier-accepted",
      }),
    );
    expect(remedy.effects.map((effect) => effect.effect)).toContain("carrier-accepted");

    remedy = satisfy(remedy, "coverage-reservation", "cov", "2026-07-14T00:10:00.000Z");
    // Coverage reserved but the carrier has not accepted the return yet — refund stays gated.
    expect(canReleaseRemedyRefund(remedy)).toBe(false);

    remedy = satisfy(remedy, "carrier-accepted", "carrier", "2026-07-14T01:00:00.000Z");
    expect(canReleaseRemedyRefund(remedy)).toBe(true);
  });
});

describe("platform-covered remedy lifecycle — fault injection", () => {
  it("effect facts are idempotent: a redelivered fact (and its notification) is absorbed once", () => {
    const base = createRemedyExecution(authorize({ allocation: { seller: "0.00", platform: "40.00" } }));
    const fact = effectFact("coverage-reservation", "cov-key", "2026-07-14T00:10:00.000Z");
    const once = applyRemedyEffectFact(base, fact);
    const twice = applyRemedyEffectFact(once, fact);
    const coverageEffect = (remedy: RemedyExecution) =>
      remedy.effects.find((effect) => effect.effect === "coverage-reservation")!;
    expect(coverageEffect(once).facts).toHaveLength(1);
    expect(coverageEffect(twice).facts).toHaveLength(1);
    expect(coverageEffect(twice).status).toBe("satisfied");
  });

  it("out-of-order effect delivery converges to the same effect statuses", () => {
    const base = createRemedyExecution(authorize({ allocation: { seller: "0.00", platform: "40.00" } }));
    const cov = effectFact("coverage-reservation", "cov", "2026-07-14T00:10:00.000Z");
    const refund = effectFact("refund-completion", "refund", "2026-07-14T00:30:00.000Z");
    const settle = effectFact("settlement-reconciliation", "settle", "2026-07-14T00:40:00.000Z");

    const inOrder = [cov, refund, settle].reduce(applyRemedyEffectFact, base);
    const shuffled = [settle, cov, refund].reduce(applyRemedyEffectFact, base);

    const statuses = (remedy: RemedyExecution) =>
      Object.fromEntries(remedy.effects.map((effect) => [effect.effect, effect.status]));
    expect(statuses(shuffled)).toEqual(statuses(inOrder));
    expect(
      canCompleteRemedy(
        applyRemedyLifecycleEvent(inOrder, createRefundReleasedEvent(inOrder, "2026-07-14T00:20:00.000Z", "c"), [])!,
      ),
    ).toBe(true);
  });

  it("a financial effect cannot be waived away", () => {
    for (const effect of ["coverage-reservation", "refund-completion", "settlement-reconciliation"] as const) {
      expect(() =>
        createRemedyEffectWaiver({
          type: "OverrideSupportRemedyEffect",
          remedyId: REMEDY_ID as RemedyId,
          effect,
          actorAccountId: "acc_op1" as AccountId,
          permissionUsed: platformRemedyCapabilities.waive,
          reasonCode: "operator-discretion",
          rationale: "should be rejected",
          evidenceReferences: ["ref-1"],
          idempotencyKey: `waive:${effect}`,
          overriddenAt: "2026-07-14T02:00:00.000Z",
        }),
      ).toThrow(/cannot be waived/i);
    }
  });

  it("a non-financial effect can be waived by an authorized operator with evidence", () => {
    const { effect, waiver } = createRemedyEffectWaiver({
      type: "OverrideSupportRemedyEffect",
      remedyId: REMEDY_ID as RemedyId,
      effect: "return-label-available",
      actorAccountId: "acc_op1" as AccountId,
      permissionUsed: platformRemedyCapabilities.waive,
      reasonCode: "return-not-required",
      rationale: "buyer keeps the item",
      evidenceReferences: ["ticket-123"],
      idempotencyKey: "waive:return-label",
      overriddenAt: "2026-07-14T02:00:00.000Z",
    });
    expect(effect).toBe("return-label-available");
    expect(waiver.evidenceReferences).toEqual(["ticket-123"]);
  });
});
