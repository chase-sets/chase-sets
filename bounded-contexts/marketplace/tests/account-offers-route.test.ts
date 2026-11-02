// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { Hono } from "hono";
import { resolveActorFromSessionId } from "../../auth/server";
import SubmittedOffersRoute, { action as submittedOffersAction } from "../routes/account-offers-submitted";
import { fixture, context as policyContext, terms, privatePolicyFields } from "../features/offer-policy/tests/fixtures";
import { createBuyerOfferPolicyRoutes } from "../features/offer-policy/api/route";
import type { MarketplaceApiEnv } from "../api";
import { omitPrivateOfferResponseFields } from "../features/offers/api/response-shape";
import { action as itemDetailAction } from "../../discovery/routes/item-detail";
import {
  appendFreshWriteToken,
  CHASE_SETS_READ_AFTER_WRITE_HEADER,
  CHASE_SETS_READ_TARGET_CONTEXT_HEADER,
  readFreshWriteToken,
} from "@chase-sets/http/responses";
import SubmittedOfferRoute, { loader as submittedOfferLoader } from "../routes/account-offer-submitted";
import { loader as submittedOffersLoader } from "../routes/account-offers-submitted";
import { action as offerMatchAction, loader as offerMatchLoader } from "../routes/account-offer-match";
import { loader as offerMatchesLoader } from "../routes/account-offer-matches";

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function marketplaceCommit(position = "42", eventId = "evt_marketplace_offer") {
  return {
    mode: "eventual",
    commitPosition: position,
    commitEventIds: [eventId],
    commitPositions: [
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: position,
        eventIds: [eventId],
      },
    ],
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("market-following Submitted Offer real router", () => {
  it.each([false, true])(
    "enforces verified email through the real Preview permission guard (verified=%s)",
    async (verified) => {
      const services = {
        sessions: {
          readAuthenticatedSession: async () => ({
            state: {
              id: "ses_test",
              userId: "usr_buyer",
              accountId: "acc_buyer",
              availableAccountIds: ["acc_buyer"],
              authenticationMethod: "password",
              status: "active",
              expiresAt: "2099-01-01T00:00:00.000Z",
            },
            authenticatedAt: "2026-09-28T00:00:00.000Z",
          }),
          getSession: async () => null,
        },
        identity: {
          getActiveMembershipForUserAccount: async () => ({
            membership_id: "mbr_test",
            role_key: "owner",
            role_permissions: [],
          }),
          getUser: async () => ({
            primary_email: "collector@chasesets.test",
            contact_methods: [
              {
                type: "email",
                value: "collector@chasesets.test",
                verifiedAt: verified ? "2026-09-28T00:00:00.000Z" : null,
              },
            ],
          }),
        },
      } as unknown as Parameters<typeof resolveActorFromSessionId>[0];
      const actor = await resolveActorFromSessionId(services, "ses_test");
      const f = await fixture();
      const app = new Hono<MarketplaceApiEnv>();
      app.use("*", async (c, next) => {
        c.set("actor", actor!);
        c.set("context", policyContext);
        await next();
      });
      app.route("/api/marketplace/account/offer-policies", createBuyerOfferPolicyRoutes(f.runtime));
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("/api/auth/session")) return jsonResponse({ actor });
          return app.request(new Request(url, init));
        }),
      );
      expect(actor?.permissions).toContain("offers.view");
      expect(actor?.permissions.includes("offers.manage")).toBe(verified);
      const action = submittedOffersAction({
        request: new Request("http://localhost/account/offers/submitted.data", {
          method: "POST",
          body: new URLSearchParams({
            policyId: "bop_verified_buyer",
            command: JSON.stringify({
              attemptId: String("preview_buyer").padEnd(22, "_"),
              type: "PreviewBuyerOfferPolicy",
              expectedVersion: 0,
              operationId: "preview_buyer",
              terms,
            }),
          }),
        }),
        params: {},
        context: undefined,
      } as never);
      if (!verified) {
        await expect(action).rejects.toMatchObject({ status: 403 });
        await expect(f.runtime.get("bop_verified_buyer", "acc_buyer")).rejects.toMatchObject({ code: "not_found" });
        return;
      }
      const result = (await action).data;
      if (!("policy" in result)) throw new Error("Expected a Buyer Offer Policy reply.");
      expect(result.error).toBeNull();
      expect(result.policy?.preview?.outcomes).toHaveLength(1);
    },
  );

  it("keeps fixed Offer item-detail intent, Submitted detail and seller Match free of required policy limits", async () => {
    const fixed = {
      offer_id: "off_fixed",
      buyer_account_id: "acc_buyer",
      catalog_catalog_item_id: "cat_one",
      product_id: "cat_one::",
      item_title: "Item",
      selected_options: [],
      price_amount: "10.00",
      price_currency_code: "USD",
      quantity_requested: 2,
      last_stream_version: 1,
      status: "submitted",
      listing_id: "lst_one",
      can_fulfill: true,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/auth/session"))
          return jsonResponse({
            actor: {
              sessionId: "ses_test",
              tenantId: "tnt_test",
              userId: "usr_buyer",
              accountId: "acc_buyer",
              membershipId: "mbr_test",
              roleKey: "owner",
              permissions: ["offers.view", "offers.manage", "listings.view"],
            },
          });
        if (url.includes("offer-policies")) return jsonResponse({ items: [] });
        if (url.includes("/items/"))
          return jsonResponse({
            catalog_item_id: "cat_one",
            title: "Item",
            subtitle: null,
            product_schema: null,
            market_listings: [],
            field_values: [],
            categories: [],
            tags: [],
            image_urls: [],
          });
        return jsonResponse(fixed);
      }),
    );
    const form = new URLSearchParams({
      intent: "submit-offer",
      productId: "cat_one::",
      selectedOptions: "[]",
      productSummary: "",
      priceAmount: "10.00",
      priceCurrencyCode: "USD",
      quantityRequested: "2",
    });
    const redirect = (await itemDetailAction({
      request: new Request("http://localhost/items/cat_one", { method: "POST", body: form }),
      params: { id: "cat_one" },
      context: undefined,
    } as never)) as Response;
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("Location")).toContain("/checkout/buy/readiness?source=offer-intent");
    for (const field of Object.keys(privatePolicyFields)) expect(redirect.headers.get("Location")).not.toContain(field);
    const detail = await submittedOfferLoader({
      request: new Request("http://localhost/account/offers/submitted/off_fixed"),
      params: { offerId: "off_fixed" },
      context: undefined,
    } as never);
    expect(detail.submittedOffer).toMatchObject(fixed);
    const match = await offerMatchLoader({
      request: new Request("http://localhost/account/offers/matches/off_fixed"),
      params: { offerId: "off_fixed" },
      context: undefined,
    } as never);
    expect(match.offerMatch).toMatchObject({ can_fulfill: true, price_amount: "10.00" });
  });
  async function routed(laggingProjection = false, initialDrift = false) {
    const f = await fixture();
    if (initialDrift)
      await f.store.appendToStream({
        streamId: "marketplace.offer-off_one",
        expectedVersion: 1,
        context: policyContext,
        events: [
          {
            eventType: "marketplace.offer.price-updated",
            payload: {
              offerId: "off_one",
              buyerAccountId: "acc_buyer",
              priceAmount: "10.00",
              priceCurrencyCode: "USD",
            },
          },
        ],
      });
    const app = new Hono<MarketplaceApiEnv>();
    const actor = {
      sessionId: "ses_test",
      tenantId: "tnt_test",
      userId: "usr_buyer",
      accountId: "acc_buyer",
      membershipId: "mbr_test",
      roleKey: "owner",
      permissions: ["offers.view", "offers.manage"],
    };
    app.use("*", async (c, next) => {
      c.set("actor", actor);
      c.set("context", policyContext);
      await next();
    });
    app.route("/api/marketplace/account/offer-policies", createBuyerOfferPolicyRoutes(f.runtime));
    let accepted = false;
    const commands: Record<string, unknown>[] = [];
    const responses: { status: number; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/session")) return jsonResponse({ actor });
        if (url.includes("/offer-policies")) {
          if (init?.body) commands.push(JSON.parse(String(init.body)));
          const response = await app.request(new Request(url, init));
          if (init?.body) responses.push({ status: response.status, body: await response.clone().json() });
          return response;
        }
        const events = await f.store.readStream({ streamId: "marketplace.offer-off_one" });
        const offer = {
          offer_id: "off_one",
          buyer_account_id: "acc_buyer",
          catalog_catalog_item_id: "cat_one",
          product_id: "cat_one::",
          item_title: "Item",
          selected_options: [],
          product_summary: null,
          price_amount: "10.00",
          price_currency_code: "USD",
          last_stream_version: laggingProjection ? 1 : events.length,
          quantity_requested: 2,
          status: accepted ? "accepted" : "submitted",
          updated_at: "2026-09-28T00:00:00.000Z",
        };
        return jsonResponse(new URL(url).pathname.endsWith("/off_one") ? offer : { items: [offer], total: 1 });
      }),
    );
    const router = createMemoryRouter(
      [
        {
          path: "/account/offers/submitted",
          loader: submittedOffersLoader,
          action: submittedOffersAction,
          Component: SubmittedOffersRoute,
        },
        {
          path: "/account/offers/submitted/:offerId",
          loader: submittedOfferLoader,
          action: submittedOffersAction,
          Component: SubmittedOfferRoute,
        },
      ],
      { initialEntries: ["/account/offers/submitted"] },
    );
    render(createElement(RouterProvider, { router }));
    await screen.findByRole("switch", { name: "Follow the market for selected Offers" });
    return {
      ...f,
      router,
      commands,
      responses,
      accept: () => {
        accepted = true;
      },
    };
  }

  it.each([false, true])(
    "walks draft, review, consent, pause, fresh resume/revision and permanent stop (lag=%s)",
    async (lag) => {
      const f = await routed(lag);
      fireEvent.click(screen.getByRole("switch"));
      expect((screen.getByRole("checkbox", { name: "Select Item (off_one)" }) as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByLabelText(/item commitment allowance/i)).toBeNull();
      expect(screen.getByRole("button", { name: "Advanced adjustment" }).getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(screen.getByRole("button", { name: "Preview selected Offers" }));
      await screen.findByText("Review exact Offer authority");
      expect(screen.getByText("Held: a Market Price is not available for this Product yet.")).toBeTruthy();
      const authorize = screen.getByRole("button", { name: "Authorize reviewed Offers" });
      expect(authorize.hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("checkbox", { name: /^I authorize/ }));
      fireEvent.click(authorize);
      fireEvent.click(authorize);
      await screen.findByText("Active", { selector: "span" });
      expect(f.commands.filter((command) => command.type === "AuthorizeBuyerOfferPolicy")).toHaveLength(1);
      expect(f.commands.find((command) => command.type === "AuthorizeBuyerOfferPolicy")?.consent).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Pause market following" }));
      await screen.findByText("Paused", { selector: "span" });
      fireEvent.change(screen.getByLabelText("Maximum unit item amount: Item"), {
        target: { value: "120.00" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Preview to resume" }));
      await waitFor(() => expect(f.responses).toHaveLength(5));
      expect(f.responses.at(-1), JSON.stringify(f.responses.at(-1))).toMatchObject({ status: 200 });
      await screen.findByText("Review exact Offer authority");
      fireEvent.click(screen.getByRole("checkbox", { name: /^I authorize/ }));
      fireEvent.click(screen.getByRole("button", { name: "Authorize reviewed Offers" }));
      await screen.findByText("Active", { selector: "span" });
      expect(f.commands.filter((command) => command.type === "PreviewBuyerOfferPolicy")).toHaveLength(2);
      expect(screen.getByRole("button", { name: "Stop market following" }).hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByRole("checkbox", { name: /^Stop is permanent/ }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Stop market following" }).hasAttribute("disabled")).toBe(false),
      );
      fireEvent.click(screen.getByRole("button", { name: "Stop market following" }));
      await screen.findByText("Stopped", { selector: "span" });
      expect(f.commands.at(-1)?.type).toBe("StopBuyerOfferPolicy");
      const previews = f.commands.filter((command) => command.type === "PreviewBuyerOfferPolicy");
      expect(previews[1]).toMatchObject({ terms: { offers: [{ offerId: "off_one", offerVersion: 2 }] } });
      await act(() => f.router.navigate("/account/offers/submitted/off_one"));
      const manageStopped = await screen.findByRole("button", { name: /^Manage Stopped/ });
      expect(manageStopped.hasAttribute("disabled")).toBe(false);
      fireEvent.click(manageStopped);
      await screen.findByText("Stopped", { selector: "span" });
      expect(screen.queryByRole("button", { name: "Preview to resume" })).toBeNull();
      f.router.dispose();
    },
  );

  it("takes the first Preview version from an authoritative owner read, not the projected Offer", async () => {
    const f = await routed(true, true);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Preview selected Offers" }));
    await screen.findByText("Review exact Offer authority");
    expect(f.commands.at(-1)).toMatchObject({ terms: { offers: [{ offerVersion: 2 }] } });
    f.router.dispose();
  });

  it("keeps selection, caps and adjustment while clearing consent on interleaved resume drift", async () => {
    const f = await routed(true);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.change(screen.getByLabelText("Maximum unit item amount: Item"), { target: { value: "20.00" } });
    fireEvent.click(screen.getByRole("button", { name: "Advanced adjustment" }));
    fireEvent.change(screen.getByLabelText("Market Price adjustment (%)", { exact: true }), {
      target: { value: "-5" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview selected Offers" }));
    await screen.findByText("Review exact Offer authority");
    fireEvent.click(screen.getByRole("checkbox", { name: /^I authorize/ }));
    fireEvent.click(screen.getByRole("button", { name: "Authorize reviewed Offers" }));
    await screen.findByText("Active", { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: "Pause market following" }));
    await screen.findByText("Paused", { selector: "span" });
    await f.store.appendToStream({
      streamId: "marketplace.offer-off_one",
      expectedVersion: 2,
      context: policyContext,
      events: [
        {
          eventType: "marketplace.offer.price-updated",
          payload: {
            offerId: "off_one",
            buyerAccountId: "acc_buyer",
            priceAmount: "11.00",
            priceCurrencyCode: "USD",
          },
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview to resume" }));
    await screen.findByText("Review your Offer controls");
    expect(f.responses.at(-1)).toEqual({ status: 409, body: { error: { code: "stale_preview" } } });
    expect((screen.getByRole("checkbox", { name: "Select Item (off_one)" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Maximum unit item amount: Item") as HTMLInputElement).value).toBe("20.00");
    expect(screen.queryByLabelText(/item commitment allowance/i)).toBeNull();
    expect((screen.getByLabelText("Market Price adjustment (%)", { exact: true }) as HTMLInputElement).value).toBe(
      "-5",
    );
    expect(screen.queryByRole("checkbox", { name: /^I authorize/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Authorize reviewed Offers" })).toBeNull();
    const staleCommand = f.commands.at(-1)!;
    const policyId = (f.responses.find((response) => response.status === 200)?.body as { policyId: string }).policyId;
    const diagnostic = await submittedOffersAction({
      request: new Request("http://localhost/account/offers/submitted", {
        method: "POST",
        body: new URLSearchParams({ policyId, command: JSON.stringify(staleCommand) }),
      }),
      params: {},
      context: undefined,
    } as never);
    const headers = new Headers(diagnostic.init?.headers);
    expect(headers.get("X-Marketplace-Command-Status")).toBe("409");
    expect(headers.get("X-Marketplace-Command-Code")).toBe("stale_preview");
    f.router.dispose();
  });

  it("keeps limits and associates errors when stale consent refreshes the policy", async () => {
    const f = await routed();
    fireEvent.click(screen.getByRole("switch"));
    expect((screen.getByRole("checkbox", { name: "Select Item (off_one)" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Maximum unit item amount: Item"), {
      target: { value: "99.00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview selected Offers" }));
    await screen.findByText("Review exact Offer authority");
    await f.store.appendToStream({
      streamId: "marketplace.offer-off_one",
      expectedVersion: 1,
      context: policyContext,
      events: [
        {
          eventType: "marketplace.offer.price-updated",
          payload: { offerId: "off_one", buyerAccountId: "acc_buyer", priceAmount: "11.00", priceCurrencyCode: "USD" },
        },
      ],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /^I authorize/ }));
    fireEvent.click(screen.getByRole("button", { name: "Authorize reviewed Offers" }));
    await screen.findByText("Review your Offer controls");
    const maximum = screen.getByLabelText("Maximum unit item amount: Item") as HTMLInputElement;
    expect(maximum.value).toBe("99.00");
    expect(maximum.getAttribute("aria-invalid")).toBe("true");
    expect(maximum.getAttribute("aria-describedby")).toContain("error");
    expect(screen.queryByRole("button", { name: "Authorize reviewed Offers" })).toBeNull();
    f.router.dispose();
  });

  it("keeps every private policy key out of seller loader and hydration snapshots", () => {
    const data = omitPrivateOfferResponseFields({
      offer_id: "off_one",
      price_amount: "10.00",
      quantity_requested: 2,
      ...privatePolicyFields,
      managed_status: "outside-allowlist",
      can_fulfill: true,
    });
    for (const key of Object.keys(privatePolicyFields)) expect(JSON.stringify(data)).not.toContain(key);
    expect(data).toMatchObject({ managed_status: "unavailable", can_fulfill: false });
  });
});

describe("marketplace offer routes", () => {
  it("loads submitted offers through the marketplace API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                offer_id: "off_1",
                buyer_account_id: "acc_1",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                price_amount: "350.00",
                quantity_requested: 1,
                status: "submitted",
                listing_id: "lst_1",
                listing_price_amount: "375.00",
                listing_quantity_cap: 1,
                listing_visible_quantity: 1,
                offer_price_gap_amount: "25.00",
                offer_to_listing_price_bps: 9333,
                seller_available_quantity: 1,
                seller_listing_availability_status: "available",
                can_fulfill: true,
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-03-31T00:00:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await submittedOffersLoader({
      request: new Request("http://localhost/account/offers/submitted"),
      params: {},
      context: undefined,
    } as never);

    expect(result.submittedOffers.items).toHaveLength(1);
    expect(result.submittedOffers.items[0]?.offer_id).toBe("off_1");
  });

  it("loads submitted offer detail through the marketplace API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            offer_id: "off_1",
            buyer_account_id: "acc_1",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            selected_options: [],
            product_summary: null,
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            listing_id: "lst_1",
            listing_price_amount: "375.00",
            listing_quantity_cap: 1,
            listing_visible_quantity: 1,
            offer_price_gap_amount: "25.00",
            offer_to_listing_price_bps: 9333,
            seller_available_quantity: 1,
            seller_listing_availability_status: "available",
            can_fulfill: true,
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
          }),
        );
      }),
    );

    const result = await submittedOfferLoader({
      request: new Request("http://localhost/account/offers/submitted/off_1"),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    const submittedOffer = result.submittedOffer;
    if (!submittedOffer) {
      throw new Error("Expected submitted offer detail.");
    }
    expect(submittedOffer.offer_id).toBe("off_1");
  });

  it("returns route-owned recovery when a fresh submitted offer read hits projection freshness timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Projection read model did not catch up before the freshness timeout.",
              },
            },
            503,
          ),
        );
      }),
    );

    const result = await submittedOfferLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit())}`,
      ),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      submittedOffer: null,
      recovery: "fresh-write-preparing",
    });
  });

  it("returns route-owned recovery when a fresh submitted offer read hits an opaque gateway timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage"],
              },
            }),
          );
        }

        return Promise.resolve(jsonResponse(null, 504));
      }),
    );

    const result = await submittedOfferLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit())}`,
      ),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      submittedOffer: null,
      recovery: "fresh-write-preparing",
    });
  });

  it("surfaces expired submitted offer fresh-write not-found reads as normal not found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "not_found",
                message: "Submitted offer not found.",
              },
            },
            404,
          ),
        );
      }),
    );

    let response: Response | null = null;
    try {
      await submittedOfferLoader({
        request: new Request(
          `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit(), 1)}`,
        ),
        params: { offerId: "off_1" },
        context: undefined,
      } as never);
    } catch (error) {
      response = error as Response;
    }

    expect(response?.status).toBe(404);
    await expect(response?.text()).resolves.toContain("Submitted offer not found");
  });

  it("surfaces unclassified submitted offer fresh-write failures normally", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "provider_failed",
                message: "Provider failed.",
              },
            },
            503,
          ),
        );
      }),
    );

    await expect(
      submittedOfferLoader({
        request: new Request(
          `http://localhost${appendFreshWriteToken("/account/offers/submitted/off_1", marketplaceCommit())}`,
        ),
        params: { offerId: "off_1" },
        context: undefined,
      } as never),
    ).rejects.toMatchObject({
      status: 503,
      body: {
        error: {
          code: "provider_failed",
        },
      },
    });
  });

  it("loads offer matches through the marketplace API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            items: [
              {
                offer_id: "off_1",
                buyer_account_id: "acc_buyer",
                buyer_display_name: "Buyer One",
                catalog_catalog_item_id: "cat_charizard",
                product_id: "cat_charizard::",
                item_title: "Charizard",
                item_subtitle: null,
                selected_options: [],
                product_summary: null,
                price_amount: "350.00",
                quantity_requested: 1,
                status: "submitted",
                created_at: "2026-03-31T00:00:00.000Z",
                updated_at: "2026-03-31T00:00:00.000Z",
              },
            ],
            total: 1,
            count: 1,
          }),
        );
      }),
    );

    const result = await offerMatchesLoader({
      request: new Request("http://localhost/account/offers/matches"),
      params: {},
      context: undefined,
    } as never);

    expect(result.offerMatches.items[0]?.buyer_display_name).toBe("Buyer One");
  });

  it("loads offer match detail through the marketplace API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse({
            offer_id: "off_1",
            buyer_account_id: "acc_buyer",
            buyer_display_name: "Buyer One",
            catalog_catalog_item_id: "cat_charizard",
            product_id: "cat_charizard::",
            item_title: "Charizard",
            item_subtitle: null,
            selected_options: [],
            product_summary: null,
            price_amount: "350.00",
            quantity_requested: 1,
            status: "submitted",
            created_at: "2026-03-31T00:00:00.000Z",
            updated_at: "2026-03-31T00:00:00.000Z",
          }),
        );
      }),
    );

    const result = await offerMatchLoader({
      request: new Request("http://localhost/account/offers/matches/off_1"),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    const offerMatch = result.offerMatch;
    if (!offerMatch) {
      throw new Error("Expected offer match detail.");
    }
    expect(offerMatch.offer_id).toBe("off_1");
    expect(offerMatch.buyer_display_name).toBe("Buyer One");
  });

  it("returns route-owned recovery when a fresh offer match read hits projection freshness timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "projection_freshness_timeout",
                message: "Projection read model did not catch up before the freshness timeout.",
              },
            },
            503,
          ),
        );
      }),
    );

    const result = await offerMatchLoader({
      request: new Request(
        `http://localhost${appendFreshWriteToken("/account/offers/matches/off_1", marketplaceCommit())}`,
      ),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(result).toEqual({
      offerMatch: null,
      acceptanceTerms: null,
      recovery: "fresh-write-preparing",
    });
  });

  it("carries write consistency metadata after accepting an offer match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        if (
          url.includes("/api/marketplace/account/offers/matches/off_1/accept") &&
          (init?.method ?? "GET").toUpperCase() === "POST"
        ) {
          return Promise.resolve(
            jsonResponse({ id: "off_1", version: 2, status: "accepted" }, 201, {
              "Chase-Sets-Consistency": "eventual",
              "Chase-Sets-Commit-Receipt": encodeURIComponent(
                JSON.stringify([
                  {
                    sourceContextName: "marketplace",
                    maxGlobalPosition: "42",
                    eventIds: ["evt_offer_accepted"],
                  },
                ]),
              ),
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const form = new URLSearchParams();
    form.set("intent", "accept-offer");
    form.set("attemptId", "route_accept_attempt_identity");
    form.set("feeQuoteFingerprint", "quote-current");

    const response = await offerMatchAction({
      request: new Request("http://localhost/account/offers/matches/off_1", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    expect(response).toBeInstanceOf(Response);
    const location = (response as Response).headers.get("Location") ?? "";
    expect(location).toMatch(/^\/account\/offers\/matches\/off_1\?afterWrite=/);
    expect(readFreshWriteToken(location)?.sources).toEqual([
      {
        sourceContextName: "marketplace",
        maxGlobalPosition: "42",
        eventIds: ["evt_offer_accepted"],
      },
    ]);
  });

  it("forwards afterWrite metadata when loading a freshly accepted offer match", async () => {
    const offerDetailHeaders: Headers[] = [];
    const freshPath = appendFreshWriteToken(
      "/account/offers/matches/off_1",
      {
        commitPositions: [
          {
            sourceContextName: "marketplace",
            maxGlobalPosition: "42",
            eventIds: ["evt_offer_accepted"],
          },
        ],
        commitEventIds: ["evt_offer_accepted"],
      },
      Date.now(),
    );

    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);

        if (url.includes("/api/auth/session")) {
          return Promise.resolve(
            jsonResponse({
              actor: {
                sessionId: "ses_1",
                tenantId: "tnt_identity",
                userId: "usr_1",
                accountId: "acc_1",
                membershipId: "mbr_1",
                roleKey: "owner",
                permissions: ["offers.view", "offers.manage", "listings.view"],
              },
            }),
          );
        }

        if (url.includes("/api/marketplace/account/offers/matches/off_1")) {
          offerDetailHeaders.push(new Headers(init?.headers));
          return Promise.resolve(
            jsonResponse({
              offer_id: "off_1",
              buyer_account_id: "acc_buyer",
              buyer_display_name: "Buyer One",
              catalog_catalog_item_id: "cat_charizard",
              product_id: "cat_charizard::",
              item_title: "Charizard",
              item_subtitle: null,
              selected_options: [],
              product_summary: null,
              price_amount: "350.00",
              quantity_requested: 1,
              status: "accepted",
              created_at: "2026-03-31T00:00:00.000Z",
              updated_at: "2026-03-31T00:00:00.000Z",
            }),
          );
        }

        return Promise.reject(new Error(`Unexpected fetch request: ${url}`));
      }),
    );

    const result = await offerMatchLoader({
      request: new Request(`http://localhost${freshPath}`),
      params: { offerId: "off_1" },
      context: undefined,
    } as never);

    const offerMatch = result.offerMatch;
    if (!offerMatch) {
      throw new Error("Expected offer match detail.");
    }
    expect(offerMatch.status).toBe("accepted");
    expect(offerDetailHeaders[0]?.get(CHASE_SETS_READ_AFTER_WRITE_HEADER)).toBeTruthy();
    expect(offerDetailHeaders[0]?.get(CHASE_SETS_READ_TARGET_CONTEXT_HEADER)).toBe("marketplace");
  });
});

