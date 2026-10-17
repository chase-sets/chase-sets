// @ts-check
// Applies DigitalOcean managed Postgres grants from Terraform local-exec
// provisioners (infrastructure/digitalocean/platform). Two grant kinds:
//
//   owner          (default) Owning context users: full database/schema usage
//                  so bootstrap can create and migrate that context's tables.
//   wake-listener  Dedicated relay listener users: CONNECT (LISTEN
//                  needs no further privilege), USAGE on the schema, and
//                  read-only SELECT on the event-store tables only — guarded
//                  by to_regclass so a freshly created database whose
//                  bootstrap has not run yet does not fail the apply. The
//                  grants resource re-runs on database/user changes, and the
//                  relay's listener connection never reads tables today
//                  (catch-up uses pooled query URLs), so a skipped SELECT
//                  grant never degrades the relay.
import { fileURLToPath } from "node:url";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkServerIdentity } from "node:tls";
import pg from "pg";
import { resolvePostgresSsl, postgresFailureFields, safeFailureFields } from "./lib/postgres-connection.mjs";
import {
  fetchDigitalOceanManagedPostgresCa,
  managedPostgresConnectionUrl,
  writeManagedPostgresCa,
} from "./terraform-state-database-urls.mjs";

const { Client } = pg;
const MANAGED_POSTGRES_GRANT_TEMP_PREFIX = "chase-sets-managed-postgres-grant-";
const MANAGED_POSTGRES_CA_FILE = "ca.crt";

/** @type {readonly import("./apply-digitalocean-database-grant.mjs").DatabaseGrant["kind"][]} */
export const GRANT_KINDS = Object.freeze(["owner", "wake-listener"]);
export const WAKE_LISTENER_EVENT_STORE_TABLES = Object.freeze(["event_store_events", "event_store_streams"]);

/** @param {string} name @param {NodeJS.ProcessEnv} [env] */
function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value) {
    throw grantError("managed-postgres-grant-input-invalid", `${name} is required`);
  }
  return value;
}

/** @param {string} classification @param {string} message @param {{code?: unknown}} [fields] */
function grantError(classification, message, fields = {}) {
  return Object.assign(new Error(message), { classification, ...fields });
}

/** @param {unknown} error */
function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

/** @type {typeof import("./apply-digitalocean-database-grant.mjs").quoteIdentifier} */
export function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

/** @type {typeof import("./apply-digitalocean-database-grant.mjs").statementsForGrant} */
export function statementsForGrant({ database, user, kind }) {
  const databaseIdentifier = quoteIdentifier(database);
  const userIdentifier = quoteIdentifier(user);

  if (kind === "wake-listener") {
    return [
      `GRANT CONNECT ON DATABASE ${databaseIdentifier} TO ${userIdentifier}`,
      `GRANT USAGE ON SCHEMA public TO ${userIdentifier}`,
      ...WAKE_LISTENER_EVENT_STORE_TABLES.map((tableName) => {
        const grantSelect = `GRANT SELECT ON TABLE public.${quoteIdentifier(tableName)} TO ${userIdentifier}`;
        // CONNECT is the only privilege the listener connection needs (it
        // issues LISTEN/UNLISTEN exclusively; catch-up reads ride the pooled
        // query URLs). The SELECT grant is best-effort defense-in-depth: the
        // cluster admin may not hold grant authority on tables owned by the
        // per-context users, and that must never fail the apply.
        return (
          `DO $$ BEGIN IF to_regclass('public.${tableName}') IS NOT NULL THEN BEGIN ` +
          `EXECUTE '${grantSelect.replaceAll("'", "''")}'; ` +
          `EXCEPTION WHEN insufficient_privilege THEN ` +
          `RAISE WARNING 'skipped best-effort wake-listener SELECT grant on public.${tableName} (insufficient privilege)'; ` +
          `END; END IF; END $$`
        );
      }),
    ];
  }

  return [
    `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${databaseIdentifier} TO ${userIdentifier}`,
    `GRANT USAGE, CREATE ON SCHEMA public TO ${userIdentifier}`,
  ];
}

/** @param {unknown} error @param {string} fallbackClassification */
function classifiedPostgresError(error, fallbackClassification) {
  const fields = postgresFailureFields(error);
  const classification =
    fields.classification === "postgres-query-failed"
      ? fallbackClassification
      : fields.classification === "self-signed-certificate-in-certificate-chain"
        ? "certificate-authority-untrusted"
        : fields.classification;
  return grantError(classification, "Managed Postgres grant operation failed.", {
    ...(errorCode(fields) ? { code: errorCode(fields) } : {}),
  });
}

/** @param {NodeJS.ProcessEnv} env */
function postgresPort(env) {
  const port = Number(env.PGPORT ?? "5432");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw grantError("managed-postgres-grant-input-invalid", "PGPORT must be a valid TCP port.");
  }
  return port;
}

