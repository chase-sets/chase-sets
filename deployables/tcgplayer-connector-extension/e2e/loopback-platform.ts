import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import { linkIntentOrigins } from "@chase-sets/platform-runtime/link-intents";
import { syntheticClaim } from "../__tests__/harness/claim";
import { fakeDocumentMarkerName, type FakeDocumentResponse, type PairingDrillResolver } from "./pairing-drill";

export const synthetic = {
  cookieName: "synthetic_connector_session",
  cookieValue: "synthetic-session-cookie-marker",
  access: "cc_at_synthetic-retained-secret-marker",
  refresh: "cc_rt_synthetic-retained-secret-marker",
  code: "synthetic-authorization-code-marker",
  clientId: "cc_client_synthetic",
};
export const closedErrors = ["authorization_refused", "pairing_code_missing", "pairing_code_ambiguous"] as const;
export type SyntheticClaimResponse = "reservation" | "invalid-credential" | "empty";

const connectorPath = "/channel-connector/oauth/connections/connection_synthetic";

/** True when a report body carries outcomes and every one is `abandoned`. */
function reportsAbandoned(raw: string) {
  try {
    const { outcomes } = JSON.parse(raw) as { outcomes?: unknown };
    return (
      Array.isArray(outcomes) &&
      outcomes.length > 0 &&
      outcomes.every((row: { outcome?: { kind?: unknown } } | null) => row?.outcome?.kind === "abandoned")
    );
  } catch {
    return false;
  }
}

