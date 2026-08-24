import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import net, { type Server as NetServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectionUrlForGrant,
  main as runGrantScript,
  statementsForGrant as productionStatementsForGrant,
} from
// @ts-expect-error The production boundary is intentionally an ESM script without a declaration file.
"../../scripts/apply-digitalocean-database-grant.mjs";

const { Client } = pg;
const execFileAsync = promisify(execFile);
const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for terraform-database-grant-tls.db.test.ts in CI.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type Grant = Readonly<{ database: string; user: string; kind?: "owner" | "wake-listener" }>;
type CertificateFixtures = Readonly<{
  caCertificate: string;
  wrongCaCertificate: string;
  serverCertificate: string;
  serverKey: string;
  hostnameMismatchCertificate: string;
  hostnameMismatchKey: string;
}>;
type DisposableDatabases = Readonly<{
  databases: readonly [string, string];
  owners: readonly [string, string];
  listeners: readonly [string, string];
  close: () => Promise<void>;
}>;
type TlsProxy = Readonly<{ port: number; connections: () => number; close: () => Promise<void> }>;
type ProviderDouble = Readonly<{
  apiBaseUrl: string;
  requests: readonly Readonly<{ url: string; authorization: string }>[];
  setCertificate: (certificate: string) => void;
  close: () => Promise<void>;
}>;

