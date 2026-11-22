// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expectUcpCapture } from "@chase-sets/platform-runtime/ucp-schema-test-support";
import { AgentCheckoutHandoffView } from "./agent-checkout-handoff-view";
import fixtures from "./agent-checkout-fixtures.json";
import requiresAction from "./requires_action.negative.json";

const result = (structuredContent: unknown) => ({ kind: "result" as const, result: { structuredContent } });
const continueButton = () => screen.queryByRole("button", { name: "Continue on Chase Sets" });
const continueUrl = fixtures.unpaid.continue_url;
// Checkout emits no discount rows today; the pinned UCP total.json requires any it sends to be negative.
const discounted = {
  ...fixtures.unpaid,
  totals: [
    { type: "subtotal", amount: 2000 },
    { type: "discount", amount: -500 },
    { type: "fulfillment", amount: 499 },
    { type: "tax", amount: 150 },
    { type: "total", amount: 2149 },
  ],
};

function renderHandoff(structuredContent: unknown, openLink = vi.fn(async (_url: string) => {})) {
  const view = render(<AgentCheckoutHandoffView state={result(structuredContent)} openLink={openLink} />);
  return { ...view, openLink };
}

afterEach(cleanup);

describe("agent checkout handoff states", () => {
  it("shows loading, then fails closed for absent, malformed and retired results", () => {
    const openLink = vi.fn(async () => {});
    const view = render(<AgentCheckoutHandoffView state={{ kind: "loading" }} openLink={openLink} />);
    expect(screen.getByText("Loading checkout")).toBeTruthy();
    const orderless: Record<string, unknown> = { ...fixtures.completed };
    delete orderless.order;
    for (const toolResult of [
      undefined,
      requiresAction,
      { structuredContent: { ...fixtures.unpaid, ucp: { ...fixtures.unpaid.ucp, version: "2026-04-08" } } },
      { structuredContent: orderless },
    ]) {
      view.rerender(<AgentCheckoutHandoffView state={{ kind: "result", result: toolResult }} openLink={openLink} />);
      expect(screen.getByRole("alert").textContent).toContain("Checkout status could not be displayed");
      expect(screen.queryByRole("button")).toBeNull();
    }
    expect(openLink).not.toHaveBeenCalled();
  });

  it.each([
    ["unpaid", fixtures.unpaid, "Payment is required to continue checkout."],
    ["pending confirmation", fixtures.pendingConfirmation, "Buyer confirmation is required to continue payment."],
    ["failed payment", fixtures.failedPayment, "Payment is required to continue checkout."],
    ["cancelled payment", fixtures.cancelledPayment, "Payment is required to continue checkout."],
    ["discounted", discounted, "Payment is required to continue checkout."],
  ])("hands a %s escalation to Chase Sets through openLink", (_row, fixture, warning) => {
    expectUcpCapture(fixture, { operation: "complete_checkout", kind: "resource" });
    const { openLink } = renderHandoff(fixture);
    expect(screen.getByText("Finish checkout on Chase Sets")).toBeTruthy();
    expect(screen.getByText(warning)).toBeTruthy();
    fireEvent.click(continueButton()!);
    expect(openLink).toHaveBeenCalledExactlyOnceWith(continueUrl);
    expect(fixture.continue_url).toBe(continueUrl);
  });

  it("refuses message-less, continue_url-less and non-https escalations without opening anything", () => {
    // `urlless` still carries https `links`; only `continue_url` may supply the handoff.
    const urlless: Record<string, unknown> = { ...fixtures.unpaid };
    delete urlless.continue_url;
    const messageless: Record<string, unknown> = { ...fixtures.unpaid };
    delete messageless.messages;
    for (const structuredContent of [
      messageless,
      { ...fixtures.unpaid, messages: [] },
      urlless,
      { ...urlless, continueUrl },
      { ...urlless, checkout_url: continueUrl },
      { ...urlless, order: { id: "ord_1", permalink_url: continueUrl } },
      { ...fixtures.unpaid, continue_url: continueUrl.replace(/^https:/, "http:") },
      { ...fixtures.unpaid, continue_url: "javascript:alert(1)" },
      { ...fixtures.unpaid, continue_url: "data:text/html,<script>alert(1)</script>" },
      { ...fixtures.unpaid, continue_url: continueUrl.replace("https://", "https://buyer:secret@") },
    ]) {
      const { openLink } = renderHandoff(structuredContent);
      expect(screen.getByRole("alert").textContent).toContain("This checkout cannot be continued from chat");
      expect(screen.queryByRole("button")).toBeNull();
      expect(openLink).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("shows a captured payment as processing, never as a confirmation", () => {
    renderHandoff(fixtures.captured);
    expect(screen.getByText("Payment is processing")).toBeTruthy();
    expect(screen.queryByText("Order confirmed")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows an unavailable line's message at its line without an action", () => {
    renderHandoff(fixtures.unavailable);
    expect(screen.getByText("This checkout needs changes")).toBeTruthy();
    const line = screen.getByText("Charizard");
    expect(line.nextElementSibling?.textContent).toBe("This item is no longer available.");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders error messages without an action", () => {
    for (const structuredContent of [
      fixtures.notFound,
      { ...fixtures.unpaid, messages: [{ type: "error", code: "not_found", content: "Checkout is gone." }] },
    ]) {
      const { openLink } = renderHandoff(structuredContent);
      expect(screen.getByRole("alert").textContent).toContain("Chase Sets could not prepare this checkout");
      expect(screen.queryByRole("button")).toBeNull();
      expect(openLink).not.toHaveBeenCalled();
      cleanup();
    }
    renderHandoff(fixtures.notFound);
    expect(screen.getByRole("alert").textContent).toContain("The checkout request could not be completed.");
  });

  it("confirms a completed order from its order fields and never offers the handoff", () => {
    const { openLink } = renderHandoff({ ...fixtures.completed, continue_url: continueUrl });
    expect(screen.getByText("Order confirmed")).toBeTruthy();
    expect(screen.getByText("Purchase CS-0001")).toBeTruthy();
    expect(screen.getByText("$26.49")).toBeTruthy();
    expect(continueButton()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View order on Chase Sets" }));
    expect(openLink).toHaveBeenCalledExactlyOnceWith(fixtures.completed.order.permalink_url);
  });

  it.each([
    ["canceled", fixtures.canceled, "Checkout canceled"],
    ["expired", fixtures.expired, "Checkout expired"],
  ])("shows a %s checkout without an action, even with an injected continue_url", (_row, fixture, title) => {
    const { openLink } = renderHandoff({ ...fixture, continue_url: continueUrl });
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(openLink).not.toHaveBeenCalled();
  });

  it("shows a warning when the host refuses to open Chase Sets", async () => {
    const openLink = vi.fn(async () => {
      throw new Error("host refused");
    });
    const { rerender } = renderHandoff(fixtures.unpaid, openLink);
    await act(async () => fireEvent.click(continueButton()!));
    expect(screen.getByText("Chase Sets checkout could not be opened")).toBeTruthy();
    expect(document.body.textContent).not.toContain("host refused");

    // The warning belongs to the result it was raised on; the next tool result clears it.
    rerender(<AgentCheckoutHandoffView state={result(fixtures.canceled)} openLink={openLink} />);
    expect(screen.getByText("Checkout canceled")).toBeTruthy();
    expect(screen.queryByText("Chase Sets checkout could not be opened")).toBeNull();
  });
});
