import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV } from "../infrastructure/platform-runtime/http.ts";
import { createWebApp } from "../infrastructure/platform-runtime/web-server.ts";
import { createWebServerTestRoot } from "../infrastructure/platform-runtime/web-server-test-support.ts";
import { createComposeIngressServer, shouldRouteToApi, xForwardedHeaders } from "./platform-compose-ingress.mjs";
import { platformApiIngressPrefixes } from "./render-platform-helm-values.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function sendRaw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(request));
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

describe("platform-compose-ingress", () => {
  it("routes every real Helm ingress API prefix to platform-api, matching the rendered chart", () => {
    for (const prefix of platformApiIngressPrefixes) {
      expect(shouldRouteToApi(prefix)).toBe(true);
      expect(shouldRouteToApi(`${prefix}/nested/path`)).toBe(true);
    }
  });

  it("routes UCP, MCP, and well-known discovery paths to platform-api", () => {
    expect(shouldRouteToApi("/.well-known/ucp")).toBe(true);
    expect(shouldRouteToApi("/ucp/v1")).toBe(true);
    expect(shouldRouteToApi("/mcp")).toBe(true);
  });

  it("routes provider webhook paths to platform-api", () => {
    expect(shouldRouteToApi("/api/payments/provider/webhooks/stripe")).toBe(true);
    expect(shouldRouteToApi("/api/fulfillment/provider/postage/webhooks/easypost")).toBe(true);
  });

  it("routes the connector credential mount to platform-api (#9985)", () => {
    expect(shouldRouteToApi("/channel-connector/oauth/authorize")).toBe(true);
    expect(shouldRouteToApi("/channel-connector/oauth/connections/x/claim")).toBe(true);
  });

  it("falls through page routes to the web app", () => {
    expect(shouldRouteToApi("/")).toBe(false);
    expect(shouldRouteToApi("/search")).toBe(false);
    expect(shouldRouteToApi("/account")).toBe(false);
    expect(shouldRouteToApi("/sign-in")).toBe(false);
  });

  it("does not prefix-match unrelated paths that merely start with the same characters", () => {
    expect(shouldRouteToApi("/mcp-docs")).toBe(false);
    expect(shouldRouteToApi("/apiary")).toBe(false);
    expect(shouldRouteToApi("/channel-connectors")).toBe(false);
    expect(shouldRouteToApi("/channel-connector-help")).toBe(false);
  });

  it("overwrites spoofed forwarded host and proto with the HTTP request hop", () => {
    expect(
      xForwardedHeaders({
        headers: {
          host: "staging.chasesets.com",
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "https",
        },
        socket: { encrypted: false },
      }),
    ).toEqual({
      "x-forwarded-host": "staging.chasesets.com",
      "x-forwarded-proto": "http",
    });
  });

  it("derives HTTPS from the encrypted request socket instead of client headers", () => {
    expect(
      xForwardedHeaders({
        headers: {
          host: "staging.chasesets.com",
          "x-forwarded-host": "attacker.invalid",
          "x-forwarded-proto": "http",
        },
        socket: { encrypted: true },
      }),
    ).toEqual({
      "x-forwarded-host": "staging.chasesets.com",
      "x-forwarded-proto": "https",
    });
  });

  it("sanitizes client forwarded headers at the handler boundary", async () => {
    let upstreamHeaders;
    const server = createComposeIngressServer({
      webTarget: "http://web.test",
      apiTarget: "http://api.test",
      fetchImpl: async (_url, options) => {
        upstreamHeaders = Object.fromEntries(options.headers);
        return new Response("ok");
      },
    });

    try {
      const port = await listen(server);
      await sendRaw(
        port,
        [
          "GET / HTTP/1.1",
          "Host: staging.chasesets.com",
          "X-Forwarded-Host: attacker.invalid",
          "x-forwarded-host: second.invalid",
          "X-Forwarded-Proto: https",
          "x-forwarded-proto: ftp",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );

      expect(upstreamHeaders["x-forwarded-host"]).toBe("staging.chasesets.com");
      expect(upstreamHeaders["x-forwarded-proto"]).toBe("http");
      expect(Object.values(upstreamHeaders).join("\n")).not.toContain("attacker.invalid");
      expect(Object.values(upstreamHeaders).join("\n")).not.toContain("second.invalid");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it("does not pass spoofed forwarded host through an HTTP/1.0 request without Host", async () => {
    let upstreamHeaders;
    const server = createComposeIngressServer({
      webTarget: "http://web.test",
      apiTarget: "http://api.test",
      fetchImpl: async (_url, options) => {
        upstreamHeaders = Object.fromEntries(options.headers);
        return new Response("ok");
      },
    });

    try {
      const port = await listen(server);
      await sendRaw(
        port,
        [
          "GET / HTTP/1.0",
          "X-Forwarded-Host: attacker.invalid",
          "X-Forwarded-Proto: https",
          "Connection: close",
          "",
          "",
        ].join("\r\n"),
      );

      expect(upstreamHeaders).not.toHaveProperty("x-forwarded-host");
      expect(upstreamHeaders["x-forwarded-proto"]).toBe("http");
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });
});

// The compose ingress in front of the shared web server, as compose boots the
// web deployables: React Router aborts any action whose Origin differs from
// the request origin the server derives, with the switch on or off.
describe("platform-compose-ingress in front of the shared web server", () => {
  const publicHost = "shop.chasesets.test:18180";
  const stacks = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(stacks.splice(0).map((stack) => stack.close()));
  });

  async function startStack(trust) {
    vi.stubEnv(CHASE_SETS_TRUST_FORWARDED_HEADERS_ENV, trust);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = createWebServerTestRoot();
    const build = await root.loadBuild();
    const web = createWebApp({ build, rootDirectory: root.rootDirectory, logStream: { write: () => {} } }).listen(
      0,
      "127.0.0.1",
    );
    await once(web, "listening");
    const webPort = web.address().port;
    const ingress = createComposeIngressServer({
      label: "web",
      webTarget: `http://127.0.0.1:${webPort}`,
      apiTarget: "http://127.0.0.1:9",
    });
    const ingressPort = await listen(ingress);
    const stack = {
      build,
      webPort,
      ingressPort,
      close: async () => {
        for (const server of [ingress, web]) {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        }
        root.remove();
      },
    };
    stacks.push(stack);
    return stack;
  }

  // Node's HTTP client, not sendRaw: the ingress streams the request body
  // upstream, so a client that half-closes after writing gets an empty reply.
  function postThroughIngress({ ingressPort }, headers) {
    const body = "intent=probe";
    return new Promise((resolve, reject) => {
      const request = httpRequest(
        {
          host: "127.0.0.1",
          port: ingressPort,
          method: "POST",
          path: "/",
          agent: false,
          headers: {
            host: publicHost,
            ...headers,
            "content-type": "application/x-www-form-urlencoded",
            "content-length": String(Buffer.byteLength(body)),
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

  function withOrigin(origin, edit) {
    const url = new URL(origin);
    edit(url);
    return url.origin;
  }

  const controls = [
    {
      control: "a foreign host",
      headers: (origin) => ({ Origin: withOrigin(origin, (url) => (url.hostname = "attacker.invalid")) }),
    },
    {
      control: "a foreign scheme",
      headers: (origin) => ({ Origin: withOrigin(origin, (url) => (url.protocol = "https:")) }),
    },
    {
      control: "a foreign port",
      headers: (origin) => ({ Origin: withOrigin(origin, (url) => (url.port = String(Number(url.port) + 1))) }),
    },
    {
      control: "a spoofed X-Forwarded-Host",
      headers: (origin) => {
        const spoofed = new URL(withOrigin(origin, (url) => (url.hostname = "attacker.invalid")));
        return { "X-Forwarded-Host": spoofed.host, "X-Forwarded-Proto": "http", Origin: spoofed.origin };
      },
    },
  ];

  describe.each([
    { trust: "true", requestOrigin: () => `http://${publicHost}` },
    { trust: "false", requestOrigin: ({ webPort }) => `http://127.0.0.1:${webPort}` },
  ])("with CHASE_SETS_TRUST_FORWARDED_HEADERS=$trust", ({ trust, requestOrigin }) => {
    it("runs a same-origin action", async () => {
      const stack = await startStack(trust);

      const status = await postThroughIngress(stack, { Origin: requestOrigin(stack) });

      expect(status).toBe(200);
      expect(stack.build.actionCount()).toBe(1);
    });

    it.each(controls)("rejects $control without running the action", async ({ headers }) => {
      const stack = await startStack(trust);

      const status = await postThroughIngress(stack, headers(requestOrigin(stack)));

      expect(status).toBe(400);
      expect(stack.build.actionCount()).toBe(0);
    });
  });

  it("does not adopt the ingress-forwarded public origin while the switch is off", async () => {
    const stack = await startStack("false");

    const status = await postThroughIngress(stack, { Origin: `http://${publicHost}` });

    expect(status).toBe(400);
    expect(stack.build.actionCount()).toBe(0);
  });
});
