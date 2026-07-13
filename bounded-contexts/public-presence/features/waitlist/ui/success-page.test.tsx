import {
  cleanup,
  fireEvent,
  render as renderWithoutRouter,
  screen,
  waitFor,
  type RenderOptions,
} from "@testing-library/react";
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

function stubFetch(
  referralCount: number,
  referralGoal = 3,
  standing: { queuePosition: number | null; totalSignups: number; positionsAdvanced: number } = {
    queuePosition: null,
    totalSignups: 0,
    positionsAdvanced: 0,
  },
) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/referral-summary")) {
      return new Response(JSON.stringify({ referralCount, referralGoal, ...standing }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.includes("/cohort-quality")) {
      return new Response(JSON.stringify({ id: "wls_public", version: 2, status: "saved" }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ items: [] }), { headers: { "Content-Type": "application/json" } });
  });
}

function cohortQualityCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls
    .filter(([input]) => String(input).includes("/cohort-quality"))
    .map(([, init]) => JSON.parse(String((init as RequestInit).body)));
}

describe("waitlist success page", () => {
  it("renders the confirmation, referral link, and progress toward founding status", async () => {
    vi.stubGlobal("fetch", stubFetch(1));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);

    expect(screen.getByRole("heading", { name: "You are on the list" })).toBeTruthy();
    // The share link carries a referral UTM channel so referred signups land
    // as a distinct row in campaign channel attribution (#4070).
    expect(
      screen.getByDisplayValue("https://chasesets.com/?ref=wls_public&utm_source=referral&utm_medium=waitlist_share"),
    ).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText("1 of 3")).toBeTruthy();
    });
  });

  it("shows the real queue position and referral advancement from the read model (#4070)", async () => {
    vi.stubGlobal("fetch", stubFetch(2, 3, { queuePosition: 41, totalSignups: 120, positionsAdvanced: 12 }));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);

    await waitFor(() => {
      expect(screen.getByText("You're #41 of 120 in the beta invite line.")).toBeTruthy();
    });
    expect(screen.getByText("Up 12 in line thanks to your referrals.")).toBeTruthy();
    expect(screen.queryByText("Your place in line is updating. Check back in a moment.")).toBeNull();
  });

  it("shows a pending place in line instead of a fake number while the projection catches up", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);

    expect(screen.getByText("Your place in line is updating. Check back in a moment.")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText("0 of 3")).toBeTruthy();
    });
    expect(screen.queryByText(/You're #\d+ of/)).toBeNull();

    // No advancement note either: a signup with no referrals has moved 0.
    expect(screen.queryByText(/thanks to your referrals/)).toBeNull();
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

  it("keeps the buyer hero assignment on signup analytics", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(
      <WaitlistSuccessPage
        signupId="wls_public"
        publicOrigin="https://chasesets.com"
        discordInviteUrl={null}
        landingExperimentVariant="seller_first_v2"
      />,
    );

    expect(window.dataLayer).toContainEqual(
      expect.objectContaining({ event: "waitlist_signup_succeeded", variant: "seller_first_v2" }),
    );
  });

  it("omits the attributed event for an unreferred signup", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);

    const events = (window.dataLayer ?? []).map((entry) => entry.event);
    expect(events).not.toContain("waitlist_signup_attributed");
  });

  it("links the founders offer terms page from the signup confirmation", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);

    const foundersLinks = screen.getAllByRole("link", { name: "Founders offer terms" });
    expect(foundersLinks.length).toBeGreaterThan(0);
    foundersLinks.forEach((link) => expect(link.getAttribute("href")).toBe("/founders"));
  });

  it("shows the wave-placement step for a seller signup with the signup's games prefilled", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(
      <WaitlistSuccessPage
        signupId="wls_public"
        publicOrigin="https://chasesets.com"
        discordInviteUrl={null}
        role="sell"
        initialGames={["pokemon"]}
      />,
    );

    expect(screen.getByText("Help us place you in the right wave")).toBeTruthy();
    const pokemonChip = screen.getByRole("button", { name: "Pokemon" });
    expect(pokemonChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("saves each wave-placement field individually the moment it changes", async () => {
    const fetchMock = stubFetch(0);
    vi.stubGlobal("fetch", fetchMock);
    window.dataLayer = [];

    render(
      <WaitlistSuccessPage
        signupId="wls_public"
        publicOrigin="https://chasesets.com"
        discordInviteUrl={null}
        role="both"
        initialGames={[]}
      />,
    );

    // Toggling a game chip saves only the games field.
    fireEvent.click(screen.getByRole("button", { name: "Magic: The Gathering" }));
    await waitFor(() => {
      expect(cohortQualityCalls(fetchMock)).toContainEqual({ games: ["magic-the-gathering"] });
    });

    // Choosing an inventory bucket saves only the inventory-size field.
    fireEvent.change(screen.getByLabelText("Approximate inventory size"), { target: { value: "2000_plus" } });
    await waitFor(() => {
      expect(cohortQualityCalls(fetchMock)).toContainEqual({ inventorySize: "2000_plus" });
    });

    // Entering a store link saves on blur with the honest has-store flag.
    const storeInput = screen.getByLabelText("Link your TCGplayer or eBay store");
    fireEvent.change(storeInput, { target: { value: "https://example-store.com/shop" } });
    fireEvent.blur(storeInput);
    await waitFor(() => {
      expect(cohortQualityCalls(fetchMock)).toContainEqual({
        hasStoreLink: true,
        storeUrl: "https://example-store.com/shop",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("Saved")).toBeTruthy();
    });

    const savedEvents = (window.dataLayer ?? []).filter((entry) => entry.event === "waitlist_cohort_field_saved");
    expect(savedEvents.length).toBe(3);
  });

  it("hides the wave-placement step for buy-intent signups and bookmarked visits without a role", async () => {
    vi.stubGlobal("fetch", stubFetch(0));
    window.dataLayer = [];

    render(
      <WaitlistSuccessPage
        signupId="wls_public"
        publicOrigin="https://chasesets.com"
        discordInviteUrl={null}
        role="buy"
      />,
    );
    expect(screen.queryByText("Help us place you in the right wave")).toBeNull();

    cleanup();
    vi.stubGlobal("fetch", stubFetch(0));

    render(<WaitlistSuccessPage signupId="wls_public" publicOrigin="https://chasesets.com" discordInviteUrl={null} />);
    expect(screen.queryByText("Help us place you in the right wave")).toBeNull();
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
