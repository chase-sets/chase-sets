import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postgresFailureFields } from "./lib/postgres-connection.mjs";
import { createDatabaseAudit } from "./staging-wake-drills.mjs";
import { databaseUrlsFromTerraformState } from "./terraform-state-database-urls.mjs";

const execFile = promisify(execFileCallback);
let temporaryDirectory;
let certificatePaths;
let postgresServer;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "production-readiness-postgres-trust-"));
  certificatePaths = await createCertificateFixtures(temporaryDirectory);
  postgresServer = {
    trusted: await startTlsPostgresProtocolServer(certificatePaths.serverCertificate, certificatePaths.serverKey),
    hostnameMismatch: await startTlsPostgresProtocolServer(
      certificatePaths.hostnameMismatchCertificate,
      certificatePaths.hostnameMismatchKey,
    ),
  };
}, 30_000);

afterAll(async () => {
  await postgresServer?.trusted.close();
  await postgresServer?.hostnameMismatch.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("production readiness managed Postgres trust seam", () => {
  it("reaches the real audit query only with the intended CA and matching DNS", async () => {
    const workflow = await readFile(new URL("../.github/workflows/platform-production.yml", import.meta.url), "utf8");
    const action = await readFile(
      new URL("../.github/actions/export-managed-postgres-authority/action.yml", import.meta.url),
      "utf8",
    );
    const exportIndex = workflow.indexOf("uses: ./.github/actions/export-managed-postgres-authority");
    const gateIndex = workflow.indexOf("node ./scripts/production-readiness-gate.mjs");
    expect(exportIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeLessThan(gateIndex);
    expect(action).toContain('--ca-path "$MANAGED_POSTGRES_CA_PATH"');

    const trustedUrls = urlsFor("localhost", certificatePaths.caCertificate);
    const sample = await sampleProductionReadinessAudit(trustedUrls);

    expect(sample).toMatchObject({
      head: "0",
      relayCursor: null,
      checkpoints: [
        {
          checkpointKey: "checkout.session-projection:checkout:v1",
          projectionName: "checkout.session-projection",
          subscriptionVersion: 1,
          position: "0",
        },
      ],
    });
  });

  it.each([
    {
      name: "withheld CA",
      mutate: (url) => {
        const parsed = new URL(url);
        parsed.searchParams.delete("sslrootcert");
        return parsed.toString();
      },
      classification: "certificate-authority-untrusted",
    },
    {
      name: "wrong CA",
      mutate: (url) => withRootCertificate(url, certificatePaths.wrongCaCertificate),
      classification: "certificate-authority-untrusted",
    },
    {
      name: "hostname mismatch",
      mutate: (url) => {
        const parsed = new URL(url);
        parsed.port = String(postgresServer.hostnameMismatch.port);
        return parsed.toString();
      },
      classification: "certificate-hostname-mismatch",
    },
    {
      name: "missing CA file",
      mutate: (url) => withRootCertificate(url, join(temporaryDirectory, "missing-ca.pem")),
      classification: "certificate-authority-file-unavailable",
    },
  ])(
    "fails closed for $name with a bounded certificate class and no retained secret bytes",
    async ({ mutate, classification }) => {
      const urls = urlsFor("localhost", certificatePaths.caCertificate).map((entry) => ({
        ...entry,
        url: mutate(entry.url),
      }));
      let failure;
      try {
        await sampleProductionReadinessAudit(urls);
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeDefined();
      const retainedEvidence = JSON.stringify(postgresFailureFields(failure));
      expect(JSON.parse(retainedEvidence).classification).toBe(classification);
      expect(retainedEvidence).not.toContain("password-marker");
      expect(retainedEvidence).not.toContain("postgresql://");
      expect(retainedEvidence).not.toContain("BEGIN CERTIFICATE");
      expect(retainedEvidence).not.toContain("ca-secret-marker");
    },
  );
});

async function sampleProductionReadinessAudit(urls) {
  const byContext = new Map(urls.map(({ contextName, url }) => [contextName, url]));
  const audit = await createDatabaseAudit({
    contextDatabaseUrls: { checkout: byContext.get("checkout") },
    controlDatabaseUrl: byContext.get("control"),
  });
  try {
    return await audit.sampleSourceContext("checkout");
  } finally {
    await audit.close();
  }
}

function urlsFor(host, caPath) {
  return databaseUrlsFromTerraformState(terraformState(host, postgresServer.trusted.port), {
    environmentName: "production",
    contexts: ["checkout", "control"],
    caPath,
  });
}

function terraformState(host, port) {
  return {
    resources: [
      {
        type: "digitalocean_database_cluster",
        name: "postgres",
        instances: [{ attributes: { id: "managed-cluster", host, port } }],
      },
      {
        type: "digitalocean_database_db",
        name: "contexts",
        instances: [
          { index_key: "checkout", attributes: { name: "checkout" } },
          { index_key: "control", attributes: { name: "control" } },
        ],
      },
      {
        type: "digitalocean_database_user",
        name: "contexts",
        instances: [
          { index_key: "checkout", attributes: { name: "checkout", password: "password-marker" } },
          { index_key: "control", attributes: { name: "control", password: "password-marker" } },
        ],
      },
    ],
  };
}

function withRootCertificate(connectionString, caPath) {
  const url = new URL(connectionString);
  url.searchParams.set("sslrootcert", caPath);
  return url.toString();
}

async function createCertificateFixtures(directory) {
  const caKey = join(directory, "ca.key");
  const caCertificate = join(directory, "ca.pem");
  const wrongCaKey = join(directory, "wrong-ca.key");
  const wrongCaCertificate = join(directory, "wrong-ca.pem");
  const serverKey = join(directory, "server.key");
  const serverRequest = join(directory, "server.csr");
  const serverCertificate = join(directory, "server.pem");
  const extensions = join(directory, "server.ext");
  const hostnameMismatchKey = join(directory, "hostname-mismatch.key");
  const hostnameMismatchRequest = join(directory, "hostname-mismatch.csr");
  const hostnameMismatchCertificate = join(directory, "hostname-mismatch.pem");
  const hostnameMismatchExtensions = join(directory, "hostname-mismatch.ext");
  await writeFile(extensions, "subjectAltName=DNS:localhost\n");
  await writeFile(hostnameMismatchExtensions, "subjectAltName=DNS:wrong-host.example\n");
  await runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    caKey,
    "-out",
    caCertificate,
    "-subj",
    "/CN=readiness-ca",
    "-days",
    "1",
  ]);
  await runOpenSsl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    wrongCaKey,
    "-out",
    wrongCaCertificate,
    "-subj",
    "/CN=wrong-ca",
    "-days",
    "1",
  ]);
  await runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    serverKey,
    "-out",
    serverRequest,
    "-subj",
    "/CN=localhost",
  ]);
  await runOpenSsl([
    "x509",
    "-req",
    "-in",
    serverRequest,
    "-CA",
    caCertificate,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    serverCertificate,
    "-days",
    "1",
    "-extfile",
    extensions,
  ]);
  await runOpenSsl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    hostnameMismatchKey,
    "-out",
    hostnameMismatchRequest,
    "-subj",
    "/CN=wrong-host.example",
  ]);
  await runOpenSsl([
    "x509",
    "-req",
    "-in",
    hostnameMismatchRequest,
    "-CA",
    caCertificate,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-out",
    hostnameMismatchCertificate,
    "-days",
    "1",
    "-extfile",
    hostnameMismatchExtensions,
  ]);
  return {
    caCertificate,
    wrongCaCertificate,
    serverCertificate,
    serverKey,
    hostnameMismatchCertificate,
    hostnameMismatchKey,
  };
}

