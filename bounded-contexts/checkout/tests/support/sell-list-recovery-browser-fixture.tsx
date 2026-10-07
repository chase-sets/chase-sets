import { createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryRouter, RouterProvider } from "react-router";
import type { loader } from "../../routes/account-sell-list";

// Synthetic recovered loader results; the production loader is exercised in account-sell-list-recovery.test.tsx.
export function mountSellListRecoveryBrowserFixture(Component: ComponentType) {
  const observedAtMs = Date.now();
  const path = "/account/sell-list?postWriteToken=pwt_test9082000000000001";
  const ready: Awaited<ReturnType<typeof loader>> = {
    isSignedIn: true,
    registrationReturn: null,
    mergedLineCount: 0,
    mergeError: null,
    sellerCheckoutRegisterHref: "/register",
    sellerCheckoutSignInHref: "/sign-in",
    freshnessError: null,
    sellListRecovery: null,
    pendingFreshWriteTiming: { observedAtMs, expiresAtMs: observedAtMs + 30_000 },
    sellList: {
      count: 1,
      items: [
        {
          seller_account_id: "acc_synthetic_9082",
          line_id: "sll_synthetic_9082",
          line_type: "product",
          offer_id: null,
          listing_id: null,
          buyer_account_id: null,
          buyer_display_name: null,
          offer_price_amount: null,
          catalog_catalog_item_id: "cat_synthetic_9082",
          product_id: "prod_synthetic_9082",
          item_title: "Synthetic recovery item",
          item_subtitle: "Synthetic fixture",
          selected_options: [],
          product_summary: "Near Mint",
          quantity: 1,
          fallback_mode: "create-listing",
          minimum_listing_price_amount: "399.00",
          created_at: "2026-10-07T00:00:00Z",
          updated_at: "2026-10-07T00:00:00Z",
        },
      ],
    },
    offerReviews: [],
    productOfferReviews: [],
    inventoryItems: [],
    payoutReadiness: { account_id: "acc_synthetic_9082", status: "ready", missing_requirements: [], updated_at: null },
  };
  const pending: Awaited<ReturnType<typeof loader>> = {
    ...ready,
    freshnessError: "Synthetic composite projection freshness timeout",
    sellListRecovery: {
      kind: "pending-fresh-write",
      recoveryKind: "refreshable-catching-up",
      message: "Synthetic composite projection freshness timeout",
      actorMode: "account",
      freshnessOutcome: "valid-after-write",
      correctionSource: "sell-list-composite-review",
    },
  };
  let calls = 0;
  let finishReview: (() => void) | undefined;
  const router = createMemoryRouter(
    [
      {
        id: "sell-list",
        path: "/account/sell-list",
        Component,
        loader: () => {
          calls += 1;
          if (calls === 1) return pending;
          return new Promise<typeof ready>((resolve) => {
            finishReview = () => resolve(ready);
          });
        },
      },
    ],
    { initialEntries: [path] },
  );
  const host = document.createElement("div");
  host.id = "sell-list-recovery-fixture";
  document.body.replaceChildren(host);
  const root = createRoot(host);
  root.render(createElement(RouterProvider, { router }));
  return {
    state: () => ({
      calls,
      navigation: router.state.navigation.state,
      recovery: router.state.loaderData["sell-list"]?.sellListRecovery?.kind ?? null,
      timing: router.state.loaderData["sell-list"]?.pendingFreshWriteTiming,
    }),
    finishReview: () => {
      if (!finishReview) throw new Error("The automatic second loader call has not started");
      finishReview();
    },
    dispose: () => {
      root.unmount();
      router.dispose();
    },
  };
}
