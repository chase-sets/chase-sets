// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import CheckoutStartRoute, { action } from "../../../routes/checkout-start";
import type { CheckoutStartPageData } from "./checkout-start-page-types";

vi.mock("@chase-sets/platform-runtime/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chase-sets/platform-runtime/auth")>()),
  resolveActorFromAuthApi: async () => ({
    sessionId: "ses_synthetic",
    tenantId: "tnt_synthetic",
    userId: "usr_synthetic",
    accountId: "acc_synthetic",
    membershipId: "mbr_synthetic",
    roleKey: "owner",
    permissions: ["orders.manage"],
  }),
}));

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

describe("checkout-closed-start-render", () => {
  it("renders the real refused-create action through the data router as a warning with a cart link", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith("/account/checkout-sessions")) throw new Error(`Unexpected synthetic request: ${url}`);
      return Response.json(
        { error: { code: "checkout_closed", message: "Checkout is closed until public launch." } },
        { status: 503 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const data: CheckoutStartPageData = {
      isSignedIn: true,
      isGuestBuyer: false,
      source: null,
      cartReadiness: null,
      cartCount: 1,
      entryAttemptKey: "synthetic-closed",
      signInPath: "/sign-in",
    };
    const router = createMemoryRouter(
      [{ path: "/checkout/buy/readiness", Component: CheckoutStartRoute, loader: () => data, action }],
      { initialEntries: ["/checkout/buy/readiness"] },
    );
    render(<RouterProvider router={router} />);
    const formData = new FormData();
    for (const [key, value] of Object.entries({
      source: "buy-now",
      listingId: "lst_synthetic",
      catalogItemId: "cat_synthetic",
      productId: "prd_synthetic",
      itemTitle: "Synthetic item",
      selectedOptions: "[]",
      quantity: "1",
    }))
      formData.set(key, value);
    await act(async () => {
      await router.navigate("/checkout/buy/readiness", { formMethod: "post", formData });
    });
    const banner = await screen.findByRole("alert");
    expect(within(banner).getByText("Checkout is closed")).toBeTruthy();
    expect(
      within(banner).getByText("Buying opens at public launch. Your Buy Cart is saved, and you can continue browsing."),
    ).toBeTruthy();
    expect(within(banner).getByRole("link", { name: "View Buy Cart" }).getAttribute("href")).toBe("/account/cart");
    expect(router.state.actionData).toMatchObject({
      "0": {
        recovery: { kind: "checkout-closed", recoveryKind: "action-required", postWriteResult: { retryable: false } },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Preparing checkout")).toBeNull();
    router.dispose();
  });
});
