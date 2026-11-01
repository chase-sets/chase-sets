// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { ChaseRoot } from "@chase-sets/design-system";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import MatchRoute, { action, loader } from "../routes/account-offer-match";
import MatchListRoute, { loader as listLoader } from "../routes/account-offer-matches";
import { hashMarketplaceRequest } from "../features/mutation-recovery/api/attempt";
import { t } from "@chase-sets/localization";

const actor = {
  sessionId: "ses_test",
  tenantId: "tnt_test",
  userId: "usr_seller",
  accountId: "acc_seller",
  membershipId: "mem_test",
  roleKey: "owner",
  permissions: ["offers.view", "offers.manage", "listings.view"],
};
const offer = {
  offer_id: "off_one",
  buyer_account_id: "acc_buyer",
  catalog_catalog_item_id: "cat_one",
  product_id: "cat_one::",
  item_title: "Item",
  item_subtitle: null,
  selected_options: [],
  product_summary: null,
  price_amount: "10.00",
  price_currency_code: "USD",
  last_stream_version: 1,
  quantity_requested: 1,
  status: "submitted",
  accepted_seller_account_id: null,
  accepted_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
  listing_id: "lst_one",
  listing_price_amount: "10.00",
  listing_price_currency_code: "USD",
  listing_stream_version: 2,
  listing_quantity_cap: 1,
  listing_visible_quantity: 1,
  offer_price_gap_amount: "0.00",
  offer_to_listing_price_bps: 10000,
  buyer_display_name: "Buyer",
  seller_available_quantity: 1,
  seller_listing_availability_status: "available",
  can_fulfill: true,
};
const path = "/account/offers/matches/off_one";
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("Offer match recovery real data router", () => {
  beforeEach(() => {
    vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  function setup(mode: "ambiguous" | "committed" | "lag" | "presence-only" | "injected", initialEntry = path) {
    let converged = false;
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/auth/session")) return json({ actor });
      if (url.pathname.includes("mutation-attempts")) {
        const kind = url.searchParams.get("kind")!;
        const target = { kind: "offer", id: "off_one" };
        const recovery = {
          schemaVersion: 1,
          mutationKind: kind,
          attemptKeyFingerprint: hashMarketplaceRequest([
            actor.accountId,
            kind,
            target,
            decodeURIComponent(url.pathname.split("/").at(-1)!),
          ]),
          actorBinding: { accountId: actor.accountId },
          target,
          canonicalRequestHash: url.searchParams.get("requestHash"),
          ownerStatus: mode === "committed" ? "committed" : "ambiguous",
          ...(mode === "committed"
            ? { ownerReceipt: { id: "off_one", version: 2 } }
            : { reason: "history-incomplete" }),
        };
        return json(
          mode === "presence-only"
            ? { ...recovery, ownerStatus: "not-observed", ownerReceipt: { id: "off_one", version: 2 } }
            : mode === "injected"
              ? {
                  ...recovery,
                  ownerStatus: "committed",
                  ownerReceipt: { id: "off_one", version: 2 },
                  canonicalRequestHash: "0".repeat(64),
                }
              : recovery,
        );
      }
      if ((init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() === "POST")
        throw new TypeError("response lost after possible send");
      if (url.pathname.endsWith("terms-preview")) return json(null);
      if (mode === "lag" && !converged)
        return json({ error: { code: "projection_freshness_timeout", message: "catching up" } }, 503);
      return json({ ...offer, ...(converged ? { status: "accepted" } : {}) });
    });
    vi.stubGlobal("fetch", transport);
    const router = createMemoryRouter(
      [
        { path: "/account/offers/matches/:offerId", loader, action, Component: MatchRoute },
        { path: "/account/offers/matches", element: <p>First result confirmed</p> },
      ],
      { initialEntries: [initialEntry] },
    );
    render(
      <ChaseRoot>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    return {
      router,
      transport,
      converge: () => {
        converged = true;
      },
    };
  }

  it("refuses pre-send without any command or lookup", async () => {
    const { router, transport } = setup("ambiguous");
    await screen.findByRole("button", { name: t("marketplace.features.offers.ui.offerMatchDetailPage.decline") });
    const form = new FormData();
    form.set("intent", "decline-offer");
    form.set("attemptId", "invalid");
    await act(async () => {
      await router.navigate(path, { formMethod: "post", formData: form });
    });
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe(t("marketplace.recovery.failedSafe")));
    expect(transport.mock.calls.filter(([url]) => String(url).includes("mutation-attempts"))).toHaveLength(0);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it.each([false, true])("list decline reaches the action and redirects; missing-field mutant=%s", async (mutant) => {
    const redirects: string[] = [];
    const transport = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input), "http://localhost");
      if (url.pathname.endsWith("/api/auth/session")) return json({ actor });
      if (init?.method === "POST") return json({ offerId: offer.offer_id, version: 2 });
      return json({ items: [offer], total: 1, count: 1 });
    });
    vi.stubGlobal("fetch", transport);
    const router = createMemoryRouter(
      [
        { path: "/account/offers/matches", loader: listLoader, Component: MatchListRoute },
        {
          id: "decline",
          path: "/account/offers/matches/:offerId",
          element: <p>Decline action result</p>,
          action: async (args) => {
            const result = await action(args);
            if (result instanceof Response) redirects.push(result.headers.get("Location")!);
            return result;
          },
        },
      ],
      { initialEntries: ["/account/offers/matches"] },
    );
    render(
      <ChaseRoot>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    const [decline] = await screen.findAllByRole("button", {
      name: t("marketplace.features.offers.ui.offerMatchListPage.decline"),
    });
    const form = decline.closest("form")!;
    const attempt = form.querySelector<HTMLInputElement>('input[name="attemptId"]');
    if (mutant) attempt?.remove();
    fireEvent.click(decline);
    await waitFor(() => expect(router.state.navigation.state).toBe("idle"));
    if (mutant) {
      await waitFor(() =>
        expect(router.state.actionData).toMatchObject({
          decline: { recovery: "failed-safe" },
        }),
      );
      expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      expect(redirects).toEqual([]);
    } else {
      await waitFor(() => expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
      const [url, init] = transport.mock.calls.find(([, init]) => init?.method === "POST")!;
      expect(new URL(String(url)).pathname).toBe(`/api/marketplace/account/offers/matches/${offer.offer_id}/decline`);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        attemptId: expect.stringMatching(/^[A-Za-z0-9_-]{22,128}$/),
      });
      expect(JSON.parse(String(init?.body)).attemptId).toBe(attempt?.value);
      await waitFor(() => expect(router.state.location.pathname).toBe("/account/offers/matches"));
      expect(redirects).toEqual(["/account/offers/matches"]);
    }
    expect(transport.mock.calls.filter(([url]) => String(url).includes("mutation-attempts"))).toHaveLength(0);
  });

  it("possible-send loss makes one lookup, never retries, and ambiguity disables and focuses the announced action result", async () => {
    const { transport } = setup("ambiguous");
    const decline = await screen.findByRole("button", {
      name: t("marketplace.features.offers.ui.offerMatchDetailPage.decline"),
    });
    fireEvent.click(decline);
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(decline).toHaveProperty("disabled", true);
    expect(transport.mock.calls.filter(([url]) => String(url).includes("mutation-attempts"))).toHaveLength(1);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    fireEvent.click(decline);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("resolves a lost command from the first owner receipt, not connectivity", async () => {
    const { transport } = setup("committed");
    fireEvent.click(
      await screen.findByRole("button", { name: t("marketplace.features.offers.ui.offerMatchDetailPage.decline") }),
    );
    await screen.findByText("First result confirmed");
    expect(transport.mock.calls.filter(([url]) => String(url).includes("mutation-attempts"))).toHaveLength(1);
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it.each(["presence-only", "injected"] as const)(
    "rejects the %s receipt mutant through the real router",
    async (mode) => {
      const { transport } = setup(mode);
      fireEvent.click(
        await screen.findByRole("button", { name: t("marketplace.features.offers.ui.offerMatchDetailPage.decline") }),
      );
      await screen.findByRole("alert");
      expect(
        screen.getByRole("button", { name: t("marketplace.features.offers.ui.offerMatchDetailPage.decline") }),
      ).toHaveProperty("disabled", true);
      expect(transport.mock.calls.filter(([url]) => String(url).includes("mutation-attempts"))).toHaveLength(1);
      expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    },
  );

  it("renders confirming through projection lag until the real loader converges", async () => {
    const entry = appendFreshWriteToken(path, {
      mode: "eventual",
      commitPosition: "42",
      commitEventIds: ["evt_first"],
      commitPositions: [{ sourceContextName: "marketplace", maxGlobalPosition: "42", eventIds: ["evt_first"] }],
    });
    const { router, transport, converge } = setup("lag", entry);
    await screen.findByText(t("marketplace.recovery.confirming"));
    expect(
      screen.queryByRole("button", { name: t("marketplace.features.offers.ui.offerMatchDetailPage.decline") }),
    ).toBeNull();
    converge();
    await act(async () => {
      await router.revalidate();
    });
    await waitFor(() => expect(screen.getAllByText("accepted").length).toBeGreaterThan(0));
    expect(screen.queryByText(t("marketplace.recovery.confirming"))).toBeNull();
    expect(transport.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });
});
