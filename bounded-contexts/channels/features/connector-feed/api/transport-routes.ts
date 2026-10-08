import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { PgQueryable } from "@chase-sets/event-core-postgres";
import type { ChannelsApiEnv } from "../../../api";
import { ChannelConnectionError } from "../../connections/domain/contracts";
import { OutboundSyncError } from "../../outbound-sync/domain/contracts";
import { ConnectorOAuthError } from "../../../support/request-support/connector-oauth";
import {
  ConnectorPairingError,
  connectorOperations,
  type ConnectorAuditReason,
  type ConnectorIdentity,
} from "../domain/contracts";
import { ConnectorTransportError } from "../domain/transport";
import { connectorReportMaxBytes } from "../domain/policy";
import { recordConnectorAudit } from "../read-model/audit";
import type { ConnectorTransportServices } from "./transport";

export function createConnectorTransportRoutes(services: ConnectorTransportServices, db: PgQueryable) {
  const app = new Hono<ChannelsApiEnv>();
  for (const operation of connectorOperations) {
    app.post(`/connections/:connectionId/${operation}`, async (c) => {
      let identity: ConnectorIdentity | null = null;
      let reason: ConnectorAuditReason = "unavailable";
      let accepted = false;
      let response: Response;
      c.set("connectorOutcome", "refused");
      try {
        const authorization = c.req.header("authorization");
        if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
          throw new ConnectorPairingError("invalid-credential");
        const policy = await services.resolveTransportPolicy();
        // Report results are bounded by the producer's closed result grammar, not the inbound payload limit.
        const maxBytes =
          operation === "claim"
            ? 1024
            : operation === "ingest"
              ? policy.maxIngestBytes
              : connectorReportMaxBytes(policy);
        const value = await readBody(c.req.raw, maxBytes);
        const input = { token: authorization.slice(7), connectionId: c.req.param("connectionId") };
        const identify = (verified: ConnectorIdentity) => {
          identity = verified;
          c.set("connectorIdentity", verified);
        };
        if (operation === "claim") response = claimResponse(await services.claim(input, value, identify));
        else {
          await services[operation](input, value, identify);
          response = new Response("{}", {
            status: operation === "ingest" ? 202 : 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        accepted = true;
        reason = "accepted";
        c.set("connectorOutcome", "accepted");
      } catch (error) {
        const failure = safeTransportFailure(error, operation === "report");
        response = failure.response;
        reason = failure.reason;
      }
      c.set("connectorReason", reason);
      try {
        await recordConnectorAudit(db, {
          requestId: randomUUID(),
          identity,
          route: operation,
          outcome: accepted ? "accepted" : "refused",
          reason,
        });
      } catch {
        // Never acknowledge a request whose required audit could not be persisted.
        response = Response.json({ code: "unavailable" }, { status: 503 });
      }
      response.headers.set("Cache-Control", "no-store");
      return response;
    });
  }
  return app;
}

async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  if (!request.body) throw new ConnectorTransportError("invalid-input");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new ConnectorTransportError("invalid-input");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ConnectorTransportError("invalid-input");
  }
}

function safeTransportFailure(
  error: unknown,
  report: boolean,
): Readonly<{ reason: ConnectorAuditReason; response: Response }> {
  if (error instanceof OutboundSyncError) {
    const reportReasons = [
      "invalid-input",
      "reservation-membership-mismatch",
      "reservation-expired",
      "stale-fence",
      "run-settlement-unavailable",
    ];
    if (report && reportReasons.includes(error.code))
      return {
        reason: error.code === "invalid-input" ? "invalid-request" : "conflict",
        response: Response.json(
          { code: "report-refused", reason: error.code },
          { status: error.code === "invalid-input" ? 400 : 409 },
        ),
      };
    if (error.code === "connection-not-active")
      return {
        reason: "authorization-refused",
        response: Response.json({ code: "authorization-refused" }, { status: 403 }),
      };
  }
  if (
    error instanceof ChannelConnectionError ||
    (error instanceof ConnectorTransportError && error.code === "invalid-input")
  )
    return {
      reason: "invalid-request",
      response: Response.json(
        report ? { code: "report-refused", reason: "invalid-input" } : { code: "invalid-input" },
        { status: 400 },
      ),
    };
  if (error instanceof ConnectorPairingError || error instanceof ConnectorOAuthError) {
    const invalid = error.code === "invalid-request";
    const unavailable = error.code === "unavailable";
    return {
      reason: invalid ? "invalid-request" : unavailable ? "unavailable" : "authorization-refused",
      response: Response.json(
        { code: invalid ? "invalid-input" : unavailable ? "unavailable" : "authorization-refused" },
        { status: invalid ? 400 : unavailable ? 503 : 403 },
      ),
    };
  }
  return { reason: "unavailable", response: Response.json({ code: "unavailable" }, { status: 503 }) };
}

function claimResponse(result: Awaited<ReturnType<ConnectorTransportServices["claim"]>>): Response {
  const { reservation, pollWindowSeconds } = result;
  if (!reservation) return Response.json({ reservation: null, pollWindowSeconds });
  // Serialize each bounded producer member once. A million-member policy must not hit a smaller whole-response/string cap.
  const { operations, ...identity } = reservation;
  const encoder = new TextEncoder();
  let index = -1;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index === -1) {
          controller.enqueue(
            encoder.encode(
              `{"pollWindowSeconds":${pollWindowSeconds},"reservation":${JSON.stringify(identity).slice(0, -1)},"operations":[`,
            ),
          );
          index = 0;
        } else if (index < operations.length) {
          controller.enqueue(encoder.encode((index === 0 ? "" : ",") + JSON.stringify(operations[index])));
          index += 1;
        } else {
          controller.enqueue(encoder.encode("]}}"));
          controller.close();
        }
      },
    }),
    { headers: { "Content-Type": "application/json" } },
  );
}
