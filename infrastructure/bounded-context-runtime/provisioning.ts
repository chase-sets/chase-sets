type PgAdminQueryResult<Row> = Readonly<{
  rows: Row[];
}>;

type PgAdminPool = Readonly<{
  query: <Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]) => Promise<PgAdminQueryResult<Row>>;
}>;

export type OwnedPostgresDatabase = Readonly<{
  roleName: string;
  password: string;
  databaseName: string;
  databaseUrl: string;
}>;

function escapeIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function escapeLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createOwnedDatabaseUrl(
  baseAdminDatabaseUrl: string,
  roleName: string,
  databaseName = roleName,
  password = roleName,
): string {
  const url = new URL(baseAdminDatabaseUrl);
  url.username = roleName;
  url.password = password;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function parseOwnedDatabaseUrl(databaseUrl: string): OwnedPostgresDatabase {
  const url = new URL(databaseUrl);
  const roleName = url.username;
  const password = url.password;
  const databaseName = url.pathname.replace(/^\//, "");

  if (!roleName) {
    throw new Error(`Owned database URL "${databaseUrl}" must include a role name.`);
  }

  if (!password) {
    throw new Error(`Owned database URL "${databaseUrl}" must include a password.`);
  }

  if (!databaseName) {
    throw new Error(`Owned database URL "${databaseUrl}" must include a database name.`);
  }

  return {
    roleName,
    password,
    databaseName,
    databaseUrl,
  };
}

async function ensureOwnedPostgresDatabase(adminPool: PgAdminPool, spec: OwnedPostgresDatabase): Promise<void> {
  const roleExists = await adminPool.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists",
    [spec.roleName],
  );

  if (roleExists.rows[0]?.exists) {
    await adminPool.query(
      `ALTER ROLE ${escapeIdentifier(spec.roleName)} WITH LOGIN PASSWORD ${escapeLiteral(spec.password)}`,
    );
  } else {
    await adminPool.query(
      `CREATE ROLE ${escapeIdentifier(spec.roleName)} WITH LOGIN PASSWORD ${escapeLiteral(spec.password)}`,
    );
  }

  const databaseExists = await adminPool.query<{ exists: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = $1) AS exists",
    [spec.databaseName],
  );

  if (databaseExists.rows[0]?.exists) {
    await adminPool.query(
      `ALTER DATABASE ${escapeIdentifier(spec.databaseName)} OWNER TO ${escapeIdentifier(spec.roleName)}`,
    );
  } else {
    await adminPool.query(
      `CREATE DATABASE ${escapeIdentifier(spec.databaseName)} OWNER ${escapeIdentifier(spec.roleName)}`,
    );
  }

  await adminPool.query(
    `GRANT ALL PRIVILEGES ON DATABASE ${escapeIdentifier(spec.databaseName)} TO ${escapeIdentifier(spec.roleName)}`,
  );
}

export async function ensureOwnedPostgresDatabases(
  adminPool: PgAdminPool,
  databaseUrls: readonly string[] | Readonly<Record<string, string>>,
): Promise<void> {
  const urls = Array.isArray(databaseUrls) ? databaseUrls : Object.values(databaseUrls);
  const uniqueSpecs = new Map(
    urls
      .map((databaseUrl) => parseOwnedDatabaseUrl(databaseUrl))
      .map((spec) => [`${spec.roleName}:${spec.databaseName}`, spec] as const),
  );

  for (const spec of uniqueSpecs.values()) {
    await ensureOwnedPostgresDatabase(adminPool, spec);
  }
}
