import { createHash } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { readFileSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import { performance } from "node:perf_hooks";

const input = JSON.parse(readFileSync("/diagnostic/client.json", "utf8"));
const protocol = JSON.parse(readFileSync("/diagnostic/protocol.json", "utf8"));
const log = (event, fields = {}) => console.log(JSON.stringify({ utc: new Date().toISOString(), event, ...fields }));
if (!net.isIPv4(input.address) || input.port !== 30443 || !net.isIPv4(input.gateway))
  throw new Error("NONLOCAL_ENDPOINT");
const ca = readFileSync("/diagnostic/tls.crt");

async function request(row) {
  const began = performance.now();
  log("client.start", {
    row,
    path: row ? protocol.path : "/api/diagnostic-health",
    address: input.address,
    port: input.port,
  });
  const body = row ? JSON.stringify({ syncRunId: "synthetic-no-provider-no-database" }) : undefined;
  return new Promise((resolve) => {
    let completed = false;
    const req = https.request(
      {
        hostname: protocol.host,
        servername: protocol.host,
        port: input.port,
        method: row ? "POST" : "GET",
        path: row ? protocol.path : "/api/diagnostic-health",
        ca,
        rejectUnauthorized: true,
        agent: false,
        // No OS resolver, /etc/hosts lookup, DNS request or public fallback exists here.
        lookup(_hostname, options, callback) {
          callback(null, options.all ? [{ address: input.address, family: 4 }] : input.address, 4);
        },
        headers: {
          host: protocol.host,
          "user-agent": row ? `ingress-nosend-${row}` : "ingress-nosend-positive-control",
          ...(row
            ? { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-diagnostic-row": row }
            : {}),
        },
      },
      (res) => {
        const chunks = [];
        log("client.headers", { status: res.statusCode, headers: res.rawHeaders });
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          completed = true;
          const result = {
            row,
            durationMs: performance.now() - began,
            status: res.statusCode,
            contentType: res.headers["content-type"],
            bytes: bytes.length,
            bodySha256: createHash("sha256").update(bytes).digest("hex"),
            bodyBase64: bytes.toString("base64"),
            complete: res.complete,
          };
          log("client.result", result);
          resolve(result);
        });
        res.on("error", (error) => {
          log("client.responseError", { errorKind: error.code ?? error.name });
          resolve({ complete: false });
        });
      },
    );
    req.on("socket", (socket) => {
      socket.on("secureConnect", () =>
        log("client.tls", {
          verified: socket.authorized,
          remote: socket.remoteAddress,
          remotePort: socket.remotePort,
          localPort: socket.localPort,
        }),
      );
      socket.on("close", (hadError) => log("client.socketClose", { hadError, completed }));
    });
    req.on("error", (error) => {
      log("client.requestError", { errorKind: error.code ?? error.name });
      resolve({ complete: false });
    });
    req.on("finish", () => log("client.requestFinished"));
    req.end(body);
  });
}

async function blocked(address, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    socket.setTimeout(1500);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      log("control.blockedEgress", { address, port, ...result });
      resolve(result);
    };
    socket.on("connect", () => finish({ blocked: false }));
    socket.on("error", (error) => finish({ blocked: true, errorKind: error.code }));
    socket.on("timeout", () => finish({ blocked: false, unknown: true }));
  });
}

if (input.mode === "row") {
  const result = await request(input.row);
  if (!result.complete) process.exitCode = 1;
} else if (input.mode === "controls") {
  const positive = await request();
  const hostBlocked = await blocked(input.gateway, 18081);
  // RFC 2544 benchmarking address, rejected locally BEFORE routing, never a real provider.
  const routedBlocked = await blocked("198.18.0.2", 443);
  const resolver = new Resolver({ timeout: 1000, tries: 1 });
  const dnsServer = input.clusterControl
    ? readFileSync("/etc/resolv.conf", "utf8").match(/^nameserver\s+(\S+)/m)?.[1]
    : "127.0.0.11";
  if (!net.isIPv4(dnsServer)) throw new Error("LOCAL_DNS_CONTROL_REQUIRED");
  resolver.setServers([dnsServer]);
  let dnsBlocked = false;
  try {
    await resolver.resolve4("synthetic-egress-control.invalid");
  } catch (error) {
    dnsBlocked = true;
    log("control.embeddedDnsBlocked", { errorKind: error.code });
  }
  let correctStack = false;
  try {
    correctStack =
      JSON.parse(Buffer.from(positive.bodyBase64, "base64").toString("utf8")).stack === input.expectedStack;
  } catch {
    /* Fail closed. */
  }
  if (
    positive.status !== 200 ||
    !positive.complete ||
    !correctStack ||
    !hostBlocked.blocked ||
    !routedBlocked.blocked ||
    !dnsBlocked
  )
    process.exitCode = 1;
} else if (input.mode === "pre-boundary") {
  const reachable = await blocked(input.gateway, 18081);
  if (reachable.blocked) process.exitCode = 1;
} else throw new Error("INVALID_CLIENT_MODE");
