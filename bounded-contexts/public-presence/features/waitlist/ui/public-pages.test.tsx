import { cleanup, fireEvent, render as renderWithoutRouter, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicPresenceHomePage } from "./public-pages";

// PublicPresencePageShell registers the DS RouterLinkAdapter, so rendering it
// requires router context — exactly as it has in the production app tree.
function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

const source = {
  pagePath: "/?utm_source=smoke",
  referrer: "https://example.test/cards",
  utmSource: "smoke",
  utmMedium: "automation",
  utmCampaign: "form-migration",
  utmContent: "hero",
  utmTerm: "pokemon",
  referredBySignupId: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("public waitlist form migration smoke", () => {
  it("keeps the hero form to email + intent, with no required consent control", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected hero waitlist panel to render a form.");
    }

    expect(form.querySelector('input[name="marketingConsent"]')).toBeNull();
    expect(form.querySelector('input[type="checkbox"]')).toBeNull();

    fireEvent.change(form.querySelector('input[name="email"]')!, { target: { value: "seller@example.com" } });

    const formData = new FormData(form);
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("?index");
    expect(formData.get("email")).toBe("seller@example.com");
    expect(formData.get("role")).toBe("both");
    expect(formData.get("interests")).toBe("low-sales-fees");
    expect(formData.get("marketingConsent")).toBeNull();
    expect(formData.get("website")).toBe("");
    expect(formData.get("pagePath")).toBe("/?utm_source=smoke");
    expect(formData.get("referrer")).toBe("https://example.test/cards");
    expect(formData.get("utmSource")).toBe("smoke");
    expect(formData.get("utmMedium")).toBe("automation");
    expect(formData.get("utmCampaign")).toBe("form-migration");
    expect(formData.get("utmContent")).toBe("hero");
    expect(formData.get("utmTerm")).toBe("pokemon");
  });

  it("keeps the final-CTA form's marketing consent checkbox optional", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form-final");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected final-CTA waitlist panel to render a form.");
    }

    const consentCheckbox = form.querySelector<HTMLInputElement>('input[name="marketingConsent"]');
    if (!consentCheckbox) {
      throw new Error("Expected the final-CTA panel to render an optional marketing-consent checkbox.");
    }
    expect(consentCheckbox.required).toBe(false);

    fireEvent.change(form.querySelector('input[name="email"]')!, { target: { value: "buyer@example.com" } });

    const formDataBeforeConsent = new FormData(form);
    expect(formDataBeforeConsent.get("marketingConsent")).toBeNull();

    fireEvent.click(consentCheckbox);

    const formDataAfterConsent = new FormData(form);
    expect(formDataAfterConsent.get("marketingConsent")).toBe("yes");
  });

  it("carries a referral code from the loader source into a hidden form field", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={{ ...source, referredBySignupId: "wls_referrer" }} />);

    const panel = document.getElementById("waitlist-form");
    const form = panel?.querySelector("form");
    if (!form) {
      throw new Error("Expected hero waitlist panel to render a form.");
    }

    const formData = new FormData(form);
    expect(formData.get("referredBySignupId")).toBe("wls_referrer");
  });

  it("shows the waitlist counter near the hero form once it clears the display threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/waitlist/count")) {
          return new Response(JSON.stringify({ displayCount: 125 }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } });
      }),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    const panel = document.getElementById("waitlist-form");
    const counterText = await vi.waitFor(() => {
      const match = panel?.textContent?.includes("125+");
      if (!match) {
        throw new Error("Counter not rendered yet.");
      }
      return match;
    });

    expect(counterText).toBe(true);
  });

  it("keeps the waitlist counter hidden below the display threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ displayCount: null }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    render(<PublicPresenceHomePage actionData={null} source={source} />);

    await vi.waitFor(() => {
      expect(document.getElementById("waitlist-form")?.textContent).not.toContain("+");
    });
  });

  it("renders an unconditional founder-story Discord CTA ahead of the final section, and hides it when unconfigured", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    window.dataLayer = [];

    const { container, rerender } = render(
      <PublicPresenceHomePage actionData={null} discordInviteUrl="https://discord.gg/chase-sets" source={source} />,
    );

    const discordLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href="https://discord.gg/chase-sets"]'),
    );
    expect(discordLinks.length).toBeGreaterThanOrEqual(2);

    const founderSection = container.querySelector('[data-public-presence-section="founder_story"]');
    const finalCtaSection = container.querySelector('[data-public-presence-section="final_cta"]');
    expect(founderSection?.querySelector('a[href="https://discord.gg/chase-sets"]')).not.toBeNull();
    expect(finalCtaSection?.querySelector('a[href="https://discord.gg/chase-sets"]')).not.toBeNull();

    rerender(<PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />);
    expect(container.querySelectorAll('a[href="https://discord.gg/chase-sets"]').length).toBe(0);
  });
});
