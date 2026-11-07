import { createServer } from "node:http";

const role = process.env.DIAGNOSTIC_ROLE;
if (!["root-route", "blocked-host-sentinel"].includes(role)) throw new Error("INVALID_CONTROL_ROLE");
const port = role === "root-route" ? 8080 : 18081;
const server = createServer((_request, response) => {
  console.log(JSON.stringify({ utc: new Date().toISOString(), event: "control.connection", role }));
  response.writeHead(418, { "content-type": "application/json" });
  response.end(JSON.stringify({ synthetic: true, role }));
});
server.on("connection", () => console.log(JSON.stringify({ event: "control.tcpConnection", role })));
server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "control.listening", role, port })));
