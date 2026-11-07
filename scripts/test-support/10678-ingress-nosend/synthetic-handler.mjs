// Bundled against EACH immutable stack, never against the diagnostic checkout's dependencies.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createHonoObservabilityMiddleware } from "@chase-sets/observability";
import { createProcessDrainState, startGracefulHttpServer } from "@chase-sets/platform-runtime/process-lifecycle";

const protocol = JSON.parse(readFileSync("/diagnostic/protocol.json", "utf8"));
const stack = protocol.stacks.find((s) => s.id === process.env.DIAGNOSTIC_STACK);
if (!stack) throw new Error("INVALID_STACK");
const context = new AsyncLocalStorage();
const consumed = new Set();
const log = (event, fields = {}) =>
  console.log(
    JSON.stringify({ utc: new Date().toISOString(), event, stack: stack.id, ...context.getStore(), ...fields }),
  );
const logger = {
  info: (_message, fields) => log(fields.type, fields),
  warn: (_message, fields) => log(fields.type, fields),
  error: (_message, fields) => log(fields.type, fields),
};
const app = new Hono();
app.use("*", (c, next) =>
  context.run({ row: c.req.header("x-diagnostic-row") ?? "control", appTrace: `synthetic-${randomUUID()}` }, next),
);
// Only the log sink is synthetic. The production middleware's duration/status boundary is unchanged.
app.use("*", createHonoObservabilityMiddleware(logger));
app.get("/api/diagnostic-health", (c) => c.json({ synthetic: true, stack: stack.id }));
app.post(protocol.path, async (c) => {
  const row = c.req.header("x-diagnostic-row");
  const rows = [
    ...protocol.rungs.map((candidates) => ({ candidates, durationMs: protocol.durationMs })),
    protocol.control,
  ];
  const index = Number(row?.replace(`${stack.id}-`, "")) - 1;
  if (row !== `${stack.id}-${index + 1}` || !rows[index] || consumed.has(row)) return c.json({ rejected: true }, 409);
  const arm = JSON.parse(readFileSync("/diagnostic/armed.json", "utf8"));
  if (arm.synthetic !== true || arm.stack !== stack.id) return c.json({ rejected: true }, 403);
  const body = await c.req.json();
  if (JSON.stringify(body) !== JSON.stringify({ syncRunId: "synthetic-no-provider-no-database" }))
    return c.json({ rejected: true }, 400);
  consumed.add(row);
  const rung = rows[index];
  const started = performance.now();
  const result = {
    synthetic: true,
    syncRunId: body.syncRunId,
    candidates: Array.from({ length: rung.candidates }, (_, i) => ({
      candidateId: `synthetic-candidate-${i + 1}`,
      source: "synthetic-no-provider",
      name: `Synthetic candidate ${i + 1}`,
      members: [{ sourceId: `synthetic-member-${i + 1}`, language: "en" }],
    })),
  };
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, rung.durationMs - (performance.now() - started))));
  log("handler.result", { candidates: rung.candidates, bytes: Buffer.byteLength(JSON.stringify(result)) });
  return c.json(result, 202);
});

const drainState = createProcessDrainState();
startGracefulHttpServer({
  name: "platform-api",
  serve(options, onListening) {
    const server = serve(options, onListening);
    log("server.defaults", {
      node: process.version,
      architecture: process.arch,
      adapter: stack.adapter,
      requestTimeout: server.requestTimeout,
      headersTimeout: server.headersTimeout,
      keepAliveTimeout: server.keepAliveTimeout,
      timeout: server.timeout,
      platform: process.platform,
    });
    server.on("connection", (socket) => {
      const endpoint = {
        local: socket.localAddress,
        localPort: socket.localPort,
        remote: socket.remoteAddress,
        remotePort: socket.remotePort,
      };
      for (const event of ["end", "close", "timeout", "error"])
        socket.on(event, (value) =>
          log(`socket.${event}`, { endpoint, hadError: event === "close" ? value : undefined }),
        );
    });
    server.on("request", (request, response) => {
      const row = request.headers["x-diagnostic-row"] ?? "control";
      const fields = {
        row,
        path: request.url,
        method: request.method,
        endpoint: `${request.socket.localAddress}:${request.socket.localPort}`,
      };
      const chunks = [];
      for (const name of ["write", "end"]) {
        const original = response[name];
        response[name] = function (chunk, encoding, ...args) {
          if (typeof chunk === "string" || Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
            const bytes = Buffer.isBuffer(chunk)
              ? chunk
              : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined);
            chunks.push(bytes);
            log(`response.${name}`, { ...fields, bytes: bytes.length, bodyBase64: bytes.toString("base64") });
          } else log(`response.${name}`, fields);
          return original.call(this, chunk, encoding, ...args);
        };
      }
      const originalWriteHead = response.writeHead;
      response.writeHead = function (...args) {
        log("response.writeHead", { ...fields, status: args[0], headers: this.getHeaders(), arguments: args });
        return originalWriteHead.apply(this, args);
      };
      for (const event of ["finish", "close", "error"])
        response.on(event, () => {
          const body = Buffer.concat(chunks);
          log(`response.${event}`, {
            ...fields,
            status: response.statusCode,
            headers: response.getHeaders(),
            finished: response.writableFinished,
            bodyBytes: body.length,
            bodySha256: createHash("sha256").update(body).digest("hex"),
          });
        });
    });
    return server;
  },
  fetch: app.fetch,
  port: protocol.backendPort,
  drainState,
  logger,
  onListening: () => log("server.listening", { port: protocol.backendPort }),
});
