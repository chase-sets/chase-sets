import { describe, expect, it } from "vitest";
import {
  applySellListReadinessToLines,
  createSellListReadinessSnapshot,
  parseSellListReadinessDecisionInput,
  validateSellListReadinessSnapshot,
  type SellListReadinessLine,
} from "./readiness";
import type { SellListSellerConfirmationEvidence } from "./domain";

const selectedOfferLine: SellListReadinessLine = {
  seller_account_id: "acc_seller",
  line_id: "sll_offer",
  line_type: "selected-offer",
  offer_id: "off_ready",
  listing_id: "lst_ready",
  offer_price_amount: "120.00",
  product_id: "cat_1::form:raw",
  item_title: "Charizard",
  quantity: 1,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  updated_at: "2026-06-09T00:00:00.000Z",
};

const productLine: SellListReadinessLine = {
  seller_account_id: "acc_seller",
  line_id: "sll_product",
  line_type: "product",
  offer_id: null,
  listing_id: null,
  offer_price_amount: null,
  product_id: "cat_2::form:raw",
  item_title: "Blastoise",
  quantity: 2,
  fallback_mode: "none",
  minimum_listing_price_amount: null,
  updated_at: "2026-06-09T00:00:00.000Z",
};

const sellerEvidence: SellListSellerConfirmationEvidence = {
  shipFrom: {
    status: "ready",
    addressId: "adr_seller",
    country: "US",
    region: "KS",
    postalCode: "67202",
  },
  payout: {
    status: "ready",
    method: "saved-payout",
    readinessStatus: "ready",
    lastCheckedAt: "2026-06-09T00:00:00.000Z",
  },
  label: {
    status: "ready",
    preference: "prepaid-label",
  },
  conditionReview: {
    status: "accepted",
    acceptedAt: "2026-06-09T00:00:00.000Z",
  },
  risk: { status: "clear" },
  provider: { status: "ready" },
  freshness: { status: "current" },
};

