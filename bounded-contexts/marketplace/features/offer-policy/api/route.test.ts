import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { MarketplaceApiEnv } from "../../../api";
import { createMarketplaceApiClient } from "../../../client";
import { hashMarketplaceRequest } from "../../mutation-recovery/api/attempt";
import { createMarketplaceMutationLookup } from "../../mutation-recovery/api/lookup";
import { createMarketplaceMutationRecoveryRoutes } from "../../mutation-recovery/api/route";
import { activate, context, fixture, preview, privateLimitTerms, seedOffer, terms } from "../tests/fixtures";
import { createBuyerOfferPolicyRoutes } from "./route";
import type { BuyerOfferPolicyServices } from "./runtime";
import { submittedOfferPolicyAction } from "./submitted-offer-route";

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
  it("reads a recorded historical authorized and consumed stream without retired keys", async () => {
    const { runtime, store } = await fixture();
    const created = (await store.readStream({ streamId: "marketplace.offer-policy-bop_one" }))[0]!;
    const audit = created.payload;
    await store.appendToStream({
      streamId: created.streamId,
      expectedVersion: 1,
      context,
      events: [
        {
          eventType: "marketplace.offer-policy.authorized",
          payload: {
            ...audit,
            operationId: "historical_authorize",
            previewId: "a".repeat(64),
            policyVersion: 1,
            terms: { ...terms, itemCommitmentAllowance: "10.00" },
            revision: 1,
            consentedAt: audit.recordedAt,
          },
        },
        {
          eventType: "marketplace.offer-policy.commitment-consumed",
          payload: {
            ...audit,
            operationId: "historical_accept",
            offerId: "off_historical",
            offerVersion: 2,
            revision: 1,
            currency: "USD",
            unitItemAmount: "9.00",
            quantity: 1,
            itemAmount: "9.00",
            consumedItemAmount: "9.00",
            evaluationEvidence: {},
          },
        },
      ],
    });
    const response = await app(runtime).request("/policies/bop_one");
    expect(response.status).toBe(200);
    const owner = await response.json();
    expect(owner).toMatchObject({ status: "active", version: 3, authority: terms });
    for (const field of ["itemCommitmentAllowance", "consumedItemAmount", "remainingItemAllowance"])
      expect(JSON.stringify(owner)).not.toContain(`"${field}"`);
  });
  it("previews and authorizes without an allowance, rejecting the retired field on both commands", async () => {
    const { runtime, store } = await fixture();
    const cleanTerms = { currency: "USD", adjustmentBps: 0, offers: terms.offers };
    const previewCommand = {
      attemptId: String("clean_preview").padEnd(22, "_"),
      type: "PreviewBuyerOfferPolicy",
      expectedVersion: 1,
      operationId: "clean_preview",
      terms: cleanTerms,
    };
    const before = await store.readAll();
    const rejected = await app(runtime).request(
      "/policies/bop_one/commands",
      post({ ...previewCommand, terms: { ...cleanTerms, itemCommitmentAllowance: "10.00" } }),
    );
    expect(rejected.status).toBe(400);
    expect(await store.readAll()).toEqual(before);
    const response = await app(runtime).request("/policies/bop_one/commands", post(previewCommand));
    expect(response.status).toBe(200);
    const p = await response.json();
    const authorize = {
      attemptId: String("clean_authorize").padEnd(22, "_"),
      type: "AuthorizeBuyerOfferPolicy",
      expectedVersion: p.version,
      operationId: "clean_authorize",
      previewId: p.preview.previewId,
      consent: true,
    };
    expect(
      (
        await app(runtime).request(
          "/policies/bop_one/commands",
          post({ ...authorize, itemCommitmentAllowance: "10.00" }),
        )
      ).status,
    ).toBe(400);
    const active = await app(runtime).request("/policies/bop_one/commands", post(authorize));
    expect(active.status).toBe(200);
    expect(await active.json()).toMatchObject({ status: "active", authority: cleanTerms });
  });
  it("recovers a lost real-caller Preview by its own hash, replays the same body and conflicts on a changed one", async () => {
    const { runtime, store } = await fixture();
    const server = app(runtime);
    server.route("/account/offer-policies", createBuyerOfferPolicyRoutes(runtime));
    server.route("/", createMarketplaceMutationRecoveryRoutes(createMarketplaceMutationLookup(store)));
    const calls: string[] = [];
    let loseNextCommand = true;
    const api = createMarketplaceApiClient({
      baseUrl: "http://marketplace.test",
      fetch: async (input, init) => {
        const response = await server.request(String(input), init);
        calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname} ${response.status}`);
        if (loseNextCommand && String(input).endsWith("/commands")) {
          loseNextCommand = false;
          throw new TypeError("response lost after commit");
        }
        return response;
      },
    });
    const attemptId = String("parity_preview").padEnd(22, "_");
    const command = {
      attemptId,
      type: "PreviewBuyerOfferPolicy",
      expectedVersion: 1,
      operationId: "parity_preview",
      terms: { currency: "USD", offers: terms.offers },
    };
    const submit = (body: unknown) => {
      const form = new FormData();
      form.set("policyId", "bop_one");
      form.set("command", JSON.stringify(body));
      return submittedOfferPolicyAction(new Request("http://marketplace.test/", { method: "POST", body: form }), api);
    };

    const recovered = await submit(command);
    expect(recovered).toMatchObject({ error: null, policy: { version: 2, preview: { terms: { adjustmentBps: 0 } } } });
    expect(calls).toEqual([
      "POST /account/offer-policies/bop_one/commands 200",
      `GET /mutation-attempts/${attemptId} 200`,
      "GET /account/offer-policies/bop_one 200",
    ]);
    const { attemptId: _attemptId, ...undefaulted } = command;
    const control = await server.request(
      `/mutation-attempts/${attemptId}?${new URLSearchParams({
        kind: "offer-policy.command",
        target: "bop_one",
        requestHash: hashMarketplaceRequest(undefaulted),
      })}`,
    );
    expect(await control.json()).toMatchObject({ ownerStatus: "not-observed" });

    const committed = await store.readAll();
    expect(await submit(command)).toMatchObject({
      error: null,
      policy: { version: 2, preview: { previewId: recovered.policy!.preview!.previewId } },
    });
    expect(await submit({ ...command, terms: { ...command.terms, adjustmentBps: -100 } })).toEqual({
      policy: null,
      error: "invalid_authority",
    });
    expect(calls.at(-1)).toBe("POST /account/offer-policies/bop_one/commands 409");
    const sent = calls.length;
    expect(await submit({ ...command, terms: { ...command.terms, itemCommitmentAllowance: "10.00" } })).toEqual({
      policy: null,
      error: "invalid_authority",
    });
    expect(calls).toHaveLength(sent);
    expect(await store.readAll()).toEqual(committed);
  });
  it("exposes fresh versions only to the owner and rejects stale resume Preview with its actual 409 code", async () => {
    const { runtime, store } = await fixture();
    const active = await activate(runtime);
    const paused = await runtime.execute(
      "bop_one",
      {
        attemptId: String("pause_route").padEnd(22, "_"),
        type: "PauseBuyerOfferPolicy",
        expectedVersion: active.version,
        operationId: "pause_route",
      },
      context,
    );
    const owner = await app(runtime).request("/policies?offerId=off_one");
    expect(await owner.json()).toMatchObject({
      offerVersions: { off_one: 2 },
      items: [{ status: "paused", version: paused.version, offerVersions: { off_one: 2 } }],
    });
    const foreign = await app(runtime, "acc_other").request("/policies?offerId=off_one");
    expect(await foreign.json()).toEqual({ items: [], offerVersions: {}, nextCursor: null });
    const before = await store.readAll();
    const response = await app(runtime).request(
      "/policies/bop_one/commands",
      post({
        attemptId: String("stale_resume").padEnd(22, "_"),
        type: "PreviewBuyerOfferPolicy",
        expectedVersion: paused.version,
        operationId: "stale_resume",
        terms,
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "stale_preview" } });
    expect(await store.readAll()).toEqual(before);
  });
  it("returns per-selection held Preview evidence on the actual command response", async () => {
    const { runtime } = await fixture();
    const response = await app(runtime).request(
      "/policies/bop_one/commands",
      post({
        attemptId: String("preview_evidence").padEnd(22, "_"),
        type: "PreviewBuyerOfferPolicy",
        expectedVersion: 1,
        operationId: "preview_evidence",
        terms,
      }),
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
            attemptId: String("authorize").padEnd(22, "_"),
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
            attemptId: String(status).padEnd(22, "_"),
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
      expect(owner).not.toHaveProperty("consumedItemAmount");
      expect(owner).not.toHaveProperty("remainingItemAllowance");
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
          attemptId: String("preview").padEnd(22, "_"),
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
              attemptId: String("attack").padEnd(22, "_"),
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
      post({
        attemptId: String("preview").padEnd(22, "_"),
        type: "PreviewBuyerOfferPolicy",
        expectedVersion: 1,
        operationId: "preview",
        terms,
        ...changes,
      }),
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
          attemptId: String("authorize").padEnd(22, "_"),
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
        attemptId: String("authorize").padEnd(22, "_"),
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
