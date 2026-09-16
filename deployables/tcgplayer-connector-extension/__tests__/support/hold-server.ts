import { createServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";

export const holdOrigin = "http://127.0.0.1:46173";

export async function startHoldServer() {
  const requests: { at: string; closedAt: string | null; released: boolean }[] = [];
  const responses = new Set<ServerResponse>();
  const sockets = new Set<Socket>();
  const violations: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "GET" || request.url !== "/hold" || request.headers.host !== "127.0.0.1:46173") {
      violations.push("Unexpected request to synthetic hold server");
      response.writeHead(403).end();
      return;
    }
    const entry = { at: new Date().toISOString(), closedAt: null as string | null, released: false };
    requests.push(entry);
    responses.add(response);
    response.on("close", () => {
      entry.closedAt = new Date().toISOString();
      responses.delete(response);
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(46173, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    requests,
    violations,
    get active() {
      return responses.size;
    },
    release() {
      for (const entry of requests) if (entry.closedAt === null) entry.released = true;
      for (const response of responses)
        response.writeHead(200, { "Content-Type": "text/plain" }).end("SYNTHETIC_RECEIPT");
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
