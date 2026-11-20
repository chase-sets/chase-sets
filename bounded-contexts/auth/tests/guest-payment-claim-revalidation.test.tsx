// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";
import GuestPaymentClaimRoute from "../routes/marketplace/guest-payment-claim";
import type { GuestPaymentClaimLoaderData } from "../features/registration/ui/guest-payment-claim-contracts";

const path = "/checkout/claim/pay_synthetic";
const bound = { contactEmail: "buyer@example.invalid", contactName: "Test Buyer" };

function routerReady(router: ReturnType<typeof createMemoryRouter>) {
  if (router.state.initialized && router.state.navigation.state === "idle" && router.state.revalidation === "idle")
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsubscribe = router.subscribe((state) => {
      if (state.initialized && state.navigation.state === "idle" && state.revalidation === "idle") {
        unsubscribe();
        resolve();
      }
    });
  });
}

describe("guest payment claim through a real data router", () => {
  afterEach(cleanup);

  it("still says the claim link was sent when Auth refuses the claim context on the reload after it", async () => {
    let reads = 0;
    const router = createMemoryRouter(
      [
        {
          path,
          loader: (): GuestPaymentClaimLoaderData => ({
            paymentId: "pay_synthetic",
            claimable: true,
            // Auth answers the first read and refuses the one after the link request.
            guestClaimContact: ++reads === 1 ? bound : null,
          }),
          action: () => ({
            status: "claim-link-sent" as const,
            token: null,
            expiresAt: "2026-12-01T00:00:00.000Z",
            displayName: "Test Buyer",
          }),
          Component: GuestPaymentClaimRoute,
        },
      ],
      { initialEntries: [path] },
    );
    render(
      <ChaseRoot>
        <RouterProvider router={router} />
      </ChaseRoot>,
    );
    await routerReady(router);
    expect(await screen.findByRole("button", { name: "Email me a claim link" })).toBeTruthy();

    await router.navigate(path, {
      formMethod: "post",
      formData: new URLSearchParams({ intent: "claim-link-request", displayName: "Test Buyer" }),
    });
    await routerReady(router);

    expect(reads).toBe(2);
    expect(await screen.findByText("Claim link sent")).toBeTruthy();
    expect(
      screen.getByText("We sent a claim link to this order's contact email. Open it to save this order to an account."),
    ).toBeTruthy();
    expect(
      screen.getByText("This order cannot be saved to an account right now. It stays on its payment page."),
    ).toBeTruthy();
    expect(screen.queryByText("Save this order")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(document.querySelector("form")).toBeNull();
    router.dispose();
  });
});
