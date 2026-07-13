// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { appendFreshWriteToken } from "@chase-sets/http/responses";
import {
  MarketplaceOfferDetailRecoveryPage,
  SubmittedOfferDetailErrorBoundary,
} from "../features/offers/ui/offer-detail-error-boundary";

afterEach(() => {
  cleanup();
});

function freshSubmittedOfferPath(nowMs = Date.now()) {
  return appendFreshWriteToken(
    "/account/offers/submitted/off_pending",
    {
      commitPositions: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "42",
          eventIds: ["evt_offer"],
        },
      ],
      commitEventIds: ["evt_offer"],
    },
    nowMs,
  );
}

function freshOfferMatchPath(nowMs = Date.now()) {
  return appendFreshWriteToken(
    "/account/offers/matches/off_pending",
    {
      commitPositions: [
        {
          sourceContextName: "marketplace",
          maxGlobalPosition: "42",
          eventIds: ["evt_offer_accepted"],
        },
      ],
      commitEventIds: ["evt_offer_accepted"],
    },
    nowMs,
  );
}

function renderSubmittedOfferRecovery(
  response: Response = new Response("We're preparing your submitted offer details. Try again in a moment.", {
    status: 503,
    statusText: "Preparing submitted offer",
  }),
  initialEntry = freshSubmittedOfferPath(),
) {
  const router = createMemoryRouter(
    [
      {
        path: "/account/offers/submitted/:offerId",
        loader: () => {
          throw response;
        },
        Component: () => <div>Submitted offer loaded</div>,
        ErrorBoundary: SubmittedOfferDetailErrorBoundary,
      },
    ],
    {
      initialEntries: [initialEntry],
    },
  );

  render(<RouterProvider router={router} />);
}

describe("Marketplace offer detail recovery boundary", () => {
  it("renders submitted-offer freshness recovery as normal route content", () => {
    const currentPath = freshSubmittedOfferPath(1_000);

    render(<MarketplaceOfferDetailRecoveryPage kind="submitted-offer" currentPath={currentPath} />);

    expect(screen.getAllByText("Preparing submitted offer")).not.toHaveLength(0);
    expect(
      screen.getAllByText("We're preparing your submitted offer details. Try again in a moment."),
    ).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: "Refresh offer" }).getAttribute("href")).toBe(currentPath);
  });

  it("renders offer-match freshness recovery as normal route content", () => {
    const currentPath = freshOfferMatchPath(1_000);

    render(<MarketplaceOfferDetailRecoveryPage kind="offer-match" currentPath={currentPath} />);

    expect(screen.getAllByText("Preparing offer match")).not.toHaveLength(0);
    expect(screen.getAllByText("We're preparing your offer match details. Try again in a moment.")).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: "Refresh offer" }).getAttribute("href")).toBe(currentPath);
  });

  it("renders submitted-offer freshness recovery instead of falling through to the root 503 page", async () => {
    renderSubmittedOfferRecovery();

    expect(await screen.findAllByText("Preparing submitted offer")).not.toHaveLength(0);
    expect(
      screen.getAllByText("We're preparing your submitted offer details. Try again in a moment."),
    ).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: "Refresh offer" }).getAttribute("href")).toContain("afterWrite=");
    expect(screen.queryByText("Marketplace error")).toBeNull();
  });

  it("renders submitted-offer freshness recovery when production normalizes the response status text", async () => {
    renderSubmittedOfferRecovery(
      new Response("We're preparing your submitted offer details. Try again in a moment.", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    expect(await screen.findAllByText("Preparing submitted offer")).not.toHaveLength(0);
    expect(screen.queryByText("Marketplace error")).toBeNull();
  });
});
