import { describe, expect, it } from "vitest";
import {
  csatWorkflowOutcomeCodes,
  csatWorkflowOutcomeSourceContext,
  isCsatWorkflowOutcomeCode,
  isProvenanceAuthoritative,
  sourceContextForOutcomeCode,
} from "./workflow-outcomes";

describe("workflow / outcome code allow-list", () => {
  it("rejects arbitrary client-supplied codes", () => {
    expect(isCsatWorkflowOutcomeCode("checkout.completed")).toBe(true);
    expect(isCsatWorkflowOutcomeCode("something.made-up")).toBe(false);
    expect(isCsatWorkflowOutcomeCode("")).toBe(false);
  });

  it("maps every code to exactly one owning source context", () => {
    for (const code of csatWorkflowOutcomeCodes) {
      expect(typeof sourceContextForOutcomeCode(code)).toBe("string");
      expect(csatWorkflowOutcomeSourceContext[code].length).toBeGreaterThan(0);
    }
  });

  it("covers the journey outcomes the three coverage leaves publish", () => {
    for (const code of [
      "checkout.recovered",
      "order.delivered",
      "return.resolved",
      "support.request-resolved",
      "reputation.review-received",
      "listing.published",
      "offer.accepted",
      "inventory.item-adjusted",
      "payout.completed",
      "discovery.search-completed",
      "registration.completed",
      "authentication.completed",
      "onboarding.completed",
    ]) {
      expect(isCsatWorkflowOutcomeCode(code)).toBe(true);
    }
  });

  it("only trusts provenance when the code's owner matches the claimed source context", () => {
    expect(isProvenanceAuthoritative("checkout.completed", "checkout")).toBe(true);
    expect(isProvenanceAuthoritative("checkout.completed", "marketplace")).toBe(false);
    expect(isProvenanceAuthoritative("not.a.code", "checkout")).toBe(false);
  });
});
