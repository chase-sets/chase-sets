import { render, screen } from "@testing-library/react";
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
    expect(screen.getByText("You are on the waitlist")).toBeTruthy();
  });
});
