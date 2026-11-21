import { isIP } from "node:net";
import { isAbsolute, join } from "node:path";
import pg from "pg";
import type { PgTransactionalPool } from "./types";

export type PgPoolOptions = Readonly<{
  max?: number;
  applicationName?: string;
  idleTimeoutMillis?: number;
  idleInTransactionSessionTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  statementTimeoutMillis?: number;
  onIdleClientError?: (event: PgPoolIdleClientErrorEvent) => void;
  onActiveClientError?: (event: PgPoolActiveClientErrorEvent) => void;
}>;

export type PgPoolIdleClientErrorEvent = Readonly<{
  error: unknown;
}>;

export type PgPoolActiveClientErrorEvent = Readonly<{
  error: unknown;
}>;

// The pod CA path is the managed Postgres CA Secret volume (mount directory + item path) that
// scripts/render-platform-helm-values.mjs mounts into every database-bearing pod.
export const managedPostgresPodCaPath = "/var/run/secrets/chase-sets/managed-postgres/ca.crt";
// Runner clients read the CA the canonical export action writes under RUNNER_TEMP
// (scripts/terraform-state-database-urls.mjs managedPostgresRunnerCaPath).
export const managedPostgresRunnerCaFileName = "digitalocean-managed-postgres-ca.pem";

export function managedPostgresRunnerCaPath(runnerTemp: string): string {
  return join(runnerTemp, managedPostgresRunnerCaFileName);
}

export const managedPostgresClientErrorCodes = [
  "postgres-url-invalid",
  "remote-postgres-sslmode-missing",
  "remote-postgres-sslmode-downgraded",
  "remote-postgres-rootcert-missing",
  "remote-postgres-rootcert-path-unexpected",
  "remote-postgres-libpq-compat-required",
  "certificate-authority-file-unavailable",
  "certificate-authority-untrusted",
  "certificate-hostname-mismatch",
  "postgres-connect-failed",
] as const;

export type ManagedPostgresClientErrorCode = (typeof managedPostgresClientErrorCodes)[number];

/**
 * The only error a refused or failed managed-Postgres client surfaces. Its
 * message is the classification; it never carries the URL, credentials, CA
 * bytes or provider text. `code` is a bounded uppercase transport code.
 */
export class ManagedPostgresClientError extends Error {
  readonly classification: ManagedPostgresClientErrorCode;
  readonly code?: string;

  constructor(classification: ManagedPostgresClientErrorCode, transportCode?: string) {
    super(classification);
    this.name = "ManagedPostgresClientError";
    this.classification = classification;
    if (transportCode !== undefined) {
      this.code = transportCode;
    }
  }
}

export type PostgresClientEnvironment = Readonly<Record<string, string | undefined>>;

export type PostgresClientAdmission = Readonly<{
  connectionString: string;
  transport: "plaintext-local" | "plaintext-preview" | "verified-managed";
}>;

// The chart renders the preview Postgres Service name for its release into
// every preview pod under this variable (chase-sets-platform.env in
// infrastructure/helm/platform/templates/_helpers.tpl).
export const previewPostgresHostEnvName = "CHASE_SETS_PREVIEW_POSTGRES_HOST";
// docker-compose.pr-smoke.yml gives its Postgres service this fixed alias: the
// preview Service name for the default release.
export const composePreviewPostgresHost = "chase-sets-platform-chase-sets-platform-preview-postgres";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1"]);
const refusedConnectionParameters = ["host", "hostaddr", "ssl", "sslcert", "sslkey"];
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const transportCodePattern = /^[A-Z0-9_]{1,40}$/;
const caFileErrorCodes = new Set(["ENOENT", "EACCES", "EISDIR", "ENOTDIR", "EPERM", "ELOOP"]);
const untrustedCertificateCodes = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_SIGNATURE_FAILURE",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
]);

/**
 * The CA path a managed client may use, fixed by the trusted execution context:
 * a Kubernetes pod reads the CA Secret mount; an admitted GitHub runner reads the
 * canonical export under RUNNER_TEMP. Preview, ambiguous or unknown contexts
 * have no managed trust location. URL, PGSSLROOTCERT, MANAGED_POSTGRES_CA_PATH
 * and caller options never select it.
 */
export function resolveManagedPostgresCaPath(env: PostgresClientEnvironment): string | undefined {
  if (env.DEPLOYMENT_ENVIRONMENT === "preview") {
    return undefined;
  }
  const runner = env.GITHUB_ACTIONS === "true";
  const pod = typeof env.KUBERNETES_SERVICE_HOST === "string" && env.KUBERNETES_SERVICE_HOST !== "";
  if (runner === pod) {
    return undefined;
  }
  if (pod) {
    return managedPostgresPodCaPath;
  }
  const runnerTemp = env.RUNNER_TEMP;
  if (typeof runnerTemp !== "string" || runnerTemp === "" || !isAbsolute(runnerTemp)) {
    return undefined;
  }
  return managedPostgresRunnerCaPath(runnerTemp);
}

