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
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  fetchDigitalOceanManagedPostgresCa,
  managedPostgresConnectionUrl,
  writeManagedPostgresCa,
} from "./terraform-state-database-urls.mjs";
import { postgresClientConfig, postgresFailureFields } from "./lib/postgres-connection.mjs";

const { Client } = pg;

export const GRANT_KINDS = Object.freeze(["owner", "wake-listener"]);
export const WAKE_LISTENER_EVENT_STORE_TABLES = Object.freeze(["event_store_events", "event_store_streams"]);

function requireEnv(name, env = process.env) {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

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

async function applyGrant(grant, connectionUrl, dependencies = {}) {
  const config = grantClientConfig(connectionUrl, grant.database, dependencies.readFileSync);
  const client = (dependencies.createClient ?? ((clientConfig) => new Client(clientConfig)))(config);
  let operationError;
  try {
    try {
      await client.connect();
    } catch (error) {
      throw boundedPostgresError(error, "postgres-connect-failed");
    }

    try {
      const statements = (dependencies.statementsForGrant ?? statementsForGrant)(grant);
      for (const statement of statements) {
        await client.query(statement);
      }
    } catch (error) {
      throw boundedPostgresError(error, "postgres-grant-query-failed");
    }
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      await client.end();
    } catch (error) {
      if (!operationError) {
        throw boundedPostgresError(error, "postgres-client-close-failed");
      }
    }
  }
}

function grantClientConfig(connectionString, database, readFileSync) {
  const url = assertVerifiedGrantConnection(connectionString, database);
  // Keep the verify-full URL as the canonical CA authority, but do not hand it
  // to pg.Client: pg reparses SSL-bearing connection strings after explicit
  // options and can replace this verified object with environment-controlled
  // TLS defaults.
  const { ssl } = postgresClientConfig(connectionString, Object.create(null), readFileSync);
  return {
    host: url.hostname,
    port: Number(url.port || "5432"),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { ...ssl, rejectUnauthorized: true },
  };
}

export function readManagedPostgresGrantOptions(env = process.env) {
  return {
    grants: readGrants(env),
    clusterId: requireClassifiedEnv("DATABASE_CLUSTER_ID", "managed-postgres-cluster-id-missing", env),
    digitalOceanToken: env.DIGITALOCEAN_ACCESS_TOKEN,
    host: requireClassifiedEnv("PGHOST", "managed-postgres-connection-input-missing", env),
    port: env.PGPORT ?? "5432",
    user: requireClassifiedEnv("PGUSER", "managed-postgres-connection-input-missing", env),
    password: requireClassifiedEnv("PGPASSWORD", "managed-postgres-connection-input-missing", env),
  };
}

export async function applyDigitalOceanDatabaseGrants(options, dependencies = {}) {
  const createTemporaryDirectory = dependencies.mkdtemp ?? mkdtemp;
  const setMode = dependencies.chmod ?? chmod;
  const writeCa = dependencies.writeCa ?? writeManagedPostgresCa;
  const remove = dependencies.rm ?? rm;
  const temporaryDirectoryParent = dependencies.temporaryDirectoryParent ?? tmpdir();
  let caDirectory;

  try {
    caDirectory = await createTemporaryDirectory(join(temporaryDirectoryParent, "chase-sets-managed-postgres-grant-"));
    await setMode(caDirectory, 0o700);
    const caPath = join(caDirectory, "ca.pem");
    const certificate = await fetchDigitalOceanManagedPostgresCa(
      {
        clusterId: options.clusterId,
        digitalOceanToken: options.digitalOceanToken,
      },
      dependencies,
    );
    try {
      await writeCa(caPath, certificate);
    } catch (error) {
      throw classifiedError("managed-postgres-ca-write-failed", error);
    }

    for (const grant of options.grants) {
      const connectionUrl = (dependencies.connectionUrlForGrant ?? connectionUrlForGrant)(options, grant, caPath);
      await applyGrant(grant, connectionUrl, dependencies);
    }

    return { grantCount: options.grants.length };
  } finally {
    if (caDirectory) {
      try {
        await remove(caDirectory, { recursive: true, force: true });
      } catch (error) {
        throw classifiedError("managed-postgres-ca-cleanup-failed", error);
      }
    }
  }
}

export function connectionUrlForGrant(options, grant, caPath) {
  const url = new URL("postgresql://localhost");
  url.hostname = options.host;
  url.port = String(options.port);
  url.username = options.user;
  url.password = options.password;
  url.pathname = `/${grant.database}`;
  return managedPostgresConnectionUrl(url.toString(), caPath);
}

function assertVerifiedGrantConnection(connectionString, database) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw classifiedError("managed-postgres-connection-url-invalid");
  }
  if (
    url.protocol !== "postgresql:" ||
    decodeURIComponent(url.pathname.slice(1)) !== database ||
    url.searchParams.get("sslmode") !== "verify-full" ||
    !url.searchParams.get("sslrootcert") ||
    url.searchParams.get("uselibpqcompat") !== "true"
  ) {
    throw classifiedError("managed-postgres-connection-url-invalid");
  }
  return url;
}

export function readGrants(env = process.env) {
  if (env.DATABASE_GRANTS_JSON) {
    const grants = JSON.parse(env.DATABASE_GRANTS_JSON);
    if (!Array.isArray(grants) || grants.length === 0) {
      throw new Error("DATABASE_GRANTS_JSON must be a non-empty array.");
    }

    return grants.map((grant, index) => {
      if (
        typeof grant?.database !== "string" ||
        grant.database.length === 0 ||
        typeof grant?.user !== "string" ||
        grant.user.length === 0
      ) {
        throw new Error(`DATABASE_GRANTS_JSON[${index}] must include database and user strings.`);
      }

      const kind = grant.kind ?? "owner";
      if (!GRANT_KINDS.includes(kind)) {
        throw new Error(`DATABASE_GRANTS_JSON[${index}].kind must be one of: ${GRANT_KINDS.join(", ")}.`);
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

export async function main(env = process.env, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const logError = dependencies.error ?? console.error;
  try {
    const result = await applyDigitalOceanDatabaseGrants(readManagedPostgresGrantOptions(env), dependencies);
    log(JSON.stringify({ status: "database-grants-applied", grantCount: result.grantCount }));
    return 0;
  } catch (error) {
    logError(JSON.stringify(postgresFailureFields(error)));
    return 1;
  }
}

function requireClassifiedEnv(name, classification, env) {
  try {
    return requireEnv(name, env);
  } catch (error) {
    throw classifiedError(classification, error);
  }
}

function boundedPostgresError(error, fallbackClassification) {
  const fields = postgresFailureFields(error);
  const classification =
    fields.classification === "postgres-query-failed" ? fallbackClassification : fields.classification;
  return classifiedError(classification, error, fields);
}

function classifiedError(classification, error, fields = {}) {
  return Object.assign(new Error(classification), fields, {
    classification,
    ...(typeof error?.code === "string" ? { code: error.code } : {}),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main();
}
