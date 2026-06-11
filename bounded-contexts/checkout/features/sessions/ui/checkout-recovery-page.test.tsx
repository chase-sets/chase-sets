// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  createMemoryRouter,
  isRouteErrorResponse,
  RouterProvider,
  useLoaderData,
  useLocation,
  useRouteError,
} from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { appendFreshWriteToken, readFreshWriteTokenState } from "@chase-sets/http/responses";
import {
  checkoutRecoveryForKind,
  createCheckoutRecoveryResponse,
  isCheckoutRecovery,
} from "../../../support/request-support/checkout-recovery";
import { ErrorBoundary as CheckoutSessionRouteErrorBoundary } from "../../../routes/checkout-session";
import { CheckoutSessionRecoveryPage, type CheckoutSessionRecoveryPageProps } from "./checkout-recovery-page";

afterEach(() => {
  cleanup();
});

function checkoutCommit() {
  return {
    commitPosition: "42",
    commitEventIds: ["evt_checkout"],
    commitPositions: [
      {
        sourceContextName: "checkout",
        maxGlobalPosition: "42",
        eventIds: ["evt_checkout"],
      },
    ],
  };
}

function ReadyCheckoutPage() {
  const data = useLoaderData() as { sessionId: string };
  return <h1>{`pay-ready:${data.sessionId}`}</h1>;
}

function RecoveryBoundary(props: { revalidationOptions?: CheckoutSessionRecoveryPageProps["revalidationOptions"] }) {
  const error = useRouteError();
  const location = useLocation();

  if (!isRouteErrorResponse(error) || !isCheckoutRecovery(error.data)) {
    throw error;
  }

  const recovery = error.data;
  return (
    <CheckoutSessionRecoveryPage
      kind={recovery.kind}
      title={recovery.title}
      description={recovery.description}
      trustCue={recovery.trustCue}
      primaryAction={recovery.primaryAction}
      secondaryAction={recovery.secondaryAction ?? null}
      currentPath={`${location.pathname}${location.search}`}
      revalidationOptions={props.revalidationOptions}
    />
  );
}

function renderCheckoutSessionRoute(options: {
  initialPath: string;
  loader: (args: { request: Request }) => unknown;
  revalidationOptions?: CheckoutSessionRecoveryPageProps["revalidationOptions"];
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/checkout/:sessionId",
        loader: options.loader,
        Component: ReadyCheckoutPage,
        ErrorBoundary: () => <RecoveryBoundary revalidationOptions={options.revalidationOptions} />,
      },
    ],
    { initialEntries: [options.initialPath] },
  );

  render(<RouterProvider router={router} />);
  return router;
}

