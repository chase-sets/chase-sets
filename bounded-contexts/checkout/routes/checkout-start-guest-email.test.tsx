// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRoutesStub, redirect } from "react-router";
import { afterEach, describe, expect, it } from "vitest";

import CheckoutStartRoute from "./checkout-start";

type CheckoutStartLoaderData = {
  isSignedIn: boolean;
  isGuestBuyer: boolean;
  source: null;
  cartReadiness: null | {
    status: "ready" | "needs-resolution" | "blocked";
    lineCount: number;
    customerSafeFacts: readonly string[];
  };
  cartCount: number;
  entryAttemptKey: string;
  signInPath: string;
};

const guestStartLoaderData: CheckoutStartLoaderData = {
  isSignedIn: false,
  isGuestBuyer: false,
  source: null,
  cartReadiness: null,
  cartCount: 1,
  entryAttemptKey: "chkentry_test",
  signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
};

const existingAccountEmail = "jane@example.com";
const existingEmailError = "This email already has an account. Sign in, or use a different email to continue as guest.";

function renderGuestCheckoutStart() {
  const Stub = createRoutesStub([
    {
      path: "/checkout/buy/readiness",
      Component: CheckoutStartRoute,
      loader: () => guestStartLoaderData,
      action: async ({ request }) => {
        const formData = await request.formData();
        const email = String(formData.get("email") ?? "").trim();
        if (email === existingAccountEmail) {
          return {
            emailExistsError: existingEmailError,
            signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
          };
        }
        return redirect("/checkout/buy/session/chk_guest_retry");
      },
    },
    {
      path: "/checkout/buy/session/:sessionId",
      Component: () => <div>checkout-session-ready</div>,
      loader: () => null,
    },
  ]);

  return render(<Stub initialEntries={["/checkout/buy/readiness"]} />);
}

function renderSignedInBlockedCartCheckoutStart() {
  const Stub = createRoutesStub([
    {
      path: "/checkout/buy/readiness",
      Component: CheckoutStartRoute,
      loader: () =>
        ({
          isSignedIn: true,
          isGuestBuyer: false,
          source: null,
          cartReadiness: {
            status: "blocked",
            lineCount: 1,
            customerSafeFacts: ["No cart items are ready for checkout."],
          },
          cartCount: 1,
          entryAttemptKey: "chkentry_test",
          signInPath: "/sign-in?returnTo=%2Fcheckout%2Fbuy%2Freadiness",
        }) satisfies CheckoutStartLoaderData,
      action: () => null,
    },
  ]);

  return render(<Stub initialEntries={["/checkout/buy/readiness"]} />);
}

describe("guest checkout start: existing account email", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the guest checkout Surface as flattened furniture, not an entity card", async () => {
    renderGuestCheckoutStart();

    const submit = await screen.findByRole("button", { name: "Continue as guest" });
    const furnitureSurfaceClass = "min-w-0 max-w-full rounded-tokenLg bg-surface-2 p-4";
    const guestSurface = submit.closest(`[class="${furnitureSurfaceClass}"]`);
    expect(guestSurface).toBeTruthy();
    expect(guestSurface?.className).not.toMatch(/ds-glass|shadow-token|surface-border|ds-glow/);
  });

  it("keeps the guest form, surfaces the email error, and lets a new email proceed", async () => {
    renderGuestCheckoutStart();

    const submit = await screen.findByRole("button", { name: "Continue as guest" });
    const nameField = screen.getByLabelText("Contact name") as HTMLInputElement;
    const emailField = screen.getByLabelText("Email") as HTMLInputElement;

    fireEvent.change(nameField, { target: { value: "Jane Smith" } });
    fireEvent.change(emailField, { target: { value: existingAccountEmail } });
    fireEvent.click(submit);

    // The existing-email block surfaces inline guidance AND a field error while
    // keeping the guest form on screen so the buyer can edit the email.
    expect(await screen.findAllByText(existingEmailError)).not.toHaveLength(0);
    const reSubmit = screen.getByRole("button", { name: "Continue as guest" });
    expect(reSubmit).toBeTruthy();
    const blockedEmailField = screen.getByLabelText("Email") as HTMLInputElement;
    expect(blockedEmailField.getAttribute("aria-invalid")).toBe("true");

    // A secondary sign-in path remains available alongside the guest form.
    expect(screen.getAllByRole("link", { name: "Sign in" }).length).toBeGreaterThan(0);

    // Editing the email to a brand-new address resubmits successfully.
    fireEvent.change(blockedEmailField, { target: { value: "jane.new@example.com" } });
    fireEvent.click(reSubmit);

    await waitFor(() => {
      expect(screen.getByText("checkout-session-ready")).toBeTruthy();
    });
  });

  it("shows blocked signed-in cart readiness without an empty ready checkout CTA", async () => {
    renderSignedInBlockedCartCheckoutStart();

    expect(await screen.findAllByText("1 item")).not.toHaveLength(0);
    expect(screen.getAllByText("Needs review").length).toBeGreaterThan(0);
    expect(screen.getByText("No cart items are ready for checkout.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review Buy Cart" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Continue to checkout" })).toBeNull();
    expect(screen.queryByText("0 items")).toBeNull();
  });
});
