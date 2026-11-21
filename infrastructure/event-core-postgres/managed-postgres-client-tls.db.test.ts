import { execFile as execFileCallback, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants as fsConstants } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import tls from "node:tls";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  ManagedPostgresClientError,
  createPgClient,
  createPgPool,
  managedPostgresPodCaPath,
  managedPostgresRunnerCaPath,
} from "./pool";
import type { PgTransactionalPool } from "./types";

const execFile = promisify(execFileCallback);
const adminDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!adminDatabaseUrl && process.env.CI) {
  throw new Error("TEST_DATABASE_URL is required for database-backed tests in CI.");
}
if (adminDatabaseUrl && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(adminDatabaseUrl).hostname)) {
  throw new Error("Managed client TLS tests require a disposable loopback PostgreSQL backend.");
}
const describeDb = adminDatabaseUrl ? describe : describe.skip;
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

// Hosted DB Profile provisions this directory (the #7512 pod mount path) for
// the runner user; elsewhere the pod cases need the same writable directory.
const podCaWritable = (() => {
  try {
    accessSync(dirname(managedPostgresPodCaPath), fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
})();
if (adminDatabaseUrl && process.env.CI && !podCaWritable) {
  throw new Error(
    `Hosted DB Profile must provision a writable ${dirname(managedPostgresPodCaPath)} for pod TLS cases.`,
  );
}
const itPod = podCaWritable ? it : it.skip;

const secretMarkers = ["tls-client-secret-marker", "postgresql://", "BEGIN CERTIFICATE", "sslrootcert"];

type Certificates = Readonly<{
  caA: string;
  caB: string;
  serverA: Readonly<{ cert: string; key: string }>;
  serverB: Readonly<{ cert: string; key: string }>;
  serverWrongName: Readonly<{ cert: string; key: string }>;
}>;

type TlsProxy = Readonly<{ port: number; connections: () => number; close: () => Promise<void> }>;

type ScriptModule = Record<string, (databaseUrl: string) => Promise<pg.Client | PgTransactionalPool>>;
// The seam returns a pg.Pool; this package types it by its transactional surface.
type ClosablePool = PgTransactionalPool & Readonly<{ end: () => Promise<void> }>;
type PoolFactoryModule = Record<string, (databaseUrl: string) => PgTransactionalPool>;

describeDb("managed Postgres client TLS against real PostgreSQL", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
  const database = `tls_client_${suffix}`;
  const roleName = `tls_client_role_${suffix}`;
  const rolePassword = "tls-client-secret-marker";
  let directory: string;
  let runnerTemp: string;
  let certificates: Certificates;
  let proxyA: TlsProxy;
  let proxyB: TlsProxy;
  let proxyWrongName: TlsProxy;
  let sentinel: TlsProxy;
  const restoreEnv: Array<() => void> = [];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "managed-postgres-client-tls-"));
    runnerTemp = join(directory, "runner-temp");
    await mkdir(runnerTemp);
    certificates = await createCertificates(directory);
    const backend = new URL(adminDatabaseUrl!);
    const target = { host: backend.hostname, port: Number(backend.port || "5432") };
    proxyA = await startTlsProxy(certificates.serverA, target);
    proxyB = await startTlsProxy(certificates.serverB, target);
    proxyWrongName = await startTlsProxy(certificates.serverWrongName, target);
    sentinel = await startSentinel();
    await withAdminClient(async (client) => {
      await client.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}'`);
      await client.query(`CREATE DATABASE ${database} OWNER ${roleName}`);
    });
    const owner = new pg.Client({ connectionString: localUrl(database), ssl: false });
    await owner.connect();
    try {
      await owner.query("CREATE SCHEMA catalog");
      await owner.query("CREATE TABLE catalog.bounded_context_schema_migrations (version text PRIMARY KEY)");
    } finally {
      await owner.end();
    }
  });

  afterEach(() => {
    while (restoreEnv.length > 0) restoreEnv.pop()!();
  });

  afterAll(async () => {
    await Promise.all([proxyA, proxyB, proxyWrongName, sentinel].filter(Boolean).map((proxy) => proxy.close()));
    if (adminDatabaseUrl) {
      await withAdminClient(async (client) => {
        await client.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
          [database],
        );
        await client.query(`DROP DATABASE IF EXISTS ${database}`);
        await client.query(`DROP ROLE IF EXISTS ${roleName}`);
      }).catch(() => undefined);
    }
    if (podCaWritable) await rm(managedPostgresPodCaPath, { force: true });
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function setEnv(values: Record<string, string | undefined>) {
    const previous = Object.fromEntries(Object.keys(values).map((name) => [name, process.env[name]]));
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    restoreEnv.push(() => {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    });
  }

  // Ambient libpq variables aim at a sentinel; an admitted client must ignore them.
  const hostileAmbient = () => ({
    PGHOST: "127.0.0.1",
    PGHOSTADDR: "127.0.0.1",
    PGPORT: String(sentinel.port),
    PGSSLMODE: "disable",
    PGSSLROOTCERT: join(directory, "ambient-ca.pem"),
    MANAGED_POSTGRES_CA_PATH: join(directory, "ambient-ca.pem"),
  });

  function runnerContext() {
    setEnv({
      ...hostileAmbient(),
      GITHUB_ACTIONS: "true",
      RUNNER_TEMP: runnerTemp,
      KUBERNETES_SERVICE_HOST: undefined,
      DEPLOYMENT_ENVIRONMENT: "staging",
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    });
    return managedPostgresRunnerCaPath(runnerTemp);
  }

  function podContext() {
    setEnv({
      ...hostileAmbient(),
      GITHUB_ACTIONS: undefined,
      RUNNER_TEMP: undefined,
      KUBERNETES_SERVICE_HOST: "10.245.0.1",
      DEPLOYMENT_ENVIRONMENT: "staging",
      NODE_TLS_REJECT_UNAUTHORIZED: undefined,
    });
    return managedPostgresPodCaPath;
  }

  function managedUrl(proxy: TlsProxy, caPath: string, overrides: Record<string, string | null> = {}): string {
    const url = new URL(`postgresql://${roleName}:${rolePassword}@localhost:${proxy.port}/${database}`);
    const params: Record<string, string | null> = {
      sslmode: "verify-full",
      sslrootcert: caPath,
      uselibpqcompat: "true",
      ...overrides,
    };
    for (const [key, value] of Object.entries(params)) {
      if (value !== null) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  async function selectOne(client: Pick<pg.ClientBase, "query">) {
    const result = await client.query<{ value: number }>("SELECT 1 AS value");
    return result.rows[0]?.value;
  }

  async function poolSelectOne(pool: PgTransactionalPool) {
    try {
      return await selectOne(pool as unknown as pg.Pool);
    } finally {
      await (pool as ClosablePool).end();
    }
  }

  async function clientSelectOne(client: pg.Client) {
    await client.connect();
    try {
      return await selectOne(client);
    } finally {
      await client.end();
    }
  }

  async function refusal(operation: () => unknown): Promise<string> {
    try {
      await operation();
    } catch (error) {
      expect(error).toBeInstanceOf(ManagedPostgresClientError);
      const serialized = `${String(error)} ${JSON.stringify(error)} ${(error as Error).stack ?? ""}`;
      for (const marker of secretMarkers) expect(serialized).not.toContain(marker);
      expect(serialized).not.toContain(String(proxyA.port));
      return (error as ManagedPostgresClientError).classification;
    }
    return "connected";
  }

  it("reaches SELECT 1 through createPgPool on a runner with only the exported runner CA", async () => {
    const caPath = runnerContext();
    await writeFile(caPath, await readFile(certificates.caA));
    const start = proxyA.connections();
    expect(await poolSelectOne(createPgPool(managedUrl(proxyA, caPath)))).toBe(1);
    expect(proxyA.connections() - start).toBe(1);
    expect(sentinel.connections()).toBe(0);
  });

  itPod("reaches SELECT 1 through createPgPool in a pod with only the #7512 mount", async () => {
    const caPath = podContext();
    await writeFile(caPath, await readFile(certificates.caA));
    expect(await poolSelectOne(createPgPool(managedUrl(proxyA, caPath)))).toBe(1);
    expect(sentinel.connections()).toBe(0);
  });

  it("reaches SELECT 1 through every direct-parser script's client on a runner", async () => {
    const caPath = runnerContext();
    await writeFile(caPath, await readFile(certificates.caA));
    const url = managedUrl(proxyA, caPath);
    // Loaded by URL so the scripts keep their own compiler settings.
    const reset = (await import(scriptUrl("catalog-integration-reset.ts"))) as PoolFactoryModule;
    const sendWindow = (await import(scriptUrl("catalog-provider-send-window.ts"))) as PoolFactoryModule;
    const redaction = (await import(scriptUrl("collections-anonymous-owner-redaction.mjs"))) as ScriptModule;
    const capture = (await import(scriptUrl("collections-cutover-authority-capture.mjs"))) as ScriptModule;
    const start = proxyA.connections();

    expect(await poolSelectOne(reset.createCatalogIntegrationResetPool!(url))).toBe(1);
    expect(await poolSelectOne(sendWindow.createProviderSendWindowPool!(url))).toBe(1);
    expect(await poolSelectOne((await redaction.openRedactionPool!(url)) as PgTransactionalPool)).toBe(1);
    expect(await clientSelectOne((await capture.createCaptureDatabaseClient!(url)) as pg.Client)).toBe(1);
    expect(await clientSelectOne((await capture.createCapturePooledClient!(url)) as pg.Client)).toBe(1);
    expect(proxyA.connections() - start).toBe(5);
    expect(sentinel.connections()).toBe(0);
  });

  itPod("takes and releases the drill's held lock through the real injector in a pod", async () => {
    const caPath = podContext();
    await writeFile(caPath, await readFile(certificates.caA));
    const drill = (await import(scriptUrl("staging-bootstrap-hook-drill.mjs"))) as {
      buildHeldLockInjectorShell: (options: { heldLockTimeoutSeconds: number }) => string;
      HELD_LOCK_READY_MARKER: string;
      HELD_LOCK_TIMEOUT_MARKER: string;
    };
    const shell = drill.buildHeldLockInjectorShell({ heldLockTimeoutSeconds: 0 });
    const script = /<<'NODE'\r?\n([\s\S]*)\r?\nNODE$/u.exec(shell)?.[1];
    expect(script).toBeDefined();
    const output = await runInjector(script!, managedUrl(proxyA, caPath));

    expect(output.exitCode).toBe(0);
    expect(output.text).toContain(`${drill.HELD_LOCK_READY_MARKER} {"context":"catalog","schema":"catalog"`);
    expect(output.text).toContain(drill.HELD_LOCK_TIMEOUT_MARKER);
    for (const marker of secretMarkers) expect(output.text).not.toContain(marker);
    expect(sentinel.connections()).toBe(0);
  });

  it("refuses each unsafe URL input before connecting, with the exact taxonomy and no secret output", async () => {
    const caPath = runnerContext();
    await writeFile(caPath, await readFile(certificates.caA));
    const start = proxyA.connections();
    const cases: Array<[Record<string, string | null>, string]> = [
      [{ sslmode: null }, "remote-postgres-sslmode-missing"],
      [{ sslmode: "prefer" }, "remote-postgres-sslmode-downgraded"],
      [{ sslmode: "require" }, "remote-postgres-sslmode-downgraded"],
      [{ sslmode: "verify-ca" }, "remote-postgres-sslmode-downgraded"],
      [{ sslmode: "disable" }, "remote-postgres-sslmode-downgraded"],
      [{ sslrootcert: null }, "remote-postgres-rootcert-missing"],
      [{ sslrootcert: certificates.caA }, "remote-postgres-rootcert-path-unexpected"],
      [{ sslrootcert: managedPostgresPodCaPath }, "remote-postgres-rootcert-path-unexpected"],
      [{ uselibpqcompat: "false" }, "remote-postgres-libpq-compat-required"],
      [{ hostaddr: "127.0.0.1" }, "postgres-url-invalid"],
    ];
    for (const [overrides, classification] of cases) {
      const url = managedUrl(proxyA, caPath, overrides);
      expect(await refusal(() => createPgPool(url)), JSON.stringify(overrides)).toBe(classification);
      expect(await refusal(() => createPgClient(url)), JSON.stringify(overrides)).toBe(classification);
    }
    expect(await refusal(() => createPgPool("not a postgres url"))).toBe("postgres-url-invalid");
    // PGSSLROOTCERT alone is never authority, even when it names the runner CA.
    setEnv({ PGSSLROOTCERT: caPath });
    expect(await refusal(() => createPgPool(managedUrl(proxyA, caPath, { sslrootcert: null })))).toBe(
      "remote-postgres-rootcert-missing",
    );
    setEnv({ NODE_TLS_REJECT_UNAUTHORIZED: "0" });
    expect(await refusal(() => createPgPool(managedUrl(proxyA, caPath)))).toBe("remote-postgres-sslmode-downgraded");
    expect(proxyA.connections() - start).toBe(0);
  });

  it("classifies a withheld CA, a wrong CA and a wrong certificate name at the client seam", async () => {
    const caPath = runnerContext();
    await rm(caPath, { force: true });
    expect(await refusal(() => poolSelectOne(createPgPool(managedUrl(proxyA, caPath))))).toBe(
      "certificate-authority-file-unavailable",
    );
    expect(await refusal(() => clientSelectOne(createPgClient(managedUrl(proxyA, caPath))))).toBe(
      "certificate-authority-file-unavailable",
    );

    await writeFile(caPath, await readFile(certificates.caB));
    expect(await refusal(() => poolSelectOne(createPgPool(managedUrl(proxyA, caPath))))).toBe(
      "certificate-authority-untrusted",
    );

    await writeFile(caPath, await readFile(certificates.caA));
    expect(await refusal(() => poolSelectOne(createPgPool(managedUrl(proxyWrongName, caPath))))).toBe(
      "certificate-hostname-mismatch",
    );
    expect(await refusal(() => clientSelectOne(createPgClient(managedUrl(proxyWrongName, caPath))))).toBe(
      "certificate-hostname-mismatch",
    );
    expect(sentinel.connections()).toBe(0);
  });

  it("refuses a cross-location CA path and a runner context without RUNNER_TEMP", async () => {
    const runnerCaPath = runnerContext();
    await writeFile(runnerCaPath, await readFile(certificates.caA));
    podContext();
    expect(await refusal(() => createPgPool(managedUrl(proxyA, runnerCaPath)))).toBe(
      "remote-postgres-rootcert-path-unexpected",
    );
    setEnv({ GITHUB_ACTIONS: "true", KUBERNETES_SERVICE_HOST: undefined, RUNNER_TEMP: undefined });
    expect(await refusal(() => createPgPool(managedUrl(proxyA, runnerCaPath)))).toBe(
      "remote-postgres-rootcert-path-unexpected",
    );
  });

  it("trusts only the rotated CA for fresh connections after the CA file changes from A to B", async () => {
    const caPath = runnerContext();
    await writeFile(caPath, await readFile(certificates.caA));
    const poolA = createPgPool(managedUrl(proxyA, caPath)) as ClosablePool;
    const poolB = createPgPool(managedUrl(proxyB, caPath)) as ClosablePool;
    const fresh = async (pool: PgTransactionalPool) => {
      const client = await (pool as unknown as pg.Pool).connect();
      try {
        return await selectOne(client);
      } finally {
        client.release(true);
      }
    };
    try {
      expect(await fresh(poolA)).toBe(1);
      expect(await refusal(() => fresh(poolB))).toBe("certificate-authority-untrusted");

      await writeFile(caPath, await readFile(certificates.caB));

      expect(await fresh(poolB)).toBe(1);
      expect(await refusal(() => fresh(poolA))).toBe("certificate-authority-untrusted");
    } finally {
      await Promise.all([poolA.end(), poolB.end()]);
    }
  });

  function localUrl(name: string) {
    const url = new URL(adminDatabaseUrl!);
    url.username = roleName;
    url.password = rolePassword;
    url.pathname = `/${name}`;
    return url.toString();
  }

  async function runInjector(script: string, databaseUrl: string) {
    // The worker image runs the injector from the deployable directory with tsx.
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module"], {
      cwd: join(repositoryRoot, "deployables", "platform-worker"),
      env: {
        ...process.env,
        CHASE_SETS_HELD_LOCK_TIMEOUT_SECONDS: "0",
        DATABASE_URL_CATALOG: databaseUrl,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let text = "";
    child.stdout.on("data", (chunk) => (text += String(chunk)));
    child.stderr.on("data", (chunk) => (text += String(chunk)));
    child.stdin.end(script);
    const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { exitCode, text };
  }
});

function scriptUrl(file: string) {
  return pathToFileURL(fileURLToPath(new URL(`../../scripts/${file}`, import.meta.url))).href;
}

async function withAdminClient<T>(operation: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: adminDatabaseUrl, ssl: false });
  await client.connect();
  try {
    return await operation(client);
  } finally {
    await client.end();
  }
}

