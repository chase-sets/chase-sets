// Admin-only entry to the platform smoke, for the Corten admin pilot (#11327). It smokes one admin origin and
// nothing else: no landing page, public routes, native MCP, waitlist write, marketplace or legacy redirect. The
// platform smoke still needs a landing URL argument; with SMOKE_REQUIRE_LANDING=false it is never fetched.
import { spawnSync } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getPlatformSmokeCliArgs } from "./platform-smoke-args.mjs";

const platformSmokePath = fileURLToPath(new URL("./platform-smoke.mjs", import.meta.url));

// Origins the platform smoke reads from the environment ahead of its arguments; cleared so only the given admin
// origin is smoked.
export const clearedOriginVariables = [
  "LANDING_WEB_URL",
  "PUBLIC_WEB_URL",
  "ADMIN_WEB_URL",
  "MARKETPLACE_WEB_URL",
  "MARKETPLACE_ROOT_WEB_URL",
  "LEGACY_PUBLIC_URL",
];

export const forcedSmokeEnvironment = {
  SMOKE_REQUIRE_LANDING: "false",
  SMOKE_REQUIRE_ADMIN: "true",
  SMOKE_REQUIRE_MARKETPLACE: "false",
  SMOKE_REQUIRE_MARKETPLACE_ROOT: "false",
  SMOKE_REQUIRE_LEGACY_REDIRECT: "false",
  SMOKE_REQUIRE_SOCIAL_LOGIN: "false",
  SMOKE_WRITE_WAITLIST: "false",
};

export function cortenAdminSmokeInvocation(argv, env) {
  const args = getPlatformSmokeCliArgs(argv);
  if (args.length !== 2) {
    throw new Error("Usage: node scripts/corten-admin-smoke.mjs https://landing... https://admin...");
  }
  const childEnv = { ...env };
  for (const name of clearedOriginVariables) delete childEnv[name];
  Object.assign(childEnv, forcedSmokeEnvironment);
  return { args: [platformSmokePath, ...args], env: childEnv };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { args, env } = cortenAdminSmokeInvocation(process.argv, process.env);
  const result = spawnSync(process.execPath, args, { env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
