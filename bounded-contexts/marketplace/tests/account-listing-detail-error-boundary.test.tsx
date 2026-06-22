// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { ListingDetailErrorBoundary } from "../features/listings/ui/listing-detail-error-boundary";

afterEach(() => {
  cleanup();
});

function renderListingRecovery(
  response: Response = new Response("We're preparing your listing details. Try again in a moment.", {
    status: 503,
    statusText: "Preparing listing",
  }),
) {
  const router = createMemoryRouter(
    [
      {
        path: "/account/listings/:listingId",
        loader: () => {
          throw response;
        },
        Component: () => <div>Listing loaded</div>,
        ErrorBoundary: ListingDetailErrorBoundary,
      },
    ],
    {
      initialEntries: ["/account/listings/lst_pending?feedbackWorkflow=listing-publish&afterWrite=fresh"],
    },
  );

  render(<RouterProvider router={router} />);
}

describe("Marketplace listing detail recovery boundary", () => {
  it("renders listing freshness recovery instead of falling through to the root 503 page", async () => {
    renderListingRecovery();

    expect(await screen.findAllByText("Preparing listing")).not.toHaveLength(0);
    expect(screen.getAllByText("We're preparing your listing details. Try again in a moment.")).not.toHaveLength(0);
    expect(screen.getByText("Your listing action is saved while these details finish updating.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Refresh listing" }).getAttribute("href")).toBe(
      "/account/listings/lst_pending?feedbackWorkflow=listing-publish&afterWrite=fresh",
    );
    expect(screen.queryByText("Marketplace error")).toBeNull();
  });

  it("renders listing freshness recovery when production normalizes the response status text", async () => {
    renderListingRecovery(
      new Response("We're preparing your listing details. Try again in a moment.", {
        status: 503,
        statusText: "Service Unavailable",
      }),
    );

    expect(await screen.findAllByText("Preparing listing")).not.toHaveLength(0);
    expect(screen.queryByText("Marketplace error")).toBeNull();
  });
});