describeDb("Terraform database-grant script real PostgreSQL/TLS integration", () => {
  let fixtureRoot: string;
  let certificates: CertificateFixtures;
  let databases: DisposableDatabases;
  let tlsProxy: TlsProxy;
  let hostnameMismatchProxy: TlsProxy;
  let provider: ProviderDouble;
  let sentinel: Readonly<{ connections: () => number; close: () => Promise<void> }>;
  const adminUrl = new URL(adminDatabaseUrl ?? "postgresql://skip:skip@localhost/skip");
  const stdout: string[] = [];
  const stderr: string[] = [];

  beforeAll(async () => {
    if (!adminUrl.username || !adminUrl.password) {
      throw new Error("terraform-database-grant-tls.db.test.ts requires TEST_DATABASE_URL user/password authority.");
    }
    fixtureRoot = await mkdtemp(join(tmpdir(), "terraform-database-grant-tls-"));
    certificates = await createCertificateFixtures(fixtureRoot);
    databases = await createDisposableDatabases(adminDatabaseUrl!);
    tlsProxy = await startTlsPostgresProxy(certificates.serverCertificate, certificates.serverKey, adminUrl);
    hostnameMismatchProxy = await startTlsPostgresProxy(
      certificates.hostnameMismatchCertificate,
      certificates.hostnameMismatchKey,
      adminUrl,
    );
    provider = await startProviderDouble(await readFile(certificates.caCertificate, "utf8"));
    sentinel = await startSentinel(tlsProxy.port);
  });

  afterAll(async () => {
    await sentinel?.close();
    await hostnameMismatchProxy?.close();
    await tlsProxy?.close();
    await provider?.close();
    await databases?.close();
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  it("uses one fetched CA while selecting a distinct verified client/database for every owner and listener grant", async () => {
    const requestStart = provider.requests.length;
    const connectionStart = tlsProxy.connections();
    const ownerGrants = grants(databases.databases, databases.owners, "owner");
    const listenerGrants = grants(databases.databases, databases.listeners, "wake-listener");

    await expect(runGrants(ownerGrants)).resolves.toBe(0);
    await expect(runGrants(listenerGrants)).resolves.toBe(0);

    expect(provider.requests.slice(requestStart)).toHaveLength(2);
    expect(tlsProxy.connections() - connectionStart).toBe(4);
    for (const request of provider.requests.slice(requestStart)) {
      expect(request.url).toMatch(/\/v2\/databases\/synthetic-cluster-id\/ca$/);
      expect(request.authorization).toBe("Bearer synthetic-provider-token");
    }
    expect(sentinel.connections()).toBe(0);
    expect(stdout.splice(0)).toEqual([
      '{"status":"database-grants-applied","grantCount":2}',
      '{"status":"database-grants-applied","grantCount":2}',
    ]);
    expect(stderr.splice(0)).toEqual([]);

    const first = await privilegeOracle(databases.databases[0], {
      owner: databases.owners[0],
      siblingOwner: databases.owners[1],
      listener: databases.listeners[0],
      siblingListener: databases.listeners[1],
    });
    const second = await privilegeOracle(databases.databases[1], {
      owner: databases.owners[1],
      siblingOwner: databases.owners[0],
      listener: databases.listeners[1],
      siblingListener: databases.listeners[0],
    });
    expect(first).toEqual(completePrivilegeOracle());
    expect(second).toEqual(completePrivilegeOracle());
  });

  it("detects first-database pinning, missing tables, and dropped SELECT mutants with all other inputs fixed", async () => {
    const ownerGrants = grants(databases.databases, databases.owners, "owner");
    const listenerGrants = grants(databases.databases, databases.listeners, "wake-listener");

    await revokeSchemaPrivileges(databases.owners);
    const pinningMutant = await runGrants(ownerGrants, {
      connectionUrlForGrant: (options: unknown, grant: Grant, caPath: string) =>
        connectionUrlForGrant(options, { ...grant, database: databases.databases[0] }, caPath),
    });
    expect(pinningMutant).toBe(1);
    expect(JSON.parse(stderr.shift()!)).toEqual({ classification: "managed-postgres-connection-url-invalid" });
    expect(
      (
        await privilegeOracle(databases.databases[1], {
          owner: databases.owners[1],
          siblingOwner: databases.owners[0],
          listener: databases.listeners[1],
          siblingListener: databases.listeners[0],
        })
      ).ownerSchema,
    ).toBe(false);
    await expect(runGrants(ownerGrants)).resolves.toBe(0);

    await revokeTablePrivileges(databases.listeners);
    await expect(
      runGrants(listenerGrants, {
        statementsForGrant: (grant: Grant) =>
          productionStatementsForGrant(grant).filter(
            (statement: string) => !statement.includes("GRANT SELECT ON TABLE"),
          ),
      }),
    ).resolves.toBe(0);
    expect(
      (
        await privilegeOracle(databases.databases[1], {
          owner: databases.owners[1],
          siblingOwner: databases.owners[0],
          listener: databases.listeners[1],
          siblingListener: databases.listeners[0],
        })
      ).listenerTables,
    ).toEqual([false, false]);
    await expect(runGrants(listenerGrants)).resolves.toBe(0);

    await inDatabase(databases.databases[1], async (client) => {
      await client.query("DROP TABLE public.event_store_streams");
    });
    await expect(runGrants(listenerGrants)).resolves.toBe(0);
    expect(
      (
        await privilegeOracle(databases.databases[1], {
          owner: databases.owners[1],
          siblingOwner: databases.owners[0],
          listener: databases.listeners[1],
          siblingListener: databases.listeners[0],
        })
      ).tablesPresent,
    ).toEqual([true, false]);
    await inDatabase(databases.databases[1], async (client) => {
      await client.query("CREATE TABLE public.event_store_streams (stream_id text PRIMARY KEY)");
      await client.query("REVOKE ALL ON TABLE public.event_store_streams FROM PUBLIC");
    });
    await expect(runGrants(listenerGrants)).resolves.toBe(0);

    const restored = await privilegeOracle(databases.databases[1], {
      owner: databases.owners[1],
      siblingOwner: databases.owners[0],
      listener: databases.listeners[1],
      siblingListener: databases.listeners[0],
    });
    expect(restored).toEqual(completePrivilegeOracle());
    expect(sentinel.connections()).toBe(0);
    expectSafeOutput(stdout.splice(0), stderr.splice(0));
  });

  it("rejects a wrong CA and a wrong hostname through the real TLS/Postgres client seam", async () => {
    provider.setCertificate(await readFile(certificates.wrongCaCertificate, "utf8"));
    await expect(runGrants([grants(databases.databases, databases.owners, "owner")[0]])).resolves.toBe(1);
    const wrongCaOutput = stderr.shift()!;
    const wrongCaFailure = JSON.parse(wrongCaOutput);
    expect(["certificate-authority-untrusted", "self-signed-certificate-in-certificate-chain"]).toContain(
      wrongCaFailure.classification,
    );

    provider.setCertificate(await readFile(certificates.caCertificate, "utf8"));
    await expect(
      runGrants([grants(databases.databases, databases.owners, "owner")[0]], {}, hostnameMismatchProxy.port),
    ).resolves.toBe(1);
    const wrongHostnameOutput = stderr.shift()!;
    expect(JSON.parse(wrongHostnameOutput)).toMatchObject({ classification: "certificate-hostname-mismatch" });
    expect(stdout.splice(0)).toEqual([]);
    expect(sentinel.connections()).toBe(0);
    expectSafeOutput([], [wrongCaOutput, wrongHostnameOutput]);
  });

  async function runGrants(grantSet: readonly Grant[], dependencies = {}, port = tlsProxy.port): Promise<number> {
    return runGrantScript(
      {
        PGHOSTADDR: "127.0.0.2",
        PGHOST: "localhost",
        PGPORT: String(port),
        PGDATABASE: "hostile-database",
        PGUSER: decodeURIComponent(adminUrl.username),
        PGPASSWORD: decodeURIComponent(adminUrl.password),
        PGSSLMODE: "disable",
        PGSSLROOTCERT: "hostile-ca",
        PGSERVICE: "hostile-service",
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
        DATABASE_CLUSTER_ID: "synthetic-cluster-id",
        DIGITALOCEAN_ACCESS_TOKEN: "synthetic-provider-token",
        DATABASE_GRANTS_JSON: JSON.stringify(grantSet),
      },
      {
        apiBaseUrl: provider.apiBaseUrl,
        temporaryDirectoryParent: fixtureRoot,
        log: (line: string) => stdout.push(line),
        error: (line: string) => stderr.push(line),
        ...dependencies,
      },
    );
  }

  async function privilegeOracle(
    database: string,
    roles: Readonly<{ owner: string; siblingOwner: string; listener: string; siblingListener: string }>,
  ) {
    return inDatabase(database, async (client) => {
      const result = await client.query<{
        tables_present: boolean[];
        owner_schema: boolean;
        sibling_owner_schema: boolean;
        listener_schema: boolean;
        sibling_listener_schema: boolean;
        listener_tables: boolean[];
        sibling_listener_tables: boolean[];
      }>(
        `SELECT ARRAY[
                  to_regclass('public.event_store_events') IS NOT NULL,
                  to_regclass('public.event_store_streams') IS NOT NULL
                ] AS tables_present,
                has_schema_privilege($1, 'public', 'USAGE') AND
                  has_schema_privilege($1, 'public', 'CREATE') AS owner_schema,
                has_schema_privilege($2, 'public', 'USAGE') OR
                  has_schema_privilege($2, 'public', 'CREATE') AS sibling_owner_schema,
                has_schema_privilege($3, 'public', 'USAGE') AND
                  NOT has_schema_privilege($3, 'public', 'CREATE') AS listener_schema,
                has_schema_privilege($4, 'public', 'USAGE') OR
                  has_schema_privilege($4, 'public', 'CREATE') AS sibling_listener_schema,
                ARRAY[
                  has_table_privilege($3, 'public.event_store_events', 'SELECT'),
                  CASE WHEN to_regclass('public.event_store_streams') IS NULL THEN false
                    ELSE has_table_privilege($3, 'public.event_store_streams', 'SELECT') END
                ] AS listener_tables,
                ARRAY[
                  has_table_privilege($4, 'public.event_store_events', 'SELECT'),
                  CASE WHEN to_regclass('public.event_store_streams') IS NULL THEN false
                    ELSE has_table_privilege($4, 'public.event_store_streams', 'SELECT') END
                ] AS sibling_listener_tables`,
        [roles.owner, roles.siblingOwner, roles.listener, roles.siblingListener],
      );
      return {
        tablesPresent: result.rows[0].tables_present,
        ownerSchema: result.rows[0].owner_schema,
        siblingOwnerSchema: result.rows[0].sibling_owner_schema,
        listenerSchema: result.rows[0].listener_schema,
        siblingListenerSchema: result.rows[0].sibling_listener_schema,
        listenerTables: result.rows[0].listener_tables,
        siblingListenerTables: result.rows[0].sibling_listener_tables,
      };
    });
  }

  async function revokeSchemaPrivileges(roles: readonly string[]) {
    for (const database of databases.databases) {
      await inDatabase(database, (client) =>
        client.query(`REVOKE ALL ON SCHEMA public FROM ${roles.map(quoteIdentifier).join(", ")}`),
      );
    }
  }

  async function revokeTablePrivileges(roles: readonly string[]) {
    for (const database of databases.databases) {
      await inDatabase(database, (client) =>
        client.query(
          `REVOKE ALL ON TABLE public.event_store_events, public.event_store_streams FROM ${roles
            .map(quoteIdentifier)
            .join(", ")}`,
        ),
      );
    }
  }

  async function inDatabase<T>(database: string, operation: (client: InstanceType<typeof Client>) => Promise<T>) {
    const url = new URL(adminDatabaseUrl!);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      return await operation(client);
    } finally {
      await client.end();
    }
  }
});

function grants(
  databaseNames: readonly [string, string],
  roleNames: readonly [string, string],
  kind: "owner" | "wake-listener",
): Grant[] {
  return databaseNames.map((database, index) => ({ database, user: roleNames[index], kind }));
}

function completePrivilegeOracle() {
  return {
    tablesPresent: [true, true],
    ownerSchema: true,
    siblingOwnerSchema: false,
    listenerSchema: true,
    siblingListenerSchema: false,
    listenerTables: [true, true],
    siblingListenerTables: [false, false],
  };
}

async function createDisposableDatabases(connectionString: string): Promise<DisposableDatabases> {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const databases = [`g7312_${suffix}_a`, `g7312_${suffix}_b`] as const;
  const owners = [`g7312_${suffix}_oa`, `g7312_${suffix}_ob`] as const;
  const listeners = [`g7312_${suffix}_la`, `g7312_${suffix}_lb`] as const;
  const admin = new Client({ connectionString });
  await admin.connect();
  try {
    for (const role of [...owners, ...listeners]) {
      await admin.query(`CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD 'synthetic-role-password'`);
    }
    for (const database of databases) {
      await admin.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
    }
  } finally {
    await admin.end();
  }

  for (const database of databases) {
    const url = new URL(connectionString);
    url.pathname = `/${database}`;
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
      await client.query("CREATE TABLE public.event_store_events (event_id text PRIMARY KEY)");
      await client.query("CREATE TABLE public.event_store_streams (stream_id text PRIMARY KEY)");
      await client.query("REVOKE ALL ON TABLE public.event_store_events, public.event_store_streams FROM PUBLIC");
    } finally {
      await client.end();
    }
  }

  return {
    databases,
    owners,
    listeners,
    close: async () => {
      const cleanup = new Client({ connectionString });
      await cleanup.connect();
      try {
        for (const database of databases) {
          await cleanup.query(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
            [database],
          );
          await cleanup.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`);
        }
        for (const role of [...owners, ...listeners]) {
          await cleanup.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
        }
      } finally {
        await cleanup.end();
      }
    },
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function createCertificateFixtures(directory: string): Promise<CertificateFixtures> {
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
    "/CN=grant-test-ca",
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

async function runOpenSsl(args: string[]): Promise<void> {
  const executable =
    process.env.OPENSSL_PATH ??
    (process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl");
  await execFileAsync(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function startTlsPostgresProxy(certificatePath: string, keyPath: string, backendUrl: URL): Promise<TlsProxy> {
  const secureContext = tls.createSecureContext({
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  });
  const sockets = new Set<Socket>();
  let connectionCount = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    socket.once("data", (request) => {
      if (!Buffer.isBuffer(request) || request.length !== 8 || request.readInt32BE(4) !== 80877103) {
        socket.destroy();
        return;
      }
      connectionCount += 1;
      socket.write("S");
      const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
      sockets.add(secureSocket);
      secureSocket.on("close", () => sockets.delete(secureSocket));
      secureSocket.on("error", () => undefined);
      const backend = net.createConnection({
        host: backendUrl.hostname,
        port: Number(backendUrl.port || "5432"),
      });
      sockets.add(backend);
      backend.on("close", () => sockets.delete(backend));
      backend.on("error", () => secureSocket.destroy());
      secureSocket.pipe(backend).pipe(secureSocket);
    });
  });
  await listen(server, 0, "127.0.0.1");
  return {
    port: (server.address() as net.AddressInfo).port,
    connections: () => connectionCount,
    close: () => closeServer(server, sockets),
  };
}

async function startProviderDouble(initialCertificate: string): Promise<ProviderDouble> {
  let certificate = initialCertificate;
  const requests: Array<Readonly<{ url: string; authorization: string }>> = [];
  const sockets = new Set<Socket>();
  const server = createHttpServer((request, response) => {
    requests.push({ url: request.url ?? "", authorization: String(request.headers.authorization ?? "") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ca: { certificate: Buffer.from(certificate).toString("base64") } }));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await listen(server, 0, "127.0.0.1");
  const port = (server.address() as net.AddressInfo).port;
  return {
    apiBaseUrl: `http://127.0.0.1:${port}/v2`,
    requests,
    setCertificate: (value) => {
      certificate = value;
    },
    close: () => closeHttpServer(server, sockets),
  };
}

async function startSentinel(port: number) {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.destroy();
  });
  await listen(server, port, "127.0.0.2");
  return { connections: () => connections, close: () => closeServer(server, sockets) };
}

function listen(server: NetServer | HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: NetServer, sockets: Set<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  for (const socket of sockets) socket.destroy();
  await closed;
}

async function closeHttpServer(server: HttpServer, sockets: Set<Socket>): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  await closed;
}

function expectSafeOutput(out: readonly string[], err: readonly string[]): void {
  const output = [...out, ...err].join("\n");
  for (const marker of [
    "synthetic-provider-token",
    decodeURIComponent(new URL(adminDatabaseUrl!).password),
    "hostile-database",
    "hostile-service",
  ]) {
    expect(output).not.toContain(marker);
  }
  expect(output).not.toContain("BEGIN CERTIFICATE");
  expect(output).not.toContain("postgresql://");
}
