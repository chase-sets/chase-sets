import type {
  BcApiModule,
  BcProjector,
} from "@chase-sets/bounded-context-module";

const RETRY_DELAY_MS = 1_000;
const MAX_RETRIES = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForDatabase(
  pool: { query: (sql: string) => Promise<unknown> },
  label = "Database",
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(
          `${label} did not become ready after ${MAX_RETRIES} attempts.`,
          { cause: error },
        );
      }

      await sleep(RETRY_DELAY_MS);
    }
  }
}

export async function drainProjectors(
  projectors: readonly BcProjector[],
): Promise<void> {
  let processed = 0;

  do {
    processed = 0;

    for (const projector of projectors) {
      const result = await projector.runOnce();
      processed += result.processed;
    }
  } while (processed > 0);
}

export function collectProjectors<TServices extends {
  projectors: readonly BcProjector[];
}>(servicesList: readonly TServices[]): readonly BcProjector[] {
  return servicesList.flatMap((services) => services.projectors);
}

export function createContextServices<
  TServices,
  TPool,
  TPorts,
>(module: BcApiModule<TServices, TPool, TPorts>, pool: TPool, ports: TPorts): TServices {
  return module.createServices(pool, ports);
}

export function composeSchemaSql(
  modules: readonly Pick<BcApiModule, "schemaSql">[],
): string {
  return modules.map((module) => module.schemaSql).join("\n\n");
}

export function composeApiModules<TPool>(
  pool: TPool,
  modules: readonly Readonly<{
    module: BcApiModule<unknown, TPool, unknown>;
    ports: unknown;
  }>[],
) {
  return modules.map(({ module, ports }) => ({
    module,
    services: module.createServices(pool, ports),
  }));
}

export function createForwardedAuthHeaders(
  request: Request,
  initHeaders?: HeadersInit,
): Headers {
  const headers = new Headers(initHeaders);
  const cookie = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");

  if (cookie && !headers.has("cookie")) {
    headers.set("cookie", cookie);
  }

  if (authorization && !headers.has("authorization")) {
    headers.set("authorization", authorization);
  }

  return headers;
}

export function createForwardedAuthFetch(
  request: Request,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  return (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? "include",
      headers: createForwardedAuthHeaders(request, init.headers),
    });
}

export function resolveRequestApiBaseUrl(request: Request, apiBasePath: string): string {
  const url = new URL(request.url);
  return `${url.origin}${apiBasePath}`;
}

export async function countEventsWithPrefix(
  pool: {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  prefix: string,
): Promise<number> {
  const result = await pool.query(
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1",
    [`${prefix}%`],
  );

  return Number(result.rows?.[0]?.count ?? 0);
}

export async function seedApiModuleIfEmpty<TPool>(
  module: Pick<BcApiModule<unknown, TPool, unknown>, "contextName" | "streamPrefix" | "seed">,
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
): Promise<void> {
  if (!module.seed) {
    return;
  }

  const eventCount = await countEventsWithPrefix(pool, module.streamPrefix);

  if (eventCount === 0) {
    console.log(`Seeding ${module.contextName} data...`);
    await module.seed(pool);
    return;
  }

  console.log(`${module.contextName} events already exist. Skipping seed.`);
}

export async function bootstrapApiModule<TServices, TPool, TPorts>(
  module: BcApiModule<TServices, TPool, TPorts>,
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  ports: TPorts,
  options: Readonly<{
    databaseLabel?: string;
    completionLabel?: string;
  }> = {},
): Promise<TServices> {
  const completionLabel = options.completionLabel ?? module.contextName;
  await waitForDatabase(pool, options.databaseLabel ?? completionLabel);
  await pool.query(module.schemaSql);
  await seedApiModuleIfEmpty(module, pool);
  const services = module.createServices(pool, ports);
  await drainProjectors(module.projectors(services));
  console.log(`${completionLabel} projections are up to date.`);
  console.log(`${completionLabel} bootstrap complete.`);
  return services;
}

export function buildOpenGraphMeta({
  title,
  description,
  siteName = "Chase Sets",
  imageUrl,
  type = "website",
}: Readonly<{
  title: string;
  description: string;
  siteName?: string;
  imageUrl?: string;
  type?: "website" | "product";
}>) {
  const meta = [
    { title },
    { name: "description", content: description },
    { property: "og:site_name", content: siteName },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:type", content: type },
    {
      name: "twitter:card",
      content: imageUrl ? "summary_large_image" : "summary",
    },
  ];

  if (imageUrl) {
    meta.push({ property: "og:image", content: imageUrl });
  }

  return meta;
}
