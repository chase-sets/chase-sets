import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createElement, Suspense } from "react";
import { renderToReadableStream } from "react-dom/server";
import { createRequestHandler, data, type EntryContext, type ServerBuild } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handleRequest, { streamTimeout } from "./web-entry-server";
import { createWebApp } from "./web-server";
import { createWebServerTestRoot, type WebServerTestRoot } from "./web-server-test-support";

vi.mock("react-dom/server", async (importOriginal) => {
  const original = await importOriginal<typeof import("react-dom/server")>();
  return { ...original, renderToReadableStream: vi.fn(original.renderToReadableStream) };
});

let root: WebServerTestRoot;
const servers: Server[] = [];

beforeEach(() => {
  root = createWebServerTestRoot();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(renderToReadableStream).mockClear();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
  root.remove();
});

const browserAgent = "Mozilla/5.0 Chrome/130.0.0.0 Safari/537.36";

async function documentContext(component = () => createElement("p", null, "route document"), isSpaMode = false) {
  const build = await root.loadBuild();
  let context: EntryContext | undefined;
  const handler = createRequestHandler({
    ...build,
    ssr: !isSpaMode,
    entry: {
      module: {
        default: (_request, _status, _headers, routerContext) => {
          context = routerContext;
          return new Response(null);
        },
      },
    },
    routes: {
      ...build.routes,
      root: {
        ...build.routes.root!,
        module: { default: component, HydrateFallback: component, loader: () => null },
      },
    },
  });
  await handler(new Request("http://localhost/"));
  if (!context) throw new Error("Document request did not reach its server entry");
  expect(context.isSpaMode).toBe(isSpaMode);
  return context;
}

function request(userAgent: string | null = browserAgent) {
  return new Request("http://localhost/", { headers: userAgent ? { "user-agent": userAgent } : {} });
}

function suspendedRoute(error?: Error) {
  let settled = false;
  let resolve!: () => void;
  const pending = new Promise<void>((complete) => {
    resolve = () => {
      settled = true;
      complete();
    };
  });
  const Content = () => {
    if (!settled) throw pending;
    if (error) throw error;
    return createElement("p", null, "resolved content");
  };
  return {
    component: () =>
      createElement(
        "html",
        null,
        createElement("body", null, createElement(Suspense, { fallback: "pending content" }, createElement(Content))),
      ),
    resolve,
  };
}

describe("shared Web Streams server entry", () => {
  it("renders router documents through renderToReadableStream with the router status", async () => {
    const build = await root.loadBuild();
    const app = createWebApp({
      rootDirectory: root.rootDirectory,
      logStream: { write: () => {} },
      build: {
        ...build,
        entry: { module: { default: handleRequest } },
        routes: {
          ...build.routes,
          root: {
            ...build.routes.root!,
            module: {
              default: () => createElement("p", null, "route document"),
              loader: () => data(null, { status: 202 }),
            },
          },
        },
      } satisfies ServerBuild,
    });
    const server = app.listen(0, "127.0.0.1");
    servers.push(server);
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/`, { headers: { "user-agent": browserAgent } });

    expect(response.status).toBe(202);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("<p>route document</p>");
    expect(renderToReadableStream).toHaveBeenCalledOnce();
  });

  it("answers HEAD with the status and no body", async () => {
    const headers = new Headers({ "x-route-header": "preserved" });
    const context = await documentContext();

    const response = await handleRequest(new Request("http://localhost/", { method: "HEAD" }), 202, headers, context);

    expect(response.status).toBe(202);
    expect(response.headers.get("x-route-header")).toBe("preserved");
    expect(await response.text()).toBe("");
    expect(renderToReadableStream).not.toHaveBeenCalled();
  });

  it("waits for all content for bots and streams the shell for browsers", async () => {
    for (const [agent, isSpaMode, waitsForContent] of [
      [browserAgent, false, false],
      [null, false, false],
      ["Googlebot", false, true],
      [browserAgent, true, true],
    ] as const) {
      const route = suspendedRoute();
      const context = await documentContext(route.component, isSpaMode);
      let responseReady = false;
      const responsePromise = handleRequest(request(agent), 200, new Headers(), context).then((response) => {
        responseReady = true;
        return response;
      });
      const shell = await vi.mocked(renderToReadableStream).mock.results.at(-1)!.value;
      await Promise.resolve();

      expect(responseReady).toBe(!waitsForContent);
      let body: Promise<string>;
      if (!waitsForContent) {
        const response = await responsePromise;
        const reader = response.body!.getReader();
        const first = await reader.read();
        expect(new TextDecoder().decode(first.value)).toContain("pending content");
        body = (async () => {
          const decoder = new TextDecoder();
          let html = decoder.decode(first.value);
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) return html;
            html += decoder.decode(chunk.value, { stream: true });
          }
        })();
      } else {
        body = responsePromise.then((response) => response.text());
      }
      route.resolve();
      await shell.allReady;
      expect(await body).toContain("resolved content");
    }
  });

  it("marks post-shell errors 500 and rejects shell errors", async () => {
    const error = new Error("boundary failed after the shell");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const agent of ["Googlebot", browserAgent]) {
      const route = suspendedRoute(error);
      const context = await documentContext(route.component);
      const responsePromise = handleRequest(request(agent), 200, new Headers(), context);
      await vi.mocked(renderToReadableStream).mock.results.at(-1)!.value;
      if (agent === browserAgent) expect((await responsePromise).status).toBe(200);
      route.resolve();
      const response = await responsePromise;

      // An already returned browser response keeps its committed status, as in the default entry.
      expect(response.status).toBe(agent === "Googlebot" ? 500 : 200);
      await response.text();
      expect(log).toHaveBeenCalledExactlyOnceWith(error);
      log.mockClear();
    }

    const shellError = new Error("shell failed");
    const brokenContext = await documentContext(() => {
      throw shellError;
    });
    await expect(handleRequest(request(), 200, new Headers(), brokenContext)).rejects.toBe(shellError);
    expect(log).not.toHaveBeenCalled();
  });

  it("clears the abort timer on completion and aborts a stalled render", async () => {
    const context = await documentContext();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const response = await handleRequest(request(), 200, new Headers(), context);
    await response.text();
    expect(vi.getTimerCount()).toBe(0);
    const completedSignal = vi.mocked(renderToReadableStream).mock.calls.at(-1)![1]!.signal!;
    expect(completedSignal.aborted).toBe(false);

    vi.useRealTimers();
    const route = suspendedRoute();
    const stalledContext = await documentContext(route.component);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalledResponse = await handleRequest(request(), 200, new Headers(), stalledContext);
    const stalledSignal = vi.mocked(renderToReadableStream).mock.calls.at(-1)![1]!.signal!;
    expect(streamTimeout).toBe(5_000);
    await vi.advanceTimersByTimeAsync(streamTimeout + 999);
    expect(stalledSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stalledSignal.aborted).toBe(true);
    await stalledResponse.text();
    expect(log).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(completedSignal.aborted).toBe(false);

    vi.useRealTimers();
    const never = new Promise<void>(() => {});
    const stalledShellContext = await documentContext(() => {
      throw never;
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stalledShell = handleRequest(request(), 200, new Headers(), stalledShellContext);
    const rejectedShell = expect(stalledShell).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(streamTimeout + 1000);
    await rejectedShell;
    expect(vi.getTimerCount()).toBe(0);
    expect(log).toHaveBeenCalledOnce();
  });
});
