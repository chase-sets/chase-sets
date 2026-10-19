import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequestHandler } from "@react-router/express";
import compression from "compression";
import express, { type Express } from "express";
import morgan from "morgan";
import type { ServerBuild } from "react-router";
import { trustForwardedHeaders } from "./http";

const defaultPort = 3000;
const shutdownSignals = ["SIGTERM", "SIGINT"] as const;

export type WebAppOptions = Readonly<{
  build: ServerBuild;
  /** The deployable directory; `public/` and the build's client assets resolve from it. */
  rootDirectory: string;
  mode?: string;
  logStream?: morgan.StreamOptions;
}>;

export type ShutdownSignalSource = Readonly<{
  once(signal: (typeof shutdownSignals)[number], listener: () => void): unknown;
}>;

/**
 * The one Express composition every web deployable serves its React Router
 * build through. Forwarded host and scheme are trusted for exactly one hop
 * (the sanitizing ingress), and only when the shared switch is on, so Express
 * and `resolvePublicRequestOrigin` always agree on the request origin.
 */
export function createWebApp({ build, rootDirectory, mode = process.env.NODE_ENV, logStream }: WebAppOptions): Express {
  const app = express();
  const assetsBuildDirectory = path.resolve(rootDirectory, build.assetsBuildDirectory);

  app.disable("x-powered-by");
  app.set("trust proxy", trustForwardedHeaders() ? 1 : false);
  app.use(compression());
  app.use(
    path.posix.join(build.publicPath, "assets"),
    express.static(path.join(assetsBuildDirectory, "assets"), { immutable: true, maxAge: "1y" }),
  );
  app.use(build.publicPath, express.static(assetsBuildDirectory));
  app.use(express.static(path.join(rootDirectory, "public"), { maxAge: "1h" }));
  app.use(
    morgan(
      (tokens, req, res) => {
        const originalUrl = (req as typeof req & { originalUrl?: string }).originalUrl ?? req.url ?? "/";
        const pathname = originalUrl.split("?", 1)[0] || "/";
        return `${tokens.method(req, res)} ${pathname} ${tokens.status(req, res)} ${tokens.res(req, res, "content-length") ?? "-"} - ${tokens["response-time"](req, res)} ms`;
      },
      logStream ? { stream: logStream } : {},
    ),
  );
  app.all("*", createRequestHandler({ build, mode }));

  return app;
}

/**
 * Serves `<root>/build/server/index.js` on PORT (default 3000) and HOST (all
 * interfaces when unset), closing the server on SIGTERM or SIGINT. This module
 * loads React when imported, so a root must default NODE_ENV before importing
 * it; the default here only covers callers that already did.
 */
export async function startWebServer(root: URL, signals: ShutdownSignalSource = process): Promise<Server> {
  process.env.NODE_ENV ??= "production";
  const rootDirectory = fileURLToPath(root);
  const build: ServerBuild = await import(pathToFileURL(path.join(rootDirectory, "build/server/index.js")).href);
  const server = await listen(createWebApp({ build, rootDirectory }), parsePort(process.env.PORT), process.env.HOST);

  for (const signal of shutdownSignals) {
    signals.once(signal, () =>
      server.close((error) => {
        if (error) console.error(error);
      }),
    );
  }

  return server;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? Number.NaN : Number(value);
  return Number.isNaN(port) ? defaultPort : port;
}

function listen(app: Express, port: number, host: string | undefined): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = host ? app.listen(port, host) : app.listen(port);
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      const address = server.address();
      const boundPort = typeof address === "object" && address ? address.port : port;
      console.log(`[web-server] http://${host ?? "localhost"}:${boundPort}`);
      resolve(server);
    });
  });
}
