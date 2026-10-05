import { describe, expect, it } from "vitest";
import { formatMoney, t } from "@chase-sets/localization";
import { buildCheckoutTotalsLines } from "./checkout-order-summary-section";

const wallet = { available_balance_amount: "5.00", currency_code: "usd" };
const payment = {
  marketplace_checkout_fee: { marketplace_checkout_fee_amount: "1.00" },
  wallet_credit: { applied_amount: "5.00" },
};
const creditLabel = t("checkout.features.sessions.ui.checkoutPage.wallet.credit");

function totals(input: { wallet: typeof wallet | null; payment: typeof payment | null; isOfferIntent?: boolean }) {
  return buildCheckoutTotalsLines({
    isOfferIntent: input.isOfferIntent ?? false,
    preview: null,
    payment: input.payment,
    wallet: input.wallet,
    authenticityCheckShowsInTotals: false,
    authenticityCheckOffer: null,
  });
}

describe("checkout order summary wallet credit", () => {
  it("uses the actual applied credit only for a known wallet and a quote", () => {
    expect(totals({ wallet, payment }).find((line) => line.label === creditLabel)?.value).toBe(
      formatMoney("-5.00", "USD"),
    );
    expect(
      totals({
        wallet: { ...wallet, available_balance_amount: "0.00" },
        payment: {
          ...payment,
          wallet_credit: { applied_amount: "0.00" },
        },
      }).find((line) => line.label === creditLabel)?.value,
    ).toBe(formatMoney("-0.00", "USD"));
  });

  it.each([
    ["unavailable wallet", null, payment],
    ["unquoted wallet", wallet, null],
    ["guest without wallet", null, null],
  ])("omits the invented credit for %s while keeping other totals", (_name, knownWallet, quote) => {
    const lines = totals({ wallet: knownWallet, payment: quote });
    expect(lines.some((line) => line.label === creditLabel)).toBe(false);
    expect(lines.some((line) => line.label === t("checkout.features.sessions.ui.checkoutPage.subtotal"))).toBe(true);
    expect(
      lines.some((line) => line.label === t("checkout.features.sessions.ui.checkoutPage.marketplace.checkout.fee")),
    ).toBe(true);
  });

  it("does not add credit to offer-intent totals", () => {
    expect(totals({ wallet, payment, isOfferIntent: true }).some((line) => line.label === creditLabel)).toBe(false);
  });
});
