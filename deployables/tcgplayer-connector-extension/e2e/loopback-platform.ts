import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";
import { syntheticClaim } from "../__tests__/harness/claim";

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
