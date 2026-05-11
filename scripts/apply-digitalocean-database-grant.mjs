import pg from "pg";

const { Client } = pg;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

async function applyGrant({ database, user }) {
  const client = new Client({
    host: requireEnv("PGHOST"),
    port: Number(process.env.PGPORT ?? "5432"),
    database,
    user: requireEnv("PGUSER"),
    password: requireEnv("PGPASSWORD"),
    ssl:
      process.env.PGSSLMODE === "require"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  await client.connect();

  const databaseIdentifier = quoteIdentifier(database);
  const userIdentifier = quoteIdentifier(user);

  try {
    await client.query(
      `GRANT CONNECT, CREATE, TEMPORARY ON DATABASE ${databaseIdentifier} TO ${userIdentifier}`,
    );
    await client.query(
      `GRANT USAGE, CREATE ON SCHEMA public TO ${userIdentifier}`,
    );
  } finally {
    await client.end();
  }
}

function readGrants() {
  if (process.env.DATABASE_GRANTS_JSON) {
    const grants = JSON.parse(process.env.DATABASE_GRANTS_JSON);
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
        throw new Error(
          `DATABASE_GRANTS_JSON[${index}] must include database and user strings.`,
        );
      }

      return { database: grant.database, user: grant.user };
    });
  }

  return [
    {
      database: requireEnv("DATABASE_GRANT_NAME"),
      user: requireEnv("DATABASE_GRANT_USER"),
    },
  ];
}

for (const grant of readGrants()) {
  await applyGrant(grant);
}