async function createCertificates(directory: string): Promise<Certificates> {
  const path = (name: string) => join(directory, name);
  const authority = async (name: string) => {
    await runOpenSsl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path(`${name}.key`),
      "-out",
      path(`${name}.pem`),
      "-subj",
      `/CN=${name}`,
      "-days",
      "1",
    ]);
    return path(`${name}.pem`);
  };
  const server = async (name: string, authorityName: string, dnsName: string) => {
    await writeFile(path(`${name}.ext`), `subjectAltName=DNS:${dnsName}\n`);
    await runOpenSsl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      path(`${name}.key`),
      "-out",
      path(`${name}.csr`),
      "-subj",
      `/CN=${dnsName}`,
    ]);
    await runOpenSsl([
      "x509",
      "-req",
      "-in",
      path(`${name}.csr`),
      "-CA",
      path(`${authorityName}.pem`),
      "-CAkey",
      path(`${authorityName}.key`),
      "-CAcreateserial",
      "-out",
      path(`${name}.pem`),
      "-days",
      "1",
      "-extfile",
      path(`${name}.ext`),
    ]);
    return { cert: path(`${name}.pem`), key: path(`${name}.key`) };
  };
  const caA = await authority("synthetic-managed-ca-a");
  const caB = await authority("synthetic-managed-ca-b");
  return {
    caA,
    caB,
    serverA: await server("server-a", "synthetic-managed-ca-a", "localhost"),
    serverB: await server("server-b", "synthetic-managed-ca-b", "localhost"),
    serverWrongName: await server("server-wrong-name", "synthetic-managed-ca-a", "wrong-name.invalid"),
  };
}