/**
 * The one plaintext preview Postgres host under DEPLOYMENT_ENVIRONMENT=preview:
 * the Service the chart names for this release, or the fixed Compose alias
 * where no release names one. Any other host, including another release's
 * preview Service, is not a preview database.
 */
export function resolvePreviewPostgresHost(env: PostgresClientEnvironment): string | undefined {
  if (env.DEPLOYMENT_ENVIRONMENT !== "preview") {
    return undefined;
  }
  const releaseHost = env[previewPostgresHostEnvName];
  if (releaseHost === undefined || releaseHost === "") {
    return composePreviewPostgresHost;
  }
  return dnsLabel.test(releaseHost) ? releaseHost : undefined;
}

/**
 * Fail-closed admission for every runtime Postgres client. Plaintext is only
 * admitted for loopback hosts, or for the exact preview Postgres host under
 * DEPLOYMENT_ENVIRONMENT=preview with sslmode=disable. Every other URL must be
 * verify-full with libpq compatibility and the location-bound sslrootcert; pg
 * then reads only that CA file and verifies the DNS hostname.
 */
export function admitPostgresClientConnection(
  connectionString: string,
  env: PostgresClientEnvironment = process.env,
): PostgresClientAdmission {
  const url = parsePostgresUrl(connectionString);
  const hostname = url.hostname.toLowerCase().replace(/^\[(.*)\]$/u, "$1");
  const sslMode = url.searchParams.get("sslmode");
  const plaintextMode = sslMode === null || sslMode === "disable";

  if (loopbackHosts.has(hostname) && plaintextMode) {
    return { connectionString: withPlaintextMode(url, connectionString, sslMode), transport: "plaintext-local" };
  }
  if (sslMode === "disable" && hostname === resolvePreviewPostgresHost(env)) {
    return { connectionString, transport: "plaintext-preview" };
  }
  // The DNS hostname is the TLS identity (SNI and certificate name); an IP literal is not.
  if (isIP(hostname) !== 0) {
    throw new ManagedPostgresClientError("postgres-url-invalid");
  }
  if (sslMode === null) {
    throw new ManagedPostgresClientError("remote-postgres-sslmode-missing");
  }
  if (sslMode !== "verify-full" || env.NODE_TLS_REJECT_UNAUTHORIZED === "0") {
    throw new ManagedPostgresClientError("remote-postgres-sslmode-downgraded");
  }
  if (url.searchParams.get("uselibpqcompat") !== "true") {
    throw new ManagedPostgresClientError("remote-postgres-libpq-compat-required");
  }
  const rootCertificatePath = url.searchParams.get("sslrootcert");
  if (!rootCertificatePath) {
    throw new ManagedPostgresClientError("remote-postgres-rootcert-missing");
  }
  const expectedCaPath = resolveManagedPostgresCaPath(env);
  if (expectedCaPath === undefined || rootCertificatePath !== expectedCaPath) {
    throw new ManagedPostgresClientError("remote-postgres-rootcert-path-unexpected");
  }
  return { connectionString, transport: "verified-managed" };
}

export function classifyManagedPostgresClientError(error: unknown): ManagedPostgresClientError {
  if (error instanceof ManagedPostgresClientError) {
    return error;
  }
  const code = errorCode(error);
  if (code !== undefined && caFileErrorCodes.has(code)) {
    return new ManagedPostgresClientError("certificate-authority-file-unavailable");
  }
  if (code !== undefined && untrustedCertificateCodes.has(code)) {
    return new ManagedPostgresClientError("certificate-authority-untrusted", code);
  }
  if (code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return new ManagedPostgresClientError("certificate-hostname-mismatch", code);
  }
  return new ManagedPostgresClientError(
    "postgres-connect-failed",
    code !== undefined && transportCodePattern.test(code) ? code : undefined,
  );
}

const constructionFailures = new WeakMap<object, ManagedPostgresClientError>();

type ClientConnectCallback = (error: Error | null, client?: pg.Client) => void;

// pg reads sslrootcert while constructing a client, so a missing CA throws
// inside pg-pool's synchronous newClient(). The managed client converts that
// and every connect-phase failure into the closed taxonomy instead.
class ManagedPostgresClient extends pg.Client {
  constructor(config?: string | pg.ClientConfig) {
    let failure: ManagedPostgresClientError | undefined;
    try {
      super(config);
    } catch (error) {
      failure = classifyManagedPostgresClientError(error);
      super({});
    }
    if (failure) {
      constructionFailures.set(this, failure);
    }
  }

