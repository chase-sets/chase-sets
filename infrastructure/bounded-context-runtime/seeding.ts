import {
  ENVIRONMENT_DATA_PROFILES,
  type BcApiModule,
  type BcSeedOptions,
  type EnvironmentDataProfile,
} from "@chase-sets/bounded-context-module";
import { escapeLikePattern } from "@chase-sets/event-core-postgres";

export const allEnvironmentDataProfiles: readonly EnvironmentDataProfile[] = ENVIRONMENT_DATA_PROFILES;

export const defaultSeedDataProfiles = [
  "critical-bootstrap",
  "catalog-integration-bootstrap",
  "scenario-seed",
  "representative-commerce-state",
  "admin-qa-actor-fixtures",
] as const satisfies readonly EnvironmentDataProfile[];

export const defaultSeedOptions: BcSeedOptions = {
  enabledDataProfiles: defaultSeedDataProfiles,
  environmentName: null,
};

export function seedProfileEnabled(options: BcSeedOptions | undefined, profile: EnvironmentDataProfile): boolean {
  return (options ?? defaultSeedOptions).enabledDataProfiles.includes(profile);
}

export function seedProfilesOverlap(
  moduleProfiles: readonly EnvironmentDataProfile[] | undefined,
  options: BcSeedOptions | undefined,
): boolean {
  const profiles = moduleProfiles ?? ["scenario-seed"];
  const enabledProfiles = (options ?? defaultSeedOptions).enabledDataProfiles;

  return profiles.some((profile) => enabledProfiles.includes(profile));
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
    "SELECT COUNT(*) AS count FROM event_store_events WHERE stream_id LIKE $1 ESCAPE '\\'",
    [`${escapeLikePattern(prefix)}%`],
  );

  return Number(result.rows?.[0]?.count ?? 0);
}

export async function seedApiModuleIfEmpty<TPool>(
  module: Pick<BcApiModule<unknown, TPool, unknown>, "contextName" | "streamPrefix" | "seed" | "seedProfiles">,
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  services?: unknown,
  options: BcSeedOptions = defaultSeedOptions,
): Promise<void> {
  if (!module.seed) {
    return;
  }
  if (!seedProfilesOverlap(module.seedProfiles, options)) {
    console.log(`${module.contextName} seed skipped for data profiles: ${options.enabledDataProfiles.join(", ")}.`);
    return;
  }

  const eventCount = await countEventsWithPrefix(pool, module.streamPrefix);

  if (eventCount === 0) {
    console.log(`Seeding ${module.contextName} data...`);
  } else {
    console.log(`${module.contextName} events already exist. Running seed reconciliation.`);
  }

  await module.seed(pool, services, options);
}

export async function seedApiModulesIfEmpty<TPool>(
  modules: readonly Pick<
    BcApiModule<unknown, TPool, unknown>,
    "contextName" | "streamPrefix" | "seed" | "seedProfiles"
  >[],
  pool: TPool & {
    query: (
      sql: string,
      params?: readonly unknown[],
    ) => Promise<{ rows?: readonly Readonly<{ count?: string | number }>[] }>;
  },
  options: BcSeedOptions = defaultSeedOptions,
): Promise<void> {
  for (const module of modules) {
    await seedApiModuleIfEmpty(module, pool, undefined, options);
  }
}
