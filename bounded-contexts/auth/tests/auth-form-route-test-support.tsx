import { act, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import { afterEach, vi } from "vitest";
import { AuthApiError } from "../client";
import { authApiActionError, type AuthActionIntent } from "../support/route-support/auth-action-errors";
import { missingPhoneResponse } from "../support/api-support/phone-code-errors";
import type { PasskeyCredentialPayload } from "../support/ui-support/passkey-browser";

const routers = new Set<ReturnType<typeof createMemoryRouter>>();
afterEach(() => {
  for (const router of routers) router.dispose();
  routers.clear();
  vi.restoreAllMocks();
});

export function missingPhoneFailure(intent: AuthActionIntent) {
  return authApiActionError(new AuthApiError(400, missingPhoneResponse()), intent);
}

export function safeFailure(intent: AuthActionIntent, status = 401, body: unknown = { error: "RAW_AUTH_MARKER" }) {
  return authApiActionError(new AuthApiError(status, body), intent);
}

export const successfulPasskey = {
  challengeId: "synthetic-challenge-id",
  challenge: "synthetic-challenge",
  externalCredentialId: "synthetic-credential",
  label: "Synthetic passkey",
  webauthnResponse: "{}",
};

export function pendingPasskey() {
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<PasskeyCredentialPayload>((_, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject: (reason: Error) => reject(reason) };
}

export function mockNativeRequestSubmit() {
  // jsdom does not implement native requestSubmit; retain the consumer's submit event.
  return vi.spyOn(HTMLFormElement.prototype, "requestSubmit").mockImplementation(function (this: HTMLFormElement) {
    this.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

export async function renderAuthRoute(route: RouteObject, path: string) {
  let resolveAction: (value: unknown) => void = () => {};
  let resolveLoading: (() => void) | undefined;
  const requests = vi.fn();
  const originalLoader = route.loader;
  const router = createMemoryRouter(
    [
      {
        ...route,
        action: async ({ request }) => {
          requests(request.method, new URL(request.url).pathname);
          return new Promise((resolve) => {
            resolveAction = resolve;
          });
        },
        loader: async (args) => {
          if (resolveLoading)
            await new Promise<void>((resolve) => {
              resolveLoading = resolve;
            });
          return typeof originalLoader === "function" ? originalLoader(args) : null;
        },
      },
      { path: "/done", element: <p>Authenticated destination</p> },
    ],
    { initialEntries: [path] },
  );
  routers.add(router);
  await act(async () => {
    render(<RouterProvider router={router} />);
  });
  await waitFor(() => {
    if (!router.state.initialized) throw new Error("Router not initialized");
  });
  return {
    router,
    requests,
    async settle(result: unknown, holdLoading = false) {
      if (holdLoading) resolveLoading = () => {};
      await act(async () => {
        resolveAction(result);
      });
      await waitFor(() => {
        if (router.state.navigation.state !== (holdLoading ? "loading" : "idle")) throw new Error("Not settled");
      });
    },
    async finishLoading() {
      await act(async () => {
        const resolve = resolveLoading;
        resolveLoading = undefined;
        resolve?.();
      });
      await waitFor(() => {
        if (router.state.navigation.state !== "idle") throw new Error("Not idle");
      });
    },
    async revalidate() {
      await act(async () => {
        router.revalidate();
      });
      await waitFor(() => {
        if (router.state.revalidation !== "idle") throw new Error("Not revalidated");
      });
    },
  };
}
