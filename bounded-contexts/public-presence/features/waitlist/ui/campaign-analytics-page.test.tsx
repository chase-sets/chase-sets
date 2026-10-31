import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CampaignAnalyticsPage } from "./campaign-analytics-page";
import type { CampaignAnalyticsSnapshot } from "../api/contracts";
import { WAVE_ONE_ADMISSION_BAR } from "../read-model/campaign-admission-bar-policy";

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
      goals: WAVE_ONE_ADMISSION_BAR,
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
  it("reads displayed admission goals from the analytics response", () => {
    const source = readFileSync(resolve(import.meta.dirname, "campaign-analytics-page.tsx"), "utf8");
    expect(source).not.toContain("campaign-admission-bar-policy");
    expect(source).not.toContain("WAVE_ONE_ADMISSION_BAR");
  });

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
            goals: WAVE_ONE_ADMISSION_BAR,
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

  it("uses response goals for progress values and labels", () => {
    const { container } = render(
      <CampaignAnalyticsPage
        analytics={buildSnapshot({
          admissionBar: {
            ...buildSnapshot().admissionBar,
            goals: { minTotalSignups: 240, minQualifiedSellers: 48, minQualifiedSellersPerGame: 5 },
          },
        })}
        funnelDashboardHref="/grafana"
      />,
    );

    expect(screen.getByText("120 of 240")).toBeTruthy();
    expect(screen.getByText("12 of 48")).toBeTruthy();
    const progressBars = Array.from(container.querySelectorAll<HTMLElement>("[role='progressbar']"));
    expect(progressBars[0]?.getAttribute("aria-valuenow")).toBe("50");
    expect(progressBars[1]?.getAttribute("aria-valuenow")).toBe("25");
  });
});
