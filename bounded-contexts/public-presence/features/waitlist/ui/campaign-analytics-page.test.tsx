import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CampaignAnalyticsPage } from "./campaign-analytics-page";
import type { CampaignAnalyticsSnapshot } from "../api/contracts";

function buildSnapshot(overrides: Partial<CampaignAnalyticsSnapshot> = {}): CampaignAnalyticsSnapshot {
  return {
    quality: {
      totalSignups: 120,
      sellerSignupCount: 40,
      qualifiedSellerCount: 12,
      storeLinkCount: 10,
      storeLinkPercent: 25,
      inventorySizeDistribution: {
        under_100: 5,
        "100_to_500": 4,
        "500_to_2000": 2,
        "2000_plus": 1,
      },
      qualifiedSellersByGame: {
        pokemon: 8,
        "magic-the-gathering": 3,
        "yu-gi-oh": 1,
        "disney-lorcana": 0,
        "one-piece-card-game": 0,
      },
    },
    channelAttribution: [
      {
        utm_source: "twitter",
        utm_medium: "social",
        utm_campaign: "wave1",
        signup_count: 40,
        seller_signup_count: 10,
        qualified_seller_count: 6,
      },
      {
        utm_source: null,
        utm_medium: null,
        utm_campaign: null,
        signup_count: 5,
        seller_signup_count: 1,
        qualified_seller_count: 0,
      },
    ],
    admissionBar: {
      totalSignups: 120,
      qualifiedSellerCount: 12,
      totalSignupsMet: false,
      qualifiedSellersMet: false,
      gameCoverage: [
        { game: "pokemon", qualifiedSellerCount: 8, covered: true },
        { game: "magic-the-gathering", qualifiedSellerCount: 3, covered: false },
        { game: "yu-gi-oh", qualifiedSellerCount: 1, covered: false },
        { game: "disney-lorcana", qualifiedSellerCount: 0, covered: false },
        { game: "one-piece-card-game", qualifiedSellerCount: 0, covered: false },
      ],
      allGamesCovered: false,
      admitted: false,
    },
    ...overrides,
  };
}

describe("campaign analytics page", () => {
  it("renders admission-bar status, quality stats, game coverage, and channel attribution", () => {
    render(
      <CampaignAnalyticsPage
        analytics={buildSnapshot()}
        funnelDashboardHref="/grafana/d/chase-sets-public-presence-waitlist/public-presence-waitlist-funnel"
      />,
    );

    expect(screen.getByRole("heading", { name: "Campaign Analytics" })).toBeTruthy();
    expect(screen.getByText("Wave 1 bar not yet met")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Game" })).toBeTruthy();
    expect(screen.getAllByText("Pokemon").length).toBeGreaterThan(0);
    expect(screen.getAllByText("twitter / social / wave1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Direct / no UTM").length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "Open the funnel dashboard in Grafana" }).getAttribute("href")).toBe(
      "/grafana/d/chase-sets-public-presence-waitlist/public-presence-waitlist-funnel",
    );
  });

  it("shows the admitted badge once every sub-condition clears the bar", () => {
    render(
      <CampaignAnalyticsPage
        analytics={buildSnapshot({
          admissionBar: {
            totalSignups: 500,
            qualifiedSellerCount: 50,
            totalSignupsMet: true,
            qualifiedSellersMet: true,
            gameCoverage: [
              { game: "pokemon", qualifiedSellerCount: 5, covered: true },
              { game: "magic-the-gathering", qualifiedSellerCount: 5, covered: true },
              { game: "yu-gi-oh", qualifiedSellerCount: 5, covered: true },
              { game: "disney-lorcana", qualifiedSellerCount: 5, covered: true },
              { game: "one-piece-card-game", qualifiedSellerCount: 5, covered: true },
            ],
            allGamesCovered: true,
            admitted: true,
          },
        })}
        funnelDashboardHref="/grafana"
      />,
    );

    expect(screen.getAllByText("Wave 1 bar met").length).toBeGreaterThan(0);
  });
});
