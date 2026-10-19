import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV } from "./http";
import { createWebApp, startWebServer, type WebAppOptions } from "./web-server";
import {
  createWebDeployableTestRoot,
  createWebServerTestRoot,
  webServerTestAssetBody,
  type WebDeployableTestRoot,
  type WebServerTestRoot,
} from "./web-server-test-support";

let root: WebServerTestRoot;
const servers: Server[] = [];

beforeEach(() => {
  root = createWebServerTestRoot();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(closeServer));
  root.remove();
});

function closeServer(server: Server) {
  server.closeAllConnections();
  return new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()));
}

async function serve(options: Pick<WebAppOptions, "logStream"> = {}) {
  const build = await root.loadBuild();
  const app = createWebApp({ build, rootDirectory: root.rootDirectory, ...options });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { app, build, port, origin: `http://127.0.0.1:${port}` };
}

// node:http, unlike fetch, sends the Host header a proxy hop would.
function postAction(port: number, headers: Readonly<Record<string, string>>) {
  const body = "intent=probe";
  return new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(body)),
          ...headers,
        },
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode));
      },
    );
    request.once("error", reject);
    request.end(body);
  });
}

async function freePort() {
  const probe = createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address() as AddressInfo;
  await closeServer(probe);
  return port;
}

describe("createWebApp parity with react-router-serve", () => {
  it("caches hashed build assets for a year, other build files never, and public files for an hour", async () => {
    const { origin } = await serve();

    const asset = await fetch(`${origin}/assets/entry.js`);
    const buildFile = await fetch(`${origin}/build-manifest.txt`);
    const publicFile = await fetch(`${origin}/robots.txt`);

    expect([asset.status, buildFile.status, publicFile.status]).toEqual([200, 200, 200]);
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(buildFile.headers.get("cache-control")).toBe("public, max-age=0");
    expect(publicFile.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("compresses responses only for clients that accept gzip", async () => {
    const { origin } = await serve();

    const gzipped = await fetch(`${origin}/assets/entry.js`, { headers: { "accept-encoding": "gzip" } });
    const identity = await fetch(`${origin}/assets/entry.js`, { headers: { "accept-encoding": "identity" } });

    expect(gzipped.headers.get("content-encoding")).toBe("gzip");
    expect(await gzipped.text()).toBe(webServerTestAssetBody);
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(await identity.text()).toBe(webServerTestAssetBody);
  });

  it("logs routed requests in morgan's tiny format and leaves static files unlogged", async () => {
    const lines: string[] = [];
    const { origin } = await serve({ logStream: { write: (line) => lines.push(line) } });

    await (await fetch(`${origin}/assets/entry.js`)).text();
    await (await fetch(`${origin}/robots.txt`)).text();
    await (await fetch(`${origin}/`)).text();

    await vi.waitFor(() => expect(lines).toHaveLength(1));
    expect(lines[0]).toMatch(/^GET \/ 200 (\d+|-) - \d+(\.\d+)? ms\n$/);
  });

  it("renders React Router documents through the build without advertising Express", async () => {
    const { origin } = await serve();

    const response = await fetch(`${origin}/`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("root 200");
    expect(response.headers.get("x-powered-by")).toBeNull();
  });
});

describe("startWebServer", () => {
  it("loads build/server/index.js and listens on PORT and HOST, defaulting NODE_ENV to production", async () => {
    const port = await freePort();
    vi.stubEnv("PORT", String(port));
    vi.stubEnv("HOST", "127.0.0.1");
    vi.stubEnv("NODE_ENV", undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const server = await startWebServer(root.rootUrl, new EventEmitter());
    servers.push(server);

    expect(server.address()).toMatchObject({ address: "127.0.0.1", port });
    expect(process.env.NODE_ENV).toBe("production");
    expect(log).toHaveBeenCalledWith(`[web-server] http://127.0.0.1:${port}`);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(await response.text()).toBe("root 200");
  });

  it.each(["SIGTERM", "SIGINT"] as const)("closes the server on %s", async (signal) => {
    vi.stubEnv("PORT", "0");
    vi.stubEnv("HOST", "127.0.0.1");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const signals = new EventEmitter();
    const server = await startWebServer(root.rootUrl, signals);
    servers.push(server);

    const closed = once(server, "close");
    signals.emit(signal);
    await closed;

    expect(server.listening).toBe(false);
  });
});

describe("web deployable roots", () => {
  let deployableRoot: WebDeployableTestRoot | undefined;
  let child: ChildProcess | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    child = undefined;
    deployableRoot?.remove();
    deployableRoot = undefined;
  });

  // A fresh process, as E2E and compose start a root, with NODE_ENV unset: the
  // root must default it before anything loads React, or react-dom/server binds
  // the production build against React's development build.
  it.each(["admin-web", "marketplace", "public-web"])(
    "%s renders a route through one React build when started without NODE_ENV",
    async (deployable) => {
      deployableRoot = createWebDeployableTestRoot(
        fileURLToPath(new URL(`../../deployables/${deployable}/`, import.meta.url)),
      );
      const env: NodeJS.ProcessEnv = { ...process.env, PORT: "0", HOST: "127.0.0.1" };
      delete env.NODE_ENV;
      const started = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
        cwd: deployableRoot.rootDirectory,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      child = started;
      let output = "";
      started.stdout.on("data", (chunk) => (output += chunk));
      started.stderr.on("data", (chunk) => (output += chunk));

      const port = await new Promise<string>((resolve, reject) => {
        started.stdout.on("data", () => {
          const listening = /\[web-server\] http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
          if (listening?.[1]) resolve(listening[1]);
        });
        started.once("exit", (code) =>
          reject(new Error(`${deployable} root exited ${code} before listening:\n${output}`)),
        );
      });
      const response = await fetch(`http://127.0.0.1:${port}/`);
      const body = await response.text();

      expect({ status: response.status, body }, output).toEqual({
        status: 200,
        body: expect.stringContaining("<p>rendered</p>"),
      });
    },
  );
});

describe("forwarded-origin trust", () => {
  it.each([
    { switchValue: undefined, trust: false },
    { switchValue: "false", trust: false },
    { switchValue: "true", trust: 1 },
    { switchValue: " TRUE ", trust: 1 },
  ])("sets trust proxy to $trust when the shared switch is $switchValue", async ({ switchValue, trust }) => {
    vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, switchValue);

    const { app } = await serve();

    expect(app.get("trust proxy")).toBe(trust);
  });

  describe("with the switch off, the request origin is the server's own", () => {
    beforeEach(() => {
      vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "false");
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("runs a same-origin action", async () => {
      const { build, origin, port } = await serve();

      const status = await postAction(port, { host: `127.0.0.1:${port}`, origin });

      expect(status).toBe(200);
      expect(build.actionCount()).toBe(1);
    });

    it.each([
      { control: "a foreign host", origin: (port: number) => `http://attacker.invalid:${port}` },
      { control: "a foreign scheme", origin: (port: number) => `https://127.0.0.1:${port}` },
      { control: "a foreign port", origin: (port: number) => `http://127.0.0.1:${port + 1}` },
    ])("rejects $control without running the action", async ({ origin }) => {
      const { build, port } = await serve();

      const status = await postAction(port, { host: `127.0.0.1:${port}`, origin: origin(port) });

      expect(status).toBe(400);
      expect(build.actionCount()).toBe(0);
    });

    it("rejects a spoofed X-Forwarded-Host without running the action", async () => {
      const { build, port } = await serve();

      const status = await postAction(port, {
        host: `127.0.0.1:${port}`,
        "x-forwarded-host": "attacker.invalid",
        "x-forwarded-proto": "https",
        origin: "https://attacker.invalid",
      });

      expect(status).toBe(400);
      expect(build.actionCount()).toBe(0);
    });
  });

  describe("with the switch on, the request origin is the one sanitized hop's forwarded host and scheme", () => {
    // The header set ingress-nginx sends with use-forwarded-headers off.
    const hop = {
      host: "shop.chasesets.test",
      "x-forwarded-host": "shop.chasesets.test",
      "x-forwarded-proto": "https",
    };

    beforeEach(() => {
      vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, "true");
      vi.spyOn(console, "error").mockImplementation(() => {});
    });

    it("runs a same-origin action", async () => {
      const { build, port } = await serve();

      const status = await postAction(port, { ...hop, origin: "https://shop.chasesets.test" });

      expect(status).toBe(200);
      expect(build.actionCount()).toBe(1);
    });

    it.each([
      { control: "a foreign host", origin: "https://attacker.invalid" },
      { control: "a foreign scheme", origin: "http://shop.chasesets.test" },
      { control: "a foreign port", origin: "https://shop.chasesets.test:8443" },
    ])("rejects $control without running the action", async ({ origin }) => {
      const { build, port } = await serve();

      const status = await postAction(port, { ...hop, origin });

      expect(status).toBe(400);
      expect(build.actionCount()).toBe(0);
    });
  });
});
