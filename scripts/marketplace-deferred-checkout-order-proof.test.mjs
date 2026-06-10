import { describe, expect, it } from "vitest";
import {
  DEFERRED_CHECKOUT_ORDER_PROOF_VERSION,
  buildDeferredCheckoutOrderProofEvidence,
  parseDeferredCheckoutOrderProofArgs,
  runDeferredCheckoutOrderProof,
} from "./marketplace-deferred-checkout-order-proof.mjs";

const proofRequest = {
  proofInputReference: "STRIPE-LIVE-CHECKOUT-INPUT-2026-05-30",
  source: {
    type: "buy-now",
    listingId: "lst_live_proof",
    catalogItemId: "cat_live_proof",
    productId: "prd_live_proof",
    itemTitle: "Live proof listing",
    selectedOptions: [],
    quantity: 1,
    fulfillmentMode: "locked-listing",
  },
  shippingOption: "standard",
  optimizationGoal: "lowest-total",
  shippingAddress: {
    name: "Proof Operator",
    line1: "1 Proof Way",
    city: "Columbus",
    state: "OH",
    postalCode: "43004",
    country: "US",
  },
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("marketplace deferred checkout order proof", () => {
  it("creates a deferred checkout session and returns order ids for Stripe smoke", async () => {
    const calls = [];
    const evidence = await runDeferredCheckoutOrderProof(
      {
        baseUrl: "https://chasesets.com",
        request: proofRequest,
        reference: "STRIPE-LIVE-PROOF-2026-05-30",
        operator: "ops@chasesets.com",
        checkedAt: "2026-05-30T12:00:00.000Z",
        allowProduction: "true",
        authorization: "Bearer proof",
      },
      async (url, init) => {
        calls.push({ url: String(url), init, body: JSON.parse(init.body) });
        const path = new URL(String(url)).pathname;
        if (path === "/api/marketplace/account/checkout-sessions") {
          return jsonResponse({ session_id: "chk_live_proof", status: "started" }, 201);
        }
        if (path === "/api/marketplace/account/checkout-sessions/chk_live_proof/confirm") {
          return jsonResponse({ order_ids: ["ord_live_1"], status: "orders-created" });
        }
        return jsonResponse({ error: { code: "not_found" } }, 404);
      },
    );

    expect(evidence).toMatchObject({
      schemaVersion: DEFERRED_CHECKOUT_ORDER_PROOF_VERSION,
      reference: "STRIPE-LIVE-PROOF-2026-05-30",
      checkoutSessionId: "chk_live_proof",
      orderIds: ["ord_live_1"],
      orderIdsCsv: "ord_live_1",
      passesDeferredCheckoutOrderProofGate: true,
    });
    expect(calls[0].body).toMatchObject({
      source: proofRequest.source,
      shippingOption: "standard",
    });
    expect(calls[1].body).toMatchObject({
      deferPayment: true,
      deferredCheckoutOrderProofReference: "STRIPE-LIVE-PROOF-2026-05-30",
      acknowledgedMaterialChanges: true,
      shippingAddress: proofRequest.shippingAddress,
    });
    expect(calls[0].init.headers.get("Authorization")).toBe("Bearer proof");
  });

  it("requires an explicit production safety switch", async () => {
    await expect(
      runDeferredCheckoutOrderProof(
        {
          baseUrl: "https://chasesets.com",
          request: proofRequest,
          reference: "STRIPE-LIVE-PROOF-2026-05-30",
          operator: "ops@chasesets.com",
          authorization: "Bearer proof",
        },
        async () => jsonResponse({}),
      ),
    ).rejects.toThrow(/DEFERRED_CHECKOUT_ORDER_PROOF_ALLOW_PRODUCTION=true/);
  });

  it("validates launch evidence metadata before reporting success", () => {
    expect(
      buildDeferredCheckoutOrderProofEvidence({
        reference: "",
        operator: "",
        checkedAt: "2026-05-30T12:00:00.000Z",
        baseUrl: "https://preview.chasesets.com",
        proofInputReference: "todo",
        sourceType: "buy-now",
        shippingOption: "standard",
        checkoutSessionId: "",
        orderIds: ["ord_1", "ord_1", ""],
        confirmStatus: "started",
      }),
    ).toMatchObject({
      passesDeferredCheckoutOrderProofGate: false,
      errors: [
        "Deferred checkout order proof requires a production proof reference.",
        "Deferred checkout order proof requires an operator.",
        "Deferred checkout order proof must target https://chasesets.com or https://admin.chasesets.com.",
        "Deferred checkout order proof proofInputReference must point to a real external evidence record, not a placeholder.",
        "Deferred checkout order proof requires checkoutSessionId.",
        "Deferred checkout order proof orderIds must be non-empty strings.",
        "Deferred checkout order proof orderIds must be unique.",
        "Deferred checkout order proof confirmStatus must be orders-created.",
      ],
    });
  });

  it("rejects stale-looking metadata and placeholder production references", () => {
    const evidence = buildDeferredCheckoutOrderProofEvidence({
      reference: "record",
      operator: "ops@chasesets.com",
      checkedAt: "not-a-date",
      baseUrl: "https://chasesets.com",
      proofInputReference: "",
      sourceType: "buy-now",
      shippingOption: "standard",
      checkoutSessionId: "chk_1",
      orderIds: ["ord_1"],
      confirmStatus: "orders-created",
    });

    expect(evidence.passesDeferredCheckoutOrderProofGate).toBe(false);
    expect(evidence.errors).toContain(
      "Deferred checkout order proof reference must point to a real external evidence record, not a placeholder.",
    );
    expect(evidence.errors).toContain("Deferred checkout order proof checkedAt must be an ISO timestamp.");
    expect(evidence.errors).toContain("Deferred checkout order proof requires proofInputReference.");
  });

  it("resolves options from flags and environment", () => {
    expect(
      parseDeferredCheckoutOrderProofArgs(
        [
          "--base-url",
          "https://admin.chasesets.com",
          "--request",
          "request.json",
          "--reference",
          "REF",
          "--operator",
          "Ops",
        ],
        {
          PLATFORM_API_AUTHORIZATION: "Bearer env",
        },
      ),
    ).toMatchObject({
      baseUrl: "https://admin.chasesets.com",
      requestPath: "request.json",
      reference: "REF",
      operator: "Ops",
      authorization: "Bearer env",
    });
  });
});
