import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export function parseIdentityTermsPopulationOptions(argv, env = process.env) {
  const values = {};
  for (const argument of argv) {
    if (argument === "--writers-upgraded") values.writersUpgraded = true;
    else {
      const match = /^--(environment|writer-sha|authorization|alias-search)=(.+)$/.exec(argument);
      if (!match || Object.hasOwn(values, match[1])) throw new Error(`Invalid or duplicate argument '${argument}'.`);
      values[match[1]] = match[2];
    }
  }
  if (!values.writersUpgraded) throw new Error("Confirm ALL writers are upgraded with --writers-upgraded.");
  if (!/^[a-f0-9]{40}$/.test(values["writer-sha"] ?? ""))
    throw new Error("--writer-sha requires the deployed 40-character SHA.");
  if (!["local", "staging", "production"].includes(values.environment))
    throw new Error("--environment must be local, staging or production.");
  if (!values.authorization?.trim())
    throw new Error("--authorization requires the host's run/retry authorization reference.");
  if (!["enabled", "disabled"].includes(values["alias-search"]))
    throw new Error("--alias-search must match the deployed writers (enabled or disabled).");
  const aliasEnabled = !new Set(["disabled", "off", "false", "0", "kill"]).has(
    (env.DISCOVERY_ALIAS_SEARCH ?? "").trim().toLowerCase(),
  );
  if (aliasEnabled !== (values["alias-search"] === "enabled"))
    throw new Error("DISCOVERY_ALIAS_SEARCH differs from --alias-search; use the deployed writer configuration.");
  if (!env.DATABASE_URL_DISCOVERY || !env.PLATFORM_CONTROL_DATABASE_URL)
    throw new Error("DATABASE_URL_DISCOVERY and PLATFORM_CONTROL_DATABASE_URL are required; use deployed app roles.");
  return { environment: values.environment, writerSha: values["writer-sha"], authorization: values.authorization };
}

export async function runIdentityTermsPopulation(argv, env, dependencies) {
  const options = parseIdentityTermsPopulationOptions(argv, env);
  return dependencies.populate({ ...options, ownerId: `discovery-identity-terms:${randomUUID()}` });
}

export async function createIdentityTermsPopulationPools(env) {
  const { createPgPool } = await import("../infrastructure/event-core-postgres/pool.ts");
  return {
    pool: createPgPool(env.DATABASE_URL_DISCOVERY, { max: 1 }),
    controlPool: createPgPool(env.PLATFORM_CONTROL_DATABASE_URL, { max: 2 }),
  };
}

async function main() {
  parseIdentityTermsPopulationOptions(process.argv.slice(2));
  const { register } = await import("node:module");
  register("../infrastructure/platform-runtime/typescript-resolver.mjs", import.meta.url);
  const [{ createPostgresPlatformControlPlane }, { populateDiscoverySearchIdentityTerms }] = await Promise.all([
    import("../infrastructure/platform-runtime/control-plane.ts"),
    import("../bounded-contexts/discovery/support/runtime-support/search-identity-terms-population.ts"),
  ]);
  const { pool, controlPool } = await createIdentityTermsPopulationPools(process.env);
  const controlPlane = createPostgresPlatformControlPlane(controlPool);
  try {
    const receipt = await runIdentityTermsPopulation(process.argv.slice(2), process.env, {
      populate: (input) => populateDiscoverySearchIdentityTerms({ ...input, pool, controlPlane }),
    });
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    await controlPlane.stop?.();
    await Promise.all([pool.end(), controlPool.end()]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
