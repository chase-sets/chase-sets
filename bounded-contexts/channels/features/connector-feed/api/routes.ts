import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import {
  ConnectorOAuthError,
  connectorRecord,
  connectorString,
} from "../../../support/request-support/connector-oauth";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelsApiEnv } from "../../../api";
import { ConnectorPairingError, type ConnectorAuditRoute, type ConnectorIdentity } from "../domain/contracts";
import type { ConnectorFeedServices } from "./runtime";
import { recordConnectorAudit } from "../read-model/audit";

export function connectorAuditMiddleware(db: PgQueryable, credentialMount = false): MiddlewareHandler<ChannelsApiEnv> {
  return async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const action = path.split("/").at(-1);
    let route: ConnectorAuditRoute | null = null;
    if (credentialMount) {
      if (action === "register" || action === "authorize" || action === "token" || action === "revoke") route = action;
    } else if (/\/connections\/[^/]+\/connector-pairing(?:\/code|\/unpair)?$/.test(path)) {
      route = action === "code" ? "pairing-create" : action === "unpair" ? "unpair" : "pairing-read";
    }
    if (!route) return next();
    c.set("connectorIdentity", null);
    c.set("connectorReason", "unavailable");
    await next();
    const identity = c.get("connectorIdentity");
    const accepted = c.res.status >= 200 && c.res.status < 300;
    const reason = accepted
      ? "accepted"
      : c.res.status === 401 || c.res.status === 403
        ? "authorization-refused"
        : c.get("connectorReason");
    await recordConnectorAudit(db, {
      requestId: randomUUID(),
      identity,
      route,
      outcome: accepted ? "accepted" : "refused",
      reason,
    });
    c.header("Cache-Control", "no-store");
  };
}
export function installConnectorAudit(app: Hono<ChannelsApiEnv>, db: PgQueryable, credentialMount = false) {
  app.use("*", connectorAuditMiddleware(db, credentialMount));
}

function safeError(error: unknown) {
  const code =
    error instanceof ConnectorPairingError || error instanceof ConnectorOAuthError ? error.code : "unavailable";
  const status =
    code === "invalid-request"
      ? 400
      : code === "connection-not-found"
        ? 404
        : code === "authorization-refused"
          ? 403
          : code === "unavailable"
            ? 503
            : code === "conflict"
              ? 409
              : 400;
  return { code, response: Response.json({ error: code }, { status, headers: { "Cache-Control": "no-store" } }) };
}
async function body(request: Request): Promise<unknown> {
  if (!request.body) throw new ConnectorPairingError("invalid-request");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of request.body) {
    length += chunk.byteLength;
    if (length > 8192) throw new ConnectorPairingError("invalid-request");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ConnectorPairingError("invalid-request");
  }
}
async function seller(services: ConnectorFeedServices, request: Request) {
  const actor = await services.resolveSeller(request);
  if (!actor || !actor.permissions.includes("channels.manage"))
    throw new ConnectorPairingError("authorization-refused");
  return actor;
}

export function createConnectorCredentialRoutes(services: ConnectorFeedServices, db: PgQueryable) {
  const app = new Hono<ChannelsApiEnv>();
  installConnectorAudit(app, db, true);
  for (const route of ["register", "authorize", "token", "revoke"] as const) {
    app.post(`/${route}`, async (c) => {
      try {
        const identify = (identity: ConnectorIdentity) => c.set("connectorIdentity", identity);
        if (route === "register") return c.json(await services.register(await body(c.req.raw)));
        if (route === "authorize") {
          const actor = await seller(services, c.req.raw);
          return c.json(await services.consumePairingCode(await body(c.req.raw), actor, identify));
        }
        if (route === "token") return c.json(await services.exchange(await body(c.req.raw), identify));
        const input = connectorRecord(await body(c.req.raw), ["token"]);
        await services.revoke(connectorString(input.token), identify);
        return c.json({ revoked: true });
      } catch (error) {
        const refusal = safeError(error);
        c.set("connectorReason", refusal.code);
        return refusal.response;
      }
    });
  }
  return app;
}

export function createSellerConnectorRoutes(services: ConnectorFeedServices) {
  const app = new Hono<ChannelsApiEnv>();
  app.get("/:id/connector-pairing", async (c) => {
    try {
      const actor = await seller(services, c.req.raw);
      return c.json(
        await services.detail({ accountId: actor.accountId, connectionId: c.req.param("id") }, (identity) =>
          c.set("connectorIdentity", identity),
        ),
      );
    } catch (error) {
      const refusal = safeError(error);
      c.set("connectorReason", refusal.code);
      return refusal.response;
    }
  });
  for (const action of ["code", "unpair"] as const) {
    app.post(`/:id/connector-pairing/${action}`, async (c) => {
      try {
        const actor = await seller(services, c.req.raw);
        const target = { accountId: actor.accountId, connectionId: c.req.param("id") };
        const identify = (identity: ConnectorIdentity) => c.set("connectorIdentity", identity);
        if (action === "code") {
          const value = connectorRecord(await body(c.req.raw), []);
          if (Object.keys(value).length) throw new ConnectorPairingError("invalid-request");
          return c.json(await services.createPairingCode(target, actor, identify));
        }
        const value = connectorRecord(await body(c.req.raw), ["pairingId", "revision"]);
        if (typeof value.revision !== "number") throw new ConnectorPairingError("invalid-request");
        await services.unpair(target, connectorString(value.pairingId), value.revision, actor, identify);
        return c.json({ state: "unpaired" });
      } catch (error) {
        const refusal = safeError(error);
        c.set("connectorReason", refusal.code);
        return refusal.response;
      }
    });
  }
  return app;
}
