// @vitest-environment jsdom
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChaseRoot } from "@chase-sets/design-system";

const createPasskeyCredential = vi.hoisted(() => vi.fn());
vi.mock("@chase-sets/auth/web", () => ({ createPasskeyCredential }));

import MarketplaceAccountPaymentRoute from "../routes/marketplace/account-payment";

const payment = {
  payment_id: "pay_pending",
  buyer_account_id: "acc_guest",
  order_ids: ["ord_guest"],
  amount: "11.00",
  currency_code: "USD",
  processor_name: "stripe",
  processor_payment_kind: "payment-intent",
  processor_payment_reference: "pi_guest",
  processor_amount: "11.00",
  processor_client_secret: null,
  processor_redirect_url: null,
  processor_status: "succeeded",
  status: "captured",
  failure_code: null,
  failure_message: null,
  created_at: "2026-04-01T00:00:00.000Z",
  updated_at: "2026-04-01T00:05:00.000Z",
  captured_at: "2026-04-01T00:05:00.000Z",
  failed_at: null,
  cancelled_at: null,
  processor_publishable_key: null,
  provider_events: [],
  marketplace_sales_fee_amount: "1.00",
  marketplace_checkout_fee_amount: "0.50",
  seller_net_amount: "9.50",
  balance_credit_amount: "0.00",
  seller_payout_amount: "9.50",
  payment_method_category: "card",
  source_context: "checkout",
  source_reference_id: "chk_guest",
};

const guestData = {
  payment,
  orders: [
    {
      order_id: "ord_guest",
      status: "paid",
      total_amount: "11.00",
      seller_payout_amount: "9.50",
      payment_deadline_at: null,
    },
  ],
  isGuestCheckoutPayment: true,
  guestClaimContext: {
    accountId: "acc_guest",
    paymentId: "pay_pending",
    contactEmail: "jane@example.com",
    contactName: "Jane Smith",
  },
  showSupportDetails: false,
  paymentElementDefaultValues: null,
};

describe.each(["normal completion", "assertion failure", "pending unmount"])(
  "account payment passkey pending: %s",
  (cleanupCase) => {
    afterEach(() => {
      vi.resetAllMocks();
    });

    it("passkey claim posts once", async () => {
      createPasskeyCredential.mockResolvedValue({
        challengeId: "challenge_1",
        challenge: "challenge",
        externalCredentialId: "credential_1",
        label: "This device",
        webauthnResponse: "response",
      });
      let release!: () => void;
      const response = new Promise<null>((resolve) => {
        release = () => resolve(null);
      });
      let posts = 0;
      const router = createMemoryRouter(
        [
          {
            path: "/account/payments/:paymentId",
            loader: () => guestData,
            action: async () => {
              posts += 1;
              return response;
            },
            element: <MarketplaceAccountPaymentRoute />,
          },
        ],
        { initialEntries: ["/account/payments/pay_pending"] },
      );
      // Match the established guest-claim route harness: initialize the data
      // router before rendering the route component so the claim surface, not
      // the router's hydration fallback, is the evidence under test.
      const dispose = vi.spyOn(router, "dispose");
      let view: ReturnType<typeof render> | undefined;
      const claim = async () => {
        try {
          await router.initialize();
          view = render(
            <ChaseRoot>
              <RouterProvider router={router} />
            </ChaseRoot>,
          );
          const user = userEvent.setup();
          expect(await screen.findByText("Save this order")).toBeTruthy();
          const submit = await screen.findByRole("button", { name: "Save with passkey" });
          await user.click(submit);
          await waitFor(() => expect(posts).toBe(1));
          expect(router.state.navigation.state).toBe("submitting");
          await user.click(submit);
          expect(posts).toBe(1);
          if (cleanupCase === "assertion failure") {
            expect(posts, "intentional pending assertion failure").toBe(2);
          }
          if (cleanupCase === "pending unmount") {
            await act(async () => view?.unmount());
            expect(view.container.innerHTML).toBe("");
            expect(router.state.navigation.state).toBe("submitting");
          }
        } finally {
          try {
            await act(async () => {
              release();
              await response;
              // RTL waitFor temporarily disables the act environment.
              await vi.waitFor(() => expect(router.state.navigation.state).toBe("idle"));
            });
          } finally {
            try {
              await act(async () => view?.unmount());
            } finally {
              router.dispose();
            }
          }
        }
      };

      if (cleanupCase === "assertion failure") {
        await expect(claim()).rejects.toThrow("intentional pending assertion failure");
      } else {
        await claim();
      }
      expect(router.state.navigation.state).toBe("idle");
      expect(view?.container.innerHTML).toBe("");
      expect(dispose).toHaveBeenCalledOnce();
    });
  },
);
