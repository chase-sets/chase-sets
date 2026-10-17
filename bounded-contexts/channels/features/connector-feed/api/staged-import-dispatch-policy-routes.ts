import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelsApiEnv } from "../../../api";
import { ConnectorPairingError, type ConnectorAuditReason, type ConnectorIdentity } from "../domain/contracts";
import { StagedImportDispatchError } from "../domain/staged-import-dispatch-policy";
import { recordConnectorAudit } from "../read-model/audit";
import type { createStagedImportDispatchPolicyReader } from "./staged-import-dispatch-policy";

export function createStagedImportDispatchPolicyRoutes(
  read: ReturnType<typeof createStagedImportDispatchPolicyReader>,
  db: PgQueryable,
) {
  const app = new Hono<ChannelsApiEnv>();
  app.get("/tcgplayer-staged-import-dispatch-policy", async (c) => {
    let identity: ConnectorIdentity | null = null;
    let reason: ConnectorAuditReason = "unavailable";
    let response: Response;
    try {
      const authorization = c.req.header("authorization");
      if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
        throw new ConnectorPairingError("invalid-credential");
      const search = new URL(c.req.url).searchParams;
      if ([...search.keys()].length !== 2) throw new ConnectorPairingError("invalid-request");
      response = Response.json(
        await read(authorization.slice(7), Object.fromEntries(search), (value) => {
          identity = value;
        }),
      );
      reason = "accepted";
    } catch (error) {
      const invalid = error instanceof ConnectorPairingError && error.code === "invalid-request";
      const unauthorized =
        error instanceof ConnectorPairingError && ["invalid-credential", "authorization-refused"].includes(error.code);
      reason = invalid ? "invalid-request" : unauthorized ? "authorization-refused" : "unavailable";
      response = Response.json(
        {
          code:
            error instanceof StagedImportDispatchError
              ? error.code
              : invalid
                ? "invalid-input"
                : unauthorized
                  ? "authorization-refused"
                  : "unavailable",
        },
        { status: invalid ? 400 : unauthorized ? 403 : 503 },
      );
    }
    try {
      await recordConnectorAudit(db, {
        requestId: randomUUID(),
        identity,
        route: "tcgplayer-staged-import-dispatch-policy",
        outcome: reason === "accepted" ? "accepted" : "refused",
        reason,
      });
    } catch {
      response = Response.json({ code: "unavailable" }, { status: 503 });
    }
    response.headers.set("Cache-Control", "no-store");
    return response;
  });
  return app;
}
