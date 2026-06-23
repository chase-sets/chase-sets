// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import {
  MarketplaceOfferDetailRecoveryPage,
  SubmittedOfferDetailErrorBoundary,
} from "../features/offers/ui/offer-detail-error-boundary";

afterEach(() => {
  cleanup();
});

function renderSubmittedOfferRecovery(
  response: Response = new Response("We're preparing your submitted offer details. Try again in a moment.", {
    status: 503,
    statusText: "Preparing submitted offer",
  }),
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
      initialEntries: ["/account/offers/submitted/off_pending?feedbackWorkflow=offer-submit&afterWrite=fresh"],
    },
  );

  render(<RouterProvider router={router} />);
}

describe("Marketplace offer detail recovery boundary", () => {
  it("renders submitted-offer freshness recovery as normal route content", () => {
    render(
      <MarketplaceOfferDetailRecoveryPage
        kind="submitted-offer"
        currentPath="/account/offers/submitted/off_pending?feedbackWorkflow=offer-submit&afterWrite=fresh"
      />,
    );

    expect(screen.getAllByText("Preparing submitted offer")).not.toHaveLength(0);
    expect(
      screen.getAllByText("We're preparing your submitted offer details. Try again in a moment."),
    ).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: "Refresh offer" }).getAttribute("href")).toBe(
      "/account/offers/submitted/off_pending?feedbackWorkflow=offer-submit&afterWrite=fresh",
    );
  });

  it("renders offer-match freshness recovery as normal route content", () => {
    render(
      <MarketplaceOfferDetailRecoveryPage
        kind="offer-match"
        currentPath="/account/offers/matches/off_pending?feedbackWorkflow=offer-accept&afterWrite=fresh"
      />,
    );

    expect(screen.getAllByText("Preparing offer match")).not.toHaveLength(0);
    expect(screen.getAllByText("We're preparing your offer match details. Try again in a moment.")).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: "Refresh offer" }).getAttribute("href")).toBe(
      "/account/offers/matches/off_pending?feedbackWorkflow=offer-accept&afterWrite=fresh",
    );
  });

  it("renders submitted-offer freshness recovery instead of falling through to the root 503 page", async () => {
    renderSubmittedOfferRecovery();

    expect(await screen.findAllByText("Preparing submitted offer")).not.toHaveLength(0);
    expect(
      screen.getAllByText("We're preparing your submitted offer details. Try again in a moment."),
    ).not.toHaveLength(0);
    expect(screen.getByRole("link", { name: "Refresh offer" }).getAttribute("href")).toBe(
      "/account/offers/submitted/off_pending?feedbackWorkflow=offer-submit&afterWrite=fresh",
    );
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
