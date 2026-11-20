// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeferredStripePayment } from "./use-deferred-stripe-payment";

const { loadStripe } = vi.hoisted(() => ({ loadStripe: vi.fn() }));
vi.mock("@stripe/stripe-js", () => ({ loadStripe }));

afterEach(cleanup);

function fixture(validationError?: string) {
  const calls: string[] = [];
  let ready: () => void;
  const element = {
    on: vi.fn((event: string, handler: () => void) => {
      if (event === "ready") ready = handler;
    }),
    mount: vi.fn(() => ready()),
    destroy: vi.fn(),
  };
  const elements = {
    create: vi.fn(() => element),
    update: vi.fn(async () => {
      calls.push("update");
    }),
    submit: vi.fn(async () => {
      calls.push("submit");
      return validationError ? { error: { message: validationError } } : {};
    }),
  };
  const stripe = {
    elements: vi.fn(() => elements),
    createConfirmationToken: vi.fn(async () => {
      calls.push("token");
      return { confirmationToken: { id: "ctoken_fixture" } };
    }),
  };
  loadStripe.mockResolvedValue(stripe);
  let card: ReturnType<typeof useDeferredStripePayment>;
  function Entry({ quote }: { quote: string }) {
    card = useDeferredStripePayment({ publishableKey: "pk_test_fixture", amount: 2605, currency: "usd", quote });
    return card.entry;
  }
  return { calls, elements, stripe, element, Entry, card: () => card };
}

describe("deferred Stripe Payment Element", () => {
  it("does no submit or token creation on mount or quote remount; Pay updates consent, validates and tokenizes in order", async () => {
    const { calls, stripe, elements, element, Entry, card } = fixture();
    const view = render(<Entry quote="quote_1" />);
    await waitFor(() => expect(card().ready).toBe(true));
    expect(stripe.elements).toHaveBeenCalledExactlyOnceWith({
      mode: "payment",
      amount: 2605,
      currency: "usd",
      captureMethod: "automatic",
    });
    expect(elements.create).toHaveBeenCalledWith("payment", { wallets: { applePay: "auto", googlePay: "auto" } });
    expect(calls).toEqual([]);
    view.rerender(<Entry quote="quote_2" />);
    await waitFor(() => expect(card().ready).toBe(true));
    expect(element.destroy).toHaveBeenCalledTimes(1);
    expect(calls).toEqual([]);
    await act(async () => expect(await card().createConfirmationToken(true)).toBe("ctoken_fixture"));
    expect(calls).toEqual(["update", "submit", "token"]);
    expect(elements.update).toHaveBeenCalledExactlyOnceWith({ setupFutureUsage: "off_session" });
  });

  it("does not create a token when Element validation fails", async () => {
    const { calls, Entry, card } = fixture("Check the card number");
    render(<Entry quote="quote_1" />);
    await waitFor(() => expect(card().ready).toBe(true));
    await act(async () => expect(await card().createConfirmationToken(false)).toBeNull());
    expect(calls).toEqual(["submit"]);
    expect(screen.getByText("Check the card number")).toBeTruthy();
  });
});
