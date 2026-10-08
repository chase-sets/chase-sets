import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { TCGPLAYER_CONNECTOR_REDIRECT_URI } from "@chase-sets/channels/client";

export const synthetic = {
  cookieName: "synthetic_connector_session",
  cookieValue: "synthetic-session-cookie-marker",
  access: "cc_at_synthetic-retained-secret-marker",
  refresh: "cc_rt_synthetic-retained-secret-marker",
  code: "synthetic-authorization-code-marker",
  clientId: "cc_client_synthetic",
};
export const closedErrors = ["authorization_refused", "pairing_code_missing", "pairing_code_ambiguous"] as const;

export async function loopbackPlatform() {
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
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url!, "http://127.0.0.1");
    reply.setHeader("Cache-Control", "no-store");
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
      if (!queryClosed || !cookieArrived) {
        reply.writeHead(400);
        reply.end();
        return;
      }
      state = query.get("state")!;
      challenge = query.get("code_challenge")!;
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
        createHash("sha256").update(verifier).digest("base64url") === challenge;
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
    if (url.pathname.startsWith("/account/channels")) {
      reply.end("<!doctype html><title>Channels</title>");
      return;
    }
    reply.writeHead(404);
    reply.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
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
