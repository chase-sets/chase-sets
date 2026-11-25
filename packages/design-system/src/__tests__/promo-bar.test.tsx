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

  it("AC4 (#8270): renders the band as a flush tinted strip with tone fill but no border, ring, outline or shadow box, while rotation controls, the aria-live counter and message links keep working", async () => {
    const user = userEvent.setup();
    const { container } = renderPromoBar([
      {
        id: "shipping-credit",
        title: "Earn 5% toward shipping on every order.",
        href: "/order-protection",
        linkLabel: "Learn more",
        tone: "success",
      },
      { id: "listing-fees", title: "0% fees on beta listings.", tone: "warning" },
    ]);
    // Chrome vocabulary the surface-diet law forbids on furniture; responsive
    // and state variants are stripped so `md:border` or `hover:ring-1` still count.
    const chromeClassPattern = /^(?:border|border-.+|surface-border|shadow-.+|ring|ring-.+|outline|outline-.+)$/;
    const chromeTokens = (element: Element) =>
      element.className
        .split(/\s+/)
        .filter(Boolean)
        .map((token) => token.replace(/^(?:[a-z0-9-]+:)+/, ""))
        .filter((token) => chromeClassPattern.test(token));

    const band = container.querySelector("section");
    expect(band).not.toBeNull();
    expect(band!.getAttribute("aria-label")).toBe("Marketplace announcements");
    expect(band!.classList.contains("bg-success-soft")).toBe(true);
    expect(band!.classList.contains("border")).toBe(false);
    expect(chromeTokens(band!)).toEqual([]);

    expect(screen.getByRole("link", { name: /learn more/i }).getAttribute("href")).toBe("/order-protection");
    const counter = screen.getByText("1/2");
    expect(counter.getAttribute("aria-live")).toBe("polite");
    expect(screen.getByLabelText("Previous announcement")).toBeTruthy();
    expect(screen.getByLabelText("Pause announcements")).toBeTruthy();

    await user.click(screen.getByLabelText("Next announcement"));

    expect(screen.getByText("0% fees on beta listings.")).toBeTruthy();
    expect(screen.getByText("2/2").getAttribute("aria-live")).toBe("polite");
    expect(band!.classList.contains("bg-warning-soft")).toBe(true);
    expect(band!.classList.contains("bg-success-soft")).toBe(false);
    expect(chromeTokens(band!)).toEqual([]);
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

  it("gives the headline its own row on a phone and keeps the desktop actions beside it", () => {
    const { container } = renderPromoBar([
      {
        id: "shipping-credit",
        title: "Earn 5% toward shipping on every order.",
        href: "/order-protection",
        linkLabel: "Read the complete shipping credit terms and conditions",
      },
      { id: "listing-fees", title: "0% fees on beta listings." },
    ]);

    const layout = container.querySelector("section > div")!;
    const headline = screen.getByText("Earn 5% toward shipping on every order.");
    const link = screen.getByRole("link", { name: "Read the complete shipping credit terms and conditions" });
    expect(layout.classList.contains("grid")).toBe(true);
    expect(layout.className).toContain("sm:[grid-template-columns:");
    expect(layout.children[0]?.contains(headline)).toBe(true);
    expect(headline.classList.contains("truncate")).toBe(false);
    expect(layout.children[1]?.contains(link)).toBe(true);
    expect(layout.children[1]?.classList.contains("flex-wrap")).toBe(true);
    expect(layout.children[1]?.contains(screen.getByLabelText("Pause announcements"))).toBe(true);
  });

  it("does not reserve an empty action column for a text-only announcement", () => {
    const { container } = renderPromoBar([{ id: "maintenance", title: "Scheduled maintenance tonight" }]);

    const layout = container.querySelector("section > div")!;
    expect(layout.children).toHaveLength(1);
    expect(layout.classList.contains("grid-cols-1")).toBe(true);
    expect(layout.className).not.toContain("sm:[grid-template-columns:");
  });

  it("hides the description below md and wraps it where it is shown", () => {
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
    expect(description.classList.contains("truncate")).toBe(false);
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