/** @param {import("./apply-digitalocean-database-grant.mjs").DatabaseGrant} grant @param {NodeJS.ProcessEnv} env */
function connectionAuthority(grant, env) {
  return {
    host: requireEnv("PGHOST", env),
    port: postgresPort(env),
    database: grant.database,
    user: requireEnv("PGUSER", env),
    password: requireEnv("PGPASSWORD", env),
  };
}

/** @param {import("./apply-digitalocean-database-grant.mjs").GrantAuthority} authority */
function authorityConnectionUrl(authority) {
  const host = authority.host.includes(":") ? `[${authority.host}]` : authority.host;
  return (
    `postgresql://${encodeURIComponent(authority.user)}:${encodeURIComponent(authority.password)}` +
    `@${host}:${authority.port}/${encodeURIComponent(authority.database)}`
  );
}

/** @type {typeof import("./apply-digitalocean-database-grant.mjs").assertManagedPostgresGrantUrl} */
export function assertManagedPostgresGrantUrl(connectionString, authority, caPath) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw grantError("managed-postgres-grant-url-invalid", "Managed Postgres grant URL was invalid.");
  }

  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw grantError("managed-postgres-grant-url-invalid", "Managed Postgres grant database was invalid.");
  }

  let user;
  let password;
  try {
    user = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw grantError("managed-postgres-grant-url-invalid", "Managed Postgres grant credentials were invalid.");
  }
  const exactAuthority =
    url.protocol === "postgresql:" &&
    url.hostname === authority.host.toLowerCase() &&
    Number(url.port) === authority.port &&
    user === authority.user &&
    password === authority.password &&
    database === authority.database;
  if (!exactAuthority) {
    throw grantError(
      "managed-postgres-grant-authority-mismatch",
      "Managed Postgres grant URL did not match the graph-owned authority.",
    );
  }

  const expectedTrustParameters = new Map([
    ["sslmode", "verify-full"],
    ["sslrootcert", caPath],
    ["uselibpqcompat", "true"],
  ]);
  const expectedParameterNames = [...expectedTrustParameters.keys()].sort();
  const actualParameterNames = [...url.searchParams.keys()].sort();
  if (
    actualParameterNames.length !== expectedTrustParameters.size ||
    actualParameterNames.some((name, index) => name !== expectedParameterNames[index])
  ) {
    throw grantError("managed-postgres-grant-trust-invalid", "Managed Postgres grant trust inputs were invalid.");
  }
  for (const [name, expectedValue] of expectedTrustParameters) {
    if (url.searchParams.getAll(name).length !== 1 || url.searchParams.get(name) !== expectedValue) {
      throw grantError("managed-postgres-grant-trust-invalid", "Managed Postgres grant trust inputs were invalid.");
    }
  }

  return url;
}

/** @type {typeof import("./apply-digitalocean-database-grant.mjs").managedPostgresGrantUrl} */
export function managedPostgresGrantUrl(grant, env, caPath) {
  const authority = connectionAuthority(grant, env);
  const connectionString = managedPostgresConnectionUrl(authorityConnectionUrl(authority), caPath);
  assertManagedPostgresGrantUrl(connectionString, authority, caPath);
  return connectionString;
}

/**
 * @param {import("./apply-digitalocean-database-grant.mjs").DatabaseGrant} grant
 * @param {NodeJS.ProcessEnv} env
 * @param {string} caPath
 * @param {import("./apply-digitalocean-database-grant.mjs").DatabaseGrantDependencies} [dependencies]
 */
async function applyGrant(grant, env, caPath, dependencies = {}) {
  const authority = connectionAuthority(grant, env);
  const buildUrl = dependencies.managedPostgresGrantUrl ?? managedPostgresGrantUrl;
  const connectionString = buildUrl(grant, env, caPath);
  const url = assertManagedPostgresGrantUrl(connectionString, authority, caPath);
  /** @type {import("pg").ClientConfig} */
  let config;
  try {
    // Keep the canonical verify-full URL as the validated authority, but pass
    // explicit fields so pg cannot reparse it and replace our TLS policy.
    // pg omits SNI for IP sockets; Node may otherwise check "localhost".
    config = {
      host: url.hostname,
      port: Number(url.port),
      database: decodeURIComponent(url.pathname.slice(1)),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      ssl: {
        ...resolvePostgresSsl(connectionString, {}, dependencies.readFileSync),
        rejectUnauthorized: true,
        checkServerIdentity: (_hostname, certificate) => checkServerIdentity(url.hostname, certificate),
      },
    };
  } catch (error) {
    throw classifiedPostgresError(error, "postgres-connect-failed");
  }
  const GrantClient = dependencies.Client ?? Client;
  const buildStatements = dependencies.statementsForGrant ?? statementsForGrant;
  const client = new GrantClient(config);
  let operationError;
  try {
    try {
      await client.connect();
    } catch (error) {
      throw classifiedPostgresError(error, "postgres-connect-failed");
    }
    for (const statement of buildStatements(grant)) {
      try {
        await client.query(statement);
      } catch (error) {
        throw classifiedPostgresError(error, "postgres-grant-query-failed");
      }
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await client.end();
    } catch (error) {
      if (!operationError) {
        throw classifiedPostgresError(error, "postgres-disconnect-failed");
      }
    }
  }
}

