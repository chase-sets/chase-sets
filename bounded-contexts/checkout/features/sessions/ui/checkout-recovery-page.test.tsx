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

function RecoveryBoundary(props: {
  revalidationOptions?: CheckoutSessionRecoveryPageProps["revalidationOptions"];
  nullKind?: boolean;
}) {
  const error = useRouteError();
  const location = useLocation();

  if (!isRouteErrorResponse(error) || !isCheckoutRecovery(error.data)) {
    throw error;
  }

  const recovery = error.data;
  return (
    <CheckoutSessionRecoveryPage
      kind={props.nullKind ? null : recovery.kind}
      title={props.nullKind ? "Checkout recovery" : recovery.title}
      description={props.nullKind ? "The checkout needs attention." : recovery.description}
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

async function withHydratedCheckoutRecovery(
  options: {
    initialPath: string;
    loader: (args: { request: Request }) => unknown;
    revalidationOptions?: CheckoutSessionRecoveryPageProps["revalidationOptions"];
    nullKind?: boolean;
  },
  inspect: (dom: {
    container: HTMLDivElement;
    section: Element;
    description: Element;
    status: Element;
    router: ReturnType<typeof createMemoryRouter>;
  }) => Promise<void>,
) {
  const consoleError = vi.spyOn(console, "error");
  const consoleWarn = vi.spyOn(console, "warn");
  const recoverableErrors: unknown[] = [];
  const routes = [
    {
      id: "checkout-session",
      path: "/checkout/buy/session/:sessionId",
      loader: options.loader,
      Component: ReadyCheckoutPage,
      ErrorBoundary: () => (
        <RecoveryBoundary revalidationOptions={options.revalidationOptions} nullKind={options.nullKind} />
      ),
    },
  ];
  const serverRouter = createMemoryRouter(routes, { initialEntries: [options.initialPath] });
  let clientRouter: ReturnType<typeof createMemoryRouter> | undefined;
  let root: ReturnType<typeof hydrateRoot> | undefined;
  const container = document.createElement("div");

  try {
    if (!serverRouter.state.initialized) {
      await new Promise<void>((resolve) => {
        const unsubscribe = serverRouter.subscribe((state) => {
          if (state.initialized) {
            unsubscribe();
            resolve();
          }
        });
      });
    }
    container.innerHTML = renderToString(<RouterProvider router={serverRouter} />);
    const section = container.querySelector("section.grid.rounded-tokenLg")!;
    const description = container.querySelector(".m-0.mx-auto.max-w-xl.text-sm.leading-6.text-secondary")!;
    const status = container.querySelector('[role="status"]')!;
    expect(section).not.toBeNull();
    expect(description).not.toBeNull();
    expect(section.querySelector("h2")?.textContent).not.toBe("");
    expect(section.textContent).not.toBe("");
    expect(section.querySelectorAll("a").length).toBeGreaterThan(0);
    expect(status).not.toBeNull();
    expect(status.textContent).toBe("");
    document.body.append(container);

    clientRouter = createMemoryRouter(routes, {
      initialEntries: [options.initialPath],
      hydrationData: {
        loaderData: serverRouter.state.loaderData,
        actionData: serverRouter.state.actionData,
        errors: serverRouter.state.errors,
      },
    });
    expect(clientRouter.state.initialized).toBe(true);
    expect(clientRouter.state.location.pathname + clientRouter.state.location.search).toBe(options.initialPath);
    await act(async () => {
      root = hydrateRoot(container, <RouterProvider router={clientRouter!} />, {
        onRecoverableError: (error) => recoverableErrors.push(error),
      });
    });
    expect(recoverableErrors).toEqual([]);
    expect(container.querySelector("section.grid.rounded-tokenLg")).toBe(section);
    expect(container.querySelector(".m-0.mx-auto.max-w-xl.text-sm.leading-6.text-secondary")).toBe(description);
    expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(description.contains(status)).toBe(true);
    expect(description.textContent).not.toBe("");

    await inspect({ container, section, description, status, router: clientRouter });
    expect(recoverableErrors).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
    expect(
      consoleWarn.mock.calls.filter((args) => /hydrat|nest|descendant|did not match/i.test(args.join(" "))),
    ).toEqual([]);
  } finally {
    try {
      await act(async () => root?.unmount());
    } finally {
      clientRouter?.dispose();
      serverRouter.dispose();
      container.remove();
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  }
}

describe("CheckoutSessionRecoveryPage", () => {
  const recoveryKinds = {
    "access-required": true,
    "attempt-changed": true,
    "cart-empty": true,
    "checkout-closed": true,
    "checkout-handoff-expired": true,
    "checkout-preparing": true,
    "guest-access-expired": true,
    "request-validation": true,
    "session-not-found": true,
    "wrong-account": true,
  } satisfies Record<CheckoutRecoveryKind, true>;
  const hydrationCases = [
    ...Object.keys(recoveryKinds).map((kind) => ({ kind: kind as CheckoutRecoveryKind | null, receipt: "none" })),
    { kind: null, receipt: "none" },
    { kind: "checkout-preparing" as const, receipt: "active" },
    { kind: "checkout-preparing" as const, receipt: "expired" },
    { kind: "checkout-preparing" as const, receipt: "exhausted" },
  ];

  it.each(hydrationCases)("hydrates parsed SSR for $kind with $receipt receipt", async ({ kind, receipt }) => {
    const nowMs = Date.now();
    const path = "/checkout/buy/session/chk_ssr";
    const currentPath =
      receipt === "none"
        ? path
        : appendFreshWriteToken(path, checkoutCommit(), nowMs - (receipt === "expired" ? 31_000 : 0));
    const recovery = checkoutRecoveryForKind(kind ?? "session-not-found", currentPath);
    await withHydratedCheckoutRecovery(
      {
        initialPath: currentPath,
        loader: ({ request }) => {
          expect(new URL(request.url).pathname + new URL(request.url).search).toBe(currentPath);
          throw createCheckoutRecoveryResponse(recovery);
        },
        nullKind: kind === null,
        revalidationOptions: {
          intervalMs: 60_000,
          maxRevalidations: receipt === "exhausted" ? 0 : 15,
          nowMs: () => nowMs,
        },
      },
      async ({ section, description, status }) => {
        expect(section.querySelector("h2")?.textContent).toBe(kind === null ? "Checkout recovery" : recovery.title);
        expect(description.textContent).toBe(
          receipt === "active"
            ? "We are getting your checkout ready. This page checks again automatically and opens checkout as soon as it is ready."
            : kind === null
              ? "The checkout needs attention."
              : recovery.description,
        );
        expect(status.textContent).toBe(receipt === "active" ? description.textContent : "");
        for (const action of [recovery.primaryAction, recovery.secondaryAction].filter(
          (action) => action !== undefined,
        )) {
          expect(
            Array.from(section.querySelectorAll("a")).some(
              (link) => link.textContent?.trim() === action.label && link.getAttribute("href") === action.href,
            ),
          ).toBe(true);
        }
        expect(section.textContent).toContain(recovery.trustCue);
      },
    );
  });

  it.each(["budget", "expiry", "pay-ready"] as const)(
    "retains the hydrated status through automatic start and %s settlement",
    async (settlement) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const startMs = Date.now();
      let nowMs = startMs;
      let loaderCalls = 0;
      const currentPath = appendFreshWriteToken("/checkout/buy/session/chk_hydrated", checkoutCommit(), startMs);
      const receiptStates: string[] = [];
      try {
        await withHydratedCheckoutRecovery(
          {
            initialPath: currentPath,
            loader: ({ request }) => {
              loaderCalls += 1;
              expect(new URL(request.url).pathname + new URL(request.url).search).toBe(currentPath);
              const receiptState = readFreshWriteTokenState(request.url, nowMs).kind;
              receiptStates.push(receiptState);
              if (settlement === "pay-ready" && loaderCalls > 1) return { sessionId: "chk_hydrated" };
              throw createCheckoutRecoveryResponse(
                checkoutRecoveryForKind(
                  receiptState === "expired" ? "checkout-handoff-expired" : "checkout-preparing",
                  currentPath,
                ),
              );
            },
            revalidationOptions: { intervalMs: 20, maxRevalidations: 2, nowMs: () => nowMs },
          },
          async ({ container, section, description, status, router }) => {
            expect(loaderCalls).toBe(1);
            expect(status.textContent).toContain("checks again automatically");
            if (settlement === "expiry") nowMs = startMs + 31_000;
            await act(async () => {
              await vi.advanceTimersByTimeAsync(20);
            });
            expect(loaderCalls).toBe(2);
            expect(router.state.navigation.state).toBe("idle");
            if (settlement === "budget") {
              expect(container.querySelector('[role="status"]')).toBe(status);
              expect(status.textContent).toContain("checks again automatically");
              await act(async () => {
                await vi.advanceTimersByTimeAsync(40);
              });
              expect(loaderCalls).toBe(3);
            }
            if (settlement === "pay-ready") {
              expect(container.textContent).toContain("pay-ready:chk_hydrated");
              expect(container.querySelector('[role="status"]')).toBeNull();
              expect(container.contains(section)).toBe(false);
            } else {
              expect(container.querySelector("section.grid.rounded-tokenLg")).toBe(section);
              expect(container.querySelector(".m-0.mx-auto.max-w-xl.text-sm.leading-6.text-secondary")).toBe(
                description,
              );
              expect(container.querySelectorAll('[role="status"]')).toHaveLength(1);
              expect(container.querySelector('[role="status"]')).toBe(status);
              expect(status.textContent).toBe("");
              const recovery = checkoutRecoveryForKind(
                settlement === "expiry" ? "checkout-handoff-expired" : "checkout-preparing",
                currentPath,
              );
              expect(description.textContent).toBe(recovery.description);
              expect(section.textContent).toContain(recovery.primaryAction.label);
            }
            expect(receiptStates).toEqual(
              settlement === "expiry"
                ? ["valid", "expired"]
                : settlement === "budget"
                  ? ["valid", "valid", "valid"]
                  : ["valid", "valid"],
            );
            const settledLoaderCalls = loaderCalls;
            await act(async () => {
              await vi.advanceTimersByTimeAsync(120);
            });
            expect(loaderCalls).toBe(settledLoaderCalls);
          },
        );
      } finally {
        vi.useRealTimers();
      }
    },
  );

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