async function runOpenSsl(args: string[]) {
  const executable =
    process.env.OPENSSL_PATH ??
    (process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : "openssl");
  await execFile(executable, args, { windowsHide: true, maxBuffer: 1024 * 1024 });
}

// A disposable TLS terminator in front of the loopback test Postgres: it answers
// the SSLRequest, presents the synthetic server certificate and pipes bytes.
async function startTlsProxy(
  certificate: Readonly<{ cert: string; key: string }>,
  backend: Readonly<{ host: string; port: number }>,
): Promise<TlsProxy> {
  const secureContext = tls.createSecureContext({
    cert: await readFile(certificate.cert),
    key: await readFile(certificate.key),
  });
  const sockets = new Set<net.Socket>();
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.once("data", (request) => {
      if (!Buffer.isBuffer(request) || request.length !== 8 || request.readInt32BE(4) !== 80877103) {
        socket.destroy();
        return;
      }
      socket.write("S");
      const secureSocket = new tls.TLSSocket(socket, { isServer: true, secureContext });
      secureSocket.on("error", () => secureSocket.destroy());
      const backendSocket = net.createConnection(backend);
      sockets.add(backendSocket);
      backendSocket.on("close", () => sockets.delete(backendSocket));
      backendSocket.on("error", () => secureSocket.destroy());
      secureSocket.on("close", () => backendSocket.destroy());
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
  return {
    port: address.port,
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function startSentinel(): Promise<TlsProxy> {
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
    connections: () => connections,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