async function runOpenSsl(args) {
  const executable =
    process.env.OPENSSL_PATH ??
    (process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl");
  await execFile(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function startTlsPostgresProtocolServer(certificatePath, keyPath) {
  const secureContext = tls.createSecureContext({
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  });
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (request) => {
      if (request.length < 8 || request.readInt32BE(4) !== 80877103) {
        socket.destroy();
        return;
      }
      socket.write("S");
      const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
      secureSocket.on("error", () => undefined);
      handlePostgresProtocol(secureSocket);
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function handlePostgresProtocol(socket) {
  let buffer = Buffer.alloc(0);
  let startup = true;
  let currentSql = "";
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      if (startup) {
        if (buffer.length < 4) return;
        const length = buffer.readInt32BE(0);
        if (buffer.length < length) return;
        buffer = buffer.subarray(length);
        startup = false;
        socket.write(
          Buffer.concat([
            protocolMessage("R", int32(0)),
            protocolMessage("S", cstrings("server_version", "16.0")),
            protocolMessage("S", cstrings("client_encoding", "UTF8")),
            protocolMessage("K", Buffer.concat([int32(1), int32(1)])),
            protocolMessage("Z", Buffer.from("I")),
          ]),
        );
        continue;
      }
      if (buffer.length < 5) return;
      const length = buffer.readInt32BE(1);
      if (buffer.length < length + 1) return;
      const type = String.fromCharCode(buffer[0]);
      const payload = buffer.subarray(5, length + 1);
      buffer = buffer.subarray(length + 1);
      if (type === "Q") respondToQuery(socket, payload.subarray(0, -1).toString("utf8"));
      if (type === "P") {
        const statementNameEnd = payload.indexOf(0);
        const sqlEnd = payload.indexOf(0, statementNameEnd + 1);
        currentSql = payload.subarray(statementNameEnd + 1, sqlEnd).toString("utf8");
        socket.write(protocolMessage("1", Buffer.alloc(0)));
      }
      if (type === "B") socket.write(protocolMessage("2", Buffer.alloc(0)));
      if (type === "D") socket.write(rowDescription(queryResult(currentSql).fields));
      if (type === "E") sendExecuteResult(socket, queryResult(currentSql).rows);
      if (type === "S") socket.write(protocolMessage("Z", Buffer.from("I")));
      if (type === "X") socket.end();
    }
  });
}

function respondToQuery(socket, sql) {
  const result = queryResult(sql);
  sendRows(socket, result.fields, result.rows);
}

function queryResult(sql) {
  if (sql.includes("platform_projection_wake_relay_cursors")) {
    return { fields: ["position", "owner_id", "age_ms"], rows: [] };
  }
  if (sql.includes("event_subscription_checkpoints")) {
    return {
      fields: ["checkpoint_key", "projection_name", "subscription_version", "position", "age_ms"],
      rows: [["checkout.session-projection:checkout:v1", "checkout.session-projection", "1", "0", "0"]],
    };
  }
  return { fields: ["head"], rows: [["0"]] };
}

function sendExecuteResult(socket, rows) {
  const messages = rows.map((row) => dataRow(row));
  messages.push(protocolMessage("C", cstrings(`SELECT ${rows.length}`)));
  socket.write(Buffer.concat(messages));
}

function sendRows(socket, fields, rows) {
  const messages = [rowDescription(fields)];
  for (const row of rows) messages.push(dataRow(row));
  messages.push(protocolMessage("C", cstrings(`SELECT ${rows.length}`)));
  messages.push(protocolMessage("Z", Buffer.from("I")));
  socket.write(Buffer.concat(messages));
}

function rowDescription(fields) {
  const entries = fields.map((field) =>
    Buffer.concat([cstrings(field), int32(0), int16(0), int32(25), int16(-1), int32(-1), int16(0)]),
  );
  return protocolMessage("T", Buffer.concat([int16(fields.length), ...entries]));
}

function dataRow(values) {
  const entries = values.map((value) => {
    const bytes = Buffer.from(value);
    return Buffer.concat([int32(bytes.length), bytes]);
  });
  return protocolMessage("D", Buffer.concat([int16(values.length), ...entries]));
}

function protocolMessage(type, payload) {
  return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload]);
}

function cstrings(...values) {
  return Buffer.from(`${values.join("\0")}\0`);
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function int16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
}
