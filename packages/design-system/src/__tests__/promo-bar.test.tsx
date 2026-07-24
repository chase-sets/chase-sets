import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PromoBar } from "../components/feedback";
import { ChaseRoot } from "../theme/provider";

function renderPromoBar(messages: Parameters<typeof PromoBar>[0]["messages"]) {
  return render(
    <ChaseRoot reducedMotion="always">
      <PromoBar messages={messages} />
    </ChaseRoot>,
  );
}

function mockReducedMotionPreference(matches: boolean) {
  const previousMatchMedia = window.matchMedia;
  const mediaQueryList = {
    matches,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  } as MediaQueryList;

  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn(() => mediaQueryList),
  });

  return () => {
    if (previousMatchMedia) {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        writable: true,
        value: previousMatchMedia,
      });
      return;
    }

    Reflect.deleteProperty(window, "matchMedia");
  };
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

  it("truncates the headline instead of wrapping so the compact row stays one line", () => {
    renderPromoBar([{ id: "shipping-credit", title: "Earn 5% toward shipping on every order." }]);

    expect(screen.getByText("Earn 5% toward shipping on every order.").className).toContain("truncate");
  });

  it("hides the description below the md breakpoint and shows it at md and up", () => {
    const { container } = renderPromoBar([
      {
        id: "shipping-credit",
        title: "Earn 5% toward shipping.",
        description: "Applies automatically at checkout.",
      },
    ]);

    const descriptionWrapper = screen.getByText("Applies automatically at checkout.").closest("span");
    expect(descriptionWrapper?.className).toContain("hidden");
    expect(descriptionWrapper?.className).toContain("md:block");
  });

  it("hides manual cycling controls below md when motion is allowed, since auto-rotation covers navigation there", () => {
    renderPromoBar([
      { id: "shipping-credit", title: "Earn 5% toward shipping." },
      { id: "listing-fees", title: "0% fees on beta listings." },
    ]);

    const controlsWrapper = screen.getByLabelText("Next announcement").closest("span[class*='shrink-0']");
    expect(controlsWrapper?.className).toContain("hidden");
    expect(controlsWrapper?.className).toContain("md:inline-block");
  });

  it("keeps manual cycling controls visible at every breakpoint when the user prefers reduced motion, since auto-rotation is off", () => {
    const restoreMatchMedia = mockReducedMotionPreference(true);

    try {
      renderPromoBar([
        { id: "shipping-credit", title: "Earn 5% toward shipping." },
        { id: "listing-fees", title: "0% fees on beta listings." },
      ]);

      const controlsWrapper = screen.getByLabelText("Next announcement").closest("span[class*='shrink-0']");
      expect(controlsWrapper?.className).not.toContain("hidden");
    } finally {
      restoreMatchMedia();
    }
  });
});
