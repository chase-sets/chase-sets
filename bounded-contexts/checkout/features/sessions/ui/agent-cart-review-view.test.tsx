// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCartReviewView } from "./agent-cart-review-view";
import fixtures from "./agent-checkout-fixtures.json";
import requiresAction from "./requires_action.negative.json";

const result = (structuredContent: unknown) => ({ kind: "result" as const, result: { structuredContent } });
const continueButton = () => screen.queryByRole("button", { name: "Continue checkout" });

afterEach(cleanup);

describe("agent cart review states", () => {
  it("shows loading, then fails closed for absent, malformed and retired results", () => {
    const onContinue = vi.fn(async () => {});
    const view = render(<AgentCartReviewView state={{ kind: "loading" }} onContinue={onContinue} />);
    expect(screen.getByText("Loading checkout")).toBeTruthy();
    const statusless: Record<string, unknown> = { ...fixtures.unpaid };
    delete statusless.status;
    for (const toolResult of [
      undefined,
      { structuredContent: { products: [] } },
      requiresAction,
      { structuredContent: { ...fixtures.unpaid, ucp: { ...fixtures.unpaid.ucp, version: "2026-04-08" } } },
      { structuredContent: statusless },
      { structuredContent: { ...fixtures.unpaid, status: "shipped" } },
      {
        structuredContent: {
          ...fixtures.unpaid,
          totals: fixtures.unpaid.totals.filter((entry) => entry.type !== "total"),
        },
      },
    ]) {
      view.rerender(<AgentCartReviewView state={{ kind: "result", result: toolResult }} onContinue={onContinue} />);
      expect(screen.getByRole("alert").textContent).toContain("Checkout could not be displayed");
      expect(continueButton()).toBeNull();
    }
  });

  it("renders the UCP error envelope's messages without an action", () => {
    render(<AgentCartReviewView state={result(fixtures.notFound)} onContinue={vi.fn(async () => {})} />);
    const alert = screen.getByRole("alert").textContent;
    expect(alert).toContain("Chase Sets could not load this checkout");
    expect(alert).toContain("The checkout request could not be completed.");
    expect(continueButton()).toBeNull();
  });

  it("renders an empty checkout without an action", () => {
    render(<AgentCartReviewView state={result(fixtures.empty)} onContinue={vi.fn(async () => {})} />);
    expect(screen.getByText("This checkout has no items")).toBeTruthy();
    expect(continueButton()).toBeNull();
  });

  it.each(["light", "dark"] as const)("renders lines, messages and the server totals as sent in %s", (theme) => {
    const view = render(<AgentCartReviewView theme={theme} state={result(fixtures.unpaid)} />);
    expect(view.container.querySelector("[data-chase-theme]")?.getAttribute("data-color-mode")).toBe(theme);
    expect(screen.getByText("Charizard")).toBeTruthy();
    expect(screen.getByText("Payment is required to continue checkout.")).toBeTruthy();
    // The only line sums to $20.00; the checkout total is the server's $26.49.
    for (const [label, amount] of [
      ["Subtotal", "$20.00"],
      ["Shipping", "$4.99"],
      ["Tax", "$1.50"],
      ["Total", "$26.49"],
    ]) {
      expect(screen.getByText(label).nextElementSibling?.textContent).toContain(amount);
    }
    expect(continueButton()).toBeNull();

    // A total that is not the sum of its breakdown is still shown exactly as sent.
    const totals = fixtures.unpaid.totals.map((entry) => (entry.type === "total" ? { ...entry, amount: 9999 } : entry));
    view.rerender(<AgentCartReviewView theme={theme} state={result({ ...fixtures.unpaid, totals })} />);
    expect(screen.getByText("Total").nextElementSibling?.textContent).toContain("$99.99");
  });

  it("offers continue only for non-terminal checkouts when it is supplied", () => {
    const onContinue = vi.fn(async () => {});
    const view = render(<AgentCartReviewView state={result(fixtures.unpaid)} onContinue={onContinue} />);
    for (const fixture of [fixtures.unpaid, fixtures.captured, fixtures.unavailable]) {
      view.rerender(<AgentCartReviewView state={result(fixture)} onContinue={onContinue} />);
      expect(continueButton()).not.toBeNull();
    }
    for (const fixture of [fixtures.completed, fixtures.canceled, fixtures.expired]) {
      view.rerender(<AgentCartReviewView state={result(fixture)} onContinue={onContinue} />);
      expect(screen.getByText("Charizard")).toBeTruthy();
      expect(continueButton()).toBeNull();
    }
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("shows continue as pending, then a Banner when it is rejected", async () => {
    let reject: (error: Error) => void = () => {};
    const onContinue = vi.fn(() => new Promise<void>((_resolve, fail) => (reject = fail)));
    render(<AgentCartReviewView state={result(fixtures.unpaid)} onContinue={onContinue} />);
    fireEvent.click(continueButton()!);
    expect(onContinue).toHaveBeenCalledOnce();
    expect(continueButton()?.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("Checkout could not continue. Try again.")).toBeNull();

    await act(async () => reject(new Error("host refused")));
    expect(screen.getByText("Checkout could not continue. Try again.")).toBeTruthy();
    expect(continueButton()?.getAttribute("aria-busy")).toBeNull();
    expect(document.body.textContent).not.toContain("host refused");
  });
});
