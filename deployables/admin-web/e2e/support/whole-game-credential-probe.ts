import { createServer, type IncomingMessage, type Server } from "node:http";
import { getEventListeners, type EventEmitter } from "node:events";
import type { Browser, BrowserContext, Page, Request, Response } from "@playwright/test";

export const wholeGameProbeCredentials = {
  email: "whole-game-307-synthetic@example.invalid",
  password: "whole-game-307-synthetic-password",
} as const;
export const wholeGameProbeSessionMarker = "whole-game-307-synthetic-session";

type OriginRole = "source" | "sink" | "blocked";
type Hop = Readonly<{ origin: OriginRole; method: string }>;
type RequestFact = Hop & Readonly<{ parent: Hop | null }>;
type Arrival = Readonly<{ method: string; bodyPresent: boolean; onlySyntheticCredentials: boolean }>;

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Loopback probe did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function arrival(request: IncomingMessage): Promise<Arrival> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 4_096) throw new Error("Loopback probe body exceeded its bound.");
    chunks.push(bytes);
  }
  const fields = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  return {
    method: request.method ?? "",
    bodyPresent: length > 0,
    onlySyntheticCredentials:
      fields.size === 2 &&
      fields.get("email") === wholeGameProbeCredentials.email &&
      fields.get("password") === wholeGameProbeCredentials.password,
  };
}

const importer = `<!doctype html><html data-admin-web-hydrated="true"><body>
  <h1>Pull provider data, review Source Observations, promote Catalog facts</h1>
  </body></html>`;
const form = `<!doctype html><html><body><form method="post" action="/access/password">
  <label id="email-label">Email<input name="email"></label>
  <button type="button" id="continue" onclick="document.getElementById('email-label').hidden=true;
    this.hidden=true; document.getElementById('password-step').hidden=false">Continue</button>
  <div id="password-step" hidden><label>Password<input name="password" type="password"></label>
    <button type="submit">Sign in</button></div></form></body></html>`;

// Real TCP responses, not route.fulfill: Chromium owns the 307 and 303 hops.
export async function startWholeGameCredentialProbe(browser: Browser) {
  let redirect = false;
  let sourceOrigin = "";
  const sourcePosts: Arrival[] = [];
  const sinkPosts: Arrival[] = [];
  const laterSubmissions: string[] = [];
  const serverErrors: string[] = [];
  const sink = createServer((request, response) => {
    void (async () => {
      sinkPosts.push(await arrival(request));
      response.writeHead(303, { location: `${sourceOrigin}/catalog/integrations` });
      response.end();
    })().catch(() => {
      serverErrors.push("sink-request-failed");
      response.writeHead(500).end();
    });
  });
  const sinkOrigin = await listen(sink);
  const source = createServer((request, response) => {
    void (async () => {
      // This server also acts as a non-forwarding proxy for non-loopback egress.
      if (!request.url?.startsWith("/") || request.headers.host !== new URL(sourceOrigin).host) {
        response.writeHead(403).end();
      } else if (request.method === "POST" && request.url === "/access/password") {
        sourcePosts.push(await arrival(request));
        response.writeHead(redirect ? 307 : 200, {
          ...(redirect ? { location: `${sinkOrigin}/credential-sink` } : { "content-type": "text/html" }),
          "set-cookie": `probe-session=${wholeGameProbeSessionMarker}; HttpOnly; SameSite=Lax`,
        });
        response.end(redirect ? undefined : importer);
      } else if (request.method !== "GET") {
        laterSubmissions.push(request.method ?? "unknown");
        response.writeHead(403).end();
      } else {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(request.url.startsWith("/access/sign-in") ? form : importer);
      }
    })().catch(() => {
      serverErrors.push("source-request-failed");
      response.writeHead(500).end();
    });
  });
  source.on("connect", (_request, socket) => socket.destroy());
  let context: BrowserContext | undefined;
  try {
    sourceOrigin = await listen(source);
    context = await browser.newContext({
      baseURL: sourceOrigin,
      serviceWorkers: "block",
      proxy: { server: sourceOrigin, bypass: "127.0.0.1" },
    });
    const page = await context.newPage();
    const requests: RequestFact[] = [];
    const routes: RequestFact[] = [];
    const responses: (Hop & Readonly<{ status: number }>)[] = [];
    const role = (request: Request): OriginRole => {
      const origin = new URL(request.url()).origin;
      return origin === sourceOrigin ? "source" : origin === sinkOrigin ? "sink" : "blocked";
    };
    const fact = (request: Request): RequestFact => {
      const parent = request.redirectedFrom();
      return {
        origin: role(request),
        method: request.method(),
        parent: parent ? { origin: role(parent), method: parent.method() } : null,
      };
    };
    const observe = (request: Request) => requests.push(fact(request));
    const observeResponse = (response: Response) =>
      responses.push({
        origin: role(response.request()),
        method: response.request().method(),
        status: response.status(),
      });
    page.on("request", observe);
    page.on("response", observeResponse);
    await context.route("**/*", async (route) => {
      routes.push(fact(route.request()));
      if (role(route.request()) === "blocked") return route.abort("blockedbyclient");
      return route.continue();
    });
    return {
      page,
      origin: sourceOrigin,
      requestListenerCount() {
        // Playwright's runtime Page is an EventEmitter; its public type omits introspection.
        return getEventListeners(page as unknown as EventEmitter, "request").length;
      },
      async attempt(signIn: (page: Page) => Promise<void>, useRedirect: boolean) {
        redirect = useRedirect;
        sourcePosts.length =
          sinkPosts.length =
          laterSubmissions.length =
          requests.length =
          routes.length =
          responses.length =
            0;
        let outcome = "signed-in";
        try {
          await signIn(page);
        } catch (error) {
          // No raw Playwright error, URL, form body or session enters the receipt.
          outcome =
            error instanceof Error && "code" in error && error.code === "staging-origin-required"
              ? "staging-origin-required"
              : "unexpected-error";
        }
        return {
          outcome,
          sourcePosts: [...sourcePosts],
          sinkPosts: [...sinkPosts],
          laterSubmissions: [...laterSubmissions],
          requests: [...requests],
          routes: [...routes],
          responses: [...responses],
          serverErrors: [...serverErrors],
        };
      },
      async checkRouteCleanup() {
        routes.length = 0;
        await page.goto(`${sinkOrigin}/credential-sink`, { waitUntil: "domcontentloaded" });
        return routes.some((request) => request.origin === "sink" && request.method === "GET");
      },
      async close() {
        page.off("request", observe);
        page.off("response", observeResponse);
        try {
          await context?.close();
        } finally {
          await Promise.all([close(source), close(sink)]);
        }
      },
    };
  } catch (error) {
    try {
      await context?.close();
    } finally {
      await Promise.all([close(source), close(sink)]);
    }
    throw error;
  }
}
