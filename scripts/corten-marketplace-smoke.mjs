// Marketplace-only entry to the platform smoke, for the Corten marketplace pilot. It smokes one marketplace origin
// as the Smoke check smokes marketplace-web: home, search, the platform API through it, UCP, and social login when
// configured. No landing page, waitlist write, marketplace root, legacy redirect or admin request. The platform smoke
// still needs a landing and an admin URL: with SMOKE_REQUIRE_LANDING=false the landing is never fetched, and with
// SMOKE_CHECK_ADMIN_SURFACE=false and no admin credentials the admin is never fetched either, so an admin outage
// does not fail this smoke.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";

const platformSmokePath = fileURLToPath(new URL("./platform-smoke.mjs", import.meta.url));

// Origins the platform smoke reads from the environment ahead of its arguments, and the admin credentials; cleared
// so only the given origins are smoked and nothing signs in.
export const clearedVariables = [
  "LANDING_WEB_URL",
  "PUBLIC_WEB_URL",
  "ADMIN_WEB_URL",
  "MARKETPLACE_WEB_URL",
  "MARKETPLACE_ROOT_WEB_URL",
  "LEGACY_PUBLIC_URL",
  "PLATFORM_ADMIN_EMAIL",
  "PLATFORM_ADMIN_PASSWORD",
];

export const forcedSmokeEnvironment = {
  SMOKE_REQUIRE_LANDING: "false",
  SMOKE_REQUIRE_ADMIN: "false",
  SMOKE_CHECK_ADMIN_SURFACE: "false",
  SMOKE_REQUIRE_ADMIN_GOOGLE_WORKSPACE_SSO: "false",
  SMOKE_REQUIRE_MARKETPLACE: "true",
  SMOKE_REQUIRE_MARKETPLACE_ROOT: "false",
  SMOKE_REQUIRE_LEGACY_REDIRECT: "false",
  SMOKE_WRITE_WAITLIST: "false",
};

export function cortenMarketplaceSmokeInvocation(argv, env) {
  const args = getPlatformSmokeCliArgs(argv);
  if (args.length !== 3) {
    throw new Error(
      "Usage: node scripts/corten-marketplace-smoke.mjs https://landing... https://admin... https://marketplace...",
    );
  }
  const childEnv = { ...env };
  for (const name of clearedVariables) delete childEnv[name];
  Object.assign(childEnv, forcedSmokeEnvironment);
  return { args: [platformSmokePath, ...args], env: childEnv };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { args, env } = cortenMarketplaceSmokeInvocation(process.argv, process.env);
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
