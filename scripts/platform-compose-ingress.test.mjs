import { connect } from "node:net";
import { describe, expect, it } from "vitest";
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
