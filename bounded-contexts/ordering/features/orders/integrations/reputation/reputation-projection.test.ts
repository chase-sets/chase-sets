import { describe, expect, it, vi } from "vitest";
import { buildTransportEvent } from "@chase-sets/event-core/test-support";
import {
  reviewOpportunityFactType,
  type ReviewOpportunityChangedV1,
} from "@chase-sets/event-core/review-opportunity-facts";
import { buildOrderingReputationProjectionHandlers, orderingOpportunitySourceEvents } from "./reputation-projection";
import { orderReviewOutcome } from "./reputation-queries";
import manifest from "../../../../context.json";

const fact: ReviewOpportunityChangedV1 = {
  factSchemaVersion: 1,
  orderId: "ord_1",
  buyerAccountId: "acc_buyer",
  sellerAccountId: "acc_seller",
  generation: "1",
  sourceGeneration: "1",
  provenance: { ordering: "10", fulfillment: "10", support: "10", marketplace: "10" },
  generatedAt: "2026-04-01T00:00:00.000Z",
  sellerToBuyer: null,
  buyerToSeller: {
    authorRole: "buyer",
    eligibleAt: "2026-04-01T00:00:00.000Z",
    effectiveDeadlineAt: "2026-06-01T00:00:00.000Z",
    submissionState: "allowed",
    held: false,
    activeReviewId: null,
    activeReviewRevealedAt: null,
  },
};
const row = {
  fact,
  valid: true,
  current: true,
  buyer_account_id: "acc_buyer",
  seller_account_id: "acc_seller",
  subject_display_name: "Seller",
  source_positions: { ordering: "10" },
};
const beforeDeadline = new Date("2026-05-01T00:00:00Z");
const afterDeadline = new Date("2026-07-01T00:00:00Z");

describe("canonical Ordering review outcomes", () => {
  it("expires an unsubmitted opportunity without another event, never a revealed or held review", () => {
    expect(orderReviewOutcome(row, "acc_buyer", beforeDeadline)).toMatchObject({
      status: "ready",
      opportunity: { submission_state: "allowed" },
    });
    expect(orderReviewOutcome(row, "acc_buyer", afterDeadline)).toMatchObject({
      status: "ready",
      opportunity: { submission_state: "expired" },
    });
    for (const held of [false, true]) {
      const revealed = {
        ...fact,
        buyerToSeller: {
          ...fact.buyerToSeller!,
          held,
          activeReviewId: "rev_1",
          activeReviewRevealedAt: fact.generatedAt,
        },
      };
      expect(orderReviewOutcome({ ...row, fact: revealed }, "acc_buyer", afterDeadline)).toMatchObject({
        opportunity: { submission_state: held ? "held" : "allowed", window_expired: false, revealed: !held },
      });
    }
  });
  it("distinguishes proven absence from missing, malformed, lagging, foreign-party and rebuilding state", () => {
    expect(orderReviewOutcome(row, "acc_seller", afterDeadline)).toEqual({ status: "ready", opportunity: null });
    const cases = [
      undefined,
      { ...row, current: false },
      { ...row, valid: false },
      { ...row, fact: { ...fact, factSchemaVersion: 2 } },
      { ...row, source_positions: { ordering: "11" } },
      { ...row, buyer_account_id: "acc_other" },
    ];
    for (const value of cases)
      expect(orderReviewOutcome(value, "acc_buyer", beforeDeadline)).toEqual({
        status: "unavailable",
        opportunity: null,
      });
    expect(orderReviewOutcome(row, "acc_foreign", beforeDeadline).status).toBe("unavailable");
  });
  it("does not expire an unchanged current snapshot merely because its generation instant is old", () => {
    expect(orderReviewOutcome(row, "acc_seller", new Date("2036-01-01T00:00:00Z"))).toEqual({
      status: "ready",
      opportunity: null,
    });
  });
  it.each([
    { direction: "buyerToSeller", authorRole: "buyer", accountId: "acc_buyer" },
    { direction: "sellerToBuyer", authorRole: "seller", accountId: "acc_seller" },
  ])(
    "rejects malformed $direction admission instead of rendering allowed",
    async ({ direction, authorRole, accountId }) => {
      const malformed = {
        ...fact,
        [direction]: { ...fact.buyerToSeller!, authorRole, submissionState: ["held"] },
      };
      const db = { query: vi.fn(async () => ({ rows: [] })) };
      await buildOrderingReputationProjectionHandlers(db)[reviewOpportunityFactType]!(
        buildTransportEvent(reviewOpportunityFactType, malformed),
      );
      expect(db.query).toHaveBeenCalledWith(expect.any(String), ["ord_1", "1", expect.any(String), null, false]);
      expect(orderReviewOutcome({ ...row, fact: malformed }, accountId, beforeDeadline)).toEqual({
        status: "unavailable",
        opportunity: null,
      });
    },
  );
  it("wires exactly the declared source events and versions, without a local eligibility engine", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    const handlers = buildOrderingReputationProjectionHandlers(db);
    for (const [source, eventTypes] of Object.entries(orderingOpportunitySourceEvents)) {
      const declaration = manifest.eventSubscriptions.find(
        (item) =>
          item.projectionName === "ordering-order-review-opportunity-projection" && item.sourceContextName === source,
      )!;
      expect(declaration.subscriptionVersion).toBe(2);
      expect([...declaration.eventTypes].sort()).toEqual([...eventTypes].sort());
      for (const eventType of eventTypes) expect(handlers[eventType]).toBeTypeOf("function");
    }
    await handlers[reviewOpportunityFactType]!(buildTransportEvent(reviewOpportunityFactType, fact));
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("EXCLUDED.generation >"),
      expect.arrayContaining(["ord_1", "1", JSON.stringify(fact), true]),
    );
    db.query.mockClear();
    await handlers["support.support-request.resolved"]!(
      buildTransportEvent("support.support-request.resolved", { orderId: "ord_1" }),
    );
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("ordering_order_review_opportunity_sources"),
      expect.any(Array),
    );
  });
  it("declares canonical opportunity freshness for both detail routes", () => {
    const routes = manifest.apiMounts.flatMap((entry) => entry.readFreshnessRoutes ?? []);
    for (const routePath of ["/purchases/:id", "/sales/:id"]) {
      const dependencies = routes.find((route) => route.routePath === routePath)!.dependencies;
      expect(dependencies).toContainEqual({ readModelTable: "ordering_order_review_opportunity_pages" });
      expect(dependencies).not.toContainEqual({ readModelTable: "ordering_order_review_eligibility_pages" });
    }
  });
});