/** @type {typeof import("./apply-digitalocean-database-grant.mjs").applyDatabaseGrants} */
export async function applyDatabaseGrants(env = process.env, dependencies = {}) {
  const grants = readGrants(env);
  const clusterId = requireEnv("DIGITALOCEAN_DATABASE_CLUSTER_ID", env);
  const digitalOceanToken = env.DIGITALOCEAN_ACCESS_TOKEN;
  const fetchCa = dependencies.fetchDigitalOceanManagedPostgresCa ?? fetchDigitalOceanManagedPostgresCa;
  const certificate = await fetchCa(
    { clusterId, digitalOceanToken },
    dependencies.fetch ? { fetch: dependencies.fetch } : {},
  );
  const createTemporaryDirectory = dependencies.mkdtemp ?? mkdtemp;
  const setMode = dependencies.chmod ?? chmod;
  const writeCa = dependencies.writeManagedPostgresCa ?? writeManagedPostgresCa;
  const remove = dependencies.rm ?? rm;
  const temporaryRoot = dependencies.tmpdir?.() ?? tmpdir();
  let ownedPath;
  let operationError;

  try {
    try {
      ownedPath = await createTemporaryDirectory(join(temporaryRoot, MANAGED_POSTGRES_GRANT_TEMP_PREFIX));
      await setMode(ownedPath, 0o700);
    } catch (error) {
      throw grantError(
        "managed-postgres-grant-ca-directory-failed",
        "Managed Postgres grant CA directory creation failed.",
        { code: errorCode(error) },
      );
    }
    const caPath = join(ownedPath, MANAGED_POSTGRES_CA_FILE);
    try {
      await writeCa(caPath, certificate);
    } catch (error) {
      throw grantError("managed-postgres-grant-ca-write-failed", "Managed Postgres grant CA write failed.", {
        code: errorCode(error),
      });
    }
    for (const grant of grants) {
      await applyGrant(grant, env, caPath, dependencies);
    }
    return { grantCount: grants.length };
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    if (ownedPath) {
      try {
        await remove(ownedPath, { recursive: true, force: true });
      } catch (error) {
        if (!operationError) {
          throw grantError("managed-postgres-grant-cleanup-failed", "Managed Postgres grant cleanup failed.", {
            code: errorCode(error),
          });
        }
      }
    }
  }
}

/** @type {typeof import("./apply-digitalocean-database-grant.mjs").runDatabaseGrantMain} */
export async function runDatabaseGrantMain(env = process.env, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const logError = dependencies.error ?? console.error;
  try {
    const result = await applyDatabaseGrants(env, dependencies);
    log(JSON.stringify({ classification: "managed-postgres-grants-applied", grantCount: result.grantCount }));
    return 0;
  } catch (error) {
    const classification =
      error && typeof error === "object" && "classification" in error
        ? error.classification
        : "managed-postgres-grant-failed";
    logError(JSON.stringify(safeFailureFields(classification, error)));
    return 1;
  }
}

/** @type {typeof import("./apply-digitalocean-database-grant.mjs").readGrants} */
export function readGrants(env = process.env) {
  if (env.DATABASE_GRANTS_JSON) {
    let grants;
    try {
      grants = JSON.parse(env.DATABASE_GRANTS_JSON);
    } catch {
      throw grantError("managed-postgres-grant-input-invalid", "DATABASE_GRANTS_JSON must be valid JSON.");
    }
    if (!Array.isArray(grants) || grants.length === 0) {
      throw grantError("managed-postgres-grant-input-invalid", "DATABASE_GRANTS_JSON must be a non-empty array.");
    }

    return grants.map((grant, index) => {
      if (
        typeof grant?.database !== "string" ||
        grant.database.length === 0 ||
        typeof grant?.user !== "string" ||
        grant.user.length === 0
      ) {
        throw grantError(
          "managed-postgres-grant-input-invalid",
          `DATABASE_GRANTS_JSON[${index}] must include database and user strings.`,
        );
      }

      const kind = grant.kind ?? "owner";
      if (!GRANT_KINDS.includes(kind)) {
        throw grantError(
          "managed-postgres-grant-input-invalid",
          `DATABASE_GRANTS_JSON[${index}].kind must be one of: ${GRANT_KINDS.join(", ")}.`,
        );
      }

      return { database: grant.database, user: grant.user, kind };
    });
  }

  return [
    {
      database: requireEnv("DATABASE_GRANT_NAME", env),
      user: requireEnv("DATABASE_GRANT_USER", env),
      kind: "owner",
    },
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await runDatabaseGrantMain();
}