describe("sell list readiness snapshots", () => {
  it("marks selected offers with accepted offer facts ready for seller checkout", () => {
    const snapshot = createSellListReadinessSnapshot([selectedOfferLine], null, sellerEvidence);

    expect(snapshot).toMatchObject({
      schemaVersion: "checkout.sell-list-readiness.v1",
      source: "sell-list",
      status: "ready",
      sellerReadiness: {
        status: "ready",
        payout: "ready",
        shipFrom: "ready",
        label: "ready",
      },
      includedLineIds: ["sll_offer"],
      unresolvedLineIds: [],
      lineOutcomes: [
        {
          lineId: "sll_offer",
          outcome: "checkout",
          reason: "ready",
          action: "selected-offer",
        },
      ],
    });
    expect(snapshot.snapshotId).toMatch(/^slr_/);
    expect(snapshot.sellerReadiness.evidenceRevision).toMatch(/^slr_/);
  });

  it("keeps product lines unresolved until the pre-checkout review chooses a sale action", () => {
    const snapshot = createSellListReadinessSnapshot([selectedOfferLine, productLine], null, sellerEvidence);

    expect(snapshot.status).toBe("needs-resolution");
    expect(snapshot.includedLineIds).toEqual(["sll_offer"]);
    expect(snapshot.unresolvedLineIds).toEqual(["sll_product"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "sll_product",
      outcome: "checkout",
      reason: "missing-sale-action",
      action: null,
    });
  });

  it("accepts Smart Match and fallback listing actions as pre-checkout readiness decisions", () => {
    const fallbackLine: SellListReadinessLine = {
      ...productLine,
      line_id: "sll_fallback",
      fallback_mode: "create-listing",
      minimum_listing_price_amount: "19.99",
    };
    const snapshot = createSellListReadinessSnapshot(
      [productLine, fallbackLine],
      {
        lineActions: [{ lineId: "sll_product", action: "smart-match" }],
      },
      sellerEvidence,
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.includedLineIds).toEqual(["sll_fallback", "sll_product"]);
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "sll_product",
      outcome: "checkout",
      reason: "ready",
      action: "smart-match",
    });
    expect(snapshot.lineOutcomes).toContainEqual({
      lineId: "sll_fallback",
      outcome: "checkout",
      reason: "ready",
      action: "fallback-listing",
    });
  });

  it("keeps unresolved or intentionally skipped lines outside seller checkout", () => {
    const removedLine: SellListReadinessLine = { ...productLine, line_id: "sll_removed" };
    const snapshot = createSellListReadinessSnapshot(
      [selectedOfferLine, productLine, removedLine],
      {
        lineOutcomes: [
          { lineId: "sll_product", outcome: "keep-in-list" },
          { lineId: "sll_removed", outcome: "removed" },
        ],
      },
      sellerEvidence,
    );

    expect(snapshot.status).toBe("ready");
    expect(snapshot.includedLineIds).toEqual(["sll_offer"]);
    expect(snapshot.unresolvedLineIds).toEqual([]);
    expect(applySellListReadinessToLines([selectedOfferLine, productLine, removedLine], snapshot)).toEqual([
      selectedOfferLine,
    ]);
  });

  it("records missing seller evidence as explicit blocked readiness", () => {
    const snapshot = createSellListReadinessSnapshot([selectedOfferLine]);

    expect(snapshot.status).toBe("ready");
    expect(snapshot.sellerReadiness).toMatchObject({
      status: "blocked",
      evidenceRevision: null,
      payout: "blocked",
      shipFrom: "blocked",
      label: "blocked",
    });
    expect(snapshot.sellerReadiness.outcomes).toContainEqual({
      dimension: "payout",
      status: "blocked",
      reason: "missing-seller-evidence",
    });
  });

  it("blocks seller readiness when payout evidence is present but not ready", () => {
    const restrictedPayoutEvidence: SellListSellerConfirmationEvidence = {
      ...sellerEvidence,
      payout: {
        ...sellerEvidence.payout,
        readinessStatus: "restricted",
      },
    };
    const snapshot = createSellListReadinessSnapshot([selectedOfferLine], null, restrictedPayoutEvidence);

    expect(snapshot.status).toBe("ready");
    expect(snapshot.sellerReadiness).toMatchObject({
      status: "blocked",
      payout: "blocked",
      shipFrom: "ready",
      label: "ready",
    });
    expect(snapshot.sellerReadiness.outcomes).toContainEqual({
      dimension: "payout",
      status: "blocked",
      reason: "payout-not-ready",
    });
  });

  it("parses sell-list readiness decisions without promoting malformed values", () => {
    expect(
      parseSellListReadinessDecisionInput({
        line_outcomes: [
          { line_id: "sll_keep", outcome: "keep-in-list" },
          { line_id: "sll_removed", outcome: "removed" },
          { line_id: "sll_bad", outcome: "checkout" },
        ],
        line_actions: [
          { line_id: "sll_smart", action: "smart-match" },
          { line_id: "sll_fallback", action: "fallback-listing" },
          { line_id: "sll_bad", action: "provider-ready" },
        ],
      }),
    ).toEqual({
      lineOutcomes: [
        { lineId: "sll_keep", outcome: "keep-in-list" },
        { lineId: "sll_removed", outcome: "removed" },
      ],
      lineActions: [
        { lineId: "sll_smart", action: "smart-match" },
        { lineId: "sll_fallback", action: "fallback-listing" },
      ],
    });
  });

  it("rejects stale sell-list readiness tokens when line facts change", () => {
    const snapshot = createSellListReadinessSnapshot([selectedOfferLine], null, sellerEvidence);
    const changedLine = { ...selectedOfferLine, quantity: 2 };

    expect(
      validateSellListReadinessSnapshot([changedLine], {
        snapshotId: snapshot.snapshotId,
        sourceRevision: snapshot.sourceRevision,
        sellerEvidence,
      }),
    ).toMatchObject({
      valid: false,
      current: { status: "ready" },
    });
  });

  it("rejects stale seller evidence tokens when seller evidence changes", () => {
    const snapshot = createSellListReadinessSnapshot([selectedOfferLine], null, sellerEvidence);
    const changedEvidence: SellListSellerConfirmationEvidence = {
      ...sellerEvidence,
      payout: { ...sellerEvidence.payout, lastCheckedAt: "2026-06-09T00:01:00.000Z" },
    };

    expect(
      validateSellListReadinessSnapshot([selectedOfferLine], {
        snapshotId: snapshot.snapshotId,
        sourceRevision: snapshot.sourceRevision,
        sellerEvidence: changedEvidence,
      }),
    ).toMatchObject({
      valid: false,
      current: { sellerReadiness: { status: "ready" } },
    });
  });
});
