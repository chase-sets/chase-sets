import { describe, expect, it } from "vitest";
import { resolveOrderPaymentDeadline, resolveTerminalPaymentFailureDeadline } from "./policies";

describe("ordering payment deadline policies", () => {
  it.each([
    ["card", "2026-03-31T01:00:00.000Z", "ordering-payment-deadline-card-v1"],
    ["bank-account", "2026-04-05T00:00:00.000Z", "ordering-payment-deadline-bank-account-v1"],
    ["platform-credit", "2026-03-31T00:15:00.000Z", "ordering-payment-deadline-platform-credit-v1"],
  ] as const)(
    "resolves %s deadlines through policy tokens",
    (methodCategory, paymentDeadlineAt, paymentDeadlinePolicy) => {
      expect(resolveOrderPaymentDeadline("2026-03-31T00:00:00.000Z", methodCategory)).toEqual({
        paymentDeadlineAt,
        paymentDeadlinePolicy,
      });
    },
  );

  it("uses the terminal-failure grace token for failed payment windows", () => {
    expect(resolveTerminalPaymentFailureDeadline("2026-03-31T00:00:00.000Z")).toEqual({
      paymentDeadlineAt: "2026-03-31T00:05:00.000Z",
      paymentDeadlinePolicy: "ordering-payment-deadline-terminal-failure-grace-v1",
    });
  });
});
