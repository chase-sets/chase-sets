import { cleanup, render as renderWithoutRouter, screen, waitFor, type RenderOptions } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WaitlistSuccessPage } from "./success-page";

// PublicPresencePageShell registers the DS RouterLinkAdapter, so rendering it
// requires router context — exactly as it has in the production app tree.
function render(ui: ReactNode, options?: RenderOptions) {
  return renderWithoutRouter(ui, { wrapper: MemoryRouter, ...options });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubFetch(referralCount: number, referralGoal = 3) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/referral-summary")) {
      return new Response(JSON.stringify({ referralCount, referralGoal }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } });
  });
}

describe("waitlist success page", () => {
  it("renders the confirmation, referral link, and progress toward founding status", async () => {
    vi.stubGlobal("fetch", stubFetch(1));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);

    expect(screen.getByRole("heading", { name: "You are on the list" })).toBeTruthy();
    expect(screen.getByDisplayValue("https://chasesets.com/?ref=wls_public")).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("1 of 3")).toBeTruthy();
    });
  });

  it("fires succeeded and attributed analytics once per fresh landing", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(
      <WaitlistSuccessPage
        signupId="wls_public"
        publicOrigin="https://chasesets.com"
        discordInviteUrl={null}
        attributed
      />,
    );

    const events = (window.dataLayer ?? []).map((entry) => entry.event);
    expect(events).toContain("waitlist_signup_succeeded");
    expect(events).toContain("waitlist_signup_attributed");
  });

  it("omits the attributed event for an unreferred signup", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);

    const events = (window.dataLayer ?? []).map((entry) => entry.event);
    expect(events).not.toContain("waitlist_signup_attributed");
  });

  it("only shows the Discord share action when an invite URL is configured", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);
    expect(screen.queryByRole("link", { name: "Share on Discord" })).toBeNull();

    cleanup();

    render(
      <WaitlistSuccessPage
        signupId="wls_public"
        publicOrigin="https://chasesets.com"
        discordInviteUrl="https://discord.gg/example"
      />,
    );
    expect(screen.getByRole("link", { name: "Share on Discord" }).getAttribute("href")).toBe(
      "https://discord.gg/example",
    );
  });
});