describe("Submitted Offers lifecycle route", () => {
  const actor = {
    sessionId: "ses_buyer",
    tenantId: "tnt_test",
    userId: "usr_buyer",
    accountId: "acc_buyer",
    membershipId: "mbr_buyer",
    roleKey: "owner",
    permissions: ["offers.view", "offers.manage"],
  };
  const counts = (submitted: number, paused: number) => ({ submitted, paused, withdrawn: 0, accepted: 0 });
  const row = (offerId: string, status: string, itemTitle = "Charizard") => ({
    offer_id: offerId,
    buyer_account_id: "acc_buyer",
    catalog_catalog_item_id: "cat_one",
    product_id: "cat_one::",
    item_title: itemTitle,
    item_subtitle: null,
    selected_options: [],
    product_summary: null,
    price_amount: "20.00",
    price_currency_code: "USD",
    last_stream_version: 1,
    quantity_requested: 1,
    status,
    accepted_seller_account_id: null,
    accepted_at: null,
    created_at: "2026-10-14T00:00:00.000Z",
    updated_at: "2026-10-14T00:00:00.000Z",
  });

  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    readonly listeners = new Map<string, Set<(event: Event) => void>>();
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(type: string, listener: (event: Event) => void) {
      this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), listener]));
    }
    close() {}
    emit(type: string, data: unknown) {
      for (const listener of this.listeners.get(type) ?? [])
        listener({ data: JSON.stringify(data), lastEventId: "1" } as MessageEvent);
    }
  }

  it("loads the requested status filter and per-status counts", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.includes("/api/auth/session")) return jsonResponse({ actor });
        if (url.includes("offer-policies")) return jsonResponse({ items: [], offerVersions: {}, nextCursor: null });
        return jsonResponse({ items: [row("off_1", "paused")], total: 1, count: 1, statusCounts: counts(0, 1) });
      }),
    );
    const result = await submittedOffersLoader({
      request: new Request("http://localhost/account/offers/submitted?status=paused"),
      params: {},
      context: undefined,
    } as never);
    expect(result.statusFilter).toBe("paused");
    expect(result.submittedOffers).toMatchObject({ statusCounts: counts(0, 1) });
    expect(urls.find((url) => url.includes("/account/offers/submitted?"))).toContain("status=paused");
    const unfiltered = await submittedOffersLoader({
      request: new Request("http://localhost/account/offers/submitted?status=bogus"),
      params: {},
      context: undefined,
    } as never);
    expect(unfiltered.statusFilter).toBe("all");
    expect(urls.filter((url) => url.includes("/account/offers/submitted?")).at(-1)).not.toContain("status=");
  });

  it("sends one Offer to its command route and several to the bulk route, replying per row", async () => {
    const calls: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/session")) return jsonResponse({ actor });
        calls.push({ url: new URL(url).pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith("/off_1/pause"))
          return jsonResponse({ id: "off_1", version: 3, status: "paused", outcome: "changed" });
        if (url.endsWith("/off_2/resume"))
          return jsonResponse({ error: { code: "offer_transition_rejected", message: "final" } }, 409);
        if (url.endsWith("/offers/submitted/bulk"))
          return jsonResponse({
            action: "withdraw",
            items: [
              { offerId: "off_1", outcome: "changed", status: "withdrawn", version: 4 },
              { offerId: "off_9", outcome: "rejected", code: "not_found" },
            ],
            total: 2,
            count: 2,
          });
        return jsonResponse({ error: { code: "unexpected" } }, 500);
      }),
    );
    const post = async (fields: [string, string][]) =>
      (
        await submittedOffersAction({
          request: new Request("http://localhost/account/offers/submitted", {
            method: "POST",
            body: new URLSearchParams([["intent", "offer-lifecycle"], ...fields]),
          }),
          params: {},
          context: undefined,
        } as never)
      ).data;

    await expect(
      post([
        ["lifecycleAction", "pause"],
        ["offerId", "off_1"],
      ]),
    ).resolves.toEqual({
      lifecycle: { outcomes: [{ offerId: "off_1", outcome: "changed", status: "paused", version: 3 }] },
    });
    await expect(
      post([
        ["lifecycleAction", "resume"],
        ["offerId", "off_2"],
      ]),
    ).resolves.toEqual({
      lifecycle: { outcomes: [{ offerId: "off_2", outcome: "rejected", code: "offer_transition_rejected" }] },
    });
    await expect(
      post([
        ["lifecycleAction", "withdraw"],
        ["offerId", "off_1"],
        ["offerId", "off_9"],
      ]),
    ).resolves.toMatchObject({
      lifecycle: { outcomes: [{ outcome: "changed" }, { outcome: "rejected", code: "not_found" }] },
    });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/marketplace/account/offers/submitted/off_1/pause",
      "/api/marketplace/account/offers/submitted/off_2/resume",
      "/api/marketplace/account/offers/submitted/bulk",
    ]);
    expect(calls[2]!.body).toEqual({ action: "withdraw", offerIds: ["off_1", "off_9"] });
    await expect(
      post([
        ["lifecycleAction", "accept"],
        ["offerId", "off_1"],
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("reports closed lifecycle admission on every selected Offer, single or bulk", async () => {
    let closedCode = "offer_lifecycle_closed";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/auth/session")) return jsonResponse({ actor });
        return jsonResponse({ error: { code: closedCode, message: "not open" } }, 503);
      }),
    );
    const post = async (fields: [string, string][]) =>
      (
        await submittedOffersAction({
          request: new Request("http://localhost/account/offers/submitted", {
            method: "POST",
            body: new URLSearchParams([["intent", "offer-lifecycle"], ...fields]),
          }),
          params: {},
          context: undefined,
        } as never)
      ).data;

    await expect(
      post([
        ["lifecycleAction", "pause"],
        ["offerId", "off_1"],
      ]),
    ).resolves.toEqual({
      lifecycle: { outcomes: [{ offerId: "off_1", outcome: "rejected", code: "offer_lifecycle_closed" }] },
    });
    await expect(
      post([
        ["lifecycleAction", "withdraw"],
        ["offerId", "off_1"],
        ["offerId", "off_2"],
      ]),
    ).resolves.toEqual({
      lifecycle: {
        outcomes: [
          { offerId: "off_1", outcome: "rejected", code: "offer_lifecycle_closed" },
          { offerId: "off_2", outcome: "rejected", code: "offer_lifecycle_closed" },
        ],
      },
    });
    // Any other unavailable reply still reaches the route error boundary.
    closedCode = "service_unavailable";
    await expect(
      post([
        ["lifecycleAction", "pause"],
        ["offerId", "off_1"],
      ]),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("runs a row Pause from the rendered list through the route action and shows its outcome", async () => {
    const commands: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/api/auth/session")) return jsonResponse({ actor });
        if (url.includes("offer-policies")) return jsonResponse({ items: [], offerVersions: {}, nextCursor: null });
        if (init?.method === "POST") {
          commands.push(new URL(url).pathname);
          return jsonResponse({ id: "off_1", version: 2, status: "paused", outcome: "changed" });
        }
        return jsonResponse({ items: [row("off_1", "submitted")], total: 1, count: 1, statusCounts: counts(1, 0) });
      }),
    );
    const router = createMemoryRouter(
      [
        {
          path: "/account/offers/submitted",
          loader: submittedOffersLoader,
          action: submittedOffersAction,
          Component: SubmittedOffersRoute,
        },
      ],
      { initialEntries: ["/account/offers/submitted"] },
    );
    render(createElement(RouterProvider, { router }));
    fireEvent.click((await screen.findAllByRole("button", { name: "Pause Charizard" }))[0]!);
    await screen.findByText("Charizard: now Paused");
    expect(commands).toEqual(["/api/marketplace/account/offers/submitted/off_1/pause"]);
    expect(screen.getAllByRole("button", { name: "Resume Charizard" }).length).toBeGreaterThan(0);
    router.dispose();
  });

  it("moves an Offer paused in another tab out of Open and refreshes every count without a manual reload", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    let paused = false;
    const listReads: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/api/auth/session")) return jsonResponse({ actor });
        if (url.includes("offer-policies")) return jsonResponse({ items: [], offerVersions: {}, nextCursor: null });
        listReads.push(url);
        return jsonResponse(
          paused
            ? { items: [], total: 0, count: 0, statusCounts: counts(0, 1) }
            : { items: [row("off_1", "submitted")], total: 1, count: 1, statusCounts: counts(1, 0) },
        );
      }),
    );
    const router = createMemoryRouter(
      [
        {
          id: "root",
          path: "/",
          loader: () => ({ actor: { accountId: "acc_buyer" } }),
          Component: Outlet,
          children: [
            {
              path: "account/offers/submitted",
              loader: submittedOffersLoader,
              action: submittedOffersAction,
              Component: SubmittedOffersRoute,
            },
          ],
        },
      ],
      { initialEntries: ["/account/offers/submitted?status=submitted"] },
    );
    render(createElement(RouterProvider, { router }));
    await screen.findByRole("radio", { name: "Open (1)" });
    expect(screen.getAllByText("Charizard").length).toBeGreaterThan(0);
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0]!.url).toContain("/api/realtime/account/events");

    paused = true;
    act(() =>
      FakeEventSource.instances[0]!.emit("projection.patch", {
        kind: "projection.patch",
        context: "marketplace",
        projection: "marketplace-offer-projection",
        topics: ["account:acc_buyer:offers"],
        changes: [{ op: "upsert", entity: "marketplace.offer", id: "off_1", value: row("off_1", "paused") }],
      }),
    );

    await screen.findByRole("radio", { name: "Paused (1)" });
    expect(screen.getByRole("radio", { name: "Open (0)" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryAllByText("Charizard")).toHaveLength(0);
    expect(listReads).toHaveLength(2);
    router.dispose();
  });
});
