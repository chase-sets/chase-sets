import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { PublicPresenceHomePage } from "./public-pages";

const source = {
  pagePath: "/",
  referrer: null,
  utmSource: null,
  utmMedium: null,
  utmCampaign: null,
  utmContent: null,
  utmTerm: null,
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("public presence homepage", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the product promise and hides Discord when no invite is configured", () => {
    render(
      <MemoryRouter>
        <PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole("heading", {
        name: "Sell cards without giving up margin.",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Join the founders circle on Discord" })).toBeNull();
  });

  it("renders an index-route-aware waitlist form target", () => {
    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />
      </MemoryRouter>,
    );

    expect(container.querySelector("form")?.getAttribute("action")).toBe("?index");
  });

  it("sets beta notification expectations and sales fee lock terms", () => {
    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("form")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Join the beta waitlist" }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "Answer three quick questions so early invites reach the accounts most likely to use the beta.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("heading", { name: "A concrete reason for sellers to join early" }).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByRole("heading", { name: "First signups get Founding Account status" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "A visible reason to be first" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Pick the workflow you want prioritized" }).length).toBeGreaterThan(
      0,
    );
    expect(screen.getAllByRole("heading", { name: "Make set completion feel predictable" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Trust and status before early access" }).length).toBeGreaterThan(0);
    expect(
      screen.getAllByText("Prelaunch only. Joining does not require buying, listing, or payment.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("No live marketplace transactions are available during prelaunch.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "Built for cards other marketplaces make hard to sell profitably: seller fee locks, no separate seller processing line, repeat listing work, and buyer-visible order costs.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "The first accounts to sign up get a Founding Account badge and founders circle access on Discord.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(
        "The first accounts to sign up get a Founding Account badge displayed beside their marketplace account.",
      ).length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("First signups get a Founding Account badge plus founders circle access on Discord.").length,
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText("No separate 2.9% plus $0.30 payment-processing line for sellers").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("$13.20 plus quoted processing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Quoted before payment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.48 tracked shipping").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-$4.17 applied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$83.88").length).toBeGreaterThan(0);
    const priorities = [...container.querySelectorAll('form select[name="interests"]')] as HTMLSelectElement[];
    expect(priorities.map((priority) => priority.value)).toEqual(["low-sales-fees"]);
    expect(container.querySelector('[id="waitlist-form"]')).toBeTruthy();
  });

  it("lets visitors choose a hero intent before submitting the compact form", async () => {
    const user = userEvent.setup();
    const events: unknown[] = [];
    window.addEventListener("chase-sets:waitlist-analytics", (event) => {
      events.push((event as CustomEvent).detail);
    });

    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />
      </MemoryRouter>,
    );

    await user.click(screen.getAllByRole("tab", { name: "Buy" })[0]);

    const heroForm = container.querySelector("#waitlist-form form");
    expect((heroForm as HTMLElement).querySelector<HTMLInputElement>('input[name="role"]')?.value).toBe("buy");
    expect((heroForm as HTMLElement).querySelector<HTMLInputElement>('input[name="interests"]')?.value).toBe(
      "set-completion",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "waitlist_role_selected",
        role: "buy",
        interest: "set-completion",
        section: "hero",
      }),
    );
  });

  it("prefills the final form from audience-path CTAs and emits analytics", async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const events: unknown[] = [];
    window.addEventListener("chase-sets:waitlist-analytics", (event) => {
      events.push((event as CustomEvent).detail);
    });

    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />
      </MemoryRouter>,
    );

    await user.click(screen.getAllByRole("link", { name: "Join early access" })[0]);
    await user.click(screen.getByRole("button", { name: "I plan to buy cards" }));

    const finalForm = container.querySelector("#waitlist-form-final form");
    expect(finalForm).toBeTruthy();
    expect((finalForm as HTMLElement).querySelector<HTMLSelectElement>('select[name="role"]')?.value).toBe("buy");
    expect((finalForm as HTMLElement).querySelector<HTMLSelectElement>('select[name="interests"]')?.value).toBe(
      "set-completion",
    );
    expect(scrollIntoView).toHaveBeenCalledOnce();
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "cta_clicked",
        role: "buy",
        interest: "set-completion",
        section: "audience_path_buyer",
      }),
    );

    const consent = within(finalForm as HTMLElement).getByRole("checkbox", {
      name: "Email me early access updates.",
    });
    await user.click(consent);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "cta_clicked",
        section: "nav",
        target: "waitlist_form",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        checked: true,
        event: "waitlist_consent_checked",
        interest: "set-completion",
        role: "buy",
        section: "final_cta",
      }),
    );
  });

  it("checks email consent and includes consent in the waitlist submission", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage actionData={null} discordInviteUrl={null} source={source} />
      </MemoryRouter>,
    );

    const form = container.querySelector("form");
    expect(form).toBeTruthy();

    const consent = within(form as HTMLElement).getByRole("checkbox", {
      name: "Email me early access updates.",
    }) as HTMLInputElement;

    expect(consent.checked).toBe(false);
    expect(form?.querySelector('input[name="emailConsent"]')?.getAttribute("value")).toBe("yes");

    await user.click(consent);

    expect(consent.checked).toBe(true);
    expect(form?.querySelector('input[name="emailConsent"]')?.getAttribute("value")).toBe("yes");
  });

  it("shows Discord and inline success when configured", () => {
    render(
      <MemoryRouter>
        <PublicPresenceHomePage
          actionData={{ status: "joined" }}
          discordInviteUrl="https://discord.example/invite"
          source={source}
        />
      </MemoryRouter>,
    );

    const discordLinks = screen.getAllByRole("link", { name: "Join the founders circle on Discord" });
    expect(discordLinks.map((link) => link.getAttribute("href"))).toEqual(["https://discord.example/invite"]);
    expect(discordLinks.map((link) => link.getAttribute("target"))).toEqual(["_blank"]);
    expect(discordLinks.map((link) => link.getAttribute("rel"))).toEqual(["noopener noreferrer"]);
    expect(screen.getAllByText("You are on the list").length).toBeGreaterThan(0);
  });
});