describe("CheckoutSessionRecoveryPage", () => {
  it("revalidates the preparing recovery automatically until checkout becomes pay-ready", async () => {
    const currentPath = appendFreshWriteToken("/checkout/chk_happy", checkoutCommit());
    let loaderCalls = 0;
    renderCheckoutSessionRoute({
      initialPath: currentPath,
      loader: () => {
        loaderCalls += 1;
        if (loaderCalls < 3) {
          throw createCheckoutRecoveryResponse(checkoutRecoveryForKind("checkout-preparing", currentPath));
        }
        return { sessionId: "chk_happy" };
      },
      revalidationOptions: { intervalMs: 20 },
    });

    expect(await screen.findByText("pay-ready:chk_happy")).toBeTruthy();
    expect(screen.queryByText("Checkout session not found.")).toBeNull();
    // Slow renders can let one extra interval fire between the successful
    // load and the recovery component unmounting, so assert settlement
    // rather than an exact count: pay-ready stops all further replays.
    expect(loaderCalls).toBeGreaterThanOrEqual(3);
    const settledLoaderCalls = loaderCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBe(settledLoaderCalls);
  });

  it("degrades to the existing manual recovery when the fresh-write receipt expires", async () => {
    const startMs = Date.now();
    let nowMs = startMs;
    const currentPath = appendFreshWriteToken("/checkout/chk_expiring", checkoutCommit(), startMs);
    let loaderCalls = 0;
    renderCheckoutSessionRoute({
      initialPath: currentPath,
      loader: ({ request }) => {
        loaderCalls += 1;
        const tokenState = readFreshWriteTokenState(request.url, nowMs);
        if (tokenState.kind === "valid") {
          throw createCheckoutRecoveryResponse(checkoutRecoveryForKind("checkout-preparing", currentPath));
        }
        throw createCheckoutRecoveryResponse(checkoutRecoveryForKind("checkout-handoff-expired", currentPath));
      },
      revalidationOptions: { intervalMs: 20, nowMs: () => nowMs },
    });

    expect(await screen.findByText("Preparing checkout")).toBeTruthy();
    expect(screen.queryByText("Checkout session not found.")).toBeNull();

    nowMs = startMs + 31_000;

    expect(await screen.findByText("Checkout needs a fresh start")).toBeTruthy();
    expect(screen.getByText("View Buy Cart")).toBeTruthy();
    expect(screen.getByText("Your payment has not started.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
    expect(loaderCalls).toBeGreaterThanOrEqual(2);

    const settledLoaderCalls = loaderCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBe(settledLoaderCalls);
  });

  it("announces automatic checking in a live region while revalidating", async () => {
    const currentPath = appendFreshWriteToken("/checkout/chk_announce", checkoutCommit());
    renderCheckoutSessionRoute({
      initialPath: currentPath,
      loader: () => {
        throw createCheckoutRecoveryResponse(checkoutRecoveryForKind("checkout-preparing", currentPath));
      },
      // An interval far longer than the test keeps the hook in its
      // auto-revalidating state for the whole assertion window.
      revalidationOptions: { intervalMs: 60_000 },
    });

    expect(await screen.findByText("Preparing checkout")).toBeTruthy();
    expect(screen.getByText("Refresh checkout")).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toContain("checks again automatically");
    });
  });

  it("stops retrying after the bounded budget and keeps the manual recovery available", async () => {
    const currentPath = appendFreshWriteToken("/checkout/chk_budget", checkoutCommit());
    let loaderCalls = 0;
    renderCheckoutSessionRoute({
      initialPath: currentPath,
      loader: () => {
        loaderCalls += 1;
        throw createCheckoutRecoveryResponse(checkoutRecoveryForKind("checkout-preparing", currentPath));
      },
      revalidationOptions: { intervalMs: 20, maxRevalidations: 2 },
    });

    expect(await screen.findByText("Preparing checkout")).toBeTruthy();

    await waitFor(() => {
      expect(loaderCalls).toBe(3);
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("");
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBe(3);
    expect(screen.getByText("Preparing checkout")).toBeTruthy();
    expect(
      screen.getByText("We are getting your checkout ready. Refresh this page in a moment to continue."),
    ).toBeTruthy();
    expect(screen.getByText("Refresh checkout")).toBeTruthy();
  });

  it("renders expired and cart recovery responses through the real route error boundary", async () => {
    for (const recovery of [
      { kind: "checkout-handoff-expired" as const, expectedTitle: "Checkout needs a fresh start" },
      { kind: "cart-empty" as const, expectedTitle: "Your Buy Cart is empty" },
    ]) {
      const router = createMemoryRouter(
        [
          {
            path: "/checkout/:sessionId",
            loader: () => {
              throw createCheckoutRecoveryResponse(checkoutRecoveryForKind(recovery.kind, "/checkout/chk_real"));
            },
            Component: ReadyCheckoutPage,
            ErrorBoundary: CheckoutSessionRouteErrorBoundary,
          },
        ],
        { initialEntries: ["/checkout/chk_real"] },
      );
      render(<RouterProvider router={router} />);

      expect(await screen.findByText(recovery.expectedTitle)).toBeTruthy();
      expect(screen.queryByText("Marketplace error")).toBeNull();
      cleanup();
    }
  });
});
