import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import pg, { type Client as PgClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type DatabaseGrant,
  type DatabaseGrantDependencies,
  managedPostgresGrantUrl,
  quoteIdentifier,
  runDatabaseGrantMain,
  statementsForGrant,
} from "../../scripts/apply-digitalocean-database-grant.mjs";
import testConfig from "./vitest.config";

const execFile = promisify(execFileCallback);
const { Client } = pg;
const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
if (adminDatabaseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(adminDatabaseUrl).hostname)) {
  throw new Error("Terraform grant tests require a disposable loopback PostgreSQL backend.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;

type CertificatePaths = Readonly<{
  caCertificate: string;
  wrongCaCertificate: string;
  serverCertificate: string;
  serverKey: string;
}>;

type TlsProxy = Readonly<{
  port: number;
  connectionCount: () => number;
  close: (hookStartedAt: number, hookTimeout: number) => Promise<void>;
}>;

type Sentinel = Readonly<{
  port: number;
  connectionCount: () => number;
  close: (onCloseCallback?: () => void) => Promise<void>;
}>;

const secretMarkers = ["provider-db-secret-marker", "ambient-db-secret-marker", "postgresql://", "BEGIN CERTIFICATE"];
const cleanupErrorCodes = [
  "08001",
  "08006",
  "2BP01",
  "3D000",
  "53300",
  "55006",
  "57P01",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOENT",
  "EACCES",
];

const cleanupPhases = [
  "hook",
  "proxy-close",
  "sentinel-close",
  "sentinel-callback",
  "admin-connect",
  "database-terminate-1",
  "database-drop-1",
  "database-terminate-2",
  "database-drop-2",
  "role-drop-1",
  "role-drop-2",
  "role-drop-3",
  "role-drop-4",
  "admin-end",
  "tempdir-removal",
] as const;
type CleanupPhase = (typeof cleanupPhases)[number];
type PhaseRecord = {
  phase: CleanupPhase;
  state: "not-entered" | "started" | "completed" | "rejected";
  startedAt?: string;
  startedElapsedMs?: number;
  finishedAt?: string;
  finishedElapsedMs?: number;
  errorClass?: string;
  errorCode?: string;
};

function observeCleanup(hookStartedAt: number, directory?: string) {
  const phases = cleanupPhases.map((phase): PhaseRecord => ({ phase, state: "not-entered" }));
  const record = (phase: CleanupPhase) => phases[cleanupPhases.indexOf(phase)];
  const stamp = () => ({ at: new Date().toISOString(), elapsedMs: Date.now() - hookStartedAt });
  const tracePath = process.env.TLS_GRANT_CLEANUP_TRACE_PATH;
  const insideDirectory = tracePath && directory ? relative(directory, tracePath) : undefined;
  const writablePath =
    tracePath &&
    isAbsolute(tracePath) &&
    (insideDirectory === undefined ||
      insideDirectory === ".." ||
      insideDirectory.startsWith(`..${sep}`) ||
      isAbsolute(insideDirectory))
      ? tracePath
      : undefined;
  let created = false;
  let retained = 0;
  let swallowedAdminError = false;
  const snapshot = (kind: "pending-at-snapshot" | "hook-settled") => ({
    kind,
    at: new Date().toISOString(),
    elapsedMs: Date.now() - hookStartedAt,
    outcome:
      kind === "pending-at-snapshot"
        ? "pending"
        : record("hook").state === "rejected"
          ? "rejected"
          : swallowedAdminError
            ? "hook-complete-with-swallowed-admin-error"
            : phases.every((phase) => phase.state === "completed")
              ? "clean-completion"
              : "hook-complete-with-unentered-phase",
    phases: phases.map((phase) => ({ ...phase })),
  });
  const retain = (kind: "pending-at-snapshot" | "hook-settled") => {
    if (!writablePath || retained === 2) return;
    try {
      const line = `${JSON.stringify(snapshot(kind))}\n`;
      if (created) appendFileSync(writablePath, line);
      else writeFileSync(writablePath, line, { flag: "wx" });
      created = true;
      retained += 1;
    } catch {
      // Missing or unwritable evidence is inconclusive; observation must not change cleanup.
    }
  };
  const start = (phase: CleanupPhase) => {
    const item = record(phase);
    const { at, elapsedMs } = stamp();
    item.state = "started";
    item.startedAt = at;
    item.startedElapsedMs = elapsedMs;
  };
  const finish = (phase: CleanupPhase, rejected = false, error?: unknown) => {
    const item = record(phase);
    const { at, elapsedMs } = stamp();
    item.state = rejected ? "rejected" : "completed";
    item.finishedAt = at;
    item.finishedElapsedMs = elapsedMs;
    if (rejected) {
      const name = error instanceof Error ? error.name : "NonError";
      item.errorClass = ["Error", "TypeError", "RangeError", "AggregateError", "DatabaseError"].includes(name)
        ? name
        : "OtherError";
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (typeof code === "string") item.errorCode = cleanupErrorCodes.includes(code) ? code : "OTHER";
    }
  };
  const run = async <T>(phase: CleanupPhase, operation: () => Promise<T>): Promise<T> => {
    start(phase);
    try {
      const value = await operation();
      finish(phase);
      return value;
    } catch (error) {
      finish(phase, true, error);
      throw error;
    }
  };
  return {
    start,
    finish,
    run,
    retain,
    setSwallowedAdminError: () => {
      swallowedAdminError = true;
    },
  };
}

type CleanupObservation = ReturnType<typeof observeCleanup>;

describeDb("Terraform database-grant TLS against real PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const databases = [`grant_tls_a_${suffix}`, `grant_tls_b_${suffix}`] as const;
  const owners = [`grant_owner_a_${suffix}`, `grant_owner_b_${suffix}`] as const;
  const listeners = [`grant_listener_a_${suffix}`, `grant_listener_b_${suffix}`] as const;
  let temporaryDirectory: string;
  let certificates: CertificatePaths;
  let proxy: TlsProxy;
  let sentinel: Sentinel;

  beforeAll(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "terraform-grant-tls-db-"));
    certificates = await createCertificateFixtures(temporaryDirectory);
    const backend = new URL(adminDatabaseUrl!);
    proxy = await startTlsPostgresProxy(certificates.serverCertificate, certificates.serverKey, {
      host: backend.hostname,
      port: Number(backend.port || "5432"),
    });
    sentinel = await startSentinel();

    await withAdminClient(async (client) => {
      for (const role of [...owners, ...listeners]) {
        await client.query(`CREATE ROLE ${quoteIdentifier(role)} NOLOGIN`);
      }
      for (const database of databases) {
        await client.query(`CREATE DATABASE ${quoteIdentifier(database)}`);
        await client.query(`REVOKE CONNECT ON DATABASE ${quoteIdentifier(database)} FROM PUBLIC`);
      }
    });

    for (const database of databases) {
      await withDatabaseClient(database, async (client) => {
        await client.query("REVOKE ALL ON SCHEMA public FROM PUBLIC");
        await client.query("CREATE TABLE public.event_store_events (event_id bigint PRIMARY KEY)");
        await client.query("CREATE TABLE public.event_store_streams (stream_id bigint PRIMARY KEY)");
      });
    }
  });

  beforeEach(async () => {
    await withAdminClient(async (client) => {
      for (const database of databases) {
        for (const role of [...owners, ...listeners]) {
          await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM ${quoteIdentifier(role)}`);
        }
      }
    });
    for (const database of databases) {
      await withDatabaseClient(database, async (client) => {
        for (const role of [...owners, ...listeners]) {
          await client.query(`REVOKE ALL ON SCHEMA public FROM ${quoteIdentifier(role)}`);
          await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quoteIdentifier(role)}`);
        }
      });
    }
  });

  afterAll(async () => {
    const hookStartedAt = Date.now();
    const observation = observeCleanup(hookStartedAt, temporaryDirectory);
    observation.start("hook");
    let downstreamTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const hookTimeout = testConfig.test?.hookTimeout;
      if (typeof hookTimeout !== "number") throw new Error("TLS teardown requires a configured hookTimeout.");
      if (proxy) await observation.run("proxy-close", () => proxy.close(hookStartedAt, hookTimeout));
      if (proxy) {
        const snapshotDelay = Math.max(0, hookTimeout - 5_000 - (Date.now() - hookStartedAt));
        downstreamTimer = setTimeout(() => observation.retain("pending-at-snapshot"), snapshotDelay);
        downstreamTimer.unref();
      }
      if (sentinel) {
        await observation.run("sentinel-close", () =>
          sentinel.close(() => {
            observation.start("sentinel-callback");
            observation.finish("sentinel-callback");
          }),
        );
      }
      if (adminDatabaseUrl) {
        await withAdminClient(async (client) => {
          for (const [index, database] of databases.entries()) {
            await observation.run(`database-terminate-${index + 1}` as CleanupPhase, () =>
              client.query(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
                [database],
              ),
            );
            await observation.run(`database-drop-${index + 1}` as CleanupPhase, () =>
              client.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`),
            );
          }
          for (const [index, role] of [...owners, ...listeners].entries()) {
            await observation.run(`role-drop-${index + 1}` as CleanupPhase, () =>
              client.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`),
            );
          }
        }, observation).catch(() => {
          observation.setSwallowedAdminError();
          return undefined;
        });
      }
      if (temporaryDirectory) {
        await observation.run("tempdir-removal", () => rm(temporaryDirectory, { recursive: true, force: true }));
      }
      observation.finish("hook");
    } catch (error) {
      observation.finish("hook", true, error);
      throw error;
    } finally {
      if (downstreamTimer) clearTimeout(downstreamTimer);
      downstreamTimer = undefined;
      observation.retain("hook-settled");
    }
  });

  it("applies owner and wake-listener grants to each grant's own database through one fetched CA", async () => {
    const startConnections = proxy.connectionCount();
    const startSentinelConnections = sentinel.connectionCount();
    const trackedPaths: string[] = [];
    let providerCalls = 0;

    const output = await withHostileAmbient(sentinel.port, () =>
      runGrantMain(grantSet(), certificates.caCertificate, {
        managedPostgresGrantUrl: (grant, env, caPath) => {
          trackedPaths.push(dirname(caPath));
          return managedPostgresGrantUrl(grant, env, caPath);
        },
        onProviderCall: () => {
          providerCalls += 1;
        },
      }),
    );

    expect(output.exitCode).toBe(0);
    expect(providerCalls).toBe(1);
    expect(proxy.connectionCount() - startConnections).toBe(4);
    expect(sentinel.connectionCount() - startSentinelConnections).toBe(0);
    expect(new Set(trackedPaths).size).toBe(1);
    for (const path of trackedPaths) await expectPathAbsent(path);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout.at(-1)!)).toEqual({
      classification: "managed-postgres-grants-applied",
      grantCount: 4,
    });
    expectSecretSafe(output);
    expect(await grantEvidenceIsComplete()).toBe(true);
  });

  it("makes the first-database-pinning bypass mutant fail before the sibling grant can land", async () => {
    const output = await runGrantMain(
      [
        { database: databases[0], user: owners[0], kind: "owner" },
        { database: databases[1], user: owners[1], kind: "owner" },
      ],
      certificates.caCertificate,
      {
        managedPostgresGrantUrl: (grant, env, caPath) => {
          const url = new URL(managedPostgresGrantUrl(grant, env, caPath));
          if (grant.database === databases[1]) url.pathname = `/${databases[0]}`;
          return url.toString();
        },
      },
    );

    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stderr.at(-1)!)).toEqual({
      classification: "managed-postgres-grant-authority-mismatch",
    });
    expect(await databasePrivilege(databases[1], owners[1], "CREATE")).toBe(false);
    expectSecretSafe(output);
  });

  it("makes missing-table and dropped-SELECT evidence controls fail while preserving best-effort SQL", async () => {
    await withDatabaseClient(databases[1], (client) => client.query("DROP TABLE public.event_store_streams"));
    try {
      const missingTable = await runGrantMain(grantSet(), certificates.caCertificate);
      expect(missingTable.exitCode).toBe(0);
      expect(await representativeTablesExist(databases[1])).toBe(false);
      expectSecretSafe(missingTable);
    } finally {
      await withDatabaseClient(databases[1], (client) =>
        client.query("CREATE TABLE public.event_store_streams (stream_id bigint PRIMARY KEY)"),
      );
    }

    await beforeEachResetPrivileges();
    const droppedSelect = await runGrantMain(grantSet(), certificates.caCertificate, {
      statementsForGrant: (grant) =>
        statementsForGrant(grant).filter((statement) => !statement.includes("GRANT SELECT")),
    });
    expect(droppedSelect.exitCode).toBe(0);
    expect(await tablePrivilege(databases[0], listeners[0], "event_store_events", "SELECT")).toBe(false);
    expect(await grantEvidenceIsComplete()).toBe(false);
    expectSecretSafe(droppedSelect);
  });

  it.each([
    { name: "wrong CA", host: "localhost", expected: "certificate-authority-untrusted" },
    { name: "wrong hostname", host: "127.0.0.1", expected: "certificate-hostname-mismatch" },
  ])("fails closed for $name at the real TLS/Postgres seam", async ({ name, host, expected }) => {
    const output = await runGrantMain(
      [{ database: databases[0], user: owners[0], kind: "owner" }],
      name === "wrong CA" ? certificates.wrongCaCertificate : certificates.caCertificate,
      { host },
    );

    expect(output.exitCode).toBe(1);
    expect(JSON.parse(output.stderr.at(-1)!)).toMatchObject({ classification: expected });
    expectSecretSafe(output);
  });

  function grantSet(): DatabaseGrant[] {
    return [
      { database: databases[0], user: owners[0], kind: "owner" },
      { database: databases[1], user: owners[1], kind: "owner" },
      { database: databases[0], user: listeners[0], kind: "wake-listener" },
      { database: databases[1], user: listeners[1], kind: "wake-listener" },
    ];
  }

  async function runGrantMain(
    grants: readonly DatabaseGrant[],
    caPath: string,
    {
      host = "localhost",
      onProviderCall,
      ...dependencies
    }: DatabaseGrantDependencies & {
      host?: string;
      onProviderCall?: () => void;
    } = {},
  ) {
    const admin = new URL(adminDatabaseUrl!);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const certificate = await readFile(caPath, "utf8");

    const exitCode = await runDatabaseGrantMain(
      {
        DATABASE_GRANTS_JSON: JSON.stringify(grants),
        DIGITALOCEAN_ACCESS_TOKEN: "provider-db-secret-marker",
        DIGITALOCEAN_DATABASE_CLUSTER_ID: "synthetic-loopback-cluster-7312",
        PGHOST: host,
        PGPASSWORD: decodeURIComponent(admin.password),
        PGPORT: String(proxy.port),
        PGUSER: decodeURIComponent(admin.username),
      },
      {
        ...dependencies,
        tmpdir: () => temporaryDirectory,
        log: (value) => stdout.push(value),
        error: (value) => stderr.push(value),
        fetch: async (url, request) => {
          onProviderCall?.();
          expect(url).toBe("https://api.digitalocean.com/v2/databases/synthetic-loopback-cluster-7312/ca");
          expect(request?.headers).toEqual({
            Accept: "application/json",
            Authorization: "Bearer provider-db-secret-marker",
          });
          return new Response(JSON.stringify({ ca: { certificate: Buffer.from(certificate).toString("base64") } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    );
    return { exitCode, stdout, stderr };
  }

  async function beforeEachResetPrivileges() {
    await withAdminClient(async (client) => {
      for (const database of databases) {
        for (const role of [...owners, ...listeners]) {
          await client.query(`REVOKE ALL ON DATABASE ${quoteIdentifier(database)} FROM ${quoteIdentifier(role)}`);
        }
      }
    });
    for (const database of databases) {
      await withDatabaseClient(database, async (client) => {
        for (const role of [...owners, ...listeners]) {
          await client.query(`REVOKE ALL ON SCHEMA public FROM ${quoteIdentifier(role)}`);
          await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${quoteIdentifier(role)}`);
        }
      });
    }
  }

  async function grantEvidenceIsComplete() {
    const evidenceRows = [
      {
        database: databases[0],
        owner: owners[0],
        siblingOwner: owners[1],
        listener: listeners[0],
        siblingListener: listeners[1],
      },
      {
        database: databases[1],
        owner: owners[1],
        siblingOwner: owners[0],
        listener: listeners[1],
        siblingListener: listeners[0],
      },
    ] as const;
    for (const { database, owner, siblingOwner, listener, siblingListener } of evidenceRows) {
      if (!(await representativeTablesExist(database))) return false;
      if (!(await databasePrivilege(database, owner, "CREATE"))) return false;
      if (await databasePrivilege(database, siblingOwner, "CREATE")) return false;
      if (!(await schemaPrivilege(database, owner, "USAGE"))) return false;
      if (!(await schemaPrivilege(database, owner, "CREATE"))) return false;
      if (await schemaPrivilege(database, siblingOwner, "USAGE")) return false;
      if (await schemaPrivilege(database, siblingOwner, "CREATE")) return false;
      if (!(await schemaPrivilege(database, listener, "USAGE"))) return false;
      if (await schemaPrivilege(database, siblingListener, "USAGE")) return false;
      for (const table of ["event_store_events", "event_store_streams"]) {
        if (!(await tablePrivilege(database, listener, table, "SELECT"))) return false;
        if (await tablePrivilege(database, siblingListener, table, "SELECT")) return false;
      }
    }
    return true;
  }

  async function representativeTablesExist(database: string) {
    return withDatabaseClient(database, async (client) => {
      const result = await client.query(
        "SELECT to_regclass('public.event_store_events') IS NOT NULL AS events, " +
          "to_regclass('public.event_store_streams') IS NOT NULL AS streams",
      );
      return result.rows[0].events === true && result.rows[0].streams === true;
    });
  }

  async function databasePrivilege(database: string, role: string, privilege: string) {
    return withDatabaseClient(database, async (client) => {
      const result = await client.query("SELECT has_database_privilege($1, $2, $3) AS allowed", [
        role,
        database,
        privilege,
      ]);
      return result.rows[0].allowed === true;
    });
  }

  async function schemaPrivilege(database: string, role: string, privilege: string) {
    return withDatabaseClient(database, async (client) => {
      const result = await client.query("SELECT has_schema_privilege($1, 'public', $2) AS allowed", [role, privilege]);
      return result.rows[0].allowed === true;
    });
  }

  async function tablePrivilege(database: string, role: string, table: string, privilege: string) {
    return withDatabaseClient(database, async (client) => {
      const result = await client.query("SELECT has_table_privilege($1, $2, $3) AS allowed", [
        role,
        `public.${table}`,
        privilege,
      ]);
      return result.rows[0].allowed === true;
    });
  }

  async function withAdminClient<T>(
    operation: (client: PgClient) => Promise<T>,
    observation?: CleanupObservation,
  ): Promise<T> {
    const client = new Client({ connectionString: adminDatabaseUrl! });
    if (observation) await observation.run("admin-connect", () => client.connect());
    else await client.connect();
    try {
      return await operation(client);
    } finally {
      if (observation) await observation.run("admin-end", () => client.end());
      else await client.end();
    }
  }

  async function withDatabaseClient<T>(database: string, operation: (client: PgClient) => Promise<T>): Promise<T> {
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

async function withHostileAmbient<T>(sentinelPort: number, operation: () => Promise<T>): Promise<T> {
  const hostile = {
    PGHOSTADDR: "127.0.0.1",
    PGHOST: "127.0.0.1",
    PGSERVICE: "ambient-db-secret-marker",
    PGPORT: String(sentinelPort),
    PGDATABASE: "ambient-db-secret-marker",
    PGUSER: "ambient-db-secret-marker",
    PGPASSWORD: "ambient-db-secret-marker",
    PGSSLMODE: "disable",
    PGSSLROOTCERT: "ambient-db-secret-marker",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
  };
  const previous = new Map(Object.keys(hostile).map((name) => [name, process.env[name]]));
  Object.assign(process.env, hostile);
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectSecretSafe(output: { stdout: string[]; stderr: string[] }) {
  const retained = JSON.stringify(output);
  for (const marker of secretMarkers) expect(retained).not.toContain(marker);
}

async function expectPathAbsent(path: string) {
  await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
}

async function createCertificateFixtures(directory: string): Promise<CertificatePaths> {
  const caKey = join(directory, "ca.key");
  const caCertificate = join(directory, "ca.pem");
  const wrongCaKey = join(directory, "wrong-ca.key");
  const wrongCaCertificate = join(directory, "wrong-ca.pem");
  const serverKey = join(directory, "server.key");
  const serverRequest = join(directory, "server.csr");
  const serverCertificate = join(directory, "server.pem");
  const extensions = join(directory, "server.ext");
  await writeFile(extensions, "subjectAltName=DNS:localhost\n");
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
    "/CN=terraform-grant-ca",
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
    "/CN=terraform-grant-wrong-ca",
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
  return { caCertificate, wrongCaCertificate, serverCertificate, serverKey };
}

async function runOpenSsl(args: string[]) {
  const executable =
    process.env.OPENSSL_PATH ??
    (process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl");
  await execFile(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
}

async function startTlsPostgresProxy(
  certificatePath: string,
  keyPath: string,
  backend: Readonly<{ host: string; port: number }>,
): Promise<TlsProxy> {
  const secureContext = tls.createSecureContext({
    cert: await readFile(certificatePath),
    key: await readFile(keyPath),
  });
  const sockets = new Set<net.Socket>();
  type ObservedSocket = { socket?: net.Socket; id: string; transition: string };
  const observed = new Set<ObservedSocket>();
  const releaseObservation = () => {
    for (const record of observed) record.socket = undefined;
    observed.clear();
  };
  let nextSocketId = 0;
  let lastTransition = `${new Date().toISOString()} listener:created`;
  let listenerState = "created";
  const mark = (id: string, transition: string) => {
    const stamped = `${new Date().toISOString()} ${id}:${transition}`;
    lastTransition = stamped;
    return stamped;
  };
  const track = (socket: net.Socket, kind: "raw" | "tls" | "backend") => {
    const record: ObservedSocket = { socket, id: `${kind}#${++nextSocketId}`, transition: "" };
    record.transition = mark(record.id, "created");
    observed.add(record);
    socket.on("end", () => {
      record.transition = mark(record.id, "end");
    });
    socket.on("close", () => {
      record.transition = mark(record.id, "closed");
    });
    return record;
  };
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    track(socket, "raw");
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.once("data", (request) => {
      if (!Buffer.isBuffer(request) || request.length !== 8 || request.readInt32BE(4) !== 80877103) {
        socket.destroy();
        return;
      }
      socket.write("S");
      const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
      const tlsRecord = track(secureSocket, "tls");
      secureSocket.on("secure", () => {
        tlsRecord.transition = mark(tlsRecord.id, "secure");
      });
      secureSocket.on("error", () => {
        tlsRecord.transition = mark(tlsRecord.id, "error");
      });
      const backendSocket = net.createConnection(backend);
      const backendRecord = track(backendSocket, "backend");
      backendSocket.on("connect", () => {
        backendRecord.transition = mark(backendRecord.id, "connected");
      });
      sockets.add(backendSocket);
      backendSocket.on("close", () => sockets.delete(backendSocket));
      backendSocket.on("error", () => {
        backendRecord.transition = mark(backendRecord.id, "error");
        secureSocket.destroy();
      });
      secureSocket.pipe(backendSocket);
      backendSocket.pipe(secureSocket);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TLS proxy did not bind a TCP port.");
  listenerState = "listening";
  mark("listener", "listening");
  return {
    port: address.port,
    connectionCount: () => connections,
    close: async (hookStartedAt, hookTimeout) => {
      const snapshot = (stage: string) => {
        const groups = (["raw", "tls", "backend"] as const).map((kind) => {
          const records = [...observed].filter((record) => record.id.startsWith(`${kind}#`));
          const active = records.filter((record) => !record.transition.endsWith(":closed"));
          const closed = records.filter((record) => record.transition.endsWith(":closed"));
          const details = active
            .slice(0, 12)
            .map(
              ({ socket, id, transition }) =>
                `${id}[${socket?.readyState ?? "released"},destroyed=${socket?.destroyed ?? "released"},connecting=${socket?.connecting ?? "released"},last=${transition}]`,
            );
          const recentClosed = closed.slice(-3).map(({ id, transition }) => `${id}[${transition}]`);
          return `${kind}=active:${active.length},closed:${closed.length},total:${records.length}{${[
            ...details,
            ...recentClosed,
            ...(active.length > 12 ? [`active-omitted=${active.length - 12}`] : []),
            ...(closed.length > 3 ? [`closed-omitted=${closed.length - 3}`] : []),
          ].join(",")}}`;
        });
        return `${new Date().toISOString()} ${stage} listener=${listenerState},listening=${server.listening} ${groups.join(" ")} last=${lastTransition}`;
      };
      const stages = [snapshot("entry")];
      let reported = false;
      const snapshotDelay = Math.max(0, hookTimeout - 5_000 - (Date.now() - hookStartedAt));
      const timer = setTimeout(() => {
        reported = true;
        console.error(`[tls-proxy-teardown] ${[...stages, snapshot("pre-ceiling pending")].join(" | ")}`);
        releaseObservation();
      }, snapshotDelay);
      timer.unref();
      try {
        for (const socket of sockets) socket.destroy();
        stages.push(snapshot("after-destroy"));
        listenerState = "closing";
        mark("listener", "closing");
        await new Promise<void>((resolve) =>
          server.close(() => {
            listenerState = "closed";
            mark("listener", "closed-callback");
            clearTimeout(timer);
            if (!reported) console.info(`[tls-proxy-teardown] ${[...stages, snapshot("close-callback")].join(" | ")}`);
            releaseObservation();
            resolve();
          }),
        );
      } finally {
        clearTimeout(timer);
        releaseObservation();
      }
    },
  };
}

async function startSentinel(): Promise<Sentinel> {
  let connections = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.destroy();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Sentinel did not bind a TCP port.");
  return {
    port: address.port,
    connectionCount: () => connections,
    close: async (onCloseCallback) => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          onCloseCallback?.();
          resolve();
        }),
      );
    },
  };
}
