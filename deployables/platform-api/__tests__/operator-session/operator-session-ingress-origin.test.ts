import catalogManifest from "@chase-sets/catalog/context";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import { serve } from "@hono/node-server";
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminPath, mounted } from "./fixture";

const publicHost = "admin.staging.chasesets.com";
const publicOrigin = `https://${publicHost}`;
const methods = ["POST", "DELETE"] as const;
const trustModes = ["true", undefined] as const;

function refusedPool() {
  const connect = vi.fn(async () => {
    throw new Error("synthetic-custody-refusal");
  });
  const query = vi.fn(async () => {
    throw new Error("unexpected unbound query");
  });
  const pool: PgTransactionalPool = { connect, query };
  return { pool, connect, query };
}

describe.each(methods)("%s operator-session ingress origin", (method) => {
  let server: ReturnType<typeof serve> | undefined;
  let port: number;
  let custody: ReturnType<typeof refusedPool>;

  beforeEach(async () => {
    vi.stubEnv("CHASE_SETS_TRUST_FORWARDED_HEADERS", undefined);
    custody = refusedPool();
    const app = mounted(catalogManifest, custody.pool);
    await new Promise<void>((resolve) => {
      server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, (address) => {
        port = address.port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    try {
      if (server) {
        const active = server;
        await new Promise<void>((resolve, reject) => active.close((error) => (error ? reject(error) : resolve())));
      }
    } finally {
      server = undefined;
      vi.unstubAllEnvs();
    }
  });

  async function write(headers: Record<string, string>, admitted: boolean) {
    custody.connect.mockClear();
    const response = await new Promise<{ status: number | undefined; body: string }>((resolve, reject) => {
      const outgoing = request(
        {
          hostname: "127.0.0.1",
          port,
          method,
          path: method === "POST" ? `${adminPath}/grant` : adminPath,
          headers,
        },
        (incoming) => {
          let body = "";
          incoming.setEncoding("utf8");
          incoming.on("data", (chunk: string) => (body += chunk));
          incoming.on("end", () => resolve({ status: incoming.statusCode, body }));
          incoming.on("error", reject);
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
    const control = `${method} trust=${process.env.CHASE_SETS_TRUST_FORWARDED_HEADERS} origin=${headers.origin}`;
    expect.soft(response.status, control).toBe(admitted ? 503 : 403);
    expect.soft(JSON.parse(response.body), control).toEqual({ code: admitted ? "custody-unavailable" : "forbidden" });
    expect.soft(custody.connect, control).toHaveBeenCalledTimes(admitted ? 1 : 0);
    expect.soft(custody.query, control).not.toHaveBeenCalled();
  }

  function ingressHeaders() {
    return {
      host: publicHost,
      "x-forwarded-proto": "https",
      "x-forwarded-host": publicHost,
      "x-forwarded-port": "443",
      "sec-fetch-site": "same-origin",
      origin: publicOrigin,
    };
  }

  it("admits same-origin writes behind TLS-terminating ingress", async () => {
    for (const trust of trustModes) {
      vi.stubEnv("CHASE_SETS_TRUST_FORWARDED_HEADERS", trust);
      await write(ingressHeaders(), true);
    }
  });

  it("still refuses foreign origins over the real server", async () => {
    for (const trust of trustModes) {
      vi.stubEnv("CHASE_SETS_TRUST_FORWARDED_HEADERS", trust);
      await write(ingressHeaders(), true);
      for (const origin of ["https://foreign.example", "null", undefined]) {
        const headers: Record<string, string> = ingressHeaders();
        if (origin === undefined) delete headers.origin;
        else headers.origin = origin;
        await write(headers, false);
      }
      await write({ ...ingressHeaders(), "sec-fetch-site": "cross-site" }, false);
    }
  });

  it("honours the forwarded-header trust boundary for host", async () => {
    const headers = { ...ingressHeaders(), "x-forwarded-host": "evil.example", origin: "https://evil.example" };
    for (const trust of trustModes) {
      vi.stubEnv("CHASE_SETS_TRUST_FORWARDED_HEADERS", trust);
      await write(headers, trust === "true");
    }
  });

  it("honours the forwarded-header trust boundary for protocol", async () => {
    const headers = {
      host: `127.0.0.1:${port}`,
      "x-forwarded-proto": "https",
      "x-forwarded-port": "443",
      "sec-fetch-site": "same-origin",
    };
    for (const [trust, protocol, admitted] of [
      ["true", "https", true],
      ["true", "http", false],
      [undefined, "https", false],
      [undefined, "http", true],
    ] as const) {
      vi.stubEnv("CHASE_SETS_TRUST_FORWARDED_HEADERS", trust);
      await write({ ...headers, origin: `${protocol}://127.0.0.1:${port}` }, admitted);
    }
  });
});
