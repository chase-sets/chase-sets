import { EventEmitter } from "node:events";
import type { request } from "node:https";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import { createUcpProfileResolver, type UcpProfileResolverOptions } from "./ucp-profile-resolver";
import { UCP_VERSION } from "./ucp-contracts";

const profile = { ucp: { version: UCP_VERSION, services: {}, payment_handlers: {}, capabilities: {} } };
const publicAddress = { address: "8.8.8.8", family: 4 };
const lookup = vi.fn(async () => [publicAddress]);

function profileDb() {
  const rows = new Map<string, { profile: unknown; expires_at: string }>();
  const writes = vi.fn();
  const db: PgQueryable = {
    async query<Row>(sql: string, values: readonly unknown[] = []) {
      if (sql.includes("SELECT")) {
        const row = rows.get(String(values[0]));
        return { rows: row ? [row as Row] : [], rowCount: row ? 1 : 0 };
      }
      writes(values);
      rows.set(String(values[0]), { profile: JSON.parse(String(values[1])), expires_at: String(values[3]) });
      return { rows: [], rowCount: 1 };
    },
  };
  return { db, rows, writes };
}

afterEach(() => vi.useRealTimers());

describe("bounded UCP platform profile resolver", () => {
  it("permits loopback only through an injected test fetch, never the production transport", async () => {
    const { db } = profileDb();
    const fetch = vi.fn(async () => Response.json(profile));
    const testResolve = createUcpProfileResolver({ db, fetch });
    expect(await testResolve("https://127.0.0.1/profile")).toMatchObject({ ok: true });
    const productionResolve = createUcpProfileResolver({ db });
    expect(await productionResolve("https://127.0.0.1/profile")).toMatchObject({
      ok: false,
      code: "invalid_profile_url",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    "http://public.example/profile",
    "https://127.0.0.1/profile",
    "https://169.254.169.254/profile",
    "https://10.0.0.1/profile",
    "https://[::1]/profile",
    "https://[::ffff:127.0.0.1]/profile",
    "https://192.0.2.1/profile",
    "https://[2001:db8::1]/profile",
    "https://user:secret@public.example/profile",
  ])("rejects special-use or non-HTTPS URLs without fetching or persisting: %s", async (url) => {
    const { db, writes } = profileDb();
    const fetch = vi.fn(async () => Response.json(profile));
    const resolve = createUcpProfileResolver({ db, lookup, fetch });
    expect(await resolve(url)).toMatchObject({ ok: false, code: "invalid_profile_url" });
    expect(fetch).not.toHaveBeenCalled();
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([[{ address: "10.0.0.1", family: 4 }], [publicAddress, { address: "169.254.169.254", family: 4 }]])(
    "rejects a hostname if any DNS answer is special-use",
    async (...addresses) => {
      const { db, writes } = profileDb();
      const fetch = vi.fn(async () => Response.json(profile));
      const resolve = createUcpProfileResolver({ db, lookup: async () => addresses, fetch });
      expect(await resolve("https://platform.example/profile")).toMatchObject({
        ok: false,
        code: "invalid_profile_url",
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(writes).not.toHaveBeenCalled();
    },
  );

  it("pins the connection to the validated first answer, never contacting a rebinding second answer", async () => {
    const { db } = profileDb();
    const dns = vi
      .fn()
      .mockResolvedValueOnce([publicAddress])
      .mockResolvedValue([{ address: "10.0.0.1", family: 4 }]);
    const contacted: string[] = [];
    const nodeRequest = vi.fn<NonNullable<UcpProfileResolverOptions["request"]>>((url, options, callback) => {
      expect(String(url)).toBe("https://platform.example/profile");
      expect(options.servername).toBe("platform.example");
      expect(options.agent).toBe(false);
      const client = new EventEmitter() as ReturnType<typeof request>;
      client.destroy = vi.fn(() => client);
      client.end = vi.fn(() => {
        const connect = async () => {
          if (!options.lookup) {
            contacted.push((await dns())[0].address);
          } else {
            options.lookup("platform.example", {}, (_error, address) => contacted.push(String(address)));
          }
          const response = Readable.from([Buffer.from(JSON.stringify(profile))]);
          callback?.(Object.assign(response, { statusCode: 200, headers: {} }) as never);
        };
        void connect();
        return client;
      });
      return client;
    });
    const resolve = createUcpProfileResolver({ db, lookup: dns, request: nodeRequest });
    expect(await resolve("https://platform.example/profile")).toMatchObject({ ok: true });
    expect(dns).toHaveBeenCalledTimes(1);
    expect(contacted).toEqual(["8.8.8.8"]);
  });

  it.each([
    ["redirect", () => new Response("", { status: 302 }), "profile_unreachable"],
    ["404", () => new Response("", { status: 404 }), "profile_unreachable"],
    ["500", () => new Response("", { status: 500 }), "profile_unreachable"],
    ["129 KiB", () => new Response(" ".repeat(129 * 1024)), "profile_malformed"],
    ["bad JSON", () => new Response("{"), "profile_malformed"],
    ["bad schema", () => Response.json({}), "profile_malformed"],
  ] as const)("rejects %s without a cache row", async (_name, response, code) => {
    const { db, writes } = profileDb();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
    const resolve = createUcpProfileResolver({ db, lookup, fetch });
    expect(await resolve("https://platform.example/profile")).toMatchObject({ ok: false, code });
    expect(writes).not.toHaveBeenCalled();
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("shares concurrent misses and expires valid cache entries at 300 seconds", async () => {
    const { db, writes } = profileDb();
    const fetch = vi.fn(async () => Response.json(profile));
    let now = new Date("2026-10-13T00:00:00Z");
    const resolve = createUcpProfileResolver({ db, lookup, fetch, now: () => now });
    await Promise.all([resolve("https://platform.example/profile"), resolve("https://platform.example/profile")]);
    now = new Date("2026-10-13T00:04:59Z");
    expect(await resolve("https://platform.example/profile")).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(writes).toHaveBeenCalledTimes(1);
    now = new Date("2026-10-13T00:05:00Z");
    await resolve("https://platform.example/profile");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not persist failures and permits a subsequent recovery", async () => {
    const { db, writes } = profileDb();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockImplementation(async () => Response.json(profile));
    const resolve = createUcpProfileResolver({ db, lookup, fetch });
    expect(await resolve("https://platform.example/profile")).toMatchObject({ ok: false });
    expect(writes).not.toHaveBeenCalled();
    expect(await resolve("https://platform.example/profile")).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("serves a valid cached profile even while four other URLs are fetching", async () => {
    const { db, rows } = profileDb();
    rows.set("https://platform.example/cached", { profile, expires_at: "2099-01-01T00:00:00Z" });
    const releases: (() => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => releases.push(() => resolve(Response.json(profile)))));
    const resolve = createUcpProfileResolver({ db, lookup, fetch });
    const pending = [0, 1, 2, 3].map((id) => resolve(`https://platform.example/${id}`));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(await resolve("https://platform.example/cached")).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(4);
    releases.forEach((release) => release());
    await Promise.all(pending);
  });

  it("never writes a late success after the unchanged deadline has expired", async () => {
    vi.useFakeTimers();
    const { db, writes } = profileDb();
    let finish!: (response: Response) => void;
    const resolve = createUcpProfileResolver({
      db,
      lookup,
      fetch: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = resolve("https://platform.example/profile");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ ok: false, code: "profile_unreachable" });
    finish(Response.json(profile));
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).not.toHaveBeenCalled();
  });

  it.each([
    { ...profile, ucp: { ...profile.ucp, capabilities: { invalid: [] } } },
    { ...profile, ucp: { ...profile.ucp, capabilities: { "dev.ucp.shopping.checkout": [{ version: UCP_VERSION }] } } },
    { ...profile, keys: [{ kid: "key", kty: "EC" }] },
    { ...profile, keys: [{ kid: "key", kty: "unknown", d: "synthetic-private-material" }] },
    { ...profile, ucp: { ...profile.ucp, request_constraints: { required: [] } } },
    {
      ...profile,
      ucp: {
        ...profile.ucp,
        request_constraints: {
          properties: {
            test: {
              enum: [
                { a: 1, b: 2 },
                { b: 2, a: 1 },
              ],
            },
          },
        },
      },
    },
    {
      ...profile,
      ucp: {
        ...profile.ucp,
        payment_handlers: {
          "com.example.payment": [
            {
              id: "payment",
              version: UCP_VERSION,
              spec: "https://example.com/spec",
              schema: "https://example.com/schema",
              available_instruments: "not-an-array",
            },
          ],
        },
      },
    },
  ])("rejects invalid registries or non-public keys without persistence", async (invalid) => {
    const { db, writes } = profileDb();
    const resolve = createUcpProfileResolver({ db, lookup, fetch: async () => Response.json(invalid) });
    expect(await resolve("https://platform.example/profile")).toMatchObject({ ok: false, code: "profile_malformed" });
    expect(writes).not.toHaveBeenCalled();
  });

  it("accepts forward-compatible public keys and A2A services without a schema or endpoint", async () => {
    const { db } = profileDb();
    const valid = {
      ...profile,
      keys: [{ kid: "key", kty: "future" }],
      ucp: {
        ...profile.ucp,
        services: { "dev.ucp.shopping": [{ version: UCP_VERSION, transport: "a2a", spec: "https://ucp.dev/spec" }] },
      },
    };
    const resolve = createUcpProfileResolver({ db, lookup, fetch: async () => Response.json(valid) });
    expect(await resolve("https://platform.example/profile")).toMatchObject({ ok: true });
  });

  it("legacy negative control: canonical keys verify despite aliases and legacy-only keys remain non-authoritative", async () => {
    const { db } = profileDb();
    const canonical = {
      ...profile,
      keys: [{ kid: "key", kty: "EC", crv: "P-256", x: "x", y: "y" }],
      signing_keys: [{ kid: "legacy", kty: "EC", crv: "P-256", x: "x", y: "y" }],
      ucp: { ...profile.ucp, signing_keys: [{ kid: "legacy", kty: "EC", crv: "P-256", x: "x", y: "y" }] },
    };
    const resolveCanonical = createUcpProfileResolver({ db, lookup, fetch: async () => Response.json(canonical) });
    expect(await resolveCanonical("https://platform.example/canonical")).toMatchObject({ ok: true });

    const legacyOnly = { ...profile, keys: undefined, signing_keys: canonical.signing_keys };
    const resolveLegacy = createUcpProfileResolver({ db, lookup, fetch: async () => Response.json(legacyOnly) });
    expect(await resolveLegacy("https://platform.example/legacy-only")).toMatchObject({ ok: true });
  });

  it("logs only the failure kind and host, never the URL or raw exception", async () => {
    const { db, writes } = profileDb();
    const onFailure = vi.fn();
    const resolve = createUcpProfileResolver({
      db,
      lookup,
      onFailure,
      fetch: async () => {
        throw new Error("synthetic-secret-detail");
      },
    });
    await resolve("https://platform.example/synthetic-sensitive-path?token=synthetic-sensitive-query");
    expect(onFailure).toHaveBeenCalledWith({ kind: "profile_unreachable", host: "platform.example" });
    expect(writes).not.toHaveBeenCalled();
  });

  it("keeps timed-out uncancellable DNS work inside the four-operation bound", async () => {
    vi.useFakeTimers();
    const { db } = profileDb();
    const dns = vi.fn(() => new Promise<never>(() => {}));
    const resolve = createUcpProfileResolver({ db, lookup: dns });
    const pending = [0, 1, 2, 3].map((id) => resolve(`https://platform.example/${id}`));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 4 }, () => ({ ok: false, code: "profile_unreachable" })),
    );
    expect(await resolve("https://platform.example/fifth")).toMatchObject({ ok: false, code: "profile_unreachable" });
    expect(dns).toHaveBeenCalledTimes(4);
  });

  it("refuses the 61st fetch start and resets the rolling window after a minute", async () => {
    const { db, writes } = profileDb();
    let now = new Date("2026-10-13T00:00:00Z");
    const fetch = vi.fn(async () => new Response("", { status: 500 }));
    const resolve = createUcpProfileResolver({ db, lookup, fetch, now: () => now });
    for (let i = 0; i < 60; i++) await resolve(`https://platform.example/${i}`);
    expect(await resolve("https://platform.example/61")).toMatchObject({ ok: false, code: "profile_unreachable" });
    expect(fetch).toHaveBeenCalledTimes(60);
    expect(writes).not.toHaveBeenCalled();
    now = new Date("2026-10-13T00:01:00Z");
    await resolve("https://platform.example/61");
    expect(fetch).toHaveBeenCalledTimes(61);
  });

  it("refuses a fifth concurrent fetch without growing single-flight state", async () => {
    const { db, writes } = profileDb();
    const releases: (() => void)[] = [];
    const fetch = vi.fn(() => new Promise<Response>((resolve) => releases.push(() => resolve(Response.json(profile)))));
    const resolve = createUcpProfileResolver({ db, lookup, fetch });
    const pending = [0, 1, 2, 3].map((id) => resolve(`https://platform.example/${id}`));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(await resolve("https://platform.example/5")).toMatchObject({ ok: false, code: "profile_unreachable" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(writes).not.toHaveBeenCalled();
    releases.forEach((release) => release());
    await Promise.all(pending);
  });

  it("times out DNS and streaming bodies within one unchanged 5 second budget", async () => {
    vi.useFakeTimers();
    for (const slowDns of [true, false]) {
      const { db, writes } = profileDb();
      const fetch = vi.fn(async () => new Response(new ReadableStream({ start() {} })));
      const resolve = createUcpProfileResolver({ db, fetch, lookup: slowDns ? () => new Promise(() => {}) : lookup });
      const pending = resolve("https://platform.example/profile");
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toMatchObject({ ok: false, code: "profile_unreachable" });
      expect(writes).not.toHaveBeenCalled();
      if (slowDns) expect(fetch).not.toHaveBeenCalled();
    }
  });
});
