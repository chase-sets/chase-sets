import { describe, expect, it } from "vitest";
import { PaymentsApiError } from "../client";

describe("PaymentsApiError", () => {
  it("uses structured API error messages", () => {
    const error = new PaymentsApiError(409, {
      error: {
        code: "fee_quote_stale",
        message: "Marketplace checkout fee changed. Review the payment total and try again.",
      },
    });

    expect(error.message).toBe(
      "Marketplace checkout fee changed. Review the payment total and try again.",
    );
  });

  it("uses string API errors without object coercion", () => {
    const error = new PaymentsApiError(400, {
      error: "Payment could not be retried.",
    });

    expect(error.message).toBe("Payment could not be retried.");
  });
});
