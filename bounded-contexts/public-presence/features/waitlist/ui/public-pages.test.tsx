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
      name: "Buy and sell trading cards with better incentives",
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
      name: "Email me Chase Sets updates and early access information.",
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

    expect(screen.getAllByRole("link", { name: "Join Discord" }).map((link) => link.getAttribute("href"))).toEqual([
      "https://discord.example/invite",
      "https://discord.example/invite",
    ]);
    expect(screen.getAllByRole("link", { name: "Join Discord" }).map((link) => link.getAttribute("target"))).toEqual([
      "_blank",
      "_blank",
    ]);
    expect(screen.getAllByRole("link", { name: "Join Discord" }).map((link) => link.getAttribute("rel"))).toEqual([
      "noopener noreferrer",
      "noopener noreferrer",
    ]);
    expect(screen.getByText("You are on the waitlist")).toBeTruthy();
  });
});
