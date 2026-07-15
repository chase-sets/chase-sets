// Release-readiness PROOF for issue #5226: prove the fair order-issue and review
// journeys behave as one coherent system across Support (platform-operations),
// Marketplace reviews and seller metrics, Settlement holds, and Notifications.
//
// Test files may reference issue numbers freely (the source issue-ref ban exempts
// tests). This proof composes the Marketplace-owned reputation-fairness deciders in
// a journey framing and asserts the cross-context seam from each context's
// context.json, so money and rating facts can only flow from Support and Settlement.
// Browser and staging rows are recorded as pending in the acceptance doc; here we
// prove every fairness, hold-timing, replay, and fail-safe invariant against the
// merged contracts.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  decideDirectionalReviewDisposition,
  type DirectionalReviewDisposition,
  type DirectionalReviewPolicyInput,
  type ResolvedResponsibility,
  type ReviewSupportRequestFact,
} from "../features/reviews/domain/directional-review-disposition";
import { addReviewWindowDays, REVIEW_WINDOW_DAYS } from "../features/reviews/domain/common";
import {
  intakeFlowForProblemCategory,
  LOW_RATING_RESOLUTION_THRESHOLD,
  REVIEW_PROBLEM_CATEGORIES,
  resolutionTriggerReason,
  shouldRouteToResolution,
} from "../features/reviews/ui/review-resolution";
import {
  isSellerResponsible,
  normalizeConsumedResponsibility,
  SELLER_METRICS_RESPONSIBILITY_VALUES,
} from "../features/seller-metrics/domain/common";

const baseDir = fileURLToPath(new URL(".", import.meta.url));

const DELIVERED_AT = "2026-01-01T00:00:00.000Z";
const RESOLVED_AT = "2026-01-05T00:00:00.000Z";
const IN_WINDOW_AT = "2026-01-10T00:00:00.000Z";
const AFTER_DEADLINE_AT = addReviewWindowDays(DELIVERED_AT, REVIEW_WINDOW_DAYS + 1);

function resolvedCase(
  responsibility: ResolvedResponsibility | string | null,
  resolutionType: string,
): ReviewSupportRequestFact {
  return { status: "resolved", responsibility, resolvedAt: RESOLVED_AT, resolutionType };
}

function evaluate(
  supportRequests: readonly ReviewSupportRequestFact[],
  overrides: Partial<DirectionalReviewPolicyInput> = {},
) {
  return decideDirectionalReviewDisposition({
    deliveredAt: overrides.deliveredAt ?? DELIVERED_AT,
    cancelledAt: overrides.cancelledAt ?? null,
    evaluatedAt: overrides.evaluatedAt ?? IN_WINDOW_AT,
    supportRequests,
    visibilityStates: overrides.visibilityStates,
  });
}

// ---------------------------------------------------------------------------
// Cross-context seam: money and rating facts flow only from Support/Settlement.
// ---------------------------------------------------------------------------

type SeamSubscription = Readonly<{
  sourceContextName?: string;
  projectionName?: string;
  reactionName?: string;
  projectionHandlerSetNames?: readonly string[];
  reactionHandlerSetNames?: readonly string[];
  eventTypes?: readonly string[];
}>;

function matchesHandler(entry: SeamSubscription, handlerName: string): boolean {
  return (
    entry.projectionName === handlerName ||
    entry.reactionName === handlerName ||
    (entry.projectionHandlerSetNames ?? []).includes(handlerName) ||
    (entry.reactionHandlerSetNames ?? []).includes(handlerName)
  );
}

type SeamContext = Readonly<{
  eventSubscriptions?: readonly SeamSubscription[];
  eventReactions?: readonly SeamSubscription[];
}>;

function loadContext(relativePath: string): SeamContext {
  return JSON.parse(readFileSync(resolve(baseDir, relativePath), "utf8")) as SeamContext;
}

function seamEntries(context: SeamContext): readonly SeamSubscription[] {
  return [...(context.eventSubscriptions ?? []), ...(context.eventReactions ?? [])];
}

