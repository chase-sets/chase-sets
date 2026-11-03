// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  createMemoryRouter,
  isRouteErrorResponse,
  RouterProvider,
  useLoaderData,
  useLocation,
  useRouteError,
} from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendCompactPostWriteToken,
  appendFreshWriteToken,
  readFreshWriteTokenState,
} from "@chase-sets/http/responses";
import {
  checkoutRecoveryForKind,
  createCheckoutRecoveryResponse,
  isCheckoutRecovery,
  type CheckoutRecoveryKind,
} from "../api/checkout-recovery";
import { ErrorBoundary as CheckoutSessionRouteErrorBoundary } from "../../../routes/checkout-session";
import { CheckoutSessionRecoveryPage, type CheckoutSessionRecoveryPageProps } from "./checkout-recovery-page";

afterEach(async () => {
  cleanup();
  // Drain React's queued scheduler work (from router navigations) while the
  // jsdom environment still exists; otherwise callbacks fire after teardown
  // and surface as unhandled "window is not defined" errors in later files.
  await new Promise((resolve) => setTimeout(resolve, 20));
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
        path: "/checkout/buy/session/:sessionId",
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
  it("hydrates every recovery kind and the null-kind fallback from parsed SSR markup", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const kinds: readonly CheckoutRecoveryKind[] = [
      "access-required",
      "attempt-changed",
      "cart-empty",
      "checkout-closed",
      "checkout-handoff-expired",
      "checkout-preparing",
      "guest-access-expired",
      "request-validation",
      "session-not-found",
      "wrong-account",
    ];

    try {
      for (const kind of [...kinds, null] as const) {
        const recovery = checkoutRecoveryForKind(kind ?? "session-not-found", "/checkout/buy/session/chk_ssr");
        const element = (
          <CheckoutSessionRecoveryPage
            kind={kind}
            title={kind === null ? "Checkout recovery" : recovery.title}
            description={kind === null ? "The checkout needs attention." : recovery.description}
            trustCue={recovery.trustCue}
            primaryAction={recovery.primaryAction}
            secondaryAction={recovery.secondaryAction ?? null}
            currentPath="/checkout/buy/session/chk_ssr"
            revalidationOptions={{ intervalMs: 60_000 }}
          />
        );
        const container = document.createElement("div");
        container.innerHTML = renderToString(element);
        const parsedSection = container.querySelector("section");
        const parsedStatus = container.querySelector('[role="status"]');
        expect(parsedSection).not.toBeNull();
        expect(parsedStatus).not.toBeNull();
        expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);

        const recoverableErrors: unknown[] = [];
        let root: ReturnType<typeof hydrateRoot> | undefined;
        await act(async () => {
          root = hydrateRoot(container, element, {
            onRecoverableError: (error) => recoverableErrors.push(error),
          });
        });

        expect(recoverableErrors).toEqual([]);
        expect(container.querySelector("section")).toBe(parsedSection);
        expect(container.querySelector('[role="status"]')).toBe(parsedStatus);
        expect(parsedStatus?.getAttribute("aria-live")).toBe("polite");
        expect(parsedStatus?.getAttribute("aria-atomic")).toBe("true");
        expect(container.querySelector("h2")?.textContent).toBe(kind === null ? "Checkout recovery" : recovery.title);
        expect(container.querySelector("a")?.textContent).toBe(recovery.primaryAction.label);
        await act(async () => {
          root?.unmount();
        });
      }
    } finally {
      expect(consoleError).not.toHaveBeenCalled();
      consoleError.mockRestore();
    }
  });

  it("revalidates the preparing recovery automatically until checkout becomes pay-ready", async () => {
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_happy", checkoutCommit());
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
    // Let any in-flight route replay settle, then prove the recovery page
    // stopped scheduling once the checkout became pay-ready.
    expect(loaderCalls).toBeGreaterThanOrEqual(3);
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBeGreaterThanOrEqual(3);
    const settledLoaderCalls = loaderCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBe(settledLoaderCalls);
  });

  it("revalidates compact post-write recovery until checkout becomes pay-ready", async () => {
    const currentPath = appendCompactPostWriteToken(
      "/checkout/buy/session/chk_compact?paymentMethodCategory=card&review=updated&resumePaymentStart=1",
      "pwt_test000000000001",
    );
    let loaderCalls = 0;
    renderCheckoutSessionRoute({
      initialPath: currentPath,
      loader: () => {
        loaderCalls += 1;
        if (loaderCalls < 3) {
          throw createCheckoutRecoveryResponse(checkoutRecoveryForKind("checkout-preparing", currentPath));
        }
        return { sessionId: "chk_compact" };
      },
      revalidationOptions: { intervalMs: 20 },
    });

    expect(await screen.findByText("pay-ready:chk_compact")).toBeTruthy();
    expect(loaderCalls).toBeGreaterThanOrEqual(3);
  });

  it("revalidates tokenless payment-start resume recovery until checkout becomes pay-ready", async () => {
    const currentPath =
      "/checkout/buy/session/chk_resume?paymentMethodCategory=card&review=updated&resumePaymentStart=1";
    let loaderCalls = 0;
    renderCheckoutSessionRoute({
      initialPath: currentPath,
      loader: () => {
        loaderCalls += 1;
        if (loaderCalls < 3) {
          throw createCheckoutRecoveryResponse(checkoutRecoveryForKind("checkout-preparing", currentPath));
        }
        return { sessionId: "chk_resume" };
      },
      revalidationOptions: { intervalMs: 20 },
    });

    expect(await screen.findByText("pay-ready:chk_resume")).toBeTruthy();
    expect(loaderCalls).toBeGreaterThanOrEqual(3);
  });

  it("degrades to the existing manual recovery when the fresh-write receipt expires", async () => {
    const startMs = Date.now();
    let nowMs = startMs;
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_expiring", checkoutCommit(), startMs);
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
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_announce", checkoutCommit());
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
    const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_budget", checkoutCommit());
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

    // Assert settlement rather than an exact scheduler count: the bounded
    // budget stops all further replays.
    await waitFor(() => {
      expect(loaderCalls).toBeGreaterThanOrEqual(3);
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("");
    });

    const settledLoaderCalls = loaderCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBe(settledLoaderCalls);
    expect(screen.getByText("Preparing checkout")).toBeTruthy();
    expect(
      screen.getByText("We are getting your checkout ready. Refresh this page in a moment to continue."),
    ).toBeTruthy();
    expect(screen.getByText("Refresh checkout")).toBeTruthy();
  });

  it("stops compact post-write recovery after the bounded budget", async () => {
    const currentPath = appendCompactPostWriteToken(
      "/checkout/buy/session/chk_compact_budget?paymentMethodCategory=card&review=updated&resumePaymentStart=1",
      "pwt_test000000000002",
    );
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
      expect(loaderCalls).toBeGreaterThanOrEqual(3);
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("");
    });

    const settledLoaderCalls = loaderCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBe(settledLoaderCalls);
    expect(screen.getByText("Refresh checkout")).toBeTruthy();
  });

  it("stops tokenless payment-start resume recovery after the bounded budget", async () => {
    const currentPath =
      "/checkout/buy/session/chk_resume_budget?paymentMethodCategory=card&review=updated&resumePaymentStart=1";
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
      expect(loaderCalls).toBeGreaterThanOrEqual(3);
    });
    await waitFor(() => {
      expect(screen.getByRole("status").textContent).toBe("");
    });

    const settledLoaderCalls = loaderCalls;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(loaderCalls).toBe(settledLoaderCalls);
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
            path: "/checkout/buy/session/:sessionId",
            loader: () => {
              throw createCheckoutRecoveryResponse(
                checkoutRecoveryForKind(recovery.kind, "/checkout/buy/session/chk_real"),
              );
            },
            Component: ReadyCheckoutPage,
            ErrorBoundary: CheckoutSessionRouteErrorBoundary,
          },
        ],
        { initialEntries: ["/checkout/buy/session/chk_real"] },
      );
      render(<RouterProvider router={router} />);

      expect(await screen.findByText(recovery.expectedTitle)).toBeTruthy();
      expect(screen.queryByText("Marketplace error")).toBeNull();
      cleanup();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  });
});
