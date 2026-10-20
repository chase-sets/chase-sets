import { act } from "@testing-library/react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  createMemoryRouter,
  createStaticHandler,
  createStaticRouter,
  RouterProvider,
  StaticRouterProvider,
  type HydrationState,
  type RouteObject,
} from "react-router";

/**
 * One server-rendered document: what a browser receives for a GET, or for a
 * POST whose action answered with data instead of a redirect.
 */
export type ServerDocument = Readonly<{ url: string; html: string; hydrationData: HydrationState }>;

/** Renders a document request through the real static data router, as the server does. */
export async function serverRender(routes: RouteObject[], request: Request): Promise<ServerDocument | Response> {
  const handler = createStaticHandler(routes);
  const context = await handler.query(request);
  if (context instanceof Response) {
    return context;
  }

  const router = createStaticRouter(handler.dataRoutes, context);
  return {
    url: request.url,
    html: renderToString(<StaticRouterProvider router={router} context={context} hydrate={false} />),
    hydrationData: { loaderData: context.loaderData, actionData: context.actionData, errors: context.errors },
  };
}

export function expectDocument(rendered: ServerDocument | Response): ServerDocument {
  if (rendered instanceof Response) {
    throw new Error(`Expected a document, received ${rendered.status} to ${rendered.headers.get("Location")}`);
  }
  return rendered;
}

export function expectRedirect(rendered: ServerDocument | Response) {
  if (!(rendered instanceof Response)) {
    throw new Error("Expected a redirect, received a document.");
  }
  return { status: rendered.status, location: new URL(rendered.headers.get("Location") ?? "", "http://localhost") };
}

/** The entry key a route's loader minted for this document. */
export function loaderEntryKey(served: ServerDocument, routeId: string) {
  return (served.hydrationData.loaderData?.[routeId] as { entryAttemptKey?: string } | undefined)?.entryAttemptKey;
}

/**
 * The body an unhydrated browser posts for one server-rendered form and submit
 * button, read from the server HTML alone (no script ran; a detached parse never
 * runs scripts). `plant` edits the parsed form first, for planted controls.
 */
export function unhydratedFormSubmission(
  html: string,
  selectors: Readonly<{ form: string; submitter: string }>,
  plant?: (form: HTMLFormElement) => void,
) {
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, "text/html");
  const form = parsed.querySelector<HTMLFormElement>(selectors.form);
  const submitter = form?.querySelector<HTMLButtonElement>(selectors.submitter) ?? null;
  if (!form || !submitter) {
    throw new Error(`Server HTML has no ${selectors.form} form with ${selectors.submitter}.`);
  }
  plant?.(form);

  const body = new URLSearchParams();
  for (const [name, value] of new FormData(form, submitter)) {
    body.append(name, String(value));
  }
  return {
    method: form.method,
    action: new URL(form.getAttribute("action") ?? "", "http://localhost/"),
    body,
  };
}

export function postForm(url: string, body: URLSearchParams) {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

export type HydratedDocument = Readonly<{
  container: HTMLElement;
  router: ReturnType<typeof createMemoryRouter>;
  unmount: () => void;
}>;

/** Puts a server document into the page and hydrates it with its own loader and action data. */
export async function hydrateDocument(served: ServerDocument, routes: RouteObject[]): Promise<HydratedDocument> {
  const url = new URL(served.url);
  const container = document.createElement("div");
  container.innerHTML = served.html;
  document.body.appendChild(container);

  const router = createMemoryRouter(routes, {
    initialEntries: [`${url.pathname}${url.search}`],
    hydrationData: served.hydrationData,
  });
  let root: Root | undefined;
  await act(async () => {
    root = hydrateRoot(container, <RouterProvider router={router} />);
  });

  return {
    container,
    router,
    unmount: () => {
      act(() => root?.unmount());
      router.dispose();
      container.remove();
    },
  };
}

/**
 * Stands in for the browser's native form submission: records the exact body
 * after every submit handler ran, and stops jsdom's unimplemented navigation.
 */
export function captureNativeSubmissions() {
  const bodies: URLSearchParams[] = [];
  const listener = (event: Event) => {
    event.preventDefault();
    const body = new URLSearchParams();
    for (const [name, value] of new FormData(event.target as HTMLFormElement, (event as SubmitEvent).submitter)) {
      body.append(name, String(value));
    }
    bodies.push(body);
  };
  document.addEventListener("submit", listener);

  return { bodies, stop: () => document.removeEventListener("submit", listener) };
}

export function hiddenEntryKey(scope: ParentNode, formSelector: string) {
  const input = scope.querySelector<HTMLInputElement>(`${formSelector} input[name="entryAttemptKey"]`);
  if (!input) {
    throw new Error(`${formSelector} renders no entryAttemptKey field.`);
  }
  return input.value;
}

/** A bfcache restore: the same document and JavaScript state come back. */
export function dispatchPersistedPageShow() {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: true });
  window.dispatchEvent(event);
}

/** jsdom has no EventSource; the realtime client opens one per shared topic set. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void) {
    this.listeners.set(type, new Set([...(this.listeners.get(type) ?? []), listener]));
  }

  close() {}

  emit(type: "projection.patch" | "sync.required", data: unknown) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data), lastEventId: String(FakeEventSource.instances.length) } as MessageEvent);
    }
  }
}

export const SYNC_REQUIRED = { kind: "sync.required", reason: "cursor-expired", contexts: ["discovery"] } as const;

/** A Checkout entry error the way the Checkout request client raises one. */
export function checkoutApiError(status: number, code: string, message = code) {
  return Object.assign(new Error(message), { status, body: { error: { code, message } } });
}

type BuyNowSource = Readonly<{
  listingId: string;
  catalogItemId: string;
  productId: string;
  selectedOptions: unknown;
  quantity: number;
  fulfillmentMode: string;
  lockedListingId: string | null;
}>;

/**
 * Checkout entry as #9994 decides it: the same key and payload return the first
 * Session, the same key with a changed payload is `409 checkout_attempt_conflict`
 * with nothing opened, and a new key opens a new Session.
 */
export function createCheckoutEntryStub() {
  const sessions = new Map<string, Readonly<{ payload: string; sessionId: string }>>();
  const sentKeys: (string | undefined)[] = [];
  let loseNextResponse = false;

  const createCheckoutSession = async (request: { entryAttemptKey?: string; source: BuyNowSource }) => {
    sentKeys.push(request.entryAttemptKey);
    const { listingId, catalogItemId, productId, selectedOptions, quantity, fulfillmentMode, lockedListingId } =
      request.source;
    const payload = JSON.stringify({
      listingId,
      catalogItemId,
      productId,
      selectedOptions,
      quantity,
      fulfillmentMode,
      lockedListingId,
    });
    const key = request.entryAttemptKey ?? "";
    const first = sessions.get(key);
    if (first && first.payload !== payload) {
      throw checkoutApiError(409, "checkout_attempt_conflict");
    }

    const sessionId = first?.sessionId ?? `chk_session_${sessions.size + 1}`;
    sessions.set(key, { payload, sessionId });
    if (loseNextResponse) {
      loseNextResponse = false;
      throw checkoutApiError(504, "gateway_timeout", "Checkout did not answer. Try again.");
    }
    return { session_id: sessionId };
  };

  return {
    createCheckoutSession,
    sentKeys,
    sessionCount: () => sessions.size,
    /** The next Session opens but its response never reaches Discovery. */
    loseNextResponse: () => {
      loseNextResponse = true;
    },
  };
}
