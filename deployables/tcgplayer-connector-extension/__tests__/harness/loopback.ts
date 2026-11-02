import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { assertConnectorClaim, assertConnectorReport } from "@chase-sets/channels/server";
import { loopbackPlatform, synthetic } from "../../e2e/loopback-platform";
import {
  assertHarnessOrigins,
  connectorHostRegistry,
  platformOrigin,
  portalOrigin,
  sentinel,
  syntheticExportHeader,
} from "./origins";
import type { Claim } from "./claim";
import { connectorTransport } from "../../src/adapters/connector-transport";

export const exportSentinel = "SYNTHETIC_9288_PLAINTEXT_SENTINEL";
const exportRoute = "/Admin/Pricing/DownloadMyExportCSV?type=Pricing";
/** A labelled synthetic Export From Live file with a plaintext sentinel in its first product name. */
export function syntheticExportCsv(rows = 3): string {
  const lines = [syntheticExportHeader.join(",")];
  for (let index = 0; index < rows; index++)
    lines.push(
      [
        1000 + index,
        "Synthetic Line",
        "Synthetic Set",
        index === 0 ? exportSentinel : `Synthetic Card ${index}`,
        "",
        index,
        "Common",
        "Near Mint",
        "1.00",
        "",
        "1.50",
        "0.90",
        1,
        0,
        "1.25",
        "",
      ].join(","),
    );
  return `${lines.join("\n")}\n`;
}

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
  const provider = {
    reply: "csv" as "csv" | "redirect",
    csv: syntheticExportCsv(),
    session: null as string | null,
    exports: 0,
    signins: 0,
  };
  const ingests: string[] = [];
  const claimBodies: unknown[] = [];
  let withheld = 0;
  let lostIngests = 0;
  let ingestStatus = 202;
  const lost: (() => void)[] = [];
  const wait = async (route: string) => {
    await holds.get(route);
  };
  const servePortal = async (request: IncomingMessage, reply: ServerResponse) => {
    reply.setHeader("Connection", "close");
    if (request.method === "GET" && request.headers.host === "127.0.0.1:46175") {
      if (request.url === exportRoute) {
        provider.exports++;
        await wait("export");
        const session = provider.session === null || String(request.headers.cookie ?? "").includes(provider.session);
        if (provider.reply === "redirect" || !session)
          reply.writeHead(302, { Location: `${portalOrigin}/signin` }).end();
        else reply.writeHead(200, { "Content-Type": "text/csv; charset=utf-8" }).end(provider.csv);
        return;
      }
      if (request.url === "/signin") {
        provider.signins++;
        reply.writeHead(200, { "Content-Type": "text/html" }).end("<html>synthetic sign-in</html>");
        return;
      }
    }
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
  };
  const portal = createServer((request, reply) => {
    servePortal(request, reply).catch((error: unknown) => {
      // Rethrow as uncaught so the runner fails exactly as the unhandled rejection did.
      setImmediate(() => {
        throw error;
      });
    });
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
              : request.url === "/channel-connector/oauth/connections/connection_synthetic/ingest"
                ? "ingest"
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
          if (action === "ingest") {
            ingests.push(JSON.stringify(input));
            await wait("ingest");
            // A lost admission: the platform recorded the post but the worker never observes its 202.
            if (lostIngests > 0) {
              lostIngests--;
              lost.push(() => request.socket.destroy());
              return true;
            }
            reply.writeHead(ingestStatus, { "Content-Type": "application/json" }).end("{}");
          } else if (action === "claim") {
            assertConnectorClaim(input);
            claimCount++;
            claimBodies.push(input);
            // Mirrors #9285: export members are withheld from a claim that does not advertise the capability.
            const exportMember = claims[0]?.operations.some(
              (operation) => operation.operationKind === "tcgplayer-live-export",
            );
            const capable = input.capabilities?.includes("tcgplayer-live-export") === true;
            if (exportMember && !capable) withheld++;
            const reservation = exportMember && !capable ? null : (claims.shift() ?? null);
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
                      (("desiredStateSequence" in member &&
                        "desiredStateSequence" in item &&
                        member.desiredStateSequence === item.desiredStateSequence) ||
                        (member.operationKind === "tcgplayer-live-export" &&
                          "operationKind" in item &&
                          item.operationKind === "tcgplayer-live-export" &&
                          item.exportId === member.exportId &&
                          item.payloadDigest === member.payloadDigest)),
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
    provider,
    ingests,
    claimBodies,
    withheld: () => withheld,
    setIngestStatus: (status: number) => {
      ingestStatus = status;
    },
    loseNextIngest: () => {
      lostIngests++;
    },
    /** Ends every unanswered lost admission so its worker observes a transport failure. */
    dropLostIngests: () => {
      for (const drop of lost.splice(0)) drop();
    },
    reset() {
      claims.length = 0;
      reports.length = 0;
      portalCalls.length = 0;
      ingests.length = 0;
      claimBodies.length = 0;
      admitted.clear();
      accepted.clear();
      claimCount = 0;
      withheld = 0;
      lostIngests = 0;
      ingestStatus = 202;
      Object.assign(provider, { reply: "csv", csv: syntheticExportCsv(), session: null, exports: 0, signins: 0 });
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
    hold(route: "claim" | "portal" | "report" | "export" | "ingest") {
      holds.set(route, new Promise<void>((resolve) => releases.set(route, resolve)));
    },
    release(route: "claim" | "portal" | "report" | "export" | "ingest") {
      releases.get(route)?.();
      holds.delete(route);
      releases.delete(route);
    },
    async close() {
      for (const drop of lost.splice(0)) drop();
      for (const release of releases.values()) release();
      await platform.close();
      portal.closeAllConnections();
      await new Promise<void>((resolve, reject) => portal.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
