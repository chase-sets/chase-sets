import { Pool } from "pg";
import type { PlatformApiBootstrapConfig } from "./config";

const PREVIEW_POSTGRES_READY_TIMEOUT_MS = 120_000;
const PREVIEW_POSTGRES_READY_RETRY_DELAY_MS = 2_000;

// Preview in-cluster Postgres extensions per context database. The pgvector
// packaging in pgvector/pgvector:pg16 is not marked trusted, so the
// non-superuser preview context role cannot CREATE EXTENSION itself. The
// admin provisioning phase installs required extensions with the superuser
// connection, which turns the schema's own CREATE EXTENSION IF NOT EXISTS
// into a no-op. Keep in sync with testDatabaseExtensions in
// infrastructure/bounded-context-runtime/test-support.ts and
// requiredExtensions in scripts/dev-system.mjs; neither registry is
// importable here without pulling test support or script tooling into the
// deployable.
const previewDatabaseExtensionsByContext: Readonly<Record<string, readonly string[]>> = {
  discovery: ["vector"],
};

export type PreviewPostgresPool = Readonly<{
  query: (queryText: string, values?: readonly unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
}>;

export type EnsurePreviewPostgresDatabasesOptions = Readonly<{
  createPool?: (connectionString: string) => PreviewPostgresPool;
  readyTimeoutMs?: number;
  readyRetryDelayMs?: number;
}>;

export async function ensurePreviewPostgresDatabases(
  config: PlatformApiBootstrapConfig,
  options: EnsurePreviewPostgresDatabasesOptions = {},
): Promise<void> {
  const adminUrl = config.previewPostgresAdminUrl;
  if (!adminUrl) {
    return;
  }

  const createPool = options.createPool ?? createDefaultPool;
  const specs = previewDatabaseSpecs(config);
  const adminPool = createPool(adminUrl);
  try {
    await waitForPreviewPostgres(adminPool, options);
    for (const spec of specs) {
      await ensurePreviewDatabase(adminPool, spec);
    }
  } finally {
    await adminPool.end();
  }

  await ensurePreviewDatabaseExtensions(createPool, adminUrl, specs);
}

function createDefaultPool(connectionString: string): PreviewPostgresPool {
  return new Pool({ connectionString, max: 1 }) as unknown as PreviewPostgresPool;
}

async function waitForPreviewPostgres(
  adminPool: PreviewPostgresPool,
  options: EnsurePreviewPostgresDatabasesOptions,
): Promise<void> {
  const timeoutMs = options.readyTimeoutMs ?? PREVIEW_POSTGRES_READY_TIMEOUT_MS;
  const retryDelayMs = options.readyRetryDelayMs ?? PREVIEW_POSTGRES_READY_RETRY_DELAY_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() <= deadline) {
    try {
      await adminPool.query("select 1");
      return;
    } catch (error) {
      lastError = error;
      await sleep(retryDelayMs);
    }
  }

  throw new Error(`Preview Postgres did not become ready before bootstrap timeout: ${String(lastError)}`);
}

async function ensurePreviewDatabase(adminPool: PreviewPostgresPool, spec: PreviewDatabaseSpec): Promise<void> {
  const roleExists = await adminPool.query("select exists(select 1 from pg_roles where rolname = $1)", [spec.username]);
  if (roleExists.rows[0]?.exists) {
    await adminPool.query(
      `alter role ${quoteIdentifier(spec.username)} with login password ${quoteLiteral(spec.password)}`,
    );
  } else {
    await adminPool.query(
      `create role ${quoteIdentifier(spec.username)} with login password ${quoteLiteral(spec.password)}`,
    );
  }

  const databaseExists = await adminPool.query("select exists(select 1 from pg_database where datname = $1)", [
    spec.database,
  ]);
  if (!databaseExists.rows[0]?.exists) {
    await adminPool.query(`create database ${quoteIdentifier(spec.database)} owner ${quoteIdentifier(spec.username)}`);
  } else {
    await adminPool.query(
      `alter database ${quoteIdentifier(spec.database)} owner to ${quoteIdentifier(spec.username)}`,
    );
  }

  await adminPool.query(
    `grant all privileges on database ${quoteIdentifier(spec.database)} to ${quoteIdentifier(spec.username)}`,
  );
}

async function ensurePreviewDatabaseExtensions(
  createPool: (connectionString: string) => PreviewPostgresPool,
  adminUrl: string,
  specs: readonly PreviewDatabaseSpec[],
): Promise<void> {
  for (const spec of specs) {
    if (spec.extensions.length === 0) {
      continue;
    }

    // CREATE EXTENSION is per-database, so connect the superuser to the
    // target database while keeping the admin URL's connection options
    // (notably sslmode=disable) intact.
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${encodeURIComponent(spec.database)}`;
    const databasePool = createPool(databaseUrl.toString());
    try {
      for (const extensionName of spec.extensions) {
        await databasePool.query(`create extension if not exists ${quoteIdentifier(extensionName)}`);
      }
    } finally {
      await databasePool.end();
    }
  }
}

function previewDatabaseSpecs(config: PlatformApiBootstrapConfig): readonly PreviewDatabaseSpec[] {
  const sources: ReadonlyArray<readonly [contextName: string, url: string | null | undefined]> = [
    ["control", config.controlDatabaseUrl],
    ["control", config.workSignalDatabaseUrl],
    ...Object.entries(config.contextDatabaseUrls),
    ...Object.entries(config.contextWaiterDatabaseUrls ?? {}),
  ];
  const specs = new Map<string, MutablePreviewDatabaseSpec>();

  for (const [contextName, url] of sources) {
    if (!url) {
      continue;
    }

    const parsed = parsePreviewDatabaseUrl(url);
    const key = `${parsed.database}:${parsed.username}`;
    const spec = specs.get(key) ?? { ...parsed, extensions: new Set<string>() };
    for (const extensionName of previewDatabaseExtensionsByContext[contextName] ?? []) {
      spec.extensions.add(extensionName);
    }
    specs.set(key, spec);
  }

  return [...specs.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([, spec]) => ({
      ...spec,
      extensions: [...spec.extensions].sort((left, right) => left.localeCompare(right, "en")),
    }));
}

type PreviewDatabaseSpec = Readonly<{
  database: string;
  username: string;
  password: string;
  extensions: readonly string[];
}>;

type MutablePreviewDatabaseSpec = {
  database: string;
  username: string;
  password: string;
  extensions: Set<string>;
};

function parsePreviewDatabaseUrl(rawUrl: string): Omit<PreviewDatabaseSpec, "extensions"> {
  const url = new URL(rawUrl);
  const database = decodeURIComponent(url.pathname.replace(/^\//u, ""));
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);

  if (!database || !username || !password) {
    throw new Error("Preview Postgres database URLs must include database, username, and password.");
  }

  return { database, username, password };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
