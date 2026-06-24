import { randomBytes } from "node:crypto";
import {
  isCompactPostWriteToken,
  isPostWriteTokenPayload,
  type PostWriteTokenPayload,
  type PostWriteTokenStore,
  type StorePostWriteTokenOptions,
} from "@chase-sets/http/responses";
import { createPgPool, type PgPoolOptions, type PgQueryable } from "@chase-sets/event-core-postgres";

export const PLATFORM_CONTROL_DATABASE_URL_ENV = "PLATFORM_CONTROL_DATABASE_URL";

const DEFAULT_POOL_OPTIONS = {
  max: 3,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
} as const satisfies PgPoolOptions;

export const platformPostWriteTokenStoreSchemaSql = `
CREATE TABLE IF NOT EXISTS platform_post_write_tokens (
  token text PRIMARY KEY,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS platform_post_write_tokens_expires_at_idx
  ON platform_post_write_tokens (expires_at);
`;

type PostWriteTokenRow = Readonly<{
  payload: unknown;
}>;

export type PostgresPostWriteTokenStoreOptions = Readonly<{
  autoBootstrap?: boolean;
  tokenFactory?: () => string;
}>;

let defaultStore: Readonly<{
  databaseUrl: string;
  poolOptions: PgPoolOptions;
  store: PostWriteTokenStore;
}> | null = null;

export async function bootstrapPostWriteTokenStore(db: PgQueryable): Promise<void> {
  await db.query(platformPostWriteTokenStoreSchemaSql);
}

export function createPostgresPostWriteTokenStore(
  db: PgQueryable,
  options: PostgresPostWriteTokenStoreOptions = {},
): PostWriteTokenStore {
  let bootstrapPromise: Promise<void> | null = null;
  const ensureBootstrapped = () => {
    if (!options.autoBootstrap) {
      return Promise.resolve();
    }

    bootstrapPromise ??= bootstrapPostWriteTokenStore(db);
    return bootstrapPromise;
  };
  const tokenFactory = options.tokenFactory ?? createPostWriteToken;

  return {
    async storePostWriteToken(payload: PostWriteTokenPayload, storeOptions: StorePostWriteTokenOptions) {
      if (!isPostWriteTokenPayload(payload)) {
        throw new TypeError(
          "Post-write token payloads must contain only fresh-write receipt and safe handoff metadata.",
        );
      }

      await ensureBootstrapped();
      await pruneExpiredPostWriteTokens(db);

      const createdAt = new Date(storeOptions.nowMs).toISOString();
      const expiresAt = new Date(storeOptions.nowMs + storeOptions.ttlMs).toISOString();
      const serializedPayload = JSON.stringify(payload);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const token = tokenFactory();
        if (!isCompactPostWriteToken(token)) {
          throw new TypeError("Post-write token factories must return compact URL-safe token identifiers.");
        }

        const result = await db.query(
          `INSERT INTO platform_post_write_tokens (
             token,
             payload,
             created_at,
             expires_at
           ) VALUES ($1, $2::jsonb, $3::timestamptz, $4::timestamptz)
           ON CONFLICT (token) DO NOTHING`,
          [token, serializedPayload, createdAt, expiresAt],
        );

        if ((result.rowCount ?? 0) > 0) {
          return token;
        }
      }

      throw new Error("Unable to reserve a compact post-write token.");
    },

    async resolvePostWriteToken(token: string) {
      if (!isCompactPostWriteToken(token)) {
        return null;
      }

      await ensureBootstrapped();
      const result = await db.query<PostWriteTokenRow>(
        `SELECT payload
         FROM platform_post_write_tokens
         WHERE token = $1
           AND expires_at > now()`,
        [token],
      );

      const payload = readPostWriteTokenPayload(result.rows[0]?.payload);
      return payload;
    },
  };
}

export async function pruneExpiredPostWriteTokens(db: PgQueryable): Promise<number> {
  const result = await db.query(
    `DELETE FROM platform_post_write_tokens
     WHERE expires_at <= now()`,
  );
  return result.rowCount ?? 0;
}

export function getDefaultPostWriteTokenStore(
  env: Readonly<Record<string, string | undefined>> = readProcessEnv(),
): PostWriteTokenStore {
  const databaseUrl = env[PLATFORM_CONTROL_DATABASE_URL_ENV]?.trim();
  if (!databaseUrl) {
    throw new Error(`${PLATFORM_CONTROL_DATABASE_URL_ENV} is required for compact post-write tokens.`);
  }

  const poolOptions = readPoolOptions(env);
  if (
    defaultStore &&
    defaultStore.databaseUrl === databaseUrl &&
    samePoolOptions(defaultStore.poolOptions, poolOptions)
  ) {
    return defaultStore.store;
  }

  const pool = createPgPool(databaseUrl, poolOptions);
  const store = createPostgresPostWriteTokenStore(pool, { autoBootstrap: true });
  defaultStore = { databaseUrl, poolOptions, store };
  return store;
}

export function resetDefaultPostWriteTokenStoreForTests() {
  defaultStore = null;
}

function readPostWriteTokenPayload(value: unknown): PostWriteTokenPayload | null {
  if (isPostWriteTokenPayload(value)) {
    return value;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return isPostWriteTokenPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function createPostWriteToken(): string {
  return `pwt_${randomBytes(18).toString("base64").replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function readPoolOptions(env: Readonly<Record<string, string | undefined>>): PgPoolOptions {
  return {
    max: readPositiveIntegerEnv(env, "DATABASE_POOL_MAX", DEFAULT_POOL_OPTIONS.max),
    idleTimeoutMillis: readPositiveIntegerEnv(
      env,
      "DATABASE_POOL_IDLE_TIMEOUT_MS",
      DEFAULT_POOL_OPTIONS.idleTimeoutMillis,
    ),
    connectionTimeoutMillis: readPositiveIntegerEnv(
      env,
      "DATABASE_POOL_CONNECTION_TIMEOUT_MS",
      DEFAULT_POOL_OPTIONS.connectionTimeoutMillis,
    ),
  };
}

function readPositiveIntegerEnv(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  defaultValue: number,
): number {
  const value = env[name]?.trim();
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : defaultValue;
}

function samePoolOptions(left: PgPoolOptions, right: PgPoolOptions): boolean {
  return (
    left.max === right.max &&
    left.idleTimeoutMillis === right.idleTimeoutMillis &&
    left.connectionTimeoutMillis === right.connectionTimeoutMillis
  );
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  return typeof process === "undefined" ? {} : process.env;
}