export async function loopbackPlatform(
  options: {
    port?: number;
    requirePairingCode?: boolean;
    handle?: (request: IncomingMessage, reply: ServerResponse) => Promise<boolean>;
    /** Opt-in claim responses, served in order and then `empty`; absent leaves claim and report unserved. */
    claims?: readonly SyntheticClaimResponse[];
  } = {},
) {
  let response: "success" | "hold" | (typeof closedErrors)[number] = "success";
  let authorizeCount = 0;
  let tokenCount = 0;
  let cookieArrived = false;
  let queryClosed = false;
  let tokenClosed = false;
  let state = "";
  let challenge = "";
  let verifier = "";
  let release: (() => void) | undefined;
  let pairingExpiresAt = 0;
  let authorizationExpiresAt = 0;
  let tokenConsumed = false;
  // Drill counters are bumped only by the request handlers below.
  const drill = {
    requestCount: 0,
    pairingCodeCount: 0,
    tokenCookieArrived: false,
    claimCount: 0,
    reservationClaimCount: 0,
    invalidCredentialClaimCount: 0,
    claimCookieArrived: false,
    reportCount: 0,
    abandonedReportCount: 0,
    channelPageServed: 0,
    pageStatus: null as number | null,
  };
  const claims = [...(options.claims ?? [])];
  const serve = async (request: IncomingMessage, reply: ServerResponse) => {
    drill.requestCount++;
    reply.setHeader("Connection", "close");
    if (await options.handle?.(request, reply)) return;
    const url = new URL(request.url!, "http://127.0.0.1");
    reply.setHeader("Cache-Control", "no-store");
    if (url.pathname === "/api/channels/connections/connection_synthetic/connector-pairing/code") {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      if (
        request.method !== "POST" ||
        raw !== "{}" ||
        !request.headers.cookie?.split("; ").includes(`${synthetic.cookieName}=${synthetic.cookieValue}`)
      ) {
        reply.writeHead(400).end();
        return;
      }
      pairingExpiresAt = Date.now() + 600000;
      drill.pairingCodeCount++;
      reply.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          pairingId: "synthetic-pairing",
          revision: 1,
          code: "SYNTHETIC_PAIRING_CODE",
          expiresAt: new Date(pairingExpiresAt).toISOString(),
        }),
      );
      return;
    }
    if (url.pathname === "/channel-connector/oauth/authorize") {
      authorizeCount++;
      const query = url.searchParams;
      const keys = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"];
      queryClosed =
        request.method === "GET" &&
        [...query.keys()].length === keys.length &&
        keys.every((key) => query.getAll(key).length === 1) &&
        query.get("response_type") === "code" &&
        query.get("client_id") === synthetic.clientId &&
        query.get("redirect_uri") === TCGPLAYER_CONNECTOR_REDIRECT_URI &&
        query.get("code_challenge_method") === "S256" &&
        /^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "") &&
        /^[A-Za-z0-9_-]{43}$/.test(query.get("state") ?? "");
      cookieArrived =
        request.headers.cookie?.split("; ").includes(`${synthetic.cookieName}=${synthetic.cookieValue}`) ?? false;
      if (!queryClosed || !cookieArrived || (options.requirePairingCode && pairingExpiresAt <= Date.now())) {
        reply.writeHead(400);
        reply.end();
        return;
      }
      state = query.get("state")!;
      challenge = query.get("code_challenge")!;
      if (options.requirePairingCode) {
        pairingExpiresAt = 0;
        authorizationExpiresAt = Date.now() + 600000;
        tokenConsumed = false;
      }
      if (response === "hold")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const callback = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI);
      callback.searchParams.set("state", state);
      if (response === "success" || response === "hold") callback.searchParams.set("code", synthetic.code);
      else {
        callback.searchParams.set("error", "access_denied");
        callback.searchParams.set("error_description", response);
      }
      reply.writeHead(302, { Location: callback.href });
      reply.end();
      return;
    }
    if (url.pathname === "/channel-connector/oauth/token") {
      tokenCount++;
      if (request.headers.cookie) drill.tokenCookieArrived = true;
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      verifier = body.code_verifier;
      tokenClosed =
        request.method === "POST" &&
        Object.keys(body).sort().join() ===
          ["grant_type", "client_id", "redirect_uri", "code", "code_verifier"].sort().join() &&
        body.grant_type === "authorization_code" &&
        body.client_id === synthetic.clientId &&
        body.redirect_uri === TCGPLAYER_CONNECTOR_REDIRECT_URI &&
        body.code === synthetic.code &&
        typeof verifier === "string" &&
        createHash("sha256").update(verifier).digest("base64url") === challenge &&
        (!options.requirePairingCode || (!tokenConsumed && authorizationExpiresAt > Date.now()));
      if (tokenClosed) tokenConsumed = true;
      reply.writeHead(tokenClosed ? 200 : 400, { "Content-Type": "application/json" });
      reply.end(
        JSON.stringify(
          tokenClosed
            ? {
                access_token: synthetic.access,
                refresh_token: synthetic.refresh,
                token_type: "Bearer",
                expires_in: 3600,
                scope: "channel-connector:claim channel-connector:report channel-connector:ingest",
                connection_id: "connection_synthetic",
              }
            : { error: "invalid-request" },
        ),
      );
      return;
    }
    if (options.claims && [`${connectorPath}/claim`, `${connectorPath}/report`].includes(url.pathname)) {
      const claim = url.pathname.endsWith("/claim");
      if (claim) drill.claimCount++;
      if (claim && request.headers.cookie) drill.claimCookieArrived = true;
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const next =
        request.method !== "POST" || request.headers.authorization !== `Bearer ${synthetic.access}`
          ? "invalid-credential"
          : claim
            ? (claims.shift() ?? "empty")
            : "report";
      reply.setHeader("Content-Type", "application/json");
      if (next === "invalid-credential") {
        if (claim) drill.invalidCredentialClaimCount++;
        reply.writeHead(401).end(JSON.stringify({ error: "invalid-credential" }));
        return;
      }
      if (next === "report") {
        drill.reportCount++;
        if (reportsAbandoned(raw)) drill.abandonedReportCount++;
        reply.writeHead(200).end("{}");
        return;
      }
      if (next === "reservation") drill.reservationClaimCount++;
      reply
        .writeHead(200)
        .end(JSON.stringify({ reservation: next === "reservation" ? syntheticClaim() : null, pollWindowSeconds: 30 }));
      return;
    }
    if (url.pathname.startsWith("/account/channels")) {
      reply.end("<!doctype html><title>Channels</title>");
      if (url.pathname === "/account/channels/connection_synthetic") {
        drill.channelPageServed++;
        drill.pageStatus = reply.statusCode;
      }
      return;
    }
    reply.writeHead(404);
    reply.end();
  };
  const server = createServer((request, reply) => {
    serve(request, reply).catch((error: unknown) => {
      // Rethrow as uncaught so the runner fails exactly as the unhandled rejection did.
      setImmediate(() => {
        throw error;
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback-listen-refused");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    select(value: typeof response) {
      response = value;
      authorizeCount = 0;
      tokenCount = 0;
      cookieArrived = false;
      queryClosed = false;
      tokenClosed = false;
    },
    release: () => {
      release?.();
    },
    observation: () => ({ authorizeCount, tokenCount, cookieArrived, queryClosed, tokenClosed }),
    drillObservation: () => ({ ...drill }),
    forbidden: () => [
      synthetic.cookieName,
      synthetic.cookieValue,
      synthetic.access,
      synthetic.refresh,
      synthetic.code,
      "synthetic-file-body-marker",
      ...(verifier ? [verifier] : []),
    ],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** Issues a synthetic pairing code and returns the served `pairingId`. */
export async function createSyntheticPairingCode(origin: string): Promise<string> {
  const response = await fetch(`${origin}/api/channels/connections/connection_synthetic/connector-pairing/code`, {
    method: "POST",
    redirect: "error",
    headers: { Cookie: `${synthetic.cookieName}=${synthetic.cookieValue}`, "Content-Type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new Error("synthetic-pairing-code-refused");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("pairingId" in body) || typeof body.pairingId !== "string")
    throw new Error("synthetic-pairing-code-refused");
  return body.pairingId;
}

const stagingOrigin = linkIntentOrigins["marketplace-web"].staging;

/** A DER element: tag, definite length, body. */
function der(tag: number, ...parts: Buffer[]) {
  const body = Buffer.concat(parts);
  const length =
    body.length < 0x80
      ? [body.length]
      : body.length < 0x100
        ? [0x81, body.length]
        : [0x82, body.length >> 8, body.length & 0xff];
  return Buffer.concat([Buffer.from([tag, ...length]), body]);
}
const oid = (hex: string) => der(0x06, Buffer.from(hex, "hex"));
const ecdsaWithSha256 = () => der(0x30, oid("2a8648ce3d040302"));
const commonName = (host: string) => der(0x30, der(0x31, der(0x30, oid("550403"), der(0x0c, Buffer.from(host)))));
const utcTime = (at: number) =>
  der(0x17, Buffer.from(`${new Date(at).toISOString().replace(/[-:T]/g, "").slice(2, 14)}Z`));

/**
 * A throwaway self-signed P-256 certificate naming only `host`, minted per run so no key is ever committed.
 * Chromium trusts it only through its SPKI digest, Node only through the PEM as `ca`.
 */
export function drillTestCertificate(host = new URL(stagingOrigin).hostname) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const now = Date.now();
  const tbs = der(
    0x30,
    der(0xa0, der(0x02, Buffer.from([2]))),
    der(0x02, Buffer.concat([Buffer.from([1]), randomBytes(8)])),
    ecdsaWithSha256(),
    commonName(host),
    der(0x30, utcTime(now - 86_400_000), utcTime(now + 7 * 86_400_000)),
    commonName(host),
    spki,
    der(0xa3, der(0x30, der(0x30, oid("551d11"), der(0x04, der(0x30, der(0x82, Buffer.from(host))))))),
  );
  const certificate = der(0x30, tbs, ecdsaWithSha256(), der(0x03, Buffer.from([0]), sign("sha256", tbs, privateKey)));
  return {
    certificatePem: `-----BEGIN CERTIFICATE-----\n${certificate
      .toString("base64")
      .match(/.{1,64}/g)!
      .join("\n")}\n-----END CERTIFICATE-----\n`,
    keyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    certificateSpki: createHash("sha256").update(spki).digest("base64"),
  };
}

/** Unmistakably synthetic staging identities; a receipt carrying them can only come from the fake. */
export const stagingSynthetic = {
  clientId: "cc_client_00000000-0000-4000-8000-000000000000",
  storageLocationId: "storage_location_synthetic",
  personaAlias: "synthetic-persona",
};

export type StagingFakeOptions = Readonly<{
  /** Control: pause answers 200 but leaves the connection active. */
  pauseIgnored?: boolean;
  /** Control: the token binds this connection id instead of the stored one. */
  tokenConnectionId?: string;
  /** Control: a paused claim serves a reservation. */
  pausedReservation?: boolean;
  /** Control: the pairing panel's Unpair is refused. */
  unpairIgnored?: boolean;
  /** A subresource every account page embeds; its origin must be aborted, never fetched. */
  pageSubresource?: string;
  /**
   * The connection page's pairing-panel markup for the current pairing detail. The browser spec owns it, so the
   * fake's own module renders no form; this server handles the posted `intent` like the panel's route action.
   */
  pairingPanel?: (detail: Readonly<{ state: string; pairingId: string | null; revision: number | null }>) => string;
  handle?: (request: IncomingMessage, reply: ServerResponse) => Promise<boolean>;
}>;
/** One served request: what it was, whether Chromium sent it, and whether it carried the session cookie. */
export type StagingFakeRow = Readonly<{
  step: string;
  method: string;
  browser: boolean;
  session: boolean;
  status: number;
}>;
type FakeConnection = { connectionId: string; providerKey: string; status: string; storageLocationIds: string[] };

/** A response intent is not evidence. Only finish publishes a row; the document proves receipt separately. */
export function createFakeDocumentRecorder() {
  let sequence = 0;
  const responses: FakeDocumentResponse[] = [];
  return {
    sequence: () => sequence,
    responses: () => [...responses],
    begin(request: IncomingMessage, reply: ServerResponse, session: boolean) {
      if (sequence >= 512) throw new Error("connector-drill-fake-document-limit");
      const responseSequence = ++sequence;
      const marker = randomUUID();
      const host = request.headers.host ?? "";
      const path = request.url ?? "";
      const method = request.method ?? "";
      reply.once("finish", () => {
        const row = {
          sequence: responseSequence,
          marker,
          host,
          path,
          method,
          status: reply.statusCode,
          session,
          completed: "finish",
        } as const;
        responses.push(row);
        console.log(
          `CONNECTOR_DRILL_FAKE_RESPONSE ${JSON.stringify({ ...row, path: path.replace(/^\/account\/channels\/[^/?]+$/, "/account/channels/<connectionId>") })}`,
        );
      });
      return `<meta name="${fakeDocumentMarkerName}" content="${marker}">`;
    },
  };
}

/**
 * The deployed staging host's fake, served over TLS with a per-run test certificate. The drill reaches it only
 * through `resolver`: Chromium maps the exact staging host to it and trusts the certificate's SPKI, and the Node
 * preflight resolves the host to it and trusts the PEM. Every receipt through it says `origin: "fake"`.
 */
export async function stagingFakePlatform(options: StagingFakeOptions = {}) {
  const certificate = drillTestCertificate();
  const session = `${synthetic.cookieName}=${synthetic.cookieValue}`;
  const rows: StagingFakeRow[] = [];
  const documents = createFakeDocumentRecorder();
  const connections = new Map<string, FakeConnection>();
  const pairing = {
    state: "unpaired" as "unpaired" | "code" | "authorized" | "paired",
    connectionId: "",
    pairingId: null as string | null,
    revision: 0,
    expiresAt: 0,
  };
  let challenge = "";
  let verifier = "";
  let sequence = 0;
  const detail = (connectionId: string) => ({
    state: pairing.connectionId !== connectionId ? "unpaired" : pairing.state === "authorized" ? "code" : pairing.state,
    pairingId: pairing.connectionId === connectionId ? pairing.pairingId : null,
    revision: pairing.connectionId === connectionId ? pairing.revision : null,
    codeExpiresAt: null,
    lastSeenAt: null,
  });
  const accountPage = (connectionId?: string) =>
    [
      "<!doctype html><title>Channels</title>",
      options.pageSubresource ? `<link rel="stylesheet" href="${options.pageSubresource}">` : "",
      connectionId ? (options.pairingPanel?.(detail(connectionId)) ?? "") : "<p>Channels</p>",
    ].join("");

  const serve = async (request: IncomingMessage, reply: ServerResponse) => {
    reply.setHeader("Connection", "close");
    if (await options.handle?.(request, reply)) return;
    const url = new URL(request.url!, stagingOrigin);
    const path = url.pathname;
    const sessionPresent = request.headers.cookie?.split("; ").includes(session) ?? false;
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const respond = (step: string, status: number, headers: Record<string, string>, body = "") => {
      rows.push({
        step,
        method: request.method ?? "",
        browser: /Chrome\//.test(request.headers["user-agent"] ?? ""),
        session: sessionPresent,
        status,
      });
      reply.writeHead(status, { "Cache-Control": "no-store", ...headers }).end(body);
    };
    const json = (step: string, status: number, body: unknown) =>
      respond(step, status, { "Content-Type": "application/json" }, JSON.stringify(body));
    const callback = (state: string, values: Record<string, string>) => {
      const target = new URL(TCGPLAYER_CONNECTOR_REDIRECT_URI);
      target.searchParams.set("state", state);
      for (const [key, value] of Object.entries(values)) target.searchParams.set(key, value);
      return { Location: target.href };
    };

    if (path === "/channel-connector/oauth/authorize") {
      const query = url.searchParams;
      if ([...query.keys()].length === 0) return json("authorize-mount", 400, { error: "invalid-request" });
      const keys = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"];
      const closed =
        request.method === "GET" &&
        [...query.keys()].length === keys.length &&
        keys.every((key) => query.getAll(key).length === 1) &&
        query.get("response_type") === "code" &&
        query.get("redirect_uri") === TCGPLAYER_CONNECTOR_REDIRECT_URI &&
        query.get("code_challenge_method") === "S256" &&
        /^[A-Za-z0-9_-]{43}$/.test(query.get("code_challenge") ?? "") &&
        /^[A-Za-z0-9_-]{43}$/.test(query.get("state") ?? "");
      if (!closed) return json("authorize-malformed", 400, { error: "invalid-request" });
      if (query.get("client_id") !== stagingSynthetic.clientId)
        return json("authorize-unregistered", 400, { error: "invalid-client" });
      const state = query.get("state")!;
      if (!sessionPresent)
        return respond(
          "authorize-refused",
          302,
          callback(state, { error: "access_denied", error_description: "authorization_refused" }),
        );
      if (pairing.state !== "code" || pairing.expiresAt <= Date.now())
        return respond(
          "authorize-refused",
          302,
          callback(state, { error: "access_denied", error_description: "pairing_code_missing" }),
        );
      pairing.state = "authorized";
      challenge = query.get("code_challenge")!;
      return respond("authorize", 302, callback(state, { code: synthetic.code }));
    }
    if (path === "/channel-connector/oauth/token") {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        // A malformed body is refused below like any other mismatch.
      }
      verifier = typeof body.code_verifier === "string" ? body.code_verifier : "";
      const closed =
        request.method === "POST" &&
        Object.keys(body).sort().join() ===
          ["grant_type", "client_id", "redirect_uri", "code", "code_verifier"].sort().join() &&
        body.grant_type === "authorization_code" &&
        body.client_id === stagingSynthetic.clientId &&
        body.redirect_uri === TCGPLAYER_CONNECTOR_REDIRECT_URI &&
        body.code === synthetic.code &&
        createHash("sha256").update(verifier).digest("base64url") === challenge &&
        pairing.state === "authorized";
      if (!closed) return json("token", 400, { error: "invalid-request" });
      pairing.state = "paired";
      return json("token", 200, {
        access_token: synthetic.access,
        refresh_token: synthetic.refresh,
        token_type: "Bearer",
        expires_in: 3600,
        scope: "channel-connector:claim channel-connector:report channel-connector:ingest",
        connection_id: options.tokenConnectionId ?? pairing.connectionId,
      });
    }
    const connector = /^\/channel-connector\/oauth\/connections\/([^/]+)\/(claim|report)$/.exec(path);
    if (connector) {
      const [, connectionId, action] = connector;
      if (
        request.method !== "POST" ||
        request.headers.authorization !== `Bearer ${synthetic.access}` ||
        pairing.state !== "paired" ||
        connectionId !== pairing.connectionId
      )
        return json(action, 401, { error: "invalid-credential" });
      if (action === "report") return json("report", 200, {});
      return json("claim", 200, {
        reservation: options.pausedReservation ? syntheticClaim() : null,
        pollWindowSeconds: 30,
      });
    }
    if (path.startsWith("/api/") && !sessionPresent)
      return json("api-unauthenticated", 401, { error: "unauthenticated" });
    if (path === "/api/inventory/storage-locations" && request.method === "GET")
      return json("storage-locations", 200, {
        items: [{ storage_location_id: stagingSynthetic.storageLocationId, is_archived: false }],
        total: 1,
        count: 1,
      });
    if (path === "/api/channels/connections") {
      if (request.method === "GET") return json("list", 200, { items: [...connections.values()] });
      let providerKey: unknown;
      try {
        ({ providerKey } = JSON.parse(raw) as { providerKey?: unknown });
      } catch {
        // Refused below.
      }
      if (request.method !== "POST" || providerKey !== "tcgplayer")
        return json("connect", 400, { error: "invalid-request" });
      const connection = {
        connectionId: `connection_fake_${++sequence}`,
        providerKey: "tcgplayer",
        status: "pending-setup",
        storageLocationIds: [],
      };
      connections.set(connection.connectionId, connection);
      return json("connect", 200, connection);
    }
    const api = /^\/api\/channels\/connections\/([^/]+)\/(activate|pause|disconnect|connector-pairing)$/.exec(path);
    if (api) {
      const [, connectionId, action] = api;
      const connection = connections.get(connectionId);
      if (!connection) return json(action, 404, { error: "connection-not-found" });
      if (action === "connector-pairing" && request.method === "GET")
        return json("pairing-read", 200, detail(connectionId));
      if (request.method !== "POST") return json(action, 405, { error: "method-not-allowed" });
      if (action === "activate") {
        let ids: unknown;
        try {
          ({ storageLocationIds: ids } = JSON.parse(raw) as { storageLocationIds?: unknown });
        } catch {
          // Refused below.
        }
        if (
          connection.status !== "pending-setup" ||
          !Array.isArray(ids) ||
          ids.length !== 1 ||
          ids[0] !== stagingSynthetic.storageLocationId
        )
          return json("activate", 409, { error: "activation-refused" });
        Object.assign(connection, { status: "active", storageLocationIds: ids });
      }
      if (action === "pause" && connection.status === "active" && !options.pauseIgnored) connection.status = "paused";
      if (action === "disconnect") {
        connection.status = "disconnected";
        if (pairing.connectionId === connectionId) pairing.state = "unpaired";
      }
      return json(action, 200, connection);
    }
    if (path === "/favicon.ico") return respond("favicon", 404, {});
    if (path === "/sign-in" && request.method === "GET")
      return respond("sign-in", 200, { "Content-Type": "text/html" }, accountPage().replace("Channels", "Sign in"));
    const account = /^\/account\/channels(?:\/([^/]+))?$/.exec(path);
    if (account) {
      if (!sessionPresent) return respond("page-unauthenticated", 302, { Location: `/sign-in?returnTo=${path}` });
      const connectionId = account[1];
      if (connectionId && !connections.has(connectionId)) return respond("page", 404, {});
      if (request.method === "POST" && connectionId) {
        const form = new URLSearchParams(raw);
        const intent = form.get("intent");
        const connection = connections.get(connectionId)!;
        if (intent === "connector-code" && ["active", "paused"].includes(connection.status)) {
          Object.assign(pairing, {
            state: "code",
            connectionId,
            pairingId: `pairing_fake_${++sequence}`,
            revision: pairing.revision + 1,
            expiresAt: Date.now() + 600_000,
          });
          return respond("code", 303, { Location: path });
        }
        if (
          intent === "connector-unpair" &&
          !options.unpairIgnored &&
          pairing.connectionId === connectionId &&
          form.get("pairingId") === pairing.pairingId &&
          form.get("revision") === String(pairing.revision)
        ) {
          Object.assign(pairing, { state: "unpaired", revision: pairing.revision + 1 });
          return respond("unpair", 303, { Location: path });
        }
        return respond(intent === "connector-unpair" ? "unpair" : "code", 409, { "Content-Type": "text/html" }, "");
      }
      const marker = documents.begin(request, reply, sessionPresent);
      return respond("page", 200, { "Content-Type": "text/html" }, accountPage(connectionId) + marker);
    }
    return json("unknown", 404, { error: "not-found" });
  };
  const server = createTlsServer({ key: certificate.keyPem, cert: certificate.certificatePem }, (request, reply) => {
    serve(request, reply).catch((error: unknown) => {
      // Rethrow as uncaught so the runner fails exactly as the unhandled rejection did.
      setImmediate(() => {
        throw error;
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback-listen-refused");
  return {
    resolver: {
      address: "127.0.0.1",
      port: address.port,
      certificateSpki: certificate.certificateSpki,
      certificatePem: certificate.certificatePem,
    } satisfies PairingDrillResolver,
    rows: () => [...rows],
    documents,
    connections: () => [...connections.values()].map((connection) => ({ ...connection })),
    pairing: () => ({ ...pairing }),
    forbidden: () => [
      synthetic.cookieValue,
      synthetic.access,
      synthetic.refresh,
      synthetic.code,
      ...(verifier ? [verifier] : []),
    ],
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
