import { describe, expect, it } from "vitest";
import { CheckoutApiError } from "../../../support/request-support/api-client";
import { checkoutRecoveryForError, checkoutRecoveryForFreshWriteError } from "./checkout-recovery";

describe("checkout-closed-recovery", () => {
  it("classifies closure as a non-retryable domain blocker before transient 503 recovery", () => {
    const error = new CheckoutApiError(503, { error: { code: "checkout_closed", message: "Closed" } });
    const recovery = checkoutRecoveryForError(error, { roleKey: "owner" });
    expect(recovery).toMatchObject({
      kind: "checkout-closed",
      recoveryKind: "action-required",
      status: 503,
      postWriteResult: {
        kind: "domain-blocker",
        reason: "checkout-closed",
        recoveryKind: "action-required",
        retryable: false,
      },
      title: "Checkout is closed",
      primaryAction: { href: "/account/cart", label: "View Buy Cart" },
    });
    expect(
      checkoutRecoveryForFreshWriteError(error, { roleKey: "owner" }, new Request("https://example.test/checkout")),
    ).toEqual(recovery);
    expect(
      checkoutRecoveryForError(new CheckoutApiError(503, { error: { code: "projection_freshness_timeout" } }), {
        roleKey: "owner",
      })?.kind,
    ).toBe("checkout-preparing");
  });
});
