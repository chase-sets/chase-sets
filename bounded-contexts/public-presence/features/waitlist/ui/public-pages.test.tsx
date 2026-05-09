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
      name: "Finish sets. Sell cards faster.",
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

  it("sets beta notification expectations and seller fee lock terms", () => {
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
    expect(screen.getAllByText("Answer three quick questions so invites go to the collectors and sellers most likely to use the beta.").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("heading", { name: "Know seller costs before listing" }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Locked while unchanged").length).toBeGreaterThan(0);
    const priority = container.querySelector('form select[name="interests"]') as HTMLSelectElement;
    expect(priority.value).toBe("set-completion");
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
      name: "Send early access updates.",
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
