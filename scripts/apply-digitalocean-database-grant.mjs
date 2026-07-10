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
import pg from "pg";

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

async function applyGrant(grant, env = process.env) {
  const client = new Client({
    host: requireEnv("PGHOST", env),
    port: Number(env.PGPORT ?? "5432"),
    database: grant.database,
    user: requireEnv("PGUSER", env),
    password: requireEnv("PGPASSWORD", env),
    ssl: env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined,
  });

  await client.connect();

  try {
    for (const statement of statementsForGrant(grant)) {
      await client.query(statement);
    }
  } finally {
    await client.end();
  }
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const grant of readGrants()) {
    await applyGrant(grant);
  }
}
