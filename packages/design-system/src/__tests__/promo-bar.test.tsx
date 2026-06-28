import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { PromoBar } from "../components/feedback";
import { ChaseRoot } from "../theme/provider";

function renderPromoBar(messages: Parameters<typeof PromoBar>[0]["messages"]) {
  return render(
    <ChaseRoot reducedMotion="always">
      <PromoBar messages={messages} />
    </ChaseRoot>,
  );
}

describe("PromoBar", () => {
  it("renders nothing when no messages are available", () => {
    const { container } = renderPromoBar([]);

    expect(container.textContent).toBe("");
  });

  it("renders a single linked promo without cycling controls", () => {
    renderPromoBar([
      {
        id: "shipping-credit",
        title: "Earn 5% toward shipping on every order.",
        href: "/order-protection",
        linkLabel: "Learn more",
        tone: "success",
      },
    ]);

    expect(screen.getByText("Earn 5% toward shipping on every order.")).toBeTruthy();
    expect(screen.getByRole("link", { name: /learn more/i }).getAttribute("href")).toBe("/order-protection");
    expect(screen.queryByLabelText("Next announcement")).toBeNull();
  });

  it("supports danger announcements through the shared tone vocabulary", () => {
    const { container } = renderPromoBar([
      {
        id: "maintenance",
        title: "Seller payouts are delayed.",
        tone: "danger",
      },
    ]);

    expect(screen.getByText("Seller payouts are delayed.")).toBeTruthy();
    expect(container.querySelector("section")?.className).toContain("bg-danger-soft");
  });

  it("lets users move through multiple messages", async () => {
    const user = userEvent.setup();
    renderPromoBar([
      { id: "shipping-credit", title: "Earn 5% toward shipping." },
      { id: "listing-fees", title: "0% fees on beta listings." },
    ]);

    await user.click(screen.getByLabelText("Next announcement"));

    expect(screen.getByText("0% fees on beta listings.")).toBeTruthy();
    expect(screen.getByText("2/2")).toBeTruthy();
  });
});
