import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import { context, fixture, preview, privateLimitTerms, seedOffer, terms } from "../tests/fixtures";
import { createBuyerOfferPolicyRoutes } from "./route";
import type { BuyerOfferPolicyServices } from "./runtime";

function app(runtime: BuyerOfferPolicyServices, accountId: string | null = "acc_buyer") {
  const result = new Hono<MarketplaceApiEnv>();
  result.use("*", async (c, next) => {
    c.set(
      "actor",
      accountId
        ? {
            accountId,
            userId: "usr_buyer",
            permissions: [],
            roleKey: "owner",
            sessionId: "ses_test",
            tenantId: "tnt_test",
            membershipId: "mbr_test",
          }
        : null,
    );
    c.set("context", accountId ? { ...context, audit: { ...context.audit, forAccountId: accountId as never } } : null);
    await next();
  });
  result.route("/policies", createBuyerOfferPolicyRoutes(runtime));
  return result;
}
const post = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("Buyer Offer Policy real account routes", () => {
  it("returns per-selection held Preview evidence on the actual command response", async () => {
    const { runtime } = await fixture();
    const response = await app(runtime).request(
      "/policies/bop_one/commands",
      post({ type: "PreviewBuyerOfferPolicy", expectedVersion: 1, operationId: "preview_evidence", terms }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "draft",
      preview: {
        terms,
        outcomes: [
          {
            offerId: "off_one",
            currentUnitItemAmount: "10.00",
            result: { status: "held", reason: "market-price-unavailable", evidence: { marketPrice: null } },
          },
        ],
      },
    });
  });
  it("retains private-limit sentinels only in owner reads throughout the lifecycle", async () => {
    const { runtime } = await fixture();
    const p = await preview(runtime, privateLimitTerms);
    for (const status of ["draft", "active", "paused", "stopped"] as const) {
      if (status === "active") {
        await runtime.execute(
          "bop_one",
          {
            type: "AuthorizeBuyerOfferPolicy",
            expectedVersion: 2,
            operationId: "authorize",
            previewId: p.preview!.previewId,
            consent: true,
          },
          context,
        );
      } else if (status !== "draft") {
        await runtime.execute(
          "bop_one",
          {
            type: status === "paused" ? "PauseBuyerOfferPolicy" : "StopBuyerOfferPolicy",
            expectedVersion: status === "paused" ? 3 : 4,
            operationId: status,
          },
          context,
        );
      }
      const response = await app(runtime).request("/policies/bop_one");
      expect(response.status).toBe(200);
      const owner = await response.json();
      expect(owner.status).toBe(status);
      expect(status === "draft" ? owner.preview.terms : owner.authority).toEqual(privateLimitTerms);
      expect(owner.consumedItemAmount).toBe("0.00");
      expect(owner.remainingItemAllowance).toBe(status === "draft" ? null : "98765.43");
      const foreign = await app(runtime, "acc_other").request("/policies/bop_one");
      expect(foreign.status).toBe(404);
      expect(await foreign.json()).toEqual({ error: { code: "not_found" } });
    }
  });
  it("rejects foreign and accepted selection through the authenticated route without events", async () => {
    const { runtime, store } = await fixture();
    await seedOffer(store, "off_foreign", "acc_other");
    await store.appendToStream({
      streamId: "marketplace.offer-off_one",
      expectedVersion: 1,
      context,
      events: [
        {
          eventType: "marketplace.offer.accepted",
          payload: { offerId: "off_one", acceptedAt: "2026-09-27T12:00:00.000Z" },
        },
      ],
    });
    const before = await store.readAll();
    for (const [offerId, offerVersion] of [
      ["off_foreign", 1],
      ["off_one", 2],
    ] as const) {
      const response = await app(runtime).request(
        "/policies/bop_one/commands",
        post({
          type: "PreviewBuyerOfferPolicy",
          expectedVersion: 1,
          operationId: "preview",
          terms: { ...terms, offers: [{ ...terms.offers[0], offerId, offerVersion }] },
        }),
      );
      expect(response.status).toBe(409);
    }
    expect(await store.readAll()).toEqual(before);
  });
  it("uses authenticated account authority and matches foreign/missing-ID responses", async () => {
    const { runtime, store } = await fixture();
    const p = await preview(runtime);
    const owner = await app(runtime).request("/policies/bop_one");
    expect(owner.status).toBe(200);
    expect((await owner.json()).preview.terms).toEqual(terms);
    const before = await store.readAll();
    for (const method of ["GET", "POST"]) {
      const options =
        method === "GET"
          ? undefined
          : post({
              type: "AuthorizeBuyerOfferPolicy",
              expectedVersion: 2,
              operationId: "attack",
              previewId: p.preview!.previewId,
              consent: true,
            });
      const foreign = await app(runtime, "acc_other").request(
        `/policies/bop_one${method === "POST" ? "/commands" : ""}`,
        options,
      );
      const missing = await app(runtime, "acc_other").request(
        `/policies/bop_missing${method === "POST" ? "/commands" : ""}`,
        options,
      );
      expect(foreign.status).toBe(404);
      expect(missing.status).toBe(404);
      expect(await foreign.json()).toEqual(await missing.json());
    }
    expect(await store.readAll()).toEqual(before);
    expect((await app(runtime, null).request("/policies/bop_one")).status).toBe(401);
  });
  it.each([
    { terms: { ...terms, offers: [] } },
    { terms: { ...terms, offers: [...terms.offers, ...terms.offers] } },
    { terms: { ...terms, offers: Array.from({ length: 101 }, () => terms.offers[0]) } },
    { terms: { ...terms, currency: "EUR" } },
    { terms: { ...terms, offers: [{ ...terms.offers[0], offerId: "off_missing" }] } },
    { terms: { ...terms, offers: [{ ...terms.offers[0], offerVersion: 2 }] } },
    { terms: { ...terms, offers: [{ ...terms.offers[0], quantity: 3 }] } },
    { terms: { ...terms, adjustmentBps: -2501 } },
    { buyerAccountId: "acc_other" },
    { consumedItemAmount: "0.00" },
  ])("rejects tampered or incomplete preview at the actual route: %j", async (changes) => {
    const { runtime, store } = await fixture();
    const before = await store.readAll();
    const response = await app(runtime).request(
      "/policies/bop_one/commands",
      post({ type: "PreviewBuyerOfferPolicy", expectedVersion: 1, operationId: "preview", terms, ...changes }),
    );
    expect([400, 409]).toContain(response.status);
    expect(await store.readAll()).toEqual(before);
  });
  it("rejects concurrent preview revision and nonaffirmative consent without events", async () => {
    const { runtime, store } = await fixture();
    const p = await preview(runtime);
    await preview(runtime, { ...terms, adjustmentBps: -2500 }, 2, "second_preview");
    const before = await store.readAll();
    for (const consent of [true, false, undefined]) {
      const response = await app(runtime).request(
        "/policies/bop_one/commands",
        post({
          type: "AuthorizeBuyerOfferPolicy",
          expectedVersion: p.version,
          operationId: "authorize",
          previewId: p.preview!.previewId,
          consent,
        }),
      );
      expect([400, 409]).toContain(response.status);
    }
    expect(await store.readAll()).toEqual(before);
  });
  it("production activation is explicitly unavailable through the route", async () => {
    const { runtime } = await fixture(false);
    const p = await preview(runtime);
    const response = await app(runtime).request(
      "/policies/bop_one/commands",
      post({
        type: "AuthorizeBuyerOfferPolicy",
        expectedVersion: p.version,
        operationId: "authorize",
        previewId: p.preview!.previewId,
        consent: true,
      }),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "enforcement_unavailable" } });
  });
});
