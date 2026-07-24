import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { PromoBar } from "../components/feedback";
import { ChaseRoot, type ChaseRootProps } from "../theme/provider";

function renderPromoBar(
  messages: Parameters<typeof PromoBar>[0]["messages"],
  reducedMotion: ChaseRootProps["reducedMotion"] = "never",
) {
  return render(
    <ChaseRoot reducedMotion={reducedMotion}>
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

  it("keeps the headline and link on a single row at every breakpoint (no mobile column stack)", () => {
    const { container } = renderPromoBar([
      {
        id: "shipping-credit",
        title: "Earn 5% toward shipping on every order.",
        href: "/order-protection",
        linkLabel: "Learn more",
      },
    ]);

    const row = container.querySelector("section > div");
    expect(row?.className).toContain("flex-row");
    expect(row?.className).not.toContain("flex-col");
  });

  it("truncates the headline below md but preserves wrapping from md up, since mobile compaction shouldn't drop desktop content", () => {
    renderPromoBar([{ id: "shipping-credit", title: "Earn 5% toward shipping on every order." }]);

    const title = screen.getByText("Earn 5% toward shipping on every order.");
    expect(title.className).toContain("truncate");
    expect(title.className).toContain("md:whitespace-normal");
    expect(title.className).not.toContain("md:truncate");
  });

  it("hides the description below the md breakpoint, and truncates it below md but preserves wrapping from md up", () => {
    renderPromoBar([
      {
        id: "shipping-credit",
        title: "Earn 5% toward shipping.",
        description: "Applies automatically at checkout.",
      },
    ]);

    const description = screen.getByText("Applies automatically at checkout.");
    const descriptionWrapper = description.closest("div");
    expect(descriptionWrapper?.className).toContain("hidden");
    expect(descriptionWrapper?.className).toContain("md:block");
    expect(description.className).toContain("truncate");
    expect(description.className).toContain("md:whitespace-normal");
    expect(description.className).not.toContain("md:truncate");
  });

  it("keeps manual navigation and pause controls visible at every breakpoint while auto-rotation is active, so mobile users can navigate and pause", () => {
    renderPromoBar([
      { id: "shipping-credit", title: "Earn 5% toward shipping." },
      { id: "listing-fees", title: "0% fees on beta listings." },
    ]);

    const nextButton = screen.getByLabelText("Next announcement");
    const controlsWrapper = nextButton.parentElement;
    expect(controlsWrapper?.className).not.toContain("hidden");
    expect(controlsWrapper?.className).not.toContain("md:inline-block");
    expect(screen.getByLabelText("Previous announcement")).toBeTruthy();
    expect(screen.getByLabelText("Pause announcements")).toBeTruthy();
  });

  it("keeps manual navigation controls visible but drops the pause control when the user prefers reduced motion, since there is nothing to pause", () => {
    renderPromoBar(
      [
        { id: "shipping-credit", title: "Earn 5% toward shipping." },
        { id: "listing-fees", title: "0% fees on beta listings." },
      ],
      "always",
    );

    expect(screen.getByLabelText("Next announcement")).toBeTruthy();
    expect(screen.getByLabelText("Previous announcement")).toBeTruthy();
    expect(screen.queryByLabelText("Pause announcements")).toBeNull();
  });

  it("auto-rotates through messages on the configured interval when motion is allowed", () => {
    vi.useFakeTimers();

    try {
      renderPromoBar(
        [
          { id: "shipping-credit", title: "Earn 5% toward shipping." },
          { id: "listing-fees", title: "0% fees on beta listings." },
        ],
        "never",
      );

      expect(screen.getByText("Earn 5% toward shipping.")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(7000);
      });

      expect(screen.getByText("0% fees on beta listings.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not auto-rotate when the user prefers reduced motion", () => {
    vi.useFakeTimers();

    try {
      renderPromoBar(
        [
          { id: "shipping-credit", title: "Earn 5% toward shipping." },
          { id: "listing-fees", title: "0% fees on beta listings." },
        ],
        "always",
      );

      expect(screen.getByText("Earn 5% toward shipping.")).toBeTruthy();

      act(() => {
        vi.advanceTimersByTime(14000);
      });

      expect(screen.getByText("Earn 5% toward shipping.")).toBeTruthy();
      expect(screen.queryByText("0% fees on beta listings.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