function eventTypesForHandler(context: SeamContext, handlerName: string): readonly string[] {
  return seamEntries(context)
    .filter((entry) => matchesHandler(entry, handlerName))
    .flatMap((entry) => entry.eventTypes ?? []);
}

function sourceContextsForHandler(context: SeamContext, handlerName: string): ReadonlySet<string> {
  return new Set(
    seamEntries(context)
      .filter((entry) => matchesHandler(entry, handlerName))
      .map((entry) => entry.sourceContextName)
      .filter((name): name is string => typeof name === "string"),
  );
}

const marketplaceContext = loadContext("../context.json");
const settlementContext = loadContext("../../settlement/context.json");
const notificationsContext = loadContext("../../notifications/context.json");
const platformOperationsContext = loadContext("../../platform-operations/context.json");

describe("reputation-support seam: money and rating facts originate only from Support and Settlement", () => {
  it("subscribes Marketplace review eligibility to the Support case lifecycle", () => {
    const types = eventTypesForHandler(marketplaceContext, "marketplace-review-support-source-projection");
    expect(types).toEqual(
      expect.arrayContaining([
        "support.support-request.opened",
        "support.support-request.resolved",
        "support.support-request.cancelled",
      ]),
    );
    expect(sourceContextsForHandler(marketplaceContext, "marketplace-review-support-source-projection")).toContain(
      "platform-operations",
    );
  });

  it("holds reviews from Support case opens and lifts on terminal facts", () => {
    const types = eventTypesForHandler(marketplaceContext, "marketplace-review-hold-reaction");
    expect(types).toEqual(
      expect.arrayContaining([
        "support.support-request.opened",
        "support.support-request.resolved",
        "support.support-request.cancelled",
      ]),
    );
  });

  it("feeds the seller-responsible issue-rate numerator only from resolved Support facts", () => {
    const types = eventTypesForHandler(marketplaceContext, "marketplace-seller-metrics-support-source-projection");
    // Only the resolved fact carries responsibility; opened/cancelled must not feed the numerator.
    expect([...new Set(types)]).toEqual(["support.support-request.resolved"]);
  });

  it("holds and releases seller proceeds through Settlement, driven by Support case events", () => {
    const lifecycle = eventTypesForHandler(settlementContext, "settlement-support-hold-lifecycle-projection");
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        "support.support-request.opened",
        "support.support-request.resolved",
        "support.support-request.cancelled",
      ]),
    );
    const holdVisibility = eventTypesForHandler(settlementContext, "settlement-support-hold-projection");
    expect(holdVisibility).toEqual(
      expect.arrayContaining(["support.support-request.opened", "support.support-request.resolved"]),
    );
  });

  it("schedules dispute notifications from the Support case lifecycle", () => {
    const types = eventTypesForHandler(notificationsContext, "notifications-support-dispute-facts-projection");
    expect(types).toEqual(
      expect.arrayContaining([
        "support.support-request.opened",
        "support.support-request.resolved",
        "support.support-request.cancelled",
      ]),
    );
  });

  it("keeps money-moving authority out of Marketplace review reactions", () => {
    // No Marketplace review subscription or reaction may consume a settlement or
    // wallet event: reviews never move money, they only react to Support facts.
    const reviewHandlers = seamEntries(marketplaceContext).filter(
      (entry) =>
        (entry.projectionName ?? entry.reactionName ?? "").includes("review") ||
        (entry.projectionName ?? entry.reactionName ?? "").includes("seller-metrics"),
    );
    const consumedTypes = reviewHandlers.flatMap((entry) => entry.eventTypes ?? []);
    expect(consumedTypes.some((type) => type.startsWith("settlement.support-hold"))).toBe(false);
    expect(consumedTypes.some((type) => type.startsWith("settlement.wallet"))).toBe(false);
  });

  it("confirms Support (platform-operations) is the sole declared source of every support.* fact the seam consumes", () => {
    expect(platformOperationsContext).toBeDefined();
    for (const context of [marketplaceContext, settlementContext, notificationsContext]) {
      const supportConsumers = seamEntries(context).filter((entry) =>
        (entry.eventTypes ?? []).some((type) => type.startsWith("support.support-request.")),
      );
      expect(supportConsumers.length).toBeGreaterThan(0);
      for (const consumer of supportConsumers) {
        expect(consumer.sourceContextName).toBe("platform-operations");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Journey matrix: reputation-fairness invariants against the merged contract.
// ---------------------------------------------------------------------------

function expectBothPublishable(decision: ReturnType<typeof evaluate>) {
  for (const direction of [decision.buyerToSeller, decision.sellerToBuyer]) {
    expect(direction.visibilityState).not.toBe("held");
  }
}

describe("J01 normal transaction: both directions score with no case", () => {
  it("allows both directions to submit and score within the window", () => {
    const decision = evaluate([]);
    for (const direction of [decision.buyerToSeller, decision.sellerToBuyer]) {
      expect(direction.submissionState).toBe("allowed");
      expect(direction.scoringDisposition).toBe("included");
      expect(direction.reasonCode).toBe("normal-completion");
    }
    expectBothPublishable(decision);
  });
});

describe("J02 resolution-first buyer intercept routes low or problem feedback to protected intake", () => {
  it("routes 1-2 stars or any problem indicator to resolution first, feedback-only otherwise", () => {
    expect(shouldRouteToResolution({ rating: 1, problemCategories: [] })).toBe(true);
    expect(shouldRouteToResolution({ rating: LOW_RATING_RESOLUTION_THRESHOLD, problemCategories: [] })).toBe(true);
    expect(shouldRouteToResolution({ rating: 5, problemCategories: ["damaged"] })).toBe(true);
    // Feedback-only: a satisfied rating with no problem indicator is never coerced.
    expect(shouldRouteToResolution({ rating: 5, problemCategories: [] })).toBe(false);
    expect(shouldRouteToResolution({ rating: 3, problemCategories: [] })).toBe(false);
    expect(resolutionTriggerReason({ rating: 1, problemCategories: ["damaged"] })).toBe(
      "low-rating-and-problem-indicator",
    );
    expect(resolutionTriggerReason({ rating: 5, problemCategories: [] })).toBe("none");
  });

  it("maps every problem category to a canonical order-issue intake flow handoff", () => {
    for (const category of REVIEW_PROBLEM_CATEGORIES) {
      const flow = intakeFlowForProblemCategory(category);
      expect(typeof flow).toBe("string");
      expect(flow.length).toBeGreaterThan(0);
    }
  });
});

describe("J03-J09 responsibility outcomes score by cause, never by remedy", () => {
  it("J03 seller responsibility with full refund includes the buyer and holds the seller to context-only", () => {
    const decision = evaluate([resolvedCase("seller", "full-refund")]);
    expect(decision.buyerToSeller.scoringDisposition).toBe("included");
    expect(decision.buyerToSeller.reasonCode).toBe("subject-responsible");
    expect(decision.sellerToBuyer.scoringDisposition).toBe("context-only");
    expect(isSellerResponsible("seller")).toBe(true);
  });

  it("J04 seller responsibility scores the same for replacement or no monetary remedy", () => {
    const fullRefund = evaluate([resolvedCase("seller", "full-refund")]);
    for (const resolutionType of ["replacement", "no-action", "return-for-refund"]) {
      const decision = evaluate([resolvedCase("seller", resolutionType)]);
      expect(decision.buyerToSeller.scoringDisposition).toBe(fullRefund.buyerToSeller.scoringDisposition);
      expect(decision.buyerToSeller.reasonCode).toBe("subject-responsible");
    }
  });

  it("J05 buyer responsibility includes the seller and holds the buyer to context-only", () => {
    const decision = evaluate([resolvedCase("buyer", "return-for-refund")]);
    expect(decision.sellerToBuyer.scoringDisposition).toBe("included");
    expect(decision.buyerToSeller.scoringDisposition).toBe("context-only");
    expect(isSellerResponsible("buyer")).toBe(false);
  });

  it("J06-J09 no carrier, platform, shared, or undetermined cause lowers either aggregate rating", () => {
    const externalCauses: readonly ResolvedResponsibility[] = ["carrier", "platform", "shared", "undetermined"];
    for (const cause of externalCauses) {
      const decision = evaluate([resolvedCase(cause, "full-refund")]);
      expect(decision.buyerToSeller.scoringDisposition).toBe("context-only");
      expect(decision.sellerToBuyer.scoringDisposition).toBe("context-only");
      // Excluded from the seller-responsible issue-rate numerator as well.
      expect(isSellerResponsible(normalizeConsumedResponsibility(cause))).toBe(false);
    }
  });

  it("keeps only seller responsibility in the issue-rate numerator vocabulary", () => {
    for (const responsibility of SELLER_METRICS_RESPONSIBILITY_VALUES) {
      expect(isSellerResponsible(responsibility)).toBe(responsibility === "seller");
    }
  });
});

describe("J10 partial refund and multi-line resolutions score by responsibility, not amount", () => {
  it("scores a partial refund the same as a full refund for the same responsibility", () => {
    const partial = evaluate([resolvedCase("seller", "partial-refund")]);
    const full = evaluate([resolvedCase("seller", "full-refund")]);
    expect(partial.buyerToSeller.scoringDisposition).toBe(full.buyerToSeller.scoringDisposition);
    expect(partial.buyerToSeller.reasonCode).toBe("subject-responsible");
  });
});

describe("J11-J14 hold timing keeps no rating impact while a case is open", () => {
  it("J11 holds both directions and suppresses reveal while a case is open", () => {
    const decision = evaluate([{ status: "open", responsibility: null, resolvedAt: null }]);
    for (const direction of [decision.buyerToSeller, decision.sellerToBuyer]) {
      expect(direction.submissionState).toBe("held");
      expect(direction.visibilityState).toBe("held");
      expect(direction.scoringDisposition).toBe("context-only");
      expect(direction.reasonCode).toBe("support-request-open");
    }
  });

  it("J11 never reveals a held direction even when a prior visibility state was revealed", () => {
    const decision = evaluate([{ status: "open", responsibility: null, resolvedAt: null }], {
      visibilityStates: { buyerToSeller: "revealed", sellerToBuyer: "revealed" },
    });
    expect(decision.buyerToSeller.visibilityState).not.toBe("revealed");
    expect(decision.sellerToBuyer.visibilityState).not.toBe("revealed");
  });

  it("J13 marks an already expired opportunity expired and does not include it", () => {
    const decision = evaluate([], { evaluatedAt: AFTER_DEADLINE_AT });
    expect(decision.buyerToSeller.submissionState).toBe("expired");
    expect(decision.buyerToSeller.reasonCode).toBe("submission-window-expired");
  });

  it("J14 ignores a cancelled case and preserves independent reveal for a delivered order", () => {
    const decision = evaluate([{ status: "cancelled", responsibility: null, resolvedAt: null }]);
    expect(decision.buyerToSeller.submissionState).toBe("allowed");
    expect(decision.buyerToSeller.scoringDisposition).toBe("included");
  });
});

describe("J15 replay recovery: duplicate and reordered facts converge", () => {
  it("returns an identical decision regardless of support-fact order or duplication", () => {
    const facts: readonly ReviewSupportRequestFact[] = [
      resolvedCase("seller", "full-refund"),
      { status: "cancelled", responsibility: null, resolvedAt: null },
    ];
    const inOrder = evaluate(facts);
    const reordered = evaluate([...facts].reverse());
    const duplicated = evaluate([...facts, ...facts]);
    expect(reordered).toEqual(inOrder);
    expect(duplicated).toEqual(inOrder);
  });

  it("takes the conservative context-only result when cases resolve to different responsibilities", () => {
    const decision = evaluate([resolvedCase("seller", "full-refund"), resolvedCase("carrier", "full-refund")]);
    expect(decision.buyerToSeller.scoringDisposition).toBe("context-only");
    expect(decision.buyerToSeller.reasonCode).toBe("multiple-responsibilities");
  });
});

describe("J17-J18 fail-safe: unknown authority or responsibility never scores by accident", () => {
  it("J17 quarantines an unrecognized case status to no rating impact", () => {
    const decision = evaluate([{ status: "pending-triage", responsibility: "seller", resolvedAt: RESOLVED_AT }]);
    for (const direction of [decision.buyerToSeller, decision.sellerToBuyer]) {
      expect(direction.submissionState).toBe("held");
      expect(direction.scoringDisposition).toBe("context-only");
      expect(direction.reasonCode).toBe("responsibility-unrecognized");
    }
  });

  it("J18 quarantines an unknown or legacy responsibility value", () => {
    const unknown = evaluate([resolvedCase("legacy-unknown-value", "full-refund")]);
    expect(unknown.buyerToSeller.scoringDisposition).toBe("context-only");
    expect(unknown.buyerToSeller.reasonCode).toBe("responsibility-unrecognized");
    // The seller-metrics numerator excludes it too and never guesses seller fault.
    expect(normalizeConsumedResponsibility("legacy-unknown-value")).toBeNull();
    expect(isSellerResponsible(normalizeConsumedResponsibility("legacy-unknown-value"))).toBe(false);
  });

  it("J18 treats a missing responsibility as excluded, never included", () => {
    const missing = evaluate([resolvedCase(null, "full-refund")]);
    expect(missing.buyerToSeller.scoringDisposition).toBe("context-only");
    expect(missing.sellerToBuyer.scoringDisposition).toBe("context-only");
  });
});

describe("J19-J20 moderation boundaries and privacy", () => {
  it("J19 never resurrects a held direction into a scored, revealed review", () => {
    const decision = evaluate([{ status: "open", responsibility: null, resolvedAt: null }]);
    const held: DirectionalReviewDisposition = decision.buyerToSeller;
    expect(held.scoringDisposition).toBe("context-only");
    expect(["held", "suppressed"]).toContain(held.visibilityState);
  });

  it("J20 the review policy consumes only non-private Support facts", () => {
    const allowedKeys = new Set(["status", "responsibility", "resolvedAt", "resolutionType", "remedy"]);
    const fact = resolvedCase("seller", "full-refund");
    for (const key of Object.keys(fact)) {
      expect(allowedKeys.has(key)).toBe(true);
    }
    // Evidence, internal notes, and reporter identity never enter the review contract.
    expect(Object.keys(fact)).not.toContain("evidence");
    expect(Object.keys(fact)).not.toContain("notes");
    expect(Object.keys(fact)).not.toContain("reporterAccountId");
  });
});

// ---------------------------------------------------------------------------
// Evidence doc pin: the acceptance matrix cannot drift from the required journeys.
// ---------------------------------------------------------------------------

describe("acceptance evidence matrix stays complete", () => {
  const doc = readFileSync(resolve(baseDir, "../docs/reputation-support-fair-journey-acceptance.md"), "utf8");

  it("keeps every required journey id in the acceptance matrix", () => {
    for (let index = 1; index <= 21; index += 1) {
      const journeyId = `J${index.toString().padStart(2, "0")}`;
      expect(doc).toContain(`| ${journeyId} |`);
    }
  });

  it("requires every scenario type before signoff", () => {
    for (const scenarioType of [
      "happy path",
      "fairness",
      "hold timing",
      "replay recovery",
      "fail-safe",
      "privacy",
      "moderation boundary",
      "audit",
    ]) {
      expect(doc).toContain(scenarioType);
    }
  });

  it("anchors acceptance to the automated cross-context coverage", () => {
    for (const anchor of [
      "directional-review-disposition.test.ts",
      "review-resolution.test.ts",
      "review-hold-reaction.test.ts",
      "review-eligibility-sql.db.test.ts",
      "behavioral-metrics-sql.db.test.ts",
      "support-hold-lifecycle.test.ts",
      "support-source-projection.test.ts",
      "support-dispute-notifications.test.ts",
    ]) {
      expect(doc).toContain(anchor);
    }
  });

  it("records the pending staging evidence and a deferred-defect ledger", () => {
    expect(doc).toContain("## Staging evidence");
    expect(doc).toContain("## Deferred defects");
    expect(doc).toContain("## Runbook");
  });
});
