import { pathToFileURL } from "node:url";
import { module as authModule } from "@chase-sets/auth";
import { sessionGenerationCapabilityReport, type SessionGenerationCapabilityReport } from "@chase-sets/auth/server";

/**
 * Pod-side Session Generation capability reporter for the floor receipt
 * (`node ./scripts/agent-grant-revocation-release.mjs capture-session-generation-floor`).
 *
 * It composes only metadata compiled into this image -- Auth's own capability
 * version and Auth's schema ledger -- with this pod's deployment identity. It
 * reads no database, no planned replica count, and no revocation support
 * version, so a pod that predates the floor cannot report the capability.
 */
export function readSessionGenerationCapability(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SessionGenerationCapabilityReport {
  return sessionGenerationCapabilityReport({
    implementationSha: env.CHASE_SETS_IMPLEMENTATION_SHA,
    deploymentInstance: env.CHASE_SETS_DEPLOYMENT_INSTANCE,
    schemaMigrationIds: (authModule.schemaMigrations ?? []).map((migration) => migration.migrationId),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) {
    process.stderr.write("revocation_activation_arguments_invalid\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`${JSON.stringify(readSessionGenerationCapability())}\n`);
  }
}
