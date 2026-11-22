import { describe, expect, it } from "vitest";
import {
  assertEvaluationBinding,
  evaluationDeadline,
  readCompetitorCapture,
  sealCompetitorCapture,
} from "../domain/evaluation-authority";
import type { RepricingRule } from "../../repricing-policies/domain/domain";
import { dryRunBody } from "../tests/dry-run-fixture";

describe("exact Pricing evaluation authority", () => {
  const binding = {
    requestId: "a".repeat(64),
    commandFingerprint: "b".repeat(64),
    consumer: { storeId: "marketplace", incarnation: "synthetic-incarnation" },
    tenantId: "tnt_synthetic",
    accountId: "acc_synthetic",
    principal: { userId: "usr_synthetic", membershipId: "mbr_synthetic", sessionId: "ses_synthetic" },
    listingId: "lst_synthetic",
    catalogItemId: "cat_synthetic",
    productId: "prd_synthetic",
    listingVersion: 1,
    target: { kind: "channel-connection" as const, connectionId: "synthetic-channel" },
    priceAmount: "15.00",
    priceCurrencyCode: "USD",
    decision: {
      kind: "pricing-evaluation" as const,
      evaluationId: "evd_synthetic",
      evaluationRevision: "1",
      standingAuthorizationId: "repricing-account/acc_synthetic",
      standingAuthorizationRevision: "0",
      basePriceRevision: 1,
    },
  };
  it("binds the full command and rejects a foreign principal, Product, consumer, pair or revision", () => {
    expect(assertEvaluationBinding(binding, binding)).toEqual(binding);
    for (const changed of [
      { principal: { ...binding.principal, membershipId: "mbr_other" } },
      { productId: "prd_other" },
      { consumer: { ...binding.consumer, incarnation: "other" } },
      { priceCurrencyCode: "EUR" },
      { commandFingerprint: "c".repeat(64) },
      { decision: { ...binding.decision, evaluationRevision: "2" } },
    ])
      expect(() => assertEvaluationBinding({ ...binding, ...changed }, binding)).toThrow("another command");
    expect(() =>
      assertEvaluationBinding({ ...binding, listingVersion: Number.MAX_SAFE_INTEGER + 1 }, binding),
    ).toThrow();
    expect(() => assertEvaluationBinding({ ...binding, target: { kind: "channel-connection" } }, binding)).toThrow();
  });

  it("validates multipart counts, contiguous part identity, roots and nested ask evidence", () => {
    const asks = Array.from({ length: 129 }, (_, index) => ({
      listingId: `lst_${index}`,
      sellerAccountId: "acc_competitor",
      listingVersion: 1,
      amount: "6.50",
      currencyCode: "USD",
      pricingMode: "hard" as const,
    }));
    const sealed = sealCompetitorCapture("synthetic-generation", asks);
    expect(sealed.parts.map(({ part, count }) => [part, count])).toEqual([
      [0, 128],
      [1, 1],
    ]);
    expect(readCompetitorCapture(sealed)).toEqual(sealed);
    expect(() => readCompetitorCapture({ ...sealed, parts: sealed.parts.slice(0, 1) })).toThrow();
    expect(() => readCompetitorCapture({ ...sealed, parts: [...sealed.parts].reverse() })).toThrow();
    expect(() => sealCompetitorCapture("synthetic-generation", [...asks, asks[0]!])).toThrow("Duplicate");
    expect(() => sealCompetitorCapture("synthetic-generation", [{ ...asks[0]!, listingVersion: NaN }])).toThrow();
    expect(() => readCompetitorCapture({ ...sealed, generation: "synthetic-other" })).toThrow();
  });

  it("uses an earlier currently nonmatching schedule only when its predicate flips at the UTC minute", () => {
    const challengeTime = "2026-11-20T10:59:45.000Z";
    const earlier: RepricingRule = {
      conditions: [{ type: "schedule-window", daysOfWeek: [5], startTime: "11:00", endTime: "11:10" }],
      directive: dryRunBody.rules[0]!.directive,
    };
    const common = { challengeTime, listingCreatedAt: null, validityBounds: [] };
    expect(evaluationDeadline({ ...common, rules: [earlier, ...dryRunBody.rules] })).toBe("2026-11-20T11:00:00.000Z");
    expect(evaluationDeadline({ ...common, rules: dryRunBody.rules })).toBe("2026-11-20T11:00:45.000Z");
    expect(evaluationDeadline({ ...common, rules: [earlier], validityBounds: ["2026-11-20T10:59:50.000Z"] })).toBe(
      "2026-11-20T10:59:50.000Z",
    );
    expect(() => evaluationDeadline({ ...common, rules: [], validityBounds: [challengeTime] })).toThrow("expired");
    expect(() => evaluationDeadline({ ...common, rules: [], challengeTime: "2026-02-30T10:59:45.000Z" })).toThrow();
    expect(() => evaluationDeadline({ ...common, rules: [], challengeTime: "2026-11-20T10:59:45+00:00" })).toThrow();
  });
});
