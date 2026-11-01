import { webcrypto } from "node:crypto";
import type { ReactNode } from "react";
import * as routerApi from "react-router";
import { createMemoryRouter, RouterProvider, useLoaderData } from "react-router";
import { render } from "@testing-library/react";
import { vi } from "vitest";
import { renderToString } from "react-dom/server";
import { AccountMutationBoundary } from "./controller";

const testActor = { tenantId: "tnt_test", userId: "usr_test", accountId: "acc_test" } as const;

export function accountManagementTestElement(ui: ReactNode, path = "/account") {
  const router = createMemoryRouter(
    [
      {
        path,
        element: <AccountMutationBoundary actor={testActor}>{ui}</AccountMutationBoundary>,
      },
    ],
    { initialEntries: [path] },
  );
  return <RouterProvider router={router} />;
}

export const renderAccountManagementPage = (ui: ReactNode, path = "/account") =>
  render(accountManagementTestElement(ui, path));
export const renderAccountManagementPageToString = (ui: ReactNode) => renderToString(accountManagementTestElement(ui));

/**
 * Renders a real page inside the boundary on a hydrated route whose after-write loads are held:
 * every revalidation or redirect load waits in `loads` until the test resolves it with page data.
 */
export function renderHeldAccountManagementRoute<T>(path: string, initial: T, page: (data: T) => ReactNode) {
  const loads: ((data: T) => void)[] = [];
  function Page() {
    return page(useLoaderData() as T);
  }
  const router = createMemoryRouter(
    [
      {
        id: "page",
        path,
        loader: () => new Promise<T>((resolve) => loads.push(resolve)),
        element: (
          <AccountMutationBoundary actor={testActor}>
            <Page />
          </AccountMutationBoundary>
        ),
      },
    ],
    { initialEntries: [path], hydrationData: { loaderData: { page: initial } } },
  );
  return { ...render(<RouterProvider router={router} />), router, loads };
}

type AccountManagementRouter = ReturnType<typeof createMemoryRouter>;

function routeIsIdle(state: AccountManagementRouter["state"]) {
  return (
    state.initialized &&
    state.navigation.state === "idle" &&
    state.revalidation === "idle" &&
    [...state.fetchers.values()].every((fetcher) => fetcher.state === "idle")
  );
}

/** Waits for route idle (navigation, revalidation, fetchers) plus a DOM commit at which settled() holds. */
export function settleAccountManagementRoute(router: AccountManagementRouter, settled: () => boolean) {
  if (routeIsIdle(router.state) && settled()) return Promise.resolve();

  return new Promise<void>((resolve) => {
    let idle = false;
    let committed = false;
    let done = false;
    const finish = () => {
      if (done || !idle || !committed || !settled()) return;
      done = true;
      unsubscribe();
      observer.disconnect();
      resolve();
    };
    const observer = new MutationObserver(() => {
      committed = true;
      finish();
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    const unsubscribe = router.subscribe((state) => {
      idle = routeIsIdle(state);
      finish();
    });
    idle = routeIsIdle(router.state);
    finish();
  });
}

/** Routes the controller's real transport through a held fetch whose JSON bodies decode as route data. */
export function stubHeldAccountManagementTransport() {
  vi.stubGlobal("crypto", webcrypto);
  vi.spyOn(routerApi, "UNSAFE_decodeViaTurboStream").mockImplementation(decodeJsonAsTurboStream as never);
  const transport = heldAccountManagementFetch();
  vi.stubGlobal("fetch", transport.fetch);
  return transport;
}

/** Holds every account-management request until the test responds; bodies decode through `decodeJsonAsTurboStream`. */
export function heldAccountManagementFetch() {
  const requests: {
    url: string;
    method: string;
    body: FormData | null;
    respond: (value: unknown, status?: number) => void;
  }[] = [];
  const fetch = (input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body instanceof FormData ? init.body : null,
        respond: (value, status = 200) => resolve(Response.json(value, { status })),
      });
    });
  return { fetch, requests, posts: () => requests.filter((request) => request.method === "POST") };
}

/** Stand-in for `UNSAFE_decodeViaTurboStream` that reads the synthetic JSON body as route data. */
export async function decodeJsonAsTurboStream(body: ReadableStream<Uint8Array>) {
  return { value: { data: JSON.parse(await new Response(body).text()) as unknown } };
}
