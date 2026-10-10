import { createServer, type IncomingMessage } from "node:http";
import { assertConnectorClaim, assertConnectorReport } from "@chase-sets/channels/server";
import { loopbackPlatform, synthetic } from "../../e2e/loopback-platform";
import { assertHarnessOrigins, connectorHostRegistry, platformOrigin, portalOrigin, sentinel } from "./origins";
import type { Claim } from "./claim";
import { connectorTransport } from "../../src/adapters/connector-transport";

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1048576) throw new Error("synthetic-body-too-large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function startLoopback() {
  assertHarnessOrigins(platformOrigin, connectorHostRegistry);
  const claims: Claim[] = [];
  const admitted = new Map<string, Claim>();
  const reports: string[] = [];
  const accepted = new Map<string, string>();
  const portalCalls: unknown[] = [];
  const holds = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  let claimCount = 0;
  let pollWindowSeconds = 30;
  const wait = async (route: string) => {
    await holds.get(route);
  };
  const portal = createServer(async (request, reply) => {
    reply.setHeader("Connection", "close");
    try {
      if (
        request.headers.host !== "127.0.0.1:46175" ||
        request.method !== "POST" ||
        !["/portal/mutate", "/portal/proof"].includes(request.url ?? "")
      )
        throw new Error("synthetic-portal-route-refused");
      const input = await body(request);
      if (!input || typeof input !== "object" || !("sentinel" in input) || input.sentinel !== sentinel)
        throw new Error("synthetic-sentinel-refused");
      if (request.url === "/portal/proof") {
        if (!portalCalls.some((prior) => JSON.stringify(prior) === JSON.stringify(input)))
          throw new Error("synthetic-proof-absent");
      } else portalCalls.push(input);
      await wait("portal");
      reply.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(input));
    } catch {
      reply.writeHead(400).end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => {
    portal.once("error", reject);
    portal.listen(46175, "127.0.0.1", () => {
      portal.off("error", reject);
      resolve();
    });
  });
  let platform: Awaited<ReturnType<typeof loopbackPlatform>>;
  try {
    platform = await loopbackPlatform({
      port: 46174,
      requirePairingCode: true,
      handle: async (request, reply) => {
        const action =
          request.url === "/channel-connector/oauth/connections/connection_synthetic/claim"
            ? "claim"
            : request.url === "/channel-connector/oauth/connections/connection_synthetic/report"
              ? "report"
              : null;
        if (!action) return false;
        try {
          if (
            request.method !== "POST" ||
            request.headers.host !== "127.0.0.1:46174" ||
            request.headers.authorization !== `Bearer ${synthetic.access}`
          )
            throw new Error("synthetic-authority-refused");
          const input = await body(request);
          if (action === "claim") {
            assertConnectorClaim(input);
            claimCount++;
            const reservation = claims.shift() ?? null;
            if (reservation) admitted.set(reservation.reservationId, reservation);
            await wait("claim");
            reply
              .writeHead(200, { "Content-Type": "application/json" })
              .end(JSON.stringify({ reservation, pollWindowSeconds }));
          } else {
            assertConnectorReport(input);
            const claim = admitted.get(input.reservationId);
            if (
              !claim ||
              Date.now() >= Date.parse(claim.leaseExpiresAt) ||
              input.outcomes.length !== claim.operations.length ||
              new Set(input.outcomes.map((item) => item.operationId)).size !== claim.operations.length ||
              input.outcomes.some(
                (item) =>
                  !claim.operations.some(
                    (member) =>
                      member.operationId === item.operationId &&
                      member.attemptId === item.attemptId &&
                      member.claimGeneration === item.claimGeneration &&
                      "desiredStateSequence" in member &&
                      "desiredStateSequence" in item &&
                      member.desiredStateSequence === item.desiredStateSequence,
                  ),
              )
            )
              throw new Error("synthetic-settlement-fence-refused");
            const serialized = JSON.stringify(input);
            const previous = accepted.get(input.reservationId);
            if (previous && previous !== serialized) throw new Error("synthetic-repeat-refused");
            reports.push(serialized);
            accepted.set(input.reservationId, serialized);
            await wait("report");
            reply.writeHead(200, { "Content-Type": "application/json" }).end("{}");
          }
        } catch {
          reply.writeHead(400, { "Content-Type": "application/json" }).end("{}");
        }
        return true;
      },
    });
  } catch (error) {
    portal.closeAllConnections();
    await new Promise<void>((resolve) => portal.close(() => resolve()));
    throw error;
  }
  const request = connectorTransport({
    platformOrigin,
    hostRegistry: connectorHostRegistry,
    permissionRegistry: ["identity", "storage", "alarms"],
  });
  const witness = { sentinel, operations: [] };
  try {
    const response = await request(
      new Request(`${portalOrigin}/portal/mutate`, {
        method: "POST",
        redirect: "error",
        body: JSON.stringify(witness),
      }),
    );
    if (!response.ok || JSON.stringify(await response.json()) !== JSON.stringify(witness))
      throw new Error("synthetic-sentinel-preflight-failed");
  } catch (error) {
    await platform.close();
    portal.closeAllConnections();
    await new Promise<void>((resolve) => portal.close(() => resolve()));
    throw error;
  }
  portalCalls.length = 0;
  return {
    platform,
    claims,
    reports,
    portalCalls,
    reset() {
      claims.length = 0;
      reports.length = 0;
      portalCalls.length = 0;
      admitted.clear();
      accepted.clear();
      claimCount = 0;
    },
    claimCount: () => claimCount,
    setPollWindow: (seconds: number) => {
      pollWindowSeconds = seconds;
    },
    report: (index = 0) => {
      const value: unknown = JSON.parse(reports[index]!);
      assertConnectorReport(value);
      return value;
    },
    hold(route: "claim" | "portal" | "report") {
      holds.set(route, new Promise<void>((resolve) => releases.set(route, resolve)));
    },
    release(route: "claim" | "portal" | "report") {
      releases.get(route)?.();
      holds.delete(route);
      releases.delete(route);
    },
    async close() {
      for (const release of releases.values()) release();
      await platform.close();
      portal.closeAllConnections();
      await new Promise<void>((resolve, reject) => portal.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
