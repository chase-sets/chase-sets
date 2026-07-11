import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicPresenceHomePage } from "./public-pages";

const source = {
  pagePath: "/?utm_source=smoke",
  referrer: "https://example.test/cards",
  utmSource: "smoke",
  utmMedium: "automation",
  utmCampaign: "form-migration",
  utmContent: "hero",
  utmTerm: "pokemon",
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
});
