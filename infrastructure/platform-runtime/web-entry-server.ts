import { isbot } from "isbot";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";

export const streamTimeout = 5_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
): Promise<Response> {
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), streamTimeout + 1000);
  let shellRendered = false;

  try {
    const stream = await renderToReadableStream(
      createElement(ServerRouter, { context: routerContext, url: request.url }),
      {
        signal: controller.signal,
        onError(error: unknown) {
          responseStatusCode = 500;
          // Shell errors reject to React Router, which owns their logging.
          if (shellRendered) console.error(error);
        },
      },
    );
    shellRendered = true;
    const clearAbortTimer = () => clearTimeout(timeout);
    void stream.allReady.then(clearAbortTimer, clearAbortTimer);

    const userAgent = request.headers.get("user-agent");
    if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
      await stream.allReady;
    }

    responseHeaders.set("Content-Type", "text/html");
    return new Response(stream, { status: responseStatusCode, headers: responseHeaders });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}
