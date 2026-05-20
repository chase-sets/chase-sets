import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
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

describe("public presence homepage", () => {
  it("renders the product promise and hides Discord when no invite is configured", () => {
    render(
      <MemoryRouter>
        <PublicPresenceHomePage
          actionData={null}
          discordInviteUrl={null}
          source={source}
        />
      </MemoryRouter>,
    );

    expect(screen.getByRole("heading", {
      name: "Finish sets. Keep more card margin.",
    })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Join Discord" })).toBeNull();
  });

  it("renders an index-route-aware waitlist form target", () => {
    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage
          actionData={null}
          discordInviteUrl={null}
          source={source}
        />
      </MemoryRouter>,
    );

    expect(container.querySelector("form")?.getAttribute("action")).toBe("?index");
  });

  it("sets beta notification expectations and sales fee lock terms", () => {
    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage
          actionData={null}
          discordInviteUrl={null}
          source={source}
        />
      </MemoryRouter>,
    );

    expect(container.querySelectorAll("form")).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Join the waitlist" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Answer three quick questions so early invites reach the accounts most likely to use the beta.").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "A concrete reason for sellers to join early" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Lock 0% seller fees on beta listings" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Start with the job you care about" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Make set completion feel predictable" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Built for cards other marketplaces make hard to sell profitably: seller fee locks, no separate seller processing line, and buyer-visible order costs.").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Beta listings keep 0% seller fees until sold while unchanged").length).toBeGreaterThan(0);
    expect(screen.getAllByText("No separate 2.9% plus $0.30 payment-processing line for sellers").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$13.20 plus quoted processing").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Quoted before payment").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$0.48 tracked shipping").length).toBeGreaterThan(0);
    expect(screen.getAllByText("-$4.17 applied").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$83.88").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Locked while unchanged").length).toBeGreaterThan(0);
    const priorities = [...container.querySelectorAll('form select[name="interests"]')] as HTMLSelectElement[];
    expect(priorities.map((priority) => priority.value)).toEqual([
      "low-sales-fees",
      "low-sales-fees",
    ]);
    expect(container.querySelector('[id="waitlist-form"]')).toBeTruthy();
  });

  it("checks email consent and includes consent in the waitlist submission", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <PublicPresenceHomePage
          actionData={null}
          discordInviteUrl={null}
          source={source}
        />
      </MemoryRouter>,
    );

    const form = container.querySelector("form");
    expect(form).toBeTruthy();

    const consent = within(form as HTMLElement).getByRole("checkbox", {
      name: "Email me early access updates.",
    }) as HTMLInputElement;

    expect(consent.checked).toBe(false);
    expect(form?.querySelector('input[name="emailConsent"]')).toBeNull();

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

    const discordLinks = screen.getAllByRole("link", { name: "Join Discord" });
    expect(discordLinks.map((link) => link.getAttribute("href"))).toEqual([
      "https://discord.example/invite",
    ]);
    expect(discordLinks.map((link) => link.getAttribute("target"))).toEqual([
      "_blank",
    ]);
    expect(discordLinks.map((link) => link.getAttribute("rel"))).toEqual([
      "noopener noreferrer",
    ]);
    expect(screen.getAllByText("You are on the list").length).toBeGreaterThan(0);
  });
});
