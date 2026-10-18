import { lookup as lookupDns } from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Readable } from "node:stream";
import type { PgQueryable } from "@chase-sets/event-core-postgres";

const TIMEOUT_MS = 5000;
const BODY_LIMIT = 128 * 1024;
const TTL_MS = 300_000;
const specialUse = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  specialUse.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
] as const) {
  specialUse.addSubnet(address, prefix, "ipv6");
}
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");

export type UcpPlatformProfile = Readonly<Record<string, unknown>> &
  Readonly<{
    keys?: readonly Readonly<Record<string, unknown>>[];
    ucp: Readonly<{
      version: string;
      services: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
      payment_handlers: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
      capabilities?: Readonly<Record<string, readonly Readonly<Record<string, unknown>>[]>>;
    }>;
  }>;
export type UcpProfileFailureCode = "invalid_profile_url" | "profile_unreachable" | "profile_malformed";
export type UcpProfileResolution =
  | Readonly<{ ok: true; profile: UcpPlatformProfile }>
  | Readonly<{ ok: false; code: UcpProfileFailureCode }>;
export type UcpProfileResolver = (profileUrl: string) => Promise<UcpProfileResolution>;
type UcpProfileRequest = (...args: Parameters<typeof httpsRequest>) => ReturnType<typeof httpsRequest>;
export type UcpProfileResolverOptions = Readonly<{
  db: PgQueryable;
  now?: () => Date;
  lookup?: (hostname: string) => Promise<readonly LookupAddress[]>;
  // Only injected test transports can avoid a real, pinned HTTPS connection.
  fetch?: typeof globalThis.fetch;
  request?: UcpProfileRequest;
  onFailure?: (event: Readonly<{ kind: UcpProfileFailureCode; host: string }>) => void;
}>;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function uri(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    return Boolean(new URL(value).protocol);
  } catch {
    return false;
  }
}
const reverseDomainName = /^[a-z](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9_-]*[a-z0-9_])?)+$/;
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function constraint(value: unknown, request = false) {
  const pending = [{ value, request, allowValue: false, nonempty: false }];
  while (pending.length) {
    const item = pending.pop()!;
    if (!object(item.value)) return false;
    const node = item.value;
    const keys = Object.keys(node);
    if (item.nonempty && !keys.length) return false;
    if (item.allowValue && (Object.hasOwn(node, "enum") || Object.hasOwn(node, "const"))) {
      if (keys.some((key) => !["enum", "const"].includes(key))) return false;
      if (
        node.enum !== undefined &&
        (!Array.isArray(node.enum) ||
          !node.enum.length ||
          new Set(node.enum.map(canonicalJson)).size !== node.enum.length)
      )
        return false;
      continue;
    }
    if (keys.some((key) => !["required", "properties", "anyOf", ...(item.request ? ["path"] : [])].includes(key)))
      return false;
    if (node.path !== undefined && typeof node.path !== "string") return false;
    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) ||
        !node.required.length ||
        node.required.some((key) => typeof key !== "string") ||
        new Set(node.required).size !== node.required.length)
    )
      return false;
    if (node.properties !== undefined) {
      if (!object(node.properties) || !Object.keys(node.properties).length) return false;
      for (const value of Object.values(node.properties))
        pending.push({ value, request: false, allowValue: true, nonempty: false });
    }
    if (node.anyOf !== undefined) {
      if (!Array.isArray(node.anyOf) || !node.anyOf.length) return false;
      for (const value of node.anyOf) pending.push({ value, request: false, allowValue: false, nonempty: true });
    }
  }
  return true;
}
function publicKey(value: unknown) {
  if (!object(value) || typeof value.kid !== "string" || typeof value.kty !== "string") return false;
  if (["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((field) => Object.hasOwn(value, field))) return false;
  if (["crv", "x", "y", "alg", "use"].some((field) => value[field] !== undefined && typeof value[field] !== "string"))
    return false;
  if (value.kty === "EC" && ["crv", "x", "y"].some((field) => typeof value[field] !== "string")) return false;
  if (value.kty === "OKP" && ["crv", "x"].some((field) => typeof value[field] !== "string")) return false;
  const algorithm =
    value.crv === "P-256" ? "ES256" : value.crv === "P-384" ? "ES384" : value.crv === "Ed25519" ? "EdDSA" : undefined;
  return !algorithm || value.alg === undefined || value.alg === algorithm;
}
function registry(value: unknown, kind: "service" | "capability" | "payment") {
  return (
    object(value) &&
    Object.entries(value).every(
      ([name, entries]) =>
        reverseDomainName.test(name) &&
        Array.isArray(entries) &&
        entries.every(
          (entry) =>
            object(entry) &&
            typeof entry.version === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(entry.version) &&
            uri(entry.spec) &&
            ((kind === "service" && entry.transport === "a2a" && entry.schema === undefined) || uri(entry.schema)) &&
            (entry.id === undefined || typeof entry.id === "string") &&
            (entry.config === undefined || object(entry.config)) &&
            (kind !== "service" ||
              (["rest", "mcp", "a2a", "embedded"].includes(String(entry.transport)) &&
                (entry.endpoint === undefined || uri(entry.endpoint)))) &&
            (kind !== "capability" ||
              entry.extends === undefined ||
              (typeof entry.extends === "string"
                ? reverseDomainName.test(entry.extends)
                : Array.isArray(entry.extends) &&
                  entry.extends.length > 0 &&
                  entry.extends.every((name) => typeof name === "string" && reverseDomainName.test(name)))) &&
            (kind !== "payment" ||
              (typeof entry.id === "string" &&
                (entry.available_instruments === undefined ||
                  (Array.isArray(entry.available_instruments) &&
                    entry.available_instruments.length > 0 &&
                    entry.available_instruments.every(
                      (instrument) =>
                        object(instrument) &&
                        typeof instrument.type === "string" &&
                        (instrument.constraints === undefined || constraint(instrument.constraints)),
                    ))))),
        ),
    )
  );
}
function validProfile(value: unknown): value is UcpPlatformProfile {
  if (!object(value) || !object(value.ucp)) return false;
  const ucp = value.ucp;
  return (
    typeof ucp.version === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(ucp.version) &&
    registry(ucp.services, "service") &&
    registry(ucp.payment_handlers, "payment") &&
    (ucp.request_constraints === undefined || constraint(ucp.request_constraints, true)) &&
    (ucp.status === undefined || ucp.status === "success" || ucp.status === "error") &&
    (ucp.map_order === undefined ||
      (object(ucp.map_order) &&
        Object.values(ucp.map_order).every(
          (order) => Array.isArray(order) && order.every((key) => typeof key === "string"),
        ))) &&
    (ucp.capabilities === undefined || registry(ucp.capabilities, "capability")) &&
    (value.keys === undefined || (Array.isArray(value.keys) && value.keys.every(publicKey)))
  );
}
function publicAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return !specialUse.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !specialUse.check(address, "ipv6");
}

function fetchPinnedProfile(url: URL, address: LookupAddress, signal: AbortSignal, request: UcpProfileRequest) {
  return new Promise<Response>((resolve, reject) => {
    const client = request(
      url,
      {
        signal,
        agent: false,
        family: address.family,
        servername: isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname,
        headers: { Accept: "application/json" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (response) => {
        const status = response.statusCode ?? 500;
        if (status < 200 || status >= 300) {
          response.destroy();
          resolve(new Response(null, { status }));
          return;
        }
        const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>;
        resolve(new Response(status === 204 || status === 205 ? null : stream, { status }));
      },
    );
    client.on("error", reject);
    client.end();
  });
}

async function readProfile(response: Response, signal: AbortSignal): Promise<UcpProfileResolution> {
  if (signal.aborted) {
    await response.body?.cancel();
    return { ok: false, code: "profile_unreachable" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { ok: false, code: "profile_unreachable" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, code: "profile_malformed" };
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > BODY_LIMIT) {
        await reader.cancel();
        return { ok: false, code: "profile_malformed" };
      }
      chunks.push(value);
    }
    signal.throwIfAborted();
    let profile: unknown;
    try {
      profile = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return { ok: false, code: "profile_malformed" };
    }
    try {
      return validProfile(profile) ? { ok: true, profile } : { ok: false, code: "profile_malformed" };
    } catch {
      return { ok: false, code: "profile_malformed" };
    }
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function createUcpProfileResolver(options: UcpProfileResolverOptions): UcpProfileResolver {
  const inFlight = new Map<string, Promise<UcpProfileResolution>>();
  let activeResolutions = 0;
  const starts: number[] = [];
  const now = () => options.now?.() ?? new Date();
  const testLoopback = (url: URL) =>
    Boolean(options.fetch && !options.lookup && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  function failure(code: UcpProfileFailureCode, host: string): UcpProfileResolution {
    try {
      options.onFailure?.({ kind: code, host });
    } catch {
      /* Logging must not change the boundary. */
    }
    return { ok: false, code };
  }
  async function resolve(url: URL): Promise<UcpProfileResolution> {
    activeResolutions++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<UcpProfileResolution>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failure("profile_unreachable", url.hostname));
      }, TIMEOUT_MS);
    });
    let result: UcpProfileResolution;
    try {
      result = await Promise.race([
        timeout,
        (async (): Promise<UcpProfileResolution> => {
          const instant = now().getTime();
          while (starts.length && starts[0] <= instant - 60_000) starts.shift();
          if (starts.length >= 60) return failure("profile_unreachable", url.hostname);
          const hostname = url.hostname.replace(/^\[|\]$/g, "");
          const family = isIP(hostname);
          let addresses: readonly LookupAddress[];
          try {
            addresses = family
              ? [{ address: hostname, family }]
              : await (options.lookup ?? ((host) => lookupDns(host, { all: true })))(hostname);
          } catch {
            return failure(controller.signal.aborted ? "profile_unreachable" : "invalid_profile_url", url.hostname);
          }
          controller.signal.throwIfAborted();
          if (
            !addresses.length ||
            addresses.some(
              (address) =>
                !publicAddress(address.address) &&
                !(testLoopback(url) && ["127.0.0.1", "::1"].includes(address.address)),
            )
          ) {
            return failure("invalid_profile_url", url.hostname);
          }
          // Recheck after DNS: parallel resolutions may have started in the meantime.
          while (starts.length && starts[0] <= now().getTime() - 60_000) starts.shift();
          if (starts.length >= 60) return failure("profile_unreachable", url.hostname);
          starts.push(now().getTime());
          const response = options.fetch
            ? await options.fetch(url.href, {
                headers: { Accept: "application/json" },
                redirect: "manual",
                signal: controller.signal,
              })
            : await fetchPinnedProfile(url, addresses[0], controller.signal, options.request ?? httpsRequest);
          const result = await readProfile(response, controller.signal);
          if (!result.ok) return failure(result.code, url.hostname);
          controller.signal.throwIfAborted();
          return result;
        })()
          .catch(() => failure("profile_unreachable", url.hostname))
          .finally(() => {
            activeResolutions--;
          }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
    if (!result.ok) return result;
    const fetchedAt = now();
    try {
      await options.db.query(
        `INSERT INTO platform_ucp_agent_profiles (profile_url, profile, fetched_at, expires_at, last_error, updated_at)
         VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz, NULL, now())
         ON CONFLICT (profile_url) DO UPDATE SET profile = EXCLUDED.profile, fetched_at = EXCLUDED.fetched_at,
         expires_at = EXCLUDED.expires_at, last_error = NULL, updated_at = EXCLUDED.updated_at`,
        [
          url.href,
          JSON.stringify(result.profile),
          fetchedAt.toISOString(),
          new Date(fetchedAt.getTime() + TTL_MS).toISOString(),
        ],
      );
    } catch {
      return failure("profile_unreachable", url.hostname);
    }
    return result;
  }
  return async (profileUrl) => {
    let url: URL;
    try {
      url = new URL(profileUrl);
    } catch {
      return Promise.resolve(failure("invalid_profile_url", ""));
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (isIP(url.hostname.replace(/^\[|\]$/g, "")) &&
        !publicAddress(url.hostname.replace(/^\[|\]$/g, "")) &&
        !testLoopback(url))
    ) {
      return Promise.resolve(failure("invalid_profile_url", url.hostname));
    }
    const existing = inFlight.get(url.href);
    if (existing) return existing;
    try {
      const cached = await options.db.query<{ profile: unknown; expires_at: Date | string }>(
        `SELECT profile, expires_at FROM platform_ucp_agent_profiles WHERE profile_url = $1`,
        [url.href],
      );
      const row = cached.rows[0];
      if (row && new Date(row.expires_at).getTime() > now().getTime() && validProfile(row.profile)) {
        return { ok: true, profile: row.profile };
      }
    } catch {
      return failure("profile_unreachable", url.hostname);
    }
    const shared = inFlight.get(url.href);
    if (shared) return shared;
    if (activeResolutions >= 4 || inFlight.size >= 4) return failure("profile_unreachable", url.hostname);
    const pending = resolve(url).finally(() => inFlight.delete(url.href));
    inFlight.set(url.href, pending);
    return pending;
  };
}
