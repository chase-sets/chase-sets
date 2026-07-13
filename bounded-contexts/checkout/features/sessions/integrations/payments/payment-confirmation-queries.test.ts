import { describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import {
  exposeCheckoutPaymentConfirmation,
  getCheckoutPaymentConfirmationProjection,
} from "./payment-confirmation-queries";

describe("checkout payment confirmation composite projection", () => {
  it("binds projected payment confirmation state to the owning session and buyer", async () => {
    const row = {
      payment_id: "pay_1",
      amount: "27.29",
      currency_code: "usd",
      status: "pending-confirmation",
      processor_client_secret: "pi_1_secret_checkout",
    };
    const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));

    await expect(
      getCheckoutPaymentConfirmationProjection({ query } as unknown as PgQueryable, "chk_1", "acc_buyer"),
    ).resolves.toEqual(row);

    expect(query).toHaveBeenCalledWith(expect.stringContaining("session.buyer_account_id = $2"), [
      "chk_1",
      "acc_buyer",
    ]);
  });

  it("only exposes processor confirmation values while confirmation is pending", () => {
    const payment = {
      payment_id: "pay_1",
      amount: "27.29",
      currency_code: "usd",
      status: "captured",
      processor_client_secret: "pi_1_secret_checkout",
    };

    expect(exposeCheckoutPaymentConfirmation(payment, { publishableKey: "pk_test_checkout" })).toMatchObject({
      processor_client_secret: null,
      processor_publishable_key: null,
    });
    expect(
      exposeCheckoutPaymentConfirmation(
        { ...payment, status: "pending-confirmation" },
        { publishableKey: "pk_test_checkout" },
      ),
    ).toMatchObject({
      processor_client_secret: "pi_1_secret_checkout",
      processor_publishable_key: "pk_test_checkout",
    });
  });
});
