// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { SubmittedOfferDetailErrorBoundary } from "../features/offers/ui/offer-detail-error-boundary";

afterEach(() => {
  cleanup();
});

function renderSubmittedOfferRecovery() {
  const router = createMemoryRouter(
    [
      {
        path: "/account/offers/submitted/:offerId",
        loader: () => {
          throw new Response("We're preparing your submitted offer details. Try again in a moment.", {
            status: 503,
            statusText: "Preparing submitted offer",
          });
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
});