  override connect(): Promise<pg.Client>;
  override connect(callback: ClientConnectCallback): void;
  override connect(callback?: ClientConnectCallback): Promise<pg.Client> | void {
    const failure = constructionFailures.get(this);
    if (callback) {
      if (failure) {
        process.nextTick(() => callback(failure));
        return;
      }
      super.connect((error: Error | null) => {
        if (error) {
          callback(classifyManagedPostgresClientError(error));
          return;
        }
        callback(null, this);
      });
      return;
    }
    if (failure) {
      return Promise.reject(failure);
    }
    return super.connect().catch((error: unknown) => {
      throw classifyManagedPostgresClientError(error);
    });
  }
}

export type PgClientOptions = Omit<
  pg.ClientConfig,
  "connectionString" | "ssl" | "host" | "port" | "user" | "password" | "database" | "stream"
>;

/** A single admitted client for callers that need pg.Client semantics. */
export function createPgClient(
  connectionString: string,
  options: PgClientOptions = {},
  env: PostgresClientEnvironment = process.env,
): pg.Client {
  const admission = admitPostgresClientConnection(connectionString, env);
  const config = { ...options, connectionString: admission.connectionString };
  return admission.transport === "verified-managed" ? new ManagedPostgresClient(config) : new pg.Client(config);
}

export function createPgPool(connectionString: string, options: PgPoolOptions = {}): PgTransactionalPool {
  const admission = admitPostgresClientConnection(connectionString, process.env);
  // @types/pg declares onConnect as void, but pg-pool awaits the returned promise
  // before handing out the client, so session setup completes or rejects acquisition.
  const sessionSetup: { onConnect: (client: pg.ClientBase) => Promise<void> } = {
    onConnect: async (client) => {
      const activeClient = client as PgActiveClient;
      activeClient.on("error", (error: unknown) => {
        reportActiveClientError(options, error);
      });

      try {
        await configurePgClientSession(activeClient, options);
      } catch (error) {
        reportActiveClientError(options, error);
        throw error;
      }
    },
  };

  const pool = new pg.Pool({
    connectionString: admission.connectionString,
    ...(admission.transport === "verified-managed"
      ? { Client: ManagedPostgresClient as unknown as new () => pg.ClientBase }
      : {}),
    max: options.max,
    ...(options.applicationName === undefined ? {} : { application_name: options.applicationName }),
    ...(options.statementTimeoutMillis === undefined ? {} : { statement_timeout: options.statementTimeoutMillis }),
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    ...sessionSetup,
  });

  pool.on("error", (error: unknown) => {
    try {
      options.onIdleClientError?.({ error });
    } catch {
      // Pool idle-client errors must never crash the process.
    }
  });

  return Object.assign(pool, {
    idleInTransactionSessionTimeoutMillis: options.idleInTransactionSessionTimeoutMillis,
  }) as unknown as PgTransactionalPool;
}

type PgActiveClient = pg.PoolClient & {
  on: (event: "error", listener: (error: unknown) => void) => void;
  query: (queryText: string, values?: readonly unknown[]) => Promise<unknown>;
};

async function configurePgClientSession(client: PgActiveClient, options: PgPoolOptions): Promise<void> {
  if (options.idleInTransactionSessionTimeoutMillis === undefined) {
    return;
  }

  await client.query("SELECT set_config('idle_in_transaction_session_timeout', $1, false)", [
    `${options.idleInTransactionSessionTimeoutMillis}ms`,
  ]);
}

function reportActiveClientError(options: PgPoolOptions, error: unknown): void {
  try {
    options.onActiveClientError?.({ error });
  } catch {
    // Active checked-out client errors must never crash the process.
  }
}

function parsePostgresUrl(connectionString: string): URL {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new ManagedPostgresClientError("postgres-url-invalid");
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.hostname === "") {
    throw new ManagedPostgresClientError("postgres-url-invalid");
  }
  const keys = [...url.searchParams.keys()];
  // pg applies the last duplicate while URLSearchParams.get() reads the first,
  // so a repeated parameter could pass validation and still change the mode.
  if (new Set(keys).size !== keys.length || keys.some((key) => refusedConnectionParameters.includes(key))) {
    throw new ManagedPostgresClientError("postgres-url-invalid");
  }
  return url;
}

function withPlaintextMode(url: URL, connectionString: string, sslMode: string | null): string {
  if (url.searchParams.has("sslrootcert") || url.searchParams.has("uselibpqcompat")) {
    throw new ManagedPostgresClientError("postgres-url-invalid");
  }
  if (sslMode === "disable") {
    return connectionString;
  }
  // An explicit mode keeps ambient PGSSLMODE from changing a loopback client.
  url.searchParams.set("sslmode", "disable");
  return url.toString();
}

function errorCode(error: unknown): string | undefined {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return typeof code === "string" ? code : undefined;
}
