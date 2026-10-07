import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelsConnectionsApiError,
  createChannelsConnectionsRequestApiClient,
  type ChannelConnectionPage,
  type PublicChannelConnection,
} from "./api-client";

const connection: PublicChannelConnection = {
  connectionId: "connection-a",
  providerKey: "fixture-provider",
  environment: "sandbox",
  status: "active",
  createdAt: "2026-09-01T00:00:00.000Z",
};
const page: ChannelConnectionPage = { items: [connection] };
const methods = [
  "listConnections",
  "getConnection",
  "pauseConnection",
  "resumeConnection",
  "disconnectConnection",
] as const;
const malformedBodies = [
  ["HTML", "<!DOCTYPE html><html></html>"],
  ["invalid JSON", "{"],
  ["empty JSON", ""],
  ["null", "null"],
  ["array", "[]"],
  ["string", '"unexpected"'],
  ["number", "42"],
  ["boolean", "true"],
] as const;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Connections request API JSON object boundary", () => {
  for (const method of methods) {
    it.each(malformedBodies)(`${method} rejects a successful %s body with the typed API error`, async (_name, body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              status: 200,
              headers: { "content-type": _name === "HTML" ? "text/html" : "application/json" },
            }),
        ),
      );
      const result = invoke(method);
      await expect(result).rejects.toBeInstanceOf(ChannelsConnectionsApiError);
      await expect(result).rejects.toMatchObject({ status: 200, body: parsedBody(body) });
    });

    it(`${method} preserves valid API objects and forwarded credentials`, async () => {
      vi.stubEnv("CHASE_SETS_INTERNAL_API_ORIGIN", "http://localhost:6412");
      const expected = method === "listConnections" ? page : connection;
      const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json(expected));
      vi.stubGlobal("fetch", fetch);
      await expect(invoke(method)).resolves.toEqual(expected);
      const [url, init] = fetch.mock.calls[0]!;
      const suffix =
        method === "listConnections"
          ? "?status=active&limit=10"
          : `/connection%2Fa${method === "getConnection" ? "" : `/${method.replace("Connection", "")}`}`;
      expect(url).toBe(`http://localhost:6412/api/channels/connections${suffix}`);
      expect(init?.method ?? "GET").toBe(method === "listConnections" || method === "getConnection" ? "GET" : "POST");
      expect(init?.credentials).toBe("include");
      const headers = new Headers(init?.headers);
      expect(headers.get("cookie")).toBe("session=synthetic-buyer");
      expect(headers.get("authorization")).toBe("Bearer synthetic-token");
      expect(headers.get("content-type")).toBe("application/json");
    });

    it.each([404, 409, 503])(`${method} preserves non-2xx status and error bodies (%s)`, async (status) => {
      const body = { error: "synthetic API failure" };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(body, { status })),
      );
      await expect(invoke(method)).rejects.toMatchObject({ status, body, message: "synthetic API failure" });
    });
  }
});

function invoke(method: (typeof methods)[number]) {
  const client = createChannelsConnectionsRequestApiClient(
    new Request("http://localhost:6403/account/channels", {
      headers: { cookie: "session=synthetic-buyer", authorization: "Bearer synthetic-token" },
    }),
  );
  return method === "listConnections"
    ? client[method]({ status: "active", limit: 10 })
    : client[method]("connection/a");
}

function parsedBody(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}
